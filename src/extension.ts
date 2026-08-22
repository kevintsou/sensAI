import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DEFAULT_ARCH_ID } from "./abi";
import { ProjectConfig, loadProjectConfig } from "./config";
import { buildContext } from "./context";
import { filterFindings } from "./filter";
import { LANGUAGE_LABEL, detectLanguage } from "./language";
import { MuteStore, muteKey } from "./mutes";
import { FindingsPanel } from "./panel";
import { appendAudit, blockedPaths } from "./privacy";
import { EndpointUnavailableError, requestReview } from "./review";
import { loadRules, rulesPath } from "./rules";
import { CONFIG_TEMPLATE, GITIGNORE_TEMPLATE, RULES_TEMPLATE } from "./template";
import { Finding, ReviewContext, Rule } from "./types";

interface Settings {
  enabled: boolean;
  endpoint: string;
  model: string;
  includeDepth: number;
  contextBudgetBytes: number;
  requestTimeoutMs: number;
}

function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration("sensai");
  return {
    enabled: c.get("enabled", true),
    endpoint: c.get("endpoint", "http://127.0.0.1:3456"),
    model: c.get("model", "claude-opus-5"),
    includeDepth: c.get("includeDepth", 2),
    contextBudgetBytes: c.get("contextBudgetBytes", 120000),
    requestTimeoutMs: c.get("requestTimeoutMs", 120000),
  };
}

class Controller {
  private rules: Rule[] = [];
  private config: ProjectConfig = {
    privacy: { neverSend: [], auditLog: null },
    assemblyArch: DEFAULT_ARCH_ID,
  };
  private mutes: MuteStore | undefined;
  private inFlight = new Set<string>();
  private lastSource = new Map<string, string>();

  constructor(
    private readonly panel: FindingsPanel,
    private readonly status: vscode.StatusBarItem,
    private readonly output: vscode.OutputChannel,
  ) {}

  private get workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  reloadProjectFiles(notify = false): void {
    const root = this.workspaceRoot;
    if (!root) {
      return;
    }
    try {
      this.config = loadProjectConfig(root);
    } catch (err) {
      void vscode.window.showWarningMessage((err as Error).message);
    }
    const { rules, problems } = loadRules(root);
    this.rules = rules;
    this.mutes = new MuteStore(MuteStore.defaultPath(root));

    for (const p of problems) {
      this.output.appendLine(`[rules] ${p}`);
    }
    if (notify) {
      const summary = `sensAI：載入 ${rules.length} 條規則` +
        (problems.length > 0 ? `，${problems.length} 個問題（見 Output）` : "");
      void vscode.window.showInformationMessage(summary);
    }
  }

  async review(document: vscode.TextDocument): Promise<void> {
    const root = this.workspaceRoot;
    if (!root) {
      return;
    }
    const filePath = document.uri.fsPath;
    // 用副檔名判斷，不用 languageId —— .s 在沒裝組語擴充時會是 plaintext。
    const language = detectLanguage(filePath);
    if (!language) {
      return;
    }
    if (this.inFlight.has(filePath)) {
      return;
    }

    const settings = readSettings();
    const source = document.getText();
    this.lastSource.set(filePath, source);

    const ctx: ReviewContext = buildContext(filePath, source, {
      workspaceRoot: root,
      language,
      depth: settings.includeDepth,
      budgetBytes: settings.contextBudgetBytes,
    });

    // 只送這個語言適用的規則。把 C 的規則送去審組語只會製造誤報。
    const rules = this.rules.filter((r) => r.languages.includes(language));
    if (rules.length === 0) {
      // 沒有規則的話結果會泛泛到沒有價值，與其送出去燒錢不如先擋下來。
      this.panel.setState({
        kind: "skipped",
        file: path.basename(filePath),
        reason: `沒有適用於${LANGUAGE_LABEL[language]}的規則。執行「sensAI: Initialize Project」建立 .sensai/rules.yaml。`,
      });
      this.setStatus("$(gear) sensAI", "沒有規則");
      return;
    }

    const blocked = blockedPaths(ctx, this.config, root);
    if (blocked.length > 0) {
      const rel = blocked.map((p) => path.relative(root, p)).join("、");
      this.panel.setState({
        kind: "skipped",
        file: path.basename(filePath),
        reason: `命中 privacy.never_send：${rel}`,
      });
      this.setStatus("$(shield) sensAI", "此檔案設定為不外送");
      return;
    }

    this.inFlight.add(filePath);
    this.panel.setState({
      kind: "reviewing",
      file: `${path.basename(filePath)}（${LANGUAGE_LABEL[language]}，${rules.length} 條規則）`,
    });
    this.setStatus("$(sync~spin) sensAI", "審查中");

    const started = Date.now();
    try {
      const raw = await requestReview(ctx, rules, {
        endpoint: settings.endpoint,
        model: settings.model,
        timeoutMs: settings.requestTimeoutMs,
        archId: this.config.assemblyArch,
      });
      const durationMs = Date.now() - started;

      const lines = source.split("\n");
      const { kept, dropped } = filterFindings(raw, source, (f) =>
        this.mutes?.has(muteKey(f, lines[f.line - 1] ?? "")) ?? false,
      );

      for (const d of dropped) {
        this.output.appendLine(
          `[filter] 濾除 (${d.reason}) 第 ${d.finding.line} 行：${d.finding.message}`,
        );
      }

      this.panel.setState({
        kind: "result",
        result: {
          filePath,
          findings: kept,
          dropped,
          durationMs,
          headersIncluded: ctx.headers.map((h) => h.path),
          contextTruncated: ctx.truncated,
        },
      });

      appendAudit(root, this.config, {
        ts: new Date().toISOString(),
        file: path.relative(root, filePath),
        headers: ctx.headers.length,
        bytes: source.length + ctx.headers.reduce((n, h) => n + h.text.length, 0),
        endpoint: settings.endpoint,
        model: settings.model,
        findings: kept.length,
        dropped: dropped.length,
        durationMs,
      });

      if (kept.length === 0) {
        this.setStatus("$(check) sensAI", "沒有發現問題");
      } else {
        this.setStatus(`$(comment-discussion) sensAI ${kept.length}`, `${kept.length} 則意見`);
      }
    } catch (err) {
      if (err instanceof EndpointUnavailableError) {
        // CCR 沒開是常態，不要用錯誤視窗打斷工作。
        this.panel.setState({ kind: "unavailable", message: err.message });
        this.setStatus("$(circle-slash) sensAI", err.message);
        this.output.appendLine(`[review] ${err.message}`);
      } else {
        const message = (err as Error).message ?? String(err);
        this.panel.setState({ kind: "error", message });
        this.setStatus("$(error) sensAI", message);
        this.output.appendLine(`[review] ${message}`);
      }
    } finally {
      this.inFlight.delete(filePath);
    }
  }

  async muteFinding(finding: Finding): Promise<void> {
    const root = this.workspaceRoot;
    const editor = vscode.window.activeTextEditor;
    const filePath = editor?.document.uri.fsPath;
    if (!root || !filePath || !this.mutes) {
      return;
    }
    const source = this.lastSource.get(filePath) ?? editor!.document.getText();
    const lineText = source.split("\n")[finding.line - 1] ?? "";

    const reason = await vscode.window.showInputBox({
      title: "標記為誤報",
      prompt: "為什麼「這一個」不是問題？（會附在給開發者的回報中，可留空）",
      placeHolder: "例：tx_count 只在主迴圈用，ISR 那份是 tx_count_isr",
    });
    if (reason === undefined) {
      return; // 使用者取消
    }

    this.mutes.add({
      key: muteKey(finding, lineText),
      ruleId: finding.rule_id,
      message: finding.message,
      file: path.relative(root, filePath),
      line: finding.line,
      lineText,
      triggerCondition: finding.trigger_condition,
      consequence: finding.consequence,
      reason,
      mutedAt: new Date().toISOString(),
    });

    if (editor) {
      await this.review(editor.document);
    }
  }

  /**
   * 建立 `.sensai/` 骨架。
   *
   * 規則不隨擴充散布 —— 那是專案的資產。但裝了 vsix 的人手上不會有
   * 任何範本，這個指令補掉那個缺口。
   */
  async initProject(): Promise<void> {
    const root = this.workspaceRoot;
    if (!root) {
      void vscode.window.showWarningMessage("sensAI：請先開啟一個資料夾。");
      return;
    }
    const dir = path.join(root, ".sensai");
    const files: Array<[string, string]> = [
      ["rules.yaml", RULES_TEMPLATE],
      ["config.yaml", CONFIG_TEMPLATE],
      [".gitignore", GITIGNORE_TEMPLATE],
    ];

    const existing = files.filter(([name]) => fs.existsSync(path.join(dir, name)));
    if (existing.length > 0) {
      const names = existing.map(([n]) => n).join("、");
      const pick = await vscode.window.showWarningMessage(
        `.sensai/ 底下已經有 ${names}。要覆蓋嗎？`,
        { modal: true },
        "只建立缺少的",
        "全部覆蓋",
      );
      if (pick === undefined) {
        return;
      }
      if (pick === "只建立缺少的") {
        for (const [name, content] of files) {
          const file = path.join(dir, name);
          if (!fs.existsSync(file)) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(file, content);
          }
        }
        this.reloadProjectFiles(true);
        return;
      }
    }

    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of files) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    this.reloadProjectFiles(true);

    const doc = await vscode.workspace.openTextDocument(path.join(dir, "rules.yaml"));
    await vscode.window.showTextDocument(doc);
    void vscode.window.showInformationMessage(
      "sensAI：已建立 .sensai/。裡面的規則只是格式示範，請換成你們專案真正的規則。",
    );
  }

  async exportFalsePositives(): Promise<void> {
    if (!this.mutes) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      content: this.mutes.toReport(),
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc);
  }

  async clearMutes(): Promise<void> {
    const n = this.mutes?.clear() ?? 0;
    void vscode.window.showInformationMessage(`sensAI：已清除 ${n} 筆本機靜音。`);
  }

  jumpTo(line: number): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  private setStatus(text: string, tooltip: string): void {
    this.status.text = text;
    this.status.tooltip = tooltip;
    this.status.show();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("sensAI");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "sensai.showPanel";
  status.text = "sensAI";
  status.show();

  let controller: Controller;
  const panel = new FindingsPanel({
    onJump: (line) => controller.jumpTo(line),
    onMute: (finding) => void controller.muteFinding(finding),
  });
  controller = new Controller(panel, status, output);
  controller.reloadProjectFiles();

  context.subscriptions.push(
    output,
    status,
    vscode.window.registerWebviewViewProvider(FindingsPanel.viewId, panel),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (readSettings().enabled) {
        void controller.review(doc);
      }
    }),

    vscode.commands.registerCommand("sensai.reviewCurrentFile", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) {
        panel.reveal();
        void controller.review(doc);
      }
    }),
    vscode.commands.registerCommand("sensai.showPanel", () => panel.reveal()),
    vscode.commands.registerCommand("sensai.initProject", () => controller.initProject()),
    vscode.commands.registerCommand("sensai.exportFalsePositives", () =>
      controller.exportFalsePositives(),
    ),
    vscode.commands.registerCommand("sensai.clearLocalMutes", () => controller.clearMutes()),
    vscode.commands.registerCommand("sensai.reloadRules", () =>
      controller.reloadProjectFiles(true),
    ),
  );

  // 規則檔改動就熱重載，不用重開視窗。
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, ".sensai/*.{yaml,yml}"),
    );
    const reload = () => controller.reloadProjectFiles();
    watcher.onDidChange(reload);
    watcher.onDidCreate(reload);
    watcher.onDidDelete(reload);
    context.subscriptions.push(watcher);
    output.appendLine(`[init] 規則檔：${rulesPath(root)}`);
  }
}

export function deactivate(): void {
  // 沒有需要清理的長期資源。
}
