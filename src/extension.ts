import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DEFAULT_ARCH_ID } from "./abi";
import { ProjectConfig, loadProjectConfig } from "./config";
import { buildContext } from "./context";
import { changedRanges, describeRanges, gitCwd, planReview, ReviewTrigger } from "./diff";
import { applySeverityBudget, filterFindings, mergeStageFindings } from "./filter";
import { LANGUAGE_LABEL, detectLanguage } from "./language";
import { MuteStore, muteKey } from "./mutes";
import { FindingsPanel } from "./panel";
import { appendAudit, blockedPaths } from "./privacy";
import { EndpointUnavailableError, requestReview } from "./review";
import { loadRules, rulesPath } from "./rules";
import { CONFIG_TEMPLATE, GITIGNORE_TEMPLATE, RULES_TEMPLATE } from "./template";
import { DroppedFinding, Finding, ReviewContext, Rule } from "./types";

interface Settings {
  enabled: boolean;
  endpoint: string;
  model: string;
  rulesPath: string;
  includeDepth: number;
  contextBudgetBytes: number;
  requestTimeoutMs: number;
  maxFindings: number;
}

function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration("sensai");
  return {
    enabled: c.get("enabled", true),
    endpoint: c.get("endpoint", "http://127.0.0.1:3456"),
    model: c.get("model", "claude-opus-5"),
    rulesPath: c.get("rulesPath", ""),
    includeDepth: c.get("includeDepth", 2),
    contextBudgetBytes: c.get("contextBudgetBytes", 120000),
    requestTimeoutMs: c.get("requestTimeoutMs", 120000),
    maxFindings: c.get("maxFindings", 8),
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
    const settings = readSettings();
    const file = rulesPath(root, settings.rulesPath);
    const { rules, problems } = loadRules(root, settings.rulesPath);
    this.rules = rules;
    this.mutes = new MuteStore(MuteStore.defaultPath(root));

    for (const p of problems) {
      this.output.appendLine(`[rules] ${p}`);
    }
    this.output.appendLine(`[rules] 規則檔：${file}（載入 ${rules.length} 條）`);
    if (notify) {
      const summary = `sensAI：載入 ${rules.length} 條規則` +
        (problems.length > 0 ? `，${problems.length} 個問題（見 Output）` : "");
      void vscode.window.showInformationMessage(summary);
    }
  }

  async review(document: vscode.TextDocument, trigger: ReviewTrigger = "manual"): Promise<void> {
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
    // 沒有規則時不整個跳過，改成只做語法檢查（見 prompt.ts 的 SYNTAX_ONLY）。
    // 泛泛的通用意見確實不值得打擾作者，但語法錯誤的對錯不需要專案知識，
    // 而且不能假設這台機器上裝了編譯器或 clangd。
    const syntaxOnly = rules.length === 0;
    if (syntaxOnly) {
      this.output.appendLine(
        `[review] 沒有適用於${LANGUAGE_LABEL[language]}的規則，本次只檢查語法。` +
          "請確認 sensai.rulesPath 或 .sensai/rules.yaml。",
      );
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

    // 相對 git HEAD 的改動行號。null 代表檔案未追蹤或不在 git repo —— 那種
    // 情況下階段一與階段二的範圍會完全相同，跑兩次只是浪費，退回單階段。
    const changed = await changedRanges(filePath, gitCwd(filePath));
    const plan = planReview(trigger, changed);

    // 存檔但檔案沒有任何改動：不審，也不送任何東西出去。
    // 面板維持原狀 —— 上一次的意見對這份沒變過的檔案仍然成立，清掉反而是退步。
    if (plan.kind === "skip") {
      this.output.appendLine(
        `[review] ${path.basename(filePath)} 相對 HEAD 沒有改動，存檔不觸發審查。` +
          "要重看整份檔案請用 sensAI: Review Current File。",
      );
      this.setStatus("$(check) sensAI", "沒有改動，未審查");
      return;
    }

    this.inFlight.add(filePath);
    this.panel.setState({
      kind: "reviewing",
      file: `${path.basename(filePath)}（${LANGUAGE_LABEL[language]}，${
        syntaxOnly ? "沒有規則，只檢查語法" : `${rules.length} 條規則`
      }）`,
    });
    this.setStatus("$(sync~spin) sensAI", syntaxOnly ? "只檢查語法（沒有規則）" : "審查中");

    const started = Date.now();
    const lines = source.split("\n");
    const isMuted = (f: Finding) =>
      this.mutes?.has(muteKey(f, lines[f.line - 1] ?? "")) ?? false;
    const clientOpts = {
      endpoint: settings.endpoint,
      model: settings.model,
      timeoutMs: settings.requestTimeoutMs,
      archId: this.config.assemblyArch,
      onUnknownRuleId: (id: string) => {
        this.output.appendLine(
          `[review] 模型回報了不存在的規則 id「${id}」，已改記為無規則。` +
            "常出現的話，通常代表規則寫得不夠具體，模型在照命名慣例猜。",
        );
      },
    };
    const logDropped = (dropped: DroppedFinding[]) => {
      for (const d of dropped) {
        this.output.appendLine(
          `[filter] 濾除 (${d.reason}) 第 ${d.finding.line} 行：${d.finding.message}`,
        );
      }
    };
    const publish = (
      findings: Finding[],
      dropped: DroppedFinding[],
      stage: "changed" | "full" | undefined,
    ) => {
      const { shown, collapsed } = applySeverityBudget(findings, settings.maxFindings);
      if (collapsed.length > 0) {
        this.output.appendLine(
          `[budget] 意見過多，收合 ${collapsed.length} 則較低嚴重度的意見` +
            `（上限 ${settings.maxFindings}，可用 sensai.maxFindings 調整）`,
        );
      }
      this.panel.setState({
        kind: "result",
        result: {
          filePath,
          findings: shown,
          collapsed,
          dropped,
          durationMs: Date.now() - started,
          headersIncluded: ctx.headers.map((h) => h.path),
          contextTruncated: ctx.truncated,
          stage,
        },
      });
      return shown.length + collapsed.length;
    };

    try {
      let kept: Finding[];
      let dropped: DroppedFinding[];

      if (plan.kind === "two-stage") {
        // 兩階段並行：階段一只看剛改的行，會先回來；階段二審整份檔案。
        // 並行而不是依序，總等待時間才不會是兩者相加。
        const changed = plan.changed;
        this.output.appendLine(
          `[review] 兩階段：階段一只看第 ${describeRanges(changed)} 行，階段二審整份檔案`,
        );
        const stage1 = requestReview(ctx, rules, { ...clientOpts, changed });
        const stage2 = requestReview(ctx, rules, clientOpts);

        // 階段一先到就先顯示，不等階段二。
        const first = stage1.then((raw) => {
          const r = filterFindings(raw, source, isMuted, changed);
          logDropped(r.dropped);
          return r;
        });
        first
          .then((r) => {
            publish(r.kept, r.dropped, "changed");
            this.setStatus("$(sync~spin) sensAI", `改動處 ${r.kept.length} 則 · 完整審查中`);
          })
          .catch(() => {
            /* 階段一失敗不影響階段二，錯誤由下面的 await 統一處理 */
          });

        const [r1, r2] = await Promise.allSettled([first, stage2]);
        if (r1.status === "rejected" && r2.status === "rejected") {
          throw r1.reason;
        }

        const changedResult =
          r1.status === "fulfilled" ? r1.value : { kept: [] as Finding[], dropped: [] };
        if (r2.status === "rejected") {
          // 完整審查掛了，至少把階段一的結果留在畫面上。
          this.output.appendLine(`[review] 階段二失敗：${(r2.reason as Error).message}`);
          kept = changedResult.kept;
          dropped = changedResult.dropped;
        } else {
          const full = filterFindings(r2.value, source, isMuted);
          logDropped(full.dropped);
          const { merged, duplicates } = mergeStageFindings(changedResult.kept, full.kept, source);
          if (duplicates > 0) {
            this.output.appendLine(`[review] 兩階段重複 ${duplicates} 則，已合併`);
          }
          kept = merged;
          dropped = [...changedResult.dropped, ...full.dropped];
        }
      } else {
        const raw = await requestReview(ctx, rules, clientOpts);
        const r = filterFindings(raw, source, isMuted);
        logDropped(r.dropped);
        kept = r.kept;
        dropped = r.dropped;
      }

      const durationMs = Date.now() - started;
      publish(kept, dropped, plan.kind === "two-stage" ? "full" : undefined);

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
    const usesConfiguredRulesPath = rulesPath(root, readSettings().rulesPath) !== rulesPath(root);
    const files: Array<[string, string]> = [
      ["config.yaml", CONFIG_TEMPLATE],
      [".gitignore", GITIGNORE_TEMPLATE],
    ];
    if (!usesConfiguredRulesPath) {
      files.unshift(["rules.yaml", RULES_TEMPLATE]);
    }

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

    if (!usesConfiguredRulesPath) {
      const doc = await vscode.workspace.openTextDocument(path.join(dir, "rules.yaml"));
      await vscode.window.showTextDocument(doc);
    }
    void vscode.window.showInformationMessage(
      usesConfiguredRulesPath
        ? "sensAI：已建立 .sensai/ 的專案設定；規則使用 sensai.rulesPath 指定的位置。"
        : "sensAI：已建立 .sensai/。裡面的規則只是格式示範，請換成你們專案真正的規則。",
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
        void controller.review(doc, "save");
      }
    }),

    vscode.commands.registerCommand("sensai.reviewCurrentFile", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) {
        panel.reveal();
        void controller.review(doc, "manual");
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

  // 專案設定與目前設定的規則檔改動都熱重載，不用重開視窗。
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    const configWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, ".sensai/config.{yaml,yml}"),
    );
    const reload = () => controller.reloadProjectFiles();
    configWatcher.onDidChange(reload);
    configWatcher.onDidCreate(reload);
    configWatcher.onDidDelete(reload);

    let rulesWatcher: vscode.FileSystemWatcher | undefined;
    const watchRulesFile = () => {
      rulesWatcher?.dispose();
      const file = rulesPath(root, readSettings().rulesPath);
      rulesWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(path.dirname(file), path.basename(file)),
      );
      rulesWatcher.onDidChange(reload);
      rulesWatcher.onDidCreate(reload);
      rulesWatcher.onDidDelete(reload);
      output.appendLine(`[init] 規則檔：${file}`);
    };
    watchRulesFile();

    context.subscriptions.push(
      configWatcher,
      { dispose: () => rulesWatcher?.dispose() },
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("sensai.rulesPath")) {
          watchRulesFile();
          controller.reloadProjectFiles(true);
        }
      }),
    );
  }
}

export function deactivate(): void {
  // 沒有需要清理的長期資源。
}
