import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildContext } from "../out-test/context.js";
import { evidenceIsGrounded, filterFindings } from "../out-test/filter.js";
import { loadRules } from "../out-test/rules.js";
import { buildUserMessage } from "../out-test/prompt.js";
import { muteKey } from "../out-test/mutes.js";

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

const opts = { workspaceRoot: ROOT, depth: 2, budgetBytes: 100000 };

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

test("prompt 帶行號、規則與 header", () => {
  const ctx = {
    filePath: "/proj/src/uart.c",
    source: "int a;\nint b;\n",
    headers: [{ path: "/proj/src/regs.h", text: "#define A 1" }],
    truncated: false,
  };
  const rules = [
    {
      id: "w1c-status-bits",
      severity: "error",
      rule: "不要用 |= 清 W1C 位元",
      except: "唯讀暫存器不算",
      examples: { bad: "S |= F;", good: "S = F;" },
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
  const ctx = { filePath: "/p/a.c", source: "int a;\n", headers: [], truncated: true };
  assert.match(buildUserMessage(ctx, []), /寧可不報/);
});
