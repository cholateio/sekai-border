## Sekai Archive Ranking Crawler

這是一個 Node.js 資料抓取腳本，專門用於 **Sekai Archive** 專案。它負責從 API 定期抓取《世界計畫 (Project Sekai)》的活動排名數據（Top 100 與分數線）。

### 抓什麼

上游是 hisekai.org 的兩支 API：

- `/tw/event/live/top100` — 取名次 1-10、20、30 … 100（共 19 個）
- `/tw/event/live/border` — 取名次 200、300、400、500、1000 … 10000（共 11 個）

每次執行寫入 30 筆到 Supabase 的 `event_rankings`（欄位 `rank` / `score` / `event_id` / `created_at`），同一批共用同一個 `created_at` 當作快照時間戳。

活動更替時（API 的 `id` 與資料庫最新一筆的 `event_id` 不同）會**清空所有舊活動的資料**——本專案只保留當前活動，不留歷史。

### 部署現況

已上線，正常運作中：

| | |
|---|---|
| Cloud Run | `sekai-border`（GCP 專案 `sekai-archive`，region `asia-east1`） |
| 規格 | 1 vCPU / 512 MiB，min-instances **0**（無閒置計費） |
| Cloud Scheduler | `sekai-border`，`*/5 * * * *`（Asia/Taipei），POST 打 Cloud Run |
| 資料庫 | Supabase 專案 `SekaiArchive` |

重新部署（**先在本機 build 過再上**，並先用 `--no-traffic` 驗證候選版本）：

```bash
docker build -t sekai-border-test .              # 本機確認建得起來、跑得動
gcloud run deploy sekai-border --source . --region asia-east1 \
  --project sekai-archive --no-traffic --tag candidate
curl -X POST https://candidate---sekai-border-trqcq3feoq-de.a.run.app/   # 應回 200
gcloud run services update-traffic sekai-border --to-latest \
  --region asia-east1 --project sekai-archive
```

`package-lock.json` 有納入版控、Dockerfile 用 `npm ci`——這是刻意的。少了它，重建同一份程式碼會裝到不同版本的相依套件（見 `docs/LESSONS.md`）。

### 本機執行

```bash
npm install
node fetch_all_rankings.js
```

需要 `.env`：

```
SUPABASE_URL=...
SUPABASE_KEY=...
BOT_CONTACT=...   # 選填，會當作 User-Agent 送給上游 API
```

⚠️ 這支腳本會寫入**正式** Supabase，且偵測到新活動時會刪除舊活動的所有資料。要測試請改用測試專案或空表。

### 檔案

- `index.js` — Cloud Run 版本（HTTP server 監聽 8080，由 Scheduler 觸發）
- `fetch_all_rankings.js` — 本機一次性執行版本，抓取邏輯與 `index.js` 重複，**改一邊要同步另一邊**
- `Dockerfile` — Cloud Run build 用
- `docs/LESSONS.md` — 踩過的坑
