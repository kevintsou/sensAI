# sensAI

VS Code 擴充。存檔 `.c` 或 `.s` 時用 AI 做一次單檔 code review，針對 ARM / Andes AndeStar V5 韌體開發。

設計理由與取捨記在 [SPEC.md](./SPEC.md)。

差異化不在 AI，在 `.sensai/rules.yaml` —— 那裡放的是這個專案的硬體特性與團隊慣例，
是通用工具永遠不會知道的東西。**沒有規則的話，這只是一個比較差的 Copilot。**

---

## 在本機跑起來

需要 Node 18 以上，以及 [Claude Code Router](https://github.com/musistudio/claude-code-router)。

```bash
git clone -b claude/vscode-ai-assistant-design-8tmteq \
    https://github.com/kevintsou/sensAI.git
cd sensAI
npm install

# 確認 CCR 有在跑
ccr status || ccr start
curl -s http://127.0.0.1:3456/v1/messages -o /dev/null -w '%{http_code}\n'

# 第一次審查
npm run review -- examples/uart_dma.c
```

`npm run review` 會先編譯再執行，不用另外 build。

---

## 沒有 CCR 的話

兩個替代方案。

### 一、假的 router（不需要任何金鑰）

```bash
npm run mock          # 另開一個終端機，預設就聽 3456
npm run review -- examples/uart_dma.c
```

它是 CCR 的替身，不用改任何設定。**但它不會真的審查程式碼** ——
意見是從送進去的 prompt 裡挑幾行湊出來的，訊息都標了「[假的]」。

用途是驗**管線**：include 有沒有被帶進去、行號對不對得上、
過濾層有沒有在做事、規則有沒有依語言篩選。它還會故意塞兩則壞意見
（行號超出範圍、捏造的識別字），讓你看得到過濾層在工作。

順便可以驗失敗路徑：

```bash
npm run mock -- --mode no-tool   # 路由的模型不支援 tool use
npm run mock -- --mode empty     # 沒有發現問題
npm run mock -- --mode error     # 路由回 500
npm run mock -- --mode slow      # 拖 30 秒，驗逾時
```

把假 router 關掉再跑一次，就能驗「CCR 沒開時優雅降級」——
CLI 會提示去確認 CCR，擴充則是狀態列顯示 `$(circle-slash) sensAI`，不跳視窗。

### 二、直接打 Anthropic API（需要 API key）

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run review -- examples/uart_dma.c --endpoint https://api.anthropic.com
```

`ANTHROPIC_API_KEY` 有設的話會取代預設的佔位字串。這條路會真的呼叫模型，
所以**意見的品質是真的**，可以用來驗規則寫得好不好 —— 只是繞過了 CCR 的路由與成本控管。

擴充也吃同一個環境變數，但要讓 VS Code 看得到 —— macOS/Linux 從終端機用
`code .` 啟動，或寫進 shell 的 profile 再重開。

---

## 怎麼驗證

有兩條路。**調規則跟 prompt 請走命令列**，快很多；VS Code 那條是最後確認整合。

### 一、命令列（調規則用這個）

```bash
npm run review -- examples/uart_dma.c
npm run review -- examples/uart_dma.s
```

跑的是跟擴充完全相同的流程 —— 同一個 context builder、同一組 prompt、
同一個 tool schema、同一層過濾。改完 `rules.yaml` 直接重跑，不用重開編輯器。

```bash
# 不呼叫 CCR，只看實際送出去的 prompt 長什麼樣
npm run review -- examples/uart_dma.s --show-prompt

# 換路由（便宜的模型先粗調，好模型再確認）
npm run review -- examples/uart_dma.c --model background

# 換架構
npm run review -- boot.s --arch armv7e-m

# 串接用
npm run review -- src/uart.c --json | jq '.kept[].rule_id'
```

### 審查你們自己的專案

CLI 會從受審檔案往上找含 `.sensai/` 的目錄當專案根目錄，
所以可以站在 sensAI 這個 repo 裡去審別的專案的檔案：

```bash
# 在你們的韌體專案裡放一份規則
mkdir -p ~/fw/.sensai
cp .sensai/rules.yaml .sensai/config.yaml ~/fw/.sensai/
$EDITOR ~/fw/.sensai/rules.yaml        # 換成你們真正的規則

# 從 sensAI repo 裡審那邊的檔案
npm run review -- ~/fw/src/uart.c
# → root 會顯示 /home/you/fw，規則與 include 解析都用那邊的

# 自動偵測不準時手動指定
npm run review -- ~/fw/src/uart.c --root ~/fw
```

輸出開頭那行會印出 `root`、載入幾條規則、附帶幾個 include ——
**先確認這三個數字合理再看意見內容**。規則 0 條或 include 0 個的話，
後面的結果沒有參考價值。

`examples/` 下的兩個檔案各自埋了錯誤，也放了誘餌：

| 檔案 | 埋的錯誤 | 誘餌（不該被報） |
|---|---|---|
| `uart_dma.c` | 6 個：W1C 誤用、缺 volatile、DMA 沒 clean cache、ISR 裡 malloc、RMW 沒關中斷、空迴圈延遲 | 3 段 |
| `uart_dma.s` | 7 個：缺 fence、W1C 誤用、callee-saved 沒存、堆疊沒對齊、`ra` 沒保存、堆疊不平衡、ABI 不符 | 3 段 |

期待結果寫在各檔案末尾，逐條對：

| 結果 | 代表什麼 | 怎麼修 |
|---|---|---|
| 都抓到、誘餌都沒報 | 方向對了 | 換成你們真的踩過坑的檔案再跑一次 |
| 漏抓 | 規則講得不夠具體 | 調 `rule` 措辭，或補 `examples` 的正反範例 |
| 誤報誘餌 | 規則涵蓋太寬 | 給那條規則補 `except` |
| 意見很空泛 | prompt 的紀律沒生效 | 看 `--show-prompt`，確認規則真的有被送進去 |
| 被大量濾除 | 模型在捏造識別字 | 濾除原因會印出來；`evidence-not-found` 多代表這條路由的模型不夠力 |

**最有價值的一步：** 拿你們當年花很久才抓到的那幾個檔案來跑。
抓得到，剩下都是包裝問題；抓不到，該調的是 prompt 跟上下文，而你只花了一天。

### 二、VS Code（確認整合用）

在 VS Code 開啟這個資料夾，按 F5 —— `.vscode/launch.json` 會把 sensAI 專案本身
當成受測 workspace 開起來，所以 `.sensai/rules.yaml` 跟 `examples/` 直接就在裡面。

在新視窗開 `examples/uart_dma.c`，存檔，看側邊欄的 sensAI 面板。

CCR 沒開的話擴充會靜默停用審查，狀態列顯示 `$(circle-slash) sensAI`，不會跳錯誤視窗 ——
這本身也是一個該驗的行為。

---

## 裝進 VS Code

F5 只是開發用的。要真的用在日常工作上，打包成 `.vsix` 安裝。

### 打包與安裝

```bash
npm run package                          # 產出 sensai.vsix（約 120 KB）
code --install-extension sensai.vsix
```

也可以在 VS Code 裡按 `Ctrl+Shift+P` →「Extensions: Install from VSIX...」。

裝完重載視窗，右下角狀態列會出現 `sensAI`。

### 給團隊用

`.vsix` 是一個檔案，最簡單的散布方式就是丟進共用磁碟或 release 附件，
大家各自 `code --install-extension`。要更正式的話可以架私有 registry（Open VSX），
但團隊規模不大的話先不必。

**規則不隨擴充散布** —— `.vsix` 裡沒有任何 `.sensai/` 內容。規則是專案的資產，
跟著各專案的 repo 走，`git pull` 就更新。擴充升級與規則更新是兩件獨立的事，
這樣才對得起「規則由開發者透過版本控管維護」這條。

### 在你們的韌體專案裡啟用

開啟專案，`Ctrl+Shift+P` →「sensAI: Initialize Project」，會建立：

```
.sensai/
├── rules.yaml      # 兩條格式示範，換成你們真正的規則
├── config.yaml     # 隱私閘門 + assembly.arch
└── .gitignore      # 排除 local-mutes.json 與 sent.log
```

**`rules.yaml` 跟 `config.yaml` 要進版控**，`.gitignore` 已經幫你把
本機靜音清單與稽核日誌排掉了。

沒有適用規則的時候，審查會**退化成只檢查語法與型別錯誤**，其他一律不報 ——
那種泛泛的通用意見沒有價值，不值得打擾你。語法錯誤是唯一的例外，
因為它的對錯不需要任何專案知識，而且不能假設每台機器上都裝了編譯器或 clangd。

狀態列的提示會標明「只檢查語法（沒有規則）」，Output 面板也會記一行。
要拿到真正有價值的結果，還是得寫 `.sensai/rules.yaml`。

### 結果出現在哪裡

| 位置 | 內容 |
|---|---|
| **左側 Activity Bar 的 sensAI 圖示** → Findings 面板 | 主要輸出。每則意見顯示訊息、行號（可點擊跳轉）、命中的規則，以及觸發條件、後果、依據三個欄位 |
| **右下角狀態列** | 目前狀態：審查中、幾則意見、沒有問題、CCR 沒開、只檢查語法（沒有規則）。點一下打開面板 |
| **Output 面板 → sensAI** | 被濾除的意見與濾除原因、規則載入的問題、錯誤訊息 |

**不在 Problems 面板，也不畫波浪線。** 這是刻意的：波浪線在編輯器語彙裡代表
「這是錯的」，是斷言，而模型給不起那個確定性。而且 Problems 面板一則只能顯示
一行文字，裝不下觸發條件與後果 —— 那三個欄位正是讓你能自己判斷是不是誤報的東西，
省掉的話這個工具就退化成一般的 linter 了。

面板沒開的時候，存檔後只有狀態列會變。點狀態列會打開面板顯示既有結果，
不會重跑審查。

### 設定放哪裡

| 設定 | 放哪 | 為什麼 |
|---|---|---|
| `sensai.endpoint`、`sensai.model` | 使用者設定 | 每台機器的 CCR 裝法與路由偏好不同 |
| `sensai.enabled` | 使用者或工作區皆可 | |
| `privacy.*`、`assembly.arch` | `.sensai/config.yaml` | 團隊共同的決定，要進版控 |

不要把 `endpoint` 寫進工作區設定再 commit —— 別人的 CCR 未必在同一個埠。

### 已知限制

**多根工作區只看第一個資料夾。** `.sensai/` 會從
`workspaceFolders[0]` 找，所以如果你同時開了韌體專案跟別的東西，
順序會影響結果。單一資料夾的用法不受影響。

---

## 設定

### 每台機器（VS Code settings）

| 設定 | 預設 | 說明 |
|---|---|---|
| `sensai.enabled` | `true` | 存檔時自動審查 |
| `sensai.endpoint` | `http://127.0.0.1:3456` | CCR 位址 |
| `sensai.model` | `claude-opus-5` | 送給 CCR 的 model 欄位，實際上是路由 key |
| `sensai.includeDepth` | `2` | `#include "..."` 的遞迴深度 |
| `sensai.contextBudgetBytes` | `120000` | 附帶 header 的總位元組上限 |
| `sensai.requestTimeoutMs` | `120000` | 單次審查逾時 |

### 專案層級（`.sensai/config.yaml`，進版控）

只放團隊共同的決定 —— 目前就是隱私閘門：

```yaml
privacy:
  never_send: ["src/secure/**", "**/crypto/**"]
  audit_log: .sensai/sent.log

# 組語審查要注入哪一組 ABI 事實。可用：riscv32-andes-v5、armv7e-m
assembly:
  arch: riscv32-andes-v5
```

受審檔案或它引用到的**任何** header 命中 `never_send`，整次審查就跳過。
不做遮蔽後照送 —— 部分遮蔽的檔案仍然洩漏結構，而且很難驗證遮乾淨了。

---

## 規則

`.sensai/rules.yaml`，**由開發者透過版本控管維護**。使用者不修改規則，
只能在自己機器上靜音（`.sensai/local-mutes.json`，已 gitignore）。

```yaml
- id: w1c-status-bits
  languages: [c, asm]
  severity: error
  rule: |
    狀態暫存器裡的中斷旗標多半是 write-1-clear。用 |= 去設定一個 W1C 位元，
    實際上是把讀回來的所有已設旗標又寫回去，會把其他還沒處理的中斷一併清掉。
  except: |
    唯讀的狀態位元不適用這條規則。
  examples:
    bad: |
      UART0->STATUS |= UART_STATUS_TXDONE;
    good: |
      UART0->STATUS = UART_STATUS_TXDONE;
```

`examples` 不要省略 —— 一組正反範例對準確度的提升，遠大於把 `rule` 寫得更長。

`except` 讓「不該報什麼」跟「該報什麼」待在同一份受控文件裡。
使用者反覆靜音同一條規則，通常代表該補一段 `except`。

`languages` 指定適用語言（`[c]` / `[asm]` / `[c, asm]`），省略代表兩者皆是。
把 C 的規則送去審組語只會製造誤報。

暫存器用途、呼叫慣例、堆疊對齊這類**架構事實**不用寫進規則 ——
擴充內建（見 `src/abi.ts`），組語審查時依 `assembly.arch` 自動注入。
判斷「什麼算問題」的部分仍然全部在你的規則裡。

改動 `.sensai/*.yaml` 會自動熱重載，不用重開視窗。

---

## 指令

| 指令 | 用途 |
|---|---|
| `sensAI: Review Current File` | 手動觸發審查 |
| `sensAI: Export False Positive Report` | 匯出誤報記錄，給開發者當調整規則的素材 |
| `sensAI: Clear Local Mutes` | 清除本機靜音 |
| `sensAI: Reload Rules` | 手動重載規則並顯示載入結果 |

---

## 設計上的兩個刻意選擇

**不畫錯誤波浪線。** 結果只進側邊面板。波浪線在編輯器語彙裡代表「這是錯的」，
是斷言，而模型給不起那個確定性。同樣猜錯一次，提議的信任損失遠小於斷言。

**強制每則意見說明具體失效情境。** `trigger_condition` / `consequence` / `evidence`
三個欄位是必填的。主要作用不是事後過濾，是改變模型的行為 —— 被要求說明
具體觸發時機時，講不出來的意見就不會被提出來。

`evidence` 引用不到原始碼裡真實存在的識別字時，該則意見會被丟棄（記在 Output 面板）。

---

## 開發

```bash
npm run typecheck   # tsc --noEmit
npm test            # 單元測試 + 對假 CCR 的端對端測試
npm run watch       # 邊改邊建
```

測試不需要真的 CCR：`test/ccr.test.mjs` 會起一個假的 router，
驗證請求的形狀（tool use、強制 tool_choice、不用 structured outputs）
與各種回應的處理。
