import * as path from "path";

export type SourceLanguage = "c" | "asm";

/**
 * 用副檔名判斷，不用 VS Code 的 languageId。
 *
 * `.s` 在沒裝組語擴充的環境下 languageId 會是 plaintext，
 * 而韌體團隊的機器上裝了什麼並不一定。
 */
export function detectLanguage(filePath: string): SourceLanguage | null {
  switch (path.extname(filePath)) {
    case ".c":
    case ".h":
      return "c";
    case ".s":
    case ".S":
      return "asm";
    default:
      return null;
  }
}

export const LANGUAGE_LABEL: Record<SourceLanguage, string> = {
  c: "C",
  asm: "組合語言",
};
