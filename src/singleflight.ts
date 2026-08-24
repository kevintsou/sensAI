/**
 * 同一個 key 同時只跑一輪工作；跑的期間進來的請求合併成一次補跑。
 *
 * 從 Controller 抽出來，是因為這裡的正確性完全取決於「檢查」與「登記」之間
 * 有沒有讓出事件迴圈 —— 那種錯誤讀程式碼很難看出來，得真的跑併發情境才驗得到，
 * 而 Controller 依賴 vscode，在單元測試裡跑不起來。
 */
export interface SingleFlightHooks<T> {
  /**
   * 已經有待補跑的值時，怎麼跟新進來的合併。
   * 回傳值就是補跑要用的值。
   */
  merge: (existing: T | undefined, incoming: T) => T;
  /** 這次被併入下一輪時呼叫。 */
  onCoalesce?: (key: string) => void;
  /** 補跑開始前呼叫。 */
  onRerun?: (key: string) => void;
  /**
   * 待補跑的佇列排空、這一輪即將結束前呼叫，名額**還沒放開**。
   *
   * 給呼叫端一個「安靜下來了」的鉤子：burst 期間可以先跑便宜的版本，
   * 等這裡再把完整的補回來。在這裡面排進去的新工作仍然會被接住，
   * 不會變成並行。
   */
  onSettled?: (key: string) => void | Promise<void>;
}

/** 傳給 task 的這一輪資訊。 */
export interface RunInfo {
  /** true 代表這輪是把期間累積的觸發補跑，不是原本那一輪。 */
  rerun: boolean;
}

export type RunOutcome = "ran" | "coalesced";

export class SingleFlight<T> {
  private readonly inFlight = new Set<string>();
  private readonly pending = new Map<string, T>();

  constructor(private readonly hooks: SingleFlightHooks<T>) {}

  /**
   * `task` 在同一個 key 上不會有兩份同時在跑。
   *
   * 回 "coalesced" 代表這次沒有自己跑，已經記成待補跑；
   * 回 "ran" 代表這次跑完了，而且把期間累積的補跑也一併跑完。
   */
  async run(
    key: string,
    value: T,
    task: (value: T, info: RunInfo) => Promise<void>,
  ): Promise<RunOutcome> {
    if (this.inFlight.has(key)) {
      this.pending.set(key, this.hooks.merge(this.pending.get(key), value));
      this.hooks.onCoalesce?.(key);
      return "coalesced";
    }

    // 登記必須跟上面的檢查在同一個同步區塊裡。中間只要有一次 await，
    // 兩個連續的觸發就會雙雙通過守衛，跑出兩份並行的工作。
    this.inFlight.add(key);
    try {
      let current = value;
      let rerun = false;
      for (;;) {
        await task(current, { rerun });
        let next = this.pending.get(key);
        if (next === undefined) {
          // 排空了。onSettled 仍在名額內執行，它自己可能又排進新的工作，
          // 所以要再看一次才能真的收工。
          await this.hooks.onSettled?.(key);
          next = this.pending.get(key);
          if (next === undefined) {
            break;
          }
        }
        // 補跑期間 inFlight 不放開 —— 放開的話，這個空隙進來的觸發
        // 會被當成沒人在跑，變成並行。
        this.pending.delete(key);
        this.hooks.onRerun?.(key);
        current = next;
        rerun = true;
      }
    } finally {
      this.inFlight.delete(key);
    }
    return "ran";
  }

  /** 測試與診斷用。 */
  isInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }
}
