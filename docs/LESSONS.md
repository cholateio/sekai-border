# LESSONS

### 2026-07-28 沒有 lockfile 的重建＝重新擲骰子，害正式服務中斷一次
- Context: 修好兩個 bug 後 `gcloud run deploy --source .` 直接部署到正式服務，沒有先在本機建 image 驗證，也沒有先用 `--no-traffic` 試跑。
- Error: `[Fatal Error] Node.js 20 detected without native WebSocket support.` 每次執行 4ms 就 500、零寫入。`package-lock.json` 被 `.gitignore` 排除，Dockerfile 又用 `npm install`（非 `npm ci`），所以 build 抓到當下最新的 `@supabase/supabase-js` 2.111.0，它需要 Node 22+ 的原生 WebSocket，而 base image 是 `node:20-slim`。四月建的舊 image 鎖在當時的版本才沒事——**程式碼沒變，build 時間變了，結果就變了**。
- Solution: 回滾流量到前一個 revision 先恢復服務（損失一個快照）；base image 改 `node:22-slim`、Dockerfile 改 `npm ci --omit=dev`、`package-lock.json` 從 `.gitignore` 移除並納入版控；本機 `docker build` + 實跑容器驗證後，再用 `--no-traffic --tag` 部署候選版本單獨測，確認 200 與寫入才切流量。
- Rule: 部署前先在本機 build 並跑起來；切正式流量前先用 `--no-traffic --tag` 驗證候選 revision。相依套件沒有 lockfile 就等於沒有版本控制——`npm install` 配 `^` 版本範圍，任何一次重建都可能裝進不同的東西。

### 2026-07-28 成功寫入卻回 500：錯把 Express 的 res API 用在原生 ServerResponse
- Context: 上線後從沒人看 log，資料一直正常寫入 Supabase，直到查 Cloud Run log 才發現每次執行都是紅的（近 6h 取樣 14/14 回 500）。
- Error: `res.status is not a function` → `[Fatal Error] res.status is not a function`。`index.js` 用 `http.createServer` 傳進來的是原生 `ServerResponse`，沒有 Express 的 `.status().send()`。抓取與寫入其實都成功了，是「回應」這一步才炸；更糟的是 `catch` 裡的 `res.status(500)` 又炸第二次，才冒泡到外層被 `writeHead(500)` 接住。
- Solution: 改用原生 `writeHead`/`end`（Express 的 res 也繼承這兩個方法，functions-framework 路徑同樣正確），並包成帶 `headersSent` 護欄的 `sendPlain`，讓錯誤處理路徑不可能再炸第二次。
- Rule: 錯誤處理路徑本身必須是不會拋例外的——寫回應前先確認 res 的型別，並在 catch 內的回應加 `headersSent` 護欄。

### 2026-07-28 number !== text：型別不符讓破壞性 DELETE 每次執行都觸發
- Context: `checkAndClearOldEvent` 只該在活動更替時清空舊資料，log 卻每 5 分鐘出現一次「新活動」。
- Error: `[System] New event detected (Old: 174, New: 174). Clearing old data...` — 新舊值印出來一模一樣卻判定不等。上游 API 的 `id` 是 JSON number `174`，DB `event_rankings.event_id` 是 text 欄位存 `'174'`，`174 !== '174'` 恆為真。沒造成資料損失純粹是因為當下只有一個活動，刪不到東西。
- Solution: 在來源處 `String(dataTop100.id)` 正規化，讓比較兩邊同型別；`fetch_all_rankings.js` 同步改。
- Rule: 跨越 API/DB 邊界的值在用 `===`/`!==` 比較前先正規化型別——尤其當比較結果會決定要不要跑破壞性操作時，型別不符會讓守門條件靜默失效。

### 2026-07-28 只看資料不看 log，會漏掉一半的故障訊號
- Context: 先查 Supabase 確認寫入正常（1452 個快照、零缺漏）就判定「運行正常」，之後查 Cloud Run log 才發現 HTTP 層每次都失敗。
- Error: 兩個 bug 都存在數週以上沒被發現，因為它們的症狀只出現在 log，不出現在資料。而且 Scheduler 狀態永遠是 `code: 13`、Cloud Run 錯誤率永遠 100%，等於監控訊號被永久噪音淹沒——真的壞掉時看起來跟現在一模一樣。
- Rule: 判斷排程服務健康，資料面（有沒有寫進去）和執行面（回傳碼／log severity）要分開各查一次，兩邊都綠才算正常。
