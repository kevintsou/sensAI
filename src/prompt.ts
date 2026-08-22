import { Rule, ReviewContext } from "./types";

export const SYSTEM_PROMPT = `你是一位資深韌體工程師，正在審查一個 ARM / Andes AndeStar V5 專案裡的單一 C 檔案。

你的任務是找出**會造成實際故障**的問題，而且只回報你說得出具體失效情境的問題。

值得回報的：
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
- 編譯器或 clangd 本來就會抓到的語法與型別錯誤
- 你只是覺得「可能有問題」但講不出觸發條件的東西

每一則意見都必須填滿：
- trigger_condition —— 什麼情況下會出事，要具體到哪個時序、哪個呼叫順序、哪個中斷時機
- consequence —— 會造成什麼結果
- evidence —— 引用檔案裡實際存在的識別字或行號

**如果你講不出具體的 trigger_condition，就不要回報這一則。**

寧可少報。一則錯誤的意見造成的信任損失，大於漏掉一則真實問題。

附上的 header 只是讓你理解 macro 與型別定義，**不要審查 header 本身**，只審查目標 C 檔案。

用繁體中文回答。`;

function renderRule(r: Rule): string {
  const parts = [`### ${r.id}（severity: ${r.severity}）`, r.rule.trim()];
  if (r.except) {
    parts.push(`不算問題的例外：\n${r.except.trim()}`);
  }
  if (r.examples?.bad) {
    parts.push("錯誤示範：\n```c\n" + r.examples.bad.trim() + "\n```");
  }
  if (r.examples?.good) {
    parts.push("正確做法：\n```c\n" + r.examples.good.trim() + "\n```");
  }
  return parts.join("\n\n");
}

/** 加上行號，模型回報的 line 才對得準。 */
function numbered(source: string): string {
  const lines = source.split("\n");
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`).join("\n");
}

export function buildUserMessage(ctx: ReviewContext, rules: Rule[]): string {
  const sections: string[] = [];

  if (rules.length > 0) {
    sections.push(
      "## 專案規則\n\n這些是本專案的硬體特性與團隊慣例，優先於你的通用知識。\n\n" +
        rules.map(renderRule).join("\n\n"),
    );
  }

  if (ctx.headers.length > 0) {
    const headerText = ctx.headers
      .map((h) => `### ${h.path}\n\`\`\`c\n${h.text}\n\`\`\``)
      .join("\n\n");
    sections.push(
      "## 附帶的 header（僅供理解 macro 與型別，不要審查這些檔案）\n\n" + headerText,
    );
  }

  if (ctx.truncated) {
    sections.push("（部分 header 因為長度上限沒有附上。判斷不確定時，寧可不報。）");
  }

  sections.push(
    `## 待審查檔案：${ctx.filePath}\n\n` +
      "行號已標在每行前面，回報時請使用這些行號。\n\n" +
      "```c\n" +
      numbered(ctx.source) +
      "\n```",
  );

  return sections.join("\n\n---\n\n");
}
