#!/usr/bin/env node
/*
 * 命令列的審查工具。跑的是跟擴充完全相同的流程 ——
 * 同一個 context builder、同一組 prompt、同一個 tool schema、同一層過濾。
 *
 * 存在的理由是調規則：改一次 rules.yaml 就重開一次 Extension Development Host
 * 太慢，而驗證 prompt 這件事本來就要跑很多輪。
 *
 *   npm run review -- examples/uart_dma.c
 *   npm run review -- examples/uart_dma.s --model background
 *   npm run review -- src/uart.c --json
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { loadProjectConfig } from "../out/config.js";
import { buildContext } from "../out/context.js";
import { filterFindings } from "../out/filter.js";
import { detectLanguage, LANGUAGE_LABEL } from "../out/language.js";
import { blockedPaths } from "../out/privacy.js";
import { requestReview, EndpointUnavailableError } from "../out/review.js";
import { loadRules } from "../out/rules.js";

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
};

const SEVERITY_COLOR = { error: C.red, warning: C.yellow, info: C.blue };

function parseArgs(argv) {
  const opts = {
    file: null,
    endpoint: process.env.SENSAI_ENDPOINT ?? "http://127.0.0.1:3456",
    model: process.env.SENSAI_MODEL ?? "claude-opus-5",
    arch: null,
    json: false,
    showPrompt: false,
    root: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--endpoint") opts.endpoint = argv[++i];
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--arch") opts.arch = argv[++i];
    else if (a === "--root") opts.root = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--show-prompt") opts.showPrompt = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (!a.startsWith("-")) opts.file = a;
  }
  return opts;
}

const USAGE = `用法：npm run review -- <檔案> [選項]

選項：
  --endpoint <url>   CCR 位址（預設 http://127.0.0.1:3456）
  --model <name>     送給 CCR 的 model 欄位，也就是路由 key
  --arch <id>        覆寫 assembly.arch（riscv32-andes-v5 / armv7e-m）
  --root <dir>       專案根目錄。省略時從檔案往上找含 .sensai/ 的目錄
  --show-prompt      印出實際送出的 prompt 就結束，不呼叫 CCR
  --json             輸出 JSON，方便串接
`;

/**
 * 從受審檔案往上找含 `.sensai/` 的目錄。
 *
 * 這樣就能站在 sensAI 這個 repo 裡，去審別的韌體專案的檔案 ——
 * 規則與 include 解析都會用那個專案的，不會誤用 sensAI 自己的。
 */
function findProjectRoot(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  for (;;) {
    if (fs.existsSync(path.join(dir, ".sensai"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return process.cwd();
    }
    dir = parent;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.file) {
    process.stdout.write(USAGE);
    process.exit(opts.help ? 0 : 1);
  }

  const filePath = path.resolve(opts.file);
  if (!fs.existsSync(filePath)) {
    console.error(`找不到檔案：${filePath}`);
    process.exit(1);
  }

  const language = detectLanguage(filePath);
  if (!language) {
    console.error(`不支援的副檔名：${path.extname(filePath)}（只處理 .c .h .s .S）`);
    process.exit(1);
  }

  const root = opts.root ? path.resolve(opts.root) : findProjectRoot(filePath);
  const config = loadProjectConfig(root);
  const { rules: allRules, problems } = loadRules(root);
  for (const p of problems) {
    console.error(C.yellow(`[rules] ${p}`));
  }

  const source = fs.readFileSync(filePath, "utf8");
  const ctx = buildContext(filePath, source, {
    workspaceRoot: root,
    language,
    depth: 2,
    budgetBytes: 120000,
  });

  const blocked = blockedPaths(ctx, config, root);
  if (blocked.length > 0) {
    console.error(
      C.yellow(`已跳過：命中 privacy.never_send —— ${blocked.map((p) => path.relative(root, p)).join("、")}`),
    );
    process.exit(0);
  }

  const rules = allRules.filter((r) => r.languages.includes(language));

  if (opts.showPrompt) {
    const { systemPrompt, buildUserMessage } = await import("../out/prompt.js");
    const { archFacts } = await import("../out/abi.js");
    const arch = language === "asm" ? archFacts(opts.arch ?? config.assemblyArch) : null;
    process.stdout.write(C.bold("=== system ===\n"));
    process.stdout.write(systemPrompt(language, arch) + "\n\n");
    process.stdout.write(C.bold("=== user ===\n"));
    process.stdout.write(buildUserMessage(ctx, rules) + "\n");
    return;
  }

  if (!opts.json) {
    console.error(
      C.dim(
        `${path.relative(root, filePath)} · ${LANGUAGE_LABEL[language]} · ` +
          `root ${root} · ` +
          `${rules.length} 條規則 · 附帶 ${ctx.headers.length} 個 include · ` +
          `${opts.model} @ ${opts.endpoint}`,
      ),
    );
  }

  const started = Date.now();
  let raw;
  try {
    raw = await requestReview(ctx, rules, {
      endpoint: opts.endpoint,
      model: opts.model,
      timeoutMs: 180000,
      archId: opts.arch ?? config.assemblyArch,
    });
  } catch (err) {
    if (err instanceof EndpointUnavailableError) {
      console.error(C.red(err.message));
      console.error(C.dim("先確認 Claude Code Router 有在跑：ccr status"));
    } else {
      console.error(C.red((err && err.message) || String(err)));
    }
    process.exit(2);
  }
  const durationMs = Date.now() - started;

  const { kept, dropped } = filterFindings(raw, source, () => false);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ file: path.relative(root, filePath), kept, dropped, durationMs }, null, 2) + "\n",
    );
    return;
  }

  const lines = source.split("\n");
  for (const f of kept) {
    const color = SEVERITY_COLOR[f.severity] ?? C.dim;
    const rule = f.rule_id ? C.dim(` [${f.rule_id}]`) : C.dim(" [無規則]");
    console.log(`\n${color(f.severity.toUpperCase())} ${C.bold(`第 ${f.line} 行`)}${rule}`);
    console.log(`  ${f.message}`);
    console.log(C.dim(`  > ${(lines[f.line - 1] ?? "").trim()}`));
    console.log(`  ${C.dim("觸發條件")}  ${f.trigger_condition}`);
    console.log(`  ${C.dim("後果")}      ${f.consequence}`);
    console.log(`  ${C.dim("依據")}      ${f.evidence}`);
  }

  if (dropped.length > 0) {
    console.log(C.dim(`\n--- 濾除 ${dropped.length} 則 ---`));
    for (const d of dropped) {
      console.log(C.dim(`  (${d.reason}) 第 ${d.finding.line} 行：${d.finding.message}`));
    }
  }

  const summary = kept.length === 0 ? C.green("沒有發現問題") : `${kept.length} 則意見`;
  console.log(C.dim(`\n${summary} · ${(durationMs / 1000).toFixed(1)}s`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
