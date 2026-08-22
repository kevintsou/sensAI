# sensAI

VS Code 擴充。存檔 `.c` 或 `.s` 時用 AI 做一次單檔 code review，針對 ARM / Andes AndeStar V5 韌體開發。

設計理由與取捨記在 [SPEC.md](./SPEC.md)。

差異化不在 AI，在 `.sensai/rules.yaml` —— 那裡放的是這個專案的硬體特性與團隊慣例，
是通用工具永遠不會知道的東西。**沒有規則的話，這只是一個比較差的 Copilot。**

---

## 快速開始

```bash
npm install
npm run build
```

在 VS Code 開啟這個資料夾，按 F5 啟動 Extension Development Host。

需要 [Claude Code Router](https://github.com/musistudio/claude-code-router) 在
`http://127.0.0.1:3456` 執行。沒開的話擴充會靜默停用審查，狀態列顯示 `$(circle-slash) sensAI`，
不會跳錯誤視窗。

### 先驗證想法再投入

`examples/` 下有兩個埋好錯誤的檔案，各自在檔尾列出應該與不應該被回報的項目：

| 檔案 | 埋的錯誤 | 誘餌 |
|---|---|---|
| `uart_dma.c` | 6 個（W1C 誤用、缺 volatile、DMA 沒 clean cache、ISR 裡 malloc、RMW 沒關中斷、空迴圈延遲） | 3 段 |
| `uart_dma.s` | 7 個（缺 fence、W1C 誤用、callee-saved 沒存、堆疊沒對齊、ra 沒保存、堆疊不平衡、ABI 不符） | 3 段 |

開啟後存檔，比對檔案末尾的期待結果：

- 都抓到，且沒有誤報那些誘餌 → prompt 與規則的方向對了
- 漏抓 → 調整對應規則的 `rule` 措辭，或補 `examples`
- 誤報 → 該規則需要補 `except`

拿你們**真的踩過坑的檔案**重跑一次這個流程，比讀任何文件都有用。

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
