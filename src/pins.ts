import * as crypto from "crypto";
import { Finding, PinnedFinding } from "./types";

/**
 * 釘選的 key 綁在「檔案 + 規則 + 訊息 + 那一行的內容」上，**不**綁行號。
 *
 * 行號不能算進去：在被釘的那行上方插入或刪除任何一行，行號就位移，key 跟著變，
 * 同一則意見會被當成沒釘過 —— 勾選框顯示未釘，再點一次就多出一筆重複的釘選。
 * 而編輯上方的程式碼是再平常不過的事。
 *
 * 改用那一行的內容當識別：上方怎麼增刪都不影響，而同一個檔案裡兩則規則與訊息
 * 都相同、只是位置不同的意見，也還能靠各自的程式碼區分開來。
 *
 * 跟 muteKey 的差別在於這裡不含行號、muteKey 也不含檔案路徑 —— 兩者的語意本來
 * 就不同：靜音是「這個判斷在這段程式碼上是誤報」，釘選是「我要留著這則意見和
 * 我寫的筆記」。至於已經釘住的記錄，不會因為那行程式碼被改動而消失：記錄本身
 * 連同筆記都存著，照樣列在釘選區，只是不再與新一輪的同一則意見自動對應。
 */
export function pinKey(filePath: string, f: Finding, lineText: string): string {
  const normalized = lineText.trim().replace(/\s+/g, " ");
  return crypto
    .createHash("sha1")
    .update([filePath, f.rule_id ?? "", f.message, normalized].join("\u0000"))
    .digest("hex");
}

/**
 * 儲存的抽象。實際上接 vscode 的 workspaceState —— 專案級、跨重啟保留、
 * 不進版控。抽成介面是為了測試時不必拉起 vscode。
 */
export interface PinBackingStore {
  get(): PinnedFinding[];
  set(records: PinnedFinding[]): void | Promise<void>;
}

/**
 * 釘選清單。使用者釘住的意見不會被後續 review 蓋掉，並且可以附上筆記。
 *
 * 與 MuteStore 平行，但存到 workspaceState 而非 .sensai/ 底下的檔案：
 * 釘選與筆記是個人的工作記錄，不是團隊共用的資產，沒有進版控的理由。
 */
export class PinStore {
  private records = new Map<string, PinnedFinding>();

  constructor(private readonly backing: PinBackingStore) {
    for (const r of backing.get()) {
      if (r && typeof r.key === "string") {
        this.records.set(r.key, r);
      }
    }
  }

  private persist(): void {
    void this.backing.set([...this.records.values()]);
  }

  has(key: string): boolean {
    return this.records.has(key);
  }

  /** 釘住一則意見。已存在就不覆蓋 —— 保留使用者原本寫的筆記。 */
  add(record: PinnedFinding): void {
    if (this.records.has(record.key)) {
      return;
    }
    this.records.set(record.key, record);
    this.persist();
  }

  remove(key: string): void {
    if (this.records.delete(key)) {
      this.persist();
    }
  }

  /** 更新某則釘選的筆記。找不到 key 就當作沒事 —— 面板重繪的時序偶爾會慢半拍。 */
  setComment(key: string, comment: string): void {
    const rec = this.records.get(key);
    if (!rec) {
      return;
    }
    rec.comment = comment;
    this.persist();
  }

  all(): PinnedFinding[] {
    return [...this.records.values()];
  }

  clear(): number {
    const n = this.records.size;
    this.records.clear();
    this.persist();
    return n;
  }
}
