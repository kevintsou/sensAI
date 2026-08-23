import Anthropic from "@anthropic-ai/sdk";
import { Finding, ReviewContext, Rule, Severity, SYNTAX_RULE_ID } from "./types";
import { archFacts } from "./abi";
import { LineRange } from "./diff";
import { buildUserMessage, systemPrompt } from "./prompt";

export interface ReviewClientOptions {
  endpoint: string;
  model: string;
  timeoutMs: number;
  /** 組語審查時要注入的 ABI 事實。C 檔案用不到。 */
  archId: string;
  /**
   * 只審查這幾行（階段一）。null 或省略代表整份檔案（階段二）。
   * 附上的檔案內容不受影響 —— 判斷改動處是否正確仍然需要完整上下文。
   */
  changed?: LineRange[] | null;
  /**
   * 模型回報了不存在的規則 id 時呼叫。該則意見的 rule_id 已經被歸為 null，
   * 這裡只是讓上層有機會記錄下來 —— 頻繁出現通常代表規則寫得不夠具體，
   * 模型在猜。
   */
  onUnknownRuleId?: (id: string) => void;
  /**
   * CCR 不驗證，所以預設是佔位字串。
   * 想略過 CCR 直接打 Anthropic API 時，設 ANTHROPIC_API_KEY 並把
   * endpoint 指向 https://api.anthropic.com。
   */
  apiKey?: string;
}

/** CCR 沒啟動時丟這個，讓上層可以靜默降級而不是跳錯誤視窗。 */
export class EndpointUnavailableError extends Error {
  constructor(endpoint: string, cause: string) {
    super(`連不上 Claude Code Router (${endpoint})：${cause}`);
    this.name = "EndpointUnavailableError";
  }
}

const FINDINGS_TOOL: Anthropic.Tool = {
  name: "report_findings",
  description:
    "回報在受審查的 C 檔案中發現的問題。沒有發現問題時，傳入空陣列。" +
    "每則意見都必須說明具體的觸發情境與後果；說不出來的就不要回報。",
  input_schema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        description: "發現的問題。寧可少報也不要塞入不確定的意見。",
        items: {
          type: "object",
          properties: {
            line: {
              type: "integer",
              description: "問題所在的行號，使用檔案內容中標示的行號。",
            },
            severity: {
              type: "string",
              enum: ["error", "warning", "info"],
              description:
                "命中專案規則時，沿用該規則的 severity。語法或型別錯誤一律填 error。",
            },
            message: {
              type: "string",
              description: "一句話說明問題，不超過 40 字。",
            },
            trigger_condition: {
              type: "string",
              description:
                "什麼情況下會出事，要具體到時序、呼叫順序或中斷時機。" +
                '例如「當 ISR 在第 40 到 42 行之間觸發時」。不可以是「在某些情況下」這種空泛描述。' +
                "語法或型別錯誤則改寫編譯階段的失敗，例如「編譯時無法解析 xxxx」。",
            },
            consequence: {
              type: "string",
              description: '會造成什麼結果。例如「讀到舊值」「DMA 搬到過期資料」。',
            },
            evidence: {
              type: "string",
              description: "引用檔案裡實際存在的識別字或行號，用來佐證這則意見。",
            },
            rule_id: {
              type: ["string", "null"],
              description:
                `命中的專案規則 id。語法或型別錯誤填 "${SYNTAX_RULE_ID}"。` +
                "兩者皆非的話填 null。",
            },
          },
          required: [
            "line",
            "severity",
            "message",
            "trigger_condition",
            "consequence",
            "evidence",
            "rule_id",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["findings"],
    additionalProperties: false,
  } as Anthropic.Tool.InputSchema,
};

function isConnectionProblem(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) {
    return true;
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND";
}

const SEVERITIES: Severity[] = ["error", "warning", "info"];

/**
 * 模型會照著看到的命名慣例編出不存在的 rule_id。
 *
 * 實測：把所有 asm-* 規則從 rules.yaml 拿掉之後，prompt 裡完全沒有那些
 * 字串，模型照樣回報 asm-stack-alignment、asm-callee-saved —— 編得跟真的
 * 一模一樣，肉眼分不出來。
 *
 * 放著不管的後果是面板顯示一個 rules.yaml 裡找不到的規則，而且 muteKey
 * 把 rule_id 算進去，靜音會綁在幽靈 id 上，模型下次換個編法就失效。
 *
 * 對不上就歸 null（顯示成「無規則」）。不丟掉整則意見 —— 錯的是歸屬，
 * 問題本身可能是真的。
 */
export function normalizeRuleId(
  raw: unknown,
  validIds: ReadonlySet<string>,
): { ruleId: string | null; fabricated: string | null } {
  if (typeof raw !== "string" || raw === "") {
    return { ruleId: null, fabricated: null };
  }
  // syntax-error 是合法的，但它不來自 rules.yaml。
  if (raw === SYNTAX_RULE_ID || validIds.has(raw)) {
    return { ruleId: raw, fabricated: null };
  }
  return { ruleId: null, fabricated: raw };
}

function coerceFinding(
  raw: unknown,
  validIds: ReadonlySet<string>,
  onFabricated: (id: string) => void,
): Finding | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const line = typeof r.line === "number" ? Math.trunc(r.line) : Number.NaN;
  if (!Number.isFinite(line)) {
    return null;
  }
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const message = str(r.message);
  if (message === "") {
    return null;
  }
  const { ruleId, fabricated } = normalizeRuleId(r.rule_id, validIds);
  if (fabricated) {
    onFabricated(fabricated);
  }
  return {
    line,
    severity: SEVERITIES.includes(r.severity as Severity) ? (r.severity as Severity) : "warning",
    message,
    trigger_condition: str(r.trigger_condition),
    consequence: str(r.consequence),
    evidence: str(r.evidence),
    rule_id: ruleId,
  };
}

/**
 * 送出一次審查請求。
 *
 * 走 tool use 而不是 structured outputs：CCR 會把請求轉發到不同 provider，
 * `output_config.format` 不保證轉得過去，function calling 則幾乎都支援。
 */
export async function requestReview(
  ctx: ReviewContext,
  rules: Rule[],
  opts: ReviewClientOptions,
): Promise<Finding[]> {
  const client = new Anthropic({
    baseURL: opts.endpoint,
    // CCR 不驗證，但 SDK 要求非空字串。指向真正的 Anthropic API 時才需要真的 key。
    apiKey: opts.apiKey || process.env.ANTHROPIC_API_KEY || "ccr",
    timeout: opts.timeoutMs,
    maxRetries: 1, // CCR 沒開的時候要快點失敗，不要卡著重試
  });

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: opts.model,
      max_tokens: 16000,
      system: systemPrompt(
        ctx.language,
        ctx.language === "asm" ? archFacts(opts.archId) : null,
        rules.length === 0,
      ),
      messages: [{ role: "user", content: buildUserMessage(ctx, rules, opts.changed ?? null) }],
      tools: [FINDINGS_TOOL],
      tool_choice: { type: "tool", name: FINDINGS_TOOL.name },
    });
  } catch (err) {
    if (isConnectionProblem(err)) {
      throw new EndpointUnavailableError(opts.endpoint, (err as Error).message);
    }
    throw err;
  }

  const call = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === FINDINGS_TOOL.name,
  );
  if (!call) {
    // 被強制 tool_choice 之後仍然沒有 tool_use，代表這條路由的模型不支援。
    throw new Error(
      `模型沒有回傳 ${FINDINGS_TOOL.name} 工具呼叫（stop_reason: ${response.stop_reason}）。` +
        "這條 CCR 路由的模型可能不支援 tool use。",
    );
  }

  const input = call.input as { findings?: unknown };
  if (!Array.isArray(input?.findings)) {
    return [];
  }
  const validIds = new Set(rules.map((r) => r.id));
  const fabricated = new Set<string>();
  const findings = input.findings
    .map((f) => coerceFinding(f, validIds, (id) => fabricated.add(id)))
    .filter((f): f is Finding => f !== null);
  for (const id of fabricated) {
    opts.onUnknownRuleId?.(id);
  }
  return findings;
}
