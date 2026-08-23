import { LineRange, isInRanges } from "./diff";
import { DroppedFinding, Finding } from "./types";

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const NUMBER_RE = /\d+/g;

/**
 * 暫存器名幾乎都是兩個字元，IDENT_RE 的三字元下限一律漏掉 —— 但那正是
 * 組語意見裡最關鍵的佐證。少了這一類，「s1 沒有保存」這種完全正確的意見
 * 會因為 evidence 裡只剩 prologue / epilogue 這類原始碼沒有的英文詞，
 * 被誤判成捏造而丟棄。
 *
 * 不改 IDENT_RE 的下限，是因為 identifiers() 的比對是子字串比對：
 * 放行兩字元的一般詞（is、in、to）等於讓任何 evidence 都能矇混過關。
 */
const REGISTER_RE = /\b(?:[xatsf](?:3[01]|[12][0-9]|[0-9])|r(?:1[0-5]|[0-9])|ra|sp|gp|tp|fp|lr|pc|ip)\b/g;

/**
 * 這些字幾乎每個 C 檔案都有，出現在 evidence 裡不構成任何佐證。
 * 不排除的話，一則捏造了識別字、但順口提到 volatile 的意見會矇混過關。
 */
const NO_EVIDENTIAL_WEIGHT = new Set([
  "auto", "break", "case", "char", "const", "continue", "default", "double",
  "else", "enum", "extern", "float", "for", "goto", "inline", "int", "long",
  "register", "restrict", "return", "short", "signed", "sizeof", "static",
  "struct", "switch", "typedef", "union", "unsigned", "void", "volatile",
  "while", "bool", "size_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t",
  "int8_t", "int16_t", "int32_t", "int64_t", "NULL", "true", "false",
]);

function identifiers(text: string): string[] {
  return (text.match(IDENT_RE) ?? []).filter((id) => !NO_EVIDENTIAL_WEIGHT.has(id));
}

function registers(text: string): string[] {
  return text.match(REGISTER_RE) ?? [];
}

/**
 * 暫存器要用字邊界比對，不能用子字串 —— 否則 s1 會在 s10 裡命中，
 * ra 會在 ram 裡命中，等於沒檢查。
 */
function sourceUsesRegister(source: string, register: string): boolean {
  return new RegExp(`\\b${register}\\b`).test(source);
}

/**
 * evidence 有沒有引用到檔案裡真的存在的東西。
 *
 * 目的是攔掉模型憑空捏造識別字的情況 —— 那是誤報最明顯的訊號。
 * 刻意放寬：只有在 evidence 提到了識別字、而且沒有任何一個出現在原始碼裡，
 * 才判定為捏造。寧可漏掉幾則可疑的，也不要把真的問題濾掉。
 */
export function evidenceIsGrounded(evidence: string, source: string, lineCount: number): boolean {
  const idents = identifiers(evidence);
  const regs = registers(evidence);
  if (idents.length > 0 || regs.length > 0) {
    return (
      idents.some((id) => source.includes(id)) ||
      regs.some((reg) => sourceUsesRegister(source, reg))
    );
  }
  // 沒有識別字時，退而求其次看它有沒有指到一個存在的行號。
  const numbers = evidence.match(NUMBER_RE) ?? [];
  return numbers.some((n) => {
    const v = Number(n);
    return Number.isFinite(v) && v >= 1 && v <= lineCount;
  });
}

export interface FilterResult {
  kept: Finding[];
  dropped: DroppedFinding[];
}

const SEVERITY_ORDER: Record<Finding["severity"], number> = { error: 0, warning: 1, info: 2 };

export function filterFindings(
  findings: Finding[],
  source: string,
  isMuted: (f: Finding) => boolean,
  scope: LineRange[] | null = null,
): FilterResult {
  const lineCount = source.split("\n").length;
  const kept: Finding[] = [];
  const dropped: DroppedFinding[] = [];

  for (const finding of findings) {
    if (finding.line < 1 || finding.line > lineCount) {
      dropped.push({ finding, reason: "line-out-of-range" });
      continue;
    }
    // 階段一限定在改動範圍內。prompt 已經講了，但模型會飄，這裡再擋一次。
    if (scope && !isInRanges(finding.line, scope)) {
      dropped.push({ finding, reason: "outside-changed-lines" });
      continue;
    }
    if (!evidenceIsGrounded(finding.evidence, source, lineCount)) {
      dropped.push({ finding, reason: "evidence-not-found" });
      continue;
    }
    if (isMuted(finding)) {
      dropped.push({ finding, reason: "muted" });
      continue;
    }
    kept.push(finding);
  }

  kept.sort(bySeverityThenLine);
  return { kept, dropped };
}

function bySeverityThenLine(a: Finding, b: Finding): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.line - b.line;
}

export interface SeverityBudget {
  /** 實際顯示的意見。 */
  shown: Finding[];
  /** 超出額度被收起來的意見，依然保留完整內容，只是預設不展開。 */
  collapsed: Finding[];
}

/**
 * 意見太多的時候把低嚴重度的收起來，避免失焦。
 *
 * 兩條原則：
 *
 * 一、error 永遠不收。就算 error 自己就超過額度也全部顯示 —— 收起一則
 * error 等於幫使用者決定「這個可以不看」，那不是這個工具該做的決定。
 * 額度的用意是擋掉 warning 的雜訊，不是擋掉壞消息。
 *
 * 二、只有總數超過額度才動作。沒超過就原樣顯示，不要為了「看起來精簡」
 * 去藏東西 —— 平常就藏的話，使用者會不信任面板上的數字。
 */
export function applySeverityBudget(findings: Finding[], cap: number): SeverityBudget {
  if (cap <= 0 || findings.length <= cap) {
    return { shown: [...findings], collapsed: [] };
  }
  const errors = findings.filter((f) => f.severity === "error");
  const rest = findings.filter((f) => f.severity !== "error");

  // error 全留；剩下的額度依 severity、行號的既有順序填，填不下的收起來。
  const room = Math.max(0, cap - errors.length);
  const shown = [...errors, ...rest.slice(0, room)].sort(bySeverityThenLine);
  return { shown, collapsed: rest.slice(room) };
}

/**
 * 跨階段比對「這是不是同一則意見」用的身分。
 *
 * 刻意不含 message：兩個階段是兩次獨立的模型呼叫，同一個問題的措辭幾乎
 * 一定不同，把 message 算進去就永遠比不出重複（muteKey 含 message 是對的，
 * 那是同一次回應內的靜音，情況不一樣）。
 *
 * 也刻意不做「同規則且行號相近就算同一則」—— 相鄰兩行命中同一條規則是
 * 很常見的真實情況（例如兩個相鄰的宣告都缺 volatile），那樣會把兩個
 * 真的問題併成一個。
 */
export function findingIdentity(f: Finding, lineText: string): string {
  const normalized = lineText.trim().replace(/\s+/g, " ");
  return [f.rule_id ?? "", normalized].join("|");
}

/**
 * 合併兩個階段的結果，去掉重複。
 *
 * 重複的部分保留 primary（階段一）的版本 —— 那是落在你剛改的行上的意見，
 * 對當下的你比較有用，而且它先到，換掉會讓面板上的文字莫名其妙跳動。
 */
export function mergeStageFindings(
  primary: Finding[],
  secondary: Finding[],
  source: string,
): { merged: Finding[]; duplicates: number } {
  const lines = source.split("\n");
  const identityOf = (f: Finding) => findingIdentity(f, lines[f.line - 1] ?? "");
  const seen = new Set(primary.map(identityOf));

  const merged = [...primary];
  let duplicates = 0;
  for (const f of secondary) {
    if (seen.has(identityOf(f))) {
      duplicates++;
      continue;
    }
    seen.add(identityOf(f));
    merged.push(f);
  }
  merged.sort(bySeverityThenLine);
  return { merged, duplicates };
}
