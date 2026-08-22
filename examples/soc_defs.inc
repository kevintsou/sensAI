/* 範例 SoC 常數定義（組語版）。
   用來驗證 .include "..." 的解析有沒有把常數帶進上下文。 */

    .equ    UART0_BASE,         0x40001000
    .equ    UART_CTRL,          0x00
    .equ    UART_STATUS,        0x04
    .equ    UART_DATA,          0x08
    .equ    UART_BAUD,          0x0C

    .equ    UART_CTRL_ENABLE,   0x01
    .equ    UART_CTRL_TXIE,     0x02
    .equ    UART_CTRL_TXSTART,  0x10

/* 以下三個狀態位元為 write-1-clear */
    .equ    UART_STATUS_TXDONE, 0x01
    .equ    UART_STATUS_RXREADY,0x02
    .equ    UART_STATUS_OVERRUN,0x04

    .equ    DMA0_BASE,          0x40002000
    .equ    DMA_CTRL,           0x00
    .equ    DMA_SRC,            0x04
    .equ    DMA_LEN,            0x0C
    .equ    DMA_CTRL_START,     0x01
