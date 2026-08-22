import * as fs from "fs";
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

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "obj", "Debug", "Release", ".vscode",
]);

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
  /** basename（小寫）→ 絕對路徑清單，用於相對路徑找不到時的後備查詢。 */
  headerIndex(): Map<string, string[]>;
}

export function realFileAccess(workspaceRoot: string): FileAccess {
  let index: Map<string, string[]> | null = null;
  return {
    exists: (p) => fs.existsSync(p),
    read: (p) => fs.readFileSync(p, "utf8"),
    headerIndex: () => {
      if (!index) {
        index = buildHeaderIndex(workspaceRoot);
      }
      return index;
    },
  };
}

function buildHeaderIndex(root: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const stack: string[] = [root];
  // 大型 repo 上避免無止境地走；韌體專案通常遠低於這個數字。
  let visited = 0;
  while (stack.length > 0 && visited < 20000) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
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
function resolveInclude(
  spec: string,
  fromFile: string,
  opts: ContextOptions,
  fa: FileAccess,
): string | null {
  const candidates = [
    path.resolve(path.dirname(fromFile), spec),
    path.resolve(opts.workspaceRoot, spec),
  ];
  for (const c of candidates) {
    if (fa.exists(c)) {
      return c;
    }
  }
  const matches = fa.headerIndex().get(path.basename(spec).toLowerCase());
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
export function buildContext(
  filePath: string,
  source: string,
  opts: ContextOptions,
  fa: FileAccess = realFileAccess(opts.workspaceRoot),
): ReviewContext {
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
        const resolved = resolveInclude(spec, node.file, opts, fa);
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
