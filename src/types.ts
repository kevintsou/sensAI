import { SourceLanguage } from "./language";

export type Severity = "error" | "warning" | "info";

/**
 * 語法與型別錯誤不是由 .sensai/rules.yaml 觸發的，但也不該顯示成「無規則」——
 * 那會跟模型自己判斷的通用問題混在一起。給它一個固定的 rule_id，
 * 面板上就能一眼看出這則是編譯期問題，不是硬體規則問題。
 */
export const SYNTAX_RULE_ID = "syntax-error";

export interface Rule {
  id: string;
  severity: Severity;
  rule: string;
  except?: string;
  examples?: { bad?: string; good?: string };
  /** 這條規則適用哪些語言。省略代表兩種都適用。 */
  languages: SourceLanguage[];
}

/** 一則審查意見。欄位對應 SPEC.md「Finding 的結構」。 */
export interface Finding {
  line: number;
  severity: Severity;
  message: string;
  trigger_condition: string;
  consequence: string;
  evidence: string;
  rule_id: string | null;
}

export interface DroppedFinding {
  finding: Finding;
  reason: "evidence-not-found" | "line-out-of-range" | "muted" | "outside-changed-lines";
}

export interface ReviewResult {
  filePath: string;
  findings: Finding[];
  dropped: DroppedFinding[];
  durationMs: number;
  headersIncluded: string[];
  contextTruncated: boolean;
  /**
   * "changed" 是階段一（只看剛改動的行）的先期結果，之後還會被階段二補上；
   * "changed-only" 也只看改動的行，但因為連續觸發而暫時不做完整審查 ——
   * 等安靜下來才會補；"full" 是完整結果。省略代表沒有分階段。
   */
  stage?: "changed" | "changed-only" | "full";
  /** 因為意見過多而被收起來的低嚴重度意見。內容完整，只是預設不展開。 */
  collapsed?: Finding[];
  /**
   * 審查期間檔案又被改過，行號是對著送出當下那一版算的。
   * 意見本身仍然有參考價值，但跳行可能會落在別的地方，所以要讓使用者知道。
   */
  stale?: boolean;
}

/**
 * 一則被使用者釘選的意見。除了 Finding 本身，還帶著它來自哪個檔案、
 * 釘選當下那一行的程式碼快照，以及使用者寫的筆記。
 *
 * lineText 是快照而非即時查詢：釘選的重點就是把「當時看到的那個版本」
 * 留下來，即使檔案之後改了也不受影響。
 */
export interface PinnedFinding {
  key: string;
  finding: Finding;
  /** 相對工作區根目錄的路徑，顯示用。 */
  file: string;
  /** 跳轉用的絕對路徑。 */
  filePath: string;
  lineText: string;
  comment: string;
  pinnedAt: string;
}

export interface HeaderFile {
  path: string;
  text: string;
}

export interface ReviewContext {
  filePath: string;
  source: string;
  headers: HeaderFile[];
  truncated: boolean;
  language: SourceLanguage;
}
