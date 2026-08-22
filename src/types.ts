import { SourceLanguage } from "./language";

export type Severity = "error" | "warning" | "info";

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
  reason: "evidence-not-found" | "line-out-of-range" | "muted";
}

export interface ReviewResult {
  filePath: string;
  findings: Finding[];
  dropped: DroppedFinding[];
  durationMs: number;
  headersIncluded: string[];
  contextTruncated: boolean;
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
