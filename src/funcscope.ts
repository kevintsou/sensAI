import { LineRange, mergeRanges } from "./diff";

/**
 * 把「改動的行」拓寬到「改動所在的函式」。
 *
 * sensAI 不剖析 C 語法，這裡是啟發式：靠大括號配對找出包住改動行的那個
 * 頂層 `{ ... }` 區塊，把範圍拓寬到整個區塊。拓不出來就回原範圍 —— 改動
 * 落在函式外（全域宣告、巨集、檔案開頭）或語法太亂配不起來時，寧可只看
 * 改動行，也不要把半個檔案誤當成一個函式。
 *
 * 已知限制：大括號計數不理會字串常數、字元常數與註解裡的 `{` `}`。韌體
 * C 這類情況少，真的遇到最壞也只是範圍算歪，退回原行由階段一/三兜底，
 * 不會漏審（整份檔案審查仍可由 config 開啟）。
 */

/** 去掉會誤導大括號計數的內容：行註解、區塊註解、字串／字元常數。 */
function stripNoise(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    // 行註解到行尾都不算。
    if (c === "/" && line[i + 1] === "/") {
      break;
    }
    // 字串／字元常數整段跳過（含跳脫）。
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < line.length && line[i] !== quote) {
        if (line[i] === "\\") {
          i++;
        }
        i++;
      }
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * 逐行預先算好「這一行有沒有在區塊註解裡」以及「去雜訊後的內容」。
 *
 * 區塊註解 `/* ... *​/` 可能跨行，所以要一次掃完整份檔案、維持狀態，不能
 * 逐行獨立判斷。
 */
function cleanLines(lines: string[]): string[] {
  const cleaned: string[] = [];
  let inBlockComment = false;
  for (const raw of lines) {
    let line = raw;
    let out = "";
    let i = 0;
    while (i < line.length) {
      if (inBlockComment) {
        const end = line.indexOf("*/", i);
        if (end === -1) {
          i = line.length;
        } else {
          i = end + 2;
          inBlockComment = false;
        }
        continue;
      }
      const start = line.indexOf("/*", i);
      if (start === -1) {
        out += line.slice(i);
        break;
      }
      out += line.slice(i, start);
      i = start + 2;
      inBlockComment = true;
    }
    cleaned.push(stripNoise(out));
  }
  return cleaned;
}

/** 統計一行淨內容裡 `{` 與 `}` 的淨增減。 */
function braceDelta(cleanLine: string): number {
  let d = 0;
  for (const c of cleanLine) {
    if (c === "{") d++;
    else if (c === "}") d--;
  }
  return d;
}

/**
 * 找出包住 `line`（1-based）的頂層大括號區塊 [start, end]（1-based，含）。
 *
 * 演算法：算出每一行結束時的大括號深度。改動行若落在深度 ≥ 1 的區塊內，
 * 往上找該區塊起始的 `{`（深度從 0 → 1 的那一行），往下找回到 0 的那一行。
 * 回 null 代表 line 不在任何區塊內（深度是 0），或配對不起來。
 */
function enclosingBlock(cleaned: string[], line: number): LineRange | null {
  // depthAfter[i] = 掃完第 i 行（0-based）後的大括號深度。
  const depthAfter: number[] = [];
  let depth = 0;
  for (let i = 0; i < cleaned.length; i++) {
    depth += braceDelta(cleaned[i]);
    depthAfter.push(depth);
  }
  const idx = line - 1;
  if (idx < 0 || idx >= cleaned.length) {
    return null;
  }

  // 改動行「之前」的深度（掃完上一行後）。深度 0 代表這行在任何區塊之外
  // 開頭；但這一行自己可能就是 `{` 起始，所以還要看行內。
  const depthBefore = idx === 0 ? 0 : depthAfter[idx - 1];
  const depthAtLineEnd = depthAfter[idx];

  // 落在函式外：進來是 0、出去也是 0（例如全域宣告、巨集）。
  // 唯一例外是這行自己既開又關（單行函式），那 depthBefore/End 都是 0 但
  // 行內有 `{`；這種極少見，保守起見一樣退回，不特別處理。
  if (depthBefore <= 0 && depthAtLineEnd <= 0) {
    return null;
  }

  // 往上找：第一個「掃完後深度為 0」的行，它的下一行就是大括號起點。
  let braceOpen = 0; // 預設到檔案開頭
  for (let i = idx - 1; i >= 0; i--) {
    if (depthAfter[i] <= 0) {
      braceOpen = i + 1;
      break;
    }
  }
  // 大括號起點的上方通常是函式簽名（可能跨行），要一起納入。往上收攏連續的
  // 非空行，遇到空行、或以 ; } { 結尾的行（代表上一個陳述／區塊已結束）就停。
  let start = braceOpen;
  for (let i = braceOpen - 1; i >= 0; i--) {
    const t = cleaned[i].trim();
    if (t === "") {
      break;
    }
    const last = t[t.length - 1];
    if (last === ";" || last === "}" || last === "{") {
      break;
    }
    start = i;
  }
  // 往下找：第一個「掃完後深度回到 0」的行，就是區塊終點。
  let end = -1;
  for (let i = idx; i < cleaned.length; i++) {
    if (depthAfter[i] <= 0) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return null; // 大括號沒收完（檔案被截斷或配對歪了）
  }
  return { start: start + 1, end: end + 1 };
}

/**
 * 把每段改動範圍拓寬到它所在的函式，回傳合併後的範圍。
 *
 * 任何一段拓不出來（落在函式外或配不起來）就保留該段原樣。整體不會小於
 * 原本的改動範圍 —— 拓寬只增不減。
 */
export function expandToEnclosingFunction(source: string, changed: LineRange[]): LineRange[] {
  if (changed.length === 0) {
    return [];
  }
  const cleaned = cleanLines(source.split("\n"));
  const out: LineRange[] = [];
  for (const range of changed) {
    // 用範圍的起點與終點各找一次區塊，聯集起來 —— 改動可能橫跨函式邊界。
    const a = enclosingBlock(cleaned, range.start);
    const b = enclosingBlock(cleaned, range.end);
    if (!a && !b) {
      out.push({ ...range }); // 拓不出來：保留原範圍
      continue;
    }
    const lo = Math.min(range.start, a?.start ?? range.start, b?.start ?? range.start);
    const hi = Math.max(range.end, a?.end ?? range.end, b?.end ?? range.end);
    out.push({ start: lo, end: hi });
  }
  return mergeRanges(out);
}
