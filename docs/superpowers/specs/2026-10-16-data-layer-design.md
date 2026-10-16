# 資料層設計 spec（子專案 1 / 4）

> 日期：2026-10-16。狀態：待 codex 審查。範圍：sekai-border 重構 + Supabase schema 重設計 + 182 期回填 + 網站端最小配合改動。
> 上層方向見同日與 user 的討論結論（記錄於 Claude 記憶 `sekai-redesign-direction`）：網站 AI 改為榜線專用分析器；本子專案是四個子專案中的第一個，後續依序為「預測與三問 API」「手機一覽圖」「解說員與拆舊 agent」。

## 1. 目標與非目標

**目標**

1. 從下一期活動起，永久保留每期榜線的期中曲線（每小時一點）與最終榜線，供第 2 子專案建預測模型。
2. 一次回填第 1 到 182 期的最終榜線與活動屬性（型態、團體、banner 角色、WL 章節）。
3. 把 sekai-border 從單檔腳本重構成有測試、可驗收的小專案，並修掉已知的資安缺口。
4. Supabase 收斂成兩張表、兩個 view；拆掉 RAG 的表、函式與擴充；用量維持在一年 10 到 15 MB。
5. 現有網站的排行頁在整個過程中不中斷。

**非目標**

- 不做預測、不做新 UI、不動 LLM（第 2 到 4 子專案）。
- 不存玩家名稱、玩家 id、卡片等個資；只存名次與分數。
- 不保留 2 萬名以外的榜線（「關注前排、捨棄後排」）。
- 不從第三方網站匯入歷史快照（project-sekai-center 的 GitHub 資料無授權條款）。
- 不做使用者登入、不開任何寫入端點給網站、不發 API 金鑰給第三方。

## 2. 資料來源（外部契約，非本專案掌控）

| 來源 | 用途 | 已驗證的形狀（2026-10-16） |
|---|---|---|
| `https://api.hisekai.org/tw/event/live/top100` | 當期前百快照 | `{id,name,start_at,aggregate_at,player_top_100_rankings:[{rank,name,score,...}],world_link_top_100_rankings:[]}` |
| `https://api.hisekai.org/tw/event/live/border` | 當期榜線快照 | `{...同上..., player_border_rankings:[{rank,score,...}] (18 條: 100..100000), world_link_border_rankings:[]}` |
| `https://api.hisekai.org/tw/event/list` | 全部活動清單（含 WL 章節） | `[{id,name,chapters:[{id,event,chapter,character,start_at,aggregate_at}],start_at,closed_at,aggregate_at,ranking_announce_at}]`，目前 1..202 |
| `https://api.hisekai.org/tw/event/{id}/top100` | 某期最終前百 | `{isEventAggregate,rankings:[100 筆],userWorldBloomChapterRankings:[{gameCharacterId,rankings:[100 筆]}]}` |
| `https://api.hisekai.org/tw/event/{id}/border` | 某期最終榜線 | `{eventId,borderRankings:[18 筆],userWorldBloomChapterRankingBorders:[{gameCharacterId,borderRankings:[13 筆: 100..20000]}]}` |
| Sekai-World TC master db `events.json` | 活動型態與團體 | `{id,eventType: marathon|cheerful_carnival|world_bloom, unit, assetbundleName, startAt, aggregateAt}` |
| Sekai-World TC master db `eventCards.json` | banner 角色 | `{eventId,cardId,bonusRate}` → 以 `cards.json` 的 `characterId` 對應 |

**未驗證、設計上必須容錯**：live 端點在 WL 期間的 `world_link_*` 欄位實際形狀（目前非 WL 期，欄位為空陣列）。設計以最終端點的章節結構（`gameCharacterId` + 每章節一組名次）為預期；見 §5「WL 容錯」。

## 3. 資料模型（Supabase，public schema）

### 3.1 `sekai_border_events`

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | integer PK | hisekai / master db 共用的期數 id |
| `name` | text | 活動名稱（hisekai） |
| `event_type` | text | `marathon` / `cheerful_carnival` / `world_bloom`（master db） |
| `unit` | text | master db 的 `unit`，無則 null |
| `start_at` | timestamptz | hisekai `start_at` |
| `aggregate_at` | timestamptz | hisekai `aggregate_at`（結算時刻） |
| `banner_characters` | integer[] | master db eventCards → characterId，去重 |
| `chapters` | jsonb | WL 章節陣列 `[{chapter, character, start_at, aggregate_at}]`，非 WL 為 `[]` |
| `finalized_at` | timestamptz null | 結算完成時間；null = 尚未結算。**結算的冪等鍵** |

### 3.2 `sekai_border_rankings`

| 欄位 | 型別 | 說明 |
|---|---|---|
| `event_id` | integer FK → events | |
| `chapter` | smallint | 主榜 0；WL 章節 1..n（對應 `events.chapters[i].chapter`） |
| `rank` | integer | 主榜：1..10、20..100（步 10）、200,300,400,500,1000,1500,2000,2500,3000,5000,10000。WL 章節：同一集合 |
| `score` | bigint | |
| `taken_at` | timestamptz | 同一輪抓取的所有列共用同一值 |
| `is_final` | boolean | 最終榜線為 true，`taken_at` = 該期（或章節）`aggregate_at` |

主鍵：`(event_id, chapter, rank, taken_at)`。索引：`(event_id, chapter, taken_at)`。

**三種資料靠保留規則區分，不分表**：

- 當期：每 5 分鐘一列（每輪 30 列；WL 期每章節再加 30 列）。
- 結束的活動：結算時刪除 `taken_at` 非整點的列（`date_trunc('hour', taken_at) <> taken_at` 且 `is_final = false`），留下每小時曲線。整點定義為 UTC 整點；顯示時區由讀取端決定。
- 最終榜線：`is_final = true` 的列。

### 3.3 Views（給現有網站用，欄位與現在的兩個 view 完全相同）

- `sekai_border_current_report`：取代 `view_all_ranking_report`，只看 `chapter = 0` 且 `is_final = false` 的最新快照。
- `sekai_border_daily_report`：取代 `view_day_ranking_report`，同樣限主榜。

兩個 view 皆 `security_invoker = on`。現有 view 的 SQL 定義在遷移時先匯出保存（`pg_get_viewdef`），新 view 以此為基礎只改表名與過濾條件。

### 3.4 容量估計

| 項目 | 列數 | 大小 |
|---|---|---|
| 當期快照（固定） | 30 × 12 × 24 × 9 ≈ 78k（WL 期 ×(1+章節數)） | 6 到 8 MB（含索引） |
| 每期每小時曲線 | 30 × 216 ≈ 6.5k | 約 0.3 MB |
| 182 期最終榜線 | 182 × 30 + WL 章節 | < 1 MB |
| 一年累積 | 36 期 | 10 到 15 MB |

現有 `event_rankings` 的 21 MB（6 MB 資料 + 索引與刪除殘留）在遷移後整表刪除收回。

## 4. sekai-border 執行流程

每 5 分鐘由 Cloud Scheduler 觸發 `POST /run`，一輪四步：

1. **抓取**：並行打 live top100、live border；若回應的 `world_link_*` 非空，連章節一起處理。任一請求失敗（非 2xx、逾時 10 秒、JSON 解析失敗、形狀驗證失敗）整輪放棄、回 500、不寫入。**不重試**（上游 429/5xx 時不加壓）。
2. **活動狀態**：比對回應 `id` 與 `events` 中 `finalized_at is null` 的最新一列：
   - 同一期且 `now < aggregate_at`：寫入快照。
   - 同一期且 `now >= aggregate_at`：進入結算（第 3 步）；結算完成後本輪不寫快照。
   - 新的一期（id 不同）：若前一期尚未結算，先結算前一期；再從 `event/list` 與 master db 補 `events` 一列；再寫入本輪快照。
   - 前一期已結算、hisekai 仍回舊期 id（空窗）：no-op，回 200。
3. **結算**（每期一次，`finalized_at` 當冪等鍵；三步順序固定，任一步失敗則 `finalized_at` 維持 null、下一輪重跑）：
   1. 從 `/tw/event/{id}/border` 與 `/top100` 抓最終榜線，寫入 `is_final = true` 的列（主榜 + WL 章節）。upsert，可重跑。
   2. 刪除該期非整點的快照列。
   3. 寫入 `finalized_at = now()`。
   順序理由：先寫最終再刪快照，中途失敗不會同時失去兩者；刪除是冪等的。
4. **回應**：所有分支經同一個帶 `headersSent` 護欄的 `sendJson(res, status, body)`；200 的 body 含 `{event_id, inserted, finalized, noop}`。非 `POST /run` 一律 404。

**活動屬性**：`events.json`（1.4 MB）與 `eventCards.json`、`cards.json`（4.5 MB）只在「新的一期」時抓一次；抓不到時 `events` 列仍寫入（`event_type`、`unit`、`banner_characters` 為 null / 空），並記 warn log，由下一輪補齊（補齊條件：`event_type is null`）。

**WL 容錯**：live 的 WL 欄位若存在但形狀對不上 §2 的預期，主榜照常寫入，WL 部分不寫、記 error log，並把該輪原始 JSON 以單行 `console.error(JSON.stringify(...))` 印入 Cloud Logging（免費保留 30 天），供修程式後人工回補。

**時間對齊**：`taken_at` 取抓取開始時刻、秒以下歸零；不做 5 分鐘對齊（Scheduler 已固定 `*/5`）。

## 5. 程式結構

```
sekai-border/
  src/
    fetch.js       # upstream calls + shape validation; returns typed objects or throws
    state.js       # pure: decide snapshot / finalize / new-event / noop from (payload, latestEvent, now)
    finalize.js    # finals upsert, hourly compaction, finalized_at
    metadata.js    # event/list + master db → events row
    db.js          # the only module that touches supabase-js (service role)
    server.js      # http server: POST /run only; sendJson guard
  scripts/
    backfill.js    # one-off: events + finals for 1..N; resumable; 1 req/s
  test/
    *.test.mjs     # node --test; unit tests need no network / db
  supabase/
    migrations/0001_sekai_border.sql   # tables, views, grants, RLS, drop old objects (split into steps, see §7)
  index.js         # entry: `node index.js` (server) / `node index.js --once` (single run, replaces fetch_all_rankings.js)
```

`fetch_all_rankings.js` 刪除。`package.json` 加 `"test": "node --test test/"`、`"engines": {"node": ">=22"}`。Dockerfile 維持 node:22-slim + `npm ci`。

## 6. 資安需求（每條可驗收）

| # | 需求 | 驗收 |
|---|---|---|
| S1 | Cloud Run 服務 Require authentication；Scheduler 以專屬 service account 用 OIDC token 呼叫；程式內無共用密鑰 | 外部不帶 token `POST /run` 得 403；Scheduler 執行紀錄為 200 |
| S2 | 只接受 `POST /run` | `GET /`、`POST /` 得 404 |
| S3 | service role key 只存在 Cloud Run 環境變數（建議 Secret Manager）與回填時的本機終端；不進 repo、不進任何 `.env.example` | `git grep -i service_role` 無命中；`.env` 在 `.gitignore` |
| S4 | `anon` 對兩張表只有 SELECT 政策；REVOKE INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER；`authenticated` 同 anon | 以 anon key 嘗試 INSERT 得 401/403；`pg_policies` 只列 SELECT |
| S5 | 兩個 view `security_invoker = on` | `pg_class.reloptions` 檢查 |
| S6 | 刪除 `documents`、`match_documents`、`vector` 擴充、`event_rankings`、兩個舊 view | `get_advisors(security)` 零 finding；`list_tables` 只剩 2 張 + `ai_inferences` |
| S7 | 上游回應寫入前驗證：欄位型別、名次 ∈ 允許集合、分數為非負整數、`id` 為正整數、名次無重複 | 單元測試餵壞資料全部拒寫 |
| S8 | 429/5xx 不重試；每輪最多 2（WL 3）支請求 + 結算時 2 支 | 程式碼無重試迴圈；整合測試計數 |
| S9 | 回填 1 秒間隔、可續跑、啟動時印出目標 Supabase ref 並要求輸入 `yes` 才開始 | 腳本實測 |
| S10 | User-Agent 帶 `BOT_CONTACT` | 既有行為保留 |

S1 現況未知（user 晚間確認）；無論現況為何，驗收以 S1 的結果為準。

## 7. 回填與遷移順序（零停機）

1. **建新物件**：新表、grants、RLS、兩個新 view（先指向舊表 `event_rankings` 的相容查詢），不刪任何舊物件。網站不受影響。
2. **搬當期資料**：`INSERT INTO sekai_border_rankings SELECT ... FROM event_rankings`（chapter 0、is_final false）；補 `events` 第 182 期一列。
3. **切 view**：兩個新 view 改讀新表；sekai-archive 的 `context/RankContext.js` 改兩個 view 名稱並部署；比對新舊 view 回傳列數與欄位一致。
4. **回填**：本機跑 `scripts/backfill.js 1 182`（events + finals；深夜；約 6 分鐘）。第 182 期尚未結束，只補 events，不寫 finals。
5. **部署 sekai-border**：先本機 `docker build` 並以 `--once` 對**測試 schema**跑一輪；`gcloud run deploy --no-traffic --tag candidate`；用 Scheduler 的 service account token 打候選版本一次，確認 200 與寫入；外部無 token 確認 403；切流量；觀察兩輪。
6. **拆舊**：刪 `event_rankings`、舊兩個 view、`documents`、`match_documents`、`vector`；sekai-archive 刪 `lib/tools/{definitions,implementations}/knowledge.js`、registry 對應項、system prompt 中知識庫相關句子、`openai` embeddings 相關程式；部署；跑 `get_advisors`。
7. **收尾**：VACUUM（Supabase 自動）後確認 DB 大小；更新兩個 repo 的 CLAUDE.md 禁區（測試可對測試 schema 跑、正式憑證規則）與 PROJECT.toml。

步驟 5 的 GCP 指令由 user 執行（本機無 gcloud）；計畫會把每一步指令與預期輸出寫成可貼的區塊。

## 8. 測試與驗收

1. **單元（`npm test`，無網路無 DB）**：`state.js` 四種狀態；`finalize.js` 的整點取樣（每小時最後一筆、結算時刻邊界、跨日）；`fetch.js` 形狀驗證（正常、WL 章節、缺欄位、名次重複、負分、非整數、id 非法）；`metadata.js` 的 master db 對應（含找不到期數、cards 缺角色）。fixture 用 2026-10-16 錄下的真實回應。
2. **整合（對 Supabase 的 `test` schema，與正式表同結構）**：完整一輪寫入列數；更替時結算順序與冪等（故意在第 1、2 步之後中斷再重跑）；空窗 no-op；WL fixture（以最終端點結構合成）寫入章節列。整合測試以環境變數 `SUPABASE_SCHEMA=test` 切換，缺少時拒跑，避免誤打正式表。
3. **部署驗收**：§7 步驟 5 的四項檢查；§6 的 S1 到 S9。
4. **資料面驗收**：回填後 `events` 182 列、`event_type` 非空 ≥ 180 列（master db 可能缺最早幾期，缺的列出）；`finals` 主榜每期 30 列；WL 期章節列數 = 章節數 × 30；`rank/score` 無 null。

## 9. 風險與緩解

| 風險 | 緩解 |
|---|---|
| WL live 欄位形狀與預期不符 | §4 WL 容錯：主榜不受影響、原始 JSON 進 log、可回補 |
| master db 期數 id 與 hisekai 不一致 | 回填時逐期比對名稱，不一致者列出人工確認；`events` 允許屬性為 null |
| hisekai 改欄位名（4 月發生過一次） | 形狀驗證在第一輪就會把整輪擋下並記 log；不會寫壞資料。兩個 repo 的 CLAUDE.md 都註明「改名要同步兩邊」 |
| 回填或遷移誤打錯的 Supabase 專案 | S9 的 ref 確認；整合測試只認 `test` schema |
| 結算在 Scheduler 兩輪之間被重複觸發 | `finalized_at` 冪等鍵 + 先寫最終再刪快照 |
| Supabase 容量 | §3.4 估算；每期結算自動壓縮 |

## 10. 給後續子專案的介面承諾

- 讀取只透過兩張表與兩個 view；第 2 子專案的模型以 `sekai_border_rankings` 的 `(event_id, chapter, rank, taken_at, score, is_final)` 與 `sekai_border_events` 的屬性為唯一輸入。
- `hourly` 曲線的第一個點是活動開始後第一個整點，最後一個點是 `is_final` 列；中間若缺整點（例如那一小時上游故障）就是缺，不內插，由模型端處理。
- 「沒有可比活動」是第 2 子專案必須處理的狀態（回填只有最終榜線，期中曲線從 183 期起才累積）。
