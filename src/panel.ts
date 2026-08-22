import * as vscode from "vscode";
import { Finding, ReviewResult } from "./types";

export type PanelState =
  | { kind: "idle" }
  | { kind: "reviewing"; file: string }
  | { kind: "result"; result: ReviewResult }
  | { kind: "skipped"; file: string; reason: string }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

export interface PanelHandlers {
  onJump(line: number): void;
  onMute(finding: Finding): void;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  error: "error",
  warning: "warning",
  info: "info",
};

export class FindingsPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = "sensai.findings";

  private view: vscode.WebviewView | undefined;
  private state: PanelState = { kind: "idle" };
  private findings: Finding[] = [];

  constructor(private readonly handlers: PanelHandlers) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg: { type: string; index?: number; line?: number }) => {
      if (msg.type === "jump" && typeof msg.line === "number") {
        this.handlers.onJump(msg.line);
      } else if (msg.type === "mute" && typeof msg.index === "number") {
        const finding = this.findings[msg.index];
        if (finding) {
          this.handlers.onMute(finding);
        }
      }
    });
    this.render();
  }

  setState(state: PanelState): void {
    this.state = state;
    this.findings = state.kind === "result" ? state.result.findings : [];
    this.render();
  }

  reveal(): void {
    void vscode.commands.executeCommand(`${FindingsPanel.viewId}.focus`);
  }

  private render(): void {
    if (this.view) {
      this.view.webview.html = this.html();
    }
  }

  private bodyHtml(): string {
    switch (this.state.kind) {
      case "idle":
        return `<p class="muted">存檔 C 檔案後會在這裡顯示審查結果。</p>`;
      case "reviewing":
        return `<p class="muted">審查中：${escapeHtml(this.state.file)}</p>`;
      case "skipped":
        return `<p class="muted">已跳過 ${escapeHtml(this.state.file)}</p>
                <p class="muted">${escapeHtml(this.state.reason)}</p>`;
      case "unavailable":
        return `<p class="muted">${escapeHtml(this.state.message)}</p>
                <p class="muted">審查已停用，其他功能不受影響。</p>`;
      case "error":
        return `<p class="bad">${escapeHtml(this.state.message)}</p>`;
      case "result":
        return this.resultHtml(this.state.result);
    }
  }

  private resultHtml(result: ReviewResult): string {
    const head = `<div class="meta">
      <div>${escapeHtml(result.filePath.split(/[\\/]/).pop() ?? result.filePath)}</div>
      <div class="muted">${result.findings.length} 則意見 ·
        附帶 ${result.headersIncluded.length} 個 header ·
        ${(result.durationMs / 1000).toFixed(1)}s${
          result.dropped.length > 0 ? ` · 濾除 ${result.dropped.length} 則` : ""
        }${result.contextTruncated ? " · 上下文已截斷" : ""}</div>
    </div>`;

    if (result.findings.length === 0) {
      return head + `<p class="ok">沒有發現問題。</p>`;
    }

    const items = result.findings
      .map((f, i) => {
        const rule = f.rule_id
          ? `<span class="rule">${escapeHtml(f.rule_id)}</span>`
          : "";
        return `<div class="finding sev-${f.severity}">
          <div class="row">
            <span class="badge">${SEVERITY_LABEL[f.severity]}</span>
            <button class="link" data-line="${f.line}">第 ${f.line} 行</button>
            ${rule}
          </div>
          <div class="msg">${escapeHtml(f.message)}</div>
          <dl>
            <dt>觸發條件</dt><dd>${escapeHtml(f.trigger_condition)}</dd>
            <dt>後果</dt><dd>${escapeHtml(f.consequence)}</dd>
            <dt>依據</dt><dd>${escapeHtml(f.evidence)}</dd>
          </dl>
          <button class="mute" data-index="${i}">這是誤報</button>
        </div>`;
      })
      .join("");

    return head + items;
  }

  private html(): string {
    const n = nonce();
    return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 8px;
    line-height: 1.5;
  }
  .muted { color: var(--vscode-descriptionForeground); }
  .ok { color: var(--vscode-descriptionForeground); }
  .bad { color: var(--vscode-errorForeground); }
  .meta { margin-bottom: 12px; }
  .meta > div:first-child { font-weight: 600; }
  .finding {
    border-left: 3px solid var(--vscode-descriptionForeground);
    padding: 8px 10px;
    margin-bottom: 10px;
    background: var(--vscode-editorWidget-background);
  }
  /* 刻意不用錯誤紅線的語彙：這是 AI 的意見，不是編譯器的斷言。 */
  .sev-error { border-left-color: var(--vscode-charts-orange, #d18616); }
  .sev-warning { border-left-color: var(--vscode-charts-yellow, #cca700); }
  .sev-info { border-left-color: var(--vscode-charts-blue, #3794ff); }
  .row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .badge {
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
  }
  .rule {
    font-size: 0.85em;
    font-family: var(--vscode-editor-font-family);
    color: var(--vscode-descriptionForeground);
  }
  .msg { font-weight: 600; margin-bottom: 6px; }
  dl { margin: 0 0 8px; }
  dt {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
  }
  dd { margin: 0 0 2px; }
  button.link {
    background: none;
    border: none;
    padding: 0;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font: inherit;
  }
  button.mute {
    background: none;
    border: 1px solid var(--vscode-descriptionForeground);
    border-radius: 2px;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 0.85em;
    padding: 2px 8px;
  }
  button.mute:hover { color: var(--vscode-foreground); }
</style>
</head>
<body>
${this.bodyHtml()}
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll("button.link").forEach((b) => {
    b.addEventListener("click", () =>
      vscode.postMessage({ type: "jump", line: Number(b.dataset.line) }));
  });
  document.querySelectorAll("button.mute").forEach((b) => {
    b.addEventListener("click", () =>
      vscode.postMessage({ type: "mute", index: Number(b.dataset.index) }));
  });
</script>
</body>
</html>`;
  }
}
