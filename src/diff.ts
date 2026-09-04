import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";

const run = promisify(execFile);

export interface LineRange {
  /** 1-based，含。 */
  start: number;
  /** 1-based，含。 */
  end: number;
}

/**
 * null 代表「無法判定改動範圍」—— 檔案不在 git 版控下、不是 git repo，
 * 或 git 執行失敗。呼叫端應該退回整份檔案審查，而不是當成「沒有改動」。
 * 空陣列則是明確的「相對 HEAD 沒有任何改動」。
 */
export type ChangedRanges = LineRange[] | null;

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * 解析 `git diff -U0` 的 hunk 標頭，取出新檔案這一側的改動行號範圍。
 *
 * 分離成純函式是為了可測試 —— 驗證範圍計算不需要真的建一個 git repo。
 */
export function parseDiffRanges(diff: string): LineRange[] {
  const ranges: LineRange[] = [];
  for (const line of diff.split("\n")) {
    const m = HUNK_RE.exec(line);
    if (!m) {
      continue;
    }
    const start = Number(m[1]);
    // 省略 count 代表 1 行；`@@ -a,b +c,0 @@` 是純刪除。
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) {
      // 純刪除在新檔案裡沒有對應的行，但刪掉一行也可能是 bug（例如刪掉了
      // 一個 fence）。標記刪除位置的那一行，讓模型有地方可以看。
      const at = Math.max(1, start);
      ranges.push({ start: at, end: at });
    } else {
      ranges.push({ start, end: start + count - 1 });
    }
  }
  return mergeRanges(ranges);
}

/** 相鄰或重疊的範圍合併，送進 prompt 的清單才不會又長又碎。 */
export function mergeRanges(ranges: LineRange[]): LineRange[] {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: LineRange[] = [{ ...sorted[0] }];
  for (const r of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** 這次審查是誰發動的。存檔與手動觸發對「沒有改動」的處置不同。 */
export type ReviewTrigger = "save" | "manual";

/**
 * 這次要怎麼審。
 *
 * - `skip`      不送任何東西出去。
 * - `full`      單階段，審整份檔案。
 * - `two-stage` 階段一只看改動處、階段二審整份，最後合併去重。
 */
export type ReviewPlan =
  | { kind: "skip"; reason: "unchanged" }
  | { kind: "full" }
  | { kind: "two-stage"; changed: LineRange[] };

/**
 * 決定這次存檔／手動觸發要不要審、以及要用哪種流程。
 *
 * 存檔的觸發條件是「存檔**且**檔案相對 HEAD 有改動」。兩者缺一就不審 ——
 * 沒有改動的存檔（改完又改回來、格式化工具沒動到東西、單純按慣性 Ctrl+S）
 * 送出去只是重跑一次上一次剛跑過的內容，白花一次請求。
 *
 * 但「無法判定」不等於「沒有改動」：檔案未追蹤或這裡根本不是 git repo 時
 * `changed` 是 null，那種情況照樣要審，否則非 git 專案會變成完全不會動。
 * 這也是為什麼 changedRanges() 刻意區分 null 與空陣列。
 *
 * 手動觸發一律照審。使用者明確叫了 Review Current File，回他一句「沒有改動」
 * 不是他要的 —— 剛 commit 完想重看一次整份檔案是完全合理的用法。
 */
export function planReview(trigger: ReviewTrigger, changed: ChangedRanges): ReviewPlan {
  if (changed === null) {
    return { kind: "full" };
  }
  if (changed.length === 0) {
    return trigger === "save" ? { kind: "skip", reason: "unchanged" } : { kind: "full" };
  }
  return { kind: "two-stage", changed };
}

export function isInRanges(line: number, ranges: LineRange[]): boolean {
  return ranges.some((r) => line >= r.start && line <= r.end);
}

export function describeRanges(ranges: LineRange[]): string {
  return ranges.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)).join("、");
}

/**
 * 取得檔案相對於 git HEAD 的改動行號範圍。
 *
 * 未追蹤的檔案會回 null 而不是「整份都是改動」—— 那種情況下階段一與階段二
 * 的範圍完全相同，跑兩次只是浪費，呼叫端會退回單階段。
 */
export async function changedRanges(filePath: string, cwd: string): Promise<ChangedRanges> {
  // 先跑 diff。有輸出就代表這個檔案一定有被追蹤，可以省掉 ls-files ——
  // 而「有改動」正是常見的情況，也是唯一需要繼續往下算的情況。
  let diff: string;
  try {
    const { stdout } = await run(
      "git",
      ["diff", "-U0", "--no-color", "HEAD", "--", filePath],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
    );
    diff = stdout;
  } catch {
    return null; // 不是 git repo，或 git 執行失敗
  }

  const ranges = parseDiffRanges(diff);
  if (ranges.length > 0) {
    return ranges;
  }

  // diff 是空的：可能是「沒有改動」，也可能是「未追蹤」（未追蹤的檔案
  // diff 一樣沒有輸出）。這兩者的處置完全相反，所以這時候才需要問一次。
  try {
    await run("git", ["ls-files", "--error-unmatch", "--", filePath], { cwd });
    return [];
  } catch {
    return null;
  }
}

/** git 指令要在檔案所在的 repo 裡跑，工作區根目錄未必就是 repo 根目錄。 */
export function gitCwd(filePath: string): string {
  return path.dirname(filePath);
}
