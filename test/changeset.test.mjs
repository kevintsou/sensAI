import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import {
  assignFindings,
  changesetWarning,
  listChangedFiles,
  matchFindingFile,
  mergeHeaders,
  NotAGitRepoError,
  parseNumstatZ,
  LARGE_CHANGESET,
} from "../out/changeset.js";
import { filterFindings } from "../out/filter.js";
import { buildChangesetMessage, changesetSystemPrompt } from "../out/prompt.js";
import { requestChangesetReview } from "../out/review.js";

const finding = (line, extra = {}) => ({
  line,
  severity: "warning",
  message: `m${line}`,
  trigger_condition: "t",
  consequence: "c",
  evidence: "dma_start",
  rule_id: null,
  ...extra,
});

// ---------------------------------------------------------------- git 輸出解析

test("numstat -z：解析行數，二進位檔的 - 記成 null，路徑可含空白與 tab 以外的字元", () => {
  const out = "12\t3\tsrc/dma.c\0-\t-\tfw/blob.bin\0" + "0\t5\tinclude/my regs.h\0";
  assert.deepEqual(parseNumstatZ(out), [
    { path: "src/dma.c", added: 12, deleted: 3 },
    { path: "fw/blob.bin", added: null, deleted: null },
    { path: "include/my regs.h", added: 0, deleted: 5 },
  ]);
});

// ---------------------------------------------------------------- 意見對回檔案

test("對檔案：完全相同、後綴、檔名依序比對", () => {
  const targets = ["src/dma.c", "include/dma.h", "src/uart.c"];
  assert.equal(matchFindingFile("src/dma.c", targets), "src/dma.c");
  assert.equal(matchFindingFile("./src/dma.c", targets), "src/dma.c");
  assert.equal(matchFindingFile("/home/me/proj/include/dma.h", targets), "include/dma.h");
  assert.equal(matchFindingFile("src\\uart.c", targets), "src/uart.c");
  assert.equal(matchFindingFile("uart.c", targets), "src/uart.c");
});

test("對檔案：同名檔案有歧義時寧可對不上，也不要掛到錯的檔案", () => {
  const targets = ["drv/a/util.c", "drv/b/util.c"];
  assert.equal(matchFindingFile("util.c", targets), null);
  assert.equal(matchFindingFile("b/util.c", targets), "drv/b/util.c");
  assert.equal(matchFindingFile("nope.c", targets), null);
});

test("對檔案：只送了一個檔案時，沒寫 file 或寫錯都歸給它", () => {
  assert.equal(matchFindingFile("", ["src/dma.c"]), "src/dma.c");
  assert.equal(matchFindingFile("other.c", ["src/dma.c"]), "src/dma.c");
});

test("assignFindings：依檔案分組，沒有意見的檔案也有空陣列，對不上的另外收", () => {
  const targets = ["src/dma.c", "include/dma.h"];
  const { byFile, unknown } = assignFindings(
    [
      { file: "src/dma.c", finding: finding(3) },
      { file: "include/dma.h", finding: finding(7) },
      { file: "src/ghost.c", finding: finding(9) },
    ],
    targets,
  );
  assert.deepEqual(byFile.get("src/dma.c").map((f) => f.line), [3]);
  assert.deepEqual(byFile.get("include/dma.h").map((f) => f.line), [7]);
  assert.deepEqual(unknown.map((f) => f.line), [9]);

  const empty = assignFindings([], targets);
  assert.deepEqual(empty.byFile.get("src/dma.c"), []);
});

// ---------------------------------------------------------------- header 合併

test("mergeHeaders：去重、排除本身就在送審清單裡的、超過預算就截斷", () => {
  const h = (p, n) => ({ path: p, text: "x".repeat(n) });
  const perFile = [
    { headers: [h("/p/inc/regs.h", 10), h("/p/inc/dma.h", 10)], truncated: false },
    { headers: [h("/p/inc/regs.h", 10), h("/p/inc/big.h", 100)], truncated: false },
  ];
  const r = mergeHeaders(perFile, new Set([path.resolve("/p/inc/dma.h")]), 50);
  assert.deepEqual(r.headers.map((x) => x.path), ["/p/inc/regs.h"]);
  assert.equal(r.truncated, true, "big.h 放不下，要標截斷");

  const ok = mergeHeaders(perFile.slice(0, 1), new Set(), 1000);
  assert.equal(ok.headers.length, 2);
  assert.equal(ok.truncated, false);
});

test("改動量警告：沒超過門檻不警告，檔案數或大小任一超過就警告", () => {
  assert.equal(changesetWarning(3, 1000), null);
  assert.match(changesetWarning(LARGE_CHANGESET.files + 1, 1000), /改動較大/);
  assert.match(changesetWarning(2, LARGE_CHANGESET.bytes + 1), /改動較大/);
});

// ---------------------------------------------------------------- 佐證比對

test("filterFindings：跨檔案的意見引用另一個檔案的識別字，給整組內容就不會被當成捏造", () => {
  const source = "void f(void) {\n  start();\n}\n";
  const f = finding(2, { evidence: "dma.h 裡 dma_start_ex 的簽名多了 len 參數" });
  const alone = filterFindings([f], source, () => false, null);
  assert.equal(alone.kept.length, 0, "只看本檔：dma_start_ex 不存在，判為捏造");

  const corpus = source + "\nint dma_start_ex(int ch, int len);\n";
  const together = filterFindings([f], source, () => false, null, corpus);
  assert.equal(together.kept.length, 1);
});

test("filterFindings：行號範圍仍然以本檔為準，不受整組內容影響", () => {
  const source = "a\nb\n";
  const r = filterFindings([finding(9)], source, () => false, null, "a\nb\n".repeat(20) + "dma_start");
  assert.equal(r.dropped[0].reason, "line-out-of-range");
});

// ---------------------------------------------------------------- prompt

const TARGETS = [
  {
    filePath: "/p/src/dma.c",
    relPath: "src/dma.c",
    source: "#include \"dma.h\"\nint dma_start(int ch) {\n  return ch;\n}\n",
    language: "c",
    scope: [{ start: 2, end: 4 }],
  },
  {
    filePath: "/p/src/boot.S",
    relPath: "src/boot.S",
    source: "_start:\n  j main\n",
    language: "asm",
    scope: null,
  },
];

test("整組 prompt：列出每個檔案與審查範圍，新檔案標整份", () => {
  const msg = buildChangesetMessage(
    { targets: TARGETS, headers: [{ path: "inc/dma.h", text: "int dma_start(int ch);" }], truncated: false },
    [],
  );
  assert.match(msg, /這組改動（2 個檔案）/);
  assert.match(msg, /## 待審查檔案：src\/dma\.c/);
  assert.match(msg, /審查範圍：第 2-4 行/);
  assert.match(msg, /## 待審查檔案：src\/boot\.S[\s\S]*新檔案，整份都在審查範圍內/);
  assert.match(msg, /附帶的 header[\s\S]*### inc\/dma\.h/);
  assert.match(msg, /```asm\n1\| _start:/);
});

test("整組 prompt：兩種語言都在時，標出只適用於其中一種的規則", () => {
  const rules = [
    { id: "c-only", severity: "error", rule: "r", languages: ["c"] },
    { id: "both", severity: "warning", rule: "r", languages: ["c", "asm"] },
  ];
  const msg = buildChangesetMessage({ targets: TARGETS, headers: [], truncated: false }, rules);
  assert.match(msg, /### c-only（severity: error）（只適用於C檔案）/);
  assert.match(msg, /### both（severity: warning）\n/);

  const cOnly = buildChangesetMessage({ targets: TARGETS.slice(0, 1), headers: [], truncated: false }, rules);
  assert.doesNotMatch(cOnly, /只適用於/, "只有一種語言時不需要標");
});

test("整組 system prompt：放入跨檔案一致性與出現的語言的檢查清單", () => {
  const both = changesetSystemPrompt(new Set(["c", "asm"]), { text: "FACTS" }, new Set());
  assert.match(both, /跨檔案的一致性/);
  assert.match(both, /## C檔案/);
  assert.match(both, /## 組合語言檔案/);
  assert.match(both, /FACTS/);

  const cOnly = changesetSystemPrompt(new Set(["c"]), null, new Set());
  assert.doesNotMatch(cOnly, /組合語言檔案/);
});

test("整組 system prompt：沒規則的語言只做語法檢查；全部沒規則就不放跨檔案那段", () => {
  const partial = changesetSystemPrompt(new Set(["c", "asm"]), null, new Set(["asm"]));
  assert.match(partial, /沒有適用於組合語言的規則/);
  assert.match(partial, /跨檔案的一致性/);

  const none = changesetSystemPrompt(new Set(["c"]), null, new Set(["c"]));
  assert.doesNotMatch(none, /跨檔案的一致性/);
  assert.match(none, /只回報語法與型別錯誤/);
});

// ---------------------------------------------------------------- 送出請求

function mockRouter(findings) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg",
            type: "message",
            role: "assistant",
            model: "mock",
            content: [{ type: "tool_use", id: "tu", name: "report_findings", input: { findings } }],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        endpoint: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

test("整組請求：一個請求帶所有檔案，tool 要求 file 欄位，回傳帶著 file", async () => {
  const router = await mockRouter([
    { file: "src/dma.c", ...finding(3) },
    { ...finding(4) }, // 模型漏了 file
  ]);
  let out;
  try {
    out = await requestChangesetReview(
      { targets: TARGETS, headers: [], truncated: false },
      [],
      { endpoint: router.endpoint, model: "m", timeoutMs: 5000, archId: "riscv32-andes-v5" },
    );
  } finally {
    await router.close();
  }
  assert.equal(router.requests.length, 1);
  const body = router.requests[0];
  const item = body.tools[0].input_schema.properties.findings.items;
  assert.ok(item.required.includes("file"));
  assert.match(body.messages[0].content, /src\/dma\.c[\s\S]*src\/boot\.S/);
  assert.match(body.system, /架構事實/, "有組語檔案時要注入架構事實");
  assert.deepEqual(
    out.map((r) => [r.file, r.finding.line]),
    [
      ["src/dma.c", 3],
      ["", 4],
    ],
  );
});

// ---------------------------------------------------------------- 真的 git repo

function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sensai-cs-"));
  const g = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  return { dir, g, write };
}

test("listChangedFiles：改過的、未追蹤的 C／組語檔案；刪除的、沒改的、非原始碼、build 目錄的不列", { skip: !gitAvailable() }, async () => {
  const { dir, g, write } = makeRepo();
  try {
    write("src/dma.c", "int a;\n");
    write("src/keep.c", "int k;\n");
    write("src/gone.c", "int g;\n");
    write("README.md", "x\n");
    write(".gitignore", "ignored/\n");
    g("add", "-A");
    g("commit", "-qm", "init");

    write("src/dma.c", "int a;\nint b;\n");
    fs.rmSync(path.join(dir, "src/gone.c"));
    write("README.md", "y\n");
    write("src/new.S", "_start:\n");
    write("build/gen.h", "#define X 1\n");
    write("ignored/x.c", "int x;\n");

    const files = await listChangedFiles(dir);
    assert.deepEqual(
      files.map((f) => [f.relPath, f.untracked, f.added, f.deleted, f.language]),
      [
        ["src/dma.c", false, 1, 0, "c"],
        ["src/new.S", true, null, null, "asm"],
      ],
    );
    assert.equal(files[0].filePath, path.join(dir, "src/dma.c"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listChangedFiles：工作區是 repo 的子目錄時，只列子目錄底下的改動", { skip: !gitAvailable() }, async () => {
  const { dir, g, write } = makeRepo();
  try {
    write("fw/a.c", "int a;\n");
    write("tools/b.c", "int b;\n");
    g("add", "-A");
    g("commit", "-qm", "init");
    write("fw/a.c", "int a2;\n");
    write("tools/b.c", "int b2;\n");

    const files = await listChangedFiles(path.join(dir, "fw"));
    assert.deepEqual(files.map((f) => f.relPath), ["a.c"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listChangedFiles：還沒有任何 commit 時，已 add 的檔案整份算改動", { skip: !gitAvailable() }, async () => {
  const { dir, g, write } = makeRepo();
  try {
    write("a.c", "int a;\n");
    g("add", "-A");
    const files = await listChangedFiles(dir);
    assert.deepEqual(files.map((f) => [f.relPath, f.untracked]), [["a.c", true]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listChangedFiles：不在 git repo 裡丟 NotAGitRepoError", { skip: !gitAvailable() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sensai-nogit-"));
  try {
    await assert.rejects(listChangedFiles(dir), NotAGitRepoError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
