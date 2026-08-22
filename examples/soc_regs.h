/* 範例 SoC 暫存器定義。用來驗證 #include 解析有沒有把 macro 帶進上下文。 */
#ifndef SOC_REGS_H
#define SOC_REGS_H

#include <stdint.h>

typedef struct {
    volatile uint32_t CTRL;
    volatile uint32_t STATUS;   /* 中斷旗標為 write-1-clear */
    volatile uint32_t DATA;
    volatile uint32_t BAUD;
} uart_regs_t;

typedef struct {
    volatile uint32_t CTRL;
    volatile uint32_t SRC;
    volatile uint32_t DST;
    volatile uint32_t LEN;
} dma_regs_t;

#define UART0 ((uart_regs_t *)0x40001000u)
#define DMA0  ((dma_regs_t  *)0x40002000u)

#define UART_CTRL_ENABLE      (1u << 0)
#define UART_CTRL_TXIE        (1u << 1)
#define UART_CTRL_RXIE        (1u << 2)

/* 以下三個位元為 write-1-clear */
#define UART_STATUS_TXDONE    (1u << 0)
#define UART_STATUS_RXREADY   (1u << 1)
#define UART_STATUS_OVERRUN   (1u << 2)

#define DMA_CTRL_START        (1u << 0)
#define DMA_CH0               0u

#define EVENT_RX              (1u << 0)
#define EVENT_TX              (1u << 1)

void dma_start(uint32_t ch, const void *buf, uint32_t len);
void dma_cache_clean(const void *buf, uint32_t len);
void dma_cache_invalidate(void *buf, uint32_t len);
void delay_us(uint32_t us);

#endif /* SOC_REGS_H */
