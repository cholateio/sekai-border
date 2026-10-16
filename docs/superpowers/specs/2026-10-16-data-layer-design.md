# 資料層設計 spec（子專案 1 / 4）— v9.2

> 日期：2026-10-16。狀態：v9.1。v8 經 codex 七輪審查（18 + 16 + 10 + 6 + 5 + 4 + 1 條）後 approve-with-fixes；v9 依實作時的上游實測（2026-10-16）修正 §4.3 的結算條件與最終名次集合（user 同意）；v9.1 納入 codex 對 v9 的 7 條意見；v9.2 依容量實測（plans/capacity-2026-10.md）把結束活動的壓縮改為「最後 24 小時每小時、更早每 3 小時」（user 決定，從使用者需求出發：預測最需要解析度的是最後一天）。範圍：sekai-border 重構 + Supabase schema 重設計 + 歷史回填 + 網站端最小配合改動。
> 上層方向見同日與 user 的討論結論（Claude 記憶 `sekai-redesign-direction`）：網站 AI 改為榜線專用分析器；本子專案是四個子專案中的第一個，後續為「預測與三問 API」「手機一覽圖」「解說員與拆舊 agent」。

## 1. 目標與非目標

**目標**

1. 從下一期活動起，永久保留每期榜線的期中曲線（結束前 24 小時每小時一點，更早每 3 小時一點）與最終榜線，供第 2 子專案建預測模型。
2. 一次回填所有**已結束**活動的最終榜線與活動屬性（型態、團體、加成角色、WL 章節）。未開始的排程活動不寫入任何資料。
3. 把 sekai-border 從單檔腳本重構成有測試、可驗收的小專案，並修掉已知的資安缺口。
4. Supabase 收斂成兩張表、兩個 view；拆掉 RAG 的表、函式與擴充；容量以實測為準（plans/capacity-2026-10.md），目標穩態 < 30 MB、年增 < 15 MB。
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
| `chapters` | jsonb NOT NULL default '[]' | WL 章節 `[{chapter:int, chapter_id:int, character_id:int, start_at, aggregate_at, ranking_announce_at}]`；CHECK 為 array。只收 `list` 中 `character` 為正整數的章節：非 WL 期可能列一個 `character: 0` 的佔位章節（第 180 期，2026-10-16 實測），上游沒有它的章節榜，寫入會讓該期永遠無法結算 |
| `metadata_status` | text NOT NULL default 'pending', CHECK in (pending, complete, missing, mismatch) | master db 屬性狀態：pending=尚未成功抓、complete=已補齊且名稱一致、missing=master db 多次確認無此 id、mismatch=master db 有此 id 但名稱與 hisekai 不同（屬性不採用，待人工） |
| `metadata_checked_at` | timestamptz null | 上次嘗試補屬性的時間 |
| `metadata_miss_count` | smallint NOT NULL default 0 | 連續「清單成功取得但無此 id」的次數；只要清單中**找到此 id**（不論結果是 `complete` 或 `mismatch`）就歸零；抓取失敗不變 |
| `finalized_at` | timestamptz null | 結算完成時間 |

### 3.2 `sekai_border_rankings`

| 欄位 | 型別 / 約束 | 說明 |
|---|---|---|
| `event_id` | integer NOT NULL FK → events(id) | |
| `chapter` | smallint NOT NULL, CHECK (0..6) | 主榜 0；WL 章節序號 1..n，對應 `events.chapters[].chapter` |
| `rank` | integer NOT NULL, CHECK (rank = ANY(allowed)) | 允許集合（主榜與章節相同）：1..10、20,30,…,100、200,300,400,500,1000,1500,2000,2500,3000,5000,10000（共 30）。即時快照必須 30 個齊全；最終榜的 1500、2500 可缺（§4.3） |
| `score` | bigint NOT NULL, CHECK (score >= 0) | |
| `taken_at` | timestamptz NOT NULL | 快照：抓取時刻向下對齊到 5 分鐘 slot；最終：該期（或章節）的 `aggregate_at` |
| `is_final` | boolean NOT NULL default false | |

主鍵 `(event_id, chapter, rank, taken_at, is_final)`；索引 `(event_id, chapter, taken_at)`。最終列與快照列即使 `taken_at` 相同也互不覆蓋。

`chapter` 的合法性由 DB 層保證：觸發器檢查 `chapter = 0` 或 `chapter` 存在於 `events.chapters[].chapter`。`events.chapters` 以 CHECK 函式約束：每個元素含整數 `chapter`（1..6）、`chapter_id`、`character_id` 與 `start_at`、`aggregate_at`、`ranking_announce_at`（皆為合法時間且 `start_at < aggregate_at <= ranking_announce_at`）；`chapter` 與 `character_id` 在同一期內各自唯一（章節↔角色是雙射）；陣列長度 ≤ 6。

**三種資料靠保留規則區分，不分表**：

- 當期：每個 5 分鐘 slot 一列。`taken_at = floor(now, 5 min)`，寫入用 `INSERT ... ON CONFLICT DO NOTHING`，所以 Scheduler 重複觸發或延遲到同一 slot 都是冪等。
- 結束的活動：結算時按時間桶壓縮，只處理 `is_final = false` 的列：`taken_at >= aggregate_at − 24 小時` 的列用 **1 小時桶**，更早的列用 **3 小時桶**（桶鍵 = `floor(epoch(taken_at) / 3600 或 10800)`，epoch 算術讓結果不依賴 session 時區；整合測試在 `SET timezone='Asia/Taipei'` 下跑一次），每個 `(event_id, chapter, rank, 桶)` 保留 `taken_at` 最大的一列，其餘刪除。WL 章節列的 24 小時界線同主榜的 `aggregate_at`。不要求 `taken_at` 剛好在整點；某桶只有一筆就留那一筆；某桶沒有資料就是缺。
- 最終榜線：`is_final = true`。

### 3.3 相容 view（給現有網站用）

現有 `view_all_ranking_report`、`view_day_ranking_report` 的定義先以 `pg_get_viewdef` 匯出存檔（放在 migration 檔內當註解）。新 view：

- `sekai_border_current_report`、`sekai_border_daily_report`：在舊 SQL 前面套一層相容子查詢：`SELECT event_id::text AS event_id, rank, score, taken_at AS created_at FROM sekai_border_rankings WHERE chapter = 0 AND is_final = false AND event_id = (SELECT max(id) FROM sekai_border_events WHERE finalized_at IS NULL AND start_at <= now())`，再把舊 SQL 的表名換成這個子查詢。欄位名、型別、排序與舊 view 一致，輸出仍是「單一當期」。
- 空窗期（沒有未結算的活動）時回空集合，網站顯示「無資料」，與現在活動更替當下的行為相同。
- 皆 `security_invoker = on`；明確 `GRANT SELECT` 給 `anon` 與 `authenticated`，並 REVOKE 其他權限（view 也可能被授予 DML）。驗收：`has_table_privilege('anon', view, 'SELECT')` 為 true，其餘為 false，且以 anon key 實際查詢兩個 view 回資料。
- 驗收：切換前對同一時刻的新舊 view 做 **逐列（rank 為鍵）值與型別比對**，不是只比列數。

### 3.4 容量

v1 的估算算錯（36 × 0.3 已是 10.8 MB，加上當期 8 MB 已超過宣稱的上限）。v2 不宣稱數字，改為**實作時實測**：在 `test` schema 以真實 schema 載入一期 5 分鐘快照（約 78k 列）與一期壓縮後曲線，記錄 `pg_total_relation_size`（含索引）；用實測值推 36 期的穩態與年增，寫進計畫的驗收。設計目標：穩態（當期 + 一年曲線 + 全部最終）< 30 MB，年增 < 15 MB；不達標的第一個手段是把索引縮成主鍵一個。

## 4. sekai-border 執行流程

每 5 分鐘由 Cloud Scheduler 觸發 `POST /run`。每輪先取得 `slot = floor(now, 5 min)`。

### 4.1 抓取與驗證（任一失敗：**短路**——不進入第二到第四步、不寫任何東西、回 500、不重試）

1. 並行打 live top100 與 live border，各 10 秒逾時。
2. 兩個回應必須**互相一致**：`id`、`aggregate_at`、`ranking_announce_at` 相同；`id` 為正整數。
3. 主榜名次集合必須**恰好等於**允許集合（30 個，不多不少）；分數為非負整數；名次不重複；分數隨名次遞減（允許相等）。
4. 回應中的 `world_link_*` 欄位：`WL_INGEST=off`（預設）時忽略；見 §5.4。

### 4.2 狀態判斷

讀 DB：`known` = `events` 中 id = live id 的列（可能不存在）；`started_latest` = `start_at <= now` 的列中 id 最大者。**資料庫裡不會有未開始的活動**（回填與新期寫入都只處理已開始者），所以 `started_latest` 就是「目前認得的最新一期」。

**第一步：確保活動列存在**（與時間判斷分離）

| 情況 | 條件 | 動作 |
|---|---|---|
| known | live id 已在 events | 無 |
| new-event | live id 不在 events 且 live id > started_latest.id（或 events 為空 = bootstrap） | 從 `event/list` 取 id = live id 的**唯一**一列（0 或多列 → 整輪 500）；其 `start_at / aggregate_at / ranking_announce_at` 必須與兩個 live 回應完全相等（時間一律轉成 epoch 比較），否則整輪 500；若 `start_at > now`（上游提早切到未開始的活動）→ 不寫入 events、不寫快照、`branch: pre-start`，仍跑第三與第四步；HTTP 狀態碼一律在第三、四步完成後依 §4.2 末段的共同規則決定；否則寫入 events 列（`metadata_status='pending'`） |
| regress | live id 不在 events 且 live id < started_latest.id | 上游異常：**短路**（同 §4.1 失敗）：不進入後續步驟、不寫、回 500、記 error |

**第二步：時間分類**（對 live id 那一列，不論它是剛建立還是早就存在）

| 分支 | 條件 | 動作 |
|---|---|---|
| current | 未結算 且 `start_at <= now < aggregate_at` | 寫入快照 |
| frozen | 未結算 且 `aggregate_at <= now < ranking_announce_at + 15 min` | 不寫快照 |
| due | 未結算 且 `now >= ranking_announce_at + 15 min` | 不寫快照（結算由第三步做） |
| stale-live | 已結算 | 不寫快照 |

**第三步：待結算掃描（每輪都跑，與分支無關）**

`eligible` = `events` 中 `finalized_at IS NULL AND now >= ranking_announce_at + interval '15 minutes'` 的所有列（含 live id 那一期若已到期）。對每一列各自呼叫 §4.3，**每期獨立 try/catch**，一期失敗不影響其他期的嘗試，也不影響本輪已完成的快照寫入。結果分兩類：`deferred`（上游最終回應的名次陣列為空，表示上游尚未有該期資料）與 `failed`（網路錯誤、驗證失敗、RPC 或 DB 錯誤）。**本輪回應碼：有任何 `failed` 就回 500**（所有獨立工作仍先做完），只有 `deferred` 或全部成功才回 200。這樣 Scheduler 的執行紀錄與 Cloud Run 錯誤率會反映真實故障（LESSONS 2026-07-28：資料面與執行面要分開都綠）。

**第四步：屬性修補**（§4.4，每輪最多 1 列）。

每輪回應 body 的**唯一**契約（§4.6 不再另訂）。正常路徑：`{slot, event_id, branch: current|frozen|due|stale-live|pre-start, inserted: int, finalized: [ids], finalize_deferred: [{id, reason}], finalize_failed: [{id, reason}], metadata_repaired: id|null}`；HTTP 狀態碼依上段規則。錯誤路徑：`{slot, branch: "error", phase, error_code: string, event_id: int|null, partial: {inserted: int, finalized: [ids], finalize_deferred: [...], finalize_failed: [...]}}` 搭配 500。`phase` 列舉與語意：
- `fetch` / `validate` / `event-list` / `regress`：短路，第二到第四步不執行，`partial` 全為空值。
- `db-read`（讀 events 失敗）：短路，同上。
- `event-write`（新期 events 列寫入失敗）：短路；下一輪會再走 new-event。
- `snapshot-write`（快照寫入失敗）：本輪結束於此、不進第三四步；快照寫入是 `ON CONFLICT DO NOTHING`，下一輪同 slot 不會重複、不同 slot 就是缺一筆。
- `finalize-scan`（待結算候選查詢失敗，非單期失敗）：本輪結束於此，`partial.inserted` 保留已寫入的快照數。
- `metadata`（第四步屬性修補中**任何** DB 讀取或寫入失敗，含候選查詢本身）：本輪結束於此、回 500，`partial` 保留已完成的 `inserted`、`finalized`、`finalize_deferred`、`finalize_failed`；屬性修補本身沒有部分寫入（單列更新）。
單期結算失敗不走這個形式，而是正常回應中的 `finalize_failed`。

### 4.3 結算（每期一次；**只由 §4.2 第三步的待結算掃描呼叫**，不由任何分支直接呼叫）

1. 抓 `/tw/event/{id}/border` 與 `/top100`，**逐端點驗證**：
   - **上游的 `isEventAggregate` 與 `isWorldBloomChapterAggregate` 不作為條件**：2026-10-16 實測第 1–182 期（含多年前結束的期）一律回 `false`。結算時機只由 §4.2 的時間門檻決定；`borderRankings` 或 `rankings` 為空陣列（上游尚未有資料）→ `deferred`，下輪重試。
   - border：根 `eventId` = 請求 id；從 `borderRankings` 取 **border 目標集 {200,300,400,500,1000,1500,2000,2500,3000,5000,10000}**（11 個，**不含 100**）中上游有提供的名次。其中 **1500、2500 可缺**：WL 章節的 border 只有 100,200,300,400,500,1000,2000,3000,4000,5000,7000,10000,20000，約第 110 期以前的主榜也沒有這兩條線（2026-10-16 實測）。其餘 9 個必備。
   - top100：根無 `eventId`（契約如此，不要求）；`rankings` 100 筆，從中取 **top 目標集 {1..10, 20,30,…,100}**（19 個，全部必備）。兩個目標集不相交，合併後每個榜（主榜、每個章節）有 **28 個必備名次**、最多 30 個；重複、或缺少任一必備名次 → 整期放棄。
   - 分數驗證同 §4.1（非負整數、不遞增）。
   - WL 期：`userWorldBloomChapterRankingBorders` 與 `userWorldBloomChapterRankings` **兩個陣列各自驗證**（每個章節的 `eventId` = 請求 id、名次取法同主榜；先驗兩個陣列與每個章節內的名次陣列都是陣列（否則 `shape` 放棄），再看是否有任一為空（→ `deferred`），最後才驗雙射與名次；結果不因先檢查哪個陣列而不同），兩個陣列各自不得有重複的 `gameCharacterId`，長度必須等於 `events.chapters` 的長度，且每個宣告的 `character_id` 在兩個陣列各恰好出現一次（雙射，不是集合相等）；任一條不符整期放棄。章節列的 `taken_at` 用該章節的 `aggregate_at`。
2. **一個 Postgres 函式 `sekai_border_finalize(event_id int, finals jsonb)` 在單一交易內完成**：`pg_advisory_xact_lock(event_id)` → 若 `finalized_at IS NOT NULL` 直接返回（冪等） → upsert `finals`（`is_final=true`） → **斷言**：chapter 0 與 `events.chapters` 宣告的每個章節，各自的 `is_final` 列名次不重複且 28 個必備名次全部存在（1500、2500 可有可無），否則 RAISE 並回滾 → 依 §3.2 的小時桶規則刪除多餘快照（只動 `is_final=false`） → `UPDATE events SET finalized_at = now()`。任何一步失敗整個交易回滾，`finalized_at` 維持 null，下一輪重試。兩次 Scheduler 同時觸發時第二個會等鎖，進入後看到已結算直接返回。函式 `EXECUTE` 只授予 `service_role`（`REVOKE ... FROM PUBLIC`）。

### 4.4 活動屬性（§3.1 的 `metadata_*`）

- 新的一期：從 `event/list` 取名稱、時間、章節（`chapter_id`、`character_id` 一併保存）；寫入 events 列，`metadata_status='pending'`。
- **屬性修補步驟每輪都跑**（與狀態判斷無關）：候選 = (`metadata_status='pending'` 且 `metadata_checked_at` 為 null 或早於 6 小時前) **或** (`metadata_status IN ('missing','mismatch')` 且 `metadata_checked_at` 早於 30 天前)，取 id 最小的 1 列；抓 master db `events.json`（If-None-Match，上次 ETag 存在記憶體；Cloud Run 冷啟就重抓一次 1.4 MB）；找到且 `name` 與 hisekai 名稱相同（去除首尾空白後完全相等）→ 填 `event_type`、`unit`，再抓 `eventCards.json` 與 `cards.json` 填 `bonus_characters`，`metadata_status='complete'`；找到但名稱不同 → `'mismatch'`，不填屬性、記 `metadata_checked_at`、`metadata_miss_count` 歸零，之後每 30 天再比一次（候選條件同 missing）；master db 清單成功取得但無此 id → `metadata_miss_count += 1`、記 `metadata_checked_at`；當 `metadata_miss_count >= 3` 且該期 `aggregate_at` 已過 7 天以上 → `'missing'`（之後每 30 天再試一次，見候選條件）；抓取失敗 → 只更新 `metadata_checked_at`，`metadata_miss_count` 不變。

### 4.5 請求預算（S8 的依據）

| 分支 | 對 hisekai | 對 raw.githubusercontent |
|---|---|---|
| 任一分支的基本開銷 | 2（live top100、live border） | 0 |
| new-event / bootstrap 額外 | +1（event/list） | 0 |
| 待結算掃描 | 每個 eligible 期 +2 | 0 |
| 屬性修補（每輪最多 1 列；候選 = 到期的 pending、missing 或 mismatch，見 §4.4） | 0 | +1（events.json，帶 ETag，304 不計傳輸）；首次 complete 再 +2（eventCards、cards） |
| 回填（一次性） | 1（list）+ 每個已結束期 2，間隔 1 秒 | 3 |

### 4.6 回應

所有分支經同一個帶 `headersSent` 護欄的 `sendJson(res, status, body)`；body 契約見 §4.2 末段。非 `POST /run` 一律 404。

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
| S4 | `anon`、`authenticated` 對兩張表只有 SELECT（RLS 啟用 + 只有 SELECT 政策 + 表層 grant 亦只有 SELECT） | 三層各自驗：(a) `pg_class.relrowsecurity = true`；(b) `pg_policies` 對兩張表恰好各一條 `FOR SELECT TO anon, authenticated`；(c) `has_table_privilege(role, table, priv)` 對兩個角色 × {INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER} 全 false、SELECT 為 true；(d) 以管理連線分別開交易：`BEGIN; SET LOCAL ROLE anon; INSERT ...; ROLLBACK;` 預期拒絕，另一個交易 `BEGIN; SET LOCAL ROLE anon; SELECT ...; ROLLBACK;` 預期有資料（被拒絕的交易已中止，不能在同一交易接著查），`authenticated` 同；(e) `has_function_privilege('anon'/'authenticated', 'sekai_border_finalize(int,jsonb)', 'EXECUTE')` 為 false，`service_role` 為 true，且 `aclexplode(proacl)` 不含 grantee = 0（PUBLIC） |
| S5 | 兩個 view `security_invoker = on` | `pg_class.reloptions` |
| S6 | 退役物件確實移除：`event_rankings`、兩個舊 view、`documents`、`match_documents`、`vector` 擴充 | 逐一查 `pg_class` / `pg_proc` / `pg_extension` 為空；`get_advisors(security)` 零 finding |
| S7 | 上游回應寫入前驗證：§4.1 第 2、3 點 + §4.3 第 1 點 | 單元測試覆蓋每一種壞資料（見 §8） |
| S8 | 無重試迴圈；請求數符合 §4.5 | 整合測試以 mock 計數每個分支的請求數 |
| S9a | 網路回填腳本 `backfill.js`：對 hisekai 1 秒間隔；可續跑的定義是**只跳過 `finalized_at IS NOT NULL` 的期**，其餘（events 列存在但未結算、或列不存在）都做：upsert events 列 → 抓最終 → 呼叫 §4.3 的 `sekai_border_finalize` RPC（同一支函式，含必備名次斷言）；啟動印目標 Supabase ref 並要求輸入 `yes` | 對 test schema 實測：在「events 已寫、finals 未寫」處中斷後重跑，該期最終補齊且不重複；mock 計時間隔 ≥ 1 秒 |
| S9b | 舊資料遷移：`migrate-legacy.js` 執行前印目標 ref 並要求 `yes`，以單一交易執行、只搬 `cutover_slot` 之前、確定性列數（重跑結果相同）、fail-closed 檢查、失敗整體回滾 | 對 test schema 以 fixture 實測兩次，搬入列數相同；故意製造約束違反時交易回滾零寫入 |
| S10 | User-Agent 帶 `BOT_CONTACT` | 保留 |

## 7. 遷移順序（不中斷、可回滾）

每一步一個 migration 檔或一個指令區塊，附預期輸出。

1. **建新物件**（不刪任何舊物件）：兩張表、約束、索引、RLS、grants/revokes、`sekai_border_finalize` 函式、兩個新 view。
2. **部署新爬蟲為候選版本（`--no-traffic`）**：它只寫新表。用 Scheduler 的 SA token 打候選版本一次：預期回應 `branch` 依當下時間為 `current`（`inserted: 30`、`events` 多一列）或 `frozen` / `due`（`inserted: 0`）；驗收以回應的 `branch` 與 `inserted` 的對應關係為準，不是固定 30。此時正式流量仍是舊爬蟲寫舊表。**候選版本寫入的快照列只是驗收用，步驟 4 會先刪掉。**
3. **改 Scheduler 再切流量**：先 `gcloud scheduler jobs update http` 把 URI 改為 `.../run`、方法 POST、並設定 OIDC service account 與 audience（舊爬蟲接受任何路徑，所以先改 URI 是安全的；此時舊爬蟲仍在跑並寫舊表）；確認一輪 Scheduler 執行為 200 後，再切流量到新爬蟲。**切流量的操作必須在活動進行中（`current` 區間）執行**；若當下是 frozen / due / 空窗，等下一期開始後再做（這避免切換後沒有快照可當邊界）。程序：(a) 暫停 Scheduler，確認沒有進行中的執行（Cloud Run 最近一次請求已回應）；(b) 切流量到新爬蟲；(c) **等到下一個 5 分鐘 slot 開始後**，由操作者用 Scheduler 的 SA token 直接 `curl -X POST .../run` 一次並保存回應 body（不靠 log），預期 `branch: current, inserted: 30`，其 `slot` 即 `cutover_slot`；若回應不是 current，恢復 Scheduler、切回舊 revision，等活動進行中再來一次；(d) 恢復 Scheduler。從此刻起新快照只進新表。因為 (c) 等過了 slot 邊界，舊表最後一筆的 slot 必定 **<** `cutover_slot`；步驟 4 的遷移對 `cutover_slot` 這個 slot 一律以新表為準（即使操作者沒等，舊表該 slot 的列也會被驗證集排除）。**回滾窗口**：在步驟 5 之前，回滾 = 切回舊 revision（舊表仍在、網站仍讀舊 view，無資料缺口，只少步驟 3 到回滾之間的快照）。步驟 5 之後若需回滾，依 §7.1 的 runbook，不再是一個指令。
4. **搬舊資料**（`migrate-legacy.js` 是唯一執行者：印目標 ref、要求輸入 `yes`、接受 `cutover_slot` 參數，然後以單一 SQL 交易執行遷移並印報告；SQL 本文放在 `supabase/migrations/` 供審閱，但不由 migration 工具自動套用）：舊表 `event_id` 為 text，只接受能轉成正整數且存在於 `events` 的值（`'unknown_event'` 等異常值列出並略過）；`created_at` 對齊到 5 分鐘 slot，同一 `(event_id, rank, slot)` 有多列時以 `row_number() over (partition by ... order by created_at desc) = 1` 取最晚的一筆；**`cutover_slot` 是步驟 3 記下的明確參數**，遷移交易依序：(1) 刪除新表中該期 `is_final=false` 且 `taken_at < cutover_slot` 的列（候選版本驗收時寫的）；(2) 把舊表整理成**暫存的驗證集**：只取 event_id 可轉正整數且存在於 events 的列、對齊 slot、每 `(event_id, rank, slot)` 取最晚一筆、只取 slot `< cutover_slot`（等於 `cutover_slot` 的舊列一律排除，該 slot 由新表擁有），並**丟棄不足 30 個名次的 slot**（列入報告）；(3) 搬驗證集進新表；(4) **fail-closed 檢查**，任一不符 RAISE 回滾：`cutover_slot` 為 5 分鐘對齊；新表在恰好 `cutover_slot` 有該期 30 列 `is_final=false`；驗證集非空；驗證集與新表 `< cutover_slot` 的列以 `(event_id, rank, taken_at)` 為鍵逐列比對 `score` 相等且數量相等；被丟棄的列數（無效 id + 不足 30 的 slot）若超過舊表列數的 1%，除非執行時帶 `--allow-skipped N` 且 N ≥ 實際丟棄數，否則回滾。報告印：搬入列數、丟棄列數與原因分布、驗證集 slot 數。報告：搬入列數、略過列數、新表該期 slot 數。
5. **切 view 與網站**：新 view 已就緒；sekai-archive 的 `context/RankContext.js` 改兩個 view 名稱，部署。部署前做 §3.3 的逐列比對。**同一步更新 sekai-border 的 README**（`POST /run` 需 OIDC、`SUPABASE_SERVICE_ROLE_KEY`、`node index.js --once`、刪除 `fetch_all_rankings.js` 的說明）。
6. **回填歷史**：本機跑 `backfill.js`（深夜；對 hisekai 1 req/s；只處理 `list` 中 `ranking_announce_at + 15 min < now` 的期數；當期由爬蟲自己管，未來期不寫；每期走 S9a 定義的流程，與線上結算共用同一支 RPC）。
7. **拆網站端 RAG**：sekai-archive 刪 `lib/tools/{definitions,implementations}/knowledge.js`、registry 項、system prompt 相關句、embeddings 程式；部署並確認聊天路由仍能載入（smoke）。
8. **觀察期**：至少跨過一次活動更替（約 10 天內），確認 new-event 與結算分支在正式環境各跑過一次且 `finalized_at` 已寫。
9. **拆舊**（觀察期後）：刪 `event_rankings`、舊兩個 view、`documents`、`match_documents`、`vector`；刪舊 Cloud Run revision。跑 S6 驗收。
10. **收尾**：確認 DB 大小；更新兩個 repo 的 CLAUDE.md 禁區與 PROJECT.toml。

### 7.1 步驟 5 之後的回滾 runbook（希望永遠用不到）

1. 暫停 Scheduler job（`gcloud scheduler jobs pause`）。
2. 把新表中該期、`is_final=false`、`taken_at` 晚於舊表最後一筆的列反向匯入舊表（SQL，一個交易；`event_id::text`、`taken_at AS created_at`）。
3. 網站 `RankContext.js` 改回舊 view 名稱並部署。
4. Cloud Run 切回舊 revision。
5. 以舊 view 查詢確認列數與最新 `created_at` 正確，再恢復 Scheduler。

這個 runbook 在觀察期（步驟 8）內每一步都能執行，因為舊表、舊 view、舊 revision 都還在；步驟 9 之後不再提供回滾。

GCP 指令（步驟 2、3、9 與 S1 的 IAM 設定）由 user 執行，計畫會給可貼的區塊與預期輸出。

## 8. 測試與驗收

1. **單元（`npm test`，無網路無 DB）**
   - `state.js` 可達的轉移各一個測試：known × {current, frozen, due, stale-live}；new-event（含 bootstrap）× {current, frozen, due}；new-event × pre-start；regress（終止，不分類）；event/list 無該 id、多列、時間不符各一個；DB 內含已結束、當期、以及（人為塞入的）未開始活動時 `started_latest` 仍選到當期。
   - 回應碼：一期 deferred 其他成功 → 200；一期 failed → 500 且快照仍已寫入、其他期仍已嘗試；§4.1 失敗與 regress 回 `branch: error` 且第三、四步未執行（以 mock 斷言零次結算與零次屬性請求）；`db-read`、`event-write`、`snapshot-write`、`finalize-scan`、`metadata`（分別注入候選查詢失敗與更新失敗兩案）各有 DB 失敗注入測試，斷言 `phase`、狀態碼與 `partial` 內容。
   - 待結算掃描：兩期 eligible、第一期失敗第二期成功、下一輪 current 分支仍重試失敗那期；未到門檻的 pending 不被觸碰。
   - `fetch.js` 驗證：正常；兩回應 id 不一致；`aggregate_at` 不一致；名次缺一個 / 多一個 / 重複；負分、非整數分；分數不遞減；id 非正整數；WL 欄位非空但 `WL_INGEST=off` 被忽略。
   - `finalize.js` 驗證：border 或 top100 的名次陣列為空 → deferred；`isEventAggregate=false` 不影響結算；border 根 `eventId` 不等於請求 id 放棄；兩個目標集合併 30、border 回應若含 100 不得重複計入；缺 1500/2500 → 28 列照收，缺其他必備名次放棄；WL：兩陣列角色集合不同、與 `events.chapters` 不符、章節 `eventId` 不符各一個；合法 WL fixture（以第 179 期最終回應錄製，去玩家欄位）產生主榜 30 列、章節數 × 28 列。
   - `sekai_border_finalize` SQL：主榜或任一章節缺任一必備名次 → RAISE 回滾；只缺 1500/2500 的 28 列（主榜與章節各測一次）照收；快照 `taken_at` 剛好等於 `aggregate_at` 時最終列與快照列並存且壓縮不動最終列。
   - 時間桶壓縮的 SQL 對 test schema 跑（見整合）：每桶留最後一筆、只有一筆的桶、沒有資料的桶、延遲啟動（第一筆在 :07）、結算時刻所在的小時、24 小時界線兩側各一筆（前者進 3 小時桶、後者進 1 小時桶，都保留）。
   - `metadata.js`：找到且名稱相同 → complete；找到但名稱不同 → mismatch 且屬性為 null；清單無此 id 第 1、2 次仍 pending 且計數遞增、第 3 次且已過 7 天才 missing、未滿 7 天不轉；`miss → miss → mismatch → miss` 後計數為 1；missing 與 mismatch 列 30 天後再被選到；抓取失敗只更新 checked_at 且計數不變；ETag 304 不重解析。
   - log 不含個資：對一個含玩家欄位的壞回應觸發驗證失敗，斷言 log 字串不含 `name` 值與 `userId`。
2. **整合（Supabase `test` schema，與正式表同結構；`SUPABASE_SCHEMA=test` 缺少時拒跑）**
   - 完整一輪的寫入列數與 slot 對齊；同一 slot 重複觸發不增列。
   - 結算：在 upsert finals 之後、壓縮之前模擬失敗 → 交易回滾、`finalized_at` 仍 null → 重跑成功；兩個並行呼叫只有一個做事。
   - 空窗 no-op；regress 不寫。
   - 遷移演練：以舊表結構的 fixture（含 `'unknown_event'` 列、同一 slot 兩筆、一個只有 29 名次的 slot）與新表 fixture（含候選版本在 `cutover_slot` 前寫的列、以及恰好 `cutover_slot` 的 30 列）跑遷移，斷言：候選列被刪、搬入/丟棄列數與原因、slot 對齊、同 slot 取最晚一筆、不足 30 的 slot 被丟棄、鍵值逐列相等、`cutover_slot` 後的新列原樣保留；另測：全部無效的舊表 → 回滾；`cutover_slot` 處不足 30 列 → 回滾；丟棄比例超過 1% 未帶 `--allow-skipped` → 回滾；源與目的分數不等（人為改一筆）→ 回滾。
   - 回滾 runbook 演練：對 test schema 執行 §7.1 步驟 2 的反向匯入 SQL，斷言舊表補齊的列數。
   - 新舊 view 逐列比對（rank 為鍵）值與型別一致。
   - 權限：以 anon 與 authenticated 角色執行 S4 的 `has_table_privilege` 斷言與實際 DML。
   - 回填：對 3 期做續跑（中斷後重跑不重複）、請求間隔 ≥ 1 秒（以 mock 計時）。
   - 請求預算：每個分支的 mock 請求計數等於 §4.5，含「missing 列 30 天到期重試」一案。
3. **部署驗收**：§7 步驟 2 的候選版本檢查；§6 的 S1 到 S9 全部。
4. **資料面驗收**：回填後 `events` 列數 = `list` 中已結束的期數；`metadata_status='complete'` 的比例與 `missing` / `mismatch` 清單列出人工確認；每個已結束期的主榜與每個章節，`is_final` 列都含 28 個必備名次（主榜約第 110 期起應為 30 列）；WL 期有 `is_final` 列的章節數 = 宣告的章節數。

## 9. 風險與緩解

| 風險 | 緩解 |
|---|---|
| WL live 欄位形狀未知 | 預設關閉 WL 快照；最終榜線走已驗證契約；開跑當天錄 fixture 再開 |
| master db 期數 id 與 hisekai 不一致 | 回填與線上修補走同一條規則：id 找到但名稱不同 → `mismatch`（不採用屬性、列出人工確認）；id 找不到 → 依 §4.4 計數後 `missing`；兩者都允許屬性為 null |
| hisekai 改欄位名 | 形狀驗證在第一輪擋下並記 log；不寫壞資料。兩個 repo 的 CLAUDE.md 註明「改名要同步兩邊」 |
| 誤打錯的 Supabase 專案 | S9 的 ref 確認；整合測試只認 `test` schema |
| Scheduler 重複或延遲觸發 | 5 分鐘 slot + ON CONFLICT；結算在單一交易內持 advisory lock |
| 最終榜在公布前去抓 | 門檻只看 `ranking_announce_at + 15 分鐘`（上游旗標恆為 false，不可用）；最終名次陣列為空則 deferred、下輪重試。**殘餘風險**：公布前上游回的是即時資料（第 182 期實測，陣列非空），若上游延遲超過 15 分鐘才換成最終值，會把未定案的資料結算進去且不會自動更正；觀察期每期結算後 24 小時對帳一次（plan Task 8 Step 11）。deferred 超過公布後 24 小時記 error log；回填腳本遇到 deferred 以非零碼結束 |
| 舊爬蟲與新爬蟲同時寫 | 切流量後只有新爬蟲在跑；舊資料搬移用 ON CONFLICT 以新表為準 |
| 回填誤寫未開始的活動 | 回填與 new-event 都只接受 `start_at <= now`；狀態機以 `started_latest` 為基準 |
| 容量估算失準 | §3.4 改為實測，計畫中有驗收門檻 |

## 10. 給後續子專案的介面承諾

- 讀取只透過兩張表與兩個 view；第 2 子專案的模型以 `sekai_border_rankings (event_id, chapter, rank, taken_at, score, is_final)` 與 `sekai_border_events` 的屬性為唯一輸入。
- 結束活動的曲線：結束前 24 小時每個 UTC 小時桶最多一個點、更早每個 3 小時桶最多一個點（各桶的最後一筆），加上一個 `is_final` 點；缺的桶就是缺，不內插。
- `bonus_characters` 是加成卡角色，不是 banner 的嚴格定義；第 2 子專案若需要更精確的「主打角色」概念，要另找來源。
- 「沒有可比活動」與「只有最終榜線、沒有期中曲線」是第 2 子專案必須處理的狀態（期中曲線從部署後的下一期起才累積）。
- `events` 永遠不含未開始的活動；需要「下一期是什麼」的功能要自己去打 `event/list`。
