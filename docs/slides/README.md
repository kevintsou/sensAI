# 主管簡報

`docs/sensAI_報告.pptx`（16:9，13 頁）的產生原始碼。

## 重新產生

```
pip install python-pptx
python3 docs/slides/build.py
```

輸出覆寫 `docs/sensAI_報告.pptx`。

## 內容

| 頁 | 主題 |
|---:|---|
| 1 | 封面 |
| 2 | 一頁摘要（四個關鍵數字 + 問題／做法／請求） |
| 3 | 問題：為什麼韌體特別需要（含 phal_sys.c 案例） |
| 4 | 運作方式：六個步驟 + 三層節流 |
| 5 | 關鍵設計一：規則即團隊資產 |
| 6 | 關鍵設計二：觸發條件／後果／依據，三道防幻覺防線 |
| 7 | 實機畫面：範例檔審查 |
| 8 | 實戰驗證：真實專案的真實缺陷 |
| 9 | 資安與治理 |
| 10 | 目前進度與已知限制 |
| 11 | 目前已有的數據與出處 |
| 12 | 如何驗證效益：採納率與指標分層 |
| 13 | 下一步與所需支援 |

## 圖片素材

`assets/` 下的 PNG 由同目錄的 HTML 以 headless Chromium 截圖而來：

```
chromium --headless --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1562,642 --screenshot=assets/real.png assets/real.html
```

- `panel.html` / `panel.png` —— 範例檔 `examples/uart_dma.c` 的審查畫面**示意圖**。
  版面與樣式取自 `src/panel.ts`，意見內容對應 `examples/uart_dma.c` 檔尾列出的預期
  結果，中繼列的數字（6 則意見、3 個 header、8.4s）為示意，非實機量測值。
- `rules.html` / `rules.png` —— `.sensai/rules.yaml` 的編輯器畫面。
- `real.html` / `real.png` —— ps5032 專案 `phal_sys.c` 的實際審查結果重繪。
  數字（1 則意見、18 個 header、65.9s）與意見全文取自實機截圖。
  若要換成原始截圖，直接覆蓋 `assets/real.png` 後重跑 `build.py`。

## 頁面數字的出處

| 數字 | 出處 |
|---|---|
| 3,603 行 / 19 模組 | `wc -l src/*.ts` |
| 1,495 行測試 / 96 項全過 | `wc -l test/*` ／ `npm test` |
| 45 次提交 / 14 天 | `git log`（2026-08-22 ～ 09-04） |
| 10 條規則（error 8 / warning 2） | `.sensai/rules.yaml` |
| 2 組 ABI | `src/abi.ts`（riscv32-andes-v5、armv7e-m） |
| 去抖動 1,000 ms／120 KB／深度 2 | `package.json` 的 `contributes.configuration` 預設值 |
| 65.9s / 18 header / 7 個月 | ps5032 專案 `phal_sys.c` 的實機審查（n=1） |
