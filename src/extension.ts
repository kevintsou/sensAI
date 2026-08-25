import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DEFAULT_ARCH_ID } from "./abi";
import { ProjectConfig, loadProjectConfig } from "./config";
import { buildContext, realFileAccess, CachingFileAccess, isInSkippedDir } from "./context";
import { changedRanges, describeRanges, gitCwd, planReview, ReviewTrigger } from "./diff";
import {
  CarriedFindings,
  applySeverityBudget,
  carryOverFindings,
  filterFindings,
  mergeStageFindings,
} from "./filter";
import { LANGUAGE_LABEL, detectLanguage } from "./language";
import { MuteStore, muteKey } from "./mutes";
import { FindingsPanel } from "./panel";
import { appendAudit, blockedPaths } from "./privacy";
import { EndpointUnavailableError, ReviewCancelledError, requestReview } from "./review";
import { loadRules, rulesPath } from "./rules";
import { PinStore, PinBackingStore, pinKey } from "./pins";
import { SingleFlight } from "./singleflight";
import { Debouncer } from "./debounce";
import { CONFIG_TEMPLATE, GITIGNORE_TEMPLATE, RULES_TEMPLATE } from "./template";
import { DroppedFinding, Finding, PinnedFinding, ReviewContext, Rule } from "./types";

/**
 * normal —— 照 planReview() 的結果跑。
 * burst  —— 連續觸發中，兩階段只跑階段一，省下的完整審查記帳等 settle 補。
 * settle —— 補上 burst 期間省略掉的完整審查。單一請求，不重跑階段一。
 */
type ReviewMode = "normal" | "burst" | "settle";

interface Settings {
  enabled: boolean;
  debounceMs: number;
  endpoint: string;
  model: string;
  apiKey: string;
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
    apiKey: c.get("apiKey", ""),
    rulesPath: c.get("rulesPath", ""),
    debounceMs: c.get("debounceMs", 1000),
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
  /**
   * 同一個檔案同時只跑一輪審查；跑的期間進來的觸發併成一次補跑，不是丟掉 ——
   * 丟掉的話，使用者最後那次存檔的內容可能永遠不會被審到。
   */
  private readonly saves = new SingleFlight<ReviewTrigger>({
    // manual 蓋過 save，反過來不蓋。使用者明確叫過一次 Review Current File，
    // 補跑就不該因為中間夾了幾次存檔而降級成「沒有改動就跳過」。
    merge: (existing, incoming) =>
      incoming === "manual" || existing === undefined ? incoming : existing,
    onCoalesce: (key) =>
      this.output.appendLine(`[review] ${path.basename(key)} 還在審查中，這次觸發併入下一輪。`),
    onRerun: (key) => this.output.appendLine(`[review] 用最新內容補跑 ${path.basename(key)}。`),
    // 連續觸發停下來了：把 burst 期間省略掉的完整審查補回來。
    onSettled: (key) => this.settleFullReview(key),
  });
  private readonly debouncer = new Debouncer();
  /** burst 期間降級成「只看改動處」的檔案。安靜下來要補一次完整審查。 */
  private readonly owedFullReview = new Set<string>();
  /**
   * burst 期間階段一的意見，等補做完整審查時合併回來。
   *
   * 補做只跑階段二，發佈時會整個取代面板 —— 不留著的話，burst 期間落在改動行上
   * 的意見就消失了。只保留最後一輪：burst 的改動範圍是相對 HEAD 累積的，
   * 後一輪涵蓋前一輪，舊的留著只會是過期的行號。
   */
  private readonly burstFindings = new Map<string, CarriedFindings>();
  private readonly documents = new Map<string, vscode.TextDocument>();
  private lastSource = new Map<string, string>();
  private readonly pins: PinStore;
  /** 每個進行中審查的檔案對應一個 AbortController，供使用者取消。 */
  private readonly inFlightAborts = new Map<string, AbortController>();
  /**
   * 跨 review 共用的檔案存取 + header 索引快取。索引是整棵樹的同步掃描，
   * 每次 review 都重建會阻塞 extension host —— 所以留著這一份，只在 header
   * 檔增刪時 invalidateIndex()。workspace root 變了才重建。
   */
  private fileAccess: CachingFileAccess | undefined;
  private fileAccessRoot: string | undefined;

  constructor(
    private readonly panel: FindingsPanel,
    private readonly status: vscode.StatusBarItem,
    private readonly output: vscode.OutputChannel,
    backing: PinBackingStore,
  ) {
    this.pins = new PinStore(backing);
    this.panel.setPins(this.pins.all());
  }

  private get workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** 取得跨 review 共用的 FileAccess；workspace root 換了就重建。 */
  private getFileAccess(root: string): CachingFileAccess {
    if (!this.fileAccess || this.fileAccessRoot !== root) {
      this.fileAccess = realFileAccess(root);
      this.fileAccessRoot = root;
    }
    return this.fileAccess;
  }

  /** header 檔增刪時呼叫，讓下次 review 重建索引。內容變動不需要（索引只認路徑）。 */
  invalidateHeaderIndex(): void {
    this.fileAccess?.invalidateIndex();
  }

  /** 檔案關閉時清掉它的快取，避免 documents/lastSource 隨開過的檔案數無限成長。 */
  forgetDocument(filePath: string): void {
    this.documents.delete(filePath);
    this.lastSource.delete(filePath);
    this.burstFindings.delete(filePath);
    this.owedFullReview.delete(filePath);
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

  /**
   * 同一個檔案同時只跑一輪審查。這一輪還在跑時進來的觸發會記在 pending，
   * 等這輪結束用**當下最新的內容**補跑一次。
   *
   * 連按存檔、或邊打字邊自動存檔，都會塌縮成「現在這輪 + 最後補跑一次」，
   * 請求數不會隨存檔次數線性增加，而最後一次存檔的內容保證會被審到。
   */
  async review(document: vscode.TextDocument, trigger: ReviewTrigger = "manual"): Promise<void> {
    const filePath = document.uri.fsPath;
    this.documents.set(filePath, document);
    // 補跑時 document 是同一個物件參考，getText() 讀到的一定是當下最新的內容。
    await this.saves.run(filePath, trigger, (t, info) =>
      this.runReview(document, t, filePath, info.rerun ? "burst" : "normal"),
    );
  }

  /**
   * 存檔觸發的入口。等使用者安靜下來才真的送出。
   *
   * 存檔事件很密集（自動存檔預設 1 秒一次），而打到一半的程式碼審了也只是製造
   * 雜訊、而且審完就過期。手動的 Review Current File 不走這裡，一律立即執行。
   */
  reviewOnSave(document: vscode.TextDocument): void {
    const filePath = document.uri.fsPath;
    const delay = readSettings().debounceMs;
    if (delay <= 0) {
      void this.review(document, "save");
      return;
    }
    this.debouncer.schedule(filePath, delay, () => void this.review(document, "save"));
  }

  /** 手動觸發：取消還在等的去抖動，避免緊接著又補送一次存檔審查。 */
  reviewNow(document: vscode.TextDocument): void {
    this.debouncer.cancel(document.uri.fsPath);
    void this.review(document, "manual");
  }

  /**
   * 連續觸發期間只跑了階段一，這裡把完整審查補回來。
   *
   * 由 SingleFlight 在佇列排空、名額還沒放開時呼叫，所以這次完整審查
   * 不會跟別的審查並行；期間新進來的存檔仍然會被接住併入下一輪。
   */
  private async settleFullReview(filePath: string): Promise<void> {
    if (!this.owedFullReview.delete(filePath)) {
      return;
    }
    const document = this.documents.get(filePath);
    if (!document) {
      return;
    }
    this.output.appendLine(`[review] 連續存檔停止，補做 ${path.basename(filePath)} 的完整審查。`);
    // 直接呼叫 runReview，不要再走 saves.run —— 名額還握在手上，會卡死。
    await this.runReview(document, "manual", filePath, "settle");
  }

  private async runReview(
    document: vscode.TextDocument,
    trigger: ReviewTrigger,
    filePath: string,
    mode: ReviewMode,
  ): Promise<void> {
    const root = this.workspaceRoot;
    if (!root) {
      return;
    }
    // 用副檔名判斷，不用 languageId —— .s 在沒裝組語擴充時會是 plaintext。
    const language = detectLanguage(filePath);
    if (!language) {
      return;
    }

    const settings = readSettings();
    const source = document.getText();
    this.lastSource.set(filePath, source);
    // 送出當下的版本。審查要跑好幾秒，這期間使用者通常還在打字 ——
    // 結果回來時行號是對著這一版算的，未必還對得上編輯器裡的內容。
    const sentVersion = document.version;

    const ctx: ReviewContext = buildContext(
      filePath,
      source,
      {
        workspaceRoot: root,
        language,
        depth: settings.includeDepth,
        budgetBytes: settings.contextBudgetBytes,
      },
      // 共用實例，header 索引跨 review 快取，不要每次 review 重掃整棵樹。
      this.getFileAccess(root),
    );

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

    // 這次審查的取消控制。SingleFlight 保證同檔同時只有一輪 runReview，但補跑
    // 會換一個新的 AbortController —— 先中止並取代舊的，避免殘留。
    this.inFlightAborts.get(filePath)?.abort();
    const abort = new AbortController();
    this.inFlightAborts.set(filePath, abort);

    // 面板已有結果時不要清空回「審查中」—— 連續存檔會一輪輪蓋掉剛顯示的意見，
    // 造成空窗。留著上一輪結果、只在頂部標「更新中」，等新結果到位再蓋過去。
    if (this.panel.hasResult()) {
      this.panel.markUpdating();
    } else {
      this.panel.setState({
        kind: "reviewing",
        file: `${path.basename(filePath)}（${LANGUAGE_LABEL[language]}，${
          syntaxOnly ? "沒有規則，只檢查語法" : `${rules.length} 條規則`
        }）`,
      });
    }
    this.setStatus("$(sync~spin) sensAI", syntaxOnly ? "只檢查語法（沒有規則）" : "審查中");

    const started = Date.now();
    const lines = source.split("\n");
    const isMuted = (f: Finding) =>
      this.mutes?.has(muteKey(f, lines[f.line - 1] ?? "")) ?? false;
    const clientOpts = {
      endpoint: settings.endpoint,
      model: settings.model,
      // 空字串時交給 review.ts 的 fallback（環境變數 → 佔位字串），舊版 CCR 照舊能用。
      apiKey: settings.apiKey || undefined,
      signal: abort.signal,
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
      stage: "changed" | "changed-only" | "full" | undefined,
    ) => {
      // 不因為過期就把結果丟掉 —— 審查期間繼續打字是常態，丟掉的話意見會經常
      // 完全不出現。改成照常顯示但標記出來，讓使用者知道行號可能已經偏移。
      const stale = document.version !== sentVersion;
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
          completedAt: Date.now(),
          headersIncluded: ctx.headers.map((h) => h.path),
          contextTruncated: ctx.truncated,
          stage,
          stale,
        },
      });
      return shown.length + collapsed.length;
    };

    try {
      let kept: Finding[];
      let dropped: DroppedFinding[];

      // settle 是「把 burst 期間省略掉的那半邊補回來」，只需要階段二 ——
      // 階段一的意見在 burst 期間已經送過了，再跑一次只是重複付錢。
      if (plan.kind === "two-stage" && mode === "burst") {
        // 連續觸發中：只跑階段一。兩階段送的是**同一份完整檔案內容**
        // （階段一只是多一段範圍指示），所以省掉階段二等於省一半請求。
        //
        // 但階段一會把改動範圍外的意見濾掉，而 DMA cache、W1C、ISR、ABI
        // 這類問題本來就常常不在改動的那幾行上。所以這是延後、不是放棄 ——
        // 欠的完整審查記在 owedFullReview，等安靜下來由 settleFullReview() 補。
        const changed = plan.changed;
        this.owedFullReview.add(filePath);
        this.output.appendLine(
          `[review] 連續存檔中，只審第 ${describeRanges(changed)} 行；` +
            "完整審查等停下來再做。",
        );
        const raw = await requestReview(ctx, rules, { ...clientOpts, changed });
        const r = filterFindings(raw, source, isMuted, changed);
        logDropped(r.dropped);
        kept = r.kept;
        dropped = r.dropped;
        // 連同當時的內容一起存 —— 行號是對著這一版算的，補做時要比對。
        this.burstFindings.set(filePath, { findings: kept, dropped, source });
      } else if (plan.kind === "two-stage" && mode === "normal") {
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

      if (mode === "settle") {
        const carried = this.burstFindings.get(filePath);
        this.burstFindings.delete(filePath);
        const out = carryOverFindings(carried, { findings: kept, dropped, source });
        if (out.merged) {
          this.output.appendLine(
            `[review] 併回 burst 期間的 ${carried!.findings.length} 則意見` +
              (out.duplicates > 0 ? `，其中 ${out.duplicates} 則與完整審查重複` : ""),
          );
        } else if (carried) {
          this.output.appendLine(
            "[review] 檔案在補做完整審查前又被改過，burst 期間的意見行號已過期，不併回。",
          );
        }
        kept = out.findings;
        dropped = out.dropped;
      } else if (mode === "normal") {
        // 完整的兩階段已經自己涵蓋了改動處，先前 burst 的殘留就過期了。
        this.burstFindings.delete(filePath);
      }

      const durationMs = Date.now() - started;
      publish(
        kept,
        dropped,
        plan.kind !== "two-stage" && mode !== "settle"
          ? undefined
          : mode === "burst"
            ? "changed-only"
            : "full",
      );

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
      if (err instanceof ReviewCancelledError) {
        // 使用者主動取消：不是錯誤。回到閒置，狀態列給個中性的字。
        this.panel.setState({ kind: "idle" });
        this.setStatus("$(circle-slash) sensAI", "已取消");
        this.output.appendLine(`[review] ${path.basename(filePath)} 的審查已取消。`);
      } else if (err instanceof EndpointUnavailableError) {
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
      // 只清掉屬於這一輪的 controller —— 補跑已經換上新的，別誤刪。
      if (this.inFlightAborts.get(filePath) === abort) {
        this.inFlightAborts.delete(filePath);
      }
    }
  }

  /**
   * 取消目前檔案進行中的審查。
   *
   * abort 進行中的請求（兩階段都會收到同一個 signal），並清掉還在等的 debounce，
   * 免得取消完緊接著又送一次。面板由 runReview 的 catch 收到 ReviewCancelledError
   * 後回到閒置。
   */
  cancelReview(): void {
    const filePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!filePath) {
      return;
    }
    this.debouncer.cancel(filePath);
    const abort = this.inFlightAborts.get(filePath);
    if (abort) {
      abort.abort();
      this.output.appendLine(`[review] 使用者取消了 ${path.basename(filePath)} 的審查。`);
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
   * 切換釘選。checkbox 的 change 事件勾與不勾都會進來，所以這裡看目前狀態
   * 決定是釘還是取消 —— 使用者取消勾選一則已釘的意見時也要能拿掉。
   */
  togglePin(finding: Finding): void {
    const root = this.workspaceRoot;
    const editor = vscode.window.activeTextEditor;
    const filePath = editor?.document.uri.fsPath;
    if (!root || !filePath) {
      return;
    }
    const key = pinKey(filePath, finding);
    if (this.pins.has(key)) {
      this.pins.remove(key);
    } else {
      const source = this.lastSource.get(filePath) ?? editor!.document.getText();
      const lineText = source.split("\n")[finding.line - 1] ?? "";
      const record: PinnedFinding = {
        key,
        finding,
        file: path.relative(root, filePath),
        filePath,
        lineText,
        comment: "",
        pinnedAt: new Date().toISOString(),
      };
      this.pins.add(record);
    }
    this.panel.setPins(this.pins.all());
  }

  unpin(key: string): void {
    this.pins.remove(key);
    this.panel.setPins(this.pins.all());
  }

  /** 更新釘選的筆記。刻意不重繪 —— 重繪會清掉使用者正在編輯的 textarea。 */
  setPinComment(key: string, text: string): void {
    this.pins.setComment(key, text);
  }

  /** 跳到某個檔案的某一行（釘選區的意見可能來自別的檔案）。 */
  async jumpToFile(filePath: string, line: number): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(filePath);
      const editor = await vscode.window.showTextDocument(doc);
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch {
      void vscode.window.showWarningMessage(`sensAI：開不了 ${filePath}`);
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

  dispose(): void {
    this.debouncer.dispose();
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
    onPin: (finding) => controller.togglePin(finding),
    onUnpin: (key) => controller.unpin(key),
    onJumpTo: (filePath, line) => void controller.jumpToFile(filePath, line),
    onComment: (key, text) => controller.setPinComment(key, text),
    onCancel: () => controller.cancelReview(),
  });
  // 釘選與筆記存到 workspaceState：專案級、跨重啟保留、不進版控。
  const PIN_KEY = "sensai.pins";
  const backing: PinBackingStore = {
    get: () => context.workspaceState.get<PinnedFinding[]>(PIN_KEY, []),
    set: (records) => {
      void context.workspaceState.update(PIN_KEY, records);
    },
  };
  controller = new Controller(panel, status, output, backing);
  controller.reloadProjectFiles();

  context.subscriptions.push(
    output,
    status,
    { dispose: () => controller.dispose() },
    vscode.window.registerWebviewViewProvider(FindingsPanel.viewId, panel),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (readSettings().enabled) {
        controller.reviewOnSave(doc);
      }
    }),

    // 檔案關閉就丟掉它的快取，否則 documents/lastSource 會隨開過的檔案數
    // 無限成長 —— documents 還持有 TextDocument 強參考，擋住 GC。
    vscode.workspace.onDidCloseTextDocument((doc) => {
      controller.forgetDocument(doc.uri.fsPath);
    }),

    vscode.commands.registerCommand("sensai.reviewCurrentFile", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) {
        panel.reveal();
        controller.reviewNow(doc);
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

    // header 檔增刪時讓 header 索引失效。索引只認「檔名 → 路徑」，所以內容變動
    // （onDidChange）不影響，只需要理會新增與刪除。
    const headerWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, "**/*.{h,hpp,hh,inc,s,S}"),
    );
    // 只有落在「索引會掃的目錄」裡的 header 增刪才失效。build/out/dist 這些
    // buildHeaderIndex 本來就跳過，一 build 就在那裡churn 大量 .h，不濾掉的話
    // 快取會被反覆清空，等於白做快取。glob 不好排除多目錄，改在回呼裡濾。
    const invalidate = (uri: vscode.Uri) => {
      if (!isInSkippedDir(path.relative(root, uri.fsPath))) {
        controller.invalidateHeaderIndex();
      }
    };

    context.subscriptions.push(
      configWatcher,
      configWatcher.onDidChange(reload),
      configWatcher.onDidCreate(reload),
      configWatcher.onDidDelete(reload),
      headerWatcher,
      headerWatcher.onDidCreate(invalidate),
      headerWatcher.onDidDelete(invalidate),
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
