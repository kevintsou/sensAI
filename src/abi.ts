/**
 * 架構事實 —— 不是規則。
 *
 * ABI 表、暫存器用途這些東西每個專案都一樣，內建在擴充裡自動注入，
 * 專案不用各自重寫一次。判斷「什麼算問題」的規則仍然全部走
 * `.sensai/rules.yaml`，由開發者控制 —— 治理邊界沒有破口。
 */
export interface ArchFacts {
  id: string;
  label: string;
  text: string;
}

const RISCV_ANDES_V5: ArchFacts = {
  id: "riscv32-andes-v5",
  label: "RISC-V RV32（Andes AndeStar V5）",
  text: `目標架構：RISC-V RV32，Andes AndeStar V5。組譯語法為 GAS。

暫存器與呼叫慣例（標準 RISC-V ABI）：
- x0/zero 恆為 0，寫入無效
- x1/ra   return address。函式內若有呼叫其他函式，必須先存起來再呼叫
- x2/sp   stack pointer。**函式邊界必須維持 16-byte 對齊**
- x3/gp、x4/tp  全域指標與執行緒指標，一般程式碼不應改動
- x5-x7/t0-t2、x28-x31/t3-t6  caller-saved，可自由使用，不需保存
- x8/s0(fp)、x9/s1、x18-x27/s2-s11  **callee-saved，修改前必須保存、返回前必須還原**
- x10-x17/a0-a7  參數暫存器，同時是 caller-saved
- a0、a1  回傳值

其他重點：
- 返回指令為 ret（jalr zero, ra, 0 的別名）
- 修改 CSR 之後若影響取指或後續存取，需要適當的 fence 或 fence.i
- MMIO 存取之間若有順序需求，需要 fence iorw, iorw；純粹的資料相依不保證順序
- Andes 專有擴充（CoDense 的 exec.it、專有 CSR）只在對應的 -march 下合法

葉子函式（不呼叫任何其他函式）不需要保存 ra。`,
};

const ARMV7_M: ArchFacts = {
  id: "armv7e-m",
  label: "ARMv7E-M（Cortex-M）",
  text: `目標架構：ARMv7E-M（Cortex-M），Thumb-2。組譯語法為 GAS。

暫存器與呼叫慣例（AAPCS）：
- r0-r3   參數與回傳值，caller-saved
- r4-r11  **callee-saved，修改前必須保存、返回前必須還原**
- r12/ip  caller-saved（intra-procedure scratch）
- r13/sp  stack pointer。**公開介面上必須維持 8-byte 對齊**
- r14/lr  return address。函式內若有呼叫其他函式，必須先存起來
- r15/pc  program counter

其他重點：
- 返回指令為 bx lr，或 pop {..., pc}
- 64-bit 參數必須對齊到偶數編號的暫存器對（r0/r1 或 r2/r3），不可跨 r1/r2
- 寫入設定暫存器後若後續行為相依，需要 DSB；改動取指相關設定需要 ISB
- 中斷向量表的對齊需符合 VTOR 的要求

葉子函式（不呼叫任何其他函式）不需要保存 lr。`,
};

const ARCHES = [RISCV_ANDES_V5, ARMV7_M];

export const DEFAULT_ARCH_ID = RISCV_ANDES_V5.id;

export function archFacts(id: string): ArchFacts {
  return ARCHES.find((a) => a.id === id) ?? RISCV_ANDES_V5;
}

export function knownArchIds(): string[] {
  return ARCHES.map((a) => a.id);
}
