import * as fs from "fs";
import * as path from "path";
import * as YAML from "yaml";
import { SourceLanguage } from "./language";
import { Rule, Severity } from "./types";

export interface RulesLoadResult {
  rules: Rule[];
  problems: string[];
}

const SEVERITIES: Severity[] = ["error", "warning", "info"];
const LANGUAGES: SourceLanguage[] = ["c", "asm"];

export function rulesPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".sensai", "rules.yaml");
}

/**
 * 載入 `.sensai/rules.yaml`。
 *
 * 規則寫壞不應該讓整個擴充停擺，所以個別規則的問題收集到 `problems`
 * 回報給使用者，其餘規則照常載入。
 */
export function loadRules(workspaceRoot: string): RulesLoadResult {
  const file = rulesPath(workspaceRoot);
  const problems: string[] = [];
  if (!fs.existsSync(file)) {
    return { rules: [], problems: ["找不到 .sensai/rules.yaml —— 沒有規則的話審查結果會很泛泛。"] };
  }

  let doc: unknown;
  try {
    doc = YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { rules: [], problems: [`rules.yaml 解析失敗: ${(err as Error).message}`] };
  }

  if (!Array.isArray(doc)) {
    return { rules: [], problems: ["rules.yaml 的最外層必須是一個 list。"] };
  }

  const rules: Rule[] = [];
  const seen = new Set<string>();

  doc.forEach((raw: any, i: number) => {
    const where = `第 ${i + 1} 條規則`;
    if (typeof raw?.id !== "string" || raw.id.trim() === "") {
      problems.push(`${where}缺少 id，已略過。`);
      return;
    }
    if (typeof raw?.rule !== "string" || raw.rule.trim() === "") {
      problems.push(`規則 ${raw.id} 缺少 rule 內容，已略過。`);
      return;
    }
    if (seen.has(raw.id)) {
      problems.push(`規則 id 重複: ${raw.id}，只保留第一條。`);
      return;
    }
    seen.add(raw.id);

    let severity: Severity = "warning";
    if (typeof raw.severity === "string") {
      if (SEVERITIES.includes(raw.severity as Severity)) {
        severity = raw.severity as Severity;
      } else {
        problems.push(`規則 ${raw.id} 的 severity "${raw.severity}" 無效，改用 warning。`);
      }
    }

    let languages: SourceLanguage[] = [...LANGUAGES];
    if (raw.languages !== undefined) {
      const listed = Array.isArray(raw.languages) ? raw.languages : [raw.languages];
      const valid = listed.filter((l: unknown): l is SourceLanguage =>
        LANGUAGES.includes(l as SourceLanguage),
      );
      if (valid.length === 0) {
        problems.push(
          `規則 ${raw.id} 的 languages 沒有有效值（可用：${LANGUAGES.join("、")}），視為兩種語言都適用。`,
        );
      } else {
        languages = valid;
      }
    }

    rules.push({
      id: raw.id,
      severity,
      languages,
      rule: raw.rule,
      except: typeof raw.except === "string" ? raw.except : undefined,
      examples:
        raw.examples && typeof raw.examples === "object"
          ? {
              bad: typeof raw.examples.bad === "string" ? raw.examples.bad : undefined,
              good: typeof raw.examples.good === "string" ? raw.examples.good : undefined,
            }
          : undefined,
    });
  });

  return { rules, problems };
}
