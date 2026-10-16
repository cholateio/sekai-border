# 容量實測（spec §3.4）— 2026-10-17

在 `test` schema 以 `scripts/capacity.sql` 實測，每個語句各自一個 MCP `execute_sql` 呼叫，`VACUUM (FULL, ANALYZE)` 單獨一個呼叫（MCP 接受）。
資料：第 900 期、9 天 × 288 個 5 分鐘 slot × 30 名次 = 77,760 列快照；結算後壓縮成每小時一點（216 小時 × 30）+ 30 列最終榜 = 6,510 列。

| 階段 | total | heap | 索引 | 列數 |
|------|-------|------|------|------|
| live（結算前） | 9,792 kB | 5,184 kB | 4,584 kB | 77,760 |
| compacted（結算 + VACUUM FULL 後） | 896 kB | 440 kB | 424 kB | 6,510 |

結算函式回報 `inserted_finals 30`、`deleted_snapshots 71,280`（77,760 − 71,280 + 30 = 6,510，與預期一致）。

壓縮後索引明細：`sekai_border_rankings_pkey` 336 kB、`sekai_border_rankings_event_chapter_time` 72 kB、`sekai_border_rankings_one_final` 16 kB。
每列約 68 bytes heap（24 bytes tuple header + 4 bytes line pointer + 欄位對齊後 ~40 bytes），已接近下限；主鍵索引（五欄複合）約佔壓縮後總量 37%。

## 判定（spec 門檻：穩態 < 30 MB、年增 < 15 MB；一年約 36 期）

- 穩態 = live 9,792 kB + 36 × 896 kB + 1 MB = 43,072 kB ≈ **42 MB** → 超標
- 年增 = 36 × 896 kB = 32,256 kB ≈ **31.5 MB** → 超標

計畫規定的第一個手段是 `drop index sekai_border_rankings_event_chapter_time` 後重量；這裡改以逐索引大小等價估算（不動 schema）：
該索引 72 kB/期，砍掉後 compacted ≈ 824 kB → 年增 ≈ 29 MB，穩態 ≈ 41 MB，**仍超標**。
光是 heap 440 kB × 36 ≈ 15.5 MB/年就已到年增門檻，因此任何只動索引的手段都不夠；需要 user 決定（降低壓縮密度、或放寬門檻）。依計畫，此結果不進 Task 8。

對照（同日量測）：`test` schema 實測資料已清除（event 900 的列全刪）。

## 若改壓縮密度（以本次實測的每列成本線性推算，未實測）

| 結束活動保留密度 | 每期列數 | 每期約 | 年增約 | 穩態約 |
|------|------|------|------|------|
| 每 1 小時（現行） | 6,510 | 896 kB | 31.5 MB | 42 MB |
| 每 2 小時 | 3,270 | ~450 kB | ~16 MB | ~27 MB |
| 每 3 小時 | 2,190 | ~300 kB | ~11 MB | ~21 MB |
