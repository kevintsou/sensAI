import * as vscode from "vscode";
import { Finding, PinnedFinding, ReviewResult } from "./types";
import { pinKey } from "./pins";

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
  /** 釘選一則目前顯示的意見（index 對應 this.findings）。 */
  onPin(finding: Finding): void;
  /** 取消釘選。 */
  onUnpin(key: string): void;
  /** 從絕對路徑跳到某行（釘選區的意見可能來自別的檔案）。 */
  onJumpTo(filePath: string, line: number): void;
  /** 更新某則釘選的筆記。 */
  onComment(key: string, text: string): void;
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
  private pins: PinnedFinding[] = [];
  /** 新一輪審查進行中，但畫面上還留著上一輪的結果。只在有結果可留時為 true。 */
  private updating = false;

  constructor(private readonly handlers: PanelHandlers) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(
      (msg: {
        type: string;
        index?: number;
        line?: number;
        key?: string;
        text?: string;
        filePath?: string;
      }) => {
        if (msg.type === "jump" && typeof msg.line === "number") {
          this.handlers.onJump(msg.line);
        } else if (msg.type === "jumpTo" && typeof msg.filePath === "string" && typeof msg.line === "number") {
          this.handlers.onJumpTo(msg.filePath, msg.line);
        } else if (msg.type === "mute" && typeof msg.index === "number") {
          const finding = this.findings[msg.index];
          if (finding) {
            this.handlers.onMute(finding);
          }
        } else if (msg.type === "pin" && typeof msg.index === "number") {
          const finding = this.findings[msg.index];
          if (finding) {
            this.handlers.onPin(finding);
          }
        } else if (msg.type === "unpin" && typeof msg.key === "string") {
          this.handlers.onUnpin(msg.key);
        } else if (msg.type === "comment" && typeof msg.key === "string" && typeof msg.text === "string") {
          // 只回存，不重繪 —— 重繪會把使用者正在打字的 textarea 清掉。
          this.handlers.onComment(msg.key, msg.text);
        }
      },
    );
    this.render();
  }

  setState(state: PanelState): void {
    this.state = state;
    // 任何新的明確狀態進來，就不再是「保留舊結果、更新中」了。
    this.updating = false;
    // 收合的意見也要能按「這是誤報」，索引接在顯示的那些後面 —— 順序必須
    // 跟 resultHtml 的 render 呼叫一致。
    this.findings =
      state.kind === "result"
        ? [...state.result.findings, ...(state.result.collapsed ?? [])]
        : [];
    this.render();
  }

  /** 面板上是否已有可顯示的審查結果。 */
  hasResult(): boolean {
    return this.state.kind === "result";
  }

  /**
   * 標記「新一輪審查進行中」，但**保留**畫面上現有的結果。
   *
   * 連續存檔時，每一輪都從頭 setState(reviewing) 會把上一輪剛顯示的意見清成
   * 空白，造成一段空窗。改成留著舊結果、只在頂部加一條「更新中…」，等新結果
   * 到位再由 setState 蓋過去。只有已經有結果可留時才走這條路。
   */
  markUpdating(): void {
    if (this.state.kind !== "result") {
      return;
    }
    this.updating = true;
    this.render();
  }

  /** 更新釘選清單並重繪。pin/unpin 之後由 Controller 呼叫。 */
  setPins(pins: PinnedFinding[]): void {
    this.pins = pins;
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
    return this.pinnedHtml() + this.stateHtml();
  }

  /**
   * 面板頂部固定區：所有被釘選的意見，跨檔案。
   *
   * 這一區不隨當前 review 變動 —— 釘選的重點就是不被後續 review 蓋掉。
   * 因為釘選是跨檔案持久化的，在 A.c 釘的意見切到 B.c 後仍然在這裡。
   */
  private pinnedHtml(): string {
    if (this.pins.length === 0) {
      return "";
    }
    const items = this.pins
      .map((p) => {
        const f = p.finding;
        const rule = f.rule_id ? `<span class="rule">${escapeHtml(f.rule_id)}</span>` : "";
        return `<div class="finding sev-${f.severity} pinned-item">
          <div class="row">
            <span class="badge">${SEVERITY_LABEL[f.severity]}</span>
            <button class="link" data-jump-file="${escapeHtml(p.filePath)}" data-jump-line="${f.line}"
              >${escapeHtml(p.file)}:${f.line}</button>
            ${rule}
            <button class="unpin" data-key="${escapeHtml(p.key)}" title="取消釘選">📌 取消釘選</button>
          </div>
          <div class="msg">${escapeHtml(f.message)}</div>
          <dl>
            <dt>觸發條件</dt><dd>${escapeHtml(f.trigger_condition)}</dd>
            <dt>後果</dt><dd>${escapeHtml(f.consequence)}</dd>
            <dt>依據</dt><dd>${escapeHtml(f.evidence)}</dd>
          </dl>
          <textarea class="comment" data-key="${escapeHtml(p.key)}"
            placeholder="加上你的筆記／備註…">${escapeHtml(p.comment)}</textarea>
        </div>`;
      })
      .join("");
    return `<div class="pinned">
      <div class="pinned-head">📌 已釘選（${this.pins.length}）</div>
      ${items}
    </div>`;
  }

  private stateHtml(): string {
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
    const collapsed = result.collapsed ?? [];
    // 保留舊結果、新一輪進行中時，頂部一條輕量提示；不清畫面。
    const updatingNote = this.updating
      ? `<div class="updating">↻ 更新中，仍顯示上一次的結果…</div>`
      : "";
    const stageNote =
      result.stage === "changed"
        ? `<div class="stage">只看剛改動的行 · 完整審查進行中…</div>`
        : result.stage === "changed-only"
          ? `<div class="stage">只看剛改動的行 · 連續存檔中，等停下來再做完整審查</div>`
          : "";
    const staleNote = result.stale
      ? `<div class="stale">審查期間檔案又被改過，行號是對著送出當下那一版算的，跳行可能會偏。</div>`
      : "";

    const head = `${updatingNote}<div class="meta">
      <div>${escapeHtml(result.filePath.split(/[\\/]/).pop() ?? result.filePath)}</div>
      <div class="muted">${result.findings.length} 則意見 ·
        附帶 ${result.headersIncluded.length} 個 header ·
        ${(result.durationMs / 1000).toFixed(1)}s${
          result.dropped.length > 0 ? ` · 濾除 ${result.dropped.length} 則` : ""
        }${result.contextTruncated ? " · 上下文已截斷" : ""}</div>
    </div>${stageNote}${staleNote}`;

    if (result.findings.length === 0 && collapsed.length === 0) {
      return head + `<p class="ok">沒有發現問題。</p>`;
    }

    const pinnedKeys = new Set(this.pins.map((p) => p.key));
    const render = (f: Finding, i: number) => {
        const rule = f.rule_id
          ? `<span class="rule">${escapeHtml(f.rule_id)}</span>`
          : "";
        const isPinned = pinnedKeys.has(pinKey(result.filePath, f));
        return `<div class="finding sev-${f.severity}">
          <div class="row">
            <label class="pin" title="釘住這則意見，不被後續審查蓋掉">
              <input type="checkbox" data-index="${i}"${isPinned ? " checked" : ""}> 釘選
            </label>
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
    };

    const items = result.findings.map((f, i) => render(f, i)).join("");

    if (collapsed.length === 0) {
      return head + items;
    }

    // 收合的部分用 <details>，預設關著但一鍵可展開 —— 意見還在，
    // 只是不跟重要的那些搶注意力。藏到看不到就變成另一種問題了。
    const hidden = collapsed
      .map((f, i) => render(f, result.findings.length + i))
      .join("");
    return (
      head +
      items +
      `<details class="collapsed">
        <summary>另有 ${collapsed.length} 則較低嚴重度的意見（意見過多，已收合）</summary>
        ${hidden}
      </details>`
    );
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
  .stale {
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-descriptionForeground));
    border-left: 2px solid var(--vscode-inputValidation-warningBorder, var(--vscode-descriptionForeground));
    padding-left: 6px;
    margin: 4px 0;
  }
  .updating {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    margin-bottom: 8px;
  }
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
    font-size: 0.8em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
    margin-top: 8px;
  }
  dd {
    margin: 1px 0 2px;
    color: var(--vscode-foreground);
  }
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
  .pinned {
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-descriptionForeground));
  }
  .pinned-head {
    font-weight: 600;
    margin-bottom: 8px;
    color: var(--vscode-foreground);
  }
  .pinned-item { background: var(--vscode-inputValidation-infoBackground, var(--vscode-editorWidget-background)); }
  label.pin {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    user-select: none;
  }
  label.pin input { cursor: pointer; margin: 0; }
  button.unpin {
    margin-left: auto;
    background: none;
    border: 1px solid var(--vscode-descriptionForeground);
    border-radius: 2px;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 0.8em;
    padding: 1px 6px;
  }
  button.unpin:hover { color: var(--vscode-foreground); }
  textarea.comment {
    width: 100%;
    box-sizing: border-box;
    min-height: 48px;
    resize: vertical;
    margin-top: 4px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-descriptionForeground));
    border-radius: 2px;
    padding: 4px 6px;
  }
</style>
</head>
<body>
${this.bodyHtml()}
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll("button.link[data-line]").forEach((b) => {
    b.addEventListener("click", () =>
      vscode.postMessage({ type: "jump", line: Number(b.dataset.line) }));
  });
  document.querySelectorAll("button.link[data-jump-file]").forEach((b) => {
    b.addEventListener("click", () =>
      vscode.postMessage({
        type: "jumpTo",
        filePath: b.dataset.jumpFile,
        line: Number(b.dataset.jumpLine),
      }));
  });
  document.querySelectorAll("button.mute").forEach((b) => {
    b.addEventListener("click", () =>
      vscode.postMessage({ type: "mute", index: Number(b.dataset.index) }));
  });
  document.querySelectorAll("label.pin input[type=checkbox]").forEach((c) => {
    c.addEventListener("change", () =>
      vscode.postMessage({ type: "pin", index: Number(c.dataset.index) }));
  });
  document.querySelectorAll("button.unpin").forEach((b) => {
    b.addEventListener("click", () =>
      vscode.postMessage({ type: "unpin", key: b.dataset.key }));
  });
  // 筆記即時回存。用 input 事件（每次打字）加 blur（保險），但只送不重繪 ——
  // 重繪會清掉正在編輯的 textarea，所以 onComment 那端刻意不觸發 render。
  document.querySelectorAll("textarea.comment").forEach((t) => {
    let timer;
    const send = () =>
      vscode.postMessage({ type: "comment", key: t.dataset.key, text: t.value });
    t.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(send, 300);
    });
    t.addEventListener("blur", () => {
      clearTimeout(timer);
      send();
    });
  });
</script>
</body>
</html>`;
  }
}
