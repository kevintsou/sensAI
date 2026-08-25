import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildContext, realFileAccess, isInSkippedDir } from "../out/context.js";
import {
  applySeverityBudget,
  carryOverFindings,
  evidenceIsGrounded,
  filterFindings,
  mergeStageFindings,
} from "../out/filter.js";
import { mergeRanges, parseDiffRanges, planReview } from "../out/diff.js";
import { expandToEnclosingFunction } from "../out/funcscope.js";
import { SingleFlight } from "../out/singleflight.js";
import { Debouncer } from "../out/debounce.js";
import { normalizeRuleId } from "../out/review.js";
import { loadRules, rulesPath } from "../out/rules.js";
import { buildUserMessage, systemPrompt } from "../out/prompt.js";
import { detectLanguage } from "../out/language.js";
import { archFacts } from "../out/abi.js";
import { muteKey } from "../out/mutes.js";
import { PinStore, pinKey } from "../out/pins.js";

const ROOT = "/proj";

/**
 * 把路徑正規化成 POSIX 分隔線，並去掉 Windows 的磁碟機代號前綴。
 *
 * fixture 的 key 一律寫成 POSIX 路徑（`/proj/src/regs.h`），但 context.ts 用
 * path.resolve() 解析相對 include，在 Windows 上會產出 `D:\proj\src\regs.h`
 * ——反斜線加磁碟機代號。兩邊都過這個函式，比對才不會因平台而異。
 */
function norm(p) {
  return p.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
}

/** 用假的檔案系統跑 include 解析，測試才不會依賴真實磁碟佈局。 */
function fakeFs(files, index = {}) {
  const has = (p) => Object.hasOwn(files, norm(p));
  return {
    exists: (p) => has(p),
    read: (p) => {
      if (!has(p)) {
        throw new Error(`ENOENT ${p}`);
      }
      return files[norm(p)];
    },
    headerIndex: () => new Map(Object.entries(index)),
  };
}

const opts = { workspaceRoot: ROOT, language: "c", depth: 2, budgetBytes: 100000 };

test("include 解析：相對於引用檔案所在目錄", () => {
  const fa = fakeFs({ "/proj/src/regs.h": "#define A 1" });
  const ctx = buildContext("/proj/src/main.c", '#include "regs.h"\n', opts, fa);
  assert.deepEqual(
    ctx.headers.map((h) => norm(h.path)),
    ["/proj/src/regs.h"],
  );
});

test("include 解析：相對路徑找不到時，退回全專案 basename 索引", () => {
  // build system 有設 include path，但我們拿不到那份設定的情況。
  const fa = fakeFs({ "/proj/inc/hal.h": "#define HAL 1" }, { "hal.h": ["/proj/inc/hal.h"] });
  const ctx = buildContext("/proj/src/main.c", '#include "hal.h"\n', opts, fa);
  assert.deepEqual(
    ctx.headers.map((h) => norm(h.path)),
    ["/proj/inc/hal.h"],
  );
});

test("include 解析：同名 header 多份時取路徑最短的", () => {
  const fa = fakeFs(
    { "/proj/a.h": "top", "/proj/vendor/deep/a.h": "deep" },
    { "a.h": ["/proj/vendor/deep/a.h", "/proj/a.h"] },
  );
  const ctx = buildContext("/proj/src/main.c", '#include "a.h"\n', opts, fa);
  assert.equal(norm(ctx.headers[0].path), "/proj/a.h");
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

test("header 索引跨呼叫快取，直到 invalidateIndex 才重建", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sensai-idx-"));
  fs.writeFileSync(path.join(dir, "a.h"), "#define A 1");
  const fa = realFileAccess(dir);

  const first = fa.headerIndex();
  // 索引建好後，記憶體裡是同一個 Map 參考 —— 沒有每次都重掃整棵樹。
  assert.strictEqual(fa.headerIndex(), first);

  // 新增一個 header，但還沒 invalidate：舊索引不該看到它。
  fs.writeFileSync(path.join(dir, "b.h"), "#define B 1");
  assert.strictEqual(fa.headerIndex(), first);
  assert.equal(first.has("b.h"), false);

  // invalidate 後重建，才看得到新檔，而且是新的 Map。
  fa.invalidateIndex();
  const rebuilt = fa.headerIndex();
  assert.notStrictEqual(rebuilt, first);
  assert.equal(rebuilt.has("a.h"), true);
  assert.equal(rebuilt.has("b.h"), true);
});

const FUNC_SRC = [
  "#include <stdint.h>",           // 1
  "",                             // 2
  "static uint32_t g_count = 0;", // 3  全域宣告（函式外）
  "",                             // 4
  "void foo(void)",               // 5  簽名
  "{",                            // 6
  "    g_count++;",               // 7
  "    bar();",                   // 8
  "}",                            // 9
  "",                             // 10
  "int baz(int x)",               // 11
  "{",                            // 12
  "    if (x) {",                 // 13
  "        return 1;  // } 假的",  // 14
  "    }",                        // 15
  "    return 0;",                // 16
  "}",                            // 17
].join("\n");

test("拓範圍：函式內改動拓到整個函式（含簽名行）", () => {
  assert.deepEqual(expandToEnclosingFunction(FUNC_SRC, [{ start: 7, end: 7 }]), [
    { start: 5, end: 9 },
  ]);
});

test("拓範圍：巢狀大括號與註解裡假的 } 不干擾", () => {
  assert.deepEqual(expandToEnclosingFunction(FUNC_SRC, [{ start: 14, end: 14 }]), [
    { start: 11, end: 17 },
  ]);
});

test("拓範圍：改動在函式外（全域宣告）保留原行", () => {
  assert.deepEqual(expandToEnclosingFunction(FUNC_SRC, [{ start: 3, end: 3 }]), [
    { start: 3, end: 3 },
  ]);
});

test("拓範圍：多段改動各自拓寬", () => {
  assert.deepEqual(
    expandToEnclosingFunction(FUNC_SRC, [
      { start: 7, end: 7 },
      { start: 14, end: 14 },
    ]),
    [
      { start: 5, end: 9 },
      { start: 11, end: 17 },
    ],
  );
});

test("拓範圍：橫跨函式的改動聯集兩邊", () => {
  // 從 foo 內一路改到 baz 內 —— 兩個函式都要納入。
  assert.deepEqual(expandToEnclosingFunction(FUNC_SRC, [{ start: 8, end: 13 }]), [
    { start: 5, end: 17 },
  ]);
});

test("拓範圍：字串常數裡的大括號不影響配對", () => {
  const src = [
    "void f(void)",       // 1
    "{",                  // 2
    '    log("{oops}");', // 3
    "    x++;",           // 4
    "}",                  // 5
  ].join("\n");
  assert.deepEqual(expandToEnclosingFunction(src, [{ start: 4, end: 4 }]), [{ start: 1, end: 5 }]);
});

test("拓範圍：空改動回空", () => {
  assert.deepEqual(expandToEnclosingFunction(FUNC_SRC, []), []);
});

test("isInSkippedDir：build 輸出目錄裡的 header 不該讓索引失效", () => {
  // 索引不掃這些目錄，所以它們裡面的 header 增刪要被 watcher 濾掉，
  // 否則一 build 就反覆清空快取。兩種分隔線都要認得。
  assert.equal(isInSkippedDir("build/gen/regs.h"), true);
  assert.equal(isInSkippedDir("build\\gen\\regs.h"), true);
  assert.equal(isInSkippedDir("out/foo.h"), true);
  assert.equal(isInSkippedDir("Debug/x.h"), true);
  assert.equal(isInSkippedDir("node_modules/pkg/a.h"), true);
  // 真正的原始碼目錄不濾掉 —— 這些 header 增刪確實該讓索引重建。
  assert.equal(isInSkippedDir("src/hal/uart.h"), false);
  assert.equal(isInSkippedDir("inc/regs.h"), false);
  assert.equal(isInSkippedDir("regs.h"), false);
  // 只比對完整路徑片段，不在較長的名字裡誤命中（buildsystem/ 不是 build/）。
  assert.equal(isInSkippedDir("buildsystem/regs.h"), false);
  assert.equal(isInSkippedDir("my-out-dir/regs.h"), false);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("去抖動：連續存檔只會送出最後一次", async () => {
  const d = new Debouncer();
  const fired = [];
  for (const v of ["v1", "v2", "v3"]) {
    d.schedule("a.c", 30, () => fired.push(v));
    await sleep(5);
  }
  await sleep(60);
  assert.deepEqual(fired, ["v3"]);
});

test("去抖動：安靜期滿才觸發，不是到時間就觸發", async () => {
  const d = new Debouncer();
  let fired = 0;
  d.schedule("a.c", 40, () => fired++);
  await sleep(25);
  d.schedule("a.c", 40, () => fired++); // 重新計時
  await sleep(25);
  assert.equal(fired, 0, "第一次的 40ms 已過，但中途被重設，不該觸發");
  await sleep(30);
  assert.equal(fired, 1);
});

test("去抖動：不同檔案各自計時，互不影響", async () => {
  const d = new Debouncer();
  const fired = [];
  d.schedule("a.c", 20, () => fired.push("a"));
  d.schedule("b.c", 20, () => fired.push("b"));
  await sleep(50);
  assert.deepEqual(fired.sort(), ["a", "b"]);
});

test("去抖動：cancel 之後不會再觸發（手動審查搶先時用）", async () => {
  const d = new Debouncer();
  let fired = 0;
  d.schedule("a.c", 20, () => fired++);
  d.cancel("a.c");
  assert.equal(d.isPending("a.c"), false);
  await sleep(40);
  assert.equal(fired, 0);
});

test("補跑那一輪會被標記為 rerun，原本那輪不會", async () => {
  const flight = saveFlight();
  const seen = [];
  let release;
  const gate = new Promise((r) => (release = r));

  const first = flight.run("a.c", "save", async (v, info) => {
    seen.push(info.rerun);
    if (seen.length === 1) await gate;
  });
  await tick();
  await flight.run("a.c", "save", async () => {});
  release();
  await first;

  assert.deepEqual(seen, [false, true]);
});

test("佇列排空時呼叫 onSettled，補完整審查就掛在這裡", async () => {
  const order = [];
  const flight = new SingleFlight({
    merge: (existing, incoming) =>
      incoming === "manual" || existing === undefined ? incoming : existing,
    onSettled: async () => order.push("settled"),
  });

  let release;
  const gate = new Promise((r) => (release = r));
  const first = flight.run("a.c", "save", async (_v, info) => {
    order.push(info.rerun ? "rerun" : "run");
    if (order.length === 1) await gate;
  });
  await tick();
  await flight.run("a.c", "save", async () => {});
  release();
  await first;

  // 補跑跑完才 settle，而且只 settle 一次。
  assert.deepEqual(order, ["run", "rerun", "settled"]);
});

test("onSettled 期間進來的觸發會被接住，不會並行也不會漏掉", async () => {
  const order = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let settled = 0;
  let flight;

  flight = new SingleFlight({
    merge: (existing, incoming) => incoming ?? existing,
    onSettled: async () => {
      settled++;
      if (settled === 1) {
        // 模擬「補完整審查的期間，使用者又存了一次檔」
        void flight.run("a.c", "save", task);
      }
      order.push("settled");
    },
  });

  const task = async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    order.push("run");
    await tick();
    concurrent--;
  };

  await flight.run("a.c", "save", task);
  assert.equal(maxConcurrent, 1, "settle 期間排進來的工作不可以跟別的並行");
  assert.deepEqual(order, ["run", "settled", "run", "settled"]);
  assert.equal(flight.isInFlight("a.c"), false);
});

/** merge 規則與 Controller 用的那份相同：manual 蓋過 save，反過來不蓋。 */
function saveFlight(log = []) {
  return new SingleFlight({
    merge: (existing, incoming) =>
      incoming === "manual" || existing === undefined ? incoming : existing,
    onCoalesce: () => log.push("coalesce"),
    onRerun: () => log.push("rerun"),
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("檢查與登記之間不讓出事件迴圈，連續兩次觸發不會並行", async () => {
  // 這正是原本的 bug：守衛檢查在 await 之前、登記在 await 之後，
  // 兩次落在同一個空窗裡的存檔會雙雙通過。
  const flight = saveFlight();
  let concurrent = 0;
  let maxConcurrent = 0;
  const task = async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await tick();
    concurrent--;
  };

  await Promise.all([
    flight.run("a.c", "save", task),
    flight.run("a.c", "save", task),
  ]);

  assert.equal(maxConcurrent, 1);
});

test("審查期間進來的觸發不會被丟掉，會用最新內容補跑", async () => {
  const flight = saveFlight();
  const seen = [];
  let release;
  const gate = new Promise((r) => (release = r));

  const first = flight.run("a.c", "save", async (v) => {
    seen.push(v);
    await gate;
  });
  await tick();

  // 第一輪還沒結束就再存兩次 —— 兩次都該併成「一次」補跑，而不是各跑一輪。
  assert.equal(await flight.run("a.c", "save", async (v) => seen.push(v)), "coalesced");
  assert.equal(await flight.run("a.c", "save", async (v) => seen.push(v)), "coalesced");

  release();
  await first;
  assert.deepEqual(seen, ["save", "save"]); // 原本這一輪 + 一次補跑
});

test("補跑期間又進來的觸發仍然被併入，不會變成並行", async () => {
  const flight = saveFlight();
  let concurrent = 0;
  let maxConcurrent = 0;
  let runs = 0;

  const task = async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    runs++;
    if (runs === 1) {
      // 第一輪跑到一半時排進一次補跑
      void flight.run("a.c", "save", task);
    } else if (runs === 2) {
      // 補跑跑到一半時再排一次 —— 這裡若放開 inFlight 就會並行
      void flight.run("a.c", "save", task);
    }
    await tick();
    concurrent--;
  };

  await flight.run("a.c", "save", task);
  assert.equal(maxConcurrent, 1);
  assert.equal(runs, 3);
});

test("補跑的 trigger：manual 蓋過 save", async () => {
  const flight = saveFlight();
  const seen = [];
  let release;
  const gate = new Promise((r) => (release = r));

  const first = flight.run("a.c", "save", async (v) => {
    seen.push(v);
    if (seen.length === 1) await gate;
  });
  await tick();
  await flight.run("a.c", "save", async () => {});
  await flight.run("a.c", "manual", async () => {});
  await flight.run("a.c", "save", async () => {});
  release();
  await first;

  // 中間夾了幾次存檔，補跑仍然是 manual —— 不會降級成「沒有改動就跳過」。
  assert.deepEqual(seen, ["save", "manual"]);
});

test("不同檔案互不阻擋", async () => {
  const flight = saveFlight();
  const seen = [];
  await Promise.all([
    flight.run("a.c", "save", async () => seen.push("a")),
    flight.run("b.c", "save", async () => seen.push("b")),
  ]);
  assert.deepEqual(seen.sort(), ["a", "b"]);
});

test("工作丟例外也要放開 inFlight，否則該檔案永遠不會再被審", async () => {
  const flight = saveFlight();
  await assert.rejects(
    flight.run("a.c", "save", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(flight.isInFlight("a.c"), false);

  let ran = false;
  await flight.run("a.c", "save", async () => {
    ran = true;
  });
  assert.equal(ran, true);
});

const SRC = "void f(void) {\n  UART0->STATUS |= 1;\n  dma_start();\n}\n";

function mkFinding(line, message, ruleId = null) {
  return {
    line,
    severity: "error",
    message,
    trigger_condition: "t",
    consequence: "c",
    evidence: "e",
    rule_id: ruleId,
  };
}

test("補做完整審查時，burst 期間的意見會被併回來，不是被覆蓋", () => {
  const carried = {
    findings: [mkFinding(2, "W1C 不能用 |=", "w1c")],
    dropped: [],
    source: SRC,
  };
  const out = carryOverFindings(carried, {
    findings: [mkFinding(3, "DMA 前沒有 clean cache", "dma")],
    dropped: [],
    source: SRC,
  });

  assert.equal(out.merged, true);
  assert.deepEqual(
    out.findings.map((f) => f.rule_id),
    ["w1c", "dma"],
  );
});

test("兩邊重複的意見只留一則，且保留 burst 那一版的說法", () => {
  const carried = {
    findings: [mkFinding(2, "burst 的說法", "w1c")],
    dropped: [],
    source: SRC,
  };
  const out = carryOverFindings(carried, {
    findings: [mkFinding(2, "完整審查的說法", "w1c")],
    dropped: [],
    source: SRC,
  });

  assert.equal(out.duplicates, 1);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].message, "burst 的說法");
});

test("檔案在補做前又被改過，burst 的意見不併回（行號已對不上）", () => {
  const carried = {
    findings: [mkFinding(2, "W1C 不能用 |=", "w1c")],
    dropped: [],
    source: SRC,
  };
  const out = carryOverFindings(carried, {
    findings: [mkFinding(3, "DMA 前沒有 clean cache", "dma")],
    dropped: [],
    source: SRC.replace("void f", "void f2"), // 內容變了
  });

  assert.equal(out.merged, false);
  assert.deepEqual(
    out.findings.map((f) => f.rule_id),
    ["dma"],
  );
});

test("沒有 burst 殘留時，完整審查的結果原樣通過", () => {
  const current = { findings: [mkFinding(3, "x", "dma")], dropped: [], source: SRC };
  const out = carryOverFindings(undefined, current);
  assert.equal(out.merged, false);
  assert.deepEqual(out.findings, current.findings);
});

test("被濾除的紀錄兩邊都保留，診斷才看得到全貌", () => {
  const carried = {
    findings: [],
    dropped: [{ finding: mkFinding(9, "burst 濾除"), reason: "line-out-of-range" }],
    source: SRC,
  };
  const out = carryOverFindings(carried, {
    findings: [],
    dropped: [{ finding: mkFinding(9, "完整審查濾除"), reason: "evidence-not-found" }],
    source: SRC,
  });
  assert.equal(out.dropped.length, 2);
});

test("存檔且有改動，才走兩階段", () => {
  const changed = [{ start: 10, end: 12 }];
  assert.deepEqual(planReview("save", changed), { kind: "two-stage", changed });
});

test("存檔但相對 HEAD 沒有改動：整次跳過，不送任何東西出去", () => {
  assert.deepEqual(planReview("save", []), { kind: "skip", reason: "unchanged" });
});

test("無法判定改動範圍不等於沒有改動，未追蹤的檔案照樣審", () => {
  // changedRanges() 對未追蹤或非 git repo 回 null。把 null 當成「沒有改動」
  // 會讓非 git 專案完全不會觸發審查。
  assert.deepEqual(planReview("save", null), { kind: "full" });
});

test("手動觸發不受改動與否影響，沒有改動也照審整份", () => {
  assert.deepEqual(planReview("manual", []), { kind: "full" });
  assert.deepEqual(planReview("manual", null), { kind: "full" });
});

test("手動觸發遇到有改動的檔案，仍然走兩階段", () => {
  const changed = [{ start: 3, end: 3 }];
  assert.deepEqual(planReview("manual", changed), { kind: "two-stage", changed });
});

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

// ------------------------------------------------- rule_id 驗證

test("模型編造的 rule_id 會被歸為無規則，而不是照單全收", () => {
  // 實測過：把 asm-* 規則全部拿掉之後，prompt 裡沒有那些字串，
  // 模型仍然照命名慣例吐出 asm-stack-alignment 這種 id。
  const valid = new Set(["w1c-status-bits", "volatile-shared-state"]);
  assert.deepEqual(normalizeRuleId("asm-stack-alignment", valid), {
    ruleId: null,
    fabricated: "asm-stack-alignment",
  });
});

test("真實存在的 rule_id 原樣保留", () => {
  const valid = new Set(["w1c-status-bits"]);
  assert.deepEqual(normalizeRuleId("w1c-status-bits", valid), {
    ruleId: "w1c-status-bits",
    fabricated: null,
  });
});

test("syntax-error 不在 rules.yaml 裡，但它是合法的", () => {
  assert.deepEqual(normalizeRuleId("syntax-error", new Set()), {
    ruleId: "syntax-error",
    fabricated: null,
  });
});

test("沒有 rule_id 的意見不算編造", () => {
  for (const raw of [null, "", undefined, 42]) {
    assert.deepEqual(normalizeRuleId(raw, new Set(["x"])), {
      ruleId: null,
      fabricated: null,
    });
  }
});

/** 記憶體版的 backing store，測試不必拉起 vscode 的 workspaceState。 */
function fakeBacking(initial = []) {
  let data = initial;
  return {
    get: () => data,
    set: (records) => {
      data = records;
    },
    // 測試用：直接看目前存了什麼。
    _peek: () => data,
  };
}

function pinRecord(over = {}) {
  const f = finding(over.finding ?? {});
  return {
    key: over.key ?? pinKey(over.filePath ?? "/proj/a.c", f),
    finding: f,
    file: over.file ?? "a.c",
    filePath: over.filePath ?? "/proj/a.c",
    lineText: over.lineText ?? "static uint32_t rx_ready;",
    comment: over.comment ?? "",
    pinnedAt: over.pinnedAt ?? "2026-08-24T00:00:00.000Z",
  };
}

test("pinKey 不受那一行程式碼影響 —— 釘選的筆記不該因為改了程式碼而消失", () => {
  const f = finding({ line: 3, rule_id: "volatile-shared-state", message: "訊息" });
  // 跟 muteKey 相反：muteKey 綁 lineText，pinKey 不綁。
  const k = pinKey("/proj/a.c", f);
  assert.equal(pinKey("/proj/a.c", { ...f }), k);
  // 檔案不同、行號不同、訊息不同、規則不同都會是不同的 key。
  assert.notEqual(pinKey("/proj/b.c", f), k);
  assert.notEqual(pinKey("/proj/a.c", { ...f, line: 4 }), k);
  assert.notEqual(pinKey("/proj/a.c", { ...f, message: "別的" }), k);
  assert.notEqual(pinKey("/proj/a.c", { ...f, rule_id: "other" }), k);
});

test("釘選：add / has / remove 與持久化", () => {
  const backing = fakeBacking();
  const store = new PinStore(backing);
  const rec = pinRecord();
  assert.equal(store.has(rec.key), false);
  store.add(rec);
  assert.equal(store.has(rec.key), true);
  assert.equal(backing._peek().length, 1);
  store.remove(rec.key);
  assert.equal(store.has(rec.key), false);
  assert.equal(backing._peek().length, 0);
});

test("釘選：重複 add 不覆蓋既有筆記", () => {
  const backing = fakeBacking();
  const store = new PinStore(backing);
  const rec = pinRecord({ comment: "我的筆記" });
  store.add(rec);
  // 同一個 key 再 add（例如又勾了一次），不能把筆記洗掉。
  store.add(pinRecord({ key: rec.key, comment: "" }));
  assert.equal(store.all()[0].comment, "我的筆記");
});

test("釘選：setComment 更新筆記並存回", () => {
  const backing = fakeBacking();
  const store = new PinStore(backing);
  const rec = pinRecord();
  store.add(rec);
  store.setComment(rec.key, "ISR 那條路徑才是真的問題");
  assert.equal(store.all()[0].comment, "ISR 那條路徑才是真的問題");
  assert.equal(backing._peek()[0].comment, "ISR 那條路徑才是真的問題");
  // 找不到的 key 不炸。
  store.setComment("nonexistent", "無效");
  assert.equal(store.all().length, 1);
});

test("釘選：建構時從 backing 載入既有資料", () => {
  const rec = pinRecord({ comment: "重開後還在" });
  const store = new PinStore(fakeBacking([rec]));
  assert.equal(store.has(rec.key), true);
  assert.equal(store.all()[0].comment, "重開後還在");
});

test("釘選：clear 全清並回報數量", () => {
  const store = new PinStore(fakeBacking());
  store.add(pinRecord({ key: "k1" }));
  store.add(pinRecord({ key: "k2" }));
  assert.equal(store.clear(), 2);
  assert.equal(store.all().length, 0);
});
