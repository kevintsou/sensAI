import Anthropic from "@anthropic-ai/sdk";
import { ChangesetContext, Finding, ReviewContext, Rule, Severity, SYNTAX_RULE_ID } from "./types";
import { archFacts } from "./abi";
import { LineRange } from "./diff";
import { buildChangesetMessage, buildUserMessage, changesetSystemPrompt, systemPrompt } from "./prompt";
import { SourceLanguage } from "./language";

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
   * 送給 endpoint 的 API key（SDK 會放進 Authorization 標頭）。
   * 新版 Claude Code Router 會驗證，需要真的 key；舊版不驗證可省略。
   * 省略時退回環境變數 ANTHROPIC_API_KEY，再退回佔位字串 "ccr"。
   * 想略過 CCR 直接打 Anthropic API 時，設真 key 並把 endpoint 指向
   * https://api.anthropic.com。
   */
  apiKey?: string;
  /** 中止這次請求。使用者按面板的取消時 abort。 */
  signal?: AbortSignal;
}

/** 使用者取消審查時丟這個，讓上層知道是刻意中止、不是錯誤。 */
export class ReviewCancelledError extends Error {
  constructor() {
    super("審查已取消");
    this.name = "ReviewCancelledError";
  }
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
    "回報在受審查的檔案中發現的問題。沒有發現問題時，傳入空陣列。" +
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

/**
 * 審查整組改動用的 tool：每則意見多一個 file。
 *
 * 名稱跟單檔的一樣 —— 對模型來說做的是同一件事，mock router 也只認這個名字。
 */
const CHANGESET_TOOL: Anthropic.Tool = (() => {
  const schema = FINDINGS_TOOL.input_schema as {
    properties: { findings: { items: { properties: Record<string, unknown>; required: string[] } } };
  };
  const item = schema.properties.findings.items;
  return {
    ...FINDINGS_TOOL,
    description:
      "回報在這組改動中發現的問題，每則都要標明在哪個檔案。沒有發現問題時，傳入空陣列。" +
      "每則意見都必須說明具體的觸發情境與後果；說不出來的就不要回報。",
    input_schema: {
      ...FINDINGS_TOOL.input_schema,
      properties: {
        findings: {
          ...schema.properties.findings,
          items: {
            ...item,
            properties: {
              file: {
                type: "string",
                description: "問題所在的檔案，照抄待審查檔案標題裡的路徑。",
              },
              ...item.properties,
            },
            required: ["file", ...item.required],
          },
        },
      },
    } as Anthropic.Tool.InputSchema,
  };
})();

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
 * 送出一次審查請求，回傳模型給的原始 findings 陣列（還沒整理）。
 *
 * 走 tool use 而不是 structured outputs：CCR 會把請求轉發到不同 provider，
 * `output_config.format` 不保證轉得過去，function calling 則幾乎都支援。
 */
async function callFindingsTool(
  system: string,
  user: string,
  tool: Anthropic.Tool,
  opts: ReviewClientOptions,
): Promise<unknown[]> {
  const client = new Anthropic({
    baseURL: opts.endpoint,
    // 依序：設定的 key → 環境變數 → 佔位字串。新版 CCR 會驗證，需要真 key；
    // 舊版不驗證，SDK 又要求非空字串，所以退回佔位字串 "ccr" 讓舊版照舊能用。
    apiKey: opts.apiKey || process.env.ANTHROPIC_API_KEY || "ccr",
    timeout: opts.timeoutMs,
    maxRetries: 1, // CCR 沒開的時候要快點失敗，不要卡著重試
  });

  let response: Anthropic.Message;
  try {
    response = await client.messages.create(
      {
        model: opts.model,
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content: user }],
        tools: [tool],
        tool_choice: { type: "tool", name: tool.name },
      },
      { signal: opts.signal },
    );
  } catch (err) {
    // abort 會丟 APIUserAbortError（或 signal 已 aborted）——歸成取消，不是錯誤。
    if (err instanceof Anthropic.APIUserAbortError || opts.signal?.aborted) {
      throw new ReviewCancelledError();
    }
    if (isConnectionProblem(err)) {
      throw new EndpointUnavailableError(opts.endpoint, (err as Error).message);
    }
    throw err;
  }

  const call = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === tool.name,
  );
  if (!call) {
    // 被強制 tool_choice 之後仍然沒有 tool_use，代表這條路由的模型不支援。
    throw new Error(
      `模型沒有回傳 ${tool.name} 工具呼叫（stop_reason: ${response.stop_reason}）。` +
        "這條 CCR 路由的模型可能不支援 tool use。",
    );
  }

  const input = call.input as { findings?: unknown };
  return Array.isArray(input?.findings) ? input.findings : [];
}

/** 把原始 findings 整理成 Finding，並回報捏造的規則 id。 */
function coerceAll<T>(
  raw: unknown[],
  rules: Rule[],
  opts: ReviewClientOptions,
  attach: (finding: Finding, raw: Record<string, unknown>) => T,
): T[] {
  const validIds = new Set(rules.map((r) => r.id));
  const fabricated = new Set<string>();
  const out: T[] = [];
  for (const r of raw) {
    const f = coerceFinding(r, validIds, (id) => fabricated.add(id));
    if (f) {
      out.push(attach(f, r as Record<string, unknown>));
    }
  }
  for (const id of fabricated) {
    opts.onUnknownRuleId?.(id);
  }
  return out;
}

/** 送出一次單檔審查請求。 */
export async function requestReview(
  ctx: ReviewContext,
  rules: Rule[],
  opts: ReviewClientOptions,
): Promise<Finding[]> {
  const raw = await callFindingsTool(
    systemPrompt(
      ctx.language,
      ctx.language === "asm" ? archFacts(opts.archId) : null,
      rules.length === 0,
    ),
    buildUserMessage(ctx, rules, opts.changed ?? null),
    FINDINGS_TOOL,
    opts,
  );
  return coerceAll(raw, rules, opts, (f) => f);
}

/** 模型回報的一則意見，連同它說的檔案（還沒對應到實際送審的檔案）。 */
export interface ChangesetRawFinding {
  file: string;
  finding: Finding;
}

/**
 * 送出一次「整組改動」的審查請求。所有送審的檔案在同一個請求裡，
 * 模型才看得到跨檔案的不一致。
 *
 * rules 應該已經篩成這組改動裡出現的語言適用的規則。
 */
export async function requestChangesetReview(
  cs: ChangesetContext,
  rules: Rule[],
  opts: ReviewClientOptions,
): Promise<ChangesetRawFinding[]> {
  const languages = new Set<SourceLanguage>(cs.targets.map((t) => t.language));
  const syntaxOnly = new Set<SourceLanguage>(
    [...languages].filter((l) => !rules.some((r) => r.languages.includes(l))),
  );
  const raw = await callFindingsTool(
    changesetSystemPrompt(
      languages,
      languages.has("asm") ? archFacts(opts.archId) : null,
      syntaxOnly,
    ),
    buildChangesetMessage(cs, rules),
    CHANGESET_TOOL,
    opts,
  );
  return coerceAll(raw, rules, opts, (finding, r) => ({
    file: typeof r.file === "string" ? r.file.trim() : "",
    finding,
  }));
}
