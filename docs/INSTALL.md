# sensAI 安裝指南

適用版本：**0.2.2**　·　最後驗證：2026-08-23

這份文件同時寫給人與 agent 看。每個步驟都有明確的指令與**可驗證的預期結果**，
不依賴截圖或畫面描述。給 agent 的執行摘要在 [附錄 A](#附錄-a給-agent-的執行摘要)。

- 只想快點裝起來用 → [路線 A：使用者安裝](#路線-a使用者安裝marketplace)
- 要改 sensAI 本身 → [路線 B：開發者安裝](#路線-b開發者安裝從原始碼)
- 想先確認裝好了沒 → [第 5 節：驗證](#5-驗證安裝)

---

## 1. 這個東西在做什麼（先讀，會影響你怎麼裝）

sensAI 是 VS Code 擴充，存檔時把「目前檔案 + 解析到的專案 header + 團隊規則」
送到**你自己指定的 endpoint**，把有依據的意見顯示在側欄。

存檔觸發的條件是**存檔且該檔案相對 git HEAD 有改動**，兩者缺一都不會送出任何內容；
詳見 [第 5.4 節](#54-什麼時候才會觸發審查)。

因此安裝分成三個獨立的部分，缺一不可：

| # | 元件 | 沒有它會怎樣 |
|---|---|---|
| 1 | **擴充本體** | 沒有 sensAI 指令與側欄 |
| 2 | **一個 endpoint** | 審查一律失敗（`連不上 Claude Code Router`） |
| 3 | **專案的 `.sensai/rules.yaml`** | 能跑，但退化成只檢查語法與型別錯誤 |

> **外送提醒**：sensAI 會把受審檔案與它引用到的專案 header 送往你設定的 endpoint。
> 在機密韌體專案啟用前，**先**設定 `privacy.never_send`（[第 4.2 節](#42-專案設定與隱私必讀)）。

---

## 2. 前置需求

| 需求 | 版本 | 檢查指令 | 給誰 |
|---|---|---|---|
| VS Code | ≥ 1.85.0 | `code --version` | 全部 |
| Node.js | ≥ 18（開發用 22 較保險） | `node -v` | 路線 B、CLI、CCR |
| npm | 隨 Node | `npm -v` | 路線 B、CLI、CCR |
| git | 任意 | `git --version` | 路線 B、`--staged` |

`engines.vscode` 是 `^1.85.0`；低於 1.85 的 VS Code 會直接拒絕安裝。

> **macOS 使用者注意**：`code` 這個 CLI 預設不在 PATH 裡。若 `code --version`
> 顯示 `command not found`，在 VS Code 裡執行 Command Palette →
> **Shell Command: Install 'code' command in PATH**，或改用 GUI 的 Extensions
> 面板完成安裝步驟。本文所有 `code …` 指令都有對應的 GUI 操作。

---

## 路線 A：使用者安裝（Marketplace）

要用 sensAI 審自己的韌體專案、不改擴充原始碼，走這條。

### A1. 安裝擴充

```bash
code --install-extension sensai.sensai
```

或在 VS Code 的 Extensions 面板搜尋 `sensAI`（發行者 `sensai`）。

**驗證**：

```bash
code --list-extensions --show-versions | grep sensai
```

預期輸出 `sensai.sensai@0.2.2`（或更新的版本）。

### A2. 接著做

跳到 [第 4 節：設定](#4-設定)。

---

## 路線 B：開發者安裝（從原始碼）

要修改擴充、跑測試、或自己打包 vsix，走這條。

### B1. 取得與建置

```bash
git clone https://github.com/kevintsou/sensAI.git
cd sensAI
npm install
```

**驗證**（兩個都必須通過）：

```bash
npm run typecheck && npm test
```

預期：typecheck 無輸出且 exit 0；測試印出 `pass 48` / `fail 0`
（版本推進後數字會變，重點是 **fail 0**）。

### B2. 在 Extension Development Host 裡跑

```bash
npm run watch
```

保持這個視窗開著，在 VS Code 裡按 **F5**。會開一個新的 VS Code 視窗，
sensAI 以原始碼形式載入其中。改完程式碼在該視窗按 `Ctrl/Cmd+R` 重載。

### B3.（選用）打包成 vsix 自行散布

```bash
npm run package
```

產出 `sensai.vsix`。安裝：

```bash
code --install-extension sensai.vsix
```

### B4. 接著做

繼續 [第 4 節：設定](#4-設定)。開發時另有一條不需要任何 API key 的
驗證路徑，見 [第 5.1 節](#51-用-mock-router-驗證零成本)。

---

## 3. 準備 endpoint（三選一）

sensAI 內部用 `@anthropic-ai/sdk`，把 `sensai.endpoint` 當作 SDK 的 `baseURL`。
**任何 endpoint 都必須相容 Anthropic Messages API，而且背後的模型必須支援 tool use**
（sensAI 靠 `report_findings` 這個 tool 取回結果）。不支援的話會看到：

> 模型沒有回傳 report_findings 工具呼叫（stop_reason: end_turn）。

### 選項 1：Claude Code Router（預設假設）

```bash
npm install -g @musistudio/claude-code-router
ccr start
ccr status
```

CCR 預設聽 `http://127.0.0.1:3456`，與 sensAI 的預設值一致，
所以這條路線通常**不用改 `sensai.endpoint`**。`sensai.model` 填 CCR 的路由 key。

### 選項 2：直接打 Anthropic API

不裝 CCR 也可以。設定：

```json
{
  "sensai.endpoint": "https://api.anthropic.com",
  "sensai.model": "claude-opus-5"
}
```

並提供 `ANTHROPIC_API_KEY` 環境變數 —— sensAI 沒有存放 API key 的設定項，
只讀環境變數（找不到時退回佔位字串 `ccr`，這在 CCR 情境下是刻意的）。

> **注意**：擴充讀的是 **VS Code 行程本身**的環境變數。在 shell 裡 `export` 之後，
> 必須**從同一個 shell** 啟動 VS Code（`code .`）才吃得到；從 Dock/開始選單點開的
> VS Code 看不到那個變數。macOS/Linux 可改用 `launchctl setenv` 或
> `~/.zshenv`；Windows 用系統環境變數，設完要重開 VS Code。

### 選項 3：mock router（只驗管線，不驗品質）

不需要 API key，適合驗證「裝對了沒」與開發時調 prompt：

```bash
npm run mock
```

意見是從 prompt 裡湊出來的假資料，**不能用來評估審查品質**。細節見
[第 5.1 節](#51-用-mock-router-驗證零成本)。僅路線 B（有原始碼）可用。

---

## 4. 設定

### 4.1 每台機器的設定（VS Code settings）

Endpoint、model、逾時這類**每台機器不同**的設定放 VS Code 使用者設定
（`Ctrl/Cmd+,` → 右上角開啟 JSON），**不要**放進 `.sensai/config.yaml`：

```json
{
  "sensai.endpoint": "http://127.0.0.1:3456",
  "sensai.model": "claude-opus-5"
}
```

完整設定項：

| 設定 | 型別 | 預設 | 用途 |
|---|---|---:|---|
| `sensai.enabled` | boolean | `true` | 存檔時自動審查 |
| `sensai.endpoint` | string | `http://127.0.0.1:3456` | endpoint 位址（SDK baseURL） |
| `sensai.model` | string | `claude-opus-5` | 送出的 model 欄位／路由 key |
| `sensai.rulesPath` | string | `""` | 指定規則檔；相對路徑以 workspace 根目錄為基準 |
| `sensai.includeDepth` | number | `2` | 專案 header 遞迴解析深度 |
| `sensai.contextBudgetBytes` | number | `120000` | header 上下文位元組上限 |
| `sensai.requestTimeoutMs` | number | `120000` | 單次審查逾時（毫秒） |
| `sensai.maxFindings` | number | `8` | 意見數量上限；超過時收合低嚴重度，`error` 不收 |

### 4.2 專案設定與隱私（必讀）

在**韌體專案**（不是 sensAI repo）裡開啟資料夾，從 Command Palette
（`Ctrl/Cmd+Shift+P`）執行：

```
sensAI: Initialize Project
```

會建立：

```
.sensai/
├── rules.yaml     # 團隊規則（進版控）— 若已設 sensai.rulesPath 則不建立
├── config.yaml    # 隱私政策與組語架構（進版控）
└── .gitignore     # 排除稽核記錄與本機靜音清單
```

如果 `.sensai/` 底下已有同名檔案，指令會跳出對話框讓你選
「只建立缺少的」或「全部覆蓋」，不會無聲蓋掉你的規則。

編輯 `.sensai/config.yaml`：

```yaml
privacy:
  never_send:
    - "src/secure/**"
    - "**/crypto/**"
  audit_log: .sensai/sent.log

assembly:
  arch: riscv32-andes-v5   # 或 armv7e-m
```

關鍵行為，安裝前務必理解：

- **受審檔案或它引用到的任何 header 命中 `never_send`，整次審查直接跳過**，
  不會「遮蔽一部分再送出去」—— 局部原始碼一樣會洩漏結構。
- `audit_log` 每次外送寫一筆 JSONL，供資安稽核追查。
- `assembly.arch` 決定組語審查注入哪一組 ABI 事實（暫存器用途、呼叫慣例、對齊要求）。
  這類架構事實**不需要**寫進 rules.yaml，擴充會自動注入。

把 `.sensai/rules.yaml` 與 `.sensai/config.yaml` 提交進版控，
再把範例規則換成團隊真正的規則。格式見 [規則撰寫指南](rules.md)。

### 4.3（選用）共用規則庫

多個專案共用一份規則時，在各專案設定：

```json
{ "sensai.rulesPath": "../firmware-review-rules/andestar-v5.yaml" }
```

只改變規則來源。`.sensai/config.yaml` 仍留在各專案，因為隱私排除與稽核設定是專案專屬的。

---

## 5. 驗證安裝

### 5.1 用 mock router 驗證（零成本）

只適用路線 B。開兩個終端機：

```bash
npm run mock
```

```bash
npm run review -- examples/uart_dma.c
```

**預期結果**（實測於 0.2.2）：

- 標頭顯示 `examples/uart_dma.c · C · … · 9 條規則 · 附帶 1 個 include`
- 3 則標著 `[假的]` 的意見，嚴重度分別是 ERROR / WARNING / INFO
- 結尾出現 `--- 濾除 2 則 ---`，理由為 `line-out-of-range` 與 `evidence-not-found`

**最後那兩則被濾除的紀錄是最重要的訊號**：它證明過濾層真的在擋掉行號超出範圍
與捏造識別字的意見。只看到意見、沒看到濾除紀錄，代表過濾層沒有正常運作。

組語路徑另外驗一次（走不同的 prompt，並注入 ABI 事實）：

```bash
npm run review -- examples/uart_dma.s
```

失敗情境也可以刻意重現：

```bash
npm run mock -- --mode no-tool   # 模型不支援 tool use
npm run mock -- --mode empty     # 沒有發現問題
npm run mock -- --mode error     # 路由回 500
npm run mock -- --mode slow      # 拖 30 秒，驗逾時處理
```

驗證完記得關掉 mock；它**不會**回報真實問題。

### 5.2 驗證擴充本身

1. 開啟一個有 `.sensai/rules.yaml` 的韌體專案。
2. 打開任一 `.c` 檔案。
3. Command Palette → **sensAI: Review Current File**。
4. 側欄應出現 sensAI 面板；**View → Output → 選 `sensAI` 頻道**可看到狀態、
   被濾除的意見與錯誤訊息。

存檔自動審查要 `sensai.enabled` 為 `true`（預設）。

### 5.4 什麼時候才會觸發審查

存檔會觸發審查的條件是**存檔 + 該檔案相對 git HEAD 有改動**。

| 情境 | 存檔時 | `sensAI: Review Current File` |
|---|---|---|
| 相對 HEAD 有改動 | 兩階段（改動處 + 整份，去重後合併） | 兩階段 |
| 相對 HEAD 沒有改動 | **不審，不外送任何內容** | 單階段，審整份 |
| 未追蹤／不在 git repo（無法判定） | 單階段，審整份 | 單階段，審整份 |

三件要記住的事：

1. **沒有改動的存檔不會觸發。** 改完又改回來、格式化工具沒動到東西、慣性按 `Ctrl+S`
   都屬於這類。此時側欄**維持原狀**（上一次的意見對這份沒變過的檔案仍然成立），
   Output → sensAI 會留一行記錄，狀態列顯示「沒有改動，未審查」。
2. **「無法判定」不等於「沒有改動」。** 未追蹤的檔案或非 git 專案照樣會完整審查，
   否則 sensAI 在這些專案裡會變成完全不動。
3. **手動觸發不受此限。** 剛 commit 完想重看一次整份檔案，用
   `sensAI: Review Current File`。

驗證方式（在一個 git 專案裡）：

```bash
git stash        # 或 git checkout -- <檔案>，把檔案還原成與 HEAD 相同
```

接著在 VS Code 存檔該檔案，Output → sensAI 應出現：

```
[review] <檔名> 相對 HEAD 沒有改動，存檔不觸發審查。要重看整份檔案請用 sensAI: Review Current File。
```

CLI 對應的是 `--staged`：沒有改動時會印「相對 HEAD 沒有改動 —— 退回單階段」，
因為 CLI 屬於明確的手動觸發。

### 5.5 頻繁存檔時的行為

同一個檔案同時只會有一輪審查。這輪還在跑時進來的存檔**併成一次補跑**，用當下最新的
內容：

| 時間 | 事件 | 行為 |
|---|---|---|
| T+0s | 存檔 v1 | 開始審查 |
| T+2s | 存檔 v2 | 併入待補跑（Output 留記錄） |
| T+4s | 存檔 v3 | 併入同一次補跑，不是再排一次 |
| T+8s | v1 結果回來 | 顯示，接著自動用 v3 補跑一次 |

三個保證：

1. **請求數不隨存檔次數線性增加。** 存 10 次不會變成 10 輪審查。
2. **最後一次存檔的內容一定會被審到。** 中途的觸發不會被丟棄。
3. **同一個檔案不會有兩輪並行。** 補跑期間進來的觸發同樣會被併入。

若審查期間檔案又被改過，結果仍會顯示，但側欄會標示「審查期間檔案又被改過，行號是
對著送出當下那一版算的，跳行可能會偏」。不同檔案彼此不互相阻擋。

Output → sensAI 可以看到這些決策：

```
[review] uart.c 還在審查中，這次觸發併入下一輪。
[review] 用最新內容補跑 uart.c。
```

### 5.3 CLI 的 exit code（要串 CI 的話讀這段）

實測於 0.2.2：

| 情境 | exit code |
|---|---:|
| 連不上 endpoint | `2` |
| 參數錯誤／找不到檔案 | `1` |
| **正常完成，不論有沒有意見** | `0` |

也就是說 **exit code 只能區分「跑不跑得起來」，不能當作「有沒有問題」的判斷**。
要用審查結果 gate CI，必須走 `--json` 自行解析 severity：

```bash
npm run review -- path/to/file.c --json
```

---

## 6. 常用指令一覽

| 指令（Command Palette） | 用途 |
|---|---|
| `sensAI: Review Current File` | 手動觸發審查 |
| `sensAI: Show Findings` | 開啟意見側欄 |
| `sensAI: Initialize Project` | 建立 `.sensai/` 骨架 |
| `sensAI: Reload Rules` | 重新載入規則（改完 rules.yaml 通常會自動重載） |
| `sensAI: Export False Positive Report` | 匯出本機誤報記錄 |
| `sensAI: Clear Local Mutes` | 清除本機靜音 |

CLI（路線 B）：

```bash
npm run review -- <檔案> [--endpoint URL] [--model NAME] [--arch ID]
                        [--root DIR] [--staged] [--show-prompt] [--json]
```

`--show-prompt` 印出實際送出的 system + user prompt 就結束，**不呼叫 endpoint**，
調規則時最有用。`--staged` 走與擴充相同的兩階段流程（先只看改動處、再看整份、
最後去重），是唯一驗得到去重與範圍限制的方式。
`SENSAI_ENDPOINT` 與 `SENSAI_MODEL` 環境變數可取代對應參數。

---

## 7. 疑難排解

| 症狀（實際訊息） | 原因 | 處理 |
|---|---|---|
| `連不上 Claude Code Router (…)：Connection error.` | endpoint 沒起來或位址錯 | `ccr status`；確認 `sensai.endpoint` 與實際 port 一致 |
| `模型沒有回傳 report_findings 工具呼叫（stop_reason: end_turn）` | 該路由背後的模型不支援 tool use | 換一個支援 tool use 的模型／路由 key |
| 回 `500` 或其他 HTTP 錯誤 | endpoint 自身的錯誤 | 看 endpoint 的日誌；訊息會原樣印出 |
| 意見很泛泛，都是通用建議 | 沒有載入規則 | 確認 `.sensai/rules.yaml` 存在；跑 `sensAI: Reload Rules`；看 Output → sensAI |
| 完全沒有反應，也沒有錯誤 | 檔案命中 `never_send`，整次跳過 | 檢查 `.sensai/config.yaml` 的 glob |
| 存檔沒有反應，狀態列顯示「沒有改動，未審查」 | **正常行為**：檔案相對 HEAD 沒有改動 | 要重看整份請用 `sensAI: Review Current File`，見 [第 5.4 節](#54-什麼時候才會觸發審查) |
| 存了很多次，只跑了一兩輪審查 | **正常行為**：審查中的存檔會併成一次補跑 | 見 [第 5.5 節](#55-頻繁存檔時的行為) |
| 側欄標示「審查期間檔案又被改過」 | 送出後檔案還在改，行號是對著送出當下那版算的 | 意見仍可參考；要對齊目前內容重跑一次即可 |
| `.sensai/config.yaml 解析失敗: …` | YAML 語法錯 | 依訊息修正縮排／引號 |
| 多根工作區只審到部分專案 | **已知限制：只讀第一個 workspace folder** | 單獨開該資料夾 |
| 直連 Anthropic 卻說沒有金鑰 | VS Code 沒吃到 `ANTHROPIC_API_KEY` | 從已 export 的 shell 執行 `code .`，見 [第 3 節選項 2](#選項-2直接打-anthropic-api) |
| 審查逾時 | 檔案大或模型慢 | 調高 `sensai.requestTimeoutMs`；或降 `sensai.includeDepth` / `sensai.contextBudgetBytes` |

其他已知限制：

- `.S` 的巨集不會展開；上下文不足時模型應保守不報。
- sensAI 只提供 review 意見，**不會產生或套用修補程式**。

---

## 8. 解除安裝

```bash
code --uninstall-extension sensai.sensai
```

`.sensai/` 屬於專案資產，不會被移除。要一併清掉再自行刪除該目錄；
若曾啟用 `audit_log`，記得處理 `.sensai/sent.log`。

---

## 附錄 A：給 agent 的執行摘要

非互動環境可直接執行的最小驗證路徑（對應路線 B）。每步都有可判定的成功條件。

```bash
# 1. 取得與安裝
git clone https://github.com/kevintsou/sensAI.git && cd sensAI
npm install                       # 成功條件：exit 0

# 2. 靜態檢查與測試
npm run typecheck                 # 成功條件：exit 0，無輸出
npm test                          # 成功條件：輸出含 "fail 0"

# 3. 啟動 mock endpoint（背景執行，勿用前景阻塞）
npm run mock &                    # 成功條件：輸出含 "假 router 已啟動"

# 4. 驗證 C 與組語兩條管線
npm run review -- examples/uart_dma.c
npm run review -- examples/uart_dma.s
# 成功條件（兩者皆須滿足，皆可直接字串比對）：
#   a. 輸出含 "3 則意見"          → 管線走完，模型回了 tool_use
#   b. 輸出含 "濾除 2 則"，且含 line-out-of-range 與 evidence-not-found
#   b 缺席即為失敗：代表過濾層沒有生效。
#   注意 [假的] 字樣會出現 11 次（每則意見佔多行），不要拿它當計數依據。

# 5. 收尾
pkill -f mock-router.mjs          # SIGTERM 導致 exit 143 屬正常
```

agent 需要知道的不變量：

- **不要用 mock 的輸出評估審查品質。** 它是從 prompt 裡挑識別字湊出來的，
  兩則被濾除的意見是刻意植入的測試訊號。
- **exit code 0 不代表沒有問題**，只代表跑完了（見 [第 5.3 節](#53-cli-的-exit-code要串-ci-的話讀這段)）。
  要判斷審查結果請用 `--json`。
- **不要把 endpoint / model / API key 寫進 `.sensai/config.yaml`。**
  那是進版控的專案檔；每台機器的設定走 VS Code settings 與環境變數。
- **`.sensai/rules.yaml` 是專案資產。** 不要用範例規則覆蓋既有規則；
  `sensAI: Initialize Project` 遇到既有檔案會停下來問，非互動情境請自行檢查
  `.sensai/` 是否已存在。
- **架構事實（暫存器用途、呼叫慣例、對齊）不要寫進 rules.yaml**，
  由 `assembly.arch` 決定並自動注入。
- **存檔不必然觸發審查。** 觸發條件是「存檔且相對 git HEAD 有改動」；沒有改動的存檔
  完全不外送。要無條件審查請用 `sensAI: Review Current File` 或 CLI。
- **啟用前先確認 `privacy.never_send`。** 審查會把原始碼與 header 送往外部 endpoint。

## 延伸閱讀

- [規則撰寫指南](rules.md)
- [隱私與專案設定](privacy.md)
- [設計理念](../SPEC.md)
- [開發與發行流程](../CONTRIBUTING.md)
