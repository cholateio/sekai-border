# 資料層設計 spec（子專案 1 / 4）— v2

> 日期：2026-10-16。狀態：v2，已納入 codex 第 1 輪設計審查 18 條。範圍：sekai-border 重構 + Supabase schema 重設計 + 歷史回填 + 網站端最小配合改動。
> 上層方向見同日與 user 的討論結論（Claude 記憶 `sekai-redesign-direction`）：網站 AI 改為榜線專用分析器；本子專案是四個子專案中的第一個，後續為「預測與三問 API」「手機一覽圖」「解說員與拆舊 agent」。

## 1. 目標與非目標

**目標**

1. 從下一期活動起，永久保留每期榜線的期中曲線（每小時一點）與最終榜線，供第 2 子專案建預測模型。
2. 一次回填所有已結束活動的最終榜線與活動屬性（型態、團體、加成角色、WL 章節）。
3. 把 sekai-border 從單檔腳本重構成有測試、可驗收的小專案，並修掉已知的資安缺口。
4. Supabase 收斂成兩張表、兩個 view；拆掉 RAG 的表、函式與擴充；容量以實測為準，目標穩態 < 30 MB、年增 < 15 MB。
5. 現有網站的排行頁在整個過程中不中斷、不凍結。

**非目標**

- 不做預測、不做新 UI、不動 LLM（第 2 到 4 子專案）。
- 不存玩家名稱、玩家 id、卡片等個資；只存名次與分數。log 也不得含這些欄位。
- 不保留 2 萬名以外的榜線。
- 不從第三方網站匯入歷史快照（project-sekai-center 的 GitHub 資料無授權條款）。
- 不做使用者登入、不開任何寫入端點給網站、不發 API 金鑰給第三方。
- **WL 期中快照在本子專案不啟用**（見 §5.4）；WL 的最終榜線與章節屬性會做。

## 2. 資料來源（外部契約，非本專案掌控）

| 來源 | 用途 | 已驗證的形狀（2026-10-16） |
|---|---|---|
| `GET api.hisekai.org/tw/event/live/top100` | 當期前百快照 | `{id,name,start_at,closed_at,aggregate_at,ranking_announce_at,player_top_100_rankings:[{rank,name,score,...}×100],world_link_top_100_rankings:[]}` |
| `GET api.hisekai.org/tw/event/live/border` | 當期榜線快照 | 同上的活動欄位 + `player_border_rankings:[{rank,score,...}×18] (100,200,300,400,500,1000,1500,2000,2500,3000,4000,5000,10000,20000,40000,60000,80000,100000)`, `world_link_border_rankings:[]` |
| `GET api.hisekai.org/tw/event/list` | 活動清單（含 WL 章節） | `[{id,name,chapters:[{id,event,chapter,character,start_at,aggregate_at,ranking_announce_at}],start_at,closed_at,aggregate_at,ranking_announce_at}]`；目前列到 id 202（含未開始的排程） |
| `GET api.hisekai.org/tw/event/{id}/top100` | 某期最終前百 | `{isEventAggregate,rankings:[×100],userWorldBloomChapterRankings:[{eventId,gameCharacterId,isWorldBloomChapterAggregate,rankings:[×100]}]}` |
| `GET api.hisekai.org/tw/event/{id}/border` | 某期最終榜線 | `{eventId,isEventAggregate,borderRankings:[×18],userWorldBloomChapterRankingBorders:[{eventId,gameCharacterId,isWorldBloomChapterAggregate,borderRankings:[×13: 100..20000]}]}` |
| Sekai-World TC master db `events.json` | 活動型態與團體 | `{id,eventType: marathon|cheerful_carnival|world_bloom, unit, startAt, aggregateAt}`；raw.githubusercontent 支援 ETag |
| Sekai-World TC master db `eventCards.json` + `cards.json` | 加成角色 | `eventCards:{eventId,cardId,bonusRate}` → `cards:{id,characterId}` |

**未驗證（設計上以旗標關閉）**：live 端點在 WL 期間的 `world_link_*` 欄位實際形狀。

## 3. 資料模型（Supabase，public schema）

### 3.1 `sekai_border_events`

| 欄位 | 型別 / 約束 | 說明 |
|---|---|---|
| `id` | integer PK, CHECK (id > 0) | hisekai / master db 共用的期數 id |
| `name` | text NOT NULL | |
| `event_type` | text null, CHECK in (marathon, cheerful_carnival, world_bloom) | master db；未取得為 null |
| `unit` | text null | master db |
| `start_at` | timestamptz NOT NULL | |
| `aggregate_at` | timestamptz NOT NULL, CHECK (aggregate_at > start_at) | 分數凍結 |
| `ranking_announce_at` | timestamptz NOT NULL, CHECK (>= aggregate_at) | 最終榜公布；結算門檻 |
| `bonus_characters` | integer[] NOT NULL default '{}' | 由 eventCards→cards 推得的**加成卡角色**（master db 沒有「banner」概念，這是它能給的最接近語意；去重） |
| `chapters` | jsonb NOT NULL default '[]' | WL 章節 `[{chapter:int, chapter_id:int, character_id:int, start_at, aggregate_at, ranking_announce_at}]`；CHECK 為 array |
| `metadata_status` | text NOT NULL default 'pending', CHECK in (pending, complete, missing) | master db 屬性狀態：pending=尚未成功抓、complete=已補齊、missing=master db 確認無此期 |
| `metadata_checked_at` | timestamptz null | 上次嘗試補屬性的時間 |
| `finalized_at` | timestamptz null | 結算完成時間 |

### 3.2 `sekai_border_rankings`

| 欄位 | 型別 / 約束 | 說明 |
|---|---|---|
| `event_id` | integer NOT NULL FK → events(id) | |
| `chapter` | smallint NOT NULL, CHECK (0..6) | 主榜 0；WL 章節序號 1..n，對應 `events.chapters[].chapter` |
| `rank` | integer NOT NULL, CHECK (rank = ANY(allowed)) | 允許集合（主榜與章節相同）：1..10、20,30,…,100、200,300,400,500,1000,1500,2000,2500,3000,5000,10000（共 30） |
| `score` | bigint NOT NULL, CHECK (score >= 0) | |
| `taken_at` | timestamptz NOT NULL | 快照：抓取時刻向下對齊到 5 分鐘 slot；最終：該期（或章節）的 `aggregate_at` |
| `is_final` | boolean NOT NULL default false | |

主鍵 `(event_id, chapter, rank, taken_at)`；索引 `(event_id, chapter, taken_at)`。

**三種資料靠保留規則區分，不分表**：

- 當期：每個 5 分鐘 slot 一列。`taken_at = floor(now, 5 min)`，寫入用 `INSERT ... ON CONFLICT DO NOTHING`，所以 Scheduler 重複觸發或延遲到同一 slot 都是冪等。
- 結束的活動：結算時按 **UTC 小時桶** 壓縮：每個 `(event_id, chapter, rank, date_trunc('hour', taken_at))` 保留 `taken_at` 最大的一列，其餘刪除。不要求 `taken_at` 剛好在整點；某小時只有一筆就留那一筆；某小時沒有資料就是缺。
- 最終榜線：`is_final = true`。

### 3.3 相容 view（給現有網站用）

現有 `view_all_ranking_report`、`view_day_ranking_report` 的定義先以 `pg_get_viewdef` 匯出存檔（放在 migration 檔內當註解）。新 view：

- `sekai_border_current_report`、`sekai_border_daily_report`：在舊 SQL 前面套一層相容子查詢：`SELECT event_id::text AS event_id, rank, score, taken_at AS created_at FROM sekai_border_rankings WHERE chapter = 0 AND is_final = false AND event_id = (SELECT max(id) FROM sekai_border_events WHERE finalized_at IS NULL)`，再把舊 SQL 的表名換成這個子查詢。欄位名、型別、排序與舊 view 一致，輸出仍是「單一當期」。
- 空窗期（沒有未結算的活動）時回空集合，網站顯示「無資料」，與現在活動更替當下的行為相同。
- 皆 `security_invoker = on`。
- 驗收：切換前對同一時刻的新舊 view 做 **逐列（rank 為鍵）值與型別比對**，不是只比列數。

### 3.4 容量

v1 的估算算錯（36 × 0.3 已是 10.8 MB，加上當期 8 MB 已超過宣稱的上限）。v2 不宣稱數字，改為**實作時實測**：在 `test` schema 以真實 schema 載入一期 5 分鐘快照（約 78k 列）與一期壓縮後曲線，記錄 `pg_total_relation_size`（含索引）；用實測值推 36 期的穩態與年增，寫進計畫的驗收。設計目標：穩態（當期 + 一年曲線 + 全部最終）< 30 MB，年增 < 15 MB；不達標的第一個手段是把索引縮成主鍵一個。

## 4. sekai-border 執行流程

每 5 分鐘由 Cloud Scheduler 觸發 `POST /run`。每輪先取得 `slot = floor(now, 5 min)`。

### 4.1 抓取與驗證（任一失敗：整輪不寫、回 500、不重試）

1. 並行打 live top100 與 live border，各 10 秒逾時。
2. 兩個回應必須**互相一致**：`id`、`aggregate_at`、`ranking_announce_at` 相同；`id` 為正整數。
3. 主榜名次集合必須**恰好等於**允許集合（30 個，不多不少）；分數為非負整數；名次不重複；分數隨名次遞減（允許相等）。
4. 回應中的 `world_link_*` 欄位：`WL_INGEST=off`（預設）時忽略；見 §5.4。

### 4.2 狀態判斷（讀 DB 兩個東西：`latest` = id 最大的一列（不論是否結算）；`pending` = 所有 `finalized_at IS NULL` 的列）

| 情況 | 條件 | 動作 |
|---|---|---|
| bootstrap | `events` 為空 | 補 live id 的 events 列（§4.4），寫入快照 |
| current | live id = latest.id 且 latest 未結算 且 `now < aggregate_at` | 寫入快照 |
| frozen | live id = latest.id 且未結算 且 `aggregate_at <= now < ranking_announce_at + 15 min` | 不寫快照；回 200 `{waiting_final:true}` |
| due | live id = latest.id 且未結算 且 `now >= ranking_announce_at + 15 min` | 嘗試結算（§4.3）；不寫快照 |
| stale-live | live id = latest.id 且 latest 已結算 | no-op，回 200 `{noop:true}` |
| new-event | live id > latest.id | 補 live id 的 events 列；寫入快照；**再**對 `pending` 中每一期（不含本期）嘗試結算。本期快照不因前期結算失敗而少寫 |
| regress | live id < latest.id | 視為上游異常：不寫、回 500、記 error |

`pending` 可以同時有多期（例如前期最終榜一直沒公布）；每輪都會對每一期各自嘗試，彼此獨立。

### 4.3 結算（每期一次；`due` 與 `new-event` 分支呼叫）

1. 抓 `/tw/event/{id}/border` 與 `/top100`；`eventId` 必須等於請求的 id；`isEventAggregate` 必須為 true（否則視為未公布，本輪放棄，記 info）；主榜名次集合驗證同 §4.1 第 3 點（最終端點的 18 條線中取允許集合內的 11 條 + 前百中取 1..10、20..100）。WL 期：`userWorldBloomChapterRankingBorders` 每個章節的 `isWorldBloomChapterAggregate` 為 true，且 `gameCharacterId` 能唯一對應到 `events.chapters[].character_id`；對不上整期放棄。
2. **一個 Postgres 函式 `sekai_border_finalize(event_id int, finals jsonb)` 在單一交易內完成**：`pg_advisory_xact_lock(event_id)` → 若 `finalized_at IS NOT NULL` 直接返回（冪等） → upsert `finals`（`is_final=true`，`taken_at = aggregate_at`，章節用各章節的 `aggregate_at`） → 依 §3.2 的小時桶規則刪除多餘快照 → `UPDATE events SET finalized_at = now()`。任何一步失敗整個交易回滾，`finalized_at` 維持 null，下一輪重試。兩次 Scheduler 同時觸發時第二個會等鎖，進入後看到已結算直接返回。

### 4.4 活動屬性（§3.1 的 `metadata_*`）

- 新的一期：從 `event/list` 取名稱、時間、章節（`chapter_id`、`character_id` 一併保存）；寫入 events 列，`metadata_status='pending'`。
- **屬性修補步驟每輪都跑**（與狀態判斷無關）：取 `metadata_status='pending'` 且 `metadata_checked_at` 為 null 或早於 6 小時前的列，最多 1 列；抓 master db `events.json`（If-None-Match，上次 ETag 存在記憶體；Cloud Run 冷啟就重抓一次 1.4 MB）；找到 → 填 `event_type`、`unit`，再抓 `eventCards.json` 與 `cards.json` 填 `bonus_characters`，`metadata_status='complete'`；master db 有清單但無此 id → `'missing'`；抓取失敗 → 只更新 `metadata_checked_at`。

### 4.5 請求預算（S8 的依據）

| 分支 | 對 hisekai | 對 raw.githubusercontent |
|---|---|---|
| current / frozen / stale-live | 2 | 0（屬性修補若有 pending：1 到 3） |
| due | 2 + 2 | 0 |
| new-event | 2 + 1（event/list）+ 每個 pending 期 2 | 1 到 3 |
| 回填（一次性） | 1（list）+ 每期 2，間隔 1 秒 | 3 |

### 4.6 回應

所有分支經同一個帶 `headersSent` 護欄的 `sendJson(res, status, body)`；200 的 body 為 `{slot, event_id, branch, inserted, finalized:[ids], noop}`。非 `POST /run` 一律 404。

## 5. 程式結構與細節

### 5.1 檔案

```
sekai-border/
  src/
    fetch.js       # upstream calls + shape/consistency validation; returns typed objects or throws
    state.js       # pure: (livePayload, latest, pending, now) -> branch + actions
    finalize.js    # fetch finals + validate + call sekai_border_finalize RPC
    metadata.js    # event/list + master db (ETag cache) -> events row / repair
    db.js          # the only module that touches supabase-js
    server.js      # http server: POST /run only; sendJson guard
  scripts/
    backfill.js    # one-off: events + finals for finished events; resumable; 1 req/s; prints target ref, requires "yes"
    migrate-legacy.js   # one-off: copy event_rankings -> new table (see §7)
  test/
    *.test.mjs     # node --test; unit tests need no network / db
    fixtures/      # recorded 2026-10-16 upstream responses, player fields stripped
  supabase/
    migrations/    # numbered SQL files, each one step of §7
  index.js         # `node index.js` (server) / `node index.js --once` (single run; replaces fetch_all_rankings.js)
```

`fetch_all_rankings.js` 刪除。`package.json`：`"test": "node --test test/"`、`"engines": {"node": ">=22"}`。Dockerfile 維持 node:22-slim + `npm ci`。

### 5.2 憑證

環境變數改名為 `SUPABASE_URL` 與 `SUPABASE_SERVICE_ROLE_KEY`（舊的 `SUPABASE_KEY` 不再接受，缺少就啟動失敗）。啟動時解碼 JWT payload 確認 `role === 'service_role'`，不符則拒絕啟動；**不印 key、不印 payload**。Cloud Run 以 Secret Manager 掛載。

### 5.3 Log 內容限制

任何 log 不得含上游回應中的 `name`、`userId`、`userCard`、`userProfile` 等欄位。形狀驗證失敗時只印：失敗的欄位路徑、事件 id、各陣列長度、回應本文的 SHA-256。需要原始回應除錯時，由人工用 curl 重現。

### 5.4 World Link

- `WL_INGEST` 環境變數預設 `off`：live 的 `world_link_*` 欄位整個忽略，主榜照常。
- WL 章節的**最終榜線**（契約已驗證）正常結算寫入 `chapter = 1..n`。
- 下一次 WL 開跑當天：用 curl 錄下 live 兩支端點的實際回應（去除玩家欄位）存進 `test/fixtures/`，依實際形狀補 `fetch.js` 的 WL 驗證與測試，再把 `WL_INGEST` 設為 `on`。這是一個獨立的小任務，不在本子專案的計畫內，但資料模型已經預留。

## 6. 資安需求（每條附驗收指令）

| # | 需求 | 驗收 |
|---|---|---|
| S1 | Cloud Run 服務 Require authentication；Scheduler job 使用專屬 service account（只有 `roles/run.invoker`，且綁在這個服務而非專案層）以 OIDC 呼叫，audience = 服務 URL；IAM 不得有 `allUsers` / `allAuthenticatedUsers` | `gcloud run services get-iam-policy sekai-border` 只列該 SA；`gcloud scheduler jobs describe` 顯示 `oidcToken.serviceAccountEmail` 與 audience；外部 `curl -X POST .../run` 得 403；Scheduler 最近執行為 200 |
| S2 | 只接受 `POST /run` | `GET /`、`POST /`、`GET /run` 得 404 |
| S3 | service role key 只存在 Secret Manager（掛進 Cloud Run）與回填時的本機終端；repo 與歷史皆無 | `git log -p --all | grep -E 'eyJ[A-Za-z0-9_-]{20,}\.' ` 無命中；`.env` 在 `.gitignore`；程式啟動驗 role |
| S4 | `anon`、`authenticated` 對兩張表只有 SELECT（RLS 政策 + 表層 grant 皆如此） | SQL：對兩個角色 × {INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER} `has_table_privilege` 全為 false，SELECT 為 true；以 anon key 實打 INSERT/UPDATE/DELETE 得拒絕；`sekai_border_finalize` 的 EXECUTE 只給 service_role |
| S5 | 兩個 view `security_invoker = on` | `pg_class.reloptions` |
| S6 | 退役物件確實移除：`event_rankings`、兩個舊 view、`documents`、`match_documents`、`vector` 擴充 | 逐一查 `pg_class` / `pg_proc` / `pg_extension` 為空；`get_advisors(security)` 零 finding |
| S7 | 上游回應寫入前驗證：§4.1 第 2、3 點 + §4.3 第 1 點 | 單元測試覆蓋每一種壞資料（見 §8） |
| S8 | 無重試迴圈；請求數符合 §4.5 | 整合測試以 mock 計數每個分支的請求數 |
| S9 | 回填與遷移腳本：1 秒間隔、可續跑、啟動印目標 ref 並要求輸入 `yes` | 腳本實測（對 test schema） |
| S10 | User-Agent 帶 `BOT_CONTACT` | 保留 |

## 7. 遷移順序（不中斷、可回滾）

每一步一個 migration 檔或一個指令區塊，附預期輸出。

1. **建新物件**（不刪任何舊物件）：兩張表、約束、索引、RLS、grants/revokes、`sekai_border_finalize` 函式、兩個新 view。
2. **部署新爬蟲為候選版本（`--no-traffic`）**：它只寫新表。用 Scheduler 的 SA token 打候選版本一次：預期 bootstrap 分支、`events` 多一列、`rankings` 多 30 列。此時正式流量仍是舊爬蟲寫舊表。
3. **切流量到新爬蟲**：從此刻起新快照只進新表。舊爬蟲版本保留在 Cloud Run 的 revision 列表當回滾點（回滾 = 切回舊 revision，舊表仍在）。
4. **搬舊資料**（`migrate-legacy.js`，一個交易）：舊表 `event_id` 為 text，先 `SELECT DISTINCT event_id`，只接受能轉成正整數且存在於 `events` 的值（現在只有 `'182'`；`'unknown_event'` 等異常值列出並略過）；`created_at` 對齊到 5 分鐘 slot 後插入，`ON CONFLICT DO NOTHING`（與步驟 3 之後新爬蟲寫入的列重疊時以新表為準）。報告：搬入列數、略過列數、新表該期 slot 數。
5. **切 view 與網站**：新 view 已就緒；sekai-archive 的 `context/RankContext.js` 改兩個 view 名稱，部署。部署前做 §3.3 的逐列比對。
6. **回填歷史**：本機跑 `backfill.js`（深夜；對 hisekai 1 req/s；只處理 `list` 中 `aggregate_at < now` 的期數，當期與未來期只寫 events 列）。
7. **拆網站端 RAG**：sekai-archive 刪 `lib/tools/{definitions,implementations}/knowledge.js`、registry 項、system prompt 相關句、embeddings 程式；部署並確認聊天路由仍能載入（smoke）。
8. **觀察期**：至少跨過一次活動更替（約 10 天內），確認 new-event 與結算分支在正式環境各跑過一次且 `finalized_at` 已寫。
9. **拆舊**（觀察期後）：刪 `event_rankings`、舊兩個 view、`documents`、`match_documents`、`vector`；刪舊 Cloud Run revision。跑 S6 驗收。
10. **收尾**：確認 DB 大小；更新兩個 repo 的 CLAUDE.md 禁區與 PROJECT.toml。

GCP 指令（步驟 2、3、9 與 S1 的 IAM 設定）由 user 執行，計畫會給可貼的區塊與預期輸出。

## 8. 測試與驗收

1. **單元（`npm test`，無網路無 DB）**
   - `state.js` 轉移表：bootstrap、current、frozen、due、stale-live、new-event（含多個 pending）、regress，每格一個測試。
   - `fetch.js` 驗證：正常；兩回應 id 不一致；`aggregate_at` 不一致；名次缺一個 / 多一個 / 重複；負分、非整數分；分數不遞減；id 非正整數；WL 欄位非空但 `WL_INGEST=off` 被忽略。
   - `finalize.js` 驗證：`isEventAggregate=false` 放棄；`eventId` 不等於請求 id 放棄；WL 章節 `gameCharacterId` 對不上放棄；最終端點名次擷取正確（18 條線取 11 + 前百取 19）。
   - 小時桶壓縮的 SQL 以 pg-mem 或對 test schema 跑（見整合）：每小時留最後一筆、只有一筆的小時、沒有資料的小時、延遲啟動（第一筆在 :07）、結算時刻所在的小時。
   - `metadata.js`：找到、master db 無此 id → missing、抓取失敗 → 只更新 checked_at、ETag 304 不重解析。
   - log 不含個資：對一個含玩家欄位的壞回應觸發驗證失敗，斷言 log 字串不含 `name` 值與 `userId`。
2. **整合（Supabase `test` schema，與正式表同結構；`SUPABASE_SCHEMA=test` 缺少時拒跑）**
   - 完整一輪的寫入列數與 slot 對齊；同一 slot 重複觸發不增列。
   - 結算：在 upsert finals 之後、壓縮之前模擬失敗 → 交易回滾、`finalized_at` 仍 null → 重跑成功；兩個並行呼叫只有一個做事。
   - 空窗 no-op；regress 不寫。
   - 遷移演練：以舊表結構的 fixture（含 `'unknown_event'` 列）跑 `migrate-legacy.js`，斷言搬入/略過列數與 slot 對齊。
   - 新舊 view 逐列比對（rank 為鍵）值與型別一致。
   - 權限：以 anon 與 authenticated 角色執行 S4 的 `has_table_privilege` 斷言與實際 DML。
   - 回填：對 3 期做續跑（中斷後重跑不重複）、請求間隔 ≥ 1 秒（以 mock 計時）。
   - 請求預算：每個分支的 mock 請求計數等於 §4.5。
3. **部署驗收**：§7 步驟 2 的候選版本檢查；§6 的 S1 到 S9 全部。
4. **資料面驗收**：回填後 `events` 列數 = `list` 中已結束的期數；`metadata_status='complete'` 的比例與 `missing` 清單列出人工確認；每個已結束期主榜 `is_final` 恰好 30 列；WL 期章節列數 = 章節數 × 30。

## 9. 風險與緩解

| 風險 | 緩解 |
|---|---|
| WL live 欄位形狀未知 | 預設關閉 WL 快照；最終榜線走已驗證契約；開跑當天錄 fixture 再開 |
| master db 期數 id 與 hisekai 不一致 | 回填逐期比對名稱，不一致者 `missing` 並列出；屬性允許 null |
| hisekai 改欄位名 | 形狀驗證在第一輪擋下並記 log；不寫壞資料。兩個 repo 的 CLAUDE.md 註明「改名要同步兩邊」 |
| 誤打錯的 Supabase 專案 | S9 的 ref 確認；整合測試只認 `test` schema |
| Scheduler 重複或延遲觸發 | 5 分鐘 slot + ON CONFLICT；結算在單一交易內持 advisory lock |
| 最終榜在公布前去抓 | 門檻 `ranking_announce_at + 15 分鐘` 且 `isEventAggregate=true`，否則下輪重試 |
| 舊爬蟲與新爬蟲同時寫 | 切流量後只有新爬蟲在跑；舊資料搬移用 ON CONFLICT 以新表為準 |
| 容量估算失準 | §3.4 改為實測，計畫中有驗收門檻 |

## 10. 給後續子專案的介面承諾

- 讀取只透過兩張表與兩個 view；第 2 子專案的模型以 `sekai_border_rankings (event_id, chapter, rank, taken_at, score, is_final)` 與 `sekai_border_events` 的屬性為唯一輸入。
- 結束活動的曲線：每個 UTC 小時桶最多一個點（該小時最後一筆），加上一個 `is_final` 點；缺的小時就是缺，不內插。
- `bonus_characters` 是加成卡角色，不是 banner 的嚴格定義；第 2 子專案若需要更精確的「主打角色」概念，要另找來源。
- 「沒有可比活動」與「只有最終榜線、沒有期中曲線」是第 2 子專案必須處理的狀態（期中曲線從部署後的下一期起才累積）。
