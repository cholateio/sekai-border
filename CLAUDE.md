# Sekai Border (Sekai Archive Ranking Crawler)

> CLAUDE.md（kit v4.3）。本檔只放「這個專案是什麼」——工作流、派工、
> review 規則由 `.claude/rules/` 自動載入（kit-owned，別在專案裡改）。
> 首次使用：跑 `claude`，貼上 `init.sh` 結尾印出的 bootstrap prompt，
> 讓 AI 幫你把 [佔位符] 填掉。

## Project goal

Sekai Archive 專案的後端爬蟲：定時從 hisekai.org API 抓《Project Sekai
(世界計畫)》活動排名（Top 100 與各名次分數線），寫入 Supabase 供後續查詢／
存檔。給 Sekai Archive 自己用的資料收集器。

## Stack

- Language: Node.js 20 (CommonJS, 無 TypeScript)
- Framework: @google-cloud/functions-framework 3.x（Cloud Run 部署；
  index.js 另起一個裸 http server 監聽 8080）
- Datastore: Supabase（PostgreSQL）—— table `event_rankings`
- Build/run: `npm install` 後，本機一次性抓取 `node fetch_all_rankings.js`
  （需 `.env` 帶 `SUPABASE_URL` / `SUPABASE_KEY`，選填 `BOT_CONTACT`）；
  Cloud Run 進入點 `node index.js`（或 `npm start` 走 functions-framework）
- Test: 無測試套件（package.json 無 test script）。改動後驗證方式：本機備妥
  `.env` 跑 `node fetch_all_rankings.js`，確認無錯誤並有寫入 Supabase

## File layout

- `index.js` — Cloud Run 部署版：`exports.runFetch` handler + 裸 http server
  監聽 8080，由 Cloud Scheduler 打 HTTP 觸發
- `fetch_all_rankings.js` — 本機／獨立版：`require('dotenv')` 讀 .env、跑一次
  即結束。抓取＋清舊資料邏輯與 index.js 幾乎重複（改一邊記得同步另一邊）
- `Dockerfile` — node:20-slim，`CMD ["node","index.js"]`，供 Cloud Run build
- `package.json` — deps 只有 functions-framework 與 @supabase/supabase-js
- `README.md` — 專案簡介（user 維護，勿動）

## Project-specific constraints（禁區與硬規則）

- 執行 `node index.js` / `node fetch_all_rankings.js` / `npm start`：會打真實
  hisekai.org API 並「寫入且可刪除」真實 Supabase `event_rankings` 表——
  `checkAndClearOldEvent` 偵測到新 event 會 DELETE 掉所有舊 event 的 rows
  （index.js / fetch_all_rankings.js 第 57 行）。別為了測試就對正式憑證跑；
  要驗證改動請用測試用 Supabase 專案或空表。# 候選,待 user 確認
- 硬編碼外部契約：API 回傳欄位 `player_top_100_rankings` /
  `player_border_rankings` / `.id` / `.rank` / `.score`，與 DB 欄位
  `event_rankings(rank, score, event_id, created_at)`——改欄位名前先確認上游
  hisekai.org API 回傳格式與 Supabase schema，否則靜默寫壞。# 候選,待 user 確認

**同步執法**：上面每一條「路徑型」禁區，都要把路徑同步加進
`.claude/protected-paths`（一行一個 glob，`*` 會跨目錄層級，
`src/legacy/` 結尾斜線代表整棵子樹）——PreToolUse hook 會物理擋下
對這些路徑的編輯，不再只靠模型自律。放寬或刪除任何一條需要 user
明確同意（見 kit-evolution 規則）。

## 檔案路由（需要時才讀，不用背）

| 情境 | 讀這裡 |
|------|--------|
| 卡關了 / 想宣告完成 / 猶豫要不要問 user | `.claude/docs/judgment-matrix.md` |
| 要派工給 subagent | `/kit-dispatch` skill（五種模板） |
| 要記教訓 / 查歷史教訓 / 想改 harness 檔案 | `docs/LESSONS.md`（append；動大手術前先掃一眼）/ kit-evolution 規則（自動已載入） |
| 有 spec 的功能 | `docs/specs/`（spec 是需求的唯一權威來源） |
| 要做 UI / 設計 schema / 同一 bug 連續卡 / 引入外部服務 / 定架構 | `.claude/docs/verification-signals.md`（命中哪節讀哪節） |

（review / isolation / 任務 sizing / 派工升降級 / 判斷層的規則不在
本檔——`.claude/rules/` 的 kit-workflow、kit-delegation、kit-evolution、
kit-judgment 已自動載入每個 session，直接遵守即可。）
