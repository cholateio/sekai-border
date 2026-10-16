# Sekai Border（Sekai Archive 資料層爬蟲）

> CLAUDE.md（kit v4.3）。本檔只放「這個專案是什麼」——工作流、派工、
> review 規則由 `.claude/rules/` 自動載入（kit-owned，別在專案裡改）。
> 首次使用：跑 `claude`，貼上 `init.sh` 結尾印出的 bootstrap prompt，
> 讓 AI 幫你把 [佔位符] 填掉。

## Project goal

Sekai Archive 的資料層：Cloud Run 上的私有服務，每 5 分鐘由 Cloud Scheduler 觸發，從 hisekai.org
抓《Project Sekai》台服活動榜線寫入 Supabase；活動結束後抓最終榜線、結算並壓縮期中曲線。
所有對 Supabase 的寫入都由本專案獨占（網站只讀）。四個子專案中的第 1 個（資料層）。

## Stack

- Language: Node.js >= 22（ESM，無 TypeScript）
- Runtime: 裸 `node:http` 伺服器（`src/server.js`），只接受 `POST /run`；Cloud Run（私有，Scheduler OIDC）
- Datastore: Supabase（PostgreSQL 17）—— `sekai_border_events`、`sekai_border_rankings`、
  相容 view `sekai_border_current_report` / `sekai_border_daily_report`；schema 以 `supabase/migrations/*.sql.tmpl`
  渲染（`{{schema}}` = public | test）後用 Supabase MCP 或 SQL editor 套用，不走 supabase CLI
- Deps: `@supabase/supabase-js` 釘 2.118.0、`dotenv`
- Build/run: `node index.js`（伺服器）、`node index.js --once`（跑一輪）；`.env` 帶
  `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SCHEMA`（見 README）
- Test: `npm test`（單元，`node --test`，不碰網路）、`npm run test:integration`（真 Supabase 的 `test` schema，
  只在 `SUPABASE_SCHEMA=test` 下跑，需要 `SUPABASE_ANON_KEY`）

## File layout

- `index.js` — 進入點：`loadEnv` → `--once` 或 `createServer`
- `src/` — `validate.js`（上游驗證、去個資）、`state.js`（純函式狀態機）、`constants.js`、`fetch.js`（請求閘門／逾時）、
  `db.js`（唯一碰 supabase-js）、`finalize.js`、`metadata.js`、`run.js`（單輪編排）、`server.js`、`env.js`、`log.js`、`errors.js`
- `scripts/` — `backfill.js`（已結束活動回填）、`migrate-legacy.js`（舊表搬一期）、`confirm.js`、`render-sql.js`、
  `record-fixtures.js`、`capacity.sql`
- `supabase/migrations/` — `0001_sekai_border.sql.tmpl`（表、觸發器、結算函式、view、RLS/grants）、`0001b_exec_sql`（遷移）、
  `0001c_rollback_export`、`0001d_legacy_freeze`、`test_only_helpers.sql`（只套 test）
- `supabase/legacy/` — 舊 view 定義逐字匯出（2026-10-16），相容 view 的對照基準
- `test/` — 單元測試、`test/integration/`（真 DB）、`test/fixtures/`（錄製的上游回應，玩家欄位只留 rank/score）
- `docs/superpowers/specs/`、`docs/superpowers/plans/` — spec（權威）、實作計畫（Task 8 = 正式環境 runbook）、容量實測

## Project-specific constraints（禁區與硬規則）

- `node index.js`、`node index.js --once`、`scripts/backfill.js`、`scripts/migrate-legacy.js` 都會打真實 hisekai.org
  並寫入 `SUPABASE_SCHEMA` 指定的 schema；`public` 就是正式資料。測試與演練一律 `SUPABASE_SCHEMA=test`，
  對 `public` 的執行只在 Task 8 runbook 規定的步驟、由 user 親自跑。
- `SUPABASE_SERVICE_ROLE_KEY` 只存在於 Cloud Run 環境變數與本機 `.env`（gitignore、mode 600）；不得寫進任何檔案、log、
  fixture、commit。log 與錯誤細節不得含上游回應裡的玩家欄位（`src/validate.js` 的 `safeDetail` 是唯一出口）。
- Supabase 專案與其他資料共用：schema 變更只透過 `supabase/migrations/*.sql.tmpl` 渲染後套用，每個物件對
  PUBLIC/anon/authenticated 先 revoke 再 grant；`test` schema 外的 DDL 由 user 確認後執行。
- `supabase/legacy/` 是舊 view 的逐字匯出，不得手改；要更新就用 `pg_get_viewdef` 重新匯出（spec §3.3 的對照基準）。
- 上游契約硬編碼在 `src/validate.js`、`src/fetch.js`、`test/fixtures/`：改欄位名前先對照真實回應（`npm run record-fixtures`），
  勿臆測；`isEventAggregate` 恆為 false，不得拿來當結算條件（2026-10-16 實測）。

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
