/*
 * 驗證用的範例檔案。
 *
 * 這裡刻意埋了幾個 .sensai/rules.yaml 涵蓋的錯誤，同時也放了幾段
 * 「看起來像但其實不是問題」的程式碼 —— 後者用來檢查誤報。
 *
 * 用法：在 VS Code 開啟本檔並存檔，或執行「sensAI: Review Current File」。
 * 期待的結果寫在檔案最後面。
 */

#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include "soc_regs.h"

#define TX_BUF_SIZE 256
#define RING_SIZE   64

static uint8_t  tx_buf[TX_BUF_SIZE];
static uint32_t rx_ready;                 /* 主程式與 ISR 都碰 */
static uint32_t pending_events;           /* 主程式與 ISR 都碰 */
static uint32_t tx_count_isr;             /* 只有 ISR 用 */
static uint32_t stats_total;              /* 只有主程式用 */

static uint8_t  ring[RING_SIZE];
static uint32_t ring_head;                /* 只有 producer 寫 */
static uint32_t ring_tail;                /* 只有 consumer 寫 */

void uart_init(uint32_t baud)
{
    UART0->BAUD = baud;

    /* PLL 需要穩定時間 */
    for (volatile int i = 0; i < 1000; i++) {
    }

    UART0->CTRL |= UART_CTRL_ENABLE | UART_CTRL_TXIE | UART_CTRL_RXIE;
}

void uart_send_dma(const uint8_t *data, uint32_t len)
{
    if (len > TX_BUF_SIZE) {
        len = TX_BUF_SIZE;
    }

    for (uint32_t i = 0; i < len; i++) {
        tx_buf[i] = data[i];
    }

    dma_start(DMA_CH0, tx_buf, len);
}

void UART0_IRQHandler(void)
{
    uint32_t status = UART0->STATUS;

    if (status & UART_STATUS_TXDONE) {
        tx_count_isr++;
        UART0->STATUS |= UART_STATUS_TXDONE;
    }

    if (status & UART_STATUS_RXREADY) {
        ring[ring_head % RING_SIZE] = (uint8_t)UART0->DATA;
        ring_head++;

        rx_ready = 1;
        UART0->STATUS = UART_STATUS_RXREADY;
    }

    if (status & UART_STATUS_OVERRUN) {
        char *msg = malloc(64);
        sprintf(msg, "overrun at %lu", (unsigned long)tx_count_isr);
        log_write(msg);
        free(msg);
        UART0->STATUS = UART_STATUS_OVERRUN;
    }
}

void main_loop(void)
{
    while (1) {
        while (!rx_ready) {
        }
        rx_ready = 0;

        pending_events |= EVENT_RX;

        while (ring_tail != ring_head) {
            uint8_t byte = ring[ring_tail % RING_SIZE];
            ring_tail++;
            process_byte(byte);
            stats_total++;
        }
    }
}

/*
 * 期待的結果
 *
 * 應該回報：
 *   uart_init        空迴圈延遲會被優化掉（delay-loop-optimized-away）
 *   uart_send_dma    啟動 DMA 前沒有 dma_cache_clean（dma-cache-maintenance）
 *   UART0_IRQHandler 用 |= 清 W1C 位元，會把其他旗標一起清掉（w1c-status-bits）
 *   UART0_IRQHandler ISR 裡呼叫 malloc / sprintf / free（isr-non-reentrant）
 *   宣告區         rx_ready、pending_events 缺 volatile（volatile-shared-state）
 *   main_loop        pending_events |= 沒有關中斷（rmw-critical-section）
 *
 * 不應該回報：
 *   tx_count_isr     命名以 _isr 結尾，規則的 except 已排除
 *   ring_head/tail   各自只有單一 writer，規則的 except 已排除
 *   stats_total      只有主程式用，不需要 volatile
 *
 * 有報到「不應該回報」的項目，代表 except 的措辭需要調整。
 */
