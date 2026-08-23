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
   * "full" 是完整結果。省略代表沒有分階段。
   */
  stage?: "changed" | "full";
  /** 因為意見過多而被收起來的低嚴重度意見。內容完整，只是預設不展開。 */
  collapsed?: Finding[];
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
