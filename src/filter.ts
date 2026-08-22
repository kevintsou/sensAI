import { DroppedFinding, Finding } from "./types";

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const NUMBER_RE = /\d+/g;

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

/**
 * evidence 有沒有引用到檔案裡真的存在的東西。
 *
 * 目的是攔掉模型憑空捏造識別字的情況 —— 那是誤報最明顯的訊號。
 * 刻意放寬：只有在 evidence 提到了識別字、而且沒有任何一個出現在原始碼裡，
 * 才判定為捏造。寧可漏掉幾則可疑的，也不要把真的問題濾掉。
 */
export function evidenceIsGrounded(evidence: string, source: string, lineCount: number): boolean {
  const idents = identifiers(evidence);
  if (idents.length > 0) {
    return idents.some((id) => source.includes(id));
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
