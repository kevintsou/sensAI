import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Finding } from "./types";

export interface MuteRecord {
  key: string;
  ruleId: string | null;
  message: string;
  file: string;
  line: number;
  lineText: string;
  triggerCondition: string;
  consequence: string;
  reason: string;
  mutedAt: string;
}

/**
 * 靜音的 key 綁在「規則 + 訊息 + 那一行實際的程式碼」上。
 *
 * 只是重排版不會讓靜音失效（空白已正規化），但真的改到那行程式碼
 * 就會重新回報 —— 那時候情況已經不同了，本來就該重看一次。
 */
export function muteKey(f: Finding, lineText: string): string {
  const normalized = lineText.trim().replace(/\s+/g, " ");
  return crypto
    .createHash("sha1")
    .update([f.rule_id ?? "", f.message, normalized].join(""))
    .digest("hex");
}

/**
 * 本機靜音清單。不進版控 —— 規則由開發者透過 PR 維護，
 * 使用者只有讓自己這台機器閉嘴的權力。
 */
export class MuteStore {
  private records = new Map<string, MuteRecord>();

  constructor(private readonly file: string) {
    this.load();
  }

  static defaultPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, ".sensai", "local-mutes.json");
  }

  private load(): void {
    if (!fs.existsSync(this.file)) {
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(parsed)) {
        for (const r of parsed as MuteRecord[]) {
          if (r && typeof r.key === "string") {
            this.records.set(r.key, r);
          }
        }
      }
    } catch {
      // 壞掉的靜音檔不該讓擴充停擺，重新開始就好。
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify([...this.records.values()], null, 2) + "\n");
  }

  has(key: string): boolean {
    return this.records.has(key);
  }

  add(record: MuteRecord): void {
    this.records.set(record.key, record);
    this.save();
  }

  clear(): number {
    const n = this.records.size;
    this.records.clear();
    this.save();
    return n;
  }

  all(): MuteRecord[] {
    return [...this.records.values()];
  }

  /**
   * 匯出成給開發者看的報告。使用者改不了規則，但這份記錄是
   * 開發者調整規則時最有價值的素材 —— 尤其是使用者填的 reason。
   */
  toReport(): string {
    const records = this.all();
    if (records.length === 0) {
      return "# sensAI 誤報回報\n\n目前沒有記錄。\n";
    }
    const byRule = new Map<string, MuteRecord[]>();
    for (const r of records) {
      const k = r.ruleId ?? "(未命中規則)";
      byRule.set(k, [...(byRule.get(k) ?? []), r]);
    }
    const lines = [
      "# sensAI 誤報回報",
      "",
      `共 ${records.length} 筆，來自 ${byRule.size} 個規則。`,
      "",
      "同一條規則反覆被否決，通常代表該補一段 `except`。",
      "",
    ];
    const groups = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [ruleId, rs] of groups) {
      lines.push(`## ${ruleId} —— ${rs.length} 筆`, "");
      for (const r of rs) {
        lines.push(`- **${r.message}**`);
        lines.push(`  - 位置：\`${r.file}:${r.line}\``);
        lines.push(`  - 程式碼：\`${r.lineText.trim()}\``);
        lines.push(`  - AI 的說法：${r.triggerCondition} → ${r.consequence}`);
        if (r.reason.trim() !== "") {
          lines.push(`  - **使用者說明：${r.reason}**`);
        }
        lines.push("");
      }
    }
    return lines.join("\n");
  }
}
