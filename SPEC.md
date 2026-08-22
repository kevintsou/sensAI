# sensAI

VS Code 的 AI 程式碼糾錯工具，針對 ARM / Andes AndeStar V5 韌體開發。
在你打字的當下檢查 `.c` 與 `.s` 的語法與語意問題。

判斷者是 AI。組譯器與編譯器只負責語法，並作為 AI 的輸入之一。

---

## 1. 運作流程

```
打字停頓 0.7s
  ├─ as / gcc -fsyntax-only  →  語法錯誤（~100ms，直接畫線）
  └─ AI 快掃                 →  改動的幾行 + 所在函式 + 上面的語法錯誤
                                 串流回傳，第一個問題出來就畫線

存檔
  └─ AI 深掃                 →  整個函式或檔案，走能力較好的路由
                                 產出的修補先套用並組譯一次，通過才顯示為 Quick Fix
```

先跑語法有兩個用處：語法錯誤本來就該由組譯器回答（100% 準確、100ms 內），
而且把語法錯誤一起餵給 AI，可以避免它對著一段還沒打完的程式碼亂猜語意，
也不會重複回報編譯器已經抓到的東西。

**未改動的區塊沿用上次結果**，不重複送。這是控制延遲與成本的主要手段。

---

## 2. AI 收到什麼

每次請求送出的內容，按優先序：

1. 改動的 hunk 及其所在函式的完整內容
2. 該檔案的語法檢查結果（若有）
3. **命中的規則**（見 §4，經過路徑與關鍵字過濾）
4. 架構事實 —— 目標架構的暫存器清單、ABI 表、呼叫慣例（內建，見 §4.4）
5. 相鄰函式的簽章

快掃與深掃使用不同的 context 預算：快掃從嚴，只送真的踩得到的；
深掃可以放寬。

---

## 3. 誤報防線

AI 作為主判斷者，誤報是唯一會殺死這個工具的東西。
波浪線畫錯兩三次，使用者就會全部無視。

### 3.1 強制具體理由

回報結果透過 tool use 取得，schema 強制每個 finding 填滿：

| 欄位 | 內容 |
|---|---|
| `line` | 哪一行 |
| `trigger_condition` | 什麼情況下會出事 —— 要具體，例：「當 ISR 在 40〜42 行之間觸發」 |
| `consequence` | 會造成什麼 —— 例：「讀到舊值」「堆疊回到錯誤位置」 |
| `evidence` | 引用程式碼中實際存在的行號或識別字 |

主要效果不在事後過濾，而在**改變模型的行為**：被要求說明具體失效情境時，
講不出來的意見就不會被提出來，那些「這裡可能要注意一下」會自己消失。

事後再過濾一次：`evidence` 引用不到真實存在的識別字、或 `trigger_condition`
沒有具體條件的，直接丟棄。

這四個欄位同時就是 hover 要顯示的內容。使用者看到
「當 ISR 在 40〜42 行之間觸發時會讀到舊值」，一秒就能自行判斷是不是誤報 ——
比只寫「缺 volatile」有用得多。

### 3.2 使用者只有本機靜音權

規則庫由開發者透過版本控管維護（§4）。使用者不修改規則，但需要能立即止血：

| | 誰能改 | 進版控 | 是否影響 AI |
|---|---|---|---|
| 規則庫 | 開發者，走 PR | ✅ | 送進 context |
| 本機靜音 | 使用者 | ❌（`.gitignore`） | 否，純粹不顯示 |
| 誤報回報 | 使用者 | ❌ | 否，可匯出給開發者 |

使用者標記一次誤報會做兩件事：本機立刻閉嘴（不必等發版），
同時留下一筆可匯出的記錄。開發者定期收集這些記錄，決定是否調整規則 ——
但決定權在版控那一側。

---

## 4. 規則庫

### 4.1 自然語言規則

判斷者是 AI，所以規則直接用自然語言寫，不需要 AST matcher 或 DSL。
資深工程師花幾分鐘就能加一條。

```yaml
# .sensai/rules/dma.yaml
- id: dma-cache-maintenance
  schema: 1
  applies_to: ["src/dma/**", "**/*_dma.c"]
  triggers: ["DMA_", "dma_start"]      # 程式碼出現這些關鍵字才注入
  severity: error
  rule: |
    本專案 SoC 的 D-cache 是 write-back。DMA buffer 在啟動 DMA 前必須先
    clean（寫方向），或在讀取結果前 invalidate（讀方向）。
    要呼叫 dma_cache_clean() / dma_cache_invalidate()，
    不要只下 __DSB()，那不夠。
  examples:
    bad: |
      memcpy(tx_buf, data, len);
      dma_start(DMA_CH0, tx_buf, len);
    good: |
      memcpy(tx_buf, data, len);
      dma_cache_clean(tx_buf, len);
      dma_start(DMA_CH0, tx_buf, len);
```

`examples` 不要省略。一組正反範例對 LLM 準確度的提升，
遠大於把 `rule` 文字寫得更長。

### 4.2 規則也要能表達「不要報什麼」

團隊層級的例外必須有地方放，否則會被迫塞進使用者端：

```yaml
- id: volatile-shared-state
  schema: 1
  severity: warning
  rule: |
    被 ISR 與主程式同時存取的變數必須標 volatile。
  except: |
    命名以 _isr 結尾的變數是 ISR 專用副本，不算共享，不要報。
    ring buffer 的 head/tail 各有單一 owner，也不算（見 docs/ringbuf.md）。
```

「該報什麼」與「不該報什麼」都在同一份受控文件裡，責任歸屬清楚。

### 4.3 規則的挑選與載入

規則庫長到數十上百條後，全部送出會撐爆 context 也拖慢快掃。
用 `applies_to`（路徑 glob）與 `triggers`（關鍵字）過濾，
只送這段程式碼真的踩得到的規則。字串比對即可，不需要向量檢索。

規則存放於專案 repo 的 `.sensai/rules/`，隨 `git pull` 生效。
LSP server 啟動時載入，並 watch 檔案變更做熱重載。無須任何散布機制。

### 4.4 事實與規則分離

架構通用的內容 —— ARM AAPCS 的 caller/callee-saved 清單、RISC-V 呼叫慣例、
暫存器別名、指令集 —— 每個專案都一樣，內建於 extension 中作為
**架構事實**自動注入 AI context。

**規則**（判斷什麼是問題）一律走專案 repo，由開發者控制。
事實不是規則，不影響治理邊界，但避免每個專案重寫一次 ABI 表。

### 4.5 規則的來源

手寫規則需要人有意識地坐下來寫，實務上難以持續。主要來源應該是：

- **從剛修完的 bug 長出來** —— 提供一個動作：把修正的 diff 交給 AI 產生規則草稿，
  開發者修改後提 PR。這樣長出來的規則都是團隊真的踩過的坑。
- **從誤報回報長出來** —— 累積的回報記錄顯示某類判斷經常被否決時，
  提示開發者考慮補一條 `except`。

### 4.6 CI 上的 dry-run

規則走 PR，所以品質檢查也放在 PR 上。新增或修改規則時，
CI 在現有 codebase 跑一次，回報這條規則會產生多少 finding：

- 命中 2 處 → 合理
- 命中 300 處 → 規則寫太寬，或專案本來就這樣寫；需要在 review 中處理

這同時能抓到「改了一條舊規則，結果別處爆掉」。

---

## 5. 模型後端

透過 Claude Code Router，使用官方 SDK：

```ts
const client = new Anthropic({
  baseURL: config.llm.endpoint,   // 預設 http://127.0.0.1:3456
  apiKey: "ccr",                  // CCR 不驗證，但 SDK 要求非空
});
```

CCR 會路由到不同 provider，因此有四個限制：

1. **不用 structured outputs** —— `output_config.format` 經過 CCR 的 transformer
   不保證轉得過去。改用 **tool use** 取得結構化 finding，相容性遠高。
2. **不依賴 prompt caching** —— 非 Anthropic 後端沒有這個機制。
   成本控制靠「只送必要內容 + 未改動區塊沿用結果」。
3. **CCR 未啟動時優雅降級** —— 語法檢查照常，AI 層靜默停用，
   僅狀態列顯示，不跳錯誤視窗。
4. **模型能力不一** —— 深掃產出的修補必須先組譯驗證才顯示，這不是加分項。

CCR 的 `model` 欄位是路由 key，快掃與深掃分流：

```yaml
llm:
  model_quick: background        # 快掃 —— 便宜快速
  model_deep:  claude-opus-5     # 深掃
```

---

## 6. 隱私

韌體原始碼通常受 NDA 保護，外送控制是必要功能。

```yaml
privacy:
  mode: opt-in                   # opt-in | opt-out | disabled
  never_send:
    - "src/secure/**"
    - "**/crypto/**"
  audit_log: .sensai/sent.log
```

- `mode: disabled` 時完全不連外，只剩語法檢查
- `never_send` 匹配的檔案完全跳過 AI 層，並在狀態列標示
- 每次外送寫入稽核日誌

---

## 7. 編輯器整合

實作為 LSP server + 薄的 VS Code client。韌體團隊的編輯器分佈很散
（VS Code、Vim、AndeSight、Keil），核心邏輯走 LSP 可跨編輯器重用。

| 來源 | `source` | 預設 severity |
|---|---|---|
| 組譯器 / 編譯器 | `sensai` | Error |
| AI | `sensai-ai` | 依規則的 `severity` |

AI 的診斷使用不同的 `source` 字串，讓使用者能在編輯器設定中單獨過濾掉
AI 的意見，而保留語法錯誤。

| LSP 能力 | 用途 |
|---|---|
| `publishDiagnostics` | 主要輸出通道 |
| `codeAction` | Quick Fix（僅顯示通過組譯驗證的修補）、標記誤報 |
| `hover` | 顯示 `trigger_condition` / `consequence` |
| `executeCommand` | 手動觸發深掃、匯出誤報回報 |

---

## 8. 待決

- [ ] `.c` 的語法檢查需要 include path 與 defines，但專案使用 AndeSight / Keil
      等封閉 build system，沒有 `compile_commands.json`。
      需決定 flags 來源：解析 `.cproject` / `.uvprojx` XML，或手動設定。
      （`.s` 只需要 `as` 與 `-march`，不受此影響）
- [ ] `.S`（經過前處理器）的巨集展開如何處理
- [ ] 快掃的 context 預算上限，需要實測延遲後決定
- [ ] 多專案共用同一顆 SoC 時，規則的重複問題
