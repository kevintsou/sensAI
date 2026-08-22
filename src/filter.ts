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
): FilterResult {
  const lineCount = source.split("\n").length;
  const kept: Finding[] = [];
  const dropped: DroppedFinding[] = [];

  for (const finding of findings) {
    if (finding.line < 1 || finding.line > lineCount) {
      dropped.push({ finding, reason: "line-out-of-range" });
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

  kept.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.line - b.line,
  );
  return { kept, dropped };
}
