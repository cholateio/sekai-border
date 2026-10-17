# 子專案 2：榜線預測與三問 — 設計 spec（v1）

> 日期 2026-10-17。上游依賴：子專案 1 資料層（`2026-10-16-data-layer-design.md` v9.2，已上線）。
> 下游消費者：子專案 3（手機一覽圖）、子專案 4（解說員）。本 spec 涵蓋兩個 repo：sekai-border（預測）與 sekai-archive（三問純函式）。

## 1. 目標與非目標

**目標**

- G1 每 5 分鐘為當期的每條線（主榜與進行中的 WL 章節 × 30 個名次）產出終線預測：P10／P50／P90，以及到結算為止每小時一點的路徑區間。
- G2 回答三問（守得住嗎／差多少／能睡多久），輸入是使用者自行輸入的分數＋目標名次，計算在使用者瀏覽器內完成。
- G3 模型隨資料累積自動變準：每結算一期自動重新訓練，不需改程式或 schema。
- G4 對 hisekai 零新增負擔，對 Supabase 容量年增 ≤ 3 MB（實測驗收，§8）。

**非目標**

- 不用 LLM（解說員屬子專案 4）；不做畫面（子專案 3）。
- 不做「自動抓玩家」：只限前百且需新表，延到子專案 3 若要顯示玩家名稱時再議（晚加不損失資料：該表只存最新一輪）。
- 不存使用者輸入的分數或任何個人化紀錄；不存玩家名稱。
- 不預測任意名次（如 1234 名）：只預測 `ALLOWED_RANKS` 的 30 個名次，中間名次不內插。
- 不使用 project-sekai-center.com 的程式、參數或資料（無授權）；只借其公開描述的方法思路。

## 2. 硬規則

- R1 **只有 sekai-border 爬蟲呼叫 hisekai**（每輪 `live/top100`＋`live/border` 兩個請求；活動更替與結算時另有子專案 1 既有的 `event/list`、`{id}/border|top100`）。網站與解說員只讀 Supabase。本子專案不新增任何上游請求。
- R2 預測失敗不得影響快照寫入與結算：推論與訓練都在各自前置步驟成功之後執行，失敗只記 log。
- R3 表要精簡：每個欄位都有上線後的讀者；能推導的不存；不開除錯或監控用欄位。
- R4 容量主張以實測為準，上限寫成驗收條件（§8 A1）。

## 3. 資料模型（Supabase `public`，模板 `{{schema}}`）

三張新表。寫入只由 service_role（爬蟲）；權限照子專案 1 慣例：revoke public/anon/authenticated → grant service_role；只有 `sekai_border_forecasts` 開 anon／authenticated 的 RLS select policy。

### 3.1 `sekai_border_series` — 前 1000 名的每小時序列

| 欄位 | 型別 | 說明 |
|---|---|---|
| `event_id` | int, FK → events | PK 之一 |
| `chapter` | smallint | 0＝主榜；WL 章節號。PK 之一 |
| `rank` | int, check ≤ 1000 且 ∈ ALLOWED_RANKS | PK 之一 |
| `start_at` | timestamptz | 第一個小時桶的起點＝`floor_hour(該章節或主榜 start_at)`（UTC） |
| `scores` | bigint[] | `scores[i]`＝`taken_at ∈ [start_at + i h, start_at + (i+1) h)` 內最後一筆非 final 快照的分數；該桶無快照為 null；長度＝到 `floor_hour(aggregate_at)` 為止的桶數 |

- 寫入：在 `sekai_border_finalize` 內、**壓縮刪除之前**、同一交易，由同一份快照推導；`on conflict do nothing`。寫入失敗即整個結算回滾（延後到下一輪；子專案 1 既有的「延後 > 24 h 記 ERROR」為警報）。
- 範圍：rank ≤ 1000 的 24 個名次（1–10、20–100、200、300、400、500、1000），主榜與每個章節各一列。1000 名以後不存（user 決定 2026-10-17），其剖面改用壓縮後的 `sekai_border_rankings`（3 小時桶）。
- 實測依據：第 182 期 rank 1000 的 139 點陣列 `pg_column_size`＝1,136 bytes；過去一年 36 期＋26 章節 → 推算約 1.9 MB／年（含列與索引額外開銷）。

### 3.2 `sekai_border_model` — 模型參數（固定 1 列）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | smallint PK, check (id = 1) | 固定 1 |
| `trained_at` | timestamptz | |
| `params` | jsonb | 剖面係數、各成員誤差 σ、合成誤差與覆蓋校正、歷史先驗表、回測摘要（§4.5）。結構由 `src/forecast/params.js` 驗證 |

- 只保留當前一份；新訓練結果不合格（§4.6）不覆寫。不保存歷史版本。

### 3.3 `sekai_border_forecasts` — 當期最新預測（每輪覆寫）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `event_id`, `chapter`, `rank` | PK | 主榜＋**進行中**的章節（`start_at ≤ now < aggregate_at`）× 30 名次 |
| `computed_at` | timestamptz | 所依據的快照時間（slot）。消費端用它判斷過期（§5.2） |
| `current_score` | bigint | 該線在 `computed_at` 的分數（三問的「現在差多少」與「已在名次外」判斷用） |
| `method` | text, check in ('model','measured','prior','linear') | 主導成員（權重最大者）；畫面標示用 |
| `final_p10`, `final_p50`, `final_p90` | bigint | 終線區間；check `current_score ≤ final_p10 ≤ final_p50 ≤ final_p90` |
| `path` | jsonb | `{"t0": <第一個未來整點 ISO>, "p10": [...], "p50": [...], "p90": [...]}`，每小時一點直到 `aggregate_at` 所在小時；整數 |

- 每輪以單一 RPC `sekai_border_put_forecasts(p_event_id, p_rows jsonb)` 寫入：同一交易內刪除該表所有 `event_id <> p_event_id` 的列與本期不在 `p_rows` 內的列，再 upsert。表內永遠只有當期。
- 不設 view：消費端直接讀此表（R3）。

### 3.4 子專案 1 物件的改動

- `sekai_border_finalize`：在壓縮刪除前插入 §3.1 的序列（唯一改動）。回傳 jsonb 增加 `series_rows`。
- 其餘表、view、觸發器不動。

## 4. 模型

### 4.1 名詞

- 一條**線**＝(event, chapter, rank)。**進度** τ＝(now − start)／(aggregate − start)，以該章節或主榜自己的時間計。
- 誤差一律在對數空間：e＝ln(預測／實際終線)。
- **名次群**（剖面與誤差分組用）：G1＝1–3、G2＝4–10、G3＝20–100、G4＝200–500、G5＝1000、G6＝1500–10000。
- **進度格**：τ 邊界 [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1]。

### 4.2 成員

| 成員 | 預測式 | 可用條件 |
|---|---|---|
| `linear` | s_now／τ | τ ≥ 0.02 |
| `measured` | s_now＋v×剩餘時數；v＝近 6 h 平均速度（不足 24 h 時）或近 24 h 平均速度 | 本線已有 ≥ 6 h 的快照 |
| `prior` | 同 `event_type`、同天數（`round((aggregate−start)/1 day)`）過去各期該名次終線的加權對數平均，權重 0.5^(距今期數／6)；章節用同天數章節 | 至少 2 期可比樣本 |
| `profile` | s_now＋r̂×Σ_{剩餘每小時 h} m(h)；m 為剖面乘數，r̂ 為以近 6 h 實際增量對剖面期望增量之比估出的當前基準速率 | 參數中該名次群的剖面已啟用（§4.6） |

- 剖面：ln(小時增量) ＝ a_event ＋ f_hod(台灣時段) ＋ f_hte(距結算時數格 [0,1,2,3,4,6,9,12,18,24,∞)) ＋ f_hfs(開跑時數格 [0,1,2,3,6,12,24,∞)) ＋ f_wk(週末)，依名次群以最小平方擬合。G1–G5 用 `series` 的每小時增量、f_hod 24 格；G6 用壓縮後快照的 3 小時增量、f_hod 8 格（每格 3 小時）。主榜與 WL 章節分開擬合（兩個家族）。
- 推論只讀三個時間點的快照（最新 slot、6 h 前、24 h 前）與 `params`，不讀整段序列；`prior` 的先驗表在訓練時算好放進 `params`。

### 4.3 合成與區間

- 權重：w_k ∝ 1／σ_k²(名次群, 進度格)，只對可用成員正規化；σ_k 取自 `params`（§4.5），下限 0.03。
- 點預測：ln P50＝Σ w_k ln p_k；且 P50 ≥ s_now。
- 區間：ln P10／P90＝ln P50 ∓ 1.2816 × σ_c × c；σ_c 為合成後的回測誤差（同分組），c 為覆蓋校正（回測中實際落在區間內比例偏離 80% 時調整，≥ 1；可回測的序列期數 < 3 時固定 1.5）。P10 下限為 s_now。
- `method`＝權重最大的成員（`profile` 記為 'model'）。
- 路徑：F(h)＝從現在到 h 的累積期望增量占總剩餘的比例（有剖面用剖面，否則按時間線性）；path_q(h)＝s_now＋(final_q − s_now)×F(h)。構造上隨時間不下降，終點等於終線。

### 4.4 退回

- 可用成員為空集合時退回 `linear`（τ < 0.02 時改用 `prior`；兩者都不可用則該線不產出預測列）。
- WL 章節：只要 12 期 WL 的章節終線就能用 `prior`；章節剖面等 WL 序列累積後才啟用。

### 4.5 訓練（`src/forecast/train.js`）

- 時機：同一輪 `/run` 中有活動結算成功後（結算交易 commit 之後）；另有 `scripts/train.js` 手動執行。
- 輸入：所有已結算期的 `series`、壓縮後快照（G6）、所有 `is_final` 終線、`events` 屬性。
- 產出 `params`：
  1. 剖面係數（僅限已啟用的名次群）。
  2. 各成員的 σ_k：`prior` 以 180 期終線做留一法；`linear`／`measured`／`profile` 以有序列的期數做留一法重播（在每個進度格的代表時點以當時可得資料預測，與實際終線比較）。
  3. 合成誤差 σ_c 與覆蓋校正 c。
  4. 歷史先驗表：每 (家族, event_type, 天數, rank) 的加權對數平均與樣本數。
  5. 回測摘要：每名次群 × 進度格的平均 |e| 與區間覆蓋率（給畫面顯示「回測誤差約 X%」）。

### 4.6 啟用與防退化

- `profile` 在某名次群啟用的條件：有序列的已結算期 ≥ 3，且該群留一法平均 |e| 低於 `linear`。不滿足就不放進 `params`（推論自動不用它）。
- 新 `params` 寫入條件：通過 `params.js` 結構驗證，且在同一評估集（本次可回測的全部線）上的合成平均 |e| ≤ 舊 `params` 的 1.1 倍。否則保留舊列並記 ERROR。首次訓練（無舊列）只需通過結構驗證。

## 5. 三問（sekai-archive `lib/border/answer.mjs`）

### 5.1 介面

`answer({ forecast, event, now, score })` → 回傳物件；`forecast` 是 `sekai_border_forecasts` 的一列（目標名次那條線），`event` 為 `{ start_at, aggregate_at }`（該章節或主榜），`score` 為使用者分數（非負整數）。純函式，無 I/O。

- 守得住嗎 `light`：`'safe'`（score ≥ P90）／`'risky'`（P50 ≤ score < P90）／`'losing'`（score < P50）。前提一律為「現在停手」。
- 差多少 `gap`：`{ now: current_score − score, safe: P90 − score, even: P50 − score }`（負值＝領先）。
- 能睡多久 `sleep`：`{ safeHours, evenHours }`＝沿 `path.p90`（`path.p50`）找第一個值 > score 的小時，回傳該點距 now 的小時數（無條件捨去到 0.5 小時）；到結算都不超過回 `'until_end'`；`current_score > score`（現在已在名次外）回 0。

### 5.2 狀態（優先序由上而下）

1. `now ≥ event.aggregate_at` → `{ state: 'closed' }`。
2. 無 `forecast` → `{ state: 'no_forecast' }`（空窗期或該線無預測）。
3. `now − forecast.computed_at > 15 分` → 照常計算但 `stale: true`（畫面灰化，顯示「預測暫停更新」）。
4. `confidence`：`method ∈ ('linear','prior')` 或 (P90−P10)／P50 > 0.3 → `'low'`；否則 `'normal'`。由函式推導，不存欄位。

### 5.3 輸入保存

分數與目標名次只存在瀏覽器 localStorage（子專案 3 的責任）；不送伺服器。

## 6. 程式結構

**sekai-border**

- `src/forecast/members.js`（四個成員）、`profile.js`（擬合與積分）、`combine.js`（權重、區間、路徑）、`params.js`（結構驗證）、`infer.js`（每輪推論：讀三個 slot＋params → rows）、`train.js`（§4.5）、`series.js`（由快照推導每小時陣列；與 SQL 推導同義，供 182 期補資料與測試對照）。
- `src/run.js`：快照寫入與結算之後呼叫 `infer`；有結算成功時呼叫 `train`。各自 try/catch，錯誤記 log，不改變 `/run` 的狀態碼與既有回應欄位；回應新增 `forecast: { rows } | { error }` 與 `trained: bool`。
- `src/db.js`：`loadSlots(eventId, chapter, takenAts)`、`loadModel()`、`putForecasts(eventId, rows)`、`saveModel(params)`、訓練用讀取。
- `scripts/train.js`、`scripts/series-from-backup.js`（讀本機 gz CSV 備份 → 以 `series.js` 推導 → 寫入；只處理指定期且 `series` 尚無該期列時）、`scripts/backtest.js`（印出回測摘要）。
- `supabase/migrations/0002_forecast.sql.tmpl`：三張表、grants、RLS、`sekai_border_put_forecasts`、更新後的 `sekai_border_finalize`。

**sekai-archive**

- `lib/border/answer.mjs`＋`scripts/test/answer.test.mjs`（`npm test` 已涵蓋 `scripts/test/*.test.mjs`）。

## 7. 錯誤處理

| 情況 | 行為 |
|---|---|
| 推論拋錯或逾時（> 20 s） | 記 ERROR `forecast failed`，`forecasts` 不動（消費端靠 `computed_at` 判過期）；`/run` 照常 |
| `params` 不存在或結構驗證失敗 | 推論改用不需參數的成員（`linear`／`measured`），`prior` 與 `profile` 停用；記 WARN |
| 序列寫入失敗 | 結算整筆回滾，下一輪重試（R2 的例外：序列是結算的一部分，寧可延後也不能壓縮掉未存的資料） |
| 訓練失敗或新參數不合格 | 記 ERROR，保留舊 `params` |
| 活動更替 | 新期第一輪推論的 RPC 自動刪除上一期的列 |
| 預測列違反不變量（§8 A4） | 該列不寫、記 ERROR；其他列照寫 |

## 8. 驗收條件（全部實測）

- A1 容量：上線後第一期結算完成時，以 `pg_total_relation_size` 量三張新表，換算年增（序列表依當年期數線性外推；另兩張表大小須與期數無關）。**年增 > 3 MB 不通過**，需先修正。
- A2 hisekai 負擔：上線後 24 h 內 Cloud Run log 的上游請求數 ＝ 每輪 2（加既有的更替／結算請求），與上線前相同。
- A3 速度：上線後 24 h 的 `/run` 平均延遲比上線前（2.25 s）增加 < 1.5 s。
- A4 不變量：每一列 `current_score ≤ final_p10 ≤ final_p50 ≤ final_p90`、`path` 各分位非遞減且末點等於對應終線、`path` 長度等於到結算的剩餘小時數；單元測試覆蓋，推論時也逐列檢查（§7）。
- A5 序列等價：整合測試中，同一批快照經 SQL（結算）與 `series.js` 推導出的陣列完全相同。
- A6 回滾安全：整合測試中，使序列插入失敗時結算回滾、快照未被刪除、`finalized_at` 仍為 null。
- A7 權限：anon 可 select `forecasts`；對 `series`／`model` 的 select 與三張表的任何寫入皆 42501。
- A8 防退化：單元測試中，`profile` 在序列期數 < 3 或贏不過 `linear` 時不被啟用；新參數誤差 > 舊參數 1.1 倍時不覆寫。
- A9 三問：`answer.test.mjs` 涵蓋三個燈號邊界（= P50、= P90）、`sleep` 的 until_end／0／一般情況、§5.2 的四種狀態。
- A10 回測報告：`scripts/backtest.js` 能跑出每名次群 × 進度格的平均 |e| 與覆蓋率。冷啟動期（序列期數 < 3）**不設準度門檻**，只要求報告產出。

## 9. 上線順序

1. 0002 先套 `test` schema → 整合測試全綠 → 套 `public`（MCP `apply_migration`，user 在旁按同意）。
2. 部署新爬蟲 revision（gcloud 由 user 執行）；保留現行 revision 為回滾點。回滾只需切回舊 revision：新表留著無害，`sekai_border_finalize` 的新版在舊爬蟲下仍正確運作（舊爬蟲呼叫同一函式）。
3. 若第 182 期在部署前結算：以 `scripts/series-from-backup.js` 從本機備份（`.superpowers/backup/event-182-raw-*.csv.gz`，以最晚的一份為準）補 182 期序列。若部署在結算前，結算會自動寫入，不需補。
4. 執行 `scripts/train.js` 產生第一份 `params`。
5. sekai-archive 合入 `answer.mjs`（不含畫面）。
6. 依 §8 逐條驗收；A1 在下一期結算時完成。

## 10. 風險

| 風險 | 緩解 |
|---|---|
| 冷啟動期準度差（只有 1 期序列） | 區間依實測誤差放寬並標 `confidence: 'low'`；`profile` 未達條件不啟用；A10 只要求報告 |
| WL 章節沒有序列 | 先用 `prior`＋`measured`；首個 WL 期結束後章節剖面才可能啟用 |
| 序列推導 bug 卡住結算 | A5、A6 測試；既有延後警報；資料不遺失 |
| 分數通膨使先驗偏低 | 半衰期 6 期加權；`prior` 誤差由留一法量測，權重自動下降 |
| 1000 名以後剖面粗（3 小時） | 該群群體行為平滑；誤差照實回測，區間反映其準度 |
| 活動型態改變（新 event_type、異常天數） | `prior` 無可比樣本即不可用，退回其他成員 |

## 11. 給後續子專案的介面承諾

- 子專案 3、4 只讀 `sekai_border_forecasts`（加子專案 1 的 `sekai_border_events`），並只透過 `answer.mjs` 計算三問；不得直接呼叫 hisekai（R1）。
- `forecasts` 欄位的語意與單位（分數為整數、時間 UTC ISO、`path` 每小時一點）在本 spec 版本內不變；模型改進只改 `params`，不改此表。
- 待議（子專案 3）：畫面若要顯示「回測誤差約 X%」，回測摘要在 `model.params` 內、不對 anon 開放；屆時再決定開放方式。本子專案不預先開欄位（R3）。
