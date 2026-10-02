import { ArchFacts } from "./abi";
import { LineRange, describeRanges } from "./diff";
import { LANGUAGE_LABEL, SourceLanguage } from "./language";
import { ChangesetContext, Rule, ReviewContext, SYNTAX_RULE_ID } from "./types";

const DISCIPLINE = `每一則意見都必須填滿：
- trigger_condition —— 什麼情況下會出事，要具體到哪個時序、哪個呼叫順序、哪個中斷時機
- consequence —— 會造成什麼結果
- evidence —— 引用檔案裡實際存在的識別字或行號

**如果你講不出具體的 trigger_condition，就不要回報這一則。**

語法與型別錯誤是唯一的例外。這類問題在編譯或組譯階段就會失敗，沒有執行時的觸發時序，
所以不適用上面那條。回報這類問題時：
- trigger_condition 寫編譯當下會發生什麼，例如「編譯時，第 28 行的 xxxx 無法解析為任何宣告」
- severity 一律填 error —— 這種檔案根本產不出可執行檔
- rule_id 填 "${SYNTAX_RULE_ID}"

寧可少報。一則錯誤的意見造成的信任損失，大於漏掉一則真實問題。

用繁體中文回答。`;

/**
 * 拆成「開場、檢查清單、收尾」三段：單檔審查照原樣串起來，審查整組改動時
 * 只借用中間的檢查清單 —— 開場與收尾講的是「單一檔案」，套到多檔案會互相矛盾。
 */
const C_CHECKS = `值得回報的：
- 語法與型別錯誤：無法編譯的寫法、未宣告的識別字、缺少分號、括號或大括號不成對、
  型別不相容的指派、函式呼叫的參數數量或型別不符、對不完整型別取值。
  不要假設有其他工具會抓這些 —— 這台機器上不一定裝了編譯器或 clangd
- 硬體暫存器操作錯誤（用 |= 去清 write-1-clear 位元、寫入唯讀暫存器、缺少解鎖序列）
- 中斷與併發（ISR 與主程式共享的狀態缺 volatile、read-modify-write 缺臨界區、缺 memory barrier）
- DMA 與 cache 一致性
- 會被編譯器優化掉的程式碼（busy-wait、delay loop、被優化掉的暫存器讀取）
- 整數溢位、位元運算寬度錯誤、有號與無號轉換在暫存器操作上出錯
- 緩衝區邊界、堆疊用量
- 違反下方「專案規則」的地方

不要回報的：
- 命名、排版、註解、可讀性
- 泛泛的「建議加強錯誤處理」「建議檢查回傳值」—— 除非你能指出這個特定呼叫失敗時會造成什麼具體後果
- 你只是覺得「可能有問題」但講不出觸發條件的東西`;

const C_PROMPT = `你是一位資深韌體工程師，正在審查一個 ARM / Andes AndeStar V5 專案裡的單一 C 檔案。

你的任務是找出**會造成實際故障**的問題，而且只回報你說得出具體失效情境的問題。

${C_CHECKS}

附上的 header 只是讓你理解 macro 與型別定義，**不要審查 header 本身**，只審查目標 C 檔案。`;

const ASM_CHECKS = `值得回報的：
- 語法錯誤：組譯器無法組譯的寫法、拼錯的指令助憶碼、運算元數量不對、
  不合法的定址模式、寫錯的 directive。
  不要假設有其他工具會抓這些 —— 這台機器上不一定裝了組譯器
- ABI 違規：修改了 callee-saved 暫存器，但 prologue 沒保存或 epilogue 沒還原
- return address 暫存器在呼叫其他函式前沒有保存
- 堆疊不平衡：prologue 與 epilogue 的 sp 調整量不相等，或某條返回路徑沒有還原 sp
- 堆疊對齊不符合架構要求
- 存在沒有以返回指令結束的執行路徑
- 分支或跳躍到未定義的 label
- MMIO 存取缺少必要的 fence 或 barrier，或順序假設不成立
- 與 C 端宣告不一致：讀取了超出宣告參數數量的參數暫存器、
  C 宣告非 void 卻沒有寫入回傳值暫存器
- 使用了目標架構不支援的指令
- 違反下方「專案規則」的地方

不要回報的：
- label 命名、排版、註解、對齊風格
- 「這幾行可以用更少指令寫完」這類優化建議 —— 除非現在的寫法是錯的
- 你只是覺得「可能有問題」但講不出觸發條件的東西

碰到巨集展開、條件組譯，或是你無法確定控制流的區段時，就不要對那個區段下判斷 ——
說不準的時候閉嘴，比猜錯有價值。`;

const ASM_PROMPT = `你是一位資深韌體工程師，正在審查一個組合語言檔案。

組語沒有型別檢查、沒有編譯器幫忙擋錯，一個 ABI 違規造成的狀態損毀通常會在
離錯誤發生點很遠的地方才炸開。你的任務是找出這類問題。

${ASM_CHECKS}

附上的 include 檔案只是讓你理解常數與巨集定義，**不要審查那些檔案**，只審查目標檔案。`;

/**
 * 沒有任何專案規則時附加這段。
 *
 * 這種情況下放行整套審查，會拿到任何通用工具都給得出的泛泛意見 —— 那正是
 * 這個專案一開始要避開的東西。但語法錯誤不一樣：它的對錯不依賴專案知識，
 * 而且這台機器上不一定裝了編譯器。所以退化成只做語法檢查，而不是整個不做。
 */
const SYNTAX_ONLY = `## 本次審查的範圍限制

這個專案沒有提供任何適用於本語言的規則。**只回報語法與型別錯誤**，
其他一律不要回報 —— 包括你依通用知識判斷有問題的地方。

沒有專案規則的情況下，通用意見的價值不足以打擾作者。語法錯誤是唯一的例外，
因為它的對錯不需要任何專案背景知識就能確定。

沒有語法錯誤的話，回傳空陣列。`;

export function systemPrompt(
  language: SourceLanguage,
  arch: ArchFacts | null,
  syntaxOnly = false,
): string {
  const base = language === "asm" ? ASM_PROMPT : C_PROMPT;
  const facts = language === "asm" && arch ? `\n\n## 架構事實\n\n${arch.text}` : "";
  const scope = syntaxOnly ? `\n\n${SYNTAX_ONLY}` : "";
  return `${base}${facts}${scope}\n\n${DISCIPLINE}`;
}

function renderRule(r: Rule, appliesTo = ""): string {
  const parts = [`### ${r.id}（severity: ${r.severity}）${appliesTo}`, r.rule.trim()];
  if (r.except) {
    parts.push(`不算問題的例外：\n${r.except.trim()}`);
  }
  if (r.examples?.bad) {
    parts.push("錯誤示範：\n```\n" + r.examples.bad.trim() + "\n```");
  }
  if (r.examples?.good) {
    parts.push("正確做法：\n```\n" + r.examples.good.trim() + "\n```");
  }
  return parts.join("\n\n");
}

/** 加上行號，模型回報的 line 才對得準。 */
function numbered(source: string): string {
  const lines = source.split("\n");
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`).join("\n");
}

export function buildUserMessage(
  ctx: ReviewContext,
  rules: Rule[],
  changed: LineRange[] | null = null,
): string {
  const fence = ctx.language === "asm" ? "asm" : "c";
  const sections: string[] = [];

  // 放第一段而不是夾在規則後面 —— 範圍限制埋在中間很容易被忽略。
  if (changed && changed.length > 0) {
    sections.push(
      "## 本次只看這幾行\n\n" +
        `作者剛剛改動的是第 ${describeRanges(changed)} 行。` +
        "**只回報問題本身落在這些行上的意見**，其他行有問題也先不要提 —— " +
        "那些會由另一次完整審查負責。\n\n" +
        "整份檔案還是附在下面，因為判斷這幾行對不對需要看得懂上下文" +
        "（例如某個暫存器的宣告在別的地方）。附上全文是為了讓你有依據，" +
        "不是要你審查全文。",
    );
  }

  if (rules.length > 0) {
    sections.push(
      "## 專案規則\n\n這些是本專案的硬體特性與團隊慣例，優先於你的通用知識。\n\n" +
        rules.map((r) => renderRule(r)).join("\n\n"),
    );
  }

  if (ctx.headers.length > 0) {
    const label =
      ctx.language === "asm"
        ? "附帶的 include 檔案（僅供理解常數與巨集，不要審查這些檔案）"
        : "附帶的 header（僅供理解 macro 與型別，不要審查這些檔案）";
    const body = ctx.headers
      .map((h) => `### ${h.path}\n\`\`\`\n${h.text}\n\`\`\``)
      .join("\n\n");
    sections.push(`## ${label}\n\n${body}`);
  }

  if (ctx.truncated) {
    sections.push("（部分 include 因為長度上限沒有附上。判斷不確定時，寧可不報。）");
  }

  sections.push(
    `## 待審查檔案：${ctx.filePath}\n\n` +
      "行號已標在每行前面，回報時請使用這些行號。\n\n" +
      "```" +
      fence +
      "\n" +
      numbered(ctx.source) +
      "\n```",
  );

  return sections.join("\n\n---\n\n");
}

const CHANGESET_INTRO = `你是一位資深韌體工程師，正在審查一組還沒 commit 的改動。作者已經把這一組改完，
現在一次送審 —— 改動可能跨好幾個函式、好幾個檔案，C 與組合語言都有可能。

你的任務是找出**會造成實際故障**的問題，而且只回報你說得出具體失效情境的問題。`;

const CROSS_FILE = `## 跨檔案的一致性

一次看整組改動，就是為了抓單看一個檔案抓不到的問題。特別注意：
- header 裡的宣告（函式簽名、struct 欄位、macro、enum 值）改了，其他檔案的使用處沒有跟著改
- 呼叫端與被呼叫端對參數、回傳值、單位、緩衝區大小或所有權的假設不一致
- 一個檔案新增或改變了共享狀態、ISR、鎖，另一個檔案存取它的方式沒有對應的保護
- 組語與 C 端的宣告不一致（參數數量、回傳值、暫存器約定）

這類意見回報在**需要修改的那一邊**，evidence 裡同時引用兩邊的檔案路徑與識別字。`;

const CHANGESET_SCOPE = `## 審查範圍

每個待審查檔案前面都標了「審查範圍」—— 改動的行加上它們所在的函式。
**只回報問題本身落在範圍內的意見**；範圍外的內容是讓你理解上下文用的，不要審查。

「附帶的 header」不在這組改動裡，只供理解 macro 與型別，不要審查。

每則意見的 file 必須是待審查檔案標題裡的路徑，原樣照抄；line 是那個檔案自己的行號。`;

/**
 * 審查整組改動用的 system prompt。
 *
 * 檢查清單沿用單檔審查的那一份（C_CHECKS／ASM_CHECKS），只換掉開場與收尾，
 * 兩種審查對「什麼值得回報」的標準才不會分岔。
 *
 * syntaxOnly 是「沒有專案規則的語言」。全部語言都沒規則時，退化成單純的語法
 * 檢查 —— 跨檔案的一致性那段也不放，否則跟「只回報語法錯誤」互相矛盾。
 * 只有部分語言沒規則時，那個語言的檔案只做語法檢查，跟單檔審查的行為一致。
 */
export function changesetSystemPrompt(
  languages: ReadonlySet<SourceLanguage>,
  arch: ArchFacts | null,
  syntaxOnly: ReadonlySet<SourceLanguage>,
): string {
  const allSyntaxOnly = [...languages].every((l) => syntaxOnly.has(l));
  const parts = [CHANGESET_INTRO];
  if (!allSyntaxOnly) {
    parts.push(CROSS_FILE);
  }
  const section = (lang: SourceLanguage, checks: string) => {
    if (!languages.has(lang) || allSyntaxOnly) {
      return;
    }
    parts.push(
      syntaxOnly.has(lang)
        ? `## ${LANGUAGE_LABEL[lang]}檔案\n\n這個專案沒有適用於${LANGUAGE_LABEL[lang]}的規則：` +
            "這類檔案**只回報語法與型別錯誤**，其他一律不要回報。"
        : `## ${LANGUAGE_LABEL[lang]}檔案\n\n${checks}`,
    );
  };
  section("c", C_CHECKS);
  section("asm", ASM_CHECKS);
  if (languages.has("asm") && arch) {
    parts.push(`## 架構事實\n\n${arch.text}`);
  }
  parts.push(CHANGESET_SCOPE);
  if (allSyntaxOnly) {
    parts.push(SYNTAX_ONLY);
  }
  parts.push(DISCIPLINE);
  return parts.join("\n\n");
}

/** 審查整組改動用的 user message。 */
export function buildChangesetMessage(cs: ChangesetContext, rules: Rule[]): string {
  const languages = new Set(cs.targets.map((t) => t.language));
  const sections: string[] = [];

  // 放第一段：先讓模型知道這次有哪些檔案、各自要看哪裡，再往下讀內容。
  const overview = cs.targets
    .map((t) => `- ${t.relPath}（${LANGUAGE_LABEL[t.language]}，${scopeLabel(t.scope)}）`)
    .join("\n");
  sections.push(`## 這組改動（${cs.targets.length} 個檔案）\n\n${overview}`);

  if (rules.length > 0) {
    // 兩種語言都在時，標出只適用於其中一種的規則 —— 把 C 的規則套到組語上只會製造誤報。
    const tag = (r: Rule) =>
      languages.size > 1 && r.languages.length === 1
        ? `（只適用於${LANGUAGE_LABEL[r.languages[0]]}檔案）`
        : "";
    sections.push(
      "## 專案規則\n\n這些是本專案的硬體特性與團隊慣例，優先於你的通用知識。\n\n" +
        rules.map((r) => renderRule(r, tag(r))).join("\n\n"),
    );
  }

  if (cs.headers.length > 0) {
    const body = cs.headers
      .map((h) => `### ${h.path}\n\`\`\`\n${h.text}\n\`\`\``)
      .join("\n\n");
    sections.push(`## 附帶的 header（僅供理解 macro 與型別，不要審查這些檔案）\n\n${body}`);
  }

  if (cs.truncated) {
    sections.push("（部分 include 因為長度上限沒有附上。判斷不確定時，寧可不報。）");
  }

  for (const t of cs.targets) {
    const fence = t.language === "asm" ? "asm" : "c";
    const scope =
      t.scope === null
        ? "新檔案，整份都在審查範圍內。"
        : `審查範圍：第 ${describeRanges(t.scope)} 行（改動處與所在的函式）。`;
    sections.push(
      `## 待審查檔案：${t.relPath}\n\n${scope}行號已標在每行前面，回報時請使用這些行號。\n\n` +
        "```" +
        fence +
        "\n" +
        numbered(t.source) +
        "\n```",
    );
  }

  return sections.join("\n\n---\n\n");
}

function scopeLabel(scope: ChangesetContext["targets"][number]["scope"]): string {
  return scope === null ? "新檔案，整份" : `第 ${describeRanges(scope)} 行`;
}
