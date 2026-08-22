# sensAI

VS Code 擴充。存檔 `.c` 時，用 AI 做一次單檔 code review，
針對 ARM / Andes AndeStar V5 韌體開發。

差異化不在 AI，在 `rules.yaml` —— 那裡放的是這個專案的硬體特性與團隊慣例，
是通用工具永遠不會知道的東西。沒有規則的話，這只是一個比較差的 Copilot。

---

## 流程

```
存檔 .c
  → 讀檔案內容
  → 抓出 #include "xxx.h" 指到的專案內 header，一併附上
  → 組 prompt：檔案 + headers + rules.yaml
  → 呼叫 CCR，tool use 取回結構化 findings
  → 顯示在側邊面板
```

`#include` 只處理引號式（專案內），`<>` 的系統 header 忽略。
不需要 include path 設定，不需要 build system 整合。

這一步不能省。韌體 C 重度依賴 macro 與 header，沒有這些
AI 會對 `HAL_UART_Transmit(&huart1, ...)` 這類呼叫給出聽起來合理但錯誤的判斷。

---

## Finding 的結構

透過 tool use 取回，schema 強制每個 finding 填滿：

| 欄位 | 內容 |
|---|---|
| `line` | 哪一行 |
| `trigger_condition` | 什麼情況下會出事 —— 要具體，例：「當 ISR 在 40〜42 行之間觸發」 |
| `consequence` | 會造成什麼 —— 例：「讀到舊值」「DMA 搬到過期資料」 |
| `evidence` | 引用檔案中實際存在的行號或識別字 |
| `rule_id` | 命中哪條規則（若有） |

主要作用不是事後過濾，是**改變模型的行為**：被要求說明具體失效情境時，
講不出來的意見就不會被提出來 ——「這裡建議加強錯誤處理」這類
正確但無用的話會自己消失。

事後再丟掉一次：`evidence` 引用不到真實存在的識別字的，直接濾除。

---

## rules.yaml

判斷者是 AI，規則直接用自然語言寫，不需要 AST matcher 或 DSL。

```yaml
# .sensai/rules.yaml
- id: dma-cache-maintenance
  severity: error
  rule: |
    本專案 SoC 的 D-cache 是 write-back。DMA buffer 在啟動 DMA 前必須先
    clean（寫方向），或在讀取結果前 invalidate（讀方向）。
    要呼叫 dma_cache_clean() / dma_cache_invalidate()，不要只下 __DSB()。
  examples:
    bad: |
      memcpy(tx_buf, data, len);
      dma_start(DMA_CH0, tx_buf, len);
    good: |
      memcpy(tx_buf, data, len);
      dma_cache_clean(tx_buf, len);
      dma_start(DMA_CH0, tx_buf, len);

- id: volatile-shared-state
  severity: warning
  rule: |
    被 ISR 與主程式同時存取的變數必須標 volatile。
  except: |
    命名以 _isr 結尾的變數是 ISR 專用副本，不算共享，不要報。
```

`examples` 不要省略 —— 一組正反範例對準確度的提升，
遠大於把 `rule` 寫得更長。

`except` 讓「不該報什麼」跟「該報什麼」待在同一份文件裡。

**規則由開發者透過版本控管維護，使用者不修改。**
檔案放在專案 repo，`git pull` 就生效。v1 全部串進 prompt，
不做挑選機制 —— 那是規則超過數十條之後才需要的。

---

## 模型後端

透過 Claude Code Router，使用官方 SDK：

```ts
const client = new Anthropic({
  baseURL: "http://127.0.0.1:3456",
  apiKey: "ccr",                    // CCR 不驗證，SDK 要求非空
});
```

CCR 會路由到不同 provider，因此：

- **用 tool use，不用 structured outputs** —— `output_config.format` 經過
  CCR 的 transformer 不保證轉得過去，tool use 相容性遠高
- **不依賴 prompt caching** —— 非 Anthropic 後端沒有這個機制
- **CCR 未啟動時** 靜默停用，狀態列顯示即可，不跳錯誤視窗

---

## 顯示

結果進側邊面板，**不畫錯誤波浪線**。

波浪線在編輯器語彙裡代表「這是錯的」，是斷言；AI 給不起那個確定性。
Copilot NES 也是用 gutter 箭頭而非波浪線，理由相同 ——
同樣猜錯一次，提議的信任損失遠小於斷言。

每個 finding 顯示 `trigger_condition` 與 `consequence`，
讓使用者能自行判斷是不是誤報。

使用者可以標記誤報：本機立刻靜音（不進版控），同時留一筆可匯出的記錄，
供開發者日後調整規則。

---

## 隱私

韌體原始碼通常受 NDA 保護。

```yaml
privacy:
  never_send: ["src/secure/**", "**/crypto/**"]
  audit_log: .sensai/sent.log
```

匹配的檔案完全跳過，狀態列標示。每次外送寫入稽核日誌。

---

## 明確不做（v1）

記錄下來以免日後重複討論：

| 不做 | 理由 |
|---|---|
| 打字停頓即時檢查 | 韌體的痛是「三天後在板子上發現」，不是「慢了幾秒」。這項佔 60% 工程量，只換回幾秒，且送出的是未完成的程式碼、誤報風險最高 |
| 語法檢查（`as` / `gcc`） | 交給 clangd。存檔時程式碼多半語法完整 |
| 修補套用 + 編譯驗證 | review 是意見，不產生可套用的 patch |
| `.s` 組語 | 價值高但先確認 `.c` 這條路走得通。組語只需 `as -march`，之後加不難 |
| LSP | 先用最陽春的 VS Code 擴充驗證想法。跨編輯器的需求之後再說 |
| 規則挑選機制、CI dry-run | 規則超過數十條才需要 |

---

## 待驗證

第一步是拿**真的踩過坑的 `.c` 檔**去試，看 AI 抓不抓得到當年那個 bug。

- 抓得到 → 剩下是包裝問題，再決定要不要升級 LSP、加 `.s`
- 抓不到 → 問題在 prompt 與上下文，此時只損失一天

其他待確認：

- [ ] 單檔 + 專案 header 的上下文是否足夠，或需要再補相鄰的 `.c`
- [ ] 團隊目前 clangd / cpptools 是否正常運作。若否，
      補一份 `compile_flags.txt` 可能比 AI 檢查更快解決日常困擾
- [ ] 追蹤指標：finding 被實際修掉的比例（不是準確率 —— 那沒有 ground truth）
