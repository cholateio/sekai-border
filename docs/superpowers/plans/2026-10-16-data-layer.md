# 資料層重構 Implementation Plan（子專案 1 / 4）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 sekai-border 重構成保留歷史、可測試、權限最小化的爬蟲，Supabase 收斂成兩張表兩個 view，並回填所有已結束活動的最終榜線。

**Architecture:** 純函式層（驗證、狀態機）與副作用層（上游抓取、DB）分離；所有寫入由 Cloud Run 上的 sekai-border 獨占；結算在單一 Postgres 交易內完成；舊爬蟲、舊表、舊 view 在觀察期內保留為回滾點。

**Tech Stack:** Node 22（ESM，`node --test`）、@supabase/supabase-js 2.118、@google-cloud/functions-framework（保留 `npm start` 相容）、Supabase Postgres 17、Cloud Run + Cloud Scheduler（OIDC）。

**Spec:** `docs/superpowers/specs/2026-10-16-data-layer-design.md`（v8）。本計畫逐節引用；衝突時以 spec 為準。

## Global Constraints

- Node `>=22`；package.json 設 `"type": "module"`，全部檔案為 ESM。
- 程式碼註解一律英文；commit message 中文。
- 快照 `taken_at = floor(now, 5 min)`，寫入 `ON CONFLICT DO NOTHING`（spec §3.2）。
- 允許名次集合（主榜與章節相同，共 30）：`1..10, 20,30,40,50,60,70,80,90,100, 200,300,400,500,1000,1500,2000,2500,3000,5000,10000`。最終榜線的兩個目標集：top 目標集 = 前 19 個（含 100），border 目標集 = 後 11 個（不含 100）（spec §4.3）。
- 結算門檻：`finalized_at IS NULL AND now >= ranking_announce_at + 15 min` 且上游 `isEventAggregate = true`（spec §4.2 第三步、§4.3）。
- 任何 log 不得含上游回應中的 `name`、`userId`、`userCard`、`userProfile`（spec §5.3）。
- 環境變數：`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`（啟動時驗 JWT `role === 'service_role'`）、`BOT_CONTACT`、`WL_INGEST`（預設 off）、`SUPABASE_SCHEMA`（預設 public；整合測試設 `test`）（spec §5.2、§8.2）。
- 上游失敗不重試；429/5xx 不加壓（spec §4.1、S8）。
- 整合測試只認 `SUPABASE_SCHEMA=test`，缺少時拒跑（spec §8.2）。
- GCP 指令（Cloud Run、Scheduler、IAM）由 user 執行；計畫只提供可貼的區塊與預期輸出。
- 每個 task 結束前：`npm test` 綠、`npm run lint`（若有）綠、commit。

## Review Focus

1. **上游在同一輪回了兩個不同活動的 id**（活動更替瞬間）：預期整輪不寫、500、`phase: validate`。測試在 Task 1。
2. **Scheduler 在同一個 5 分鐘 slot 內觸發兩次**：預期第二次 `inserted: 0` 且無錯。測試在 Task 4（整合）。
3. **最終榜公布延遲超過一輪**：預期 `due` 分支每輪回 `finalize_deferred`、200，直到旗標為 true。測試在 Task 2 與 Task 4。
4. **回填中途被中斷在「events 已寫、finals 未寫」**：重跑後該期補齊且不重複。測試在 Task 6。
5. **遷移時 `cutover_slot` 這個 slot 在舊表也有列**：舊列必須被排除、新表 30 列保留。測試在 Task 6。

---

### Task 0: 專案骨架、fixture 錄製、測試基礎（無業務邏輯）

**Files:**
- Modify: `package.json`（type module、scripts、engines、devDependency 無）
- Create: `src/.gitkeep`（之後 task 填）、`test/fixtures/README.md`
- Create: `scripts/record-fixtures.js`（錄上游回應並去除玩家欄位）
- Create: `test/fixtures/live-top100.json`、`test/fixtures/live-border.json`、`test/fixtures/event-list.json`、`test/fixtures/final-border-181.json`、`test/fixtures/final-top100-181.json`、`test/fixtures/final-border-179.json`（WL）、`test/fixtures/final-top100-179.json`（WL）、`test/fixtures/master-events.json`（只取 id ≤ 202 的必要欄位）、`test/fixtures/master-eventCards.json`、`test/fixtures/master-cards.json`（只取 `id`、`characterId`）
- Modify: `.gitignore`（加 `.env`、`.superpowers/`）

**Interfaces:**
- Produces: `test/fixtures/*.json`，所有後續 task 的單元測試只讀這些檔案；`npm test` = `node --test test/*.test.js`；`npm run test:integration` = `node --test test/integration/*.test.js`。

- [ ] **Step 1: package.json**

```bash
cd /home/cholate/sekai-border && node - <<'JS'
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.type = 'module';
p.main = 'index.js';
p.engines = { node: '>=22' };
p.scripts = {
  start: 'node index.js',
  once: 'node index.js --once',
  test: 'node --test test/*.test.js',
  'test:integration': 'node --test test/integration/*.test.js',
  'record-fixtures': 'node scripts/record-fixtures.js',
};
fs.writeFileSync('package.json', JSON.stringify(p, null, 4) + '\n');
JS
grep -n '"type"\|"test"\|"engines"' package.json
printf '.superpowers/\n' >> .gitignore
```

Expected: 印出 `"type": "module"`、`"test": "node --test test/*.test.js"`、`"engines"` 三行。

- [ ] **Step 2: 寫 fixture 錄製腳本（去個資）**

```js
// scripts/record-fixtures.js
// Records upstream responses used by unit tests. Player-identifying fields are stripped so fixtures
// can live in git (spec §1 non-goals, §5.3).
import { writeFile, mkdir } from 'node:fs/promises';

const OUT = new URL('../test/fixtures/', import.meta.url);
const UA = process.env.BOT_CONTACT || 'sekai-border-fixture-recorder';
const PII = new Set(['name', 'userId', 'userCard', 'userCheerfulCarnival', 'userHonorMissions', 'userPlayerFrames', 'userProfile', 'userProfileHonors', 'last_player_info', 'last_played_at']);

function strip(value) {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).filter(([k]) => !PII.has(k)).map(([k, v]) => [k, strip(v)]));
    }
    return value;
}

async function get(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jobs = [
    ['live-top100.json', 'https://api.hisekai.org/tw/event/live/top100'],
    ['live-border.json', 'https://api.hisekai.org/tw/event/live/border'],
    ['event-list.json', 'https://api.hisekai.org/tw/event/list'],
    ['final-border-181.json', 'https://api.hisekai.org/tw/event/181/border'],
    ['final-top100-181.json', 'https://api.hisekai.org/tw/event/181/top100'],
    ['final-border-179.json', 'https://api.hisekai.org/tw/event/179/border'],
    ['final-top100-179.json', 'https://api.hisekai.org/tw/event/179/top100'],
];

await mkdir(OUT, { recursive: true });
for (const [file, url] of jobs) {
    const data = strip(await get(url));
    await writeFile(new URL(file, OUT), JSON.stringify(data, null, 1));
    console.log('recorded', file);
    await sleep(1000);
}

const MASTER = 'https://raw.githubusercontent.com/Sekai-World/sekai-master-db-tc-diff/main/';
const events = (await get(MASTER + 'events.json')).map(({ id, eventType, name, unit, startAt, aggregateAt }) => ({ id, eventType, name, unit, startAt, aggregateAt }));
await writeFile(new URL('master-events.json', OUT), JSON.stringify(events));
const eventCards = (await get(MASTER + 'eventCards.json')).map(({ eventId, cardId }) => ({ eventId, cardId }));
await writeFile(new URL('master-eventCards.json', OUT), JSON.stringify(eventCards));
const cards = (await get(MASTER + 'cards.json')).map(({ id, characterId }) => ({ id, characterId }));
await writeFile(new URL('master-cards.json', OUT), JSON.stringify(cards));
console.log('recorded master data');
```

- [ ] **Step 3: 執行並驗證 fixture 無個資**

```bash
cd /home/cholate/sekai-border && npm run record-fixtures && ls -la test/fixtures && grep -l '"name"' test/fixtures/final-*.json test/fixtures/live-*.json; echo "files still containing a name key (expect only event-level name): $(grep -c '"name"' test/fixtures/live-top100.json)"; grep -c "userId" test/fixtures/*.json
```

Expected: 10 個檔案；`userId` 在所有 fixture 中計數為 0；`live-top100.json` 的 `"name"` 只剩活動名稱一次（計數 1）。活動名稱是公開資訊，保留。

- [ ] **Step 4: 寫 fixture 說明並 commit**

```bash
cd /home/cholate/sekai-border && cat > test/fixtures/README.md <<'MD'
# Fixtures

Recorded 2026-10-16 with `npm run record-fixtures` from api.hisekai.org and Sekai-World TC master db.
Player-identifying fields are stripped at record time (see scripts/record-fixtures.js). Event 181 is a
finished marathon; event 179 is a finished World Link event with 6 chapters. Do not hand-edit; re-record.
MD
npm test 2>&1 | tail -3
git add package.json .gitignore scripts/record-fixtures.js test/fixtures
git commit -m "chore: ESM 專案骨架、測試指令、去個資的上游 fixture"
```

Expected: `npm test` 因為還沒有測試檔而印出 0 tests（exit 0 或 1 都可，此時尚無測試）；commit 成功。

---

### Task 1: `src/validate.js` — 允許名次、形狀與一致性驗證（spec §4.1、§4.3 第 1 點、§5.3）

**Files:**
- Create: `src/constants.js`、`src/validate.js`、`src/errors.js`
- Test: `test/validate.test.js`

**Interfaces:**
- Produces:
  - `constants.js`：`ALLOWED_RANKS: number[]`（30）、`TOP_TARGET: Set<number>`（19）、`BORDER_TARGET: Set<number>`（11）、`SLOT_MS = 300000`、`ANNOUNCE_GRACE_MS = 900000`。
  - `errors.js`：`class UpstreamError extends Error { phase: 'fetch'|'validate'|'event-list'; code: string; detail: object }`，`detail` 永不含個資。
  - `validate.js`：
    - `validateLive(top100, border, { wlIngest }) → { event: {id, name, start_at, aggregate_at, ranking_announce_at}, rows: Array<{chapter:0, rank, score}> }`，失敗丟 `UpstreamError('validate', code)`。
    - `validateFinal(id, border, top100, chapters) → { rows: Array<{chapter, rank, score}>, deferred: boolean }`；`deferred=true` 表示旗標為 false（尚未公布）。`chapters` 為 `events.chapters` 陣列。
    - `validateEventListEntry(list, id, live) → entry`（唯一性與時間一致性）。
    - `safeDetail(payload) → object`：回傳只含路徑、長度、SHA-256 的物件（給 log）。

- [ ] **Step 1: 寫失敗的測試**

```js
// test/validate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateLive, validateFinal, validateEventListEntry, safeDetail } from '../src/validate.js';
import { ALLOWED_RANKS, TOP_TARGET, BORDER_TARGET } from '../src/constants.js';
import { UpstreamError } from '../src/errors.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

test('constants: 30 allowed ranks, disjoint 19 + 11 final targets', () => {
    assert.equal(ALLOWED_RANKS.length, 30);
    assert.equal(TOP_TARGET.size, 19);
    assert.equal(BORDER_TARGET.size, 11);
    assert.ok(TOP_TARGET.has(100) && !BORDER_TARGET.has(100));
    assert.deepEqual([...TOP_TARGET].filter((r) => BORDER_TARGET.has(r)), []);
});

test('validateLive accepts recorded live responses and yields 30 rows', () => {
    const { event, rows } = validateLive(fx('live-top100'), fx('live-border'), { wlIngest: false });
    assert.equal(rows.length, 30);
    assert.deepEqual(rows.map((r) => r.rank).sort((a, b) => a - b), [...ALLOWED_RANKS].sort((a, b) => a - b));
    assert.ok(rows.every((r) => r.chapter === 0 && Number.isInteger(r.score) && r.score >= 0));
    assert.equal(typeof event.id, 'number');
    assert.ok(event.aggregate_at instanceof Date && event.ranking_announce_at >= event.aggregate_at);
});

test('validateLive rejects mismatched event ids between the two responses', () => {
    const b = clone(fx('live-border')); b.id = b.id + 1;
    assert.throws(() => validateLive(fx('live-top100'), b, { wlIngest: false }), (e) => e instanceof UpstreamError && e.phase === 'validate' && e.code === 'event_mismatch');
});

test('validateLive rejects mismatched aggregate_at', () => {
    const b = clone(fx('live-border')); b.aggregate_at = '2030-01-01T00:00:00Z';
    assert.throws(() => validateLive(fx('live-top100'), b, { wlIngest: false }), (e) => e.code === 'event_mismatch');
});

test('validateLive rejects a missing allowed rank, a duplicate rank, a negative score, a non-integer score', () => {
    const missing = clone(fx('live-border')); missing.player_border_rankings = missing.player_border_rankings.filter((r) => r.rank !== 500);
    assert.throws(() => validateLive(fx('live-top100'), missing, { wlIngest: false }), (e) => e.code === 'rank_set');
    const dup = clone(fx('live-top100')); dup.player_top_100_rankings.push({ ...dup.player_top_100_rankings[0] });
    assert.throws(() => validateLive(dup, fx('live-border'), { wlIngest: false }), (e) => e.code === 'rank_set');
    const neg = clone(fx('live-top100')); neg.player_top_100_rankings[0].score = -1;
    assert.throws(() => validateLive(neg, fx('live-border'), { wlIngest: false }), (e) => e.code === 'score');
    const frac = clone(fx('live-top100')); frac.player_top_100_rankings[0].score = 1.5;
    assert.throws(() => validateLive(frac, fx('live-border'), { wlIngest: false }), (e) => e.code === 'score');
});

test('validateLive rejects scores that increase with rank', () => {
    const t = clone(fx('live-top100')); t.player_top_100_rankings.find((r) => r.rank === 2).score = t.player_top_100_rankings.find((r) => r.rank === 1).score + 1;
    assert.throws(() => validateLive(t, fx('live-border'), { wlIngest: false }), (e) => e.code === 'score_order');
});

test('validateLive rejects a non-positive-integer event id', () => {
    const t = clone(fx('live-top100')); const b = clone(fx('live-border')); t.id = 'abc'; b.id = 'abc';
    assert.throws(() => validateLive(t, b, { wlIngest: false }), (e) => e.code === 'event_id');
});

test('validateLive ignores world_link_* arrays when wlIngest is off', () => {
    const t = clone(fx('live-top100')); t.world_link_top_100_rankings = [{ garbage: true }];
    const { rows } = validateLive(t, fx('live-border'), { wlIngest: false });
    assert.equal(rows.length, 30);
});

test('validateFinal extracts exactly 30 main rows from border(11) + top100(19)', () => {
    const { rows, deferred } = validateFinal(181, fx('final-border-181'), fx('final-top100-181'), []);
    assert.equal(deferred, false);
    assert.equal(rows.filter((r) => r.chapter === 0).length, 30);
    assert.equal(rows.filter((r) => r.chapter === 0 && r.rank === 100).length, 1);
});

test('validateFinal reports deferred when isEventAggregate is false', () => {
    const b = clone(fx('final-border-181')); b.isEventAggregate = false;
    assert.deepEqual(validateFinal(181, b, fx('final-top100-181'), []), { rows: [], deferred: true });
});

test('validateFinal rejects a border root eventId that differs from the requested id', () => {
    assert.throws(() => validateFinal(180, fx('final-border-181'), fx('final-top100-181'), []), (e) => e.code === 'event_mismatch');
});

test('validateFinal WL: 6 chapters bijective with declared characters -> 6 x 30 rows', () => {
    const border = fx('final-border-179'); const top = fx('final-top100-179');
    const chapters = border.userWorldBloomChapterRankingBorders.map((c, i) => ({ chapter: i + 1, chapter_id: 17900 + i + 1, character_id: c.gameCharacterId, start_at: '2026-09-06T12:00:00Z', aggregate_at: '2026-09-08T11:59:59Z', ranking_announce_at: '2026-09-08T12:09:59Z' }));
    const { rows } = validateFinal(179, border, top, chapters);
    assert.equal(rows.filter((r) => r.chapter > 0).length, 6 * 30);
    for (let c = 1; c <= 6; c++) assert.equal(rows.filter((r) => r.chapter === c).length, 30);
});

test('validateFinal WL: character set mismatch, duplicate character, chapter flag false, child eventId mismatch all reject', () => {
    const border = fx('final-border-179'); const top = fx('final-top100-179');
    const chapters = border.userWorldBloomChapterRankingBorders.map((c, i) => ({ chapter: i + 1, chapter_id: 17900 + i + 1, character_id: c.gameCharacterId, start_at: '2026-09-06T12:00:00Z', aggregate_at: '2026-09-08T11:59:59Z', ranking_announce_at: '2026-09-08T12:09:59Z' }));
    const fewer = chapters.slice(0, 5);
    assert.throws(() => validateFinal(179, border, top, fewer), (e) => e.code === 'wl_chapters');
    const dup = clone(border); dup.userWorldBloomChapterRankingBorders[1].gameCharacterId = dup.userWorldBloomChapterRankingBorders[0].gameCharacterId;
    assert.throws(() => validateFinal(179, dup, top, chapters), (e) => e.code === 'wl_chapters');
    const flag = clone(top); flag.userWorldBloomChapterRankings[2].isWorldBloomChapterAggregate = false;
    assert.deepEqual(validateFinal(179, border, flag, chapters), { rows: [], deferred: true });
    const bad = clone(border); bad.userWorldBloomChapterRankingBorders[0].eventId = 1;
    assert.throws(() => validateFinal(179, bad, top, chapters), (e) => e.code === 'event_mismatch');
});

test('validateEventListEntry requires exactly one entry whose times equal the live event', () => {
    const list = fx('event-list'); const { event } = validateLive(fx('live-top100'), fx('live-border'), { wlIngest: false });
    const entry = validateEventListEntry(list, event.id, event);
    assert.equal(entry.id, event.id);
    assert.throws(() => validateEventListEntry(list.filter((e) => e.id !== event.id), event.id, event), (e) => e.phase === 'event-list' && e.code === 'not_unique');
    assert.throws(() => validateEventListEntry([...list, list.find((e) => e.id === event.id)], event.id, event), (e) => e.code === 'not_unique');
    const shifted = clone(event); shifted.aggregate_at = new Date(event.aggregate_at.getTime() + 1000);
    assert.throws(() => validateEventListEntry(list, event.id, shifted), (e) => e.code === 'time_mismatch');
});

test('safeDetail never contains player fields', () => {
    const t = clone(fx('live-top100')); t.player_top_100_rankings[0].name = 'SECRET_NAME'; t.player_top_100_rankings[0].userId = 'SECRET_ID';
    const d = JSON.stringify(safeDetail(t));
    assert.ok(!d.includes('SECRET_NAME') && !d.includes('SECRET_ID'));
    assert.match(d, /sha256/);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /home/cholate/sekai-border && npm test`
Expected: FAIL，`Cannot find module` 指向 `src/validate.js`。

- [ ] **Step 3: 實作 constants / errors / validate**

```js
// src/constants.js
export const ALLOWED_RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 1000, 1500, 2000, 2500, 3000, 5000, 10000];
export const TOP_TARGET = new Set(ALLOWED_RANKS.slice(0, 19)); // 1..10, 20..100 (owns rank 100)
export const BORDER_TARGET = new Set(ALLOWED_RANKS.slice(19)); // 200..10000
export const SLOT_MS = 5 * 60 * 1000;
export const ANNOUNCE_GRACE_MS = 15 * 60 * 1000;
export const MAX_CHAPTERS = 6;
```

```js
// src/errors.js
// `detail` must never carry upstream player fields; build it with safeDetail() from validate.js.
export class UpstreamError extends Error {
    constructor(phase, code, detail = {}) {
        super(`${phase}:${code}`);
        this.phase = phase;
        this.code = code;
        this.detail = detail;
    }
}
```

```js
// src/validate.js
import { createHash } from 'node:crypto';
import { ALLOWED_RANKS, TOP_TARGET, BORDER_TARGET } from './constants.js';
import { UpstreamError } from './errors.js';

const ALLOWED = new Set(ALLOWED_RANKS);

export function safeDetail(payload) {
    const out = { sha256: createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex') };
    if (payload && typeof payload === 'object') {
        for (const [k, v] of Object.entries(payload)) out[k] = Array.isArray(v) ? `array[${v.length}]` : typeof v;
    }
    return out;
}

function fail(phase, code, payload) { return new UpstreamError(phase, code, safeDetail(payload)); }

function toDate(v, code, payload) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw fail('validate', code, payload);
    return d;
}

function eventHeader(p) {
    if (!Number.isInteger(p?.id) || p.id <= 0) throw fail('validate', 'event_id', p);
    const start_at = toDate(p.start_at, 'event_time', p);
    const aggregate_at = toDate(p.aggregate_at, 'event_time', p);
    const ranking_announce_at = toDate(p.ranking_announce_at, 'event_time', p);
    if (!(start_at < aggregate_at) || !(aggregate_at <= ranking_announce_at)) throw fail('validate', 'event_time', p);
    return { id: p.id, name: String(p.name ?? ''), start_at, aggregate_at, ranking_announce_at };
}

// Checks rank/score integrity for one chapter's rows; `expected` is the full allowed set.
function checkRows(rows, expected, payload) {
    const seen = new Set();
    for (const r of rows) {
        if (!Number.isInteger(r.rank) || !expected.has(r.rank) || seen.has(r.rank)) throw fail('validate', 'rank_set', payload);
        if (!Number.isInteger(r.score) || r.score < 0) throw fail('validate', 'score', payload);
        seen.add(r.rank);
    }
    if (seen.size !== expected.size) throw fail('validate', 'rank_set', payload);
    const sorted = [...rows].sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].score > sorted[i - 1].score) throw fail('validate', 'score_order', payload);
    return sorted.map(({ rank, score }) => ({ rank, score }));
}

function pick(list, target, payload) {
    if (!Array.isArray(list)) throw fail('validate', 'shape', payload);
    const rows = list.filter((r) => target.has(r?.rank)).map((r) => ({ rank: r.rank, score: r.score }));
    return rows;
}

export function validateLive(top100, border, { wlIngest = false } = {}) {
    const a = eventHeader(top100);
    const b = eventHeader(border);
    if (a.id !== b.id || a.aggregate_at.getTime() !== b.aggregate_at.getTime() || a.ranking_announce_at.getTime() !== b.ranking_announce_at.getTime()) {
        throw fail('validate', 'event_mismatch', { top100: safeDetail(top100), border: safeDetail(border) });
    }
    const rows = checkRows([...pick(top100.player_top_100_rankings, TOP_TARGET, top100), ...pick(border.player_border_rankings, BORDER_TARGET, border)], ALLOWED, { top100: safeDetail(top100), border: safeDetail(border) });
    // WL live payload shape is unverified until the next WL event; ignored unless WL_INGEST=on (spec §5.4).
    void wlIngest;
    return { event: a, rows: rows.map((r) => ({ chapter: 0, ...r })) };
}

function chapterRows(entries, key, target, id, chapters, payload) {
    if (!Array.isArray(entries)) throw fail('validate', 'shape', payload);
    const byChar = new Map();
    for (const c of entries) {
        if (c?.eventId !== id) throw fail('validate', 'event_mismatch', payload);
        if (byChar.has(c.gameCharacterId)) throw fail('validate', 'wl_chapters', payload);
        byChar.set(c.gameCharacterId, c);
    }
    if (byChar.size !== chapters.length) throw fail('validate', 'wl_chapters', payload);
    const out = [];
    let deferred = false;
    for (const ch of chapters) {
        const c = byChar.get(ch.character_id);
        if (!c) throw fail('validate', 'wl_chapters', payload);
        if (c.isWorldBloomChapterAggregate !== true) { deferred = true; continue; }
        out.push({ chapter: ch.chapter, rows: pick(c[key], target, payload) });
    }
    return { out, deferred };
}

export function validateFinal(id, border, top100, chapters = []) {
    if (border?.eventId !== id) throw fail('validate', 'event_mismatch', border);
    if (border.isEventAggregate !== true || top100?.isEventAggregate !== true) return { rows: [], deferred: true };
    const payload = { border: safeDetail(border), top100: safeDetail(top100) };
    const main = checkRows([...pick(top100.rankings, TOP_TARGET, top100), ...pick(border.borderRankings, BORDER_TARGET, border)], ALLOWED, payload);
    const rows = main.map((r) => ({ chapter: 0, ...r }));
    if (chapters.length > 0) {
        const b = chapterRows(border.userWorldBloomChapterRankingBorders, 'borderRankings', BORDER_TARGET, id, chapters, payload);
        const t = chapterRows(top100.userWorldBloomChapterRankings, 'rankings', TOP_TARGET, id, chapters, payload);
        if (b.deferred || t.deferred) return { rows: [], deferred: true };
        for (const ch of chapters) {
            const br = b.out.find((x) => x.chapter === ch.chapter).rows;
            const tr = t.out.find((x) => x.chapter === ch.chapter).rows;
            rows.push(...checkRows([...tr, ...br], ALLOWED, payload).map((r) => ({ chapter: ch.chapter, ...r })));
        }
    }
    return { rows, deferred: false };
}

export function validateEventListEntry(list, id, live) {
    if (!Array.isArray(list)) throw new UpstreamError('event-list', 'shape', safeDetail(list));
    const matches = list.filter((e) => e?.id === id);
    if (matches.length !== 1) throw new UpstreamError('event-list', 'not_unique', { id, matches: matches.length });
    const e = matches[0];
    const same = (x, y) => new Date(x).getTime() === y.getTime();
    if (!same(e.start_at, live.start_at) || !same(e.aggregate_at, live.aggregate_at) || !same(e.ranking_announce_at, live.ranking_announce_at)) {
        throw new UpstreamError('event-list', 'time_mismatch', { id });
    }
    return e;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd /home/cholate/sekai-border && npm test 2>&1 | grep -E "^# (pass|fail)|ℹ (pass|fail)"`
Expected: `pass 15`、`fail 0`。

- [ ] **Step 5: Commit**

```bash
cd /home/cholate/sekai-border && git add src/constants.js src/errors.js src/validate.js test/validate.test.js && git commit -m "feat: 上游回應驗證（允許名次集合、兩回應一致性、最終榜與 WL 章節雙射、去個資 detail）"
```

---

### Task 2: `src/state.js` — 純函式狀態機（spec §4.2）

**Files:**
- Create: `src/state.js`
- Test: `test/state.test.js`

**Interfaces:**
- Consumes: `validateLive` 的 `event`。
- Produces:
  - `slotOf(date) → Date`（向下對齊 5 分鐘）。
  - `decide({ live, known, startedLatest, now }) → { ensure: 'none'|'insert'|'regress'|'pre-start', branch: 'current'|'frozen'|'due'|'stale-live'|'pre-start'|null }`。`live` = 驗證後的 event；`known` = DB 中 id = live.id 的列或 null；`startedLatest` = 已開始的最大 id 列或 null。`listEntry` 的 `start_at > now` 由呼叫端用 `pre-start` 旗標傳入（`decide` 接受 `preStart: boolean`）。
  - `isEligibleForFinalize(eventRow, now) → boolean`（`finalized_at == null && now >= ranking_announce_at + 15 min`）。
  - `classify(eventRow, now) → 'current'|'frozen'|'due'|'stale-live'`。

- [ ] **Step 1: 寫失敗的測試**

```js
// test/state.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { slotOf, decide, classify, isEligibleForFinalize } from '../src/state.js';

const T = (s) => new Date(s);
const ev = (over = {}) => ({ id: 182, start_at: T('2026-10-11T07:00:00Z'), aggregate_at: T('2026-10-19T12:59:59Z'), ranking_announce_at: T('2026-10-19T13:09:59Z'), finalized_at: null, ...over });

test('slotOf floors to 5 minutes', () => {
    assert.equal(slotOf(T('2026-10-16T12:04:59.999Z')).toISOString(), '2026-10-16T12:00:00.000Z');
    assert.equal(slotOf(T('2026-10-16T12:05:00.000Z')).toISOString(), '2026-10-16T12:05:00.000Z');
});

test('classify: current / frozen / due / stale-live', () => {
    assert.equal(classify(ev(), T('2026-10-15T00:00:00Z')), 'current');
    assert.equal(classify(ev(), T('2026-10-19T13:00:00Z')), 'frozen');
    assert.equal(classify(ev(), T('2026-10-19T13:24:58Z')), 'frozen');
    assert.equal(classify(ev(), T('2026-10-19T13:24:59Z')), 'due');
    assert.equal(classify(ev({ finalized_at: T('2026-10-19T14:00:00Z') }), T('2026-10-20T00:00:00Z')), 'stale-live');
});

test('isEligibleForFinalize gates on finalized_at and announce + 15 min', () => {
    assert.equal(isEligibleForFinalize(ev(), T('2026-10-19T13:24:58Z')), false);
    assert.equal(isEligibleForFinalize(ev(), T('2026-10-19T13:24:59Z')), true);
    assert.equal(isEligibleForFinalize(ev({ finalized_at: T('2026-10-19T14:00:00Z') }), T('2026-10-20T00:00:00Z')), false);
});

test('decide: known event -> ensure none, branch by time', () => {
    const d = decide({ live: ev(), known: ev(), startedLatest: ev(), now: T('2026-10-15T00:00:00Z'), preStart: false });
    assert.deepEqual(d, { ensure: 'none', branch: 'current' });
});

test('decide: bootstrap (empty db) inserts and classifies', () => {
    const d = decide({ live: ev(), known: null, startedLatest: null, now: T('2026-10-15T00:00:00Z'), preStart: false });
    assert.deepEqual(d, { ensure: 'insert', branch: 'current' });
});

test('decide: new event greater than started latest inserts; classified frozen/due by its own times', () => {
    const prev = ev({ id: 181, finalized_at: null });
    const live = ev({ id: 182 });
    assert.deepEqual(decide({ live, known: null, startedLatest: prev, now: T('2026-10-19T13:00:00Z'), preStart: false }), { ensure: 'insert', branch: 'frozen' });
    assert.deepEqual(decide({ live, known: null, startedLatest: prev, now: T('2026-10-19T13:30:00Z'), preStart: false }), { ensure: 'insert', branch: 'due' });
});

test('decide: pre-start inserts nothing', () => {
    const live = ev({ id: 183, start_at: T('2026-10-21T07:00:00Z') });
    assert.deepEqual(decide({ live, known: null, startedLatest: ev(), now: T('2026-10-20T00:00:00Z'), preStart: true }), { ensure: 'pre-start', branch: 'pre-start' });
});

test('decide: regress terminates', () => {
    const live = ev({ id: 180 });
    assert.deepEqual(decide({ live, known: null, startedLatest: ev({ id: 182 }), now: T('2026-10-15T00:00:00Z'), preStart: false }), { ensure: 'regress', branch: null });
});

test('decide: a future row planted in the db does not change started-latest semantics (caller filters start_at <= now)', () => {
    // startedLatest is computed by the caller with start_at <= now; a known live event must still be "known".
    const d = decide({ live: ev(), known: ev(), startedLatest: ev(), now: T('2026-10-15T00:00:00Z'), preStart: false });
    assert.equal(d.ensure, 'none');
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /home/cholate/sekai-border && node --test test/state.test.js`
Expected: FAIL，`Cannot find module` 指向 `src/state.js`。

- [ ] **Step 3: 實作**

```js
// src/state.js
// Pure decisions only; the caller loads DB rows and performs effects (spec §4.2).
import { SLOT_MS, ANNOUNCE_GRACE_MS } from './constants.js';

export function slotOf(date) {
    return new Date(Math.floor(date.getTime() / SLOT_MS) * SLOT_MS);
}

export function isEligibleForFinalize(row, now) {
    return row.finalized_at == null && now.getTime() >= row.ranking_announce_at.getTime() + ANNOUNCE_GRACE_MS;
}

export function classify(row, now) {
    if (row.finalized_at != null) return 'stale-live';
    const t = now.getTime();
    if (t < row.aggregate_at.getTime()) return 'current';
    if (t < row.ranking_announce_at.getTime() + ANNOUNCE_GRACE_MS) return 'frozen';
    return 'due';
}

export function decide({ live, known, startedLatest, now, preStart }) {
    if (known) return { ensure: 'none', branch: classify(known, now) };
    if (startedLatest && live.id < startedLatest.id) return { ensure: 'regress', branch: null };
    if (preStart) return { ensure: 'pre-start', branch: 'pre-start' };
    return { ensure: 'insert', branch: classify({ ...live, finalized_at: null }, now) };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd /home/cholate/sekai-border && npm test 2>&1 | grep -E "ℹ (pass|fail)"`
Expected: `pass 24`、`fail 0`。

- [ ] **Step 5: Commit**

```bash
cd /home/cholate/sekai-border && git add src/state.js test/state.test.js && git commit -m "feat: 純函式狀態機（slot 對齊、時間分類、結算門檻、new-event/pre-start/regress）"
```

---

### Task 3: Supabase schema migration（表、約束、觸發器、結算函式、相容 view、權限）— 先套在 `test` schema（spec §3、§6 S4–S6）

**Files:**
- Create: `supabase/migrations/0001_sekai_border.sql.tmpl`（`{{schema}}` 佔位，渲染後套用）
- Create: `scripts/render-sql.js`（把 `.tmpl` 渲染成指定 schema 的 SQL，印到 stdout）
- Create: `test/integration/schema.test.js`（對 `test` schema 跑的 SQL 層測試）
- Create: `test/integration/helpers.js`（整合測試共用：建 client、拒跑保護、清表）

**前置（user 一次性）**：Supabase dashboard → Project Settings → API → **Exposed schemas** 加入 `test`。沒有這一步，supabase-js 無法讀寫 `test` schema（PostgREST 只暴露列出的 schema）。

**Interfaces:**
- Produces：`{{schema}}.sekai_border_events`、`{{schema}}.sekai_border_rankings`、`{{schema}}.sekai_border_finalize(p_event_id int, p_finals jsonb) returns jsonb`（回 `{finalized: bool, already: bool, inserted_finals: int, deleted_snapshots: int}`）、`{{schema}}.sekai_border_current_report`、`{{schema}}.sekai_border_daily_report`。
- 本 task 只套到 `test` schema（用 Supabase MCP 的 `apply_migration` 或 psql）；套到 `public` 在 Task 8 步驟 1。

- [ ] **Step 1: 寫渲染腳本**

```js
// scripts/render-sql.js
// usage: node scripts/render-sql.js <file.tmpl> <schema> [legacy_schema]
//   {{schema}} -> target schema; {{legacy_schema}} -> where the old event_rankings table lives (default: same as schema)
import { readFileSync } from 'node:fs';
const [file, schema, legacy = schema] = process.argv.slice(2);
if (!file || !/^[a-z_]+$/.test(schema ?? '') || !/^[a-z_]+$/.test(legacy)) { console.error('usage: render-sql.js <file.tmpl> <schema> [legacy_schema]'); process.exit(2); }
process.stdout.write(readFileSync(file, 'utf8').replaceAll('{{schema}}', schema).replaceAll('{{legacy_schema}}', legacy));
```

- [ ] **Step 2: 寫 migration template**

```sql
-- supabase/migrations/0001_sekai_border.sql.tmpl
-- Rendered per schema by scripts/render-sql.js. Idempotent (IF NOT EXISTS / OR REPLACE) so it can be re-applied.
create schema if not exists {{schema}};

create table if not exists {{schema}}.sekai_border_events (
    id                   integer primary key check (id > 0),
    name                 text not null,
    event_type           text check (event_type in ('marathon', 'cheerful_carnival', 'world_bloom')),
    unit                 text,
    start_at             timestamptz not null,
    aggregate_at         timestamptz not null,
    ranking_announce_at  timestamptz not null,
    bonus_characters     integer[] not null default '{}',
    chapters             jsonb not null default '[]'::jsonb,
    metadata_status      text not null default 'pending' check (metadata_status in ('pending', 'complete', 'missing', 'mismatch')),
    metadata_checked_at  timestamptz,
    metadata_miss_count  smallint not null default 0 check (metadata_miss_count >= 0),
    finalized_at         timestamptz,
    constraint sekai_border_events_times check (start_at < aggregate_at and aggregate_at <= ranking_announce_at)
);

-- chapters: array of {chapter 1..6, chapter_id, character_id, start_at, aggregate_at, ranking_announce_at};
-- chapter and character_id unique within the event; at most 6 (spec §3.2).
create or replace function {{schema}}.sekai_border_chapters_valid(ch jsonb) returns boolean
language plpgsql immutable as $$
declare e jsonb; n int := 0; chs int[] := '{}'; chars int[] := '{}'; s timestamptz; a timestamptz; r timestamptz;
begin
    if jsonb_typeof(ch) <> 'array' then return false; end if;
    for e in select * from jsonb_array_elements(ch) loop
        n := n + 1;
        if n > 6 then return false; end if;
        if jsonb_typeof(e->'chapter') <> 'number' or jsonb_typeof(e->'chapter_id') <> 'number' or jsonb_typeof(e->'character_id') <> 'number' then return false; end if;
        if (e->>'chapter')::int < 1 or (e->>'chapter')::int > 6 then return false; end if;
        begin
            s := (e->>'start_at')::timestamptz; a := (e->>'aggregate_at')::timestamptz; r := (e->>'ranking_announce_at')::timestamptz;
        exception when others then return false; end;
        if s is null or a is null or r is null or not (s < a and a <= r) then return false; end if;
        if (e->>'chapter')::int = any(chs) or (e->>'character_id')::int = any(chars) then return false; end if;
        chs := chs || (e->>'chapter')::int; chars := chars || (e->>'character_id')::int;
    end loop;
    return true;
end $$;

alter table {{schema}}.sekai_border_events drop constraint if exists sekai_border_events_chapters_valid;
alter table {{schema}}.sekai_border_events add constraint sekai_border_events_chapters_valid check ({{schema}}.sekai_border_chapters_valid(chapters));

create table if not exists {{schema}}.sekai_border_rankings (
    event_id  integer  not null references {{schema}}.sekai_border_events(id),
    chapter   smallint not null check (chapter between 0 and 6),
    rank      integer  not null check (rank = any (array[1,2,3,4,5,6,7,8,9,10,20,30,40,50,60,70,80,90,100,200,300,400,500,1000,1500,2000,2500,3000,5000,10000])),
    score     bigint   not null check (score >= 0),
    taken_at  timestamptz not null,
    is_final  boolean  not null default false,
    primary key (event_id, chapter, rank, taken_at, is_final)
);
create index if not exists sekai_border_rankings_event_chapter_time on {{schema}}.sekai_border_rankings (event_id, chapter, taken_at);

-- chapter must be 0 or declared in events.chapters
create or replace function {{schema}}.sekai_border_rankings_chapter_check() returns trigger
language plpgsql as $$
begin
    if new.chapter = 0 then return new; end if;
    if not exists (select 1 from {{schema}}.sekai_border_events e, jsonb_array_elements(e.chapters) c where e.id = new.event_id and (c->>'chapter')::int = new.chapter) then
        raise exception 'chapter % not declared for event %', new.chapter, new.event_id using errcode = '23514';
    end if;
    return new;
end $$;
drop trigger if exists sekai_border_rankings_chapter_check on {{schema}}.sekai_border_rankings;
create trigger sekai_border_rankings_chapter_check before insert or update on {{schema}}.sekai_border_rankings
    for each row execute function {{schema}}.sekai_border_rankings_chapter_check();

-- Finalization in one transaction (spec §4.3 step 2). p_finals: [{chapter, rank, score}].
create or replace function {{schema}}.sekai_border_finalize(p_event_id integer, p_finals jsonb) returns jsonb
language plpgsql security definer set search_path = {{schema}}, pg_temp as $$
declare ev record; n_ins int; n_del int; ch record; cnt int;
begin
    perform pg_advisory_xact_lock(p_event_id);
    select * into ev from sekai_border_events where id = p_event_id for update;
    if not found then raise exception 'unknown event %', p_event_id; end if;
    if ev.finalized_at is not null then return jsonb_build_object('finalized', true, 'already', true, 'inserted_finals', 0, 'deleted_snapshots', 0); end if;

    insert into sekai_border_rankings (event_id, chapter, rank, score, taken_at, is_final)
    select p_event_id, (f->>'chapter')::smallint, (f->>'rank')::int, (f->>'score')::bigint,
           case when (f->>'chapter')::int = 0 then ev.aggregate_at
                else (select (c->>'aggregate_at')::timestamptz from jsonb_array_elements(ev.chapters) c where (c->>'chapter')::int = (f->>'chapter')::int) end,
           true
    from jsonb_array_elements(p_finals) f
    on conflict (event_id, chapter, rank, taken_at, is_final) do update set score = excluded.score;
    get diagnostics n_ins = row_count;

    -- assert 30 distinct final ranks for chapter 0 and every declared chapter
    select count(distinct rank) into cnt from sekai_border_rankings where event_id = p_event_id and chapter = 0 and is_final;
    if cnt <> 30 then raise exception 'chapter 0 has % final ranks, expected 30', cnt; end if;
    for ch in select (c->>'chapter')::int as chapter from jsonb_array_elements(ev.chapters) c loop
        select count(distinct rank) into cnt from sekai_border_rankings where event_id = p_event_id and chapter = ch.chapter and is_final;
        if cnt <> 30 then raise exception 'chapter % has % final ranks, expected 30', ch.chapter, cnt; end if;
    end loop;

    -- hourly compaction: keep the last observation per UTC hour bucket, non-final rows only (spec §3.2)
    delete from sekai_border_rankings r using (
        select ctid from (
            select ctid, row_number() over (partition by event_id, chapter, rank, date_trunc('hour', taken_at at time zone 'UTC') order by taken_at desc) as rn
            from sekai_border_rankings where event_id = p_event_id and is_final = false
        ) x where rn > 1
    ) d where r.ctid = d.ctid;
    get diagnostics n_del = row_count;

    update sekai_border_events set finalized_at = now() where id = p_event_id;
    return jsonb_build_object('finalized', true, 'already', false, 'inserted_finals', n_ins, 'deleted_snapshots', n_del);
end $$;
revoke all on function {{schema}}.sekai_border_finalize(integer, jsonb) from public;
grant execute on function {{schema}}.sekai_border_finalize(integer, jsonb) to service_role;

-- Compatibility views: legacy SQL verbatim, fed by a CTE named event_rankings that selects the single started,
-- unfinalized event's non-final main-board rows and aliases columns to the legacy contract (spec §3.3).
create or replace view {{schema}}.sekai_border_current_report with (security_invoker = on) as
with event_rankings as (
    select event_id::text as event_id, rank, score, taken_at as created_at
    from {{schema}}.sekai_border_rankings
    where chapter = 0 and is_final = false
      and event_id = (select max(id) from {{schema}}.sekai_border_events where finalized_at is null and start_at <= now())
), ranking_calculations as (
    select event_id, rank, created_at, score,
        first_value(created_at) over (partition by event_id order by created_at) as start_time,
        lag(score, 12)  over (partition by event_id, rank order by created_at) as score_1h_ago,
        lag(score, 36)  over (partition by event_id, rank order by created_at) as score_3h_ago,
        lag(score, 288) over (partition by event_id, rank order by created_at) as score_24h_ago,
        lag(created_at, 12)  over (partition by event_id, rank order by created_at) as time_1h_ago,
        lag(created_at, 36)  over (partition by event_id, rank order by created_at) as time_3h_ago,
        lag(created_at, 288) over (partition by event_id, rank order by created_at) as time_24h_ago
    from event_rankings
), validated_speeds as (
    select *,
        case when extract(epoch from created_at - time_1h_ago)  between 3000  and 4200  then score - score_1h_ago  end as speed_1h,
        case when extract(epoch from created_at - time_3h_ago)  between 9600  and 12000 then score - score_3h_ago  end as speed_3h,
        case when extract(epoch from created_at - time_24h_ago) between 84600 and 88200 then score - score_24h_ago end as speed_24h
    from ranking_calculations
), latest_stats as (
    select event_id, rank,
        (array_agg(score      order by created_at desc))[1] as current_score,
        (array_agg(created_at order by created_at desc))[1] as last_captured_at,
        (array_agg(start_time order by created_at desc))[1] as event_start_time,
        (array_agg(speed_1h   order by created_at desc))[1] as last_1h_speed,
        (array_agg(speed_3h   order by created_at desc))[1] as last_3h_speed,
        (array_agg(speed_24h  order by created_at desc))[1] as last_24h_speed,
        max(speed_1h) filter (where created_at > start_time + interval '1 hour') as max_speed_historical
    from validated_speeds group by event_id, rank
)
select rank, current_score,
    coalesce(last_1h_speed, 0)  as last_1h_speed,
    coalesce(last_3h_speed, 0)  as last_3h_speed,
    coalesce(last_24h_speed, 0) as last_24h_speed,
    coalesce(max_speed_historical, 0) as max_speed,
    case when extract(epoch from last_captured_at - event_start_time) < 3600 then 0
         else round(current_score::numeric / (extract(epoch from last_captured_at - event_start_time) / 3600)) end as overall_speed
from latest_stats order by rank;

create or replace view {{schema}}.sekai_border_daily_report with (security_invoker = on) as
with event_rankings as (
    select event_id::text as event_id, rank, score, taken_at as created_at
    from {{schema}}.sekai_border_rankings
    where chapter = 0 and is_final = false
      and event_id = (select max(id) from {{schema}}.sekai_border_events where finalized_at is null and start_at <= now())
)
select event_id, rank, array_agg(score order by created_at) as scores
from (
    select distinct on (event_id, rank, date(created_at at time zone 'Asia/Taipei')) event_id, rank, score, created_at
    from event_rankings
    where extract(hour from created_at at time zone 'Asia/Taipei') = 0 and extract(minute from created_at at time zone 'Asia/Taipei') <= 2
    order by event_id, rank, date(created_at at time zone 'Asia/Taipei'), created_at
) sub group by event_id, rank;

-- RLS + grants: anon/authenticated SELECT only (spec S4, S5)
alter table {{schema}}.sekai_border_events   enable row level security;
alter table {{schema}}.sekai_border_rankings enable row level security;
drop policy if exists sekai_border_events_read   on {{schema}}.sekai_border_events;
drop policy if exists sekai_border_rankings_read on {{schema}}.sekai_border_rankings;
create policy sekai_border_events_read   on {{schema}}.sekai_border_events   for select to anon, authenticated using (true);
create policy sekai_border_rankings_read on {{schema}}.sekai_border_rankings for select to anon, authenticated using (true);
grant usage on schema {{schema}} to anon, authenticated, service_role;
revoke all on {{schema}}.sekai_border_events, {{schema}}.sekai_border_rankings, {{schema}}.sekai_border_current_report, {{schema}}.sekai_border_daily_report from anon, authenticated;
grant select on {{schema}}.sekai_border_events, {{schema}}.sekai_border_rankings, {{schema}}.sekai_border_current_report, {{schema}}.sekai_border_daily_report to anon, authenticated;
grant all on {{schema}}.sekai_border_events, {{schema}}.sekai_border_rankings to service_role;
```

- [ ] **Step 3: 渲染並套到 `test` schema**

```bash
cd /home/cholate/sekai-border && node scripts/render-sql.js supabase/migrations/0001_sekai_border.sql.tmpl test > /tmp/0001_test.sql && wc -l /tmp/0001_test.sql && grep -c "{{" /tmp/0001_test.sql
```

Expected: 約 150 行，`{{` 計數 0。然後用 Supabase MCP `apply_migration`（name `0001_sekai_border_test`，query = `/tmp/0001_test.sql` 內容）套用，或 user 以 psql 執行。Expected：無錯誤。

- [ ] **Step 4: 寫整合測試 helper 與 SQL 層測試（先寫、看它因為表空而失敗的部分）**

```js
// test/integration/helpers.js
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

export const SCHEMA = process.env.SUPABASE_SCHEMA;
if (SCHEMA !== 'test') { console.error('integration tests run only with SUPABASE_SCHEMA=test'); process.exit(2); }
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) if (!process.env[k]) { console.error(`missing ${k}`); process.exit(2); }

export const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: SCHEMA } });
export const anon = process.env.SUPABASE_ANON_KEY ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { db: { schema: SCHEMA } }) : null;

export async function truncate() {
    const r1 = await admin.from('sekai_border_rankings').delete().gte('event_id', 0);
    const r2 = await admin.from('sekai_border_events').delete().gte('id', 0);
    if (r1.error || r2.error) throw new Error('truncate failed: ' + (r1.error?.message || r2.error?.message));
}

export async function insertEvent(over = {}) {
    const row = { id: 182, name: '與你相繫的Heart Beat', start_at: '2026-10-11T07:00:00Z', aggregate_at: '2026-10-19T12:59:59Z', ranking_announce_at: '2026-10-19T13:09:59Z', ...over };
    const { error } = await admin.from('sekai_border_events').insert(row);
    if (error) throw new Error(error.message);
    return row;
}
```

```js
// test/integration/schema.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, anon, truncate, insertEvent } from './helpers.js';
import { ALLOWED_RANKS } from '../../src/constants.js';

const rows = (eventId, takenAt, chapter = 0, isFinal = false, base = 1000) => ALLOWED_RANKS.map((rank, i) => ({ event_id: eventId, chapter, rank, score: base - i, taken_at: takenAt, is_final: isFinal }));

test.beforeEach(truncate);

test('constraints: bad rank, negative score, undeclared chapter, bad chapters json are rejected', async () => {
    await insertEvent();
    let r = await admin.from('sekai_border_rankings').insert({ event_id: 182, chapter: 0, rank: 150, score: 1, taken_at: '2026-10-12T00:00:00Z' });
    assert.match(r.error.message, /check/i);
    r = await admin.from('sekai_border_rankings').insert({ event_id: 182, chapter: 0, rank: 100, score: -1, taken_at: '2026-10-12T00:00:00Z' });
    assert.match(r.error.message, /check/i);
    r = await admin.from('sekai_border_rankings').insert({ event_id: 182, chapter: 1, rank: 100, score: 1, taken_at: '2026-10-12T00:00:00Z' });
    assert.match(r.error.message, /not declared/);
    r = await admin.from('sekai_border_events').insert({ id: 179, name: 'x', start_at: '2026-09-06T12:00:00Z', aggregate_at: '2026-09-10T11:59:59Z', ranking_announce_at: '2026-09-10T12:09:59Z', chapters: [{ chapter: 7, chapter_id: 1, character_id: 2, start_at: '2026-09-06T12:00:00Z', aggregate_at: '2026-09-07T11:59:59Z', ranking_announce_at: '2026-09-07T12:09:59Z' }] });
    assert.match(r.error.message, /chapters_valid/);
});

test('snapshot insert is idempotent per slot (ON CONFLICT DO NOTHING via upsert ignoreDuplicates)', async () => {
    await insertEvent();
    const slot = '2026-10-12T00:00:00Z';
    const a = await admin.from('sekai_border_rankings').upsert(rows(182, slot), { onConflict: 'event_id,chapter,rank,taken_at,is_final', ignoreDuplicates: true });
    assert.equal(a.error, null);
    const b = await admin.from('sekai_border_rankings').upsert(rows(182, slot, 0, false, 5), { onConflict: 'event_id,chapter,rank,taken_at,is_final', ignoreDuplicates: true });
    assert.equal(b.error, null);
    const { data } = await admin.from('sekai_border_rankings').select('score').eq('rank', 1);
    assert.equal(data.length, 1); assert.equal(data[0].score, 1000);
});

test('finalize: keeps last observation per UTC hour (non-UTC session tz), keeps finals, asserts 30 finals, idempotent, snapshot at aggregate_at survives', async () => {
    await insertEvent();
    const times = ['2026-10-12T00:07:00Z', '2026-10-12T00:37:00Z', '2026-10-12T00:57:00Z', '2026-10-12T01:02:00Z', '2026-10-12T03:11:00Z', '2026-10-19T12:59:59Z'];
    for (const t of times) { const { error } = await admin.from('sekai_border_rankings').insert(rows(182, t)); assert.equal(error, null); }
    const finals = ALLOWED_RANKS.map((rank, i) => ({ chapter: 0, rank, score: 999999 - i }));
    const r1 = await admin.rpc('sekai_border_finalize', { p_event_id: 182, p_finals: finals });
    assert.equal(r1.error, null);
    assert.equal(r1.data.finalized, true); assert.equal(r1.data.already, false); assert.equal(r1.data.inserted_finals, 30);
    const { data } = await admin.from('sekai_border_rankings').select('taken_at,is_final').eq('rank', 1).order('taken_at');
    const snaps = data.filter((d) => !d.is_final).map((d) => new Date(d.taken_at).toISOString());
    assert.deepEqual(snaps, ['2026-10-12T00:57:00.000Z', '2026-10-12T01:02:00.000Z', '2026-10-12T03:11:00.000Z', '2026-10-19T12:59:59.000Z']);
    assert.equal(data.filter((d) => d.is_final).length, 1);
    const r2 = await admin.rpc('sekai_border_finalize', { p_event_id: 182, p_finals: finals });
    assert.equal(r2.data.already, true);
    const { data: ev } = await admin.from('sekai_border_events').select('finalized_at').eq('id', 182).single();
    assert.ok(ev.finalized_at);
});

test('finalize rolls back when fewer than 30 finals are supplied', async () => {
    await insertEvent();
    const finals = ALLOWED_RANKS.slice(0, 29).map((rank, i) => ({ chapter: 0, rank, score: 10 - 0 * i }));
    const r = await admin.rpc('sekai_border_finalize', { p_event_id: 182, p_finals: finals });
    assert.match(r.error.message, /expected 30/);
    const { count } = await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true }).eq('is_final', true);
    assert.equal(count, 0);
    const { data: ev } = await admin.from('sekai_border_events').select('finalized_at').eq('id', 182).single();
    assert.equal(ev.finalized_at, null);
});

test('compat views: single started unfinalized event, legacy column names, empty when none', async () => {
    const { data: empty } = await admin.from('sekai_border_current_report').select('*');
    assert.deepEqual(empty, []);
    await insertEvent();
    await admin.from('sekai_border_rankings').insert(rows(182, '2026-10-12T00:00:00Z'));
    await admin.from('sekai_border_rankings').insert(rows(182, '2026-10-12T00:05:00Z', 0, false, 2000));
    const { data: cur } = await admin.from('sekai_border_current_report').select('*').order('rank');
    assert.equal(cur.length, 30);
    assert.deepEqual(Object.keys(cur[0]).sort(), ['current_score', 'last_1h_speed', 'last_24h_speed', 'last_3h_speed', 'max_speed', 'overall_speed', 'rank']);
    assert.equal(cur[0].current_score, 2000);
    // Taipei midnight = 16:00Z
    await admin.from('sekai_border_rankings').insert(rows(182, '2026-10-12T16:00:00Z', 0, false, 3000));
    const { data: daily } = await admin.from('sekai_border_daily_report').select('*').order('rank');
    assert.equal(daily.length, 30);
    assert.deepEqual(Object.keys(daily[0]).sort(), ['event_id', 'rank', 'scores']);
    assert.equal(daily[0].event_id, '182');
    assert.deepEqual(daily[0].scores, [3000]);
});

test('privileges: anon can select tables and views but cannot write; finalize not executable by anon', { skip: !anon }, async () => {
    await insertEvent();
    const sel = await anon.from('sekai_border_events').select('id');
    assert.equal(sel.error, null);
    const ins = await anon.from('sekai_border_rankings').insert({ event_id: 182, chapter: 0, rank: 1, score: 1, taken_at: '2026-10-12T00:00:00Z' });
    assert.ok(ins.error);
    const del = await anon.from('sekai_border_events').delete().eq('id', 182);
    assert.ok(del.error || del.count === 0);
    const rpc = await anon.rpc('sekai_border_finalize', { p_event_id: 182, p_finals: [] });
    assert.ok(rpc.error);
    const v = await anon.from('sekai_border_current_report').select('*');
    assert.equal(v.error, null);
});
```

說明：privilege 測試用 anon key 走 PostgREST，驗的是 RLS + grant 的實際效果；`has_table_privilege` / `pg_policies` / `relrowsecurity` / `aclexplode` 的目錄層驗收在 Task 8 用 SQL 直接查（下面給指令）。

- [ ] **Step 5: 建 `.env`（本機，gitignored），跑整合測試**

```bash
cd /home/cholate/sekai-border && npm i --no-audit --no-fund dotenv@^17 && cat > .env <<'ENV'
SUPABASE_URL=https://bwhhtfcyagqhcddzssas.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<user 貼入>
SUPABASE_ANON_KEY=<user 貼入，可選；缺少時 privilege 測試跳過>
SUPABASE_SCHEMA=test
ENV
git check-ignore -q .env && echo ".env ignored" && SUPABASE_SCHEMA=test npm run test:integration 2>&1 | grep -E "ℹ (pass|fail|skipped)|not ok"
```

Expected: `pass 6`（或 anon 缺少時 `pass 5, skipped 1`）、`fail 0`。沒有 `SUPABASE_SCHEMA=test` 時 helper 以 exit 2 拒跑（也測一次：`SUPABASE_SCHEMA=public npm run test:integration` → 印拒跑訊息）。

- [ ] **Step 6: Commit**

```bash
cd /home/cholate/sekai-border && git add supabase/migrations/0001_sekai_border.sql.tmpl scripts/render-sql.js test/integration/helpers.js test/integration/schema.test.js package.json package-lock.json && git commit -m "feat: Supabase schema（兩張表、章節約束、結算交易函式、相容 view、RLS/grants）與 test schema 整合測試"
```

---

### Task 4: 副作用層 — `src/fetch.js`、`src/db.js`、`src/metadata.js`、`src/finalize.js`、`src/run.js`（一輪的編排）（spec §4、§4.4、§4.5、§5.2、§5.3）

**Files:**
- Create: `src/fetch.js`、`src/db.js`、`src/metadata.js`、`src/finalize.js`、`src/run.js`、`src/log.js`
- Test: `test/run.test.js`（以 fake fetch 與 fake db 測編排、請求預算、回應契約、錯誤 phase）、`test/metadata.test.js`、`test/integration/run.test.js`（真 DB，fake 上游）

**Interfaces:**
- `fetch.js`：`makeUpstream({ fetchImpl = globalThis.fetch, userAgent }) → { live(), eventList(), finals(id), master(name, etag) }`。每個函式單次請求、10 秒逾時、非 2xx 丟 `UpstreamError('fetch', 'http_'+status)`、JSON 失敗丟 `UpstreamError('fetch','json')`。`master` 回 `{ status: 200|304, etag, body }`。**無重試**。
- `db.js`：`makeDb(client) → { loadKnown(id), loadStartedLatest(now), loadEligible(now), insertEvent(row), insertSnapshot(rows, slot), finalize(id, finals), loadMetadataCandidate(now), updateMetadata(id, patch) }`。`client` 是 supabase-js client（schema 由呼叫端設定）。所有方法把 `{error}` 轉成 throw `new DbError(phase, message)`（`src/errors.js` 加 `DbError`）。`insertSnapshot` 用 `upsert(..., { onConflict: 'event_id,chapter,rank,taken_at,is_final', ignoreDuplicates: true })` 並回實際插入數（以 `select` 計數差）。
- `metadata.js`：`repairOne({ db, upstream, now, cache }) → { repaired: id|null }`，`cache` 是程序內 `{ etag, events }`。
- `finalize.js`：`finalizePending({ db, upstream, now }) → { finalized: [ids], deferred: [{id, reason}], failed: [{id, reason}] }`。
- `run.js`：`runOnce({ db, upstream, now, wlIngest }) → { status: 200|500, body }`，body 契約 = spec §4.2 末段（正常與 error 兩種形式）。
- `log.js`：`log(level, msg, detail)` 印單行 JSON；`detail` 必須是 `safeDetail` 產物或純數字/字串。

- [ ] **Step 1: 寫失敗的編排測試（fake 上游 + fake db）**

```js
// test/run.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runOnce } from '../src/run.js';
import { UpstreamError, DbError } from '../src/errors.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
const T = (s) => new Date(s);

function fakeUpstream(over = {}) {
    const calls = { live: 0, eventList: 0, finals: 0, master: 0 };
    return {
        calls,
        live: async () => { calls.live++; return over.live ? over.live() : { top100: fx('live-top100'), border: fx('live-border') }; },
        eventList: async () => { calls.eventList++; return over.eventList ? over.eventList() : fx('event-list'); },
        finals: async (id) => { calls.finals++; return over.finals ? over.finals(id) : { border: fx('final-border-181'), top100: fx('final-top100-181') }; },
        master: async (name) => { calls.master++; return over.master ? over.master(name) : { status: 200, etag: 'x', body: fx('master-' + name.replace('.json', '')) }; },
    };
}

function fakeDb(state = {}) {
    const s = { events: [], snapshots: [], finalized: [], ...state };
    const fail = (phase) => { if (s.failAt === phase) throw new DbError(phase, 'injected'); };
    return {
        s,
        loadKnown: async (id) => { fail('db-read'); return s.events.find((e) => e.id === id) ?? null; },
        loadStartedLatest: async (now) => { fail('db-read'); return s.events.filter((e) => e.start_at <= now).sort((a, b) => b.id - a.id)[0] ?? null; },
        loadEligible: async (now) => { fail('finalize-scan'); return s.events.filter((e) => e.finalized_at == null && now >= new Date(e.ranking_announce_at.getTime() + 15 * 60000)); },
        insertEvent: async (row) => { fail('event-write'); s.events.push({ finalized_at: null, chapters: [], metadata_status: 'pending', ...row }); },
        insertSnapshot: async (rows, slot) => { fail('snapshot-write'); const key = (r) => `${r.event_id}:${r.chapter}:${r.rank}:${slot.toISOString()}`; let n = 0; for (const r of rows) { const k = key(r); if (!s.snapshots.find((x) => x.k === k)) { s.snapshots.push({ k, ...r, taken_at: slot }); n++; } } return n; },
        finalize: async (id) => { fail('finalize'); s.finalized.push(id); const e = s.events.find((x) => x.id === id); e.finalized_at = new Date(); return { finalized: true, already: false }; },
        loadMetadataCandidate: async () => { fail('metadata'); return s.events.find((e) => e.metadata_status === 'pending') ?? null; },
        updateMetadata: async (id, patch) => { fail('metadata'); Object.assign(s.events.find((e) => e.id === id), patch); },
    };
}

const live = () => ({ top100: fx('live-top100'), border: fx('live-border') });
const liveEvent = () => { const t = fx('live-top100'); return { id: t.id, name: t.name, start_at: T(t.start_at), aggregate_at: T(t.aggregate_at), ranking_announce_at: T(t.ranking_announce_at) }; };

test('bootstrap: empty db -> insert event, write 30 snapshot rows, 200, budget = live 2 + eventList 1 + master 1..3', async () => {
    const up = fakeUpstream(); const db = fakeDb();
    const r = await runOnce({ db, upstream: up, now: T('2026-10-15T00:03:00Z'), wlIngest: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.branch, 'current'); assert.equal(r.body.inserted, 30); assert.equal(r.body.slot, '2026-10-15T00:00:00.000Z');
    assert.equal(db.s.events.length, 1);
    assert.equal(up.calls.eventList, 1); assert.ok(up.calls.master >= 1 && up.calls.master <= 3);
});

test('current: known event -> 30 rows, same slot twice inserts 0 the second time', async () => {
    const up = fakeUpstream(); const db = fakeDb({ events: [{ ...liveEvent(), finalized_at: null, metadata_status: 'complete', chapters: [] }] });
    const a = await runOnce({ db, upstream: up, now: T('2026-10-15T00:03:00Z') });
    const b = await runOnce({ db, upstream: up, now: T('2026-10-15T00:04:30Z') });
    assert.equal(a.body.inserted, 30); assert.equal(b.body.inserted, 0); assert.equal(b.status, 200);
    assert.equal(up.calls.eventList, 0);
});

test('frozen and due write no snapshot; due with unpublished finals -> finalize_deferred, 200', async () => {
    const ev = { ...liveEvent(), finalized_at: null, metadata_status: 'complete', chapters: [] };
    const up = fakeUpstream({ finals: () => { const b = fx('final-border-181'); return { border: { ...b, eventId: ev.id, isEventAggregate: false }, top100: fx('final-top100-181') }; } });
    const db = fakeDb({ events: [ev] });
    const frozen = await runOnce({ db, upstream: up, now: T('2026-10-19T13:05:00Z') });
    assert.equal(frozen.body.branch, 'frozen'); assert.equal(frozen.body.inserted, 0); assert.equal(up.calls.finals, 0);
    const due = await runOnce({ db, upstream: up, now: T('2026-10-19T13:30:00Z') });
    assert.equal(due.status, 200); assert.equal(due.body.branch, 'due'); assert.equal(due.body.finalize_deferred.length, 1); assert.equal(up.calls.finals, 1);
});

test('eligible pending event is finalized on a normal current round of a different live event; one failing event -> 500 but snapshots written', async () => {
    const old = { id: 181, name: 'old', start_at: T('2026-10-01T07:00:00Z'), aggregate_at: T('2026-10-09T12:59:59Z'), ranking_announce_at: T('2026-10-09T13:09:59Z'), finalized_at: null, metadata_status: 'complete', chapters: [] };
    const older = { ...old, id: 180, name: 'older' };
    const cur = { ...liveEvent(), finalized_at: null, metadata_status: 'complete', chapters: [] };
    const up = fakeUpstream({ finals: (id) => { if (id === 180) throw new UpstreamError('fetch', 'http_500'); const b = fx('final-border-181'); return { border: { ...b, eventId: id }, top100: fx('final-top100-181') }; } });
    const db = fakeDb({ events: [older, old, cur] });
    const r = await runOnce({ db, upstream: up, now: T('2026-10-15T00:03:00Z') });
    assert.equal(r.status, 500);
    assert.equal(r.body.inserted, 30);
    assert.deepEqual(r.body.finalized, [181]);
    assert.equal(r.body.finalize_failed[0].id, 180);
});

test('validate failure short-circuits: 500, branch error, phase validate, no finalize and no metadata calls', async () => {
    const up = fakeUpstream({ live: () => { const b = fx('live-border'); return { top100: fx('live-top100'), border: { ...b, id: b.id + 1 } }; } });
    const db = fakeDb({ events: [{ id: 181, name: 'old', start_at: T('2026-10-01T07:00:00Z'), aggregate_at: T('2026-10-09T12:59:59Z'), ranking_announce_at: T('2026-10-09T13:09:59Z'), finalized_at: null, metadata_status: 'pending', chapters: [] }] });
    const r = await runOnce({ db, upstream: up, now: T('2026-10-15T00:03:00Z') });
    assert.equal(r.status, 500); assert.equal(r.body.branch, 'error'); assert.equal(r.body.phase, 'validate'); assert.equal(r.body.error_code, 'event_mismatch');
    assert.equal(up.calls.finals, 0); assert.equal(up.calls.master, 0);
});

test('regress short-circuits with phase regress', async () => {
    const up = fakeUpstream(); const db = fakeDb({ events: [{ ...liveEvent(), id: 999, start_at: T('2026-10-01T00:00:00Z'), finalized_at: null, metadata_status: 'complete', chapters: [] }] });
    const r = await runOnce({ db, upstream: up, now: T('2026-10-15T00:03:00Z') });
    assert.equal(r.status, 500); assert.equal(r.body.phase, 'regress');
});

test('pre-start: live event not yet started -> nothing inserted, branch pre-start, scan still runs', async () => {
    const t = fx('live-top100'); const b = fx('live-border');
    const future = { ...t, id: 183, start_at: '2026-10-21T07:00:00Z', aggregate_at: '2026-10-29T12:59:59Z', ranking_announce_at: '2026-10-29T13:09:59Z' };
    const fb = { ...b, id: 183, start_at: future.start_at, aggregate_at: future.aggregate_at, ranking_announce_at: future.ranking_announce_at };
    const list = [...fx('event-list'), { id: 183, name: 'next', chapters: [], start_at: future.start_at, closed_at: future.aggregate_at, aggregate_at: future.aggregate_at, ranking_announce_at: future.ranking_announce_at }];
    const up = fakeUpstream({ live: () => ({ top100: future, border: fb }), eventList: () => list });
    const db = fakeDb({ events: [{ ...liveEvent(), finalized_at: null, metadata_status: 'complete', chapters: [] }] });
    const r = await runOnce({ db, upstream: up, now: T('2026-10-20T00:03:00Z') });
    assert.equal(r.status, 200); assert.equal(r.body.branch, 'pre-start'); assert.equal(r.body.inserted, 0); assert.equal(db.s.events.length, 1);
});

for (const phase of ['db-read', 'event-write', 'snapshot-write', 'finalize-scan', 'metadata']) {
    test(`db failure at ${phase} -> 500 with that phase and preserved partial`, async () => {
        const up = fakeUpstream();
        const base = phase === 'db-read' || phase === 'event-write' ? [] : [{ ...liveEvent(), finalized_at: null, metadata_status: 'pending', chapters: [] }];
        const db = fakeDb({ events: base, failAt: phase });
        const r = await runOnce({ db, upstream: up, now: T('2026-10-15T00:03:00Z') });
        assert.equal(r.status, 500); assert.equal(r.body.branch, 'error'); assert.equal(r.body.phase, phase);
        if (phase === 'finalize-scan' || phase === 'metadata') assert.equal(r.body.partial.inserted, 30); else assert.equal(r.body.partial.inserted, 0);
    });
}
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /home/cholate/sekai-border && node --test test/run.test.js 2>&1 | head -5`
Expected: `Cannot find module` 指向 `src/run.js`。

- [ ] **Step 3: 實作 log / errors / fetch / db / metadata / finalize / run**

```js
// src/log.js
// Single-line JSON logs for Cloud Logging. `detail` must come from safeDetail() or be plain numbers/strings:
// upstream player fields must never reach here (spec §5.3).
export function log(level, msg, detail = {}) {
    const line = JSON.stringify({ severity: level.toUpperCase(), msg, ...detail, ts: new Date().toISOString() });
    (level === 'error' ? console.error : console.log)(line);
}
```

```js
// src/errors.js  (append)
export class DbError extends Error {
    constructor(phase, message) { super(`${phase}:${message}`); this.phase = phase; }
}
```

```js
// src/fetch.js
import { UpstreamError } from './errors.js';

const BASE = 'https://api.hisekai.org/tw';
const MASTER = 'https://raw.githubusercontent.com/Sekai-World/sekai-master-db-tc-diff/main/';
const TIMEOUT_MS = 10000;

export function makeUpstream({ fetchImpl = globalThis.fetch, userAgent = 'sekai-border' } = {}) {
    async function getJson(url, extraHeaders = {}) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        let res;
        try {
            res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json', ...extraHeaders }, signal: ctrl.signal });
        } catch (e) {
            throw new UpstreamError('fetch', e.name === 'AbortError' ? 'timeout' : 'network', { url });
        } finally { clearTimeout(t); }
        if (res.status === 304) return { status: 304, etag: res.headers.get('etag'), body: null };
        if (!res.ok) throw new UpstreamError('fetch', `http_${res.status}`, { url });
        try { return { status: 200, etag: res.headers.get('etag'), body: await res.json() }; }
        catch { throw new UpstreamError('fetch', 'json', { url }); }
    }
    return {
        async live() {
            const [t, b] = await Promise.all([getJson(`${BASE}/event/live/top100`), getJson(`${BASE}/event/live/border`)]);
            return { top100: t.body, border: b.body };
        },
        async eventList() { return (await getJson(`${BASE}/event/list`)).body; },
        async finals(id) {
            const [b, t] = await Promise.all([getJson(`${BASE}/event/${id}/border`), getJson(`${BASE}/event/${id}/top100`)]);
            return { border: b.body, top100: t.body };
        },
        async master(name, etag) { return getJson(MASTER + name, etag ? { 'If-None-Match': etag } : {}); },
    };
}
```

```js
// src/db.js
// The only module that talks to supabase-js. Every method throws DbError(phase) on {error}.
import { DbError } from './errors.js';

const toDates = (e) => e && ({ ...e, start_at: new Date(e.start_at), aggregate_at: new Date(e.aggregate_at), ranking_announce_at: new Date(e.ranking_announce_at), finalized_at: e.finalized_at ? new Date(e.finalized_at) : null, metadata_checked_at: e.metadata_checked_at ? new Date(e.metadata_checked_at) : null });
const chk = (phase, { error, data, count }) => { if (error) throw new DbError(phase, error.message); return { data, count }; };

export function makeDb(client) {
    const ev = () => client.from('sekai_border_events');
    const rk = () => client.from('sekai_border_rankings');
    return {
        async loadKnown(id) { const { data } = chk('db-read', await ev().select('*').eq('id', id).maybeSingle()); return toDates(data); },
        async loadStartedLatest(now) { const { data } = chk('db-read', await ev().select('*').lte('start_at', now.toISOString()).order('id', { ascending: false }).limit(1).maybeSingle()); return toDates(data); },
        async loadEligible(now) {
            const cutoff = new Date(now.getTime() - 15 * 60000).toISOString();
            const { data } = chk('finalize-scan', await ev().select('*').is('finalized_at', null).lte('ranking_announce_at', cutoff).order('id'));
            return data.map(toDates);
        },
        async insertEvent(row) { chk('event-write', await ev().insert(row)); },
        async insertSnapshot(rows, slot) {
            const payload = rows.map((r) => ({ ...r, taken_at: slot.toISOString(), is_final: false }));
            const before = chk('snapshot-write', await rk().select('*', { count: 'exact', head: true }).eq('event_id', rows[0].event_id).eq('taken_at', slot.toISOString()).eq('is_final', false)).count;
            chk('snapshot-write', await rk().upsert(payload, { onConflict: 'event_id,chapter,rank,taken_at,is_final', ignoreDuplicates: true }));
            const after = chk('snapshot-write', await rk().select('*', { count: 'exact', head: true }).eq('event_id', rows[0].event_id).eq('taken_at', slot.toISOString()).eq('is_final', false)).count;
            return after - before;
        },
        async finalize(id, finals) { const { data } = chk('finalize', await client.rpc('sekai_border_finalize', { p_event_id: id, p_finals: finals })); return data; },
        async loadMetadataCandidate(now) {
            const h6 = new Date(now.getTime() - 6 * 3600000).toISOString();
            const d30 = new Date(now.getTime() - 30 * 86400000).toISOString();
            const { data } = chk('metadata', await ev().select('*').or(`and(metadata_status.eq.pending,or(metadata_checked_at.is.null,metadata_checked_at.lt.${h6})),and(metadata_status.in.(missing,mismatch),metadata_checked_at.lt.${d30})`).order('id').limit(1).maybeSingle());
            return toDates(data);
        },
        async updateMetadata(id, patch) { chk('metadata', await ev().update(patch).eq('id', id)); },
    };
}
```

```js
// src/metadata.js
// Repairs one event row per round from master db (spec §4.4). `cache` persists ETag + parsed events in-process.
export async function repairOne({ db, upstream, now, cache }) {
    const row = await db.loadMetadataCandidate(now);
    if (!row) return { repaired: null };
    let events;
    try {
        const r = await upstream.master('events.json', cache.etag);
        if (r.status === 200) { cache.etag = r.etag; cache.events = r.body; }
        events = cache.events;
    } catch {
        await db.updateMetadata(row.id, { metadata_checked_at: now.toISOString() });
        return { repaired: null };
    }
    const m = events.find((e) => e.id === row.id);
    if (!m) {
        const miss = row.metadata_miss_count + 1;
        const old = now.getTime() - row.aggregate_at.getTime() >= 7 * 86400000;
        const status = miss >= 3 && old ? 'missing' : (row.metadata_status === 'missing' ? 'missing' : 'pending');
        await db.updateMetadata(row.id, { metadata_miss_count: miss, metadata_checked_at: now.toISOString(), metadata_status: status });
        return { repaired: null };
    }
    if (String(m.name ?? '').trim() !== String(row.name).trim()) {
        await db.updateMetadata(row.id, { metadata_status: 'mismatch', metadata_miss_count: 0, metadata_checked_at: now.toISOString() });
        return { repaired: null };
    }
    const [ec, cards] = await Promise.all([upstream.master('eventCards.json'), upstream.master('cards.json')]);
    const cardIds = ec.body.filter((x) => x.eventId === row.id).map((x) => x.cardId);
    const chars = [...new Set(cards.body.filter((c) => cardIds.includes(c.id)).map((c) => c.characterId))].sort((a, b) => a - b);
    await db.updateMetadata(row.id, { event_type: m.eventType, unit: m.unit ?? null, bonus_characters: chars, metadata_status: 'complete', metadata_miss_count: 0, metadata_checked_at: now.toISOString() });
    return { repaired: row.id };
}
```

```js
// src/finalize.js
import { validateFinal } from './validate.js';
import { isEligibleForFinalize } from './state.js';
import { log } from './log.js';

// Tries every eligible event independently (spec §4.2 step 3). Returns {finalized, deferred, failed}.
export async function finalizePending({ db, upstream, now }) {
    const out = { finalized: [], deferred: [], failed: [] };
    const eligible = (await db.loadEligible(now)).filter((e) => isEligibleForFinalize(e, now));
    for (const e of eligible) {
        try {
            const { border, top100 } = await upstream.finals(e.id);
            const { rows, deferred } = validateFinal(e.id, border, top100, e.chapters ?? []);
            if (deferred) { out.deferred.push({ id: e.id, reason: 'not_published' }); continue; }
            const r = await db.finalize(e.id, rows);
            out.finalized.push(e.id);
            log('info', 'finalized', { event_id: e.id, ...r });
        } catch (err) {
            out.failed.push({ id: e.id, reason: `${err.phase ?? 'finalize'}:${err.code ?? err.message}` });
            log('error', 'finalize failed', { event_id: e.id, phase: err.phase ?? 'finalize', code: err.code ?? err.message, ...(err.detail ?? {}) });
        }
    }
    return out;
}
```

```js
// src/run.js
// One scheduler round (spec §4). Pure decisions come from state.js; effects go through db/upstream.
import { validateLive, validateEventListEntry } from './validate.js';
import { decide, slotOf } from './state.js';
import { finalizePending } from './finalize.js';
import { repairOne } from './metadata.js';
import { log } from './log.js';

const metaCache = { etag: null, events: null };

export async function runOnce({ db, upstream, now = new Date(), wlIngest = false, cache = metaCache }) {
    const slot = slotOf(now);
    const partial = { inserted: 0, finalized: [], finalize_deferred: [], finalize_failed: [] };
    const error = (phase, code, event_id = null) => ({ status: 500, body: { slot: slot.toISOString(), branch: 'error', phase, error_code: code, event_id, partial } });
    let live, rows;
    try {
        const { top100, border } = await upstream.live();
        ({ event: live, rows } = validateLive(top100, border, { wlIngest }));
    } catch (e) { log('error', 'live failed', { phase: e.phase, code: e.code, ...(e.detail ?? {}) }); return error(e.phase ?? 'fetch', e.code ?? 'unknown'); }

    let known, startedLatest, listEntry = null;
    try { known = await db.loadKnown(live.id); startedLatest = await db.loadStartedLatest(now); }
    catch (e) { return error('db-read', e.message, live.id); }

    let preStart = false;
    if (!known && !(startedLatest && live.id < startedLatest.id)) {
        try { listEntry = validateEventListEntry(await upstream.eventList(), live.id, live); }
        catch (e) { log('error', 'event list failed', { phase: e.phase, code: e.code }); return error(e.phase ?? 'event-list', e.code ?? 'unknown', live.id); }
        preStart = new Date(listEntry.start_at) > now;
    }
    const d = decide({ live, known, startedLatest, now, preStart });
    if (d.ensure === 'regress') { log('error', 'regress', { live_id: live.id, latest_id: startedLatest?.id }); return error('regress', 'live_id_below_latest', live.id); }
    if (d.ensure === 'insert') {
        const chapters = (listEntry.chapters ?? []).map((c) => ({ chapter: c.chapter, chapter_id: c.id, character_id: c.character, start_at: c.start_at, aggregate_at: c.aggregate_at, ranking_announce_at: c.ranking_announce_at }));
        try { await db.insertEvent({ id: live.id, name: live.name, start_at: live.start_at.toISOString(), aggregate_at: live.aggregate_at.toISOString(), ranking_announce_at: live.ranking_announce_at.toISOString(), chapters, metadata_status: 'pending' }); }
        catch (e) { return error('event-write', e.message, live.id); }
    }
    if (d.branch === 'current') {
        try { partial.inserted = await db.insertSnapshot(rows.map((r) => ({ event_id: live.id, ...r })), slot); }
        catch (e) { return error('snapshot-write', e.message, live.id); }
    }

    let fin;
    try { fin = await finalizePending({ db, upstream, now }); }
    catch (e) { return error('finalize-scan', e.message, live.id); }
    Object.assign(partial, { finalized: fin.finalized, finalize_deferred: fin.deferred, finalize_failed: fin.failed });

    let repaired = null;
    try { ({ repaired } = await repairOne({ db, upstream, now, cache })); }
    catch (e) { return error('metadata', e.message, live.id); }

    const body = { slot: slot.toISOString(), event_id: live.id, branch: d.branch, inserted: partial.inserted, finalized: fin.finalized, finalize_deferred: fin.deferred, finalize_failed: fin.failed, metadata_repaired: repaired };
    log(fin.failed.length ? 'error' : 'info', 'round', body);
    return { status: fin.failed.length ? 500 : 200, body };
}
```

注意：`db.loadEligible` 的 `finalize-scan` phase 由 db.js 丟出；`db.finalize` 失敗（phase `finalize`）在 `finalizePending` 內被當成該期的 `failed`，不中斷其他期。

- [ ] **Step 4: 跑單元測試確認通過**

Run: `cd /home/cholate/sekai-border && npm test 2>&1 | grep -E "ℹ (pass|fail)|not ok"`
Expected: `fail 0`（pass 數 = 24 + 12）。

- [ ] **Step 5: metadata 單元測試（fake db/upstream）**

```js
// test/metadata.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { repairOne } from '../src/metadata.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
const T = (s) => new Date(s);
const row = (over = {}) => ({ id: 182, name: '與你相繫的Heart Beat', aggregate_at: T('2026-10-19T12:59:59Z'), metadata_status: 'pending', metadata_miss_count: 0, metadata_checked_at: null, ...over });
const mk = (r, masterOver = {}) => {
    const patches = [];
    const db = { loadMetadataCandidate: async () => r, updateMetadata: async (id, p) => patches.push(p) };
    const upstream = { master: async (name, etag) => { if (masterOver.fail) throw new Error('net'); if (name === 'events.json' && etag === 'E1') return { status: 304, etag: 'E1', body: null }; return { status: 200, etag: 'E1', body: masterOver[name] ?? fx('master-' + name.replace('.json', '')) }; } };
    return { db, upstream, patches };
};

test('found with same name -> complete with type, unit and bonus characters', async () => {
    const { db, upstream, patches } = mk(row());
    const r = await repairOne({ db, upstream, now: T('2026-10-16T00:00:00Z'), cache: {} });
    assert.equal(r.repaired, 182);
    assert.equal(patches[0].metadata_status, 'complete'); assert.equal(patches[0].event_type, 'marathon');
    assert.deepEqual(patches[0].bonus_characters, [1, 2, 3, 4, 25]);
});

test('found with different name -> mismatch, miss count reset, no attributes', async () => {
    const { db, upstream, patches } = mk(row({ name: 'other', metadata_miss_count: 2 }));
    await repairOne({ db, upstream, now: T('2026-10-16T00:00:00Z'), cache: {} });
    assert.equal(patches[0].metadata_status, 'mismatch'); assert.equal(patches[0].metadata_miss_count, 0); assert.equal(patches[0].event_type, undefined);
});

test('absent: miss 1, 2 stay pending; third miss becomes missing only when event ended 7+ days ago', async () => {
    const r = row({ id: 999999 });
    let m = mk(r); await repairOne({ ...m, now: T('2026-10-16T00:00:00Z'), cache: {} }); assert.deepEqual([m.patches[0].metadata_status, m.patches[0].metadata_miss_count], ['pending', 1]);
    m = mk({ ...r, metadata_miss_count: 2 }); await repairOne({ ...m, now: T('2026-10-20T00:00:00Z'), cache: {} }); assert.equal(m.patches[0].metadata_status, 'pending');
    m = mk({ ...r, metadata_miss_count: 2 }); await repairOne({ ...m, now: T('2026-11-01T00:00:00Z'), cache: {} }); assert.equal(m.patches[0].metadata_status, 'missing');
});

test('fetch failure only touches checked_at', async () => {
    const m = mk(row({ metadata_miss_count: 1 }), { fail: true });
    await repairOne({ ...m, now: T('2026-10-16T00:00:00Z'), cache: {} });
    assert.deepEqual(Object.keys(m.patches[0]), ['metadata_checked_at']);
});

test('ETag 304 reuses cached events without re-parsing', async () => {
    const m = mk(row());
    const cache = { etag: 'E1', events: fx('master-events') };
    const r = await repairOne({ ...m, now: T('2026-10-16T00:00:00Z'), cache });
    assert.equal(r.repaired, 182);
});
```

Run: `cd /home/cholate/sekai-border && npm test 2>&1 | grep -E "ℹ (pass|fail)|not ok"`
Expected: `fail 0`。

- [ ] **Step 6: 整合測試（真 DB、fake 上游）**

```js
// test/integration/run.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { admin, truncate } from './helpers.js';
import { makeDb } from '../../src/db.js';
import { runOnce } from '../../src/run.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8'));
const T = (s) => new Date(s);
const upstream = (finalsFlag = true) => ({
    live: async () => ({ top100: fx('live-top100'), border: fx('live-border') }),
    eventList: async () => fx('event-list'),
    finals: async (id) => { const b = fx('final-border-181'); return { border: { ...b, eventId: id, isEventAggregate: finalsFlag }, top100: fx('final-top100-181') }; },
    master: async (name) => ({ status: 200, etag: 'x', body: fx('master-' + name.replace('.json', '')) }),
});

test.beforeEach(truncate);

test('bootstrap + same-slot double fire + finalize through the real RPC', async () => {
    const db = makeDb(admin);
    const a = await runOnce({ db, upstream: upstream(), now: T('2026-10-15T00:03:00Z'), cache: {} });
    assert.equal(a.status, 200); assert.equal(a.body.inserted, 30); assert.equal(a.body.metadata_repaired, 182);
    const b = await runOnce({ db, upstream: upstream(), now: T('2026-10-15T00:04:00Z'), cache: {} });
    assert.equal(b.body.inserted, 0);
    const c = await runOnce({ db, upstream: upstream(), now: T('2026-10-15T01:00:00Z'), cache: {} });
    assert.equal(c.body.inserted, 30);
    // force the event into "due" by rewriting its times, then finalize
    await admin.from('sekai_border_events').update({ aggregate_at: '2026-10-15T01:10:00Z', ranking_announce_at: '2026-10-15T01:20:00Z' }).eq('id', 182);
    const due = await runOnce({ db, upstream: upstream(false), now: T('2026-10-15T01:40:00Z'), cache: {} });
    assert.equal(due.body.finalize_deferred.length, 1);
    const fin = await runOnce({ db, upstream: upstream(true), now: T('2026-10-15T01:45:00Z'), cache: {} });
    assert.deepEqual(fin.body.finalized, [182]);
    const { count } = await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true }).eq('is_final', true);
    assert.equal(count, 30);
    const { data: ev } = await admin.from('sekai_border_events').select('finalized_at,event_type').eq('id', 182).single();
    assert.ok(ev.finalized_at); assert.equal(ev.event_type, 'marathon');
});
```

Run: `cd /home/cholate/sekai-border && npm run test:integration 2>&1 | grep -E "ℹ (pass|fail)|not ok"`
Expected: `fail 0`。

- [ ] **Step 7: Commit**

```bash
cd /home/cholate/sekai-border && git add src test && git commit -m "feat: 上游抓取、DB 存取、屬性修補、待結算掃描與單輪編排（含錯誤 phase 契約與請求預算測試）"
```

---

### Task 5: HTTP 伺服器、`--once`、JWT 角色檢查、Dockerfile（spec §4.6、§5.1、§5.2、S2）

**Files:**
- Create: `src/server.js`、`src/env.js`
- Rewrite: `index.js`
- Delete: `fetch_all_rankings.js`
- Modify: `Dockerfile`（CMD 不變，確認 node:22）
- Test: `test/server.test.js`、`test/env.test.js`

**Interfaces:**
- `env.js`：`loadEnv(env = process.env) → { url, key, schema, botContact, wlIngest }`；缺 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 或 JWT `role !== 'service_role'` → throw `Error('env: ...')`，訊息不含 key。
- `server.js`：`createServer({ handler }) → http.Server`；只有 `POST /run` 呼叫 `handler()`（回 `{status, body}`），其他 404 `{error:'not_found'}`；`sendJson` 帶 `headersSent` 護欄；handler throw → 500 `{branch:'error', phase:'unhandled'}`。

- [ ] **Step 1: 寫失敗的測試**

```js
// test/env.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../src/env.js';

const jwt = (role) => 'h.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.s';

test('accepts a service_role JWT and defaults', () => {
    const e = loadEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: jwt('service_role') });
    assert.equal(e.schema, 'public'); assert.equal(e.wlIngest, false); assert.equal(e.key.length > 0, true);
});
test('rejects anon role and missing vars without leaking the key', () => {
    const k = jwt('anon');
    assert.throws(() => loadEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: k }), (e) => /role/.test(e.message) && !e.message.includes(k));
    assert.throws(() => loadEnv({ SUPABASE_URL: 'https://x.supabase.co' }), /SUPABASE_SERVICE_ROLE_KEY/);
    assert.throws(() => loadEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_KEY: jwt('service_role') }), /SUPABASE_SERVICE_ROLE_KEY/);
});
```

```js
// test/server.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

async function withServer(handler, fn) {
    const srv = createServer({ handler });
    await new Promise((r) => srv.listen(0, r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try { await fn(base); } finally { await new Promise((r) => srv.close(r)); }
}

test('POST /run calls handler and relays status/body', async () => {
    await withServer(async () => ({ status: 200, body: { ok: 1 } }), async (base) => {
        const r = await fetch(base + '/run', { method: 'POST' });
        assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: 1 });
    });
});
test('other routes are 404 and do not call the handler', async () => {
    let calls = 0;
    await withServer(async () => { calls++; return { status: 200, body: {} }; }, async (base) => {
        for (const [m, p] of [['GET', '/'], ['POST', '/'], ['GET', '/run']]) { const r = await fetch(base + p, { method: m }); assert.equal(r.status, 404); }
    });
    assert.equal(calls, 0);
});
test('handler throw -> 500 unhandled', async () => {
    await withServer(async () => { throw new Error('boom'); }, async (base) => {
        const r = await fetch(base + '/run', { method: 'POST' });
        assert.equal(r.status, 500); assert.equal((await r.json()).phase, 'unhandled');
    });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /home/cholate/sekai-border && node --test test/env.test.js test/server.test.js 2>&1 | head -4`
Expected: `Cannot find module`。

- [ ] **Step 3: 實作**

```js
// src/env.js
export function loadEnv(env = process.env) {
    for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) if (!env[k]) throw new Error(`env: ${k} is required`);
    let role;
    try { role = JSON.parse(Buffer.from(env.SUPABASE_SERVICE_ROLE_KEY.split('.')[1], 'base64url').toString('utf8')).role; } catch { throw new Error('env: SUPABASE_SERVICE_ROLE_KEY is not a JWT'); }
    if (role !== 'service_role') throw new Error('env: SUPABASE_SERVICE_ROLE_KEY role must be service_role');
    return { url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, schema: env.SUPABASE_SCHEMA || 'public', botContact: env.BOT_CONTACT || 'sekai-border', wlIngest: env.WL_INGEST === 'on' };
}
```

```js
// src/server.js
import http from 'node:http';

// headersSent guard: the error path must never throw a second time (LESSONS 2026-07-28).
export function sendJson(res, status, body) {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

export function createServer({ handler }) {
    return http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/run') return sendJson(res, 404, { error: 'not_found' });
        try { const { status, body } = await handler(); sendJson(res, status, body); }
        catch (e) { console.error(JSON.stringify({ severity: 'ERROR', msg: 'unhandled', error: String(e?.message) })); sendJson(res, 500, { branch: 'error', phase: 'unhandled', error_code: 'unhandled' }); }
    });
}
```

```js
// index.js
// `node index.js` -> HTTP server for Cloud Run; `node index.js --once` -> one round, prints the body, exits with 0/1.
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './src/env.js';
import { makeDb } from './src/db.js';
import { makeUpstream } from './src/fetch.js';
import { runOnce } from './src/run.js';
import { createServer } from './src/server.js';

const env = loadEnv();
console.log(JSON.stringify({ severity: 'INFO', msg: 'boot', supabase_ref: new URL(env.url).hostname.split('.')[0], schema: env.schema, wl_ingest: env.wlIngest }));
const db = makeDb(createClient(env.url, env.key, { db: { schema: env.schema } }));
const upstream = makeUpstream({ userAgent: env.botContact });
const handler = () => runOnce({ db, upstream, now: new Date(), wlIngest: env.wlIngest });

if (process.argv.includes('--once')) {
    const r = await handler();
    console.log(JSON.stringify(r.body));
    process.exit(r.status === 200 ? 0 : 1);
} else {
    const port = Number(process.env.PORT || 8080);
    createServer({ handler }).listen(port, () => console.log(JSON.stringify({ severity: 'INFO', msg: 'listening', port })));
}
```

```bash
cd /home/cholate/sekai-border && git rm -q fetch_all_rankings.js && npm uninstall @google-cloud/functions-framework 2>&1 | tail -1 && sed -i 's/^FROM node:22-slim/FROM node:22-slim/' Dockerfile && grep -n "FROM\|CMD\|npm ci" Dockerfile
```

Expected: Dockerfile 仍為 `node:22-slim`、`npm ci --omit=dev`、`CMD ["node","index.js"]`；functions-framework 移除（`npm start` 已改為 `node index.js`）。

- [ ] **Step 4: 跑測試確認通過；本機 `--once` 對 test schema 跑一輪**

```bash
cd /home/cholate/sekai-border && npm test 2>&1 | grep -E "ℹ (pass|fail)|not ok" && set -a && . ./.env && set +a && SUPABASE_SCHEMA=test node index.js --once; echo "once exit=$?"
```

Expected: 單元 `fail 0`；`--once` 印 boot 行（含 `supabase_ref: bwhhtfcyagqhcddzssas`、`schema: test`）與一行 body，`branch` 為當下對應的分支，exit 0（若 test schema 被整合測試清空，這輪會是 bootstrap：`inserted: 30`）。

- [ ] **Step 5: Docker build 並在容器內跑 `--once`**

```bash
cd /home/cholate/sekai-border && docker build -t sekai-border-test . 2>&1 | tail -2 && docker run --rm --env-file .env -e SUPABASE_SCHEMA=test sekai-border-test node index.js --once; echo "container once exit=$?"
```

Expected: build 成功；容器內同樣印 body，exit 0。

- [ ] **Step 6: Commit**

```bash
cd /home/cholate/sekai-border && git add -A src index.js test Dockerfile package.json package-lock.json && git commit -m "feat: 只接受 POST /run 的伺服器、--once 單輪模式、service_role JWT 檢查；移除 fetch_all_rankings.js 與 functions-framework"
```

---

### Task 6: `scripts/backfill.js` 與 `scripts/migrate-legacy.js`（spec §7 步驟 4、6；S9a、S9b）

**Files:**
- Create: `scripts/backfill.js`、`scripts/migrate-legacy.js`、`scripts/confirm.js`（共用：印 ref、要求輸入 `yes`）
- Create: `supabase/migrations/0002_migrate_legacy.sql.tmpl`（`{{schema}}`、`{{cutover_slot}}`、`{{allow_skipped}}` 佔位；由 `migrate-legacy.js` 渲染並以**一次 RPC** 執行）
- Create: `supabase/migrations/0001b_exec_sql.sql.tmpl`（`{{schema}}.sekai_border_exec_migration(p_cutover timestamptz, p_allow_skipped int)` 函式：把 0002 的邏輯包成 security definer 函式，只給 service_role；遷移因此是單一交易且可由 supabase-js 呼叫）
- Test: `test/backfill.test.js`（fake db/upstream：續跑、間隔、只處理已結束期）、`test/integration/migrate.test.js`（真 DB：驗證集、cutover 擁有權、回滾案例）

**Interfaces:**
- `backfill.js`：`node scripts/backfill.js [--from 1] [--to 999] [--yes]`。流程：讀 `.env` → 印 ref 與 schema → 等 `yes`（`--yes` 跳過，供測試）→ `event/list` → 對每個 `ranking_announce_at + 15 min < now` 且 `id` 在範圍內的期：若 DB 該期 `finalized_at` 非 null → 跳過；否則 upsert events 列（含 chapters）→ 抓 finals → `validateFinal` → `db.finalize`；每個 hisekai 請求之間 `sleep(1000)`。輸出每期一行 `{id, action: skipped|finalized|deferred|failed}` 與總結。
- `migrate-legacy.js`：`node scripts/migrate-legacy.js --cutover 2026-10-20T12:05:00Z [--allow-skipped N] [--yes]`。印 ref → `yes` → `rpc('sekai_border_exec_migration', { p_cutover, p_allow_skipped })` → 印報告 JSON。
- 遷移函式回傳 `{inserted, skipped_invalid_id, skipped_partial_slot, deleted_candidate_rows, verified_slots}`，任何斷言失敗 RAISE（整體回滾）。

- [ ] **Step 1: 寫遷移函式 template**

```sql
-- supabase/migrations/0001b_exec_sql.sql.tmpl
-- One-transaction legacy copy (spec §7 step 4). Reads {{legacy_schema}}.event_rankings (legacy, text event_id) and
-- writes {{schema}}.sekai_border_rankings. Caller supplies the cutover slot recorded at traffic switch.
create or replace function {{schema}}.sekai_border_exec_migration(p_cutover timestamptz, p_allow_skipped integer default 0) returns jsonb
language plpgsql security definer set search_path = {{schema}}, {{legacy_schema}}, pg_temp as $$
declare n_del int; n_ins int; n_bad_id int; n_partial int; n_slots int; n_total int; n_mismatch int; cnt int;
begin
    if date_trunc('minute', p_cutover) <> p_cutover or extract(minute from p_cutover)::int % 5 <> 0 then raise exception 'cutover_slot must be 5-minute aligned'; end if;

    -- (1) drop candidate-run rows written before cutover
    delete from sekai_border_rankings where is_final = false and taken_at < p_cutover;
    get diagnostics n_del = row_count;

    -- (2) validated, deduplicated source set
    create temp table src on commit drop as
    with typed as (
        select (case when event_id ~ '^[0-9]+$' then event_id::int end) as event_id, rank, score, created_at,
               to_timestamp(floor(extract(epoch from created_at) / 300) * 300) as slot
        from {{legacy_schema}}.event_rankings
    ), valid as (
        select t.* from typed t join sekai_border_events e on e.id = t.event_id
    ), dedup as (
        -- several legacy rows can share a slot (old crawler timestamps were not aligned): keep the latest observation
        select event_id, rank, score, slot, row_number() over (partition by event_id, rank, slot order by created_at desc) as rn
        from valid
    ), per_slot as (
        select event_id, slot, count(*) as n from dedup where rn = 1 group by event_id, slot
    )
    select d.event_id, d.rank, d.score, d.slot
    from dedup d join per_slot p on p.event_id = d.event_id and p.slot = d.slot
    where d.rn = 1 and d.slot < p_cutover and p.n = 30;

    select count(*) into n_total from {{legacy_schema}}.event_rankings;
    select count(*) into n_bad_id from {{legacy_schema}}.event_rankings where not (event_id ~ '^[0-9]+$') or not exists (select 1 from sekai_border_events e where e.id = event_id::int);
    select count(*) into n_slots from (select distinct event_id, slot from src) s;
    select count(*) into n_partial from (
        select event_id, slot from (select (case when event_id ~ '^[0-9]+$' then event_id::int end) as event_id, rank, to_timestamp(floor(extract(epoch from created_at)/300)*300) as slot from {{legacy_schema}}.event_rankings) q
        where event_id is not null and slot < p_cutover group by event_id, slot having count(distinct rank) <> 30
    ) ps;
    if (select count(*) from src) = 0 then raise exception 'validated source set is empty'; end if;

    -- (3) copy
    insert into sekai_border_rankings (event_id, chapter, rank, score, taken_at, is_final)
    select event_id, 0, rank, score, slot, false from src
    on conflict (event_id, chapter, rank, taken_at, is_final) do nothing;
    get diagnostics n_ins = row_count;

    -- (4) fail-closed checks
    select count(*) into cnt from sekai_border_rankings where is_final = false and chapter = 0 and taken_at = p_cutover;
    if cnt <> 30 then raise exception 'cutover slot must hold exactly 30 live rows, found %', cnt; end if;
    select count(*) into n_mismatch from src s left join sekai_border_rankings r on r.event_id = s.event_id and r.chapter = 0 and r.rank = s.rank and r.taken_at = s.slot and r.is_final = false
        where r.score is distinct from s.score;
    if n_mismatch <> 0 then raise exception 'source/destination mismatch on % rows', n_mismatch; end if;
    if (n_bad_id + n_partial * 30) > greatest(p_allow_skipped, n_total / 100) then raise exception 'skipped % rows exceeds allowance', n_bad_id + n_partial * 30; end if;

    return jsonb_build_object('inserted', n_ins, 'deleted_candidate_rows', n_del, 'skipped_invalid_id', n_bad_id, 'skipped_partial_slots', n_partial, 'verified_slots', n_slots);
end $$;
revoke all on function {{schema}}.sekai_border_exec_migration(timestamptz, integer) from public;
grant execute on function {{schema}}.sekai_border_exec_migration(timestamptz, integer) to service_role;
```

`{{legacy_schema}}` 在 public 渲染為 `public`，在 test 渲染為 `test`（test schema 有一張同結構的 `test.event_rankings` 給測試用，見 Step 3）。

- [ ] **Step 2: 渲染並套到 `test` schema**

```bash
cd /home/cholate/sekai-border && node scripts/render-sql.js supabase/migrations/0001b_exec_sql.sql.tmpl test test > /tmp/0001b_test.sql && grep -c "{{" /tmp/0001b_test.sql
```

Expected: `0`；以 MCP `apply_migration`（name `0001b_exec_migration_test`）套用成功。

- [ ] **Step 3: 寫整合測試（先跑、看它因為函式尚未滿足斷言或 fixture 而失敗）**

```js
// test/integration/migrate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, truncate, insertEvent } from './helpers.js';
import { ALLOWED_RANKS } from '../../src/constants.js';

// Legacy table lives in public; tests write to a scratch copy test.event_rankings_legacy via the admin client
// using the `public` schema name? No: PostgREST is per-schema. We use a tiny helper RPC instead:
const legacy = (rows) => admin.rpc('sekai_border_test_seed_legacy', { p_rows: rows });
const run = (cutover, allow = 0) => admin.rpc('sekai_border_exec_migration', { p_cutover: cutover, p_allow_skipped: allow });
const rows = (eventId, createdAt, base = 1000, ranks = ALLOWED_RANKS) => ranks.map((rank, i) => ({ event_id: String(eventId), rank, score: base - i, created_at: createdAt }));
const live = (takenAt, base = 5000) => ALLOWED_RANKS.map((rank, i) => ({ event_id: 182, chapter: 0, rank, score: base - i, taken_at: takenAt, is_final: false }));

test.beforeEach(async () => { await truncate(); await admin.rpc('sekai_border_test_clear_legacy', {}); });

test('happy path: dedup keeps latest, partial slot dropped, candidate rows deleted, cutover slot owned by new table', async () => {
    await insertEvent();
    await legacy([...rows(182, '2026-10-20T11:50:10Z'), ...rows(182, '2026-10-20T11:50:40Z', 1100), ...rows(182, '2026-10-20T11:55:05Z', 1200), ...rows(182, '2026-10-20T12:00:03Z', 1300, ALLOWED_RANKS.slice(0, 29)), ...rows(182, '2026-10-20T12:05:02Z', 1400), { event_id: 'unknown_event', rank: 1, score: 1, created_at: '2026-10-20T11:55:05Z' }]);
    await admin.from('sekai_border_rankings').insert([...live('2026-10-20T11:45:00Z', 1), ...live('2026-10-20T12:05:00Z')]);
    const r = await run('2026-10-20T12:05:00Z', 100);
    assert.equal(r.error, null, r.error?.message);
    assert.equal(r.data.deleted_candidate_rows, 30);
    assert.equal(r.data.inserted, 60);
    assert.equal(r.data.skipped_invalid_id, 1);
    assert.equal(r.data.skipped_partial_slots, 1);
    const { data } = await admin.from('sekai_border_rankings').select('taken_at,score').eq('rank', 1).order('taken_at');
    assert.deepEqual(data.map((d) => [new Date(d.taken_at).toISOString(), d.score]), [['2026-10-20T11:50:00.000Z', 1100], ['2026-10-20T11:55:00.000Z', 1200], ['2026-10-20T12:05:00.000Z', 5000]]);
});

test('rolls back when the cutover slot does not hold 30 live rows', async () => {
    await insertEvent();
    await legacy(rows(182, '2026-10-20T11:50:10Z'));
    const r = await run('2026-10-20T12:05:00Z');
    assert.match(r.error.message, /cutover slot/);
    const { count } = await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true });
    assert.equal(count, 0);
});

test('rolls back when everything is invalid, and when skipped exceeds allowance without --allow-skipped', async () => {
    await insertEvent();
    await admin.from('sekai_border_rankings').insert(live('2026-10-20T12:05:00Z'));
    await legacy([{ event_id: 'unknown_event', rank: 1, score: 1, created_at: '2026-10-20T11:55:05Z' }]);
    let r = await run('2026-10-20T12:05:00Z');
    assert.match(r.error.message, /empty/);
    await admin.rpc('sekai_border_test_clear_legacy', {});
    await legacy([...rows(182, '2026-10-20T11:50:10Z'), ...Array.from({ length: 5 }, (_, i) => ({ event_id: 'bad' + i, rank: 1, score: 1, created_at: '2026-10-20T11:55:05Z' }))]);
    r = await run('2026-10-20T12:05:00Z');
    assert.match(r.error.message, /exceeds allowance/);
    r = await run('2026-10-20T12:05:00Z', 5);
    assert.equal(r.error, null);
});

test('rejects a non-aligned cutover', async () => {
    const r = await run('2026-10-20T12:03:00Z');
    assert.match(r.error.message, /aligned/);
});
```

兩個測試用 RPC（只在 `test` schema 建，**不進 public**）：

```sql
-- supabase/migrations/test_only_legacy_helpers.sql（只套到 test；public 的遷移直接讀 public.event_rankings）
create table if not exists test.event_rankings (id bigserial primary key, created_at timestamptz default now(), rank int, score bigint, event_id text);
create or replace function test.sekai_border_test_seed_legacy(p_rows jsonb) returns void language sql security definer set search_path = test as $$
    insert into test.event_rankings (event_id, rank, score, created_at) select r->>'event_id', (r->>'rank')::int, (r->>'score')::bigint, (r->>'created_at')::timestamptz from jsonb_array_elements(p_rows) r; $$;
create or replace function test.sekai_border_test_clear_legacy() returns void language sql security definer set search_path = test as $$ delete from test.event_rankings; $$;
```

先套 `test_only_legacy_helpers.sql` 到 test schema（MCP `apply_migration`），再跑。

Run: `cd /home/cholate/sekai-border && npm run test:integration 2>&1 | grep -E "ℹ (pass|fail)|not ok"`
Expected：`fail 0`。RED 證據：在套 `0001b` 之前先跑一次，`sekai_border_exec_migration` 不存在 → 4 個測試全 FAIL（`function ... does not exist`）；套用後全 PASS。

- [ ] **Step 4: 寫 backfill 與 migrate-legacy 腳本（含 confirm）**

```js
// scripts/confirm.js
import { createInterface } from 'node:readline/promises';
export async function confirmTarget({ url, schema, argv }) {
    const ref = new URL(url).hostname.split('.')[0];
    console.log(`target supabase ref=${ref} schema=${schema}`);
    if (argv.includes('--yes')) return;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question('type yes to continue: '); rl.close();
    if (a.trim() !== 'yes') { console.log('aborted'); process.exit(1); }
}
```

```js
// scripts/backfill.js
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../src/env.js';
import { makeDb } from '../src/db.js';
import { makeUpstream } from '../src/fetch.js';
import { validateFinal } from '../src/validate.js';
import { ANNOUNCE_GRACE_MS } from '../src/constants.js';
import { confirmTarget } from './confirm.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function backfill({ db, upstream, now = new Date(), from = 1, to = 999999, interval = 1000, log = console.log }) {
    const list = await upstream.eventList();
    const done = [];
    for (const e of list.filter((x) => x.id >= from && x.id <= to && new Date(x.ranking_announce_at).getTime() + ANNOUNCE_GRACE_MS < now.getTime()).sort((a, b) => a.id - b.id)) {
        const known = await db.loadKnown(e.id);
        if (known?.finalized_at) { done.push({ id: e.id, action: 'skipped' }); continue; }
        const chapters = (e.chapters ?? []).map((c) => ({ chapter: c.chapter, chapter_id: c.id, character_id: c.character, start_at: c.start_at, aggregate_at: c.aggregate_at, ranking_announce_at: c.ranking_announce_at }));
        if (!known) await db.insertEvent({ id: e.id, name: e.name, start_at: e.start_at, aggregate_at: e.aggregate_at, ranking_announce_at: e.ranking_announce_at, chapters, metadata_status: 'pending' });
        try {
            await sleep(interval);
            const { border, top100 } = await upstream.finals(e.id);
            const { rows, deferred } = validateFinal(e.id, border, top100, chapters);
            if (deferred) { done.push({ id: e.id, action: 'deferred' }); continue; }
            await db.finalize(e.id, rows);
            done.push({ id: e.id, action: 'finalized' });
        } catch (err) { done.push({ id: e.id, action: 'failed', reason: `${err.phase ?? 'db'}:${err.code ?? err.message}` }); }
        log(JSON.stringify(done[done.length - 1]));
    }
    return done;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const env = loadEnv();
    await confirmTarget({ url: env.url, schema: env.schema, argv: process.argv });
    const db = makeDb(createClient(env.url, env.key, { db: { schema: env.schema } }));
    const res = await backfill({ db, upstream: makeUpstream({ userAgent: env.botContact }), from: arg('--from', 1), to: arg('--to', 999999) });
    const summary = res.reduce((m, r) => ((m[r.action] = (m[r.action] || 0) + 1), m), {});
    console.log(JSON.stringify({ summary }));
    process.exit(summary.failed ? 1 : 0);
}
```

```js
// scripts/migrate-legacy.js
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../src/env.js';
import { confirmTarget } from './confirm.js';

const i = process.argv.indexOf('--cutover');
if (i < 0) { console.error('usage: migrate-legacy.js --cutover <ISO 5-minute slot> [--allow-skipped N] [--yes]'); process.exit(2); }
const cutover = process.argv[i + 1];
const j = process.argv.indexOf('--allow-skipped');
const allow = j >= 0 ? Number(process.argv[j + 1]) : 0;
const env = loadEnv();
await confirmTarget({ url: env.url, schema: env.schema, argv: process.argv });
const client = createClient(env.url, env.key, { db: { schema: env.schema } });
const { data, error } = await client.rpc('sekai_border_exec_migration', { p_cutover: cutover, p_allow_skipped: allow });
if (error) { console.error(JSON.stringify({ migrated: false, error: error.message })); process.exit(1); }
console.log(JSON.stringify({ migrated: true, ...data }));
```

- [ ] **Step 5: backfill 單元測試（fake）**

```js
// test/backfill.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backfill } from '../scripts/backfill.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
const mk = (events = []) => {
    const s = { events: [...events], finalized: [], calls: [] };
    const db = { loadKnown: async (id) => s.events.find((e) => e.id === id) ?? null, insertEvent: async (r) => s.events.push({ ...r, finalized_at: null }), finalize: async (id) => { s.finalized.push(id); s.events.find((e) => e.id === id).finalized_at = new Date(); } };
    const upstream = { eventList: async () => fx('event-list'), finals: async (id) => { s.calls.push(Date.now()); if (id === 180) throw Object.assign(new Error('x'), { phase: 'fetch', code: 'http_500' }); if (id === 179) return { border: fx('final-border-179'), top100: fx('final-top100-179') }; const b = fx('final-border-181'); return { border: { ...b, eventId: id }, top100: fx('final-top100-181') }; } };
    return { db, upstream, s };
};

test('processes only ended events in range, skips finalized, finalizes the rest, keeps >= interval between hisekai calls', async () => {
    const { db, upstream, s } = mk([{ id: 181, finalized_at: new Date() }]);
    const res = await backfill({ db, upstream, now: new Date('2026-10-16T00:00:00Z'), from: 178, to: 182, interval: 20, log: () => {} });
    assert.deepEqual(res.map((r) => [r.id, r.action]), [[178, 'finalized'], [179, 'finalized'], [180, 'failed'], [181, 'skipped']]);
    for (let i = 1; i < s.calls.length; i++) assert.ok(s.calls[i] - s.calls[i - 1] >= 19);
});

test('resume: event row exists without finals -> finalized on rerun, not duplicated', async () => {
    const { db, upstream, s } = mk([{ id: 178, finalized_at: null }]);
    await backfill({ db, upstream, now: new Date('2026-10-16T00:00:00Z'), from: 178, to: 178, interval: 1, log: () => {} });
    assert.deepEqual(s.finalized, [178]);
    assert.equal(s.events.filter((e) => e.id === 178).length, 1);
});
```

Run: `cd /home/cholate/sekai-border && npm test 2>&1 | grep -E "ℹ (pass|fail)|not ok"`
Expected: `fail 0`。（179 是 WL，fake 回它的真實 fixture；event-list fixture 中 179 的章節 `character` 必須與 fixture 的 `gameCharacterId` 一致，否則 `wl_chapters` → `failed`，那代表 fixture 不一致而不是程式錯。）

- [ ] **Step 6: 對 test schema 實跑回填（3 期，含一期 WL）**

```bash
cd /home/cholate/sekai-border && set -a && . ./.env && set +a && SUPABASE_SCHEMA=test node scripts/backfill.js --from 179 --to 181 --yes; echo "exit=$?"
```

Expected: 三行 `{id:179, action:'finalized'}`、`{180,...}`、`{181, 'finalized'}`（180 若 hisekai 有資料亦 finalized），summary 無 failed；用 SQL 查 test schema：`select event_id, chapter, count(*) from test.sekai_border_rankings where is_final group by 1,2 order by 1,2` → 179 有 chapter 0..6 各 30 列，180/181 各 chapter 0 30 列。中斷測試：對 182 以外的某期先手動 `update test.sekai_border_events set finalized_at = null` 並刪其 finals，再重跑 → 該期 `finalized`、其他 `skipped`。

- [ ] **Step 7: Commit**

```bash
cd /home/cholate/sekai-border && git add scripts supabase test && git commit -m "feat: 回填腳本（續跑、1 秒間隔、ref 確認）與單一交易的舊資料遷移函式（驗證集、cutover 擁有權、fail-closed）"
```

---

### Task 7: 文件與專案設定（README、CLAUDE.md 禁區、PROJECT.toml）

**Files:**
- Rewrite: `README.md`（`POST /run`、OIDC、`SUPABASE_SERVICE_ROLE_KEY`、`--once`、`npm test` / `test:integration`、backfill / migrate 用法、WL 旗標）
- Modify: `CLAUDE.md`（Stack / File layout / constraints：禁區改為「正式憑證只能對 public；`SUPABASE_SCHEMA=test` 才能跑整合測試」「hisekai 欄位改名要同步 sekai-archive」）
- Modify: `PROJECT.toml`（`[commands]` 加 `once`、`backfill`；`status_note`）

- [ ] **Step 1: 改寫三個檔案**（內容依 spec §5 與本計畫；README 的部署段落放 Task 8 的指令區塊）
- [ ] **Step 2: 驗收**

```bash
cd /home/cholate/sekai-border && grep -c "fetch_all_rankings\|SUPABASE_KEY" README.md CLAUDE.md; grep -n "POST /run\|SUPABASE_SERVICE_ROLE_KEY\|--once\|test:integration" README.md | head
```

Expected: 第一行兩個 0；第二行四個關鍵字都出現。

- [ ] **Step 3: Commit**

```bash
cd /home/cholate/sekai-border && git add README.md CLAUDE.md PROJECT.toml && git commit -m "docs: 新架構的 README、CLAUDE.md 禁區與 PROJECT.toml 指令"
```

---

### Task 8: 正式環境 rollout（spec §7、§6；GCP 指令由 user 執行）

這個 task 沒有程式碼，是一份有 Expected 的 runbook。每步做完在 ledger 記一行。**步驟 3 的切流量必須在活動進行中（current）執行。**

- [ ] **Step 1: 套 schema 到 public（不刪任何舊物件）**

```bash
cd /home/cholate/sekai-border && node scripts/render-sql.js supabase/migrations/0001_sekai_border.sql.tmpl public > /tmp/0001_public.sql && node scripts/render-sql.js supabase/migrations/0001b_exec_sql.sql.tmpl public public > /tmp/0001b_public.sql && grep -c "{{" /tmp/0001_public.sql /tmp/0001b_public.sql
```

以 MCP `apply_migration` 套兩個檔。Expected：成功；之後 SQL 驗收：

```sql
select relname, relrowsecurity from pg_class where relname in ('sekai_border_events','sekai_border_rankings');                      -- both true
select tablename, policyname, cmd, roles from pg_policies where tablename like 'sekai_border_%';                                     -- exactly 2 rows, cmd SELECT, {anon,authenticated}
select r, t, p, has_table_privilege(r, 'public.'||t, p) from (values ('anon'),('authenticated')) a(r), (values ('sekai_border_events'),('sekai_border_rankings'),('sekai_border_current_report'),('sekai_border_daily_report')) b(t), (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) c(p) order by 1,2,3;  -- SELECT true, all others false
select has_function_privilege('anon','public.sekai_border_finalize(integer,jsonb)','EXECUTE') a, has_function_privilege('authenticated','public.sekai_border_finalize(integer,jsonb)','EXECUTE') b, has_function_privilege('service_role','public.sekai_border_finalize(integer,jsonb)','EXECUTE') c;  -- false false true
select grantee from aclexplode((select proacl from pg_proc where proname='sekai_border_finalize')) where grantee = 0;           -- 0 rows (no PUBLIC)
select c.relname, (select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker') from pg_class c where relname in ('sekai_border_current_report','sekai_border_daily_report');  -- on, on
```

- [ ] **Step 2: 部署候選版本（user）**

```bash
cd /home/cholate/sekai-border && docker build -t sekai-border-test . && gcloud run deploy sekai-border --source . --region asia-east1 --project sekai-archive --no-traffic --tag candidate \
  --set-secrets SUPABASE_SERVICE_ROLE_KEY=sekai-border-service-role:latest --set-env-vars SUPABASE_URL=https://bwhhtfcyagqhcddzssas.supabase.co,BOT_CONTACT=<你的聯絡>,WL_INGEST=off
```

（先在 Secret Manager 建 `sekai-border-service-role`，值為 service role key，並把 Cloud Run 的 runtime SA 加 `roles/secretmanager.secretAccessor`。）Expected：部署成功，印出候選 URL。

- [ ] **Step 3: IAM 與 Scheduler（user）**

```bash
gcloud iam service-accounts create sekai-border-scheduler --project sekai-archive
gcloud run services add-iam-policy-binding sekai-border --region asia-east1 --project sekai-archive --member serviceAccount:sekai-border-scheduler@sekai-archive.iam.gserviceaccount.com --role roles/run.invoker
gcloud run services update sekai-border --region asia-east1 --project sekai-archive --no-allow-unauthenticated
gcloud run services get-iam-policy sekai-border --region asia-east1 --project sekai-archive        # Expected: only the scheduler SA has run.invoker; no allUsers
SERVICE_URL=$(gcloud run services describe sekai-border --region asia-east1 --project sekai-archive --format 'value(status.url)')
gcloud scheduler jobs update http sekai-border --location asia-east1 --project sekai-archive --uri "$SERVICE_URL/run" --http-method POST \
  --oidc-service-account-email sekai-border-scheduler@sekai-archive.iam.gserviceaccount.com --oidc-token-audience "$SERVICE_URL"
gcloud scheduler jobs describe sekai-border --location asia-east1 --project sekai-archive | grep -A3 oidcToken   # Expected: SA email + audience
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$SERVICE_URL/run"                                               # Expected: 403
```

然後用 SA token 打候選版本一次：

```bash
TOKEN=$(gcloud auth print-identity-token --impersonate-service-account sekai-border-scheduler@sekai-archive.iam.gserviceaccount.com --audiences "$SERVICE_URL")
CANDIDATE_URL=$(gcloud run services describe sekai-border --region asia-east1 --project sekai-archive --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.status.traffic.find(t=>t.tag==="candidate")||{}).url||"")})')
echo "candidate: $CANDIDATE_URL"   # Expected: https://candidate---sekai-border-....a.run.app
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$CANDIDATE_URL/run"
```

Expected：JSON body，`branch` 與 `inserted` 符合當下時間（current → 30）；`public.sekai_border_events` 有一列。

- [ ] **Step 4: 切流量（user；活動進行中）**

```bash
gcloud scheduler jobs pause sekai-border --location asia-east1 --project sekai-archive
# wait until the next 5-minute boundary passes (e.g. now 12:03 -> wait until 12:05:10)
gcloud run services update-traffic sekai-border --to-latest --region asia-east1 --project sekai-archive
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$SERVICE_URL/run" | tee /tmp/cutover.json
gcloud scheduler jobs resume sekai-border --location asia-east1 --project sekai-archive
```

Expected：`/tmp/cutover.json` 的 `branch: "current"`、`inserted: 30`；記下 `slot` 為 `CUTOVER_SLOT`。若不是 current：resume、`update-traffic --to-revisions <old>=100`，等活動進行中再做。

- [ ] **Step 5: 搬舊資料（我，用 user 提供的 .env）**

```bash
cd /home/cholate/sekai-border && set -a && . ./.env && set +a && SUPABASE_SCHEMA=public node scripts/migrate-legacy.js --cutover "$CUTOVER_SLOT"
```

Expected：`{migrated: true, inserted: N, deleted_candidate_rows: 30, skipped_invalid_id: 0, skipped_partial_slots: ≤ 2, verified_slots: ≈ N/30}`。

- [ ] **Step 6: 切 view 與網站（sekai-archive）**

```bash
cd /home/cholate/sekai-archive && sed -i "s/from('view_all_ranking_report')/from('sekai_border_current_report')/; s/from('view_day_ranking_report')/from('sekai_border_daily_report')/" context/RankContext.js && grep -n "sekai_border_" context/RankContext.js && npm run smoke && git add context/RankContext.js && git commit -m "feat: 排行頁改讀 sekai_border_* 相容 view" && git push origin main
```

切換前比對（SQL，對同一時刻）：`select * from view_all_ranking_report` 與 `select * from sekai_border_current_report` 以 rank 為鍵逐列比對 `current_score` 等欄位相等；`view_day_ranking_report` 同。Expected：零差異（除非新快照在比對期間落入）。部署後正式站排行頁有 10 列、banner 正常（用 Task 2 子專案的 Playwright 檢查）。同一步 commit README（Task 7 已寫）。

- [ ] **Step 7: 回填歷史（我；深夜）**

```bash
cd /home/cholate/sekai-border && set -a && . ./.env && set +a && SUPABASE_SCHEMA=public node scripts/backfill.js
```

Expected：summary `finalized` ≈ 180、`failed` 0（有的話逐期列出）、耗時約 6 分鐘。SQL 驗收：`select count(*) from sekai_border_events` = 已結束期數 + 1（當期）；`select event_id, count(*) from sekai_border_rankings where is_final and chapter = 0 group by 1 having count(*) <> 30` → 0 列；WL 期章節列數 = 章節數 × 30；`metadata_status` 分布列出 `missing` / `mismatch` 供人工確認。

- [ ] **Step 8: 拆網站端 RAG（sekai-archive）**

```bash
cd /home/cholate/sekai-archive && git rm -q lib/tools/definitions/knowledge.js lib/tools/implementations/knowledge.js && grep -n "knowledge\|search_knowledge_base" lib/tools/registry.js lib/prompts/system.js hooks/*.js components/*.js | cut -c1-120
```

依 grep 結果移除 registry 項、system prompt 第 7 條中「知識庫」相關句、`useLLM.js` 的 `allowed_tools: ['search_knowledge_base']`（改為 `[]`）、`useStatelessLLM.js` 的 toolMap 項。`npm run lint && npm run smoke` 綠後 commit、push。Expected：`npm ls openai` 仍在（chat 用）、`grep -rn knowledge lib app hooks components` 零命中。

- [ ] **Step 9: 觀察期**（至少跨過一次活動更替，約 10 天）：每天看一次 Scheduler 執行紀錄（全 200）與 `select branch, count(*)`（從 Cloud Logging 的 `round` log 統計）；更替後確認 `finalized_at` 已寫、`sekai_border_rankings` 該期非整點列已刪、`is_final` 30 列。

- [ ] **Step 10: 拆舊（觀察期後）**

```sql
drop view if exists public.view_all_ranking_report; drop view if exists public.view_day_ranking_report;
drop table if exists public.event_rankings;
drop function if exists public.match_documents(vector, double precision, integer);
drop table if exists public.documents;
drop extension if exists vector;
```

Expected：`get_advisors(security)` 零 finding；`list_tables` 只剩 `sekai_border_events`、`sekai_border_rankings`、`ai_inferences`；`gcloud run revisions delete <old>`。然後更新兩個 repo 的 PROJECT.toml。

---

## 執行模型建議（kit-workflow 要求）

| Phase | 建議主模型 / effort | 理由 | 升級觸發 |
|---|---|---|---|
| Task 0–2（骨架、驗證、狀態機） | Opus 5.5 / medium | 規格與測試碼已在計畫裡，純轉寫 | 任何 fixture 與 spec 形狀不符 |
| Task 3、6（SQL 交易函式、遷移） | Fable 5.1 / high | plpgsql 與交易語意是整個子專案最容易錯的地方 | 整合測試出現非預期 rollback |
| Task 4、5（副作用層、伺服器） | Opus 5.5 / medium | 介面在計畫裡凍結 | 整合測試與單元測試結論不一致 |
| Task 8（rollout） | Fable 5.1 / high | 不可逆操作與正式資料 | 任何一步 Expected 不符 → 停 |
