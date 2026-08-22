/*
 * 驗證用的範例檔案（組合語言版，對應 uart_dma.c）。
 *
 * 目標架構：RISC-V RV32，Andes AndeStar V5。
 * 這裡刻意埋了幾個 .sensai/rules.yaml 涵蓋的錯誤，同時也放了幾段
 * 「看起來像但其實正確」的程式碼 —— 後者用來檢查誤報。
 *
 * 用法：在 VS Code 開啟本檔並存檔，或執行「sensAI: Review Current File」。
 * 期待的結果寫在檔案最後面。
 */

    .include "soc_defs.inc"

    .section .text
    .option nopic

/* ------------------------------------------------------------------ */
/* uint32_t uart_get_status(void);                                     */
/*                                                                     */
/* 葉子函式，只用 caller-saved 暫存器，不呼叫任何東西。                 */
/* 沒有保存 t0 或 ra 都是正確的。                                       */
    .globl  uart_get_status
    .type   uart_get_status, @function
uart_get_status:
    li      t0, UART0_BASE
    lw      a0, UART_STATUS(t0)
    ret
    .size   uart_get_status, .-uart_get_status

/* ------------------------------------------------------------------ */
/* void uart_send_byte(uint8_t b);                                     */
    .globl  uart_send_byte
    .type   uart_send_byte, @function
uart_send_byte:
    li      t0, UART0_BASE
    sw      a0, UART_DATA(t0)

    li      t1, UART_CTRL_TXSTART
    sw      t1, UART_CTRL(t0)
    lw      t2, UART_STATUS(t0)

    andi    t2, t2, UART_STATUS_TXDONE
    ret
    .size   uart_send_byte, .-uart_send_byte

/* ------------------------------------------------------------------ */
/* void uart_clear_txdone(void);                                       */
    .globl  uart_clear_txdone
    .type   uart_clear_txdone, @function
uart_clear_txdone:
    li      t0, UART0_BASE
    lw      t1, UART_STATUS(t0)
    ori     t1, t1, UART_STATUS_TXDONE
    sw      t1, UART_STATUS(t0)
    ret
    .size   uart_clear_txdone, .-uart_clear_txdone

/* ------------------------------------------------------------------ */
/* void uart_send_buffer(const uint8_t *buf, uint32_t len);            */
    .globl  uart_send_buffer
    .type   uart_send_buffer, @function
uart_send_buffer:
    addi    sp, sp, -12
    sw      ra, 8(sp)

    mv      s0, a0
    mv      s1, a1

.Lsend_loop:
    beqz    s1, .Lsend_done
    lbu     a0, 0(s0)
    call    uart_send_byte
    addi    s0, s0, 1
    addi    s1, s1, -1
    j       .Lsend_loop

.Lsend_done:
    lw      ra, 8(sp)
    addi    sp, sp, 12
    ret
    .size   uart_send_buffer, .-uart_send_buffer

/* ------------------------------------------------------------------ */
/* void uart_send_dma(const uint8_t *buf, uint32_t len);               */
    .globl  uart_send_dma
    .type   uart_send_dma, @function
uart_send_dma:
    li      t0, DMA0_BASE
    sw      a0, DMA_SRC(t0)
    sw      a1, DMA_LEN(t0)

    call    dma_cache_clean

    li      t1, DMA_CTRL_START
    sw      t1, DMA_CTRL(t0)
    ret
    .size   uart_send_dma, .-uart_send_dma

/* ------------------------------------------------------------------ */
/* uint32_t uart_checksum(const uint8_t *buf, uint32_t len);           */
    .globl  uart_checksum
    .type   uart_checksum, @function
uart_checksum:
    addi    sp, sp, -16
    sw      s0, 12(sp)

    beqz    a1, .Lsum_empty

    li      t0, 0
    mv      s0, a0
.Lsum_loop:
    beqz    a1, .Lsum_done
    lbu     t1, 0(s0)
    add     t0, t0, t1
    addi    s0, s0, 1
    addi    a1, a1, -1
    j       .Lsum_loop

.Lsum_done:
    mv      a0, t0
    lw      s0, 12(sp)
    addi    sp, sp, 16
    ret

.Lsum_empty:
    lw      t2, 0(a2)
    ret
    .size   uart_checksum, .-uart_checksum

/* ------------------------------------------------------------------ */
/* uint32_t uart_poll_rx(uint8_t *out);                                */
/*                                                                     */
/* 正確的非葉子函式：ra 與 s0 都有保存與還原，sp 平衡且 16-byte 對齊。 */
    .globl  uart_poll_rx
    .type   uart_poll_rx, @function
uart_poll_rx:
    addi    sp, sp, -16
    sw      ra, 12(sp)
    sw      s0, 8(sp)

    mv      s0, a0
    call    uart_get_status
    andi    a0, a0, UART_STATUS_RXREADY
    beqz    a0, .Lpoll_none

    li      t0, UART0_BASE
    lbu     t1, UART_DATA(t0)
    sb      t1, 0(s0)
    li      a0, 1

.Lpoll_none:
    lw      s0, 8(sp)
    lw      ra, 12(sp)
    addi    sp, sp, 16
    ret
    .size   uart_poll_rx, .-uart_poll_rx

/*
 * 期待的結果
 *
 * 應該回報：
 *   uart_send_byte    寫 CTRL 後立刻讀 STATUS，中間沒有 fence（asm-mmio-ordering）
 *   uart_clear_txdone 用 lw / ori / sw 去清 W1C 位元，會把其他旗標一起清掉
 *                     （w1c-status-bits）
 *   uart_send_buffer  改了 s0、s1 但沒有保存與還原（asm-callee-saved）
 *   uart_send_buffer  addi sp, sp, -12 不符合 16-byte 對齊（asm-stack-alignment）
 *   uart_send_dma     呼叫 dma_cache_clean 前沒有保存 ra（asm-return-address）
 *   uart_checksum     .Lsum_empty 路徑沒有還原 sp 與 s0 就 ret（asm-stack-balance）
 *   uart_checksum     讀取 a2，但 C 宣告只有兩個參數；且該路徑沒有設定 a0
 *                     （asm-c-abi-match）
 *
 * 不應該回報：
 *   uart_get_status   葉子函式，只用 t0，不需要保存任何東西
 *   uart_send_byte    使用 t0 到 t2 不需要保存 —— 那是 caller-saved
 *   uart_poll_rx      ra 與 s0 都正確保存還原，sp 平衡且對齊
 *
 * 有報到「不應該回報」的項目，代表對應規則的 except 或架構事實需要調整。
 */
