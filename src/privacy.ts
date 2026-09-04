import * as fs from "fs";
import * as path from "path";
import { minimatch } from "minimatch";
import { ProjectConfig } from "./config";
import { ReviewContext } from "./types";

/**
 * 韌體原始碼通常受 NDA 保護。這裡的判斷要保守：
 * 只要受審檔案或任何一個附帶的 header 命中 never_send，整次審查就跳過。
 * 不做遮蔽後照送 —— 部分遮蔽的檔案仍然洩漏結構，而且很難驗證遮乾淨了。
 */
export function blockedPaths(ctx: ReviewContext, config: ProjectConfig, workspaceRoot: string): string[] {
  const patterns = config.privacy.neverSend;
  if (patterns.length === 0) {
    return [];
  }
  const candidates = [ctx.filePath, ...ctx.headers.map((h) => h.path)];
  return candidates.filter((p) => {
    const rel = path.relative(workspaceRoot, p).split(path.sep).join("/");
    return patterns.some((pat) => minimatch(rel, pat, { dot: true }));
  });
}

export interface AuditEntry {
  ts: string;
  file: string;
  /**
   * 這次請求的結果。
   *
   * 失敗的請求同樣要記 —— 送到一半才 500 或逾時的情況下，原始碼已經
   * 離開這台機器了。稽核日誌在失敗時留白，等於在最需要它的時候沒有記錄。
   */
  outcome: "ok" | "failed" | "cancelled";
  headers: number;
  bytes: number;
  endpoint: string;
  model: string;
  findings: number;
  dropped: number;
  durationMs: number;
}

/**
 * 每次外送寫一筆稽核記錄，讓資安稽核有跡可循。
 * 寫不進去不該讓審查失敗，所以錯誤在這裡吞掉。
 */
export function appendAudit(workspaceRoot: string, config: ProjectConfig, entry: AuditEntry): void {
  const target = config.privacy.auditLog;
  if (!target) {
    return;
  }
  const file = path.isAbsolute(target) ? target : path.join(workspaceRoot, target);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    // 稽核寫入失敗不影響審查結果本身。
  }
}
