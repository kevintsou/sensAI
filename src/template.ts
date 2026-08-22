/**
 * `sensAI: Initialize Project` 寫出來的範本。
 *
 * 規則不隨擴充散布 —— 那是專案的資產，由開發者透過版本控管維護。
 * 這裡只給一個能跑起來的骨架，讓新專案不用從空白開始。
 */

export const RULES_TEMPLATE = `# sensAI 規則庫
#
# 這裡放的是「這個專案的硬體特性與團隊慣例」—— AI 不可能自己知道的東西。
# 沒有規則的話，審查結果會退化成任何通用工具都給得出的泛泛意見。
#
# 由開發者透過版本控管維護。使用者只能在自己機器上靜音，不修改這個檔案。
#
# 每條規則：
#   id        必填，唯一
#   languages [c] / [asm] / [c, asm]，省略代表兩種都適用
#   severity  error / warning / info，預設 warning
#   rule      必填，自然語言，直接寫給模型看
#   except    什麼情況不算問題 —— 團隊層級的例外放這裡
#   examples  一組正反範例。不要省略，對準確度的幫助遠大於把 rule 寫更長。
#
# 暫存器用途與呼叫慣例這類「架構事實」不用寫在這裡，擴充會依
# config.yaml 的 assembly.arch 自動注入。
#
# 下面兩條是格式示範，請換成你們專案真正的規則。

- id: volatile-shared-state
  languages: [c]
  severity: error
  rule: |
    被 ISR 與主程式同時存取的變數必須標 volatile，否則編譯器會把讀取
    提到迴圈外或直接快取在暫存器裡，導致主程式看不到 ISR 的更新。
  except: |
    命名以 _isr 結尾的變數是 ISR 專用副本，不算共享，不要報。
  examples:
    bad: |
      static uint32_t rx_ready;
      void UART0_IRQHandler(void) { rx_ready = 1; }
      void main_loop(void) { while (!rx_ready) { } }
    good: |
      static volatile uint32_t rx_ready;
      void UART0_IRQHandler(void) { rx_ready = 1; }
      void main_loop(void) { while (!rx_ready) { } }

- id: asm-callee-saved
  languages: [asm]
  severity: error
  rule: |
    函式若修改 callee-saved 暫存器，必須在 prologue 存進堆疊、在每一條返回
    路徑還原。少存一個的話，呼叫端的區域變數會在呼叫後莫名其妙變值，
    而且症狀會出現在離這個函式很遠的地方。
  except: |
    程式進入點（_start、reset handler）沒有呼叫端可以回去，不適用。
  examples:
    bad: |
      my_func:
          addi    sp, sp, -16
          sw      ra, 12(sp)
          mv      s0, a0
          call    helper
          lw      ra, 12(sp)
          addi    sp, sp, 16
          ret
    good: |
      my_func:
          addi    sp, sp, -16
          sw      ra, 12(sp)
          sw      s0, 8(sp)
          mv      s0, a0
          call    helper
          lw      s0, 8(sp)
          lw      ra, 12(sp)
          addi    sp, sp, 16
          ret
`;

export const CONFIG_TEMPLATE = `# sensAI 專案設定（進版控）
#
# 只放團隊共同的決定。每台機器各自的設定 —— CCR 位址、model、逾時 ——
# 走 VS Code settings，不要放在這裡。

privacy:
  # 命中的檔案完全跳過審查，不會外送任何內容。
  # 受審檔案或它引用到的任何 header 命中，整次審查就跳過。
  never_send:
    - "**/crypto/**"

  # 每次外送寫一筆 JSONL 記錄，讓資安稽核有跡可循。
  audit_log: .sensai/sent.log

# 組語審查時要注入哪一組 ABI 事實（暫存器用途、呼叫慣例、對齊要求）。
# 可用：riscv32-andes-v5、armv7e-m
assembly:
  arch: riscv32-andes-v5
`;

export const GITIGNORE_TEMPLATE = `# 本機靜音清單，使用者個人的判斷，不進版控 ——
# 規則的變更走 .sensai/rules.yaml 的 PR。
local-mutes.json

# 稽核日誌是本機記錄。
sent.log
`;
