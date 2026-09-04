import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { SourceLanguage } from "./language";
import { HeaderFile, ReviewContext } from "./types";

/**
 * 只處理引號式 include；`<...>` 是系統 header，跳過。
 *
 * 兩種形式都收：`#include "x.h"`（C，以及經過前處理器的 .S）
 * 與 `.include "x.inc"`（GAS 的 .s）。
 */
const INCLUDE_RE = /^[ \t]*(?:#[ \t]*include|\.include)[ \t]*"([^"]+)"/gm;

export const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "obj", "Debug", "Release", ".vscode",
]);

/**
 * 路徑（相對 workspace root）是否落在會被 buildHeaderIndex 跳過的目錄裡。
 *
 * header 索引不掃這些目錄，所以這些目錄裡的 header 增刪**不該**讓索引失效 ——
 * 韌體專案一 build 就在 build/out 產出／刪除大量 .h，若不濾掉，快取會被反覆
 * 清空，等於每次 review 又全樹重掃。watcher 的失效回呼用這個把它們擋掉。
 */
export function isInSkippedDir(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg));
}

const HEADER_EXTS = new Set([".h", ".hpp", ".hh", ".inc", ".s", ".S"]);

export interface ContextOptions {
  workspaceRoot: string;
  language: SourceLanguage;
  /** #include 的遞迴深度。1 = 只抓直接引用的 header。 */
  depth: number;
  /** 附帶 header 的總位元組上限。 */
  budgetBytes: number;
}

export interface FileAccess {
  exists(p: string): boolean;
  read(p: string): string;
  /**
   * basename（小寫）→ 絕對路徑清單，用於相對路徑找不到時的後備查詢。
   *
   * 非同步：這是一趟整棵樹的走訪，在 extension host 執行緒上同步跑會讓
   * 整個 VS Code 卡住（實測 25600 個 header 要 229 ms）。
   */
  headerIndex(): Promise<Map<string, string[]>>;
}

/**
 * 帶「失效」能力的 FileAccess。header 索引是走整棵樹的同步掃描，很貴 ——
 * 一定要跨 review 快取，只在 header 檔案增刪時才重建。
 */
export interface CachingFileAccess extends FileAccess {
  /** 丟掉快取的 header 索引，下次查詢時重建。header 檔增刪時呼叫。 */
  invalidateIndex(): void;
}

/**
 * 建立一個跨 review 共用的 FileAccess。
 *
 * 關鍵在於**這個實例要被留著重用**：header 索引 lazy-build 一次後就快取，
 * 不要每次 review 都 new 一個新的（那會讓整棵樹的同步掃描每次存檔重跑，
 * 阻塞 extension host）。索引的失效由呼叫端在 header 檔增刪時觸發。
 */
export function realFileAccess(
  workspaceRoot: string,
  onWarn: (message: string) => void = () => {},
  maxEntries: number = MAX_INDEX_ENTRIES,
): CachingFileAccess {
  let index: Map<string, string[]> | null = null;
  // 併發的 review 共用同一次建立，不要各自走一趟樹。
  let building: Promise<Map<string, string[]>> | null = null;
  return {
    exists: (p) => fs.existsSync(p),
    read: (p) => fs.readFileSync(p, "utf8"),
    headerIndex: async () => {
      if (index) {
        return index;
      }
      if (!building) {
        building = buildHeaderIndex(workspaceRoot, onWarn, maxEntries).then((built) => {
          index = built;
          building = null;
          return built;
        });
      }
      return building;
    },
    invalidateIndex: () => {
      index = null;
      building = null;
    },
  };
}

/**
 * 走訪的項目數上限。
 *
 * 純粹是防呆，避免在意外巨大的樹上走到天荒地老 —— 不是效能手段，走訪本身
 * 已經是非同步的了。打到上限代表索引不完整：解析不到的 include 就不會附上，
 * 模型少了那份 macro 與暫存器定義，會給出「聽起來合理但錯誤」的判斷。
 * 所以打到了一定要講，不能無聲。
 */
export const MAX_INDEX_ENTRIES = 200000;

async function buildHeaderIndex(
  root: string,
  onWarn: (message: string) => void,
  maxEntries: number,
): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  const stack: string[] = [root];
  let visited = 0;
  let truncated = false;

  // 上限在每個目錄開始前檢查，所以單一目錄一定會被讀完 —— 真實的風險是
  // 目錄數量，不是單一目錄的大小，不值得為此在迴圈內再加一層判斷。
  while (stack.length > 0) {
    if (visited >= maxEntries) {
      truncated = true;
      break;
    }
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          stack.push(path.join(dir, entry.name));
        }
      } else if (HEADER_EXTS.has(path.extname(entry.name))) {
        const key = entry.name.toLowerCase();
        const list = index.get(key) ?? [];
        list.push(path.join(dir, entry.name));
        index.set(key, list);
      }
    }
  }

  if (truncated) {
    onWarn(
      `header 索引在走訪 ${visited} 個項目後達到上限（${maxEntries}），索引不完整。` +
        "落在未掃到範圍的 header 將無法被 include 解析，附給模型的上下文會缺一角。" +
        "請把不需要索引的目錄排除，或縮小 workspace 範圍。",
    );
  }
  return index;
}

function extractIncludes(text: string): string[] {
  const out: string[] = [];
  INCLUDE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INCLUDE_RE.exec(text)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * 把 include 指到的檔案解析成絕對路徑。
 *
 * 依序試：引用檔案所在目錄 → workspace root → 全專案 header 索引裡
 * 同 basename 的檔案。最後一步是為了處理 build system 有設 include path、
 * 但我們拿不到那份設定的情況。
 */
async function resolveInclude(
  spec: string,
  fromFile: string,
  opts: ContextOptions,
  fa: FileAccess,
): Promise<string | null> {
  const candidates = [
    path.resolve(path.dirname(fromFile), spec),
    path.resolve(opts.workspaceRoot, spec),
  ];
  for (const c of candidates) {
    if (fa.exists(c)) {
      return c;
    }
  }
  const matches = (await fa.headerIndex()).get(path.basename(spec).toLowerCase());
  if (matches && matches.length > 0) {
    // 多個同名檔案時，選路徑最短的 —— 通常是最上層、最通用的那份。
    return [...matches].sort((a, b) => a.length - b.length)[0];
  }
  return null;
}

/**
 * 組出要送給模型的上下文：受審檔案本身，加上它引用到的專案內 header。
 *
 * 韌體 C 重度依賴 macro 與 header，只送單檔的話模型會對
 * `HAL_UART_Transmit(&huart1, ...)` 這類呼叫給出聽起來合理但錯誤的判斷。
 */
export async function buildContext(
  filePath: string,
  source: string,
  opts: ContextOptions,
  fa: FileAccess = realFileAccess(opts.workspaceRoot),
): Promise<ReviewContext> {
  const headers: HeaderFile[] = [];
  const visited = new Set<string>([path.resolve(filePath)]);
  let bytes = 0;
  let truncated = false;

  // BFS：直接引用的 header 先進來，才不會在預算用完時剩下一堆間接引用。
  let frontier: Array<{ file: string; text: string }> = [{ file: filePath, text: source }];

  for (let d = 0; d < Math.max(0, opts.depth) && frontier.length > 0; d++) {
    const next: Array<{ file: string; text: string }> = [];
    for (const node of frontier) {
      for (const spec of extractIncludes(node.text)) {
        const resolved = await resolveInclude(spec, node.file, opts, fa);
        if (!resolved || visited.has(resolved)) {
          continue;
        }
        visited.add(resolved);

        let text: string;
        try {
          text = fa.read(resolved);
        } catch {
          continue;
        }

        if (bytes + text.length > opts.budgetBytes) {
          truncated = true;
          continue;
        }
        bytes += text.length;
        headers.push({ path: resolved, text });
        next.push({ file: resolved, text });
      }
    }
    frontier = next;
  }

  return { filePath, source, headers, truncated, language: opts.language };
}
