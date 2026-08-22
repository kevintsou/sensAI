# sensAI — 韌體開發即時正確性檢查器

> ARM / Andes AndeStar V5 韌體專用的 Language Server，
> 在你打字的當下就指出組語與 C 的正確性問題。

---

## 1. 這是什麼，不是什麼

sensAI 是一個 **Language Server (LSP)**，專門服務 ARM 與 Andes AndeStar V5 (RISC-V based)
的韌體開發，主要處理組語 (`.s` / `.S`) 與 C (`.c` / `.h`)。

**它不是 Copilot 的複製品。** 它不做程式碼補全、不做 ghost text、不做對話式聊天。
它只回答一個問題：**「你剛剛改的這段，是對的嗎？」**

### 與 clangd 的分工

`.c` 已經有 clangd 負責語法、型別、補全、跳轉。sensAI 刻意**不重做**這些，
避免兩個工具對同一件事各畫一條紅波浪線。

| 檔案 | clangd 負責 | sensAI 負責 |
|---|---|---|
| `.c` / `.h` | 語法、型別、補全、跳轉、rename | 硬體語意、ABI、併發/中斷、`volatile` |
| `.s` / `.S` | （無支援） | **全部** ← 主戰場 |

組語在現有 IDE 生態裡幾乎是工具真空：沒有型別檢查、沒有 ABI 驗證、
沒有堆疊分析。這是 sensAI 最主要的價值來源。

---

## 2. 核心設計原則

### 原則一：不確定就閉嘴

靜態分析遇到無法確定的情況（間接跳轉、巨集展開、動態 `sp` 調整、
未知的外部符號），一律標記為 `unknown` 並**放棄該項檢查**，絕不猜測。

理由：誤報一次，使用者就再也不信任這個工具。在韌體開發這種
「工程師本來就很懷疑工具」的領域，寧可漏報也不要誤報。

### 原則二：能靜態算的，絕不交給 LLM

大量的韌體錯誤是**確定性可判定**的 —— callee-saved 暫存器沒還原、
堆疊不平衡、W1C bit 用 `|=` 清除。這些交給 LLM 反而更慢、更貴、更不準。

LLM 只用在**需要理解意圖**的地方：這段組語跟旁邊的 C 呼叫端意圖對不對得起來、
這個 delay loop 會不會被優化掉、這個中斷處理常式缺了什麼。

### 原則三：LLM 的每個修補都必須先通過驗證

任何 LLM 產出的 patch，先套用到記憶體中的檔案副本，
用真實的 toolchain 組譯 / 編譯一次。**組不過就直接丟掉，不顯示給使用者。**

韌體場景讓這件事特別乾淨：`as` 組得過 = 語法一定正確。

### 原則四：程式碼外送必須是明示的選擇

韌體原始碼通常受 NDA 保護。所有外送 LLM 的行為都必須可設定、可稽核、可完全關閉。

---

## 3. 三層延遲架構

LLM 一次來回需要 1〜5 秒，與「即時」天然衝突。
sensAI 用分層讓即時感由前兩層撐起：

| 層級 | 延遲 | 觸發時機 | 內容 | 成本 |
|---|---|---|---|---|
| **T0** 靜態分析 | < 10 ms | 每次 `didChange` | ABI、堆疊、回傳路徑、指令合法性、暫存器語意 | 零 |
| **T1** Toolchain 驗證 | ~200 ms | debounce 300 ms | `as` 組譯 / `gcc -fsyntax-only` | 零 |
| **T2** LLM 語意審查 | 1〜5 s | idle 1.5 s 或 `didSave` | 意圖層面的問題、修補建議 | 依路由 |
| **T3** 深度審查 | 5〜30 s | 使用者手動觸發 | 整個函式 / 檔案的完整審查 | 高 |

T0 與 T1 提供「秒回的確定答案」，T2 之後補上「AI 的判斷」。
兩者在 UI 上必須明確區分（見 §7）。

---

## 4. T0：靜態分析引擎

### 4.1 架構抽象

```ts
interface ArchDef {
  id: 'armv7-m' | 'armv8-m' | 'riscv32-andes-v5' | ...;

  registers: {
    canonical: string[];                    // x0..x31 / r0..r15
    aliases: Record<string, string>;        // a0 -> x10, fp -> x8
    width: 32 | 64;
  };

  abi: {
    args:        string[];   // ARM: r0-r3      RISC-V: a0-a7
    returns:     string[];   // ARM: r0-r1      RISC-V: a0-a1
    callerSaved: string[];   // ARM: r0-r3,r12  RISC-V: t0-t6,a0-a7
    calleeSaved: string[];   // ARM: r4-r11     RISC-V: s0-s11
    stackPointer: string;    // sp
    returnAddress: string;   // lr / ra
    stackAlignment: 8 | 16;  // ARM AAPCS: 8    RISC-V: 16
  };

  decode(mnemonic: string, operands: Operand[]): InstructionSemantics;
  isValidFor(mnemonic: string, march: string): boolean;
}
```

v1 實作兩個：`armv7-m`（Cortex-M 系列）與 `riscv32-andes-v5`
（標準 RISC-V ABI + Andes 專有擴充：CoDense、EXEC.IT、專有 CSR）。

### 4.2 Parser

手寫的 GAS 語法 parser（不用 tree-sitter —— 現有 asm grammar 對
指令語意的支援不足）。輸出：

```
Label | Directive | Instruction(mnemonic, operands) | Comment | MacroInvocation
```

遇到巨集展開、`.if` 條件組譯等無法靜態確定的區段，標記為 opaque region，
其中的分析全部略過（原則一）。

### 4.3 檢查項目

從指令序列建立函式內的 CFG（label → basic block），然後執行資料流分析：

| 檢查 | 說明 | 可判定性 |
|---|---|---|
| **Callee-saved 違規** | 函式修改了 callee-saved 暫存器，但 prologue 沒存、epilogue 沒還原 | 確定 |
| **堆疊不平衡** | 追蹤 `sp` 增減，每個 return point 淨變化必須為 0 | 確定（動態調整時放棄） |
| **堆疊對齊** | prologue 的 `sp` 調整量須符合架構要求（ARM 8-byte / RISC-V 16-byte） | 確定 |
| **回傳路徑缺失** | CFG 中存在未以 `bx lr` / `ret` / `jr ra` 結束的路徑 | 確定 |
| **`lr`/`ra` 覆寫** | 呼叫子函式前未保存 return address | 確定 |
| **指令不合法** | 使用了目標 `-march` 不支援的指令 | 確定 |
| **Label 問題** | 分支到未定義的 label、label 重複定義 | 確定 |
| **未初始化讀取** | 讀取在此路徑上從未被寫入、也非參數的暫存器 | 高信心 |

**所有這些都是零成本、零延遲、無誤報的。** 這是 sensAI 的地基，
也是相對於現有工具的護城河。

---

## 5. 跨 C / 組語邊界一致性

韌體最經典的錯誤來源之一，而且**大半是靜態可算的**。

從組語端抽取：
```asm
    .globl  uart_send
    .type   uart_send, %function
uart_send:
    ...
```

從 C 端抽取（tree-sitter-c 解析 header，不需要完整 include path）：
```c
extern int uart_send(const char *buf, size_t len);
```

比對規則：

| 檢查 | 範例錯誤 |
|---|---|
| 參數數量 | C 宣告 2 個參數，組語卻讀了 `a2` |
| 回傳值 | C 宣告非 `void`，組語卻從未寫入 `a0` / `r0` |
| 64-bit 參數對齊 | ARM AAPCS 要求 64-bit 參數對齊到偶數暫存器對，組語從 `r1` 開始讀 |
| 符號存在性 | C 宣告了 `extern`，但沒有任何 `.s` 定義它 |
| 呼叫慣例標註 | 組語函式缺 `.type %function`，導致 linker 在 Thumb interworking 下產生錯誤 |

準確度接近 100%，不需要 LLM。

---

## 6. 硬體暫存器語意

### 6.1 為什麼不用 PDF RAG

直覺會想把 SoC datasheet 餵給模型做 RAG。實務上這條路不通：

- datasheet 的暫存器表格 PDF 解析品質很差，欄位、bit range、access type 常錯位
- SoC 手冊通常受 NDA 保護，不能外送
- 模型對 Andes 專有暫存器的訓練資料極少，RAG 命中率不穩定

### 6.2 資料驅動的靜態檢查

改用**專案內的暫存器語意標註**，讓硬體語意錯誤變成確定性檢查：

```yaml
# .sensai/registers.yaml
UART0_STATUS:
  address: 0x40001004
  access: ro
  bits:
    TX_DONE:   { bit: 0, access: w1c }    # 寫 1 清除
    RX_FULL:   { bit: 1, access: ro  }

PLL_CTRL:
  address: 0x40002000
  requires_unlock:
    register: PLL_LOCK
    value: 0xA5A5
  bits:
    ENABLE: { bit: 0 }

DMA_BUFFER:
  address_range: [0x20010000, 0x20014000]
  requires_cache_maintenance: true
```

由此可以確定性地判定：

| 檢查 | 範例錯誤 |
|---|---|
| W1C 誤用 | `UART0_STATUS \|= TX_DONE;` —— 對 write-1-clear 位元用 `\|=` 是錯的 |
| 唯讀寫入 | 對 `access: ro` 的暫存器或位元寫入 |
| 缺解鎖序列 | 寫 `PLL_CTRL` 前沒有先寫 `PLL_LOCK = 0xA5A5` |
| 缺 cache 維護 | DMA buffer 存取前後沒有 clean / invalidate |
| 缺 `volatile` | MMIO 位址範圍內的存取，指標未標 `volatile` |

### 6.3 標註如何產生

1. **自動打底** —— 從專案 header 抽取 `#define` 與位址常數，
   產生 `registers.yaml` 骨架（bit 位置多半推得出來，access type 推不出來）
2. **人工標註關鍵暫存器** —— 資深工程師補上 `access`、`requires_unlock` 等語意
3. **LLM 輔助建議**（可選）—— 從 header 的註解推測 access type，
   標記為「待人工確認」，絕不直接生效

這份 YAML 完全不外送，並且會逐步累積成團隊資產。

---

## 7. 併發與中斷語意

這一層混合靜態規則與 LLM，是誤報風險最高的部分，因此預設 severity 較低。

**靜態可判定的：**

| 檢查 | 說明 |
|---|---|
| ISR 內呼叫非 reentrant 函式 | 對照可設定的黑名單（`malloc`、`printf`、專案自訂） |
| ISR 內阻塞 | 呼叫已知的 blocking API、或含無界迴圈 |
| 共享變數缺 `volatile` | 同時被 ISR 與主程式存取，但未標 `volatile` |
| 中斷向量表對齊 | 向量表符號的對齊不符架構要求 |
| CSR 修改後缺同步 | 修改特定 CSR 後缺 `fence.i` / `isb` |

**需要 LLM 的：**

- read-modify-write 序列缺臨界區保護（需理解哪些狀態是共享的）
- memory barrier 位置不足以保證所需的順序
- delay loop 會被編譯器優化掉
- 這段組語的意圖與周邊 C 程式碼不一致

---

## 8. T1：Toolchain 驗證層

### 8.1 組語（依賴少，v1 就能做）

```
as -march=<arch> -mabi=<abi> -o /dev/null <patched.s>
```

組得過 = 語法正確。進一步可以在套用修補前後各組譯一次，
用 `objdump` 比對，確認修補沒有改動預期外的指令。

### 8.2 C（依賴多，需要 build 資訊）

```
<cross-gcc> -fsyntax-only -Wall -Werror <flags from project> <patched.c>
```

必須使用專案真正的 cross compiler 與 flags，不能用 host gcc。

### 8.3 取得 build flags（封閉 IDE 環境）

專案使用 AndeSight / Keil 等封閉 build system，沒有 `compile_commands.json`。
設計成**可插拔的 flags 來源**：

| 來源 | 說明 | 優先序 |
|---|---|---|
| `.sensai/config.yaml` 手動設定 | 使用者自行填寫，永遠可用 | 最高 |
| AndeSight `.cproject` | Eclipse CDT XML，可解析 include path、defines、`-march` | 高 |
| Keil `.uvprojx` | uVision XML，同上 | 高 |
| `compile_commands.json` | 若專案有 CMake 或 bear 可產生 | 高 |
| `make -n` 抽取 | 從 dry-run 輸出解析編譯指令 | 中 |

**這是 `.c` 支援排在 `.s` 之後的主因** —— 組語驗證只需要 `as` 與 `-march`，
C 驗證需要完整的 include path 與 defines。

---

## 9. T2：LLM 層

### 9.1 後端：Claude Code Router

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: config.llm.endpoint,   // 預設 http://127.0.0.1:3456
  apiKey: "ccr",                  // CCR 不驗證，但 SDK 要求非空
});
```

CCR 提供 Anthropic 相容的 `/v1/messages`，因此可以直接用官方 SDK。
但 CCR 會將請求路由到不同 provider，這帶來四個限制：

**限制一：不能依賴 structured outputs。**
`output_config.format` 經過 CCR 的 transformer 不保證轉得過去。
改用 **tool use / function calling** 取得結構化結果 —— 幾乎所有 provider 都支援：

```ts
const tools = [{
  name: "report_findings",
  description: "回報在這段程式碼中發現的正確性問題",
  input_schema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            line:        { type: "integer" },
            severity:    { type: "string", enum: ["error", "warning", "info"] },
            category:    { type: "string", enum: ["abi", "concurrency", "mmio", "intent", "other"] },
            message:     { type: "string" },
            explanation: { type: "string" },
            patch:       { type: "string", description: "統一 diff 格式，可選" },
          },
          required: ["line", "severity", "category", "message"],
          additionalProperties: false,
        },
      },
    },
    required: ["findings"],
    additionalProperties: false,
  },
}];
```

**限制二：不能靠 prompt caching 壓成本。**
非 Anthropic 後端沒有這個機制，`cache_read_input_tokens` 會是 0。
成本控制必須靠「只送必要的 hunk 加上精選 context」，而非快取。

**限制三：CCR 未啟動時要優雅降級。**
T0 / T1 照常運作，T2 靜默停用，僅在狀態列顯示，不跳錯誤視窗。

**限制四：模型能力不一。**
CCR 可能路由到能力較弱的模型。因此驗證層（原則三）不是加分項，而是必要條件。

### 9.2 路由策略

CCR 的 `model` 欄位實際上是路由 key，可以分流：

```yaml
llm:
  model_quick: background        # T2 即時審查 —— 便宜快速的路由
  model_deep:  claude-opus-5     # T3 手動深度審查
```

### 9.3 送出的 context

只送必要內容，控制成本與延遲：

1. 改動的 hunk 及其所在函式完整內容
2. 該函式呼叫與被呼叫的相鄰函式簽章
3. 相關的暫存器定義（從 `registers.yaml` 過濾出這段程式碼實際觸及的）
4. 目標架構與 ABI 摘要
5. T0 已經發現的問題（避免 LLM 重複回報）

### 9.4 修補自我驗證

```
LLM 產出 patch
  → 套用到記憶體中的檔案副本
  → 用真實 toolchain 組譯 / 編譯
  → 通過：顯示為 Quick Fix，標註「已驗證」
  → 失敗：丟棄，不顯示（記錄到 log 供調校 prompt）
```

---

## 10. 隱私閘門

韌體原始碼通常受 NDA 保護。外送控制是必要功能，不是選配。

```yaml
# .sensai/config.yaml
privacy:
  mode: opt-in              # opt-in | opt-out | disabled
  never_send:
    - "src/secure/**"
    - "**/*_key*.c"
    - "**/crypto/**"
  redact:
    - pattern: "0x[0-9A-Fa-f]{8}"    # 遮蔽疑似位址常數
      when: "in_comment"
  audit_log: .sensai/sent.log        # 記錄每次外送的檔案與位元組數
```

- `mode: disabled` 時，sensAI 完全不連外，只跑 T0 / T1 —— 而這已經是有用的工具
- `never_send` 匹配的檔案，T2 / T3 完全跳過，並在狀態列標示
- `registers.yaml` 與 datasheet 衍生資料**永不外送**
- 每次外送寫入稽核日誌，讓資安稽核有跡可循

---

## 11. LSP 與編輯器整合

### 11.1 診斷呈現

不同來源的可信度不同，UI 上必須讓使用者一眼分辨：

| 來源 | `source` | `code` 前綴 | 預設 severity |
|---|---|---|---|
| 靜態分析 | `sensai` | `abi/`、`stack/`、`mmio/` | Error / Warning |
| Toolchain | `sensai` | `build/` | Error |
| LLM | `sensai-ai` | `ai/` | Information |

LLM 的診斷使用不同的 `source` 字串，讓使用者可以在 VS Code 設定中
獨立過濾掉 AI 的意見，而保留靜態分析的結果。

### 11.2 LSP 能力

| 能力 | 用途 |
|---|---|
| `textDocument/publishDiagnostics` | 主要輸出通道 |
| `textDocument/codeAction` | Quick Fix（僅顯示通過驗證的修補） |
| `textDocument/hover` | 顯示暫存器語意、ABI 規則說明 |
| `workspace/executeCommand` | 手動觸發 T3 深度審查、重新產生 `registers.yaml` |

### 11.3 為什麼是 LSP 而不是純 VS Code extension

韌體團隊的編輯器分佈很散 —— VS Code、Vim、Eclipse (AndeSight)、Keil。
寫成 LSP 讓核心邏輯可以跨編輯器重用，VS Code extension 只是最薄的一層 client。

代價是 VS Code 專屬的 UI（inline chat、ghost text）用不上 —— 但 sensAI
本來就不做那些。

---

## 12. 設定檔

```yaml
# .sensai/config.yaml
targets:
  - match: "src/arm/**"
    arch: armv7e-m
    toolchain: /opt/gcc-arm-none-eabi/bin/arm-none-eabi
    flags: ["-mthumb", "-mfpu=fpv4-sp-d16"]

  - match: "src/andes/**"
    arch: riscv32-andes-v5
    toolchain: /opt/nds32le-elf/bin/riscv32-elf
    flags: ["-march=rv32imac_xandes", "-mabi=ilp32"]

build_info:
  source: cproject                    # cproject | uvprojx | compile_commands | manual
  path: ./AndeSight/.cproject

llm:
  endpoint: http://127.0.0.1:3456
  model_quick: background
  model_deep: claude-opus-5
  trigger: idle                       # idle | save | manual
  idle_ms: 1500

privacy:
  mode: opt-in
  never_send: ["src/secure/**"]

rules:
  non_reentrant: ["malloc", "free", "printf", "sprintf"]
  disable: ["abi/uninitialized-read"]  # 個別關閉太吵的規則
```

---

## 13. 開發階段

四項檢查全部做完約需 3〜4 個月。分期如下：

### M1 — 組語靜態引擎（約 4 週）
- LSP server 骨架 + VS Code client
- GAS parser、CFG 建構、資料流分析框架
- `ArchDef` 抽象 + ARM Cortex-M 與 Andes V5 兩組實作
- §4.3 全部檢查項目
- **無 LLM，無網路。這個階段結束就已經是可用的工具。**

### M2 — 驗證層與邊界檢查（約 3 週）
- T1 組譯驗證（`as`）
- 跨 C / 組語邊界一致性（§5）
- AndeSight `.cproject` / Keil `.uvprojx` 解析

### M3 — LLM 層（約 3 週）
- CCR 整合、tool-use 結構化輸出
- 修補自我驗證流程
- 隱私閘門與稽核日誌
- T3 手動深度審查

### M4 — 硬體與併發語意（約 4 週）
- `registers.yaml` 格式與從 header 自動抽取
- 暫存器語意檢查（§6.2）
- 併發與中斷規則（§7）

### M5 — C 深度支援
- `.c` 的 T1 驗證（依賴 M2 的 build 資訊解析）
- C 端的 MMIO、`volatile`、型別轉換檢查

---

## 14. 待決事項

- [ ] Andes 專有指令（CoDense、EXEC.IT）的合法性驗證 —— 需要指令集清單來源
- [ ] `.S`（大寫，經過前處理器）的巨集展開如何處理 —— 傾向標為 opaque region
- [ ] 是否支援 inline assembly（C 中的 `__asm__`）—— 建議 M5 之後再議
- [ ] 多檔案 / 全專案層級的分析（例如中斷向量表完整性）—— v1 僅做單檔
- [ ] `registers.yaml` 是否需要支援 SVD / IP-XACT 匯入
