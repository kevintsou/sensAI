import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildContext } from "../out/context.js";
import {
  applySeverityBudget,
  evidenceIsGrounded,
  filterFindings,
  mergeStageFindings,
} from "../out/filter.js";
import { mergeRanges, parseDiffRanges } from "../out/diff.js";
import { loadRules, rulesPath } from "../out/rules.js";
import { buildUserMessage, systemPrompt } from "../out/prompt.js";
import { detectLanguage } from "../out/language.js";
import { archFacts } from "../out/abi.js";
import { muteKey } from "../out/mutes.js";

const ROOT = "/proj";

/** 用假的檔案系統跑 include 解析，測試才不會依賴真實磁碟佈局。 */
function fakeFs(files, index = {}) {
  return {
    exists: (p) => Object.hasOwn(files, p),
    read: (p) => {
      if (!Object.hasOwn(files, p)) {
        throw new Error(`ENOENT ${p}`);
      }
      return files[p];
    },
    headerIndex: () => new Map(Object.entries(index)),
  };
}

const opts = { workspaceRoot: ROOT, language: "c", depth: 2, budgetBytes: 100000 };

test("include 解析：相對於引用檔案所在目錄", () => {
  const fa = fakeFs({ "/proj/src/regs.h": "#define A 1" });
  const ctx = buildContext("/proj/src/main.c", '#include "regs.h"\n', opts, fa);
  assert.deepEqual(
    ctx.headers.map((h) => h.path),
    ["/proj/src/regs.h"],
  );
});

test("include 解析：相對路徑找不到時，退回全專案 basename 索引", () => {
  // build system 有設 include path，但我們拿不到那份設定的情況。
  const fa = fakeFs({ "/proj/inc/hal.h": "#define HAL 1" }, { "hal.h": ["/proj/inc/hal.h"] });
  const ctx = buildContext("/proj/src/main.c", '#include "hal.h"\n', opts, fa);
  assert.deepEqual(
    ctx.headers.map((h) => h.path),
    ["/proj/inc/hal.h"],
  );
});

test("include 解析：同名 header 多份時取路徑最短的", () => {
  const fa = fakeFs(
    { "/proj/a.h": "top", "/proj/vendor/deep/a.h": "deep" },
    { "a.h": ["/proj/vendor/deep/a.h", "/proj/a.h"] },
  );
  const ctx = buildContext("/proj/src/main.c", '#include "a.h"\n', opts, fa);
  assert.equal(ctx.headers[0].path, "/proj/a.h");
});

test("include 解析：忽略角括號的系統 header", () => {
  const fa = fakeFs({ "/proj/src/stdint.h": "should not be picked" });
  const ctx = buildContext("/proj/src/main.c", "#include <stdint.h>\n", opts, fa);
  assert.equal(ctx.headers.length, 0);
});

test("include 解析：遞迴到設定的深度為止", () => {
  const files = {
    "/proj/src/a.h": '#include "b.h"\n',
    "/proj/src/b.h": '#include "c.h"\n',
    "/proj/src/c.h": "deepest\n",
  };
  const source = '#include "a.h"\n';

  const d1 = buildContext("/proj/src/m.c", source, { ...opts, depth: 1 }, fakeFs(files));
  assert.deepEqual(
    d1.headers.map((h) => path.basename(h.path)),
    ["a.h"],
  );

  const d3 = buildContext("/proj/src/m.c", source, { ...opts, depth: 3 }, fakeFs(files));
  assert.deepEqual(
    d3.headers.map((h) => path.basename(h.path)),
    ["a.h", "b.h", "c.h"],
  );
});

test("include 解析：循環引用不會無限迴圈", () => {
  const fa = fakeFs({
    "/proj/a.h": '#include "b.h"\n',
    "/proj/b.h": '#include "a.h"\n',
  });
  const ctx = buildContext("/proj/m.c", '#include "a.h"\n', { ...opts, depth: 5 }, fa);
  assert.equal(ctx.headers.length, 2);
});

test("include 解析：超過位元組預算就標記截斷", () => {
  const fa = fakeFs({ "/proj/big.h": "x".repeat(5000) });
  const ctx = buildContext("/proj/m.c", '#include "big.h"\n', { ...opts, budgetBytes: 100 }, fa);
  assert.equal(ctx.headers.length, 0);
  assert.equal(ctx.truncated, true);
});

test("evidence 引用到原始碼裡存在的識別字才算數", () => {
  const source = "static volatile uint32_t rx_ready;\n";
  assert.equal(evidenceIsGrounded("rx_ready 沒有標 volatile", source, 1), true);
  assert.equal(evidenceIsGrounded("tx_pending 沒有標 volatile", source, 1), false);
});

test("evidence 只提到暫存器名時，仍然算引用到原始碼", () => {
  // 兩字元的暫存器名進不了 IDENT_RE，evidence 剩下的 prologue / epilogue
  // 又不會出現在組語裡 —— 沒有另外認暫存器的話，這則正確的意見會被誤殺。
  const source = "uart_send_buffer:\n    mv      s1, a1\n    beqz    s1, .Lsend_done\n";
  assert.equal(evidenceIsGrounded("prologue 沒有 sw s1，epilogue 也沒有 lw s1", source, 3), true);
  assert.equal(evidenceIsGrounded("prologue 沒有保存 s7，epilogue 沒有還原", source, 3), false);
});

test("暫存器用字邊界比對，不會在更長的名字裡誤命中", () => {
  const source = "    mv      s10, a1\n";
  assert.equal(evidenceIsGrounded("prologue 沒有保存 s1", source, 1), false);
  assert.equal(evidenceIsGrounded("prologue 沒有保存 s10", source, 1), true);
});

test("evidence 沒有識別字時，退而看行號是否存在", () => {
  const source = "a\nb\nc\n";
  assert.equal(evidenceIsGrounded("第 2 行", source, 3), true);
  assert.equal(evidenceIsGrounded("第 99 行", source, 3), false);
  assert.equal(evidenceIsGrounded("看起來怪怪的", source, 3), false);
});

function finding(over = {}) {
  return {
    line: 1,
    severity: "warning",
    message: "訊息",
    trigger_condition: "當 ISR 觸發",
    consequence: "讀到舊值",
    evidence: "rx_ready",
    rule_id: null,
    ...over,
  };
}

test("filter 濾掉捏造識別字與超出範圍的行號", () => {
  const source = "static uint32_t rx_ready;\nint main(void) { return 0; }\n";
  const { kept, dropped } = filterFindings(
    [
      finding({ line: 1 }),
      finding({ line: 999, message: "行號超出範圍" }),
      finding({ line: 2, evidence: "not_a_real_symbol", message: "捏造的識別字" }),
    ],
    source,
    () => false,
  );
  assert.deepEqual(kept.map((f) => f.message), ["訊息"]);
  assert.deepEqual(
    dropped.map((d) => d.reason).sort(),
    ["evidence-not-found", "line-out-of-range"],
  );
});

test("filter 依 severity 再依行號排序", () => {
  const source = "rx_ready\nrx_ready\nrx_ready\n";
  const { kept } = filterFindings(
    [
      finding({ line: 3, severity: "info", message: "c" }),
      finding({ line: 2, severity: "error", message: "b" }),
      finding({ line: 1, severity: "warning", message: "a" }),
    ],
    source,
    () => false,
  );
  assert.deepEqual(kept.map((f) => f.message), ["b", "a", "c"]);
});

test("靜音的意見會被濾掉並標明原因", () => {
  const source = "rx_ready\n";
  const { kept, dropped } = filterFindings([finding()], source, () => true);
  assert.equal(kept.length, 0);
  assert.equal(dropped[0].reason, "muted");
});

test("靜音 key 不受排版影響，但程式碼真的改了就失效", () => {
  const f = finding({ rule_id: "volatile-shared-state" });
  const base = muteKey(f, "  static uint32_t rx_ready;");
  assert.equal(muteKey(f, "static  uint32_t   rx_ready;"), base);
  assert.notEqual(muteKey(f, "static volatile uint32_t rx_ready;"), base);
});

test("rules.yaml 載入：略過壞規則但保留其餘", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sensai-"));
  fs.mkdirSync(path.join(dir, ".sensai"));
  fs.writeFileSync(
    path.join(dir, ".sensai", "rules.yaml"),
    [
      "- id: good",
      "  severity: error",
      "  rule: 有內容",
      "- id: no-rule-text",
      "- rule: 缺少 id",
      "- id: good",
      "  rule: 重複的 id",
      "- id: bad-severity",
      "  severity: catastrophic",
      "  rule: severity 無效",
    ].join("\n"),
  );

  const { rules, problems } = loadRules(dir);
  assert.deepEqual(rules.map((r) => r.id), ["good", "bad-severity"]);
  assert.equal(rules[0].severity, "error");
  assert.equal(rules[1].severity, "warning", "無效的 severity 應退回 warning");
  assert.equal(problems.length, 4);
});

test("可從工作區外載入規則，並支援相對於工作區的路徑", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sensai-rules-path-"));
  const external = path.join(dir, "shared", "andestar.yaml");
  fs.mkdirSync(path.dirname(external));
  fs.writeFileSync(external, "- id: shared-rule\n  rule: 共用規則\n");

  assert.equal(rulesPath(dir, "shared/andestar.yaml"), external);
  assert.equal(rulesPath(dir, external), external);
  assert.deepEqual(loadRules(dir, "shared/andestar.yaml").rules.map((r) => r.id), ["shared-rule"]);
});

test("prompt 帶行號、規則與 header", () => {
  const ctx = {
    filePath: "/proj/src/uart.c",
    source: "int a;\nint b;\n",
    headers: [{ path: "/proj/src/regs.h", text: "#define A 1" }],
    truncated: false,
    language: "c",
  };
  const rules = [
    {
      id: "w1c-status-bits",
      severity: "error",
      rule: "不要用 |= 清 W1C 位元",
      except: "唯讀暫存器不算",
      examples: { bad: "S |= F;", good: "S = F;" },
      languages: ["c"],
    },
  ];
  const msg = buildUserMessage(ctx, rules);

  assert.match(msg, /1\| int a;/);
  assert.match(msg, /2\| int b;/);
  assert.match(msg, /w1c-status-bits/);
  assert.match(msg, /唯讀暫存器不算/);
  assert.match(msg, /#define A 1/);
  assert.match(msg, /不要審查這些檔案/);
  assert.equal(/上下文已截斷|沒有附上/.test(msg), false);
});

test("prompt 在上下文截斷時告知模型保守一點", () => {
  const ctx = {
    filePath: "/p/a.c",
    source: "int a;\n",
    headers: [],
    truncated: true,
    language: "c",
  };
  assert.match(buildUserMessage(ctx, []), /寧可不報/);
});

/* ------------------------------------------------------------- 組合語言 */

test("依副檔名判斷語言，不依賴 languageId", () => {
  assert.equal(detectLanguage("/p/uart.c"), "c");
  assert.equal(detectLanguage("/p/regs.h"), "c");
  assert.equal(detectLanguage("/p/boot.s"), "asm");
  assert.equal(detectLanguage("/p/vectors.S"), "asm");
  assert.equal(detectLanguage("/p/readme.md"), null);
  assert.equal(detectLanguage("/p/Makefile"), null);
});

test("include 解析：支援 GAS 的 .include 指令", () => {
  const fa = fakeFs({ "/proj/src/soc_defs.inc": ".equ BASE, 0x40001000" });
  const ctx = buildContext(
    "/proj/src/boot.s",
    '    .include "soc_defs.inc"\n',
    { ...opts, language: "asm" },
    fa,
  );
  assert.deepEqual(
    ctx.headers.map((h) => path.basename(h.path)),
    ["soc_defs.inc"],
  );
  assert.equal(ctx.language, "asm");
});

test("include 解析：.S 走前處理器，#include 也要收", () => {
  const fa = fakeFs({ "/proj/src/regs.h": "#define A 1" });
  const ctx = buildContext(
    "/proj/src/vectors.S",
    '#include "regs.h"\n',
    { ...opts, language: "asm" },
    fa,
  );
  assert.equal(ctx.headers.length, 1);
});

test("規則的 languages：省略時兩種語言都適用", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sensai-lang-"));
  fs.mkdirSync(path.join(dir, ".sensai"));
  fs.writeFileSync(
    path.join(dir, ".sensai", "rules.yaml"),
    [
      "- id: both-by-default",
      "  rule: 沒寫 languages",
      "- id: asm-only",
      "  languages: [asm]",
      "  rule: 只給組語",
      "- id: c-only",
      "  languages: c",
      "  rule: 單一字串也接受",
      "- id: nonsense-languages",
      "  languages: [klingon]",
      "  rule: 無效值視為兩種都適用",
    ].join("\n"),
  );

  const { rules, problems } = loadRules(dir);
  const byId = Object.fromEntries(rules.map((r) => [r.id, r.languages]));
  assert.deepEqual(byId["both-by-default"], ["c", "asm"]);
  assert.deepEqual(byId["asm-only"], ["asm"]);
  assert.deepEqual(byId["c-only"], ["c"]);
  assert.deepEqual(byId["nonsense-languages"], ["c", "asm"]);
  assert.equal(problems.length, 1, "只有無效值那條該產生警告");
});

test("兩種語言的 system prompt 都要求回報語法錯誤", () => {
  // 語法錯誤沒有執行時的觸發時序，所以 DISCIPLINE 那條「講不出 trigger_condition
  // 就不要報」必須明確為它開一個例外，否則模型會照紀律把語法錯誤吞掉。
  for (const [language, arch] of [["c", null], ["asm", archFacts("riscv32-andes-v5")]]) {
    const prompt = systemPrompt(language, arch);
    assert.match(prompt, /語法/, `${language}: 值得回報的清單要包含語法`);
    assert.match(prompt, /syntax-error/, `${language}: 要指定 rule_id`);
    assert.doesNotMatch(
      prompt,
      /本來就會抓到的語法/,
      `${language}: 不該再叫模型跳過語法錯誤`,
    );
  }
});

test("沒有規則時，system prompt 把範圍限縮成只檢查語法", () => {
  const normal = systemPrompt("c", null, false);
  assert.doesNotMatch(normal, /只回報語法與型別錯誤/);

  const syntaxOnly = systemPrompt("c", null, true);
  assert.match(syntaxOnly, /只回報語法與型別錯誤/);
  assert.match(syntaxOnly, /其他一律不要回報/);
  // 規則還在的時候不該被誤觸發 —— 這是「退化」不是「取代」。
  assert.match(syntaxOnly, /語法/);
});

test("組語的 system prompt 帶入架構事實，C 的不帶", () => {
  const riscv = systemPrompt("asm", archFacts("riscv32-andes-v5"));
  assert.match(riscv, /callee-saved/);
  assert.match(riscv, /16-byte 對齊/);
  assert.match(riscv, /s2-s11/);

  const arm = systemPrompt("asm", archFacts("armv7e-m"));
  assert.match(arm, /r4-r11/);
  assert.match(arm, /8-byte 對齊/);
  assert.equal(/s2-s11/.test(arm), false, "不該混進另一個架構的暫存器");

  const c = systemPrompt("c", null);
  assert.match(c, /volatile/);
  assert.equal(/callee-saved/.test(c), false);
});

test("未知的架構 id 退回預設，不會炸掉", () => {
  assert.equal(archFacts("does-not-exist").id, "riscv32-andes-v5");
});

test("組語的 prompt 用 asm 圍籬與對應的措辭", () => {
  const ctx = {
    filePath: "/proj/src/boot.s",
    source: "my_func:\n    ret\n",
    headers: [{ path: "/proj/src/soc_defs.inc", text: ".equ BASE, 0x40001000" }],
    truncated: false,
    language: "asm",
  };
  const msg = buildUserMessage(ctx, []);
  assert.match(msg, /```asm/);
  assert.match(msg, /1\| my_func:/);
  assert.match(msg, /附帶的 include 檔案/);
  assert.match(msg, /\.equ BASE/);
});

// ---------------------------------------------------------------- 兩階段

test("diff 解析：取出新檔案側的改動行號範圍", () => {
  const diff = [
    "diff --git a/x.c b/x.c",
    "--- a/x.c",
    "+++ b/x.c",
    "@@ -10,0 +11,3 @@",
    "@@ -30 +33 @@",
  ].join("\n");
  assert.deepEqual(parseDiffRanges(diff), [
    { start: 11, end: 13 },
    { start: 33, end: 33 },
  ]);
});

test("diff 解析：純刪除也標記位置，刪掉一行同樣可能是 bug", () => {
  assert.deepEqual(parseDiffRanges("@@ -10,3 +9,0 @@"), [{ start: 9, end: 9 }]);
});

test("diff 解析：相鄰範圍合併，清單才不會又長又碎", () => {
  assert.deepEqual(mergeRanges([{ start: 1, end: 3 }, { start: 4, end: 5 }]), [
    { start: 1, end: 5 },
  ]);
  assert.deepEqual(mergeRanges([{ start: 1, end: 2 }, { start: 9, end: 9 }]), [
    { start: 1, end: 2 },
    { start: 9, end: 9 },
  ]);
});

test("階段一把落在改動範圍外的意見擋下來", () => {
  const source = "rx_ready\nrx_ready\nrx_ready\nrx_ready\n";
  const { kept, dropped } = filterFindings(
    [finding({ line: 2, message: "在範圍內" }), finding({ line: 4, message: "在範圍外" })],
    source,
    () => false,
    [{ start: 1, end: 2 }],
  );
  assert.deepEqual(kept.map((f) => f.message), ["在範圍內"]);
  assert.equal(dropped[0].reason, "outside-changed-lines");
});

test("兩階段的重複意見只會出現一次", () => {
  const source = "static uint32_t rx_ready;\nstatic uint32_t pending;\n";
  const stage1 = [finding({ line: 1, rule_id: "volatile-shared-state", message: "階段一的措辭" })];
  const stage2 = [
    // 同一則問題，但措辭不同 —— 這正是 muteKey 比不出來的情況。
    finding({ line: 1, rule_id: "volatile-shared-state", message: "階段二換句話說" }),
    finding({ line: 2, rule_id: "volatile-shared-state", message: "另一個變數" }),
  ];
  const { merged, duplicates } = mergeStageFindings(stage1, stage2, source);
  assert.equal(duplicates, 1);
  assert.deepEqual(merged.map((f) => f.message), ["階段一的措辭", "另一個變數"]);
});

test("相鄰兩行命中同一條規則，不可以被誤併成一則", () => {
  // 這份專案的 uart_dma.c 就是這個情況：rx_ready 與 pending_events
  // 相鄰宣告、同一條規則、兩個都是真的問題。
  const source = "static uint32_t rx_ready;\nstatic uint32_t pending_events;\n";
  const { merged, duplicates } = mergeStageFindings(
    [finding({ line: 1, rule_id: "volatile-shared-state", message: "rx_ready" })],
    [finding({ line: 2, rule_id: "volatile-shared-state", message: "pending_events" })],
    source,
  );
  assert.equal(duplicates, 0);
  assert.equal(merged.length, 2);
});

test("意見過多時收合低嚴重度的，但 error 永遠不收", () => {
  const many = [
    finding({ line: 1, severity: "error", message: "e1" }),
    finding({ line: 2, severity: "error", message: "e2" }),
    finding({ line: 3, severity: "warning", message: "w1" }),
    finding({ line: 4, severity: "warning", message: "w2" }),
    finding({ line: 5, severity: "info", message: "i1" }),
  ];
  const { shown, collapsed } = applySeverityBudget(many, 3);
  assert.deepEqual(shown.map((f) => f.message), ["e1", "e2", "w1"]);
  assert.deepEqual(collapsed.map((f) => f.message), ["w2", "i1"]);
});

test("error 數量本身就超過額度時，全部照顯示", () => {
  const errors = [1, 2, 3, 4].map((n) =>
    finding({ line: n, severity: "error", message: `e${n}` }),
  );
  const { shown, collapsed } = applySeverityBudget(errors, 2);
  assert.equal(shown.length, 4, "收起一則 error 等於幫使用者決定那則可以不看");
  assert.equal(collapsed.length, 0);
});

test("沒有超過額度就原樣顯示，不為了精簡而藏東西", () => {
  const few = [finding({ severity: "warning" }), finding({ severity: "info" })];
  const { shown, collapsed } = applySeverityBudget(few, 8);
  assert.equal(shown.length, 2);
  assert.equal(collapsed.length, 0);
});
