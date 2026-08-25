import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as http from "node:http";

import { requestReview, EndpointUnavailableError, ReviewCancelledError } from "../out/review.js";

const CTX = {
  filePath: "/proj/src/uart.c",
  source: "static uint32_t rx_ready;\nvoid main_loop(void) { while (!rx_ready) { } }\n",
  headers: [],
  truncated: false,
  language: "c",
};

const RULES = [
  { id: "volatile-shared-state", severity: "error", rule: "共享變數要標 volatile" },
];

/** 假的 CCR：回傳一個 Anthropic 格式的 tool_use 回應。 */
function mockRouter(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push({ url: req.url, body: JSON.parse(body) });
        handler(res, JSON.parse(body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        endpoint: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function replyWithFindings(res, findings) {
  const payload = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "mock",
    content: [{ type: "tool_use", id: "tu_1", name: "report_findings", input: { findings } }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

test("送到 CCR 的請求帶著 tool 定義與強制 tool_choice", async () => {
  const router = await mockRouter((res) => replyWithFindings(res, []));
  try {
    await requestReview(CTX, RULES, {
      endpoint: router.endpoint,
      model: "my-route",
      timeoutMs: 5000,
      archId: "riscv32-andes-v5",
    });
  } finally {
    await router.close();
  }

  assert.equal(router.requests.length, 1);
  const { url, body } = router.requests[0];
  assert.equal(url, "/v1/messages");
  assert.equal(body.model, "my-route", "model 是 CCR 的路由 key，要原樣送出");
  assert.equal(body.tools[0].name, "report_findings");
  assert.deepEqual(body.tool_choice, { type: "tool", name: "report_findings" });
  // structured outputs 經過 CCR 的 transformer 不保證轉得過去，所以不該出現。
  assert.equal(body.output_config, undefined);
  assert.match(body.messages[0].content, /volatile-shared-state/);
});

test("解析回傳的 findings", async () => {
  const router = await mockRouter((res) =>
    replyWithFindings(res, [
      {
        line: 2,
        severity: "error",
        message: "rx_ready 缺 volatile",
        trigger_condition: "當 ISR 在主迴圈輪詢期間設值",
        consequence: "主迴圈永遠看不到更新，卡在 while",
        evidence: "rx_ready",
        rule_id: "volatile-shared-state",
      },
    ]),
  );
  try {
    const findings = await requestReview(CTX, RULES, {
      endpoint: router.endpoint,
      model: "m",
      timeoutMs: 5000,
      archId: "riscv32-andes-v5",
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 2);
    assert.equal(findings[0].rule_id, "volatile-shared-state");
  } finally {
    await router.close();
  }
});

test("欄位缺漏或型別不對的 finding 會被丟掉，不會讓整批失敗", async () => {
  const router = await mockRouter((res) =>
    replyWithFindings(res, [
      { line: "not a number", message: "壞掉的" },
      { line: 1, message: "沒有 severity 的", evidence: "rx_ready" },
    ]),
  );
  try {
    const findings = await requestReview(CTX, RULES, {
      endpoint: router.endpoint,
      model: "m",
      timeoutMs: 5000,
      archId: "riscv32-andes-v5",
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning", "缺 severity 時退回 warning");
  } finally {
    await router.close();
  }
});

test("路由的模型不支援 tool use 時給出可理解的錯誤", async () => {
  const router = await mockRouter((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "mock",
        content: [{ type: "text", text: "我覺得這段程式碼看起來不錯。" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
  });
  try {
    await assert.rejects(
      () => requestReview(CTX, RULES, {
          endpoint: router.endpoint,
          model: "m",
          timeoutMs: 5000,
          archId: "riscv32-andes-v5",
        }),
      /tool use/,
    );
  } finally {
    await router.close();
  }
});

test("CCR 沒開時丟 EndpointUnavailableError，讓上層靜默降級", async () => {
  // 先開再關，拿到一個確定沒人聽的埠號。
  const router = await mockRouter(() => {});
  const endpoint = router.endpoint;
  await router.close();

  await assert.rejects(
    () => requestReview(CTX, RULES, { endpoint, model: "m", timeoutMs: 5000, archId: "riscv32-andes-v5" }),
    (err) => {
      assert.ok(err instanceof EndpointUnavailableError);
      assert.match(err.message, /連不上 Claude Code Router/);
      return true;
    },
  );
});

test("組語審查時，架構事實會進到 system prompt", async () => {
  const router = await mockRouter((res) => replyWithFindings(res, []));
  const asmCtx = {
    filePath: "/proj/src/boot.s",
    source: "my_func:\n    addi sp, sp, -12\n    ret\n",
    headers: [],
    truncated: false,
    language: "asm",
  };
  try {
    await requestReview(asmCtx, [], {
      endpoint: router.endpoint,
      model: "m",
      timeoutMs: 5000,
      archId: "riscv32-andes-v5",
    });
  } finally {
    await router.close();
  }

  const { system } = router.requests[0].body;
  assert.match(system, /callee-saved/);
  assert.match(system, /16-byte 對齊/);
  assert.match(system, /s2-s11/);
});

test("C 審查時不注入組語的 ABI 事實", async () => {
  const router = await mockRouter((res) => replyWithFindings(res, []));
  try {
    await requestReview(CTX, RULES, {
      endpoint: router.endpoint,
      model: "m",
      timeoutMs: 5000,
      archId: "riscv32-andes-v5",
    });
  } finally {
    await router.close();
  }
  assert.equal(/callee-saved/.test(router.requests[0].body.system), false);
});

test("signal 已 abort：丟 ReviewCancelledError，不當成一般錯誤", async () => {
  const router = await mockRouter((res) => replyWithFindings(res, []));
  const ac = new AbortController();
  ac.abort(); // 送出前就取消
  try {
    await assert.rejects(
      () =>
        requestReview(CTX, RULES, {
          endpoint: router.endpoint,
          model: "m",
          timeoutMs: 5000,
          archId: "riscv32-andes-v5",
          signal: ac.signal,
        }),
      (err) => {
        assert.ok(err instanceof ReviewCancelledError);
        return true;
      },
    );
  } finally {
    await router.close();
  }
});

test("請求進行中 abort：丟 ReviewCancelledError", async () => {
  // router 故意不回應，讓請求卡著，好在中途 abort。
  let received;
  const router = await mockRouter(() => {
    received?.();
  });
  const ac = new AbortController();
  const inFlight = new Promise((resolve) => (received = resolve));
  try {
    const p = requestReview(CTX, RULES, {
      endpoint: router.endpoint,
      model: "m",
      timeoutMs: 5000,
      archId: "riscv32-andes-v5",
      signal: ac.signal,
    });
    await inFlight; // 確定請求已送達 router（卡在等回應）
    ac.abort();
    await assert.rejects(
      () => p,
      (err) => {
        assert.ok(err instanceof ReviewCancelledError);
        return true;
      },
    );
  } finally {
    await router.close();
  }
});
