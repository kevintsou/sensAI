import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DEFAULT_ARCH_ID } from "./abi";
import { ProjectConfig, loadProjectConfig } from "./config";
import { buildContext, realFileAccess, CachingFileAccess, isInSkippedDir } from "./context";
import {
  ChangedFile,
  assignFindings,
  changesetWarning,
  formatBytes,
  listChangedFiles,
  mergeHeaders,
} from "./changeset";
import { changedRanges, describeRanges, gitCwd, LineRange, planReview, ReviewTrigger } from "./diff";
import { expandToEnclosingFunction } from "./funcscope";
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
import {
  EndpointUnavailableError,
  ReviewCancelledError,
  requestChangesetReview,
  requestReview,
} from "./review";
import { loadRules, rulesPath } from "./rules";
import { PinStore, PinBackingStore, pinKey } from "./pins";
import { SingleFlight } from "./singleflight";
import { Debouncer } from "./debounce";
import { CONFIG_TEMPLATE, GITIGNORE_TEMPLATE, RULES_TEMPLATE } from "./template";
import {
  ChangesetContext,
  ChangesetTarget,
  DroppedFinding,
  Finding,
  PinnedFinding,
  ReviewContext,
  ReviewResult,
  Rule,
} from "./types";

/**
 * normal —— 照 planReview() 的結果跑。
 * burst  —— 連續觸發中，兩階段只跑階段一，省下的完整審查記帳等 settle 補。
 * settle —— 補上 burst 期間省略掉的完整審查。單一請求，不重跑階段一。
 */
type ReviewMode = "normal" | "burst" | "settle";

/**
 * 三種模式。存成兩個設定：sensai.enabled 是總開關，sensai.mode 選自動或手動。
 *
 * 不併成一個設定，是因為 enabled 已經有人在用（0.6 以前就有），而且這樣關掉
 * 再打開時會回到原本的模式，不用另外記。
 */
type Mode = "auto" | "manual" | "off";

const MODE_LABEL: Record<Mode, string> = {
  auto: "$(eye) 自動",
  manual: "$(debug-pause) 手動",
  off: "$(eye-closed) 已關閉",
};

function currentMode(s: Settings = readSettings()): Mode {
  return !s.enabled ? "off" : s.mode;
}

interface Settings {
  enabled: boolean;
  mode: "auto" | "manual";
  debounceMs: number;
  endpoint: string;
  model: string;
  apiKey: string;
  rulesPath: string;
  includeDepth: number;
  contextBudgetBytes: number;
  requestTimeoutMs: number;
  maxFindings: number;
  reviewWholeFile: boolean;
}

function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration("sensai");
  return {
    enabled: c.get("enabled", true),
    mode: c.get<string>("mode", "auto") === "manual" ? "manual" : "auto",
    endpoint: c.get("endpoint", "http://127.0.0.1:3456"),
    model: c.get("model", "claude-opus-5"),
    apiKey: c.get("apiKey", ""),
    rulesPath: c.get("rulesPath", ""),
    debounceMs: c.get("debounceMs", 1000),
    includeDepth: c.get("includeDepth", 2),
    contextBudgetBytes: c.get("contextBudgetBytes", 120000),
    requestTimeoutMs: c.get("requestTimeoutMs", 120000),
    maxFindings: c.get("maxFindings", 8),
    reviewWholeFile: c.get("reviewWholeFile", false),
  };
}

/**
 * 切換 sensai.enabled。
 *
 * 寫到「目前真正決定這個值」的那一層：專案的 .vscode/settings.json 若有寫，
 * 只改使用者設定會被它蓋掉，按了沒反應。都沒寫才寫使用者設定 —— 暫時關掉
 * 通常是「我這台機器先不要」，不該變成 commit 進版控的專案設定。
 */
async function writeSetting(key: "enabled" | "mode", value: unknown): Promise<void> {
  const c = vscode.workspace.getConfiguration("sensai");
  const info = c.inspect(key);
  const target =
    info?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await c.update(key, value, target);
}

async function setEnabled(enabled: boolean): Promise<void> {
  await writeSetting("enabled", enabled);
  void vscode.window.showInformationMessage(
    enabled ? "sensAI：已開啟。" : "sensAI：已暫時關閉，不會再送出任何審查。",
  );
}

/** 切換到某個模式。寫入的層級規則同 setEnabled。 */
async function setMode(mode: Mode): Promise<void> {
  if (mode === "off") {
    await setEnabled(false);
    return;
  }
  if (readSettings().mode !== mode) {
    await writeSetting("mode", mode);
  }
  if (!readSettings().enabled) {
    await writeSetting("enabled", true);
  }
  void vscode.window.showInformationMessage(
    mode === "auto"
      ? "sensAI：自動模式，存檔就會審查。"
      : "sensAI：手動模式，存檔不再審查。改完一組後按 ▶ 審查改動。",
  );
}

/** 讓使用者從三種模式裡挑一個。 */
async function pickMode(): Promise<void> {
  const now = currentMode();
  const items: Array<vscode.QuickPickItem & { mode: Mode }> = [
    { mode: "auto", label: MODE_LABEL.auto, detail: "存檔就審查改動的地方（原本的行為）" },
    {
      mode: "manual",
      label: MODE_LABEL.manual,
      detail: "存檔不審查。改完一組後按 ▶ 審查改動，一次審整組改動，可以跨多個檔案",
    },
    { mode: "off", label: "$(eye-closed) 關閉", detail: "不送出任何審查" },
  ];
  for (const item of items) {
    if (item.mode === now) {
      item.description = "目前";
    }
  }
  const pick = await vscode.window.showQuickPick(items, {
    title: "sensAI 模式",
    placeHolder: "選擇 sensAI 什麼時候審查",
  });
  if (pick && pick.mode !== now) {
    await setMode(pick.mode);
  }
}

/** 審查整組改動在 inFlightAborts、面板取消鈕上用的 key。不會跟檔案路徑撞到。 */
const CHANGESET_KEY = "sensai:changeset";

/** 審查改動時，一個讀好、算好範圍與上下文的改動檔案。 */
interface PreparedFile {
  file: ChangedFile;
  source: string;
  /** 審查範圍（改動處與所在函式）。null 代表整份。 */
  scope: LineRange[] | null;
  ctx: ReviewContext;
  /** 命中 never_send 的路徑（檔案本身或它 include 的 header）。非空就不送。 */
  blocked: string[];
}

function toRel(root: string, p: string): string {
  return path.relative(root, p).split(path.sep).join("/");
}

function blockedReason(p: PreparedFile, root: string): string {
  const hits = p.blocked.filter((b) => path.resolve(b) !== path.resolve(p.file.filePath));
  return hits.length === 0
    ? "命中 privacy.never_send"
    : `include 的 ${hits.map((h) => toRel(root, h)).join("、")} 命中 privacy.never_send`;
}

/** 勾選清單上顯示的大小估計：原始碼加上合併後（受預算限制）的 header。 */
function estimateBytes(chosen: PreparedFile[], budget: number): number {
  const targets = new Set(chosen.map((p) => path.resolve(p.file.filePath)));
  const { headers } = mergeHeaders(chosen.map((p) => p.ctx), targets, budget);
  return (
    chosen.reduce((n, p) => n + p.source.length, 0) + headers.reduce((n, h) => n + h.text.length, 0)
  );
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
  /** 審查改動正在整理檔案或等使用者勾選。 */
  private preparingChangeset = false;
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
      this.fileAccess = realFileAccess(root, (msg) => this.output.appendLine(`[index] ${msg}`));
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
    // 補做的完整審查是存檔觸發的延續，只有自動模式才做。
    if (currentMode() !== "auto") {
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
    // 關掉就是完全不外送，手動觸發也一樣。入口處都擋過了，這裡是最後一道：
    // 關掉之前就排進 SingleFlight 的補跑、清除靜音觸發的重審，都會走到這裡。
    if (!settings.enabled) {
      return;
    }
    // 存檔觸發只在自動模式跑。切到手動之前就排進 SingleFlight 的補跑會走到這裡。
    if (trigger === "save" && settings.mode !== "auto") {
      return;
    }
    const source = document.getText();
    this.lastSource.set(filePath, source);
    // 送出當下的版本。審查要跑好幾秒，這期間使用者通常還在打字 ——
    // 結果回來時行號是對著這一版算的，未必還對得上編輯器裡的內容。
    const sentVersion = document.version;

    const ctx: ReviewContext = await buildContext(
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
      this.panel.markUpdating(filePath);
    } else {
      this.panel.setState({
        kind: "reviewing",
        filePath,
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
    /**
     * 寫一筆稽核記錄。成功與失敗都要寫 —— 請求送到一半才失敗的情況下，
     * 原始碼已經離開這台機器了，這時候留白等於在最需要記錄的時候沒有記錄。
     */
    const writeAudit = (
      outcome: "ok" | "failed" | "cancelled",
      findings = 0,
      droppedCount = 0,
    ) => {
      appendAudit(root, this.config, {
        ts: new Date().toISOString(),
        outcome,
        file: path.relative(root, filePath),
        headers: ctx.headers.length,
        bytes: source.length + ctx.headers.reduce((n, h) => n + h.text.length, 0),
        endpoint: settings.endpoint,
        model: settings.model,
        findings,
        dropped: droppedCount,
        durationMs: Date.now() - started,
      });
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
          sourceLines: lines,
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
        // 兩階段並行：階段一只看剛改的行，會先回來；階段二是「完整審查」那一段。
        // 並行而不是依序，總等待時間才不會是兩者相加。
        //
        // 階段二的範圍：預設是「改動所在的函式」（比整份小、較快、較省 token）；
        // 開了 sensai.reviewWholeFile 就擴大成整份檔案。函式是整份的子集，所以
        // 兩者擇一即可，不會同時送、不重疊。
        const changed = plan.changed;
        const wholeFile = settings.reviewWholeFile;
        // 拓不出函式邊界時 expandToEnclosingFunction 會保留原改動行，等於退回
        // 只看改動行 —— 保守，不會把半個檔案誤當函式。
        const secondScope = wholeFile ? null : expandToEnclosingFunction(source, changed);
        this.output.appendLine(
          `[review] 兩階段：階段一只看第 ${describeRanges(changed)} 行，階段二審` +
            (wholeFile
              ? "整份檔案（sensai.reviewWholeFile）"
              : `改動所在的函式（第 ${describeRanges(secondScope!)} 行）`),
        );
        const stage1 = requestReview(ctx, rules, { ...clientOpts, changed });
        const stage2 = requestReview(ctx, rules, { ...clientOpts, changed: secondScope });

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
          // 階段二的範圍限制跟送出去的一致：整份不限範圍，函式則限在函式行內。
          const full = filterFindings(r2.value, source, isMuted, secondScope);
          logDropped(full.dropped);
          const { merged, duplicates } = mergeStageFindings(changedResult.kept, full.kept, source);
          if (duplicates > 0) {
            this.output.appendLine(`[review] 兩階段重複 ${duplicates} 則，已合併`);
          }
          kept = merged;
          dropped = [...changedResult.dropped, ...full.dropped];
        }
      } else if (plan.kind === "two-stage" && mode === "settle") {
        // burst 停下後補做「完整審查那一段」。範圍跟 normal 的階段二一致：
        // 預設函式、開了 reviewWholeFile 才整份。階段一在 burst 期間已送過。
        const secondScope = settings.reviewWholeFile
          ? null
          : expandToEnclosingFunction(source, plan.changed);
        this.output.appendLine(
          `[review] 補做完整審查：${
            settings.reviewWholeFile ? "整份檔案" : `改動所在的函式（第 ${describeRanges(secondScope!)} 行）`
          }`,
        );
        const raw = await requestReview(ctx, rules, { ...clientOpts, changed: secondScope });
        const r = filterFindings(raw, source, isMuted, secondScope);
        logDropped(r.dropped);
        kept = r.kept;
        dropped = r.dropped;
      } else {
        // full plan（未追蹤／非 git／手動審沒改動）：沒有改動範圍可算函式，審整份。
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

      publish(
        kept,
        dropped,
        plan.kind !== "two-stage" && mode !== "settle"
          ? undefined
          : mode === "burst"
            ? "changed-only"
            : "full",
      );

      writeAudit("ok", kept.length, dropped.length);

      if (kept.length === 0) {
        this.setStatus("$(check) sensAI", "沒有發現問題");
      } else {
        this.setStatus(`$(comment-discussion) sensAI ${kept.length}`, `${kept.length} 則意見`);
      }
    } catch (err) {
      writeAudit(err instanceof ReviewCancelledError ? "cancelled" : "failed");
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
  cancelReview(filePath?: string): void {
    // 面板會指名要取消哪個檔案（它顯示的就是那個檔案的結果）。
    // 從命令面板叫進來時沒有指名，才退回目前這個分頁。
    // 審查改動進行中時，從命令面板取消的就是它 —— 那是使用者最可能想停的。
    const target =
      filePath ??
      (this.inFlightAborts.has(CHANGESET_KEY)
        ? CHANGESET_KEY
        : vscode.window.activeTextEditor?.document.uri.fsPath);
    if (!target) {
      return;
    }
    const abort = this.inFlightAborts.get(target);
    this.debouncer.cancel(target);
    if (abort) {
      abort.abort();
      this.output.appendLine(`[review] 使用者取消了 ${path.basename(target)} 的審查。`);
    }
  }
  /**
   * 取得某個檔案「產生這些意見時」的內容。
   *
   * 一定要用審查當下那一版：意見的行號是對著它算的，拿別的版本去取那一行
   * 會算出對不上的 muteKey，靜音就永遠不會生效。
   */
  private reviewedSource(filePath: string): string | undefined {
    return this.lastSource.get(filePath) ?? this.documents.get(filePath)?.getText();
  }

  async muteFinding(finding: Finding, filePath: string): Promise<void> {
    const root = this.workspaceRoot;
    const source = this.reviewedSource(filePath);
    if (!root || source === undefined || !this.mutes) {
      return;
    }
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

    // 審查改動的結果、或手動模式下的任何結果：直接從畫面上拿掉。為了一則意見
    // 重送整組改動又慢又貴，手動模式也不該自己送出請求。
    if (this.panel.showingChangeset() || currentMode() === "manual") {
      this.panel.removeFinding(finding);
      return;
    }

    // 重審剛靜音的那個檔案，不是前景那個。
    const document = this.documents.get(filePath);
    if (document) {
      await this.review(document);
    }
  }

  /**
   * 切換釘選。checkbox 的 change 事件勾與不勾都會進來，所以這裡看目前狀態
   * 決定是釘還是取消 —— 使用者取消勾選一則已釘的意見時也要能拿掉。
   */
  togglePin(finding: Finding, filePath: string): void {
    const root = this.workspaceRoot;
    if (!root) {
      return;
    }
    const source = this.reviewedSource(filePath) ?? "";
    const lineText = source.split("\n")[finding.line - 1] ?? "";
    const key = pinKey(filePath, finding, lineText);
    if (this.pins.has(key)) {
      this.pins.remove(key);
    } else {
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
    // 被靜音擋掉的意見要重新出現，得再審一次 —— 面板上的舊結果是套用過
    // 靜音之後的，清了不重審的話畫面不會有任何變化，看起來像沒生效。
    // 手動模式不自己送出請求：意見會在下一次審查時重新出現。
    if (currentMode() === "manual") {
      if (n > 0) {
        this.output.appendLine("[mutes] 手動模式：被靜音的意見會在下一次審查時重新出現。");
      }
      return;
    }
    const document = vscode.window.activeTextEditor?.document;
    if (n > 0 && document) {
      await this.review(document);
    }
  }

  /** 清除所有釘選與筆記。與 clearMutes 對稱 —— 否則釘選只進不出。 */
  clearPins(): void {
    const n = this.pins.clear();
    this.panel.setPins(this.pins.all());
    void vscode.window.showInformationMessage(`sensAI：已清除 ${n} 筆釘選。`);
  }

  /**
   * 從自動切到手動時呼叫。
   *
   * 還沒送出的存檔審查（在等去抖動的、burst 欠下的完整審查）收掉；已經在跑的
   * 讓它跑完 —— 那是切換之前就送出去的，結果仍然有用。
   */
  stopSaveReviews(): void {
    this.debouncer.cancelAll();
    this.owedFullReview.clear();
    this.output.appendLine("[review] 手動模式：存檔不再觸發審查。");
  }

  /**
   * 手動模式的「審查改動」：把相對 HEAD 改過的檔案整組送審。
   *
   * 跟存檔審查的差別在於範圍 —— 存檔時只看得到那一個檔案剛存下的那一塊，
   * 改動跨好幾個檔案時，其他相關的部分可能還沒改，審出來的是做到一半的狀態。
   * 這裡等使用者說「改完了」，再把整組放進同一個請求，模型才看得到跨檔案的不一致。
   */
  async reviewChanges(): Promise<void> {
    // 整理改動與勾選清單開著的期間，再按一次不要疊出第二份清單。
    if (this.preparingChangeset) {
      return;
    }
    this.preparingChangeset = true;
    try {
      await this.reviewChangesUnguarded();
    } finally {
      this.preparingChangeset = false;
    }
  }

  private async reviewChangesUnguarded(): Promise<void> {
    const root = this.workspaceRoot;
    if (!root) {
      void vscode.window.showWarningMessage("sensAI：請先開啟一個資料夾。");
      return;
    }
    if (this.inFlightAborts.has(CHANGESET_KEY)) {
      void vscode.window.showInformationMessage(
        "sensAI：上一次的審查改動還在進行中，可以在面板上取消。",
      );
      return;
    }

    // git diff 只看得到磁碟上的內容。還沒存檔的編輯不能偷偷用舊內容審。
    const dirty = vscode.workspace.textDocuments.filter(
      (d) =>
        d.isDirty &&
        d.uri.scheme === "file" &&
        detectLanguage(d.uri.fsPath) !== null &&
        !path.relative(root, d.uri.fsPath).startsWith(".."),
    );
    if (dirty.length > 0) {
      const names = dirty.map((d) => path.basename(d.uri.fsPath)).join("、");
      const SAVE = "全部存檔並審查";
      const pick = await vscode.window.showWarningMessage(
        `有 ${dirty.length} 個檔案還沒存檔：${names}。審查的是存檔後的內容。`,
        { modal: true },
        SAVE,
      );
      if (pick !== SAVE) {
        return;
      }
      for (const d of dirty) {
        if (!(await d.save())) {
          void vscode.window.showWarningMessage(`sensAI：${path.basename(d.uri.fsPath)} 存檔失敗，已取消審查。`);
          return;
        }
      }
    }

    let changed: ChangedFile[];
    try {
      changed = await listChangedFiles(root);
    } catch (err) {
      void vscode.window.showWarningMessage(`sensAI：${(err as Error).message}`);
      return;
    }
    if (changed.length === 0) {
      void vscode.window.showInformationMessage("sensAI：相對 HEAD 沒有改動的 C 或組語檔案。");
      return;
    }

    const settings = readSettings();
    const fa = this.getFileAccess(root);
    this.setStatus("$(sync~spin) sensAI", "整理改動中");
    const prepared = (
      await Promise.all(changed.map((f) => this.prepareChangedFile(f, root, settings, fa)))
    ).filter((p): p is PreparedFile => p !== null);
    this.setStatus("$(debug-pause) sensAI", "手動模式");

    const selected = await this.pickChangedFiles(prepared, settings);
    if (!selected || selected.length === 0) {
      return;
    }
    const excluded = prepared
      .filter((p) => p.blocked.length > 0)
      .map((p) => ({ file: p.file.relPath, reason: blockedReason(p, root) }));
    // 送出之後就交給面板的取消鈕管，防重入的旗標到這裡為止。
    this.preparingChangeset = false;
    await this.runChangesetReview(selected, excluded, root, settings);
  }

  /** 讀出一個改動檔案、算好審查範圍與上下文。讀不到或其實沒改動回 null。 */
  private async prepareChangedFile(
    file: ChangedFile,
    root: string,
    settings: Settings,
    fa: CachingFileAccess,
  ): Promise<PreparedFile | null> {
    let source: string;
    try {
      source = await fs.promises.readFile(file.filePath, "utf8");
    } catch {
      this.output.appendLine(`[changes] 讀不到 ${file.relPath}，略過。`);
      return null;
    }
    // 未追蹤的檔案整份都是改動，不必再問 git。
    const ranges = file.untracked ? null : await changedRanges(file.filePath, gitCwd(file.filePath));
    if (ranges !== null && ranges.length === 0) {
      return null;
    }
    const scope = ranges === null ? null : expandToEnclosingFunction(source, ranges);
    const ctx = await buildContext(
      file.filePath,
      source,
      {
        workspaceRoot: root,
        language: file.language,
        depth: settings.includeDepth,
        budgetBytes: settings.contextBudgetBytes,
      },
      fa,
    );
    return { file, source, scope, ctx, blocked: blockedPaths(ctx, this.config, root) };
  }

  /**
   * 列出這次要送審的檔案讓使用者勾選。命中 never_send 的列在下方但不能勾。
   * 改動量大時只警告，送多少由使用者決定。取消回 undefined。
   */
  private pickChangedFiles(
    prepared: PreparedFile[],
    settings: Settings,
  ): Promise<PreparedFile[] | undefined> {
    const sendable = prepared.filter((p) => p.blocked.length === 0);
    const blocked = prepared.filter((p) => p.blocked.length > 0);
    if (sendable.length === 0) {
      void vscode.window.showWarningMessage(
        "sensAI：改動的檔案全部命中 privacy.never_send，沒有可以送出的內容。",
      );
      return Promise.resolve(undefined);
    }

    type Item = vscode.QuickPickItem & { prepared?: PreparedFile };
    const root = this.workspaceRoot ?? "";
    const items: Item[] = sendable.map((p) => ({
      label: p.file.relPath,
      description: p.file.untracked
        ? "新檔案"
        : `+${p.file.added ?? "?"} −${p.file.deleted ?? "?"}`,
      detail: `${p.scope === null ? "審查整份" : `審查第 ${describeRanges(p.scope)} 行`} · ${
        LANGUAGE_LABEL[p.file.language]
      } · ${formatBytes(p.source.length)}`,
      prepared: p,
    }));
    for (const p of blocked) {
      items.push({
        label: `🔒 ${p.file.relPath} 不會送出：${blockedReason(p, root)}`,
        kind: vscode.QuickPickItemKind.Separator,
      });
    }

    const qp = vscode.window.createQuickPick<Item>();
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true;
    qp.items = items;
    qp.selectedItems = items.filter((i) => i.prepared);
    const refresh = () => {
      const chosen = qp.selectedItems.flatMap((i) => (i.prepared ? [i.prepared] : []));
      const bytes = estimateBytes(chosen, settings.contextBudgetBytes);
      qp.title = `sensAI：審查改動（已選 ${chosen.length} 個檔案，約 ${formatBytes(bytes)}）`;
      qp.placeholder =
        changesetWarning(chosen.length, bytes) ?? "確認要送出的檔案，按 Enter 開始審查";
    };
    refresh();

    return new Promise((resolve) => {
      let done = false;
      qp.onDidChangeSelection(refresh);
      qp.onDidAccept(() => {
        done = true;
        resolve(qp.selectedItems.flatMap((i) => (i.prepared ? [i.prepared] : [])));
        qp.hide();
      });
      qp.onDidHide(() => {
        if (!done) {
          resolve(undefined);
        }
        qp.dispose();
      });
      qp.show();
    });
  }

  /** 把選好的檔案整組送審，結果依檔案分組顯示在面板上。 */
  private async runChangesetReview(
    selected: PreparedFile[],
    excluded: Array<{ file: string; reason: string }>,
    root: string,
    settings: Settings,
  ): Promise<void> {
    // 勾選期間可能被關掉或切回自動模式。
    if (currentMode() !== "manual") {
      return;
    }
    const targets: ChangesetTarget[] = selected.map((p) => ({
      filePath: p.file.filePath,
      relPath: p.file.relPath,
      source: p.source,
      language: p.file.language,
      scope: p.scope,
    }));
    const merged = mergeHeaders(
      selected.map((p) => p.ctx),
      new Set(targets.map((t) => path.resolve(t.filePath))),
      settings.contextBudgetBytes,
    );
    const cs: ChangesetContext = {
      targets,
      headers: merged.headers.map((h) => ({ path: toRel(root, h.path), text: h.text })),
      truncated: merged.truncated,
    };
    const languages = new Set(targets.map((t) => t.language));
    const rules = this.rules.filter((r) => r.languages.some((l) => languages.has(l)));
    for (const lang of languages) {
      if (!rules.some((r) => r.languages.includes(lang))) {
        this.output.appendLine(
          `[changes] 沒有適用於${LANGUAGE_LABEL[lang]}的規則，這類檔案只檢查語法。`,
        );
      }
    }

    const abort = new AbortController();
    this.inFlightAborts.set(CHANGESET_KEY, abort);
    if (this.panel.hasResult()) {
      this.panel.markUpdating(CHANGESET_KEY);
    } else {
      this.panel.setState({
        kind: "reviewing",
        filePath: CHANGESET_KEY,
        file: `審查改動（${targets.length} 個檔案）`,
      });
    }
    this.panel.reveal();
    this.setStatus("$(sync~spin) sensAI", `審查改動中（${targets.length} 個檔案）`);
    this.output.appendLine(
      `[changes] 審查改動：${targets
        .map((t) => `${t.relPath}（${t.scope === null ? "整份" : `第 ${describeRanges(t.scope)} 行`}）`)
        .join("、")}`,
    );

    const started = Date.now();
    const bytes =
      targets.reduce((n, t) => n + t.source.length, 0) +
      cs.headers.reduce((n, h) => n + h.text.length, 0);
    const writeAudit = (outcome: "ok" | "failed" | "cancelled", findings = 0, dropped = 0) => {
      appendAudit(root, this.config, {
        ts: new Date().toISOString(),
        outcome,
        file: targets.map((t) => t.relPath).join(", "),
        headers: cs.headers.length,
        bytes,
        endpoint: settings.endpoint,
        model: settings.model,
        findings,
        dropped,
        durationMs: Date.now() - started,
      });
    };

    try {
      const raw = await requestChangesetReview(cs, rules, {
        endpoint: settings.endpoint,
        model: settings.model,
        apiKey: settings.apiKey || undefined,
        signal: abort.signal,
        timeoutMs: settings.requestTimeoutMs,
        archId: this.config.assemblyArch,
        onUnknownRuleId: (id: string) => {
          this.output.appendLine(`[review] 模型回報了不存在的規則 id「${id}」，已改記為無規則。`);
        },
      });

      const { byFile, unknown } = assignFindings(raw, targets.map((t) => t.relPath));
      for (const f of unknown) {
        this.output.appendLine(
          `[filter] 濾除 (unknown-file) ${f.line} 行：${f.message}（模型回報的檔案對不上任何送審的檔案）`,
        );
      }
      // 跨檔案的意見會引用另一個檔案的識別字，evidence 要對整組內容比對。
      const corpus = [...targets.map((t) => t.source), ...cs.headers.map((h) => h.text)].join("\n");
      let kept = 0;
      let droppedCount = unknown.length;
      const files: ReviewResult[] = targets.map((t) => {
        const lines = t.source.split("\n");
        const isMuted = (f: Finding) => this.mutes?.has(muteKey(f, lines[f.line - 1] ?? "")) ?? false;
        const r = filterFindings(byFile.get(t.relPath) ?? [], t.source, isMuted, t.scope, corpus);
        for (const d of r.dropped) {
          this.output.appendLine(
            `[filter] 濾除 (${d.reason}) ${t.relPath}:${d.finding.line}：${d.finding.message}`,
          );
        }
        const { shown, collapsed } = applySeverityBudget(r.kept, settings.maxFindings);
        kept += r.kept.length;
        droppedCount += r.dropped.length;
        // 跳行、靜音、釘選都要用「審查當下」的內容算那一行。
        this.lastSource.set(t.filePath, t.source);
        return {
          filePath: t.filePath,
          displayPath: t.relPath,
          sourceLines: lines,
          findings: shown,
          collapsed,
          dropped: r.dropped,
          durationMs: Date.now() - started,
          completedAt: Date.now(),
          headersIncluded: [],
          contextTruncated: false,
        };
      });
      const stale = targets.some((t) => {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === t.filePath);
        return doc !== undefined && doc.getText() !== t.source;
      });

      this.panel.setState({
        kind: "changeset",
        result: {
          files,
          excluded,
          unassigned: unknown.length,
          durationMs: Date.now() - started,
          completedAt: Date.now(),
          headersIncluded: cs.headers.length,
          contextTruncated: cs.truncated,
          stale,
        },
      });
      writeAudit("ok", kept, droppedCount);
      this.setStatus(
        kept === 0 ? "$(check) sensAI" : `$(comment-discussion) sensAI ${kept}`,
        kept === 0 ? "審查改動：沒有發現問題" : `審查改動：${kept} 則意見`,
      );
    } catch (err) {
      writeAudit(err instanceof ReviewCancelledError ? "cancelled" : "failed");
      if (err instanceof ReviewCancelledError) {
        this.panel.setState({ kind: "idle" });
        this.setStatus("$(circle-slash) sensAI", "已取消");
        this.output.appendLine("[changes] 審查改動已取消。");
      } else if (err instanceof EndpointUnavailableError) {
        this.panel.setState({ kind: "unavailable", message: err.message });
        this.setStatus("$(circle-slash) sensAI", err.message);
        this.output.appendLine(`[changes] ${err.message}`);
      } else {
        const message = (err as Error).message ?? String(err);
        this.panel.setState({ kind: "error", message });
        this.setStatus("$(error) sensAI", message);
        this.output.appendLine(`[changes] ${message}`);
      }
    } finally {
      if (this.inFlightAborts.get(CHANGESET_KEY) === abort) {
        this.inFlightAborts.delete(CHANGESET_KEY);
      }
    }
  }

  /**
   * sensai.enabled 被關掉時呼叫。
   *
   * 只擋新的觸發不夠：關掉前已經在等的去抖動、跑到一半的請求（手動的也算）、
   * burst 欠下的完整審查，都會在關掉之後才送出去。關掉就是不要再外送，全收掉。
   */
  stopAllReviews(): void {
    this.debouncer.cancelAll();
    this.owedFullReview.clear();
    for (const abort of this.inFlightAborts.values()) {
      abort.abort();
    }
    this.output.appendLine("[review] sensAI 已關閉：不再送出任何審查。");
  }

  dispose(): void {
    this.debouncer.dispose();
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

  // 模式獨立一顆，主狀態列項目仍然是「打開面板」，兩者互不搶點擊。
  // 排在主項目右邊（priority 較低）並帶文字，連起來讀是「sensAI 自動／手動／已關閉」；
  // 只放一個圖示的話，看起來像主項目的裝飾，使用者找不到。
  const modeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  modeItem.command = "sensai.pickMode";
  // 手動模式才出現：面板沒打開時，也找得到審查改動的按鈕。
  const reviewChangesItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  reviewChangesItem.command = "sensai.reviewChanges";
  reviewChangesItem.text = "$(play) 審查改動";
  reviewChangesItem.tooltip = "sensAI：把相對 HEAD 改過的檔案整組送審";
  const renderMode = () => {
    const mode = currentMode();
    modeItem.text = MODE_LABEL[mode];
    modeItem.tooltip = {
      auto: "sensAI 自動模式：存檔就審查。點一下切換模式",
      manual: "sensAI 手動模式：存檔不審查，按 ▶ 審查改動才送出。點一下切換模式",
      off: "sensAI 已關閉：不會送出任何審查（包括手動）。點一下切換模式",
    }[mode];
    modeItem.show();
    if (mode === "manual") {
      reviewChangesItem.show();
    } else {
      reviewChangesItem.hide();
    }
  };
  renderMode();

  let controller: Controller;
  const panel = new FindingsPanel({
    onJump: (filePath, line) => void controller.jumpToFile(filePath, line),
    onMute: (finding, filePath) => void controller.muteFinding(finding, filePath),
    onPin: (finding, filePath) => controller.togglePin(finding, filePath),
    onUnpin: (key) => controller.unpin(key),
    onJumpTo: (filePath, line) => void controller.jumpToFile(filePath, line),
    onComment: (key, text) => controller.setPinComment(key, text),
    onCancel: (filePath) => controller.cancelReview(filePath),
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
    modeItem,
    reviewChangesItem,
    { dispose: () => controller.dispose() },
    vscode.window.registerWebviewViewProvider(FindingsPanel.viewId, panel),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      // 手動模式存檔不審查；那是這個模式存在的理由。
      if (currentMode() === "auto") {
        controller.reviewOnSave(doc);
      }
    }),

    // 檔案關閉就丟掉它的快取，否則 documents/lastSource 會隨開過的檔案數
    // 無限成長 —— documents 還持有 TextDocument 強參考，擋住 GC。
    vscode.workspace.onDidCloseTextDocument((doc) => {
      controller.forgetDocument(doc.uri.fsPath);
    }),

    vscode.commands.registerCommand("sensai.reviewCurrentFile", async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) {
        return;
      }
      // 關掉時不默默吞掉：使用者明確下了指令，要讓他知道為什麼沒反應。
      if (!readSettings().enabled) {
        const ENABLE = "開啟並審查";
        const pick = await vscode.window.showWarningMessage(
          "sensAI 目前已關閉，不會送出任何審查。",
          ENABLE,
        );
        if (pick !== ENABLE) {
          return;
        }
        await setEnabled(true);
      }
      panel.reveal();
      controller.reviewNow(doc);
    }),
    vscode.commands.registerCommand("sensai.showPanel", () => panel.reveal()),
    vscode.commands.registerCommand("sensai.initProject", () => controller.initProject()),
    vscode.commands.registerCommand("sensai.exportFalsePositives", () =>
      controller.exportFalsePositives(),
    ),
    vscode.commands.registerCommand("sensai.clearLocalMutes", () => controller.clearMutes()),
    vscode.commands.registerCommand("sensai.clearPins", () => controller.clearPins()),
    vscode.commands.registerCommand("sensai.cancelReview", () => controller.cancelReview()),
    vscode.commands.registerCommand("sensai.reloadRules", () =>
      controller.reloadProjectFiles(true),
    ),
    vscode.commands.registerCommand("sensai.toggle", () => setEnabled(!readSettings().enabled)),
    vscode.commands.registerCommand("sensai.enable", () => setEnabled(true)),
    vscode.commands.registerCommand("sensai.disable", () => setEnabled(false)),
    vscode.commands.registerCommand("sensai.pickMode", () => pickMode()),
    // 面板標題列的模式按鈕：三個指令各帶自己的圖示，依目前模式只顯示其中一個。
    vscode.commands.registerCommand("sensai.modeMenu.auto", () => pickMode()),
    vscode.commands.registerCommand("sensai.modeMenu.manual", () => pickMode()),
    vscode.commands.registerCommand("sensai.modeMenu.off", () => pickMode()),
    vscode.commands.registerCommand("sensai.reviewChanges", async () => {
      // 這個功能只屬於手動模式。從快捷鍵之類的地方在別的模式叫到時，問一聲再切。
      const mode = currentMode();
      if (mode !== "manual") {
        const SWITCH = "切換到手動模式並審查";
        const pick = await vscode.window.showInformationMessage(
          mode === "off"
            ? "sensAI 目前已關閉，不會送出任何審查。"
            : "「審查改動」只在手動模式下使用；自動模式會在存檔時審查。",
          SWITCH,
        );
        if (pick !== SWITCH) {
          return;
        }
        await setMode("manual");
      }
      await controller.reviewChanges();
    }),

    // 不論是從指令、狀態列還是直接改 settings.json 切換，都走這裡收尾。
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        !event.affectsConfiguration("sensai.enabled") &&
        !event.affectsConfiguration("sensai.mode")
      ) {
        return;
      }
      renderMode();
      const mode = currentMode();
      if (mode === "off") {
        controller.stopAllReviews();
      } else if (mode === "manual") {
        controller.stopSaveReviews();
      }
    }),
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
