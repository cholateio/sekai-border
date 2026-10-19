# sekai-border — Sekai Archive 榜線爬蟲

Sekai Archive 的資料層。每 5 分鐘從 hisekai.org 抓《世界計畫 Project Sekai》台服活動的榜線（前 100 名與分數線），
存進 Supabase；活動結束後抓最終榜線並把期中曲線壓縮保存，供網站與預測模型使用。所有對 Supabase 的寫入都由這個服務獨占。

設計文件：`docs/superpowers/specs/2026-10-16-data-layer-design.md`（spec，權威來源）、
`docs/superpowers/plans/2026-10-16-data-layer.md`（實作計畫；Task 8 是正式環境的部署／切換／回滾 runbook）。

## 資料

Supabase 兩張表、兩個 view（`supabase/migrations/0001_sekai_border.sql.tmpl`，`{{schema}}` 渲染成 `public` 或 `test`）：

| 物件 | 內容 |
|------|------|
| `sekai_border_events` | 每期活動一列：名稱、起訖時間、型態、團體、加成角色、WL 章節、`finalized_at` |
| `sekai_border_rankings` | `(event_id, chapter, rank, taken_at, is_final)`：chapter 0 = 主榜，1..6 = WL 章節；`is_final` 是最終榜線 |
| `sekai_border_series` / `sekai_border_model` / `sekai_border_forecasts` | 子專案 2（`0002_forecast.sql.tmpl`）：前 1000 名每小時序列（結算時寫入）、訓練參數（固定 1 列）、當期每條線的終線 P10/P50/P90 與路徑（每輪覆寫；anon 只能讀這張） |
| RPC `sekai_border_put_forecasts` / `sekai_border_put_series` | 預測寫入（表鎖 NOWAIT、單調、上限 120 列）；已結算活動補序列（只填 NULL、與 DB 快照一致才提交） |
| `sekai_border_current_report` / `sekai_border_daily_report` | 與舊 view `view_all_ranking_report` / `view_day_ranking_report` 同欄位同型別的相容 view，給網站現有查詢用 |

名次集合（主榜與章節相同，共 30）：1–10、20–100（每 10）、200、300、400、500、1000、1500、2000、2500、3000、5000、10000。
即時快照必須 30 個齊全；最終榜線 1500 與 2500 可缺（WL 章節與約第 110 期以前的主榜沒有這兩條線），其餘 28 個必備。

保留規則：當期每 5 分鐘一個快照；活動結算時前 1000 名寫成每小時序列（`sekai_border_series`；階段一 0002 仍保留這些名次的原始快照，0003／0004 驗證後才刪），1000 名以後壓縮成「結束前 24 小時每小時一點、更早每 3 小時一點」，再加 `is_final` 列。
容量實測見 `docs/superpowers/plans/capacity-2026-10.md`（約 13.8 MB／年）。

## 執行

Cloud Run 私有服務，只接受 `POST /run`（其餘 404），由 Cloud Scheduler 以 OIDC 每 5 分鐘呼叫一次。一輪做四件事：
抓即時榜並寫入當前 slot 的快照（WL 章節另一筆寫入）→ 為當期每條線寫預測 → 到期的活動抓最終榜並結算（單一 Postgres 交易，含序列）→ 有結算就重訓 → 補一列活動屬性（master db）→ 回報。
WL 章節、預測、訓練任一失敗只記 log，不改變狀態碼。
回應 200 代表資料面與執行面都正常；有任何一期結算失敗回 500，Scheduler 的執行紀錄因此能反映真實故障。

環境變數（Cloud Run 上設定；本機放 `.env`，已 gitignore）：

| 變數 | 說明 |
|------|------|
| `SUPABASE_URL` | 專案 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | legacy 格式的 service_role JWT（`eyJ…`）。啟動時驗證 `role === 'service_role'`，不是就拒絕啟動。只能放在 Cloud Run 與本機 `.env` |
| `SUPABASE_SCHEMA` | 預設 `public`；整合測試與本機演練用 `test` |
| `SUPABASE_ANON_KEY` | 只有整合測試需要（驗證 anon 權限） |
| `BOT_CONTACT` | 送給上游的 User-Agent（選填） |

WL 章節即時快照一律嘗試寫入；章節錯誤只記 `wl ingest failed`，主榜不受影響（子專案 2 spec §3.1）。

```bash
npm install
node index.js --once          # 跑一輪就結束；exit 0 = 200
node index.js                 # 啟動 HTTP 伺服器（PORT，預設 8080）
```

`--once` 與伺服器都會寫入 `SUPABASE_SCHEMA` 指定的 schema。對 `public` 跑就是寫正式資料。

## 測試

```bash
npm test                      # 單元測試，純函式與 fake 上游，不碰網路與資料庫
npm run test:integration      # 真 Supabase 的 test schema；需要 .env，且 SUPABASE_SCHEMA=test（其他值拒跑）
```

整合測試的前置（一次性）：Supabase dashboard → Project Settings → Data API → Exposed schemas 加入 `test`；
把 `0001_sekai_border.sql.tmpl` 渲染成 `test` 後套上，再套 `test_only_helpers.sql` 與 `supabase/legacy/views_test_schema.sql`
（順序固定；渲染：`node scripts/render-sql.js <tmpl> test [legacy_schema]`）。測試每輪會清空 test schema 的兩張表。

上游回應的錄製檔在 `test/fixtures/`（`npm run record-fixtures` 重錄；玩家欄位只留 rank 與 score）。

## 回填與舊資料遷移

```bash
node scripts/backfill.js --from 1 --to 999999        # 已結束活動的最終榜線與屬性；每個 HTTP 請求間隔 ≥ 1 秒，可中斷續跑
node scripts/migrate-legacy.js --event <id> --cutover <YYYY-MM-DDTHH:M5:00Z> [--candidate-slot <slot>] [--allow-skipped N]
```

兩支腳本啟動時都會印出目標 Supabase ref 與 schema，要輸入 `yes` 才繼續（`--yes` 跳過）。
回填只跳過 `finalized_at` 已寫的期；有任何一期 `failed` 或 `deferred` 以非零碼結束。
遷移把舊表 `event_rankings` 中**一期**的快照搬進新表，單一交易、任一檢查不過整個回滾（SQL 在 `supabase/migrations/0001b_exec_sql.sql.tmpl`）。
什麼時候跑、帶什麼參數，見計畫 Task 8。

預測相關腳本（子專案 2）：

```bash
npm run train -- [--exclude 1,2] [--yes]               # 手動重訓並寫 sekai_border_model
npm run backtest                                      # 唯讀：rolling-origin 回測摘要（各格 MAE、區間覆蓋率、成員 σ）
node scripts/series-from-backup.js <event_id> [--yes] # 已結算活動補序列：本機備份 ∪ DB 快照，經 put_series 寫入，不刪任何東西
node scripts/load-raw.js <csv.gz> --as <id> [--yes]   # A1 容量量測：把備份載入 test schema（只接受 SUPABASE_SCHEMA=test）
node scripts/capacity-model.js [--yes]                # A1：全量合成輸入訓練出的 params 寫進 test.sekai_border_model 量大小
```

`scripts/capacity-forecast.sql` 是 A1 量測語句（每句各自執行）。`render-sql.js` 支援 `--set key=value` 填入額外的 `{{key}}`（值只能是數字與逗號），有未替換的 token 就失敗。

## 部署與回滾

GCP：Cloud Run `sekai-border`（專案 `sekai-archive`，region `asia-east1`，min-instances 0）＋ Cloud Scheduler `sekai-border`（`*/5 * * * *`）。
服務必須 **Require authentication**，Scheduler 用服務帳戶的 OIDC token 呼叫。

部署、切流量、搬舊資料、觀察期、回滾的逐步指令與每步的 Expected，都在
`docs/superpowers/plans/2026-10-16-data-layer.md` 的 Task 8。重點：先 `--no-traffic` 部署候選版本打一次驗收，暫停 Scheduler，
凍結舊表（`0001d_legacy_freeze`），切流量，再搬舊資料；觀察期至少跨過一次活動更替，回滾用 `sekai_border_export_to_legacy` 把新表的快照補回舊表。

子專案 2 上線紀錄：0002 於 2026-10-17T14:03Z 套用 public，revision `sekai-border-00016-jub` 自 14:14Z 起 100% 流量（回滾點 `sekai-border-00014-cew`＋`0002_rollback.sql.tmpl`）；第 182 期 2026-10-19T13:25Z 以階段一結算並自動重訓。

## 檔案

| 路徑 | 內容 |
|------|------|
| `index.js` | 進入點：載入環境、`--once` 或 HTTP 伺服器 |
| `src/validate.js` | 上游回應驗證（名次集合、兩回應一致性、最終榜目標集、WL 章節雙射、去個資的錯誤細節） |
| `src/state.js` | 純函式狀態機：slot、分支（current / frozen / due / stale-live / pre-start / regress） |
| `src/fetch.js` | 上游抓取：單一閘門（請求間隔）、10 秒逾時涵蓋 body、不重試 |
| `src/db.js` | 唯一碰 supabase-js 的模組 |
| `src/finalize.js`、`src/metadata.js`、`src/run.js` | 結算掃描、屬性修補、單輪編排 |
| `src/server.js`、`src/env.js` | `POST /run` 伺服器、環境變數與 JWT 角色檢查 |
| `scripts/` | `backfill.js`、`migrate-legacy.js`、`render-sql.js`、`record-fixtures.js`、`capacity.sql` |
| `supabase/migrations/` | schema 模板（0001）、遷移（0001b）、回滾匯出（0001c）、舊表凍結（0001d）、test 專用 helper |
| `supabase/legacy/` | 舊 view 定義的逐字匯出（相容 view 的對照基準），勿手改，要改就重新匯出 |
| `docs/LESSONS.md` | 踩過的坑 |

## 上游（hisekai.org）已知事實（2026-10 實測）

- `/tw/event/{id}/border|top100` 的 `isEventAggregate`、`isWorldBloomChapterAggregate` 對所有活動都回 `false`，不能當結算條件；結算只看 `ranking_announce_at + 15 分鐘`。
- 公布前這兩支回的是即時資料（非空）；還不存在的活動回空陣列。空陣列視為「尚未公布」，下一輪重試。
- 非 WL 活動的清單可能帶一個 `character: 0` 的佔位章節（第 180 期），不會被存成章節。
