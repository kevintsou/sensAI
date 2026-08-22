#!/usr/bin/env node
/*
 * 假的 Claude Code Router，給沒有 CCR、也沒有 API key 的時候用。
 *
 * 預設聽 3456，所以不用改任何設定，直接當 CCR 的替身 ——
 * 擴充與 CLI 都會以為自己在跟真的路由講話。
 *
 * 它不會真的審查程式碼：意見是從送進來的 prompt 裡挑幾行湊出來的。
 * 用途是驗證「管線通不通」—— include 有沒有被帶進去、行號對不對得上、
 * 過濾層有沒有在做事、CCR 掛掉時擴充會不會優雅降級。
 * 意見的品質要驗的話，還是得接真的模型。
 *
 *   npm run mock                    # 正常回應
 *   npm run mock -- --mode no-tool  # 模擬路由的模型不支援 tool use
 *   npm run mock -- --mode empty    # 模擬沒有發現問題
 *   npm run mock -- --mode error    # 模擬路由回 500
 *   npm run mock -- --mode slow     # 拖 30 秒，驗逾時處理
 */

import * as http from "node:http";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const PORT = Number(arg("--port", "3456"));
const MODE = arg("--mode", "ok");

/** 從 prompt 裡把「NN| 程式碼」那段還原成行號對照表。 */
function extractNumberedLines(userMessage) {
  const marker = userMessage.lastIndexOf("待審查檔案");
  const tail = marker >= 0 ? userMessage.slice(marker) : userMessage;
  const out = [];
  for (const m of tail.matchAll(/^\s*(\d+)\|\s?(.*)$/gm)) {
    out.push({ line: Number(m[1]), text: m[2] });
  }
  return out;
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]{3,}/g;
const KEYWORDS = new Set([
  "static", "volatile", "uint32_t", "uint8_t", "void", "const", "return",
  "while", "struct", "include", "define", "signed", "unsigned", "char",
]);

function pickIdentifier(text) {
  for (const id of text.match(IDENT_RE) ?? []) {
    if (!KEYWORDS.has(id)) {
      return id;
    }
  }
  return null;
}

/** 挑幾行有實際識別字的，湊成看起來合理的意見。 */
function fabricateFindings(userMessage) {
  const lines = extractNumberedLines(userMessage);
  const usable = lines
    .map((l) => ({ ...l, ident: pickIdentifier(l.text) }))
    .filter((l) => l.ident !== null);

  if (usable.length === 0) {
    return [];
  }

  const step = Math.max(1, Math.floor(usable.length / 3));
  const picked = [usable[0], usable[step], usable[step * 2]].filter(Boolean).slice(0, 3);

  const findings = picked.map((l, i) => ({
    line: l.line,
    severity: ["error", "warning", "info"][i % 3],
    message: `[假的] ${l.ident} 這裡有問題`,
    trigger_condition: `[假的] 當 ISR 在第 ${l.line} 行執行到一半時被搶佔`,
    consequence: "[假的] 這是假 router 湊出來的，不代表真的有問題",
    evidence: `第 ${l.line} 行的 ${l.ident}`,
    rule_id: null,
  }));

  // 故意各塞一則會被過濾掉的，讓過濾層的效果看得見。
  findings.push({
    line: 999999,
    severity: "error",
    message: "[假的] 行號超出範圍，應該被濾除",
    trigger_condition: "x",
    consequence: "y",
    evidence: picked[0].ident,
    rule_id: null,
  });
  findings.push({
    line: picked[0].line,
    severity: "error",
    message: "[假的] 捏造的識別字，應該被濾除",
    trigger_condition: "x",
    consequence: "y",
    evidence: "totally_invented_symbol_xyz",
    rule_id: null,
  });

  return findings;
}

function messageEnvelope(content, stopReason) {
  return {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model: "mock-router",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400).end('{"error":"bad json"}');
      return;
    }

    const userMessage = parsed?.messages?.[0]?.content ?? "";
    const stamp = new Date().toISOString().slice(11, 19);
    console.log(
      `${stamp}  ${req.method} ${req.url}  model=${parsed.model}  ` +
        `system=${(parsed.system ?? "").length}B  user=${userMessage.length}B  ` +
        `tools=${(parsed.tools ?? []).map((t) => t.name).join(",") || "(無)"}  mode=${MODE}`,
    );

    if (MODE === "error") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "mock 故意失敗" } }));
      return;
    }

    if (MODE === "slow") {
      await new Promise((r) => setTimeout(r, 30000));
    }

    if (MODE === "no-tool") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          messageEnvelope([{ type: "text", text: "我看過了，這段程式碼沒什麼問題。" }], "end_turn"),
        ),
      );
      return;
    }

    const findings = MODE === "empty" ? [] : fabricateFindings(userMessage);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        messageEnvelope(
          [{ type: "tool_use", id: "tu_mock", name: "report_findings", input: { findings } }],
          "tool_use",
        ),
      ),
    );
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`假 router 已啟動：http://127.0.0.1:${PORT}   mode=${MODE}`);
  console.log("意見是湊出來的，只用來驗管線。要驗品質請接真的模型。\n");
});
