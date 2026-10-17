# 子專案 2：榜線預測與三問 — 設計 spec（v10）

> 日期 2026-10-17。上游依賴：子專案 1 資料層（`2026-10-16-data-layer-design.md` v9.2，已上線）。
> 下游消費者：子專案 3（手機一覽圖）、子專案 4（解說員）。涵蓋兩個 repo：sekai-border（WL 即時抓取、序列、預測）與 sekai-archive（三問純函式）。
> v2：納入 codex adversarial review 第 1 輪 11 條；user 決定（2026-10-17）WL 章節即時抓取納入本子專案、結算後刪除前 1000 名的重複快照。
> v3：納入第 2 輪 7 條（第 6 條部分採納，理由見 §4.6）。
> v4：納入第 3 輪 6 條：快照刪除改為兩階段（§3.3、§9）、WL 檢查完全移出主榜路徑、預測寫入單調、容量依章節實際天數、G6 速率單位、A2 遞迴相依檢查。
> v5：納入第 4 輪 6 條：階段一保留前 1000 名原始快照供階段二逐桶驗證、主榜與 WL 分開閘門、寫入 RPC 不以空資料清表且同時間拒寫、真正可中斷的逾時、import 白名單、G6 以實際時間差計速率。
> v6：納入第 5 輪 4 條：無完整原始快照的已結算期一律走通用補序列並永久保留壓縮點（取代 182 特例）、寫入 RPC 加伺服器端 statement_timeout、訓練加 deadline、A2 明訂威脅模型並補 Node 全域 API 檢查。
> v7：納入第 6 輪 3 條：0003／0004 改用明確的可刪除期別清單（不再推斷來源）、寫入 RPC 改用不等待的 advisory lock、訓練以協作式讓出檢查 deadline 並實測耗時上限。
> v8：納入第 7 輪 3 條：RPC 開頭設定 lock_timeout、訓練序列資料上限 40 期且 A15 於上限量測、A6 刪除斷言限定於清單內與 0003 之後的期別。
> v9：納入第 8 輪 2 條：RPC 改以 NOWAIT 表鎖取得寫入獨佔（之後的 DML 不可能等鎖）並限制列數、`prior` 的終線輸入也設上限。
> v10：納入第 9 輪 3 條：路徑長度上限 505 點（窗 > 21 天不預測；歷史最長 12 天）並由 RPC 逐列檢查、`prior` 改為每分組最多 12 個最近樣本（取自全部歷史）、A6／A14 的鎖測試依 PostgreSQL 鎖相容表改寫。

## 1. 目標與非目標

**目標**

- G1 每 5 分鐘為當期的每條線（主榜＋進行中的 WL 章節 × 名次）產出終線預測 P10／P50／P90 與到結算為止的路徑區間。
- G2 三問（守得住嗎／差多少／能睡多久）：輸入為使用者自行輸入的分數＋目標名次，在使用者瀏覽器內計算。
- G3 每結算一期自動重新訓練；不需改程式或 schema。演算法固定，新參數只多資料；回測成績寫進參數，退步可見（§4.6）。
- G4 對 hisekai 零新增請求；Supabase 年增以 §8 A1 的實測公式驗收（上限 6 MB／年）。

**非目標**

- 不用 LLM（子專案 4）；不做畫面（子專案 3）。
- 不做「自動抓玩家」（只限前百且需新表；子專案 3 若要顯示玩家名稱再議，晚加不損失資料）。
- 不存使用者輸入的分數、不存玩家名稱。
- 只預測 `ALLOWED_RANKS`（WL 章節為其中 28 個，無 1500／2500），中間名次不內插。
- 不使用 project-sekai-center.com 的程式、參數或資料（無授權）；只借其公開描述的方法思路。

## 2. 硬規則

- R1 只有 sekai-border 爬蟲呼叫 hisekai。本子專案不新增任何上游請求：每輪仍為 `live/top100`＋`live/border` 兩個（WL 章節資料就在這兩個回應裡），活動更替與結算時另有子專案 1 既有請求。**已知例外**：sekai-archive 的 4 個聊天工具（`lib/tools/implementations/{ranking,border,player,strategy}.js`）仍直接呼叫 hisekai，於子專案 4 拆除；本子專案新增的程式不得再加任何呼叫點。
- R2 預測失敗不得影響快照寫入與結算；WL 章節抓取失敗不得影響主榜寫入。
- R3 表要精簡：每個欄位都有上線後的讀者；能推導的不存；不開除錯或監控用欄位。
- R4 容量主張以實測為準，上限寫成驗收條件。

## 3. 資料

### 3.1 WL 章節即時抓取（改子專案 1 的 `validateLive` 與 `run.js`）

- 契約（hisekai 文件 `docs.hisekai.org/en/docs/data` 的 `world_link` 物件，2026-10-17 讀取）：`live/border.world_link_border_rankings` 與 `live/top100.world_link_top_100_rankings` 各為 `world_link[]`；每個元素有 `id, event, chapter, character, start_at, aggregate_at, ranking_announce_at`，以及**依端點只有其中一個**名次陣列：border 端點為 `player_border_rankings`、top100 端點為 `player_top_100_rankings`（文件原文：“Will return player_border_rankings or player_top_100_rankings depending on the requested endpoint”）。玩家元素與主榜相同（`rank, name, score, …`）。非 WL 期兩個陣列為空（2026-10-17 實測第 182 期）。
- 兩階段驗證：`validateLive` 只驗主榜，**完全不檢查** WL 欄位，只把 `border.world_link_border_rankings` 與 `top100.world_link_top_100_rankings` 原值（可能缺欄、null 或任何型別）交出；所有 WL 形狀檢查都在主榜寫入之後、`validateWl` 內進行；`run.js` 在取得可信的章節定義之後（已知活動讀 `sekai_border_events.chapters`；新活動用 `chaptersFromList` 的結果）才呼叫 `validateWl({ border, top100, eventId, slot, chapters })`。
- 取用規則：只取 `start_at ≤ slot < aggregate_at` 的章節（以可信章節定義的時間為準，不信任上游元素自帶的時間）；元素以 `chapter` 對應已宣告章節，且 `character` 必須等於宣告的 `character_id`、`event` 必須等於 live id，否則該章節記 `wl_chapters` 錯誤。名次挑選與排序檢查沿用主榜的 `pick`／`checkRows`，1500／2500 視為可缺（`FINAL_OPTIONAL`）。border 陣列取 `BORDER_TARGET`、top100 陣列取 `TOP_TARGET`，兩者合併為該章節的列。
- 隔離：主榜照現行流程驗證、寫入。章節列另外驗證、另一次寫入；任何章節錯誤（形狀、對應、排序、寫入）只記 ERROR `wl ingest failed`（含章節號與錯誤碼，不含玩家欄位），該輪不寫任何章節列，主榜不受影響，`/run` 狀態碼不因此改變。回應新增 `wl_inserted`。
- 移除 `WL_INGEST` 環境變數：抓取一律嘗試，安全性由隔離保證。
- 驗證時點：下一個 WL（第 202 期，2027-04-18 開跑）第一輪，錄下兩個 live 回應（去除玩家名稱等欄位）存成 `test/fixtures/live-wl-*.json`，加一個以真實回應跑 `validateLive` 的測試；不符契約則修正，期間主榜不受影響。此為上線後的追蹤任務（§9 步驟 7）。

### 3.2 `sekai_border_series` — 前 1000 名的每小時序列（新表）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `event_id` | int, FK → events | PK |
| `chapter` | smallint | 0＝主榜；WL 章節號。PK |
| `rank` | int, check `rank ≤ 1000` 且 ∈ ALLOWED_RANKS | PK |
| `start_at` | timestamptz | `floor_hour(W_start)` |
| `scores` | bigint[] | 長度 N；`scores[i]`＝`taken_at ∈ [start_at + i h, start_at + (i+1) h) ∩ [W_start, W_end)` 內最後一筆非 final 快照的分數；該桶無快照為 null |

- 時間窗：主榜 W＝[event.start_at, event.aggregate_at)；章節 W＝[chapter.start_at, chapter.aggregate_at)。N＝ceil((W_end − floor_hour(W_start))／1 h)。例：W_end＝12:59:59 時含 12 點桶；W_end＝13:00:00 時不含 13 點桶。
- 某 (chapter, rank) 在窗內沒有任何快照則不寫該列。
- 寫入：在 `sekai_border_finalize` 內、刪除快照之前、同一交易，`on conflict do nothing`。寫入失敗即整個結算回滾，下一輪重試（子專案 1 既有「延後 > 24 h 記 ERROR」為警報）。
- 實測依據：第 182 期 rank 1000 的 139 點陣列 `pg_column_size`＝1,136 bytes。

### 3.3 結算時的快照刪除規則（改子專案 1 的 `sekai_border_finalize`；兩階段）

- **階段一（0002）**：序列寫入之後，rank ≤ 1000 的非 final 快照**原樣保留不壓縮**（供階段二以完整原始資料驗證）；rank > 1000 照子專案 1 規則壓縮；final 列不動。相對子專案 1 的行為只有「多寫序列、少刪前 1000 名」，不刪除任何子專案 1 會保留的資料。暫時代價：每個主榜期多保留約 10 MB（依 164.6 bytes／列 × 24 名次 × 窗內 slot 數），於階段二釋放。
- **階段二**分兩個閘門，各自一個 migration：
  - **0003（主榜）**：至少兩期主榜以階段一結算後，逐期、逐 (rank ≤ 1000) 以資料庫內保留的完整原始快照驗證 chapter 0 的序列：(1) `start_at`、陣列長度符合 §3.2；(2) 每個桶：原始快照中該桶最後一筆觀測 ＝ 序列值，且無觀測的桶 ＝ null（雙向）；(3) 原始快照中每一筆都落在某個桶內。全部通過才套用。套用後結算改為刪除 chapter 0 rank ≤ 1000 的非 final 快照；並以一次性交易對階段一期間已結算的期別重做 (1)–(3) 的斷言後刪除，任一斷言失敗整筆回滾。
  - **可刪除期別採明確清單、預設不刪**：0003／0004 的 migration 檔內寫死一份 `event_id` 清單，只對清單內的期別刪除；清單只收錄「由階段一結算函式結算（以 rollout ledger 中該期結算時的 revision 與 migration 版本為據），且在套用前一刻以資料庫內原始快照通過 (1)–(3)」的期別，套用時再對清單內每一期重做 (1)–(3)，任一失敗整筆回滾。不在清單內的期別一律保留（包括：0002 之前結算的第 182 期、回滾期間以子專案 1 結算函式結算的期別、以及任何來源不明者）；它們以 `scripts/series-from-backup.js <event_id>`（§9 步驟 3）補序列，壓縮點永久保留（每期約 2,000 列、0.3 MB）。0003 套用後新結算的期別由新版結算函式直接處理，不需清單。
  - **0004（WL 章節）**：第 202 期（第一個真實 WL）以階段一結算、且其各章節序列以同樣 (1)–(3) 驗證通過後才套用；作用同 0003，對象為 chapter > 0。在此之前章節的 rank ≤ 1000 原始快照一律保留。

子專案 1 spec §10「已結束活動的曲線在 `sekai_border_rankings`」的承諾改為：rank ≤ 1000 在 `sekai_border_series`、rank > 1000 在 `sekai_border_rankings`（壓縮後）。目前沒有任何消費者讀已結束活動的快照（網站的兩個 view 只讀進行中的一期）。

### 3.4 `sekai_border_model` — 模型參數（新表，固定 1 列）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | smallint PK, check (id = 1) | |
| `trained_at` | timestamptz | |
| `params` | jsonb | §4.5 的產出；結構與有限值由 `src/forecast/params.js` 驗證 |

### 3.5 `sekai_border_forecasts` — 當期最新預測（新表，每輪覆寫）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `event_id`, `chapter`, `rank` | PK | 主榜＋進行中章節的各名次 |
| `computed_at` | timestamptz | 所依據的 slot；消費端判斷過期 |
| `current_score` | bigint | 該線在 `computed_at` 的分數（「現在差多少」「已在名次外」用） |
| `final_p10`, `final_p50`, `final_p90` | bigint | check `current_score ≤ final_p10 ≤ final_p50 ≤ final_p90` |
| `path` | jsonb | `{"t0": ISO, "p10": [...], "p50": [...], "p90": [...]}`，見 §4.3 |
| `method` | text, check in ('model','measured','prior','linear') | 權重最大的成員（`profile`→'model'），畫面標示用 |
| `confidence` | text, check in ('normal','low') | 由推論端依校正樣本數決定（§4.3），畫面標「僅供參考」用；消費端無法自行推導（樣本數在 `model` 內、不對 anon 開放） |

- 寫入 RPC `sekai_border_put_forecasts(p_event_id int, p_computed_at timestamptz, p_rows jsonb)`：**SECURITY INVOKER**、物件名一律帶 schema；函式第一個動作為 `lock table {{schema}}.sekai_border_forecasts in exclusive mode nowait`（攔截 lock_not_available → 回傳 `{ written: false, reason: 'busy' }`）。EXCLUSIVE 與任何寫入者持有的 ROW EXCLUSIVE 衝突，因此一旦取得，表上不可能有其他交易持有列鎖，之後的 DELETE／UPSERT 不會等待任何鎖；同時串行化所有寫入（不另用 advisory lock）。`p_rows` 超過 120 列、或任一列 `path` 的任一分位陣列長度超過 505（＝21 天 × 24 ＋ 1），即 raise（payload 因此有固定上限，DML 不等鎖，執行時間有界）。另設 `set_config('lock_timeout', '2s', true)` 作為防禦；`p_rows` 的每一列 `event_id` 必須等於 `p_event_id`、`computed_at` 必須等於 `p_computed_at`，否則 raise；`p_rows` 為空陣列時不做任何事、回傳 `{ written: false, reason: 'empty' }`（因此表在第一次寫入後永不被清空，表內最大 `computed_at` 即為持久的水位）；若表內任一列的 `computed_at >= p_computed_at`，不寫入並回傳 `{ written: false, reason: 'stale' }`（同一 slot 只接受第一次寫入；較舊的一輪不得覆寫較新的、也不得刪除新一期的列）；否則同一交易內刪除 `event_id <> p_event_id` 的列與本期不在 `p_rows` 內的列，再 upsert。`revoke execute … from public, anon, authenticated; grant execute … to service_role`。
- 不設 view；消費端直接讀此表（R3）。

### 3.6 權限

照子專案 1 慣例：三張新表 revoke all from public/anon/authenticated → grant 給 service_role；RLS 開啟；只有 `forecasts` 有 anon／authenticated 的 select policy。`series`、`model` 不對 anon 開放。

## 4. 模型

### 4.1 名詞

- 線＝(event, chapter, rank)；家族：`main`（chapter 0）與 `wl`（chapter > 0）分開訓練與校正。
- 窗 W 同 §3.2；進度 τ＝(t − W_start)／(W_end − W_start)。
- 對數誤差 e＝ln(預測／實際終線)；實際終線 ≤ 0 的線不參與任何誤差統計。
- 名次群：G1＝1–3、G2＝4–10、G3＝20–100、G4＝200–500、G5＝1000、G6＝1500–10000。
- 進度格邊界 [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1]；格的代表點＝中點 {0.075, 0.225, 0.4, 0.6, 0.775, 0.925}。
- 校正格＝(家族, 名次群, 進度格)。

### 4.2 成員

| 成員 | 預測式 | 可用條件 |
|---|---|---|
| `linear` | s_now／τ | τ ≥ 0.02 且 s_now > 0 |
| `measured` | s_now＋v×剩餘時數；v＝(s_now − s_{now−L})／L，L＝24 h（窗內已有 ≥ 24 h 資料）否則 6 h | 窗內已有 ≥ 6 h 資料、對應的過去快照存在、v ≥ 0 |
| `prior` | 同家族、同 `event_type`（WL 章節不分 type）、同天數（主榜 `round(窗長/1 d)`；章節同）、時間上**早於本期**的各期該名次終線中**最近 12 個**正值樣本的加權對數平均，權重 0.5^(距今期數／6)（距今期數以該家族所有期別的序號差計）；終線 ≤ 0 的樣本排除且不計入樣本數 | 至少 2 個正值樣本 |
| `profile` | s_now＋r̂×Σ m(h)，h 為從 now 到 W_end 的每小時；r̂＝近 6 h 實際增量／同期間剖面期望增量 | 該 (家族, 名次群) 剖面已啟用（§4.6），且 r̂ 有限且 > 0 |

- 任何成員的預測若非有限值或 < s_now，視為該次不可用。
- 剖面模型以**每小時速率**為單位：ρ＝Δ／k（Δ 為相鄰且兩端皆非 null 的觀測之間的增量，k 為兩者間隔的小時數；不跨缺口）。ln(ρ＋1) ＝ a_line ＋ f_hod(台灣時段) ＋ f_hte(距結算時數格 [0,1,2,3,4,6,9,12,18,24,∞)) ＋ f_hfs(開跑時數格 [0,1,2,3,6,12,24,∞)) ＋ f_wk(週末)；各因子以該區間中點時刻取格。G1–G5 用 `series`（k＝1）、f_hod 24 格；G6 用壓縮後快照（只用窗內早於最後 24 h 的部分；相鄰的定義為 epoch 對齊的 3 小時桶索引相差 1，跨過缺桶即不相鄰；k 取兩筆保留觀測的實際時間差（小時，可為非整數），不假設為 3）、f_hod 8 格（每格 3 小時，推論時每小時查其所屬格）。m(h)＝exp(f(h))，即期望的每小時速率乘數；推論的 Σ m(h) 逐小時加總，單位一致。以最小平方擬合，每 (家族, 名次群) 一組；a_line 為每條訓練線各自的截距（推論時以 r̂ 取代）。
- 推論只讀：每條線在最新 slot、6 h 前、24 h 前的快照，及 `params`。不讀整段序列。

### 4.3 合成、區間、路徑、信心

- 權重 w_k ∝ 1／σ_k²，σ_k 取自 `params` 的校正格（缺格時依 §4.4 退層），只對可用成員正規化。
- ln P50＝Σ w_k ln p_k，再取 max(P50, s_now)。
- 區間用合成預測的回測殘差經驗分位數：校正格內 e_c 的第 10、90 百分位 q10、q90。P10＝min(P50, max(s_now, P50×exp(−q90)))；P90＝max(P50, P50×exp(−q10))。四捨五入成整數後再依序夾值一次（P10 ≥ s_now、P50 ≥ P10、P90 ≥ P50），保證 §3.5 的順序約束（殘差全為正或全為負時亦成立）。
- 路徑時間點：t0＝`computed_at` 之後的第一個整點；點依序為 t0, t0＋1 h, …（嚴格早於 W_end 的整點），最後一點為 W_end 本身。陣列長度＝這些時間點的數量（≥ 1）。F(t)＝從 now 到 t 的期望增量占到 W_end 總剩餘增量的比例（有剖面用剖面；否則按時間線性）；path_q(t)＝s_now＋(final_q − s_now)×F(t)。構造上非遞減，末點等於終線。
- `confidence`＝'low' 當任一條件成立：`method ∈ ('linear','prior')`；所用區間來自 §4.4 的第 3 層或預設層；該校正格的合成殘差樣本數 < 20。否則 'normal'。

### 4.4 退層與無參數

- σ_k 與殘差分位數的查找順序：(1) 校正格（樣本 ≥ 8 才用 σ_k，≥ 20 才用分位數）；(2) 同 (家族, 名次群) 合併所有進度格；(3) 同家族合併所有名次群；(4) 預設：σ_k＝0.25，q10＝−0.32、q90＝0.32。
- 可用成員為空集合時該線不產出列。
- 窗長超過 21 天的主榜或章節不產出預測（歷史最長主榜 12 天、章節 3 天，2026-10-17 查詢）。
- `params` 不存在（首次訓練前）或驗證失敗：不產出任何預測列（消費端顯示 `no_forecast`），記 WARN。
- σ_k 下限 0.03。

### 4.5 訓練（`src/forecast/train.js`）

- 時機：同一輪 `/run` 中有活動結算成功之後（結算交易 commit 後）；`scripts/train.js` 可手動執行。
- 輸入上限：`series` 與壓縮後快照（G6）只取**最近 40 個**已結算的主榜期與最近 40 個章節（約一年；訓練計算量因此有固定上限，`linear`／`measured`／`profile` 的回測也只在這個範圍內進行）；`prior` 的先驗表從**全部**歷史終線建立，但每個分組 (家族, event_type, 天數, rank) 只保留時間上最近的 12 個正值樣本（稀疏分組因此不會因全域截斷而失去樣本；終線列數每年約增加 1,100 列，讀取成本可忽略）；`prior` 的 rolling-origin 回測只評估最近 120 個主榜期與 120 個章節，每一折的先驗計算為每分組 ≤ 12 個樣本。所有訓練輸入、折數與每折計算量因此有固定上限。
- 回測採**時間順序（rolling-origin）**：依 W_start 排序，評估第 j 期時，`prior` 與 `profile` 只用 W_end 早於第 j 期 W_start 的期別訓練；在每個進度格代表點 τ_b，以「當時以前」的資料（`series` 每小時值、G6 用壓縮後快照）重建 s_now、6 h／24 h 前的值，產生各成員與合成預測，與實際終線比較。
- `prior` 的回測涵蓋輸入上限內所有有終線的期別；`linear`／`measured`／`profile` 只涵蓋有序列或快照的期別。
- 產出 `params`：剖面係數（只含已啟用者）、各成員每校正格的 σ_k（RMS of e）與樣本數、合成殘差每校正格的 q10／q90 與樣本數、歷史先驗表（每 (家族, type, 天數, rank) 的加權對數平均與樣本數）、回測摘要（每校正格的平均 |e|、P10–P90 覆蓋率）。
- 寫入前驗證：所有數值有限；σ ∈ (0, 2)；q10 ≤ q90；樣本數為非負整數。不通過即不寫、記 ERROR、保留舊列。

### 4.6 剖面啟用

`profile` 在某 (家族, 名次群) 啟用的條件：有序列（或 G6 有快照）的已結算期 ≥ 3，且該群 rolling-origin 回測中 `profile` 的平均 |e| 低於 `linear`（樣本 ≥ 8）。否則不放進 `params`。

不設「候選參數 vs 已部署參數」閘門（codex 第 2 輪第 6 條，部分採納）：rolling-origin 回測中，第 j 期的評估只用 j 之前的期別，候選與已部署參數在舊期別上的折完全相同，唯一差異是最新一期；在該期上兩者沒有公平的比較基準（已部署參數未見過它、候選已見過）。因此比較閘門大多空轉，卻需保存第二份參數（違反 R3）。改以：(1) 回測摘要記錄每期的折內誤差，最新一期誤差異常可直接看到；(2) `scripts/train.js --exclude <event_id,…>` 排除異常期別重新訓練並覆寫，作為回退手段，不需保存舊版本。

## 5. 三問（sekai-archive `lib/border/answer.mjs`）

### 5.1 介面

`answer({ forecast, window, now, score })`：`forecast`＝目標線的 `sekai_border_forecasts` 一列；`window`＝`{ start_at, aggregate_at }`（主榜或該章節）；`now`＝Date；`score`＝使用者分數（非負整數）。純函式、無 I/O。前提一律為「現在停手」。

- `light`：`'safe'`（score ≥ P90）、`'risky'`（P50 ≤ score < P90）、`'losing'`（score < P50）。
- `gap`：`{ now: current_score − score, safe: P90 − score, even: P50 − score }`（負值＝領先）。
- `sleep`：`{ safeHours, evenHours }`。依 §4.3 重建每個路徑點的時間；**忽略時間 ≤ now 的點**；`current_score > score` → 0；否則找第一個 path.p90（p50）> score 的點，回傳 (該點時間 − now) 小時、無條件捨去到 0.5；全程不超過 → `'until_end'`。
- 另回傳 `method`、`confidence`。

### 5.2 狀態（由上而下判斷）

1. `now ≥ window.aggregate_at` → `{ state: 'closed' }`。
2. 無 `forecast` → `{ state: 'no_forecast' }`。
3. 其餘照常計算；`now − computed_at > 15 分` 時加 `stale: true`（畫面灰化，顯示「預測暫停更新」）。

### 5.3 輸入保存

分數與目標名次只存在瀏覽器 localStorage（子專案 3）；不送伺服器。

## 6. 程式結構

**sekai-border**

- `src/validate.js`：`validateLive` 回傳 `{ event, rows, wlRaw: { border, top100 } }`，`wlRaw` 為上游原值、不做任何檢查（§3.1）；新增 `validateWl({ border, top100, eventId, slot, chapters })` → 章節列；移除 `wlIngest` 參數。
- `src/run.js`：主榜寫入後另寫章節列（隔離）；結算之後呼叫 `infer`；有結算成功時呼叫 `train`。各自 try/catch，失敗只記 log，不改變 `/run` 狀態碼。回應新增 `wl_inserted`、`forecast: { rows } | { error }`、`trained`。
- `src/forecast/`：`members.js`、`profile.js`、`combine.js`、`params.js`、`infer.js`、`train.js`、`series.js`（JS 版序列推導，與 SQL 同義）。`src/forecast/*` 不得 import `src/fetch.js`。
- `src/db.js`：`insertSnapshot` 不變（章節列也走它）、`loadSlots`、`loadModel`、`putForecasts`、`saveModel`、訓練用讀取。
- `src/env.js`：移除 `WL_INGEST`。
- `scripts/train.js [--exclude <event_id,…>]`、`scripts/backtest.js`（印回測摘要）、`scripts/series-from-backup.js`（§9 步驟 3）。
- `supabase/migrations/0002_forecast.sql.tmpl`（階段一）：三張表、grants、RLS、`sekai_border_put_forecasts`、多寫序列的 `sekai_border_finalize`；`0002_rollback.sql.tmpl`；`0003_purge_main_dup.sql.tmpl`、`0004_purge_wl_dup.sql.tmpl`（階段二：結算改刪 rank ≤ 1000 快照＋既有期別的一次性驗證與刪除，主榜與章節分開）。

**sekai-archive**

- `lib/border/answer.mjs`＋`scripts/test/answer.test.mjs`（`npm test` 已涵蓋 `scripts/test/*.test.mjs`）。

## 7. 錯誤處理

| 情況 | 行為 |
|---|---|
| WL 章節驗證或寫入失敗 | 記 ERROR `wl ingest failed`；該輪無章節列；主榜照寫 |
| 推論拋錯或逾時（> 20 s） | 記 ERROR `forecast failed`；`forecasts` 不動（消費端以 `computed_at` 判過期）。逾時實作：推論持有一個 20 s 的 `AbortController`，所有資料庫讀取以 `.abortSignal(signal)` 發出；`/run` 以 deadline 包住整個推論，逾時即 abort 並記錄；寫入 RPC 只在推論開始後 15 s 內才發出（超過即視為逾時、不寫），並以同一 signal 發出。RPC 以 NOWAIT 取得表鎖、之後的 DML 不等待任何鎖、列數有上限（§3.5），因此寫入在發出後的有界時間內提交或回滾，不會在逾時後提交。模型計算為同步純函式、輸入有界（單輪最多約 60 條線），不會長時間佔用執行緒 |
| RPC 回傳 busy | 記 WARN；不重試（下一輪會再寫） |
| 訓練逾時（> 60 s） | 訓練持有自己的 60 s deadline：所有讀取與 `saveModel` 以 `.abortSignal(signal)` 發出；rolling-origin 每完成一期的折就 `await` 讓出一次執行緒並檢查 deadline，超過即中止；`saveModel` 只在 50 s 內發出。逾時記 ERROR `train failed`、保留舊 `params`，`/run` 照常回應 |
| RPC 回傳 stale | 記 WARN；不重試 |
| `params` 不存在或驗證失敗 | 不產出預測列；記 WARN |
| 單列違反不變量（§8 A4） | 該列不寫、記 ERROR；其他列照寫 |
| 序列寫入失敗 | 結算整筆回滾，下一輪重試 |
| 訓練失敗或參數驗證不通過 | 記 ERROR，保留舊 `params` |
| 活動更替 | 新期第一輪的 RPC 刪除上一期的列 |

## 8. 驗收條件

- A1 容量（在 `test` schema 受控量測，沿用子專案 1 `docs/superpowers/plans/capacity-2026-10.md` 的作法；部署前完成）：
  - 主榜：以第 182 期本機備份的真實快照載入 `test`（換用未使用的 event_id），執行新版結算，`VACUUM (FULL, ANALYZE)` 兩張表後量 `pg_total_relation_size(rankings)＋pg_total_relation_size(series)`，減去載入前同樣 VACUUM FULL 後的空表基準，得每期保留量 B_main（kB）。
  - WL 章節：以合成資料（28 名次、5 分鐘 slot）分別量 2 天與 3 天章節的保留量，換算成每章節小時的保留量 b_ch（並記錄兩者以確認近似線性）；第 202 期結算後以真實資料在 `test` 重量一次。
  - 年增＝B_main × 過去 365 天開跑的主榜期數 ＋ b_ch × 同期所有章節的實際小時數總和（由 `sekai_border_events.chapters` 計）。
  - 量測對象為**階段二**的結算規則（長期狀態）；階段一期間每期多保留的原始快照（約 10 MB／主榜期）另列，於 0003／0004 套用時釋放。
  - 進行中的期別在結算前的快照空間會在結算後被重複利用，不計入年增；其高峰另列（主榜約 17 MB、WL 期另約 16 MB，量測時一併記錄）。
  - 通過條件：年增 ≤ 6 MB；`model` 單列 ≤ 200 kB；`forecasts` 滿載（主榜＋一個章節）≤ 500 kB。預期約 5.2 MB／年。
- A2 上游請求：`test/run.test.js` 以計數的 upstream stub 斷言：一般輪 `live()` 恰 1 次（＝2 個 HTTP 請求）、`eventList()`／`finals()` 只在子專案 1 既有條件下呼叫。推論、訓練、`validateWl` 的測試檔先把 `globalThis.fetch` 換成一被呼叫就拋錯的替身，之後才以動態 `import()` 載入受測模組。另以測試從 `src/forecast/*.js` 出發遞迴走訪所有 import，採**白名單**：整棵樹只允許指向 `src/forecast/` 內檔案與 `src/constants.js` 的相對路徑；任何 bare specifier、`node:` 內建模組（含 `node:module`）、動態 `import()` 或 `require` 皆判違規。反例檔（`node:http2`、`createRequire('node:https')`、經本地包裝間接 import `node:https`）必須全部被判違規。資料庫存取只經由注入的 `db` 物件。此外以 AST 檢查整棵樹不得出現 `process.getBuiltinModule`、`process.binding`、`fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource` 等識別字（反例檔各一）。威脅模型：本條防的是**我們自己不小心新增上游請求**，不是防惡意程式（程式碼全為本專案撰寫並經審查）。
- A3 速度：上線後 24 h 的 Cloud Run `/run` 平均延遲比上線前（2.25 s）增加 < 1.5 s。
- A4 不變量（單元測試＋推論時逐列檢查）：`current_score ≤ final_p10 ≤ final_p50 ≤ final_p90`；所有值為有限整數；`path` 各分位非遞減、長度符合 §4.3、末點等於對應終線。
- A5 序列等價與邊界：整合測試中同一批快照經 SQL 與 `series.js` 推導完全相同；涵蓋 W_end＝:59:59 與整點、窗內缺桶、某名次完全無快照、章節窗。
- A6 結算安全：整合測試中，使序列插入失敗 → 結算回滾、快照未刪、`finalized_at` 為 null。階段一成功時：序列寫入、rank ≤ 1000 的非 final 快照原樣保留、rank > 1000 依子專案 1 規則壓縮。0003 套用後：**清單內的期別**與**0003 之後由新版結算函式結算的期別**，其 chapter 0 rank ≤ 1000 的非 final 快照為 0 列；**不在清單內的已結算期別**（例如以子專案 1 規則壓縮的稀疏快照，以及由它推導、彼此一致的稀疏序列）其快照一筆都不得減少；章節的保留不變。0004 對章節同理。驗證斷言（§3.3 (1)–(3)）以刻意竄改的序列（錯一個桶、少一個桶、多一個非 null）測試必須失敗並整筆回滾。A14 另含：以另一連線持有與 EXCLUSIVE 衝突的鎖（未提交的 UPDATE 所持的 ROW EXCLUSIVE、`LOCK … IN SHARE MODE`、`ACCESS EXCLUSIVE`）時，RPC 立即回傳 busy、表不變、之後也無延遲提交；另一連線只是在交易中 SELECT（ACCESS SHARE，與 EXCLUSIVE 相容）時，RPC 照常寫入；`p_rows` 121 列、或某列 `path` 長度 506 時 raise。
- A7 權限：anon 可 select `forecasts`；anon 對 `series`／`model` 的 select、三張表的寫入皆 42501；`has_function_privilege('anon', 'sekai_border_put_forecasts(int, timestamptz, jsonb)', 'execute')` 為 false，且以 anon 實際呼叫該 RPC 失敗。
- A8 WL：以依 §3.1 契約手工合成的 live 回應（border 元素只有 `player_border_rankings`、top100 元素只有 `player_top_100_rankings`）測試：正常時寫入進行中章節的列；章節形狀錯誤、`character`／`event` 不符、章節不在進行中、章節寫入失敗時，主榜列照常寫入且 `/run` 狀態碼不變；非 WL 期（空陣列）不寫章節列也不記 ERROR；新活動第一輪（章節來自 `event/list`）也能寫章節列。
- A9 數值健全：單元測試涵蓋 s_now＝0、全零序列、稀疏序列、v < 0、r̂ 非有限、歷史終線含 0 → 對應成員不可用或樣本被排除、無 NaN／Infinity 寫出；殘差全正／全負時區間順序仍成立；`params` 含非有限值時驗證拒絕。
- A10 回測：`scripts/backtest.js` 產出每校正格的平均 |e| 與覆蓋率；rolling-origin 的測試斷言評估第 j 期時未使用任何 W_end ≥ 第 j 期 W_start 的期別。冷啟動期不設準度門檻。
- A11 剖面啟用：單元測試中，期數 < 3 或贏不過 `linear` 時不啟用。
- A12 三問：`answer.test.mjs` 涵蓋燈號邊界（= P50、= P90）、`sleep` 的 0／until_end／一般／過期多小時（忽略過去點、不出現負值）、W_end 非整點、§5.2 三種狀態。
- A13 預測寫入單調：整合測試中，(a) T2 寫入後以 T1 < T2 呼叫 → stale、表不變；(b) 以 T2 再呼叫一次（同 slot）→ stale、表不變；(c) 以空 `p_rows`、T3 > T2 呼叫 → empty、表不變，之後以 T1 呼叫仍為 stale；(d) 新一期 T2 寫入後，舊一期以 T1 呼叫不得刪除新一期的列；(e) `p_rows` 內 event_id 或 computed_at 與參數不符 → raise、表不變。
- A14 逾時：單元測試以替身驗證（時間在測試中縮短）：(a) 推論讀取卡住 → abort、記錄 `forecast failed`、寫入從未被呼叫、`/run` 照常回應；(b) 讀取在 15 s 後才完成 → 不發出寫入；(c) 訓練讀取或 `saveModel` 卡住 → 記錄 `train failed`、`/run` 照常回應；(d) 每一折都刻意變慢的訓練 → 在 deadline 後的下一個讓出點中止、不寫入。整合測試：在 `test` schema 以另一連線持有與 EXCLUSIVE 衝突的鎖（未提交的 UPDATE 所持的 ROW EXCLUSIVE、`LOCK … IN SHARE MODE`、`ACCESS EXCLUSIVE`）時，RPC 立即回傳 busy、表不變、之後也無延遲提交；另一連線只是在交易中 SELECT（ACCESS SHARE，與 EXCLUSIVE 相容）時，RPC 照常寫入；`p_rows` 121 列、或某列 `path` 長度 506 時 raise。
- A15 訓練耗時：以合成資料在**訓練輸入上限**（40 主榜期＋40 章節的完整序列與壓縮快照、全部歷史終線，其中每個 prior 分組放 30 個樣本以驗證只取 12 個）於 Cloud Run 同規格（1 vCPU）實測 `train` 全程 < 10 s；並斷言 `train` 實際使用的序列期數、回測評估期數、每個 prior 分組的樣本數都不超過上限（資料庫中多放超過上限的期別時亦然）。另以稀疏分組測試：某分組只有 2 個樣本且一個位於很早的期別時，`prior` 仍可用。

## 9. 上線順序

1. 0002（階段一）先套 `test` schema → 整合測試全綠 → 在 `test` 完成 A1 量測並通過 → 套 `public`（MCP `apply_migration`，user 在旁按同意）。
2. 部署新爬蟲 revision（gcloud 由 user 執行）；現行 revision 保留為回滾點。
   - 回滾：(a) 切回舊 revision；(b) 執行 `supabase/migrations/0002_rollback.sql.tmpl`：以子專案 1 版本的 `sekai_border_finalize` 取代新版、drop `sekai_border_put_forecasts`；三張新表保留（無害、可再用）。整合測試涵蓋「套 0002 → 回滾 → 舊版結算行為與子專案 1 測試一致」。回滾期間結算的期別沒有序列，重新上線後依步驟 3 補序列（壓縮點永久保留，資訊不比子專案 1 少）。
   - 階段一的結算不刪除任何子專案 1 會保留的資料，因此回滾不需要還原資料。
3. 對每一個「已結算但沒有序列」的期別（部署前結算的第 182 期；回滾期間結算的期別）：`scripts/series-from-backup.js <event_id>`（只補序列，不刪任何快照；這些期別的壓縮點依 §3.3 永久保留）
   - 輸入：所有 `.superpowers/backup/event-<id>-raw-*.csv.gz`（可以沒有）**與**資料庫中該期現存的非 final 快照，取聯集（同 slot 同名次以資料庫為準）。資料庫現存的點因此一定被納入，不論本機備份涵蓋到哪裡都不會損失資訊。
   - 以 `series.js` 推導序列，印出涵蓋範圍（第一／最後一個非 null 桶、null 桶數）供人工確認。
   - 寫入在單一交易內：插入序列（已存在時只允許「每個非 null 值不變、只把 null 補成值」的更新）→ 斷言資料庫每一筆 rank ≤ 1000 的非 final 快照，其所在小時桶的序列值等於該桶最後一筆觀測（聯集意義下）。任一斷言失敗即整筆回滾。
   若部署在結算前，結算會依 §3.2 自動寫入序列，不需此步。
4. 執行 `scripts/train.js` 產生第一份 `params`（此前不產出預測，§4.4）。
5. sekai-archive 合入 `answer.mjs`。
6. 0003（主榜）：至少兩期主榜以階段一結算後，依 §3.3 的 (1)–(3) 驗證；全部通過才套用（`test` 先行、整合測試涵蓋 A6）。
7. 追蹤：第 202 期（WL）第一輪錄 fixture 並驗證 §3.1 契約；該期以階段一結算後依 §3.3 驗證章節序列，通過才套 0004；並在 `test` 以真實資料重量 A1 的 WL 部分。

## 10. 風險

| 風險 | 緩解 |
|---|---|
| live 的 WL 形狀與文件不符 | 隔離（R2、A8）；202 期第一輪錄 fixture 驗證後修正 |
| 冷啟動準度差（1 期序列） | 退層區間＋`confidence: 'low'`；剖面未達條件不啟用；只要求回測報告 |
| 序列推導 bug 卡住結算或刪錯資料 | A5、A6；階段一保留完整原始快照；階段二以原始資料逐桶雙向驗證後才刪，主榜與 WL 分開閘門；既有延後警報 |
| 前 1000 名快照刪除後無法回復 | 序列保有每小時資訊（比 3 小時壓縮更細）；182 期另有本機原始備份 |
| 分數通膨使先驗偏低 | 半衰期 6 期；`prior` 的 σ 由回測量出，權重自動下降 |
| 1000 名以後剖面粗 | 群體行為平滑；誤差照實回測反映在區間 |
| 新 event_type 或異常天數 | `prior` 無可比樣本即不可用，退回其他成員 |

## 11. 給後續子專案的介面承諾

- 子專案 3、4 只讀 `sekai_border_forecasts`（與 `sekai_border_events`），三問只透過 `answer.mjs`；不新增任何 hisekai 呼叫（R1）。
- `forecasts` 欄位語意在本 spec 版本內不變；模型改進只改 `params`。
- 已結束活動的曲線：rank ≤ 1000 讀 `sekai_border_series`，rank > 1000 讀 `sekai_border_rankings`（§3.3；階段二之前 rank ≤ 1000 的壓縮點仍暫存在 rankings，消費端不得依賴）；兩者目前都不對 anon 開放 `series`，子專案 3 若要畫歷史曲線需另議權限。
- 待議（子專案 3）：畫面若要顯示「回測誤差約 X%」，摘要在 `model.params` 內、不對 anon 開放，屆時再決定開放方式；本子專案不預先開欄位（R3）。
