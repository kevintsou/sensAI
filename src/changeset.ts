import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";
import { isInSkippedDir } from "./context";
import { SourceLanguage, detectLanguage } from "./language";
import { ChangesetRawFinding } from "./review";
import { Finding, HeaderFile } from "./types";

/**
 * 手動模式的「審查改動」：找出工作區裡相對 git HEAD 改過的檔案，一次送審。
 *
 * 這裡只放不依賴 vscode 的部分 —— git 輸出的解析、意見對回檔案、header 合併 ——
 * 這些的對錯要靠單元測試驗，Controller 在測試裡跑不起來。
 */

const run = promisify(execFile);

export interface ChangedFile {
  /** 相對工作區根目錄、以 / 分隔。 */
  relPath: string;
  filePath: string;
  language: SourceLanguage;
  /** 未追蹤（或 repo 還沒有任何 commit）：整份都算改動。 */
  untracked: boolean;
  /** 新增／刪除的行數。未追蹤的檔案沒有。 */
  added: number | null;
  deleted: number | null;
}

export class NotAGitRepoError extends Error {
  constructor() {
    super("這個工作區不在 git repo 裡，無法判定改動範圍。可改用 sensAI: Review Current File 審查單一檔案。");
    this.name = "NotAGitRepoError";
  }
}

/** 解析 `-z` 輸出的 NUL 分隔清單。 */
export function parseNulList(out: string): string[] {
  return out.split("\0").filter((s) => s !== "");
}

/**
 * 解析 `git diff --numstat -z --no-renames` 的輸出。
 *
 * 每筆是 `新增\t刪除\t路徑\0`；二進位檔的行數是 `-`。一定要配 --no-renames ——
 * 開了改名偵測，改名那筆的格式會變成 `新增\t刪除\t\0舊路徑\0新路徑\0`。
 */
export function parseNumstatZ(
  out: string,
): Array<{ path: string; added: number | null; deleted: number | null }> {
  const num = (s: string) => (s === "-" ? null : Number(s));
  const entries: Array<{ path: string; added: number | null; deleted: number | null }> = [];
  for (const rec of parseNulList(out)) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(rec);
    if (m) {
      entries.push({ path: m[3], added: num(m[1]), deleted: num(m[2]) });
    }
  }
  return entries;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/**
 * 列出工作區裡相對 HEAD 改過的 C／組語檔案，加上未追蹤的。
 *
 * 範圍限在工作區根目錄底下（--relative），工作區只是 repo 的一個子目錄時，
 * 不會把 repo 其他地方的改動也拉進來。被刪掉的檔案不列 —— 沒有內容可審。
 */
export async function listChangedFiles(root: string): Promise<ChangedFile[]> {
  try {
    await git(["rev-parse", "--is-inside-work-tree"], root);
  } catch {
    throw new NotAGitRepoError();
  }

  let hasHead = true;
  try {
    await git(["rev-parse", "--verify", "-q", "HEAD"], root);
  } catch {
    hasHead = false;
  }

  const files = new Map<string, ChangedFile>();
  const add = (rel: string, untracked: boolean, added: number | null, deleted: number | null) => {
    const relPath = rel.split(path.sep).join("/");
    const language = detectLanguage(relPath);
    if (!language) {
      return;
    }
    files.set(relPath, {
      relPath,
      filePath: path.join(root, relPath),
      language,
      untracked,
      added,
      deleted,
    });
  };

  if (hasHead) {
    const numstat = await git(
      ["diff", "--numstat", "-z", "--no-renames", "--diff-filter=d", "--relative", "HEAD"],
      root,
    );
    for (const e of parseNumstatZ(numstat)) {
      // 0 增 0 刪是只改了檔案權限，沒有內容可審。
      if (e.added === 0 && e.deleted === 0) {
        continue;
      }
      add(e.path, false, e.added, e.deleted);
    }
  } else {
    // 還沒有任何 commit：沒有 HEAD 可比，已 add 的檔案整份都算改動。
    for (const rel of parseNulList(await git(["ls-files", "-z", "--cached"], root))) {
      add(rel, true, null, null);
    }
  }

  for (const rel of parseNulList(await git(["ls-files", "-z", "--others", "--exclude-standard"], root))) {
    // 沒被 .gitignore 擋掉的 build 輸出常常一大片，header 索引也不掃這些目錄。
    if (isInSkippedDir(rel)) {
      continue;
    }
    add(rel, true, null, null);
  }

  return [...files.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function normalizeReported(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
}

/**
 * 把模型回報的 file 對到送審的檔案。對不上回 null。
 *
 * 依序：完全相同 → 後綴相符（模型寫了絕對路徑或多了前綴）→ 檔名相符。
 * 後兩步都要求唯一 —— 兩個 util.c 時寧可對不上，也不要把意見掛到錯的檔案，
 * 那會讓跳行、靜音、釘選全部作用在錯的地方。只送了一個檔案時沒有歧義，直接給它。
 */
export function matchFindingFile(reported: string, targets: string[]): string | null {
  const r = normalizeReported(reported);
  if (r !== "") {
    if (targets.includes(r)) {
      return r;
    }
    const suffix = targets.filter((t) => r.endsWith("/" + t) || t.endsWith("/" + r));
    if (suffix.length === 1) {
      return suffix[0];
    }
    const base = path.posix.basename(r);
    const byName = targets.filter((t) => path.posix.basename(t) === base);
    if (byName.length === 1) {
      return byName[0];
    }
  }
  return targets.length === 1 ? targets[0] : null;
}

/** 把整組的意見依檔案分開。對不上任何送審檔案的另外收著。 */
export function assignFindings(
  raw: ChangesetRawFinding[],
  targets: string[],
): { byFile: Map<string, Finding[]>; unknown: Finding[] } {
  const byFile = new Map<string, Finding[]>(targets.map((t) => [t, []]));
  const unknown: Finding[] = [];
  for (const { file, finding } of raw) {
    const target = matchFindingFile(file, targets);
    if (target === null) {
      unknown.push(finding);
    } else {
      byFile.get(target)!.push(finding);
    }
  }
  return { byFile, unknown };
}

/**
 * 合併每個送審檔案各自解析出的 header。
 *
 * 去掉重複，也去掉本身就在送審清單裡的 —— 那些會以「待審查檔案」的身分完整出現，
 * 再當附帶 header 送一次只是重複付錢，還會讓模型搞不清楚該不該審它。
 * 總量受 budgetBytes 限制，超過的不附，並標記截斷。
 */
export function mergeHeaders(
  perFile: Array<{ headers: HeaderFile[]; truncated: boolean }>,
  targetPaths: ReadonlySet<string>,
  budgetBytes: number,
): { headers: HeaderFile[]; truncated: boolean } {
  const seen = new Set<string>();
  const headers: HeaderFile[] = [];
  let bytes = 0;
  let truncated = perFile.some((c) => c.truncated);
  for (const ctx of perFile) {
    for (const h of ctx.headers) {
      const key = path.resolve(h.path);
      if (seen.has(key) || targetPaths.has(key)) {
        continue;
      }
      seen.add(key);
      if (bytes + h.text.length > budgetBytes) {
        truncated = true;
        continue;
      }
      bytes += h.text.length;
      headers.push(h);
    }
  }
  return { headers, truncated };
}

/**
 * 超過這個量就在勾選清單上警告。只警告、不擋 —— 要送多少由使用者決定。
 * 一次送太多，模型的注意力會被攤薄，跨檔案的問題反而容易漏，也比較慢、比較貴。
 */
export const LARGE_CHANGESET = { files: 10, bytes: 300_000 };

export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`;
}

/** 改動量太大時的警告文字；沒超過回 null。 */
export function changesetWarning(fileCount: number, bytes: number): string | null {
  if (fileCount <= LARGE_CHANGESET.files && bytes <= LARGE_CHANGESET.bytes) {
    return null;
  }
  return (
    `⚠ 改動較大（${fileCount} 個檔案、約 ${formatBytes(bytes)}）：一次送出會比較慢、較耗 token，` +
    "也容易漏掉跨檔案的問題。建議取消勾選跟這次改動無關的檔案。"
  );
}
