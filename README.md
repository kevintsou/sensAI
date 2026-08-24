# sensAI

AI-assisted code review for ARM and Andes AndeStar V5 firmware in VS Code.

[繁體中文](#繁體中文) · [Install guide](docs/INSTALL.md) · [Rule authoring](docs/rules.md) · [Privacy](docs/privacy.md) · [Contributing](CONTRIBUTING.md)

## English

sensAI reviews firmware C and assembly files when you save them, provided the
file has actual changes relative to git HEAD. It combines
the file, relevant project headers, and rules written by your team, then shows
grounded findings in the sensAI side panel. It is designed to catch
project-specific issues that generic AI tools do not know about: DMA cache
maintenance, write-one-to-clear registers, ISR safety, ABI requirements, and
similar hardware conventions.

### Highlights

- Reviews `.c`, `.h`, `.s`, and `.S` files on save or on demand.
- Skips a save with no changes; an on-demand review always runs.
- Waits for a quiet period before sending, and coalesces saves that arrive
  mid-review into one re-run on the latest content.
- Resolves project-local includes and injects ABI facts for assembly reviews.
- Uses natural-language rules maintained in version control.
- Requires source-grounded evidence and drops fabricated references.
- Keeps suggestions in a dedicated panel rather than asserting that AI output
  is a compiler error.

### Quick start

1. Install **sensAI** from the VS Code Marketplace.
2. Start a Claude Code Router-compatible endpoint and configure it in your VS
   Code user settings:

   ```json
   {
     "sensai.endpoint": "http://127.0.0.1:3456",
     "sensai.model": "claude-opus-5"
   }
   ```

3. Open your firmware repository and run **sensAI: Initialize Project** from
   the Command Palette. Commit `.sensai/rules.yaml` and `.sensai/config.yaml`
   with the project, then replace the example rules with your team's rules.

Use **sensAI: Review Current File** for an on-demand review. Findings appear
in the sensAI side panel; status and diagnostics are available in the
**sensAI** Output channel.

### Rules and privacy

Rules are deliberately not shipped with the extension. Keep them in
`.sensai/rules.yaml` for each project, or set `sensai.rulesPath` to a shared
private rules repository. The project-level `.sensai/config.yaml` keeps each
project's privacy policy separate from the shared rules.

> **Privacy notice:** sensAI sends the reviewed source file and resolved
> project headers to the endpoint you configure. Use `privacy.never_send` to
> exclude confidential paths. If the source file or any included header
> matches, the entire review is skipped.

Without applicable rules, sensAI limits its request to syntax and type errors.
See [Rule authoring](docs/rules.md) and [Privacy](docs/privacy.md) before
enabling reviews on confidential firmware repositories.

### Settings

| Setting | Default | Purpose |
|---|---:|---|
| `sensai.enabled` | `true` | Review supported files on save. |
| `sensai.debounceMs` | `1000` | Quiet period after a save before the review is sent; `0` sends immediately. |
| `sensai.endpoint` | `http://127.0.0.1:3456` | Router endpoint. |
| `sensai.model` | `claude-opus-5` | Router model key. |
| `sensai.rulesPath` | empty | A rules file; relative paths use the workspace root. |
| `sensai.includeDepth` | `2` | Recursive project-header depth. |
| `sensai.contextBudgetBytes` | `120000` | Header-context byte limit. |
| `sensai.requestTimeoutMs` | `120000` | Per-review timeout in milliseconds. |
| `sensai.maxFindings` | `8` | Finding cap; lower severities collapse first, `error` never collapses. |

## 繁體中文

sensAI 是給 ARM 與 Andes AndeStar V5 韌體團隊使用的 VS Code AI code review
擴充。存檔且檔案相對 git HEAD 有改動時，它會帶入目前檔案、專案內引用的 header
與團隊規則，將有依據的意見顯示在 sensAI 側欄。它特別適合檢查通用工具不知道的專案知識，例如 DMA cache、
W1C 暫存器、ISR 安全性與組語 ABI。

### 快速開始

1. 從 VS Code Marketplace 安裝 **sensAI**。
2. 啟動相容的 Claude Code Router，並在 VS Code 使用者設定填入自己的
   `sensai.endpoint` 與 `sensai.model`。
3. 開啟韌體專案後，從 Command Palette 執行 **sensAI: Initialize Project**。
   把 `.sensai/rules.yaml` 與 `.sensai/config.yaml` 提交到專案版本控制，再將範例
   規則換成團隊真正的規則。

可用 **sensAI: Review Current File** 手動審查。結果顯示在 sensAI 側欄；狀態、
被濾除的意見與錯誤訊息位於 **Output → sensAI**。

### 規則與隱私

規則不會隨 extension 散布。每個專案可將規則放在 `.sensai/rules.yaml`，或以
`sensai.rulesPath` 指向部門共用的私有 rules repository；`.sensai/config.yaml`
則留在專案中，管理該專案的隱私政策。

> **隱私提醒：** sensAI 會將受審檔案與解析到的專案 header 傳往你設定的 endpoint。
> 請用 `privacy.never_send` 排除機密路徑；受審檔案或任何附帶 header 命中時，整次
> 審查都會跳過。

沒有適用規則時，sensAI 只檢查語法與型別錯誤。啟用機密韌體專案前，請先閱讀
[規則撰寫指南](docs/rules.md) 與 [隱私設定](docs/privacy.md)。

### 常用指令

| 指令 | 用途 |
|---|---|
| `sensAI: Review Current File` | 手動觸發審查。 |
| `sensAI: Initialize Project` | 建立 `.sensai/` 專案設定骨架。 |
| `sensAI: Reload Rules` | 重新載入規則。 |
| `sensAI: Export False Positive Report` | 匯出本機誤報記錄。 |
| `sensAI: Clear Local Mutes` | 清除本機靜音。 |

### 觸發時機

存檔會觸發審查的條件是**存檔且該檔案相對 git HEAD 有改動**。沒有改動的存檔
（改完又改回來、格式化沒動到東西、慣性按 Ctrl+S）不會送出任何內容，側欄維持
原狀，Output 會留一行記錄。

未追蹤的檔案或不在 git repo 裡的檔案無法判定改動範圍，這種情況**照樣審**整份
檔案 —— 「無法判定」不等於「沒有改動」。

`sensAI: Review Current File` 不受此限制，一律照審。

### 頻繁存檔

三層機制避免重複的請求一直被送出：

1. **去抖動**：存檔後等 `sensai.debounceMs`（預設 1000ms）沒有新的存檔才真的送出。
   持續打字期間幾乎不會送出任何請求 —— 只審已經穩定下來的內容。設 0 可關閉。
2. **合併**：同一個檔案同時只跑一輪。這輪還在跑時進來的存檔併成**一次**補跑（不是
   丟掉，也不是各跑一輪），用當下最新的內容。最後一次存檔的內容保證會被審到。
3. **連續觸發時降級**：補跑那幾輪只做階段一（只看改動的行）。兩階段送的是同一份
   完整檔案，省掉階段二等於省一半請求。

第 3 點是**延後、不是放棄**。階段一會濾掉改動範圍外的意見，而 DMA cache、W1C、ISR、
ABI 這類問題常常不在改動的那幾行上。所以連續觸發一停止，sensAI 會自動補做完整審查
（單一請求，不重跑階段一）。側欄在降級期間會標示「連續存檔中，等停下來再做完整審查」。

`sensAI: Review Current File` 不受這三層影響，一律立即執行完整流程，並取消該檔案還在
等待的去抖動。

審查期間檔案又被改過時，結果仍然會顯示，但側欄會標明行號是對著送出當下那一版算的、
跳行可能會偏。

### 限制

- 多根工作區目前只讀取第一個工作區資料夾。
- `.S` 的巨集不會展開；上下文不足時模型應保守不報。
- sensAI 提供 review 意見，不會產生或套用修補程式。

## More documentation

- [Installation guide](docs/INSTALL.md)
- [Rule authoring](docs/rules.md)
- [Privacy and project configuration](docs/privacy.md)
- [Design rationale](SPEC.md)
- [Development and release workflow](CONTRIBUTING.md)
