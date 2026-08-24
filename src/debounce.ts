/**
 * 每個 key 各自的去抖動計時器。
 *
 * 存檔事件本身很密集（自動存檔預設 1 秒一次，加上手動存檔），但「使用者停下來了」
 * 才是值得審查的時機 —— 打到一半的程式碼審了也只是製造雜訊，而且審完就過期。
 *
 * 不依賴 vscode，這樣併發與時序行為才測得到。
 */
export class Debouncer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** 排程 key 的工作。同一個 key 重複呼叫會把前一次的計時重新計算。 */
  schedule(key: string, delayMs: number, fn: () => void): void {
    this.cancel(key);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      fn();
    }, delayMs);
    // 不要因為還有計時器就擋著 Node 結束（測試會用到）。
    timer.unref?.();
    this.timers.set(key, timer);
  }

  /** 取消 key 尚未觸發的工作。已經觸發的不受影響。 */
  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /** 測試與診斷用。 */
  isPending(key: string): boolean {
    return this.timers.has(key);
  }
}
