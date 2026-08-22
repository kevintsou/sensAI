import Anthropic from "@anthropic-ai/sdk";
import { Finding, ReviewContext, Rule, Severity } from "./types";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt";

export interface ReviewClientOptions {
  endpoint: string;
  model: string;
  timeoutMs: number;
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
              description: "命中專案規則時，沿用該規則的 severity。",
            },
            message: {
              type: "string",
              description: "一句話說明問題，不超過 40 字。",
            },
            trigger_condition: {
              type: "string",
              description:
                "什麼情況下會出事，要具體到時序、呼叫順序或中斷時機。" +
                '例如「當 ISR 在第 40 到 42 行之間觸發時」。不可以是「在某些情況下」這種空泛描述。',
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
              description: "命中的專案規則 id。不是由規則觸發的話填 null。",
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

function coerceFinding(raw: unknown): Finding | null {
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
  return {
    line,
    severity: SEVERITIES.includes(r.severity as Severity) ? (r.severity as Severity) : "warning",
    message,
    trigger_condition: str(r.trigger_condition),
    consequence: str(r.consequence),
    evidence: str(r.evidence),
    rule_id: typeof r.rule_id === "string" && r.rule_id !== "" ? r.rule_id : null,
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
    apiKey: "ccr", // CCR 不驗證，但 SDK 要求非空字串
    timeout: opts.timeoutMs,
    maxRetries: 1, // CCR 沒開的時候要快點失敗，不要卡著重試
  });

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: opts.model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage(ctx, rules) }],
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
  return input.findings
    .map(coerceFinding)
    .filter((f): f is Finding => f !== null);
}
