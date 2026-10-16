# 容量實測（spec §3.4）— 2026-10-17

在 `test` schema 以 `scripts/capacity.sql` 實測，每個語句各自一個 MCP `execute_sql` 呼叫，`VACUUM (FULL, ANALYZE)` 單獨一個呼叫（MCP 接受）。
資料：第 900 期、9 天 × 288 個 5 分鐘 slot × 30 名次 = 77,760 列快照。兩次量測，差別只在結算函式的壓縮規則。

## 第二次（spec v9.2 現行規則：結束前 24 小時每小時一點、更早每 3 小時一點）

| 階段 | total | heap | 索引 | 列數 |
|------|-------|------|------|------|
| live（結算前） | 9,856 kB | 5,200 kB | 4,624 kB | 77,760 |
| compacted（結算 + VACUUM FULL 後） | 392 kB | 184 kB | 208 kB | 2,670 |

結算函式回報 `inserted_finals 30`、`deleted_snapshots 75,120`；剩 (64 個 3 小時桶 + 24 個小時桶) × 30 + 30 最終 = 2,670，與推算一致。

判定（門檻：穩態 < 30 MB、年增 < 15 MB；一年約 36 期）：
- 年增 = 36 × 392 kB = 14,112 kB ≈ **13.8 MB** → 達標
- 穩態 = live 9,856 kB + 14,112 kB + 1 MB = 24,992 kB ≈ **24.4 MB** → 達標

## 第一次（spec v9.1 舊規則：全程每小時一點）— 保留為基準

| 階段 | total | heap | 索引 | 列數 |
|------|-------|------|------|------|
| live（結算前） | 9,792 kB | 5,184 kB | 4,584 kB | 77,760 |
| compacted | 896 kB | 440 kB | 424 kB | 6,510 |

`deleted_snapshots 71,280`；年增 ≈ 31.5 MB、穩態 ≈ 42 MB，兩者超標。索引明細：pkey 336 kB、event_chapter_time 72 kB、one_final 16 kB；
每列約 68 bytes heap 已近下限，砍 event_chapter_time 索引只省 72 kB/期（年增仍約 29 MB），因此改壓縮規則而非動索引（user 決定，2026-10-17）。

實測資料（event 900）兩次都已清除。
