# 資料層重構 Implementation Plan（子專案 1 / 4）— v10

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 sekai-border 重構成保留歷史、可測試、權限最小化的爬蟲，Supabase 收斂成兩張表兩個 view，並回填所有已結束活動的最終榜線與屬性。

**Architecture:** 純函式層（驗證、狀態機）與副作用層（上游抓取、DB）分離；所有寫入由 Cloud Run 上的 sekai-border 獨占；結算與舊資料遷移各在單一 Postgres 交易內完成；舊爬蟲、舊表、舊 view 在觀察期內保留為回滾點，回滾 runbook 可貼即跑。

**Tech Stack:** Node 22（ESM，`node --test`）、@supabase/supabase-js 2.118.0（明確釘版）、dotenv、Supabase Postgres 17、Cloud Run + Cloud Scheduler（OIDC）。

**Spec:** `docs/superpowers/specs/2026-10-16-data-layer-design.md`（v9）。衝突時以 spec 為準。

## Global Constraints

- Node `>=22`；package.json `"type": "module"`，全部檔案 ESM；`@supabase/supabase-js` 釘 `2.118.0`。
- 程式碼註解一律英文；commit message 中文。
- 快照 `taken_at = floor(now, 5 min)`，寫入 `ON CONFLICT DO NOTHING`；回報的 `inserted` 必須是**該次語句實際插入的列數**（spec §3.2）。
- 允許名次集合（主榜與章節相同，共 30）：`1..10, 20,30,40,50,60,70,80,90,100, 200,300,400,500,1000,1500,2000,2500,3000,5000,10000`。最終榜線兩個目標集：top 目標集 = 前 19 個（含 100），border 目標集 = 後 11 個（不含 100）（spec §4.3）。即時快照必須 30 個齊全；最終榜每個榜（主榜、每個章節）必備 28 個（`FINAL_OPTIONAL` = {1500, 2500} 上游有才存：WL 章節與約第 110 期以前的主榜沒有這兩條線）。
- 結算門檻只看時間：`finalized_at IS NULL AND now >= ranking_announce_at + 15 min`。上游 `isEventAggregate`、`isWorldBloomChapterAggregate` 對所有活動都回 false（2026-10-16 實測），不得作為條件；最終回應的名次陣列為空 → deferred。
- 任何 log 與 fixture 不得含上游回應中的玩家欄位（`name` 僅在玩家物件內要移除；活動名稱必須保留）（spec §5.3）。
- 環境變數：`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`（啟動時驗 JWT `role === 'service_role'`）、`BOT_CONTACT`、`WL_INGEST`（預設 off）、`SUPABASE_SCHEMA`（預設 public；整合測試設 `test`）。
- 上游**每一個 HTTP 請求**之間在回填時至少 1 秒；常態不重試；10 秒逾時涵蓋到 body 解析完成（spec §4.1、S8、S9a）。
- 整合測試只認 `SUPABASE_SCHEMA=test`，`SUPABASE_ANON_KEY` 必填，且以 `--test-concurrency=1` 序列執行（三個檔案共用同一個 schema）。
- GCP 指令由 user 執行；每個區塊附 Expected。
- 每個 task 結束前：`npm test` 綠、對應的 `npm run test:integration` 綠、commit。

## Review Focus

1. **上游在同一輪回了兩個不同活動的 id**：整輪不寫、500、`phase: validate`。測試 Task 1 / Task 4。
2. **Scheduler 在同一個 5 分鐘 slot 內並行觸發兩次**：兩次合計 `inserted` = 30。測試 Task 4（整合，`Promise.all`）。
3. **最終榜公布延遲超過一輪**：`due` 分支每輪 `finalize_deferred`、200。測試 Task 4。
4. **回填中斷在「events 已寫、finals 未寫」**：重跑補齊、不重複。測試 Task 6。
5. **遷移時 `cutover_slot` 這個 slot 在舊表也有列**：舊列排除、新表 30 列保留；且只動指定的活動。測試 Task 6。

---

### Task 0: 專案骨架、釘版、fixture 錄製（路徑感知去個資）

**Files:**
- Modify: `package.json`、`.gitignore`、`Dockerfile`（CMD 暫指 index.cjs）
- Rename: `index.js → index.cjs`、`fetch_all_rankings.js → fetch_all_rankings.cjs`（舊爬蟲在 Task 5 前維持可跑）
- Create: `.dockerignore`、`scripts/record-fixtures.js`、`test/fixtures/README.md`、`test/fixtures/*.json`、`test/fixtures.test.js`

**Interfaces:**
- Produces：`npm test`、`npm run test:integration`、`npm run record-fixtures`；fixture：`live-top100`、`live-border`、`event-list`、`final-border-181`、`final-top100-181`、`final-border-179`、`final-top100-179`、`master-events`（id ≤ 202）、`master-eventCards`（eventId ≤ 202）、`master-cards`（只含被 eventCards 引用的卡）。

- [ ] **Step 1: package.json、釘版、舊檔改名為 .cjs、.dockerignore**

```bash
cd /home/cholate/sekai-border && git mv index.js index.cjs && git mv fetch_all_rankings.js fetch_all_rankings.cjs && node - <<'JS'
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.type = 'module'; p.main = 'index.js'; p.engines = { node: '>=22' };
// Legacy entrypoint stays runnable as CommonJS (.cjs) until Task 5 replaces it with the ESM index.js.
p.scripts = { start: 'node index.cjs', once: 'node index.js --once', test: 'node --test test/*.test.js', 'test:integration': 'node --test --test-concurrency=1 test/integration/*.test.js', 'record-fixtures': 'node scripts/record-fixtures.js' };
delete p.dependencies['@google-cloud/functions-framework'];
p.dependencies['@supabase/supabase-js'] = '2.118.0';
p.dependencies['dotenv'] = '^17.2.0';
fs.writeFileSync('package.json', JSON.stringify(p, null, 4) + '\n');
JS
sed -i 's/CMD \[ *"node", *"index.js" *\]/CMD ["node", "index.cjs"]/' Dockerfile && grep -n "CMD" Dockerfile
printf '.env\n.env.*\n.git\n.superpowers\nnode_modules\ntest\nscripts/smoke\n' > .dockerignore
npm install --no-audit --no-fund 2>&1 | tail -1 && node -e "console.log('supabase-js', require('./package-lock.json').packages['node_modules/@supabase/supabase-js'].version)" && printf '.superpowers/\n' >> .gitignore && grep -n '"type"\|"start"\|"engines"\|supabase-js' package.json
```

Expected: `supabase-js 2.118.0`；Dockerfile `CMD ["node", "index.cjs"]`（Task 5 改回 `index.js`）；package.json 顯示 `"type": "module"`、`"start": "node index.cjs"`。`npm start` 仍可啟動舊爬蟲（Task 5 之前正式部署若需重建仍可用）。

- [ ] **Step 2: 路徑感知的 fixture 錄製腳本**

```js
// scripts/record-fixtures.js
// Records upstream responses for unit tests. Player-identifying fields are stripped ONLY inside player-ranking
// arrays; event-level fields (event name, chapter data) are preserved (spec §1 non-goals, §5.3).
import { writeFile, mkdir } from 'node:fs/promises';

const OUT = new URL('../test/fixtures/', import.meta.url);
const UA = process.env.BOT_CONTACT || 'sekai-border-fixture-recorder';
const PLAYER_ARRAYS = /^(player_top_100_rankings|player_border_rankings|world_link_top_100_rankings|world_link_border_rankings|rankings|borderRankings)$/;
const PLAYER_KEEP = new Set(['rank', 'score']);

function strip(value, inPlayers = false) {
    if (Array.isArray(value)) return value.map((v) => strip(v, inPlayers));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .filter(([k]) => !inPlayers || PLAYER_KEEP.has(k))
            .map(([k, v]) => [k, strip(v, inPlayers || PLAYER_ARRAYS.test(k))]));
    }
    return value;
}

async function get(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_EVENT_ID = 202;

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
    await writeFile(new URL(file, OUT), JSON.stringify(strip(await get(url)), null, 1));
    console.log('recorded', file);
    await sleep(1000);
}
const MASTER = 'https://raw.githubusercontent.com/Sekai-World/sekai-master-db-tc-diff/main/';
const events = (await get(MASTER + 'events.json')).filter((e) => e.id <= MAX_EVENT_ID).map(({ id, eventType, name, unit, startAt, aggregateAt }) => ({ id, eventType, name, unit, startAt, aggregateAt }));
await writeFile(new URL('master-events.json', OUT), JSON.stringify(events));
const eventCards = (await get(MASTER + 'eventCards.json')).filter((c) => c.eventId <= MAX_EVENT_ID).map(({ eventId, cardId }) => ({ eventId, cardId }));
await writeFile(new URL('master-eventCards.json', OUT), JSON.stringify(eventCards));
const needed = new Set(eventCards.map((c) => c.cardId));
const cards = (await get(MASTER + 'cards.json')).filter((c) => needed.has(c.id)).map(({ id, characterId }) => ({ id, characterId }));
await writeFile(new URL('master-cards.json', OUT), JSON.stringify(cards));
console.log('recorded master data', { events: events.length, eventCards: eventCards.length, cards: cards.length });
```

- [ ] **Step 3: 執行並驗證：玩家欄位全無、活動名稱保留**

```bash
cd /home/cholate/sekai-border && npm run record-fixtures && node -e "
const fs=require('fs');const dir='test/fixtures/';let bad=0;
for (const f of fs.readdirSync(dir).filter(x=>x.endsWith('.json'))) { const s=fs.readFileSync(dir+f,'utf8'); if (/\"userId\"|\"userCard\"|\"userProfile\"/.test(s)) { console.log('PII in', f); bad++; } }
const live=JSON.parse(fs.readFileSync(dir+'live-top100.json'));console.log('live event name:', JSON.stringify(live.name), '| player keys:', Object.keys(live.player_top_100_rankings[0]).join(','));
const list=JSON.parse(fs.readFileSync(dir+'event-list.json'));console.log('list names kept:', list.every(e=>typeof e.name==='string'&&e.name.length>0));
const b179=JSON.parse(fs.readFileSync(dir+'final-border-179.json'));console.log('179 chapters:', b179.userWorldBloomChapterRankingBorders.map(c=>c.gameCharacterId).join(','), '| chapter item keys:', Object.keys(b179.userWorldBloomChapterRankingBorders[0].borderRankings[0]).join(','));
const l179=list.find(e=>e.id===179);console.log('list 179 chapter characters:', l179.chapters.map(c=>c.character).join(','));
process.exit(bad)"
```

Expected: 無 `PII in` 行；`live event name: "與你相繫的Heart Beat"`；`player keys: rank,score`；`list names kept: true`；179 的章節角色兩邊集合相同（順序可不同；若不同，Task 6 的 WL 回填測試會失敗，這是資料不一致的訊號）。

- [ ] **Step 4: fixture 不變量測試、README、commit**

```js
// test/fixtures.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
const dir = new URL('./fixtures/', import.meta.url);
const fx = (n) => JSON.parse(readFileSync(new URL(n + '.json', dir), 'utf8'));
test('no player-identifying fields in any fixture', () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) assert.doesNotMatch(readFileSync(new URL(f, dir), 'utf8'), /"userId"|"userCard"|"userProfile"/, f);
});
test('event-level names and WL chapter data are preserved', () => {
    assert.ok(fx('live-top100').name.length > 0);
    assert.deepEqual(Object.keys(fx('live-top100').player_top_100_rankings[0]).sort(), ['rank', 'score']);
    assert.ok(fx('event-list').every((e) => typeof e.name === 'string' && e.name.length > 0));
    const chars179 = fx('final-border-179').userWorldBloomChapterRankingBorders.map((c) => c.gameCharacterId).sort();
    assert.deepEqual(fx('event-list').find((e) => e.id === 179).chapters.map((c) => c.character).sort(), chars179);
});
```

```bash
cd /home/cholate/sekai-border && cat > test/fixtures/README.md <<'MD'
# Fixtures

Recorded with `npm run record-fixtures` (2026-10-16) from api.hisekai.org and Sekai-World TC master db.
Player objects keep only `rank` and `score`; event-level names and chapter data are preserved. Event 181 is a
finished marathon; 179 is a finished World Link event with 6 chapters. Do not hand-edit; re-record.
MD
npm test 2>&1 | grep -E "ℹ (pass|fail)|not ok"
git add package.json package-lock.json .gitignore .dockerignore Dockerfile index.cjs fetch_all_rankings.cjs scripts/record-fixtures.js test && git commit -m "chore: ESM 骨架（舊入口暫改 .cjs）、supabase-js 釘 2.118.0、.dockerignore、路徑感知去個資 fixture 與不變量測試"
```

Expected: `pass 2`、`fail 0`（179 的章節角色若兩邊不一致，第二個測試會在這裡就失敗，而不是等到 Task 6）。

---

### Task 1: `src/validate.js` — 名次集合、形狀、一致性、WL 雙射（spec §4.1、§4.3、§5.3）

**Files:**
- Create: `src/log.js`、`src/constants.js`、`src/errors.js`、`src/validate.js`
- Test: `test/validate.test.js`

**Interfaces（後續 task 依此呼叫）:**
- `constants.js`：`ALLOWED_RANKS`（30）、`TOP_TARGET`（Set，19）、`BORDER_TARGET`（Set，11）、`FINAL_OPTIONAL`（Set {1500, 2500}，最終榜可缺）、`SLOT_MS`、`ANNOUNCE_GRACE_MS`。
- `errors.js`：`UpstreamError(phase, code, detail)`、`DbError(phase, message)`。
- `validate.js`：`validateLive(top100, border, { wlIngest }) → { event, rows }`；`validateFinal(id, border, top100, chapters) → { rows, deferred }`；`validateEventListEntry(list, id, live) → entry`；`safeDetail(payload) → object`。

- [ ] **Step 1: 寫失敗的測試**

```js
// test/validate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateLive, validateFinal, validateEventListEntry, safeDetail } from '../src/validate.js';
import { ALLOWED_RANKS, TOP_TARGET, BORDER_TARGET, FINAL_OPTIONAL } from '../src/constants.js';
import { UpstreamError } from '../src/errors.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const chaptersFor = (border, startAt = '2026-09-06T12:00:00Z') => border.userWorldBloomChapterRankingBorders.map((c, i) => ({ chapter: i + 1, chapter_id: 17900 + i + 1, character_id: c.gameCharacterId, start_at: startAt, aggregate_at: '2026-09-08T11:59:59Z', ranking_announce_at: '2026-09-08T12:09:59Z' }));

test('constants: 30 allowed ranks, disjoint 19 + 11 final targets', () => {
    assert.equal(ALLOWED_RANKS.length, 30); assert.equal(TOP_TARGET.size, 19); assert.equal(BORDER_TARGET.size, 11);
    assert.ok(TOP_TARGET.has(100) && !BORDER_TARGET.has(100));
    assert.deepEqual([...TOP_TARGET].filter((r) => BORDER_TARGET.has(r)), []);
    assert.deepEqual([...FINAL_OPTIONAL].sort((a, b) => a - b), [1500, 2500]); assert.ok([...FINAL_OPTIONAL].every((r) => BORDER_TARGET.has(r)));
});
test('validateLive accepts recorded live responses: 30 rows, event name kept', () => {
    const { event, rows } = validateLive(fx('live-top100'), fx('live-border'), { wlIngest: false });
    assert.equal(rows.length, 30);
    assert.deepEqual(rows.map((r) => r.rank).sort((a, b) => a - b), [...ALLOWED_RANKS].sort((a, b) => a - b));
    assert.ok(rows.every((r) => r.chapter === 0 && Number.isInteger(r.score) && r.score >= 0));
    assert.equal(typeof event.id, 'number'); assert.ok(event.name.length > 0);
    assert.ok(event.aggregate_at instanceof Date && event.ranking_announce_at >= event.aggregate_at);
});
test('validateLive rejects mismatched ids / aggregate_at between the two responses', () => {
    const b = clone(fx('live-border')); b.id += 1;
    assert.throws(() => validateLive(fx('live-top100'), b, {}), (e) => e instanceof UpstreamError && e.phase === 'validate' && e.code === 'event_mismatch');
    const b2 = clone(fx('live-border')); b2.aggregate_at = new Date(new Date(b2.aggregate_at).getTime() + 1000).toISOString(); b2.ranking_announce_at = new Date(new Date(b2.ranking_announce_at).getTime() + 1000).toISOString(); // still internally valid, differs from top100
    assert.throws(() => validateLive(fx('live-top100'), b2, {}), (e) => e.code === 'event_mismatch');
});
test('validateLive rejects missing rank, duplicate rank, negative score, non-integer score, non-decreasing scores, bad id', () => {
    const missing = clone(fx('live-border')); missing.player_border_rankings = missing.player_border_rankings.filter((r) => r.rank !== 500);
    assert.throws(() => validateLive(fx('live-top100'), missing, {}), (e) => e.code === 'rank_set');
    const dup = clone(fx('live-top100')); dup.player_top_100_rankings.push({ ...dup.player_top_100_rankings[0] });
    assert.throws(() => validateLive(dup, fx('live-border'), {}), (e) => e.code === 'rank_set');
    const neg = clone(fx('live-top100')); neg.player_top_100_rankings[0].score = -1;
    assert.throws(() => validateLive(neg, fx('live-border'), {}), (e) => e.code === 'score');
    const frac = clone(fx('live-top100')); frac.player_top_100_rankings[0].score = 1.5;
    assert.throws(() => validateLive(frac, fx('live-border'), {}), (e) => e.code === 'score');
    const order = clone(fx('live-top100')); const r1 = order.player_top_100_rankings.find((r) => r.rank === 1); order.player_top_100_rankings.find((r) => r.rank === 2).score = r1.score + 1;
    assert.throws(() => validateLive(order, fx('live-border'), {}), (e) => e.code === 'score_order');
    const t = clone(fx('live-top100')); const b = clone(fx('live-border')); t.id = 'abc'; b.id = 'abc';
    assert.throws(() => validateLive(t, b, {}), (e) => e.code === 'event_id');
});
test('validateLive ignores world_link_* arrays when wlIngest is off', () => {
    const t = clone(fx('live-top100')); t.world_link_top_100_rankings = [{ garbage: true }];
    assert.equal(validateLive(t, fx('live-border'), { wlIngest: false }).rows.length, 30);
});
test('validateFinal: 30 main rows from border(11) + top100(19), rank 100 once; aggregate flags ignored; empty arrays deferred; root eventId mismatch rejects', () => {
    assert.equal(fx('final-border-181').isEventAggregate, false);
    const { rows, deferred } = validateFinal(181, fx('final-border-181'), fx('final-top100-181'), []);
    assert.equal(deferred, false); assert.equal(rows.filter((r) => r.chapter === 0).length, 30);
    assert.equal(rows.filter((r) => r.chapter === 0 && r.rank === 100).length, 1);
    const b = clone(fx('final-border-181')); b.borderRankings = [];
    assert.deepEqual(validateFinal(181, b, fx('final-top100-181'), []), { rows: [], deferred: true });
    const t = clone(fx('final-top100-181')); t.rankings = [];
    assert.deepEqual(validateFinal(181, fx('final-border-181'), t, []), { rows: [], deferred: true });
    assert.throws(() => validateFinal(180, fx('final-border-181'), fx('final-top100-181'), []), (e) => e.code === 'event_mismatch');
});
test('validateFinal: old-era main border without 1500/2500 -> 28 rows; a missing required rank rejects', () => {
    const old = clone(fx('final-border-181')); old.borderRankings = old.borderRankings.filter((r) => !FINAL_OPTIONAL.has(r.rank));
    const { rows } = validateFinal(181, old, fx('final-top100-181'), []);
    assert.equal(rows.length, 28); assert.ok(rows.every((r) => !FINAL_OPTIONAL.has(r.rank)));
    const miss = clone(fx('final-border-181')); miss.borderRankings = miss.borderRankings.filter((r) => r.rank !== 500);
    assert.throws(() => validateFinal(181, miss, fx('final-top100-181'), []), (e) => e.code === 'rank_set');
});
test('validateFinal WL: bijection with declared chapters -> main 30 + 6 x 28 rows (chapter borders have no 1500/2500)', () => {
    const border = fx('final-border-179'); const top = fx('final-top100-179');
    const { rows, deferred } = validateFinal(179, border, top, chaptersFor(border));
    assert.equal(deferred, false);
    for (let c = 1; c <= 6; c++) assert.equal(rows.filter((r) => r.chapter === c).length, 28);
    assert.equal(rows.filter((r) => r.chapter === 0).length, 30);
});
test('validateFinal WL: fewer declared chapters, duplicate character, child eventId mismatch, missing array reject; empty chapter array deferred', () => {
    const border = fx('final-border-179'); const top = fx('final-top100-179'); const chapters = chaptersFor(border);
    assert.throws(() => validateFinal(179, border, top, chapters.slice(0, 5)), (e) => e.code === 'wl_chapters');
    const dup = clone(border); dup.userWorldBloomChapterRankingBorders[1].gameCharacterId = dup.userWorldBloomChapterRankingBorders[0].gameCharacterId;
    assert.throws(() => validateFinal(179, dup, top, chapters), (e) => e.code === 'wl_chapters');
    const empty = clone(top); empty.userWorldBloomChapterRankings = [];
    assert.deepEqual(validateFinal(179, border, empty, chapters), { rows: [], deferred: true });
    const bad = clone(border); bad.userWorldBloomChapterRankingBorders[0].eventId = 1;
    assert.throws(() => validateFinal(179, bad, top, chapters), (e) => e.code === 'event_mismatch');
    const noArr = clone(top); delete noArr.userWorldBloomChapterRankings;
    assert.throws(() => validateFinal(179, border, noArr, chapters), (e) => e.code === 'shape');
});
test('validateEventListEntry: exactly one entry, times equal to live; otherwise not_unique / time_mismatch', () => {
    const list = fx('event-list'); const { event } = validateLive(fx('live-top100'), fx('live-border'), {});
    assert.equal(validateEventListEntry(list, event.id, event).id, event.id);
    assert.throws(() => validateEventListEntry(list.filter((e) => e.id !== event.id), event.id, event), (e) => e.phase === 'event-list' && e.code === 'not_unique');
    assert.throws(() => validateEventListEntry([...list, list.find((e) => e.id === event.id)], event.id, event), (e) => e.code === 'not_unique');
    const shifted = { ...event, aggregate_at: new Date(event.aggregate_at.getTime() + 1000) };
    assert.throws(() => validateEventListEntry(list, event.id, shifted), (e) => e.code === 'time_mismatch');
});
test('a validation failure logged through log() carries no player fields', async () => {
    const { log } = await import('../src/log.js'); const t = clone(fx('live-top100')); t.player_top_100_rankings[0].name = 'SECRET_NAME'; t.id = 'bad';
    const lines = []; const orig = console.error; console.error = (l) => lines.push(l);
    try { try { validateLive(t, fx('live-border'), {}); } catch (e) { log('error', 'live failed', { phase: e.phase, code: e.code, ...e.detail }); } } finally { console.error = orig; }
    assert.equal(lines.length, 1); assert.ok(!lines[0].includes('SECRET_NAME')); assert.match(lines[0], /"code":"event_id"/);
});
test('safeDetail never contains player fields', () => {
    const t = clone(fx('live-top100')); t.player_top_100_rankings[0].name = 'SECRET_NAME'; t.player_top_100_rankings[0].userId = 'SECRET_ID';
    const d = JSON.stringify(safeDetail(t));
    assert.ok(!d.includes('SECRET_NAME') && !d.includes('SECRET_ID')); assert.match(d, /sha256/);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /home/cholate/sekai-border && npm test 2>&1 | head -3`
Expected: `Cannot find module` 指向 `src/validate.js`。

- [ ] **Step 3: 實作**

```js
// src/log.js
// Single-line JSON for Cloud Logging. `detail` must come from safeDetail() or be plain numbers/strings (spec §5.3).
export function log(level, msg, detail = {}) {
    const line = JSON.stringify({ severity: level.toUpperCase(), msg, ...detail, ts: new Date().toISOString() });
    (level === 'error' ? console.error : console.log)(line);
}
```

```js
// src/constants.js
export const ALLOWED_RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 1000, 1500, 2000, 2500, 3000, 5000, 10000];
export const TOP_TARGET = new Set(ALLOWED_RANKS.slice(0, 19)); // 1..10, 20..100 (owns rank 100)
export const BORDER_TARGET = new Set(ALLOWED_RANKS.slice(19)); // 200..10000
// Final boards may lack these: WL chapter borders and main borders before ~event 110 have no 1500/2500 line (probed 2026-10-16).
export const FINAL_OPTIONAL = new Set([1500, 2500]);
export const SLOT_MS = 5 * 60 * 1000;
export const ANNOUNCE_GRACE_MS = 15 * 60 * 1000;
```

```js
// src/errors.js
// `detail` must never carry upstream player fields; build it with safeDetail() from validate.js.
export class UpstreamError extends Error {
    constructor(phase, code, detail = {}) { super(`${phase}:${code}`); this.phase = phase; this.code = code; this.detail = detail; }
}
export class DbError extends Error {
    constructor(phase, message) { super(`${phase}:${message}`); this.phase = phase; }
}
```

```js
// src/validate.js
import { createHash } from 'node:crypto';
import { ALLOWED_RANKS, TOP_TARGET, BORDER_TARGET, FINAL_OPTIONAL } from './constants.js';
import { UpstreamError } from './errors.js';

const ALLOWED = new Set(ALLOWED_RANKS);
const NONE = new Set();

export function safeDetail(payload) {
    const out = { sha256: createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex') };
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        for (const [k, v] of Object.entries(payload)) out[k] = Array.isArray(v) ? `array[${v.length}]` : typeof v;
    }
    return out;
}
const fail = (phase, code, payload) => new UpstreamError(phase, code, safeDetail(payload));

function eventHeader(p) {
    if (!Number.isInteger(p?.id) || p.id <= 0) throw fail('validate', 'event_id', p);
    const d = (v) => { const x = new Date(v); if (Number.isNaN(x.getTime())) throw fail('validate', 'event_time', p); return x; };
    const start_at = d(p.start_at), aggregate_at = d(p.aggregate_at), ranking_announce_at = d(p.ranking_announce_at);
    if (!(start_at < aggregate_at) || !(aggregate_at <= ranking_announce_at)) throw fail('validate', 'event_time', p);
    return { id: p.id, name: String(p.name ?? ''), start_at, aggregate_at, ranking_announce_at };
}

function pick(list, target, payload) {
    if (!Array.isArray(list)) throw fail('validate', 'shape', payload);
    return list.filter((r) => target.has(r?.rank)).map((r) => ({ rank: r.rank, score: r.score }));
}

// Every allowed rank except `optional` present, no duplicates, non-negative integer scores, scores non-increasing with rank.
function checkRows(rows, payload, optional = NONE) {
    const seen = new Set();
    for (const r of rows) {
        if (!Number.isInteger(r.rank) || !ALLOWED.has(r.rank) || seen.has(r.rank)) throw fail('validate', 'rank_set', payload);
        if (!Number.isInteger(r.score) || r.score < 0) throw fail('validate', 'score', payload);
        seen.add(r.rank);
    }
    for (const r of ALLOWED) if (!optional.has(r) && !seen.has(r)) throw fail('validate', 'rank_set', payload);
    const sorted = [...rows].sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].score > sorted[i - 1].score) throw fail('validate', 'score_order', payload);
    return sorted.map(({ rank, score }) => ({ rank, score }));
}

export function validateLive(top100, border, { wlIngest = false } = {}) {
    const a = eventHeader(top100), b = eventHeader(border);
    const payload = { top100: safeDetail(top100), border: safeDetail(border) };
    if (a.id !== b.id || a.aggregate_at.getTime() !== b.aggregate_at.getTime() || a.ranking_announce_at.getTime() !== b.ranking_announce_at.getTime()) throw new UpstreamError('validate', 'event_mismatch', payload);
    const rows = checkRows([...pick(top100.player_top_100_rankings, TOP_TARGET, top100), ...pick(border.player_border_rankings, BORDER_TARGET, border)], payload);
    void wlIngest; // live WL payload shape is unverified until the next WL event (spec §5.4)
    return { event: a, rows: rows.map((r) => ({ chapter: 0, ...r })) };
}

// One WL array (border or top100 chapters): bijection against declared chapters; deferred while upstream has not filled it.
function chapterRows(entries, key, target, id, chapters, payload) {
    if (!Array.isArray(entries)) throw fail('validate', 'shape', payload);
    if (entries.length === 0) return { out: [], deferred: true };
    const byChar = new Map();
    for (const c of entries) {
        if (c?.eventId !== id) throw new UpstreamError('validate', 'event_mismatch', payload);
        if (byChar.has(c.gameCharacterId)) throw new UpstreamError('validate', 'wl_chapters', payload);
        byChar.set(c.gameCharacterId, c);
    }
    if (byChar.size !== chapters.length) throw new UpstreamError('validate', 'wl_chapters', payload);
    const out = [];
    for (const ch of chapters) {
        const c = byChar.get(ch.character_id);
        if (!c) throw new UpstreamError('validate', 'wl_chapters', payload);
        out.push({ chapter: ch.chapter, rows: pick(c[key], target, payload) });
    }
    return { out, deferred: false };
}

export function validateFinal(id, border, top100, chapters = []) {
    if (border?.eventId !== id) throw fail('validate', 'event_mismatch', border);
    // Upstream aggregate flags are false for every event (probed 2026-10-16); readiness is time-gated by the caller.
    if (border.borderRankings?.length === 0 || top100?.rankings?.length === 0) return { rows: [], deferred: true };
    const payload = { border: safeDetail(border), top100: safeDetail(top100) };
    const rows = checkRows([...pick(top100?.rankings, TOP_TARGET, top100), ...pick(border.borderRankings, BORDER_TARGET, border)], payload, FINAL_OPTIONAL).map((r) => ({ chapter: 0, ...r }));
    if (chapters.length > 0) {
        const b = chapterRows(border.userWorldBloomChapterRankingBorders, 'borderRankings', BORDER_TARGET, id, chapters, payload);
        const t = chapterRows(top100.userWorldBloomChapterRankings, 'rankings', TOP_TARGET, id, chapters, payload);
        if (b.deferred || t.deferred) return { rows: [], deferred: true };
        for (const ch of chapters) {
            const br = b.out.find((x) => x.chapter === ch.chapter).rows, tr = t.out.find((x) => x.chapter === ch.chapter).rows;
            rows.push(...checkRows([...tr, ...br], payload, FINAL_OPTIONAL).map((r) => ({ chapter: ch.chapter, ...r })));
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
    if (!same(e.start_at, live.start_at) || !same(e.aggregate_at, live.aggregate_at) || !same(e.ranking_announce_at, live.ranking_announce_at)) throw new UpstreamError('event-list', 'time_mismatch', { id });
    return e;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd /home/cholate/sekai-border && npm test 2>&1 | grep -E "ℹ (pass|fail)|not ok"`
Expected: `pass 14`（含 fixtures.test.js 的 2 個）、`fail 0`。

- [ ] **Step 5: Commit**

```bash
cd /home/cholate/sekai-border && git add src test/validate.test.js && git commit -m "feat: log 與上游回應驗證（名次集合、兩回應一致性、最終榜目標集、WL 章節雙射、去個資 detail）"
```

---

### Task 2: `src/state.js` — 純函式狀態機（spec §4.2）

**Files:** Create `src/state.js`；Test `test/state.test.js`

**Interfaces:**
- `slotOf(date) → Date`；`classify(row, now) → 'current'|'frozen'|'due'|'stale-live'`；`isEligibleForFinalize(row, now) → boolean`；`decide({ live, known, startedLatest, now, preStart }) → { ensure: 'none'|'insert'|'regress'|'pre-start', branch }`。

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
test('classify boundaries', () => {
    assert.equal(classify(ev(), T('2026-10-15T00:00:00Z')), 'current');
    assert.equal(classify(ev(), T('2026-10-19T12:59:59Z')), 'frozen');
    assert.equal(classify(ev(), T('2026-10-19T13:24:58Z')), 'frozen');
    assert.equal(classify(ev(), T('2026-10-19T13:24:59Z')), 'due');
    assert.equal(classify(ev({ finalized_at: T('2026-10-19T14:00:00Z') }), T('2026-10-20T00:00:00Z')), 'stale-live');
});
test('isEligibleForFinalize', () => {
    assert.equal(isEligibleForFinalize(ev(), T('2026-10-19T13:24:58Z')), false);
    assert.equal(isEligibleForFinalize(ev(), T('2026-10-19T13:24:59Z')), true);
    assert.equal(isEligibleForFinalize(ev({ finalized_at: T('2026-10-19T14:00:00Z') }), T('2026-10-20T00:00:00Z')), false);
});
test('known x {current, frozen, due, stale-live}', () => {
    assert.deepEqual(decide({ live: ev(), known: ev(), startedLatest: ev(), now: T('2026-10-15T00:00:00Z'), preStart: false }), { ensure: 'none', branch: 'current' });
    assert.deepEqual(decide({ live: ev(), known: ev(), startedLatest: ev(), now: T('2026-10-19T13:00:00Z'), preStart: false }), { ensure: 'none', branch: 'frozen' });
    assert.deepEqual(decide({ live: ev(), known: ev(), startedLatest: ev(), now: T('2026-10-19T13:30:00Z'), preStart: false }), { ensure: 'none', branch: 'due' });
    const done = ev({ finalized_at: T('2026-10-19T14:00:00Z') });
    assert.deepEqual(decide({ live: ev(), known: done, startedLatest: done, now: T('2026-10-20T00:00:00Z'), preStart: false }), { ensure: 'none', branch: 'stale-live' });
});
test('new-event (incl. bootstrap) x {current, frozen, due}', () => {
    assert.deepEqual(decide({ live: ev(), known: null, startedLatest: null, now: T('2026-10-15T00:00:00Z'), preStart: false }), { ensure: 'insert', branch: 'current' });
    const prev = ev({ id: 181 });
    assert.deepEqual(decide({ live: ev(), known: null, startedLatest: prev, now: T('2026-10-19T13:00:00Z'), preStart: false }), { ensure: 'insert', branch: 'frozen' });
    assert.deepEqual(decide({ live: ev(), known: null, startedLatest: prev, now: T('2026-10-19T13:30:00Z'), preStart: false }), { ensure: 'insert', branch: 'due' });
});
test('pre-start inserts nothing; regress terminates', () => {
    assert.deepEqual(decide({ live: ev({ id: 183 }), known: null, startedLatest: ev(), now: T('2026-10-20T00:00:00Z'), preStart: true }), { ensure: 'pre-start', branch: 'pre-start' });
    assert.deepEqual(decide({ live: ev({ id: 180 }), known: null, startedLatest: ev(), now: T('2026-10-15T00:00:00Z'), preStart: false }), { ensure: 'regress', branch: null });
});
```

- [ ] **Step 2: 跑測試確認失敗** — Run `node --test test/state.test.js`，Expected `Cannot find module`。

- [ ] **Step 3: 實作**

```js
// src/state.js
// Pure decisions only; the caller loads DB rows and performs effects (spec §4.2).
import { SLOT_MS, ANNOUNCE_GRACE_MS } from './constants.js';
export const slotOf = (date) => new Date(Math.floor(date.getTime() / SLOT_MS) * SLOT_MS);
export const isEligibleForFinalize = (row, now) => row.finalized_at == null && now.getTime() >= row.ranking_announce_at.getTime() + ANNOUNCE_GRACE_MS;
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

- [ ] **Step 4: 跑測試確認通過** — Expected `pass 20`（14 + 6）、`fail 0`。
- [ ] **Step 5: Commit** — `git add src/state.js test/state.test.js && git commit -m "feat: 純函式狀態機"`

---

### Task 3: Supabase schema（表、約束、觸發器、結算函式、以舊定義為本的相容 view、權限）— 先套在 `test` schema（spec §3、§6）

**Files:**
- Create: `supabase/legacy/views_2026-10-16.sql`（舊 view 定義的逐字保存，從 `pg_get_viewdef` 匯出）
- Create: `supabase/legacy/views_test_schema.sql`（同一份舊 view 包成 `create or replace view test.…`，供整合測試新舊逐列比對）
- Create: `supabase/migrations/0001_sekai_border.sql.tmpl`、`scripts/render-sql.js`
- Create: `supabase/migrations/test_only_helpers.sql`（只套 test：模擬失敗、時區、權限目錄查詢的 helper）
- Test: `test/integration/helpers.js`、`test/integration/schema.test.js`

**前置（user 一次性）**：Supabase dashboard → Project Settings → API → **Exposed schemas** 加入 `test`。`.env` 需有 `SUPABASE_ANON_KEY`（權限測試必跑）。

**Interfaces:**
- `{{schema}}.sekai_border_events`、`{{schema}}.sekai_border_rankings`、`{{schema}}.sekai_border_finalize(p_event_id int, p_finals jsonb) → jsonb {finalized, already, inserted_finals, deleted_snapshots}`、`{{schema}}.sekai_border_current_report`、`{{schema}}.sekai_border_daily_report`。
- test-only（全部只授 `service_role`）：`test.sekai_border_test_seed_legacy(p_rows)`、`test.sekai_border_test_clear_legacy()`、`test.sekai_border_test_view_diff()`、`test.sekai_border_test_finalize_in_tz(p_event_id, p_finals, p_tz)`、`test.sekai_border_test_finalize_failing(p_event_id, p_finals)`（觸發器在壓縮 DELETE 前 RAISE）、`test.sekai_border_test_privileges() → jsonb`。

- [ ] **Step 0: 逐字保存舊 view 定義（MCP SQL）**

```sql
select viewname, pg_get_viewdef(('public.'||viewname)::regclass, true) from pg_views where schemaname='public' and viewname in ('view_all_ranking_report','view_day_ranking_report');
```

把兩段輸出原樣寫進 `supabase/legacy/views_2026-10-16.sql`（以 `-- view_all_ranking_report` / `-- view_day_ranking_report` 分隔）。Expected：檔案含 `lag(event_rankings.score, 12)`、`lag(..., 36)`、`lag(..., 288)`、`3000::numeric`、`4200::numeric`、`84600`、`88200`、`'Asia/Taipei'`、`<= 2::numeric`，這些常數是後面 view 的對照基準。另外記錄舊 view 的欄位型別：

```sql
select table_name, column_name, data_type from information_schema.columns where table_schema='public' and table_name in ('view_all_ranking_report','view_day_ranking_report') order by 1, ordinal_position;
```

Expected（寫進同一檔案當註解）：`view_all_ranking_report`：rank integer, current_score bigint, last_1h_speed bigint, last_3h_speed bigint, last_24h_speed bigint, max_speed bigint, overall_speed numeric；`view_day_ranking_report`：event_id text, rank integer, scores bigint[]。

第三段：把同一份舊 view 以 test schema 的 `create or replace view` 包起來，供整合測試做新舊 view 逐列比對（spec §8.2）：

```sql
select 'set search_path = test;' || E'\n' || string_agg(format('create or replace view test.%I as %s', viewname, pg_get_viewdef(('public.'||viewname)::regclass, true)), E'\n' order by viewname)
from pg_views where schemaname='public' and viewname in ('view_all_ranking_report','view_day_ranking_report');
```

輸出原樣存成 `supabase/legacy/views_test_schema.sql`。Expected：檔案含 2 個 `create or replace view test.`、`FROM event_rankings` 未加 schema（`set search_path = test` 讓它解析到 `test.event_rankings`）、每個 `create` 以 `;` 結尾（`pg_get_viewdef` 自帶；沒有就補）。

- [ ] **Step 1: 渲染腳本**

```js
// scripts/render-sql.js
// usage: node scripts/render-sql.js <file.tmpl> <schema> [legacy_schema]   ({{schema}} / {{legacy_schema}})
import { readFileSync } from 'node:fs';
const [file, schema, legacy = schema] = process.argv.slice(2);
if (!file || !/^[a-z_]+$/.test(schema ?? '') || !/^[a-z_]+$/.test(legacy)) { console.error('usage: render-sql.js <file.tmpl> <schema> [legacy_schema]'); process.exit(2); }
process.stdout.write(readFileSync(file, 'utf8').replaceAll('{{schema}}', schema).replaceAll('{{legacy_schema}}', legacy));
```

- [ ] **Step 2: migration template**（相容 view 的本體是 Step 0 的舊 SQL，只把 `FROM event_rankings` 換成 CTE；`WITH` 子句以外一字不改）

```sql
-- supabase/migrations/0001_sekai_border.sql.tmpl  (idempotent; rendered per schema)
create schema if not exists {{schema}};

create table if not exists {{schema}}.sekai_border_events (
    id integer primary key check (id > 0),
    name text not null,
    event_type text check (event_type in ('marathon','cheerful_carnival','world_bloom')),
    unit text,
    start_at timestamptz not null,
    aggregate_at timestamptz not null,
    ranking_announce_at timestamptz not null,
    bonus_characters integer[] not null default '{}',
    chapters jsonb not null default '[]'::jsonb,
    metadata_status text not null default 'pending' check (metadata_status in ('pending','complete','missing','mismatch')),
    metadata_checked_at timestamptz,
    metadata_miss_count smallint not null default 0 check (metadata_miss_count >= 0),
    finalized_at timestamptz,
    constraint sekai_border_events_times check (start_at < aggregate_at and aggregate_at <= ranking_announce_at)
);

-- chapters: [{chapter 1..6 int, chapter_id int, character_id int, start_at, aggregate_at, ranking_announce_at}],
-- chapter and character_id unique per event, <= 6 entries, every integer field integer-valued (spec §3.2).
create or replace function {{schema}}.sekai_border_chapters_valid(ch jsonb) returns boolean
language plpgsql immutable as $$
declare e jsonb; n int := 0; chs int[] := '{}'; chars int[] := '{}'; s timestamptz; a timestamptz; r timestamptz; k text;
begin
    if jsonb_typeof(ch) <> 'array' then return false; end if;
    for e in select * from jsonb_array_elements(ch) loop
        n := n + 1; if n > 6 then return false; end if;
        foreach k in array array['chapter','chapter_id','character_id'] loop
            if not (e ? k) or jsonb_typeof(e->k) is distinct from 'number' or (e->>k)::numeric <> trunc((e->>k)::numeric) then return false; end if;
        end loop;
        if (e->>'chapter')::int < 1 or (e->>'chapter')::int > 6 then return false; end if;
        begin s := (e->>'start_at')::timestamptz; a := (e->>'aggregate_at')::timestamptz; r := (e->>'ranking_announce_at')::timestamptz;
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
    event_id integer not null references {{schema}}.sekai_border_events(id),
    chapter smallint not null check (chapter between 0 and 6),
    rank integer not null check (rank = any (array[1,2,3,4,5,6,7,8,9,10,20,30,40,50,60,70,80,90,100,200,300,400,500,1000,1500,2000,2500,3000,5000,10000])),
    score bigint not null check (score >= 0),
    taken_at timestamptz not null,
    is_final boolean not null default false,
    primary key (event_id, chapter, rank, taken_at, is_final)
);
create index if not exists sekai_border_rankings_event_chapter_time on {{schema}}.sekai_border_rankings (event_id, chapter, taken_at);
-- one final row per (event, chapter, rank)
create unique index if not exists sekai_border_rankings_one_final on {{schema}}.sekai_border_rankings (event_id, chapter, rank) where is_final;

create or replace function {{schema}}.sekai_border_rankings_chapter_check() returns trigger language plpgsql as $$
begin
    if new.chapter = 0 then return new; end if;
    if not exists (select 1 from {{schema}}.sekai_border_events e, jsonb_array_elements(e.chapters) c where e.id = new.event_id and (c->>'chapter')::int = new.chapter) then
        raise exception 'chapter % not declared for event %', new.chapter, new.event_id using errcode = '23514';
    end if;
    return new;
end $$;
drop trigger if exists sekai_border_rankings_chapter_check on {{schema}}.sekai_border_rankings;
create trigger sekai_border_rankings_chapter_check before insert or update on {{schema}}.sekai_border_rankings for each row execute function {{schema}}.sekai_border_rankings_chapter_check();

-- Finalization in one transaction (spec §4.3). p_finals: [{chapter, rank, score}].
create or replace function {{schema}}.sekai_border_finalize(p_event_id integer, p_finals jsonb) returns jsonb
language plpgsql security definer set search_path = {{schema}}, pg_temp as $$
declare ev record; n_ins int; n_del int; ch record; cnt_rows int; cnt_ranks int; cnt_req int;
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

    for ch in select 0 as chapter union all select (c->>'chapter')::int from jsonb_array_elements(ev.chapters) c loop
        -- 1500/2500 are optional on final boards (src/constants.js FINAL_OPTIONAL); the other 28 allowed ranks are required
        select count(*), count(distinct rank), count(distinct rank) filter (where rank <> all (array[1500, 2500])) into cnt_rows, cnt_ranks, cnt_req
        from sekai_border_rankings where event_id = p_event_id and chapter = ch.chapter and is_final;
        if cnt_rows <> cnt_ranks or cnt_req <> 28 then raise exception 'chapter % has % final rows / % ranks / % of 28 required ranks', ch.chapter, cnt_rows, cnt_ranks, cnt_req; end if;
    end loop;

    -- hourly compaction: keep the last observation per UTC hour bucket; non-final rows only (spec §3.2)
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

-- Compatibility views (spec §3.3): the legacy SQL from supabase/legacy/views_2026-10-16.sql, verbatim, with
-- `FROM event_rankings` resolved by a CTE that exposes the legacy contract (event_id text, rank, score, created_at)
-- for the single started, unfinalized event's non-final main-board rows.
create or replace view {{schema}}.sekai_border_current_report with (security_invoker = on) as
with event_rankings as (
    select event_id::text as event_id, rank, score, taken_at as created_at
    from {{schema}}.sekai_border_rankings
    where chapter = 0 and is_final = false
      and event_id = (select max(id) from {{schema}}.sekai_border_events where finalized_at is null and start_at <= now())
), ranking_calculations AS (
         SELECT event_rankings.event_id, event_rankings.rank, event_rankings.created_at, event_rankings.score,
            first_value(event_rankings.created_at) OVER (PARTITION BY event_rankings.event_id ORDER BY event_rankings.created_at) AS start_time,
            lag(event_rankings.score, 12) OVER (PARTITION BY event_rankings.event_id, event_rankings.rank ORDER BY event_rankings.created_at) AS score_1h_ago,
            lag(event_rankings.score, 36) OVER (PARTITION BY event_rankings.event_id, event_rankings.rank ORDER BY event_rankings.created_at) AS score_3h_ago,
            lag(event_rankings.score, 288) OVER (PARTITION BY event_rankings.event_id, event_rankings.rank ORDER BY event_rankings.created_at) AS score_24h_ago,
            lag(event_rankings.created_at, 12) OVER (PARTITION BY event_rankings.event_id, event_rankings.rank ORDER BY event_rankings.created_at) AS time_1h_ago,
            lag(event_rankings.created_at, 36) OVER (PARTITION BY event_rankings.event_id, event_rankings.rank ORDER BY event_rankings.created_at) AS time_3h_ago,
            lag(event_rankings.created_at, 288) OVER (PARTITION BY event_rankings.event_id, event_rankings.rank ORDER BY event_rankings.created_at) AS time_24h_ago
           FROM event_rankings
        ), validated_speeds AS (
         SELECT ranking_calculations.event_id, ranking_calculations.rank, ranking_calculations.created_at, ranking_calculations.score, ranking_calculations.start_time,
            ranking_calculations.score_1h_ago, ranking_calculations.score_3h_ago, ranking_calculations.score_24h_ago,
            ranking_calculations.time_1h_ago, ranking_calculations.time_3h_ago, ranking_calculations.time_24h_ago,
                CASE WHEN EXTRACT(epoch FROM ranking_calculations.created_at - ranking_calculations.time_1h_ago) >= 3000::numeric AND EXTRACT(epoch FROM ranking_calculations.created_at - ranking_calculations.time_1h_ago) <= 4200::numeric THEN ranking_calculations.score - ranking_calculations.score_1h_ago ELSE NULL::bigint END AS speed_1h,
                CASE WHEN EXTRACT(epoch FROM ranking_calculations.created_at - ranking_calculations.time_3h_ago) >= 9600::numeric AND EXTRACT(epoch FROM ranking_calculations.created_at - ranking_calculations.time_3h_ago) <= 12000::numeric THEN ranking_calculations.score - ranking_calculations.score_3h_ago ELSE NULL::bigint END AS speed_3h,
                CASE WHEN EXTRACT(epoch FROM ranking_calculations.created_at - ranking_calculations.time_24h_ago) >= 84600::numeric AND EXTRACT(epoch FROM ranking_calculations.created_at - ranking_calculations.time_24h_ago) <= 88200::numeric THEN ranking_calculations.score - ranking_calculations.score_24h_ago ELSE NULL::bigint END AS speed_24h
           FROM ranking_calculations
        ), latest_stats AS (
         SELECT validated_speeds.event_id, validated_speeds.rank,
            (array_agg(validated_speeds.score ORDER BY validated_speeds.created_at DESC))[1] AS current_score,
            (array_agg(validated_speeds.created_at ORDER BY validated_speeds.created_at DESC))[1] AS last_captured_at,
            (array_agg(validated_speeds.start_time ORDER BY validated_speeds.created_at DESC))[1] AS event_start_time,
            (array_agg(validated_speeds.speed_1h ORDER BY validated_speeds.created_at DESC))[1] AS last_1h_speed,
            (array_agg(validated_speeds.speed_3h ORDER BY validated_speeds.created_at DESC))[1] AS last_3h_speed,
            (array_agg(validated_speeds.speed_24h ORDER BY validated_speeds.created_at DESC))[1] AS last_24h_speed,
            max(validated_speeds.speed_1h) FILTER (WHERE validated_speeds.created_at > (validated_speeds.start_time + '01:00:00'::interval)) AS max_speed_historical
           FROM validated_speeds GROUP BY validated_speeds.event_id, validated_speeds.rank
        )
 SELECT rank, current_score,
    COALESCE(last_1h_speed, 0::bigint) AS last_1h_speed, COALESCE(last_3h_speed, 0::bigint) AS last_3h_speed, COALESCE(last_24h_speed, 0::bigint) AS last_24h_speed,
    COALESCE(max_speed_historical, 0::bigint) AS max_speed,
    CASE WHEN EXTRACT(epoch FROM last_captured_at - event_start_time) < 3600::numeric THEN 0::numeric
         ELSE round(current_score::numeric / (EXTRACT(epoch FROM last_captured_at - event_start_time) / 3600::numeric)) END AS overall_speed
   FROM latest_stats ORDER BY rank;

create or replace view {{schema}}.sekai_border_daily_report with (security_invoker = on) as
with event_rankings as (
    select event_id::text as event_id, rank, score, taken_at as created_at
    from {{schema}}.sekai_border_rankings
    where chapter = 0 and is_final = false
      and event_id = (select max(id) from {{schema}}.sekai_border_events where finalized_at is null and start_at <= now())
)
 SELECT event_id, rank, array_agg(score ORDER BY created_at) AS scores
   FROM ( SELECT DISTINCT ON (event_rankings.event_id, event_rankings.rank, (date((event_rankings.created_at AT TIME ZONE 'Asia/Taipei'::text)))) event_rankings.event_id, event_rankings.rank, event_rankings.score, event_rankings.created_at
           FROM event_rankings
          WHERE EXTRACT(hour FROM (event_rankings.created_at AT TIME ZONE 'Asia/Taipei'::text)) = 0::numeric AND EXTRACT(minute FROM (event_rankings.created_at AT TIME ZONE 'Asia/Taipei'::text)) <= 2::numeric
          ORDER BY event_rankings.event_id, event_rankings.rank, (date((event_rankings.created_at AT TIME ZONE 'Asia/Taipei'::text))), event_rankings.created_at) sub
  GROUP BY event_id, rank;

-- RLS + grants (spec S4, S5, N11)
alter table {{schema}}.sekai_border_events enable row level security;
alter table {{schema}}.sekai_border_rankings enable row level security;
drop policy if exists sekai_border_events_read on {{schema}}.sekai_border_events;
drop policy if exists sekai_border_rankings_read on {{schema}}.sekai_border_rankings;
create policy sekai_border_events_read on {{schema}}.sekai_border_events for select to anon, authenticated using (true);
create policy sekai_border_rankings_read on {{schema}}.sekai_border_rankings for select to anon, authenticated using (true);
grant usage on schema {{schema}} to anon, authenticated, service_role;
revoke all on {{schema}}.sekai_border_events, {{schema}}.sekai_border_rankings, {{schema}}.sekai_border_current_report, {{schema}}.sekai_border_daily_report from anon, authenticated;
grant select on {{schema}}.sekai_border_events, {{schema}}.sekai_border_rankings, {{schema}}.sekai_border_current_report, {{schema}}.sekai_border_daily_report to anon, authenticated;
grant all on {{schema}}.sekai_border_events, {{schema}}.sekai_border_rankings to service_role;
grant select on {{schema}}.sekai_border_current_report, {{schema}}.sekai_border_daily_report to service_role;   -- no default privileges outside public: explicit, or the service-role client cannot read the views
```

驗收 view 與舊定義一致（在 Step 0 檔案與 template 之間）：

```bash
cd /home/cholate/sekai-border && for k in "lag(event_rankings.score, 12)" "lag(event_rankings.score, 36)" "lag(event_rankings.score, 288)" "3000::numeric" "4200::numeric" "9600::numeric" "12000::numeric" "84600::numeric" "88200::numeric" "'01:00:00'::interval" "3600::numeric" "'Asia/Taipei'::text" "<= 2::numeric"; do printf '%-40s legacy=%s tmpl=%s\n' "$k" "$(grep -cF "$k" supabase/legacy/views_2026-10-16.sql)" "$(grep -cF "$k" supabase/migrations/0001_sekai_border.sql.tmpl)"; done
```

Expected：每一行 legacy 與 tmpl 的計數相同（都 ≥ 1）。

- [ ] **Step 3: test-only helpers**

```sql
-- supabase/migrations/test_only_helpers.sql  (apply ONLY to the test schema)
create table if not exists test.event_rankings (id bigserial primary key, created_at timestamptz default now(), rank int, score bigint, event_id text);
grant all on test.event_rankings to service_role; grant usage, select on sequence test.event_rankings_id_seq to service_role;   -- tests read it through the service-role client
create or replace function test.sekai_border_test_seed_legacy(p_rows jsonb) returns void language sql security definer set search_path = test as $$
    insert into test.event_rankings (event_id, rank, score, created_at) select r->>'event_id', (r->>'rank')::int, (r->>'score')::bigint, (r->>'created_at')::timestamptz from jsonb_array_elements(p_rows) r; $$;
create or replace function test.sekai_border_test_clear_legacy() returns void language sql security definer set search_path = test as $$ delete from test.event_rankings; $$;

-- legacy vs compat views on the same data (spec §8.2): row diff via EXCEPT (type-incompatible columns make EXCEPT itself fail, which is also a finding);
-- column types via format_type (information_schema.data_type says only ARRAY for bigint[] vs integer[])
create or replace function test.sekai_border_test_view_diff() returns jsonb language plpgsql security definer set search_path = test as $$
declare d1 int; d2 int; t1 jsonb; t2 jsonb; t3 jsonb; t4 jsonb;
begin
    select count(*) into d1 from ((select * from test.view_all_ranking_report except select * from test.sekai_border_current_report) union all (select * from test.sekai_border_current_report except select * from test.view_all_ranking_report)) x;
    select count(*) into d2 from ((select * from test.view_day_ranking_report except select * from test.sekai_border_daily_report) union all (select * from test.sekai_border_daily_report except select * from test.view_day_ranking_report)) x;
    select jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) order by a.attnum) into t1 from pg_attribute a where a.attrelid = 'test.view_all_ranking_report'::regclass and a.attnum > 0 and not a.attisdropped;
    select jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) order by a.attnum) into t2 from pg_attribute a where a.attrelid = 'test.sekai_border_current_report'::regclass and a.attnum > 0 and not a.attisdropped;
    select jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) order by a.attnum) into t3 from pg_attribute a where a.attrelid = 'test.view_day_ranking_report'::regclass and a.attnum > 0 and not a.attisdropped;
    select jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) order by a.attnum) into t4 from pg_attribute a where a.attrelid = 'test.sekai_border_daily_report'::regclass and a.attnum > 0 and not a.attisdropped;
    return jsonb_build_object('current_diff', d1, 'daily_diff', d2, 'current_types_equal', t1 = t2, 'daily_types_equal', t3 = t4);
end $$;

-- run finalize under a given session timezone (spec §3.2: bucketing must not depend on it)
create or replace function test.sekai_border_test_finalize_in_tz(p_event_id int, p_finals jsonb, p_tz text) returns jsonb language plpgsql security definer set search_path = test as $$
begin perform set_config('timezone', p_tz, true); return test.sekai_border_finalize(p_event_id, p_finals); end $$;

-- fault injection: when test.fail_compaction is 'on', the first DELETE on rankings raises (between finals upsert and compaction)
create or replace function test.sekai_border_test_fail_delete() returns trigger language plpgsql as $$
begin if current_setting('test.fail_compaction', true) = 'on' then raise exception 'injected failure before compaction'; end if; return old; end $$;
drop trigger if exists sekai_border_test_fail_delete on test.sekai_border_rankings;
create trigger sekai_border_test_fail_delete before delete on test.sekai_border_rankings for each row execute function test.sekai_border_test_fail_delete();
create or replace function test.sekai_border_test_finalize_failing(p_event_id int, p_finals jsonb) returns jsonb language plpgsql security definer set search_path = test as $$
begin perform set_config('test.fail_compaction', 'on', true); return test.sekai_border_finalize(p_event_id, p_finals); end $$;

-- catalog-level privilege report (spec S4): roles x privileges, policies, rls, function acl
create or replace function test.sekai_border_test_privileges() returns jsonb language sql security definer as $$
  select jsonb_build_object(
    'rls', (select jsonb_object_agg(relname, relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='test' and relname in ('sekai_border_events','sekai_border_rankings')),
    'policies', (select jsonb_agg(jsonb_build_object('t', tablename, 'cmd', cmd, 'roles', roles)) from pg_policies where schemaname='test' and tablename like 'sekai_border_%'),
    'privs', (select jsonb_agg(jsonb_build_object('role', r, 'rel', t, 'priv', p, 'has', has_table_privilege(r, 'test.'||t, p)))
              from (values ('anon'),('authenticated')) a(r), (values ('sekai_border_events'),('sekai_border_rankings'),('sekai_border_current_report'),('sekai_border_daily_report')) b(t), (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) c(p)),
    'fn', jsonb_build_object('anon', has_function_privilege('anon','test.sekai_border_finalize(integer,jsonb)','EXECUTE'), 'authenticated', has_function_privilege('authenticated','test.sekai_border_finalize(integer,jsonb)','EXECUTE'), 'service_role', has_function_privilege('service_role','test.sekai_border_finalize(integer,jsonb)','EXECUTE'),
                              'public_grantee', (select count(*) from aclexplode((select proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='test' and proname='sekai_border_finalize')) where grantee = 0)),
    'views', (select jsonb_object_agg(relname, coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker'),'off')) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='test' and relname in ('sekai_border_current_report','sekai_border_daily_report'))
  ) $$;
-- every test helper is service_role only (the test schema is exposed through PostgREST)
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'test' and p.proname like 'sekai_border_test_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop; end $$;
```

- [ ] **Step 4: 渲染並套到 `test` schema**

```bash
cd /home/cholate/sekai-border && node scripts/render-sql.js supabase/migrations/0001_sekai_border.sql.tmpl test > /tmp/0001_test.sql && if grep -n '{{' /tmp/0001_test.sql; then echo 'placeholders left'; false; else echo 'placeholders left: 0'; fi
```

Expected `0`；以 MCP `apply_migration` 套 `/tmp/0001_test.sql`（name `0001_sekai_border_test`）再依序套 `supabase/migrations/test_only_helpers.sql`（name `test_only_helpers`）與 `supabase/legacy/views_test_schema.sql`（name `test_only_legacy_views`）——三個 apply 的順序固定為 `0001_sekai_border_test` → `test_only_helpers` → `test_only_legacy_views`，因為 `set search_path = test` 讓舊 view 本體裡未加 schema 的 `event_rankings` 在 CREATE VIEW 解析時綁到 helpers 建的 `test.event_rankings`，該表必須先存在。Expected：三個皆無錯誤。

- [ ] **Step 5: 整合測試 helper 與 schema 測試**

```js
// test/integration/helpers.js
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
export const SCHEMA = process.env.SUPABASE_SCHEMA;
if (SCHEMA !== 'test') { console.error('integration tests run only with SUPABASE_SCHEMA=test'); process.exit(2); }
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY']) if (!process.env[k]) { console.error(`missing ${k}`); process.exit(2); }
export const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: SCHEMA } });
export const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { db: { schema: SCHEMA } });
export async function truncate() {
    for (const [t, c] of [['sekai_border_rankings', 'event_id'], ['sekai_border_events', 'id']]) { const { error } = await admin.from(t).delete().gte(c, 0); if (error) throw new Error(error.message); }
}
export async function insertEvent(over = {}) {
    const row = { id: 182, name: '與你相繫的Heart Beat', start_at: '2026-10-11T07:00:00Z', aggregate_at: '2026-10-19T12:59:59Z', ranking_announce_at: '2026-10-19T13:09:59Z', ...over };
    const { error } = await admin.from('sekai_border_events').insert(row); if (error) throw new Error(error.message); return row;
}
```

```js
// test/integration/schema.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, anon, truncate, insertEvent } from './helpers.js';
import { ALLOWED_RANKS } from '../../src/constants.js';
const rows = (eventId, takenAt, chapter = 0, isFinal = false, base = 1000) => ALLOWED_RANKS.map((rank, i) => ({ event_id: eventId, chapter, rank, score: base - i, taken_at: takenAt, is_final: isFinal }));
const finals = ALLOWED_RANKS.map((rank, i) => ({ chapter: 0, rank, score: 999999 - i }));
const ins = (r) => admin.from('sekai_border_rankings').insert(r).then(({ error }) => { if (error) throw new Error(error.message); });
test.beforeEach(truncate);

test('constraints: bad rank, negative score, undeclared chapter, non-integer chapter_id, duplicate character all rejected', async () => {
    await insertEvent();
    for (const [row, re] of [[{ event_id: 182, chapter: 0, rank: 150, score: 1, taken_at: '2026-10-12T00:00:00Z' }, /check/i], [{ event_id: 182, chapter: 0, rank: 100, score: -1, taken_at: '2026-10-12T00:00:00Z' }, /check/i], [{ event_id: 182, chapter: 1, rank: 100, score: 1, taken_at: '2026-10-12T00:00:00Z' }, /not declared/]]) {
        const r = await admin.from('sekai_border_rankings').insert(row); assert.match(r.error?.message ?? '', re);
    }
    const base = { id: 179, name: 'x', start_at: '2026-09-06T12:00:00Z', aggregate_at: '2026-09-10T11:59:59Z', ranking_announce_at: '2026-09-10T12:09:59Z' };
    const ch = (o) => ({ chapter: 1, chapter_id: 17901, character_id: 21, start_at: '2026-09-06T12:00:00Z', aggregate_at: '2026-09-07T11:59:59Z', ranking_announce_at: '2026-09-07T12:09:59Z', ...o });
    const noKey = ch({}); delete noKey.character_id;
    for (const chapters of [[ch({ chapter: 7 })], [ch({ chapter_id: 1.5 })], [noKey], [ch({}), ch({ chapter: 2 })], [ch({}), ch({ chapter: 2, chapter_id: 17902, character_id: 22, start_at: 'nope' })]]) {
        const r = await admin.from('sekai_border_events').insert({ ...base, chapters }); assert.match(r.error?.message ?? '', /chapters_valid/);
    }
    const ok = await admin.from('sekai_border_events').insert({ ...base, chapters: [ch({}), ch({ chapter: 2, chapter_id: 17902, character_id: 22 })] }); assert.equal(ok.error, null);
});

test('snapshot upsert ignoreDuplicates + select returns only inserted rows', async () => {
    await insertEvent();
    const slot = '2026-10-12T00:00:00Z';
    const a = await admin.from('sekai_border_rankings').upsert(rows(182, slot), { onConflict: 'event_id,chapter,rank,taken_at,is_final', ignoreDuplicates: true }).select('rank');
    assert.equal(a.error, null); assert.equal(a.data.length, 30);
    const b = await admin.from('sekai_border_rankings').upsert(rows(182, slot, 0, false, 500), { onConflict: 'event_id,chapter,rank,taken_at,is_final', ignoreDuplicates: true }).select('rank');
    assert.equal(b.error, null); assert.equal(b.data.length, 0);
    const { data } = await admin.from('sekai_border_rankings').select('score').eq('rank', 1); assert.equal(data[0].score, 1000);
});

test('finalize under Asia/Taipei session tz: UTC hour buckets keep last observation; finals kept; snapshot at aggregate_at coexists; idempotent', async () => {
    await insertEvent();
    for (const t of ['2026-10-12T00:07:00Z', '2026-10-12T00:37:00Z', '2026-10-12T00:57:00Z', '2026-10-12T01:02:00Z', '2026-10-12T03:11:00Z', '2026-10-19T12:59:59Z']) await ins(rows(182, t));
    const r1 = await admin.rpc('sekai_border_test_finalize_in_tz', { p_event_id: 182, p_finals: finals, p_tz: 'Asia/Taipei' });
    assert.equal(r1.error, null, r1.error?.message); assert.equal(r1.data.inserted_finals, 30); assert.equal(r1.data.deleted_snapshots, 60);
    const { data } = await admin.from('sekai_border_rankings').select('taken_at,is_final').eq('rank', 1).order('taken_at');
    assert.deepEqual(data.filter((d) => !d.is_final).map((d) => new Date(d.taken_at).toISOString()), ['2026-10-12T00:57:00.000Z', '2026-10-12T01:02:00.000Z', '2026-10-12T03:11:00.000Z', '2026-10-19T12:59:59.000Z']);
    assert.equal(data.filter((d) => d.is_final).length, 1);
    const r2 = await admin.rpc('sekai_border_finalize', { p_event_id: 182, p_finals: finals }); assert.equal(r2.data.already, true);
});

test('finalize accepts 28 finals without the optional 1500/2500 (WL chapters, events before ~#110)', async () => {
    await insertEvent();
    const r = await admin.rpc('sekai_border_finalize', { p_event_id: 182, p_finals: finals.filter((f) => f.rank !== 1500 && f.rank !== 2500) });
    assert.equal(r.error, null, r.error?.message); assert.equal(r.data.inserted_finals, 28);
});

test('finalize rolls back on a missing required rank and on injected failure between upsert and compaction; concurrent calls -> exactly one does the work', async () => {
    await insertEvent(); await ins(rows(182, '2026-10-12T00:07:00Z')); await ins(rows(182, '2026-10-12T00:37:00Z'));
    const short = await admin.rpc('sekai_border_finalize', { p_event_id: 182, p_finals: finals.slice(0, 29) });
    assert.match(short.error.message, /27 of 28 required ranks/);
    const inj = await admin.rpc('sekai_border_test_finalize_failing', { p_event_id: 182, p_finals: finals });
    assert.match(inj.error.message, /injected/);
    let c = await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true }); assert.equal(c.count, 60);
    const ev0 = await admin.from('sekai_border_events').select('finalized_at').eq('id', 182).single(); assert.equal(ev0.data.finalized_at, null);
    const [x, y] = await Promise.all([admin.rpc('sekai_border_finalize', { p_event_id: 182, p_finals: finals }), admin.rpc('sekai_border_finalize', { p_event_id: 182, p_finals: finals })]);
    assert.equal(x.error, null); assert.equal(y.error, null);
    assert.deepEqual([x.data.already, y.data.already].sort(), [false, true]);
    c = await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true }).eq('is_final', true); assert.equal(c.count, 30);
});

test('finalize rolls back when a declared WL chapter has no finals', async () => {
    const ch = (c, charId) => ({ chapter: c, chapter_id: 17900 + c, character_id: charId, start_at: '2026-09-06T12:00:00Z', aggregate_at: '2026-09-07T11:59:59Z', ranking_announce_at: '2026-09-07T12:09:59Z' });
    await insertEvent({ id: 179, name: 'wl', start_at: '2026-09-06T12:00:00Z', aggregate_at: '2026-09-10T11:59:59Z', ranking_announce_at: '2026-09-10T12:09:59Z', chapters: [ch(1, 21), ch(2, 22)] });
    const r = await admin.rpc('sekai_border_finalize', { p_event_id: 179, p_finals: [...finals, ...ALLOWED_RANKS.map((rank, i) => ({ chapter: 1, rank, score: 500 - i }))] });
    assert.match(r.error.message, /chapter 2 has 0 final rows/);
    assert.equal((await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true }).eq('event_id', 179)).count, 0);
});
test('compat views: legacy column names/types, single started unfinalized event, empty when none, daily picks Taipei midnight', async () => {
    assert.deepEqual((await admin.from('sekai_border_current_report').select('*')).data, []);
    await insertEvent();
    await insertEvent({ id: 183, name: 'future', start_at: '2026-10-21T07:00:00Z', aggregate_at: '2026-10-29T12:59:59Z', ranking_announce_at: '2026-10-29T13:09:59Z' }); // should be ignored (not started)
    await ins(rows(182, '2026-10-12T00:00:00Z')); await ins(rows(182, '2026-10-12T00:05:00Z', 0, false, 2000)); await ins(rows(182, '2026-10-12T16:00:00Z', 0, false, 3000));
    const { data: cur } = await admin.from('sekai_border_current_report').select('*').order('rank');
    assert.equal(cur.length, 30); assert.deepEqual(Object.keys(cur[0]).sort(), ['current_score', 'last_1h_speed', 'last_24h_speed', 'last_3h_speed', 'max_speed', 'overall_speed', 'rank']);
    assert.equal(cur[0].current_score, 3000);
    const { data: daily } = await admin.from('sekai_border_daily_report').select('*').order('rank');
    assert.equal(daily.length, 30); assert.deepEqual(Object.keys(daily[0]).sort(), ['event_id', 'rank', 'scores']); assert.equal(daily[0].event_id, '182'); assert.deepEqual(daily[0].scores, [3000]);
});

test('legacy views vs compat views: identical rows and column types on the same data (spec §8.2)', async () => {
    await admin.rpc('sekai_border_test_clear_legacy', {}); await insertEvent();
    const slots = ['2026-10-12T00:00:00Z', '2026-10-12T00:05:00Z', '2026-10-12T16:00:00Z', '2026-10-13T00:00:00Z'];
    for (const [i, s] of slots.entries()) await ins(rows(182, s, 0, false, 1000 * (i + 1)));
    await admin.rpc('sekai_border_test_seed_legacy', { p_rows: slots.flatMap((s, i) => ALLOWED_RANKS.map((rank, j) => ({ event_id: '182', rank, score: 1000 * (i + 1) - j, created_at: s }))) });
    const { data, error } = await admin.rpc('sekai_border_test_view_diff'); assert.equal(error, null, error?.message);
    assert.deepEqual(data, { current_diff: 0, daily_diff: 0, current_types_equal: true, daily_types_equal: true });
});

test('privileges: catalog report + real anon DML', async () => {
    const { data: p, error } = await admin.rpc('sekai_border_test_privileges'); assert.equal(error, null, error?.message);
    assert.deepEqual(p.rls, { sekai_border_events: true, sekai_border_rankings: true });
    assert.equal(p.policies.length, 2); assert.ok(p.policies.every((x) => x.cmd === 'SELECT'));
    for (const x of p.privs) assert.equal(x.has, x.priv === 'SELECT', JSON.stringify(x));
    assert.deepEqual([p.fn.anon, p.fn.authenticated, p.fn.service_role, p.fn.public_grantee], [false, false, true, 0]);
    assert.deepEqual(p.views, { sekai_border_current_report: 'on', sekai_border_daily_report: 'on' });
    await insertEvent();
    assert.equal((await anon.from('sekai_border_events').select('id')).error, null);
    assert.ok((await anon.from('sekai_border_rankings').insert({ event_id: 182, chapter: 0, rank: 1, score: 1, taken_at: '2026-10-12T00:00:00Z' })).error);
    assert.ok((await anon.from('sekai_border_events').update({ name: 'x' }).eq('id', 182)).error || (await admin.from('sekai_border_events').select('name').eq('id', 182).single()).data.name !== 'x');
    assert.ok((await anon.rpc('sekai_border_finalize', { p_event_id: 182, p_finals: [] })).error);
    assert.equal((await anon.from('sekai_border_current_report').select('*')).error, null);
});
```

- [ ] **Step 6: `.env` 與執行**

```bash
cd /home/cholate/sekai-border && cat > .env <<'ENV'
SUPABASE_URL=https://bwhhtfcyagqhcddzssas.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<user 貼入>
SUPABASE_ANON_KEY=<user 貼入>
SUPABASE_SCHEMA=test
ENV
git check-ignore -q .env && echo ".env ignored" && npm run test:integration 2>&1 | grep -E "ℹ (pass|fail)|not ok"
```

Expected: `pass 9`、`fail 0`。`SUPABASE_SCHEMA=public npm run test:integration` → 印拒跑訊息、exit 2。

- [ ] **Step 6b: 角色 DML 實測（MCP SQL，四個獨立交易；`SET ROLE` 不能放在 security definer 函式裡）**

對 `anon` 與 `authenticated` 各跑四次（每次一個交易，預期的錯誤讓交易中止後 ROLLBACK）：

```sql
begin; set local role anon; select count(*) from test.sekai_border_events; rollback;                                                    -- Expected: a number (select allowed)
begin; set local role anon; insert into test.sekai_border_rankings (event_id, chapter, rank, score, taken_at) values (182, 0, 1, 1, now()); rollback;   -- Expected: ERROR permission denied
begin; set local role anon; update test.sekai_border_events set name = name where id = 182; rollback;                                   -- Expected: ERROR permission denied
begin; set local role anon; delete from test.sekai_border_events where id = -1; rollback;                                               -- Expected: ERROR permission denied
```

（把 `anon` 換成 `authenticated` 再跑一輪。）Task 8 Step 1 對 public 以同樣四句 × 兩角色驗收。

- [ ] **Step 7: Commit**

```bash
cd /home/cholate/sekai-border && git add supabase scripts/render-sql.js test/integration && git commit -m "feat: Supabase schema（約束、唯一最終列、結算交易函式、以舊定義為本的相容 view、RLS/grants）與 test schema 整合測試"
```

---

### Task 3b: 容量實測（spec §3.4）

**Files:** Create `scripts/capacity.sql`（在 test schema 跑）、`docs/superpowers/plans/capacity-2026-10.md`（實測紀錄）

- [ ] **Step 1: 載入一期分量的快照並量測（每個語句各自一個 MCP `execute_sql` 呼叫，共 8 個；`VACUUM` 不能在交易內）**

```sql
-- scripts/capacity.sql  (EVERY statement below is its own MCP execute_sql call; (3b) VACUUM must be alone)
-- (1a) the event row
insert into test.sekai_border_events (id, name, start_at, aggregate_at, ranking_announce_at) values (900, 'capacity', '2026-01-01T00:00:00Z', '2026-01-10T00:00:00Z', '2026-01-10T00:10:00Z');
-- (1b) one event's worth of 5-minute snapshots: 9 days x 288 slots x 30 ranks = 77,760 rows
insert into test.sekai_border_rankings (event_id, chapter, rank, score, taken_at, is_final)
select 900, 0, r, 1000000 + s, '2026-01-01T00:00:00Z'::timestamptz + (s * interval '5 minutes'), false
from generate_series(0, 2591) s, unnest(array[1,2,3,4,5,6,7,8,9,10,20,30,40,50,60,70,80,90,100,200,300,400,500,1000,1500,2000,2500,3000,5000,10000]) r;
-- (2) measure live
select 'live' as stage, pg_size_pretty(pg_total_relation_size('test.sekai_border_rankings')) as total, pg_size_pretty(pg_relation_size('test.sekai_border_rankings')) as heap, pg_size_pretty(pg_indexes_size('test.sekai_border_rankings')) as idx, count(*) from test.sekai_border_rankings;
-- (3a) finalize (compacts to hourly)
select test.sekai_border_finalize(900, (select jsonb_agg(jsonb_build_object('chapter',0,'rank',r,'score',1)) from unnest(array[1,2,3,4,5,6,7,8,9,10,20,30,40,50,60,70,80,90,100,200,300,400,500,1000,1500,2000,2500,3000,5000,10000]) r));
-- (3b) its own call:
vacuum (full, analyze) test.sekai_border_rankings;
-- (4) measure compacted
select 'compacted' as stage, pg_size_pretty(pg_total_relation_size('test.sekai_border_rankings')) as total, pg_size_pretty(pg_relation_size('test.sekai_border_rankings')) as heap, pg_size_pretty(pg_indexes_size('test.sekai_border_rankings')) as idx, count(*) from test.sekai_border_rankings;
-- (5)
delete from test.sekai_border_rankings where event_id = 900;
-- (6)
delete from test.sekai_border_events where id = 900;
```

Expected：(2) 約 7.8 萬列；(4) 約 6,510 列（216 小時 × 30 + 30 最終）。`vacuum` 若 MCP 拒絕，由 user 以 psql 執行同一句。

- [ ] **Step 2: 記錄與判定**

把兩個 stage 的 total/heap/idx 寫進 `capacity-2026-10.md`，並算：穩態 = live_total + 36 × compacted_total + 1 MB；年增 = 36 × compacted_total。Expected：穩態 < 30 MB、年增 < 15 MB。若不達標：第一個手段是 `drop index sekai_border_rankings_event_chapter_time`（主鍵已含 `event_id, chapter`），重量一次並記錄；仍不達標 → 停下來回報 user，不進 Task 8。

- [ ] **Step 3: Commit** — `git add scripts/capacity.sql docs/superpowers/plans/capacity-2026-10.md && git commit -m "docs: 容量實測"`

---

### Task 4: 副作用層與單輪編排（spec §4、§4.4、§4.5、§5.2、§5.3）

**Files:** Create `src/fetch.js`、`src/db.js`、`src/metadata.js`、`src/finalize.js`、`src/run.js`（`src/log.js` 已在 Task 1 建立）；Test `test/run.test.js`、`test/metadata.test.js`、`test/integration/run.test.js`

**Interfaces:**
- `fetch.js`：`makeUpstream({ fetchImpl, userAgent, minIntervalMs = 0 }) → { live(), eventList(), finals(id), master(name, etag) }`。**每個 HTTP 請求**經同一個序列化閘門，間隔 ≥ `minIntervalMs`；10 秒逾時涵蓋 body；非 2xx → `UpstreamError('fetch','http_<status>')`；JSON 失敗 → `'json'`；無重試。`master` 回 `{status: 200|304, etag, body}`。
- `db.js`：`makeDb(client)` → `loadKnown(id)`、`loadStartedLatest(now)`、`loadEligible(now)`、`insertEvent(row)`、`insertSnapshot(rows, slot) → number`（**該語句實際插入數**，用 `upsert(...).select('rank')`）、`finalize(id, finals)`、`loadMetadataCandidate(now)`、`updateMetadata(id, patch)`。失敗 throw `DbError(phase)`。
- `metadata.js`：`repairOne({ db, upstream, now, cache })`；三個 master 請求任一網路失敗 → 只更新 `metadata_checked_at`。
- `finalize.js`：`finalizePending({ db, upstream, now }) → { finalized, deferred, failed }`。
- `run.js`：`runOnce({ db, upstream, now, wlIngest, cache }) → { status, body }`，契約 = spec §4.2 末段。

- [ ] **Step 1: 寫失敗的編排測試（真 `makeUpstream` + 以 URL 計數的 fake `fetchImpl`；fake db）**

```js
// test/run.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runOnce } from '../src/run.js';
import { makeUpstream } from '../src/fetch.js';
import { DbError } from '../src/errors.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
const T = (s) => new Date(s);
const json = (body, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });

// Routes URLs to fixture bodies; counts every HTTP request by kind.
function fakeFetch(over = {}) {
    const counts = { top100: 0, border: 0, list: 0, finalBorder: 0, finalTop100: 0, master: 0 };
    const impl = async (url) => {
        const u = String(url);
        if (u.endsWith('/event/live/top100')) { counts.top100++; return over.liveTop100?.() ?? json(fx('live-top100')); }
        if (u.endsWith('/event/live/border')) { counts.border++; return over.liveBorder?.() ?? json(fx('live-border')); }
        if (u.endsWith('/event/list')) { counts.list++; return json(over.list?.() ?? fx('event-list')); }
        const m = u.match(/\/event\/(\d+)\/(border|top100)$/);
        if (m) { const id = Number(m[1]); if (m[2] === 'border') { counts.finalBorder++; return over.finalBorder?.(id) ?? json({ ...fx('final-border-181'), eventId: id }); } counts.finalTop100++; return json(fx('final-top100-181')); }
        if (u.includes('raw.githubusercontent.com')) { counts.master++; if (over.masterFail) return json({}, 500); const name = u.split('/').pop().replace('.json', ''); return json(fx('master-' + name), 200, { etag: 'E1' }); }
        throw new Error('unexpected url ' + u);
    };
    return { impl, counts };
}
const upstreamWith = (ff) => makeUpstream({ fetchImpl: ff.impl, userAgent: 'test' });

function fakeDb(state = {}) {
    const s = { events: [], snapshots: [], finalized: [], ...state };
    const fail = (phase) => { if (s.failAt === phase) throw new DbError(phase, 'injected'); };
    return { s,
        loadKnown: async (id) => { fail('db-read'); return s.events.find((e) => e.id === id) ?? null; },
        loadStartedLatest: async (now) => { fail('db-read'); return s.events.filter((e) => e.start_at <= now).sort((a, b) => b.id - a.id)[0] ?? null; },
        loadEligible: async (now) => { fail('finalize-scan'); return s.events.filter((e) => e.finalized_at == null && now >= new Date(e.ranking_announce_at.getTime() + 15 * 60000)); },
        insertEvent: async (row) => { fail('event-write'); s.events.push({ finalized_at: null, chapters: [], metadata_status: 'pending', metadata_miss_count: 0, metadata_checked_at: null, ...row, start_at: new Date(row.start_at), aggregate_at: new Date(row.aggregate_at), ranking_announce_at: new Date(row.ranking_announce_at) }); },
        insertSnapshot: async (rows, slot) => { fail('snapshot-write'); let n = 0; for (const r of rows) { const k = `${r.event_id}:${r.chapter}:${r.rank}:${slot.toISOString()}`; if (!s.snapshots.includes(k)) { s.snapshots.push(k); n++; } } return n; },
        finalize: async (id) => { fail('finalize'); s.finalized.push(id); s.events.find((x) => x.id === id).finalized_at = new Date(); return { finalized: true, already: false }; },
        loadMetadataCandidate: async () => { fail('metadata'); return s.events.find((e) => e.metadata_status === 'pending') ?? null; },
        updateMetadata: async (id, patch) => { fail('metadata'); Object.assign(s.events.find((e) => e.id === id), patch); },
    };
}
const liveEvent = () => { const t = fx('live-top100'); return { id: t.id, name: t.name, start_at: T(t.start_at), aggregate_at: T(t.aggregate_at), ranking_announce_at: T(t.ranking_announce_at), finalized_at: null, chapters: [], metadata_status: 'complete', metadata_miss_count: 0 }; };
const run = (db, ff, now) => runOnce({ db, upstream: upstreamWith(ff), now: T(now), cache: {} });

test('bootstrap: empty db -> insert event, 30 rows, 200; HTTP = top100 1, border 1, list 1, master 3', async () => {
    const ff = fakeFetch(); const db = fakeDb();
    const r = await run(db, ff, '2026-10-15T00:03:00Z');
    assert.equal(r.status, 200); assert.equal(r.body.branch, 'current'); assert.equal(r.body.inserted, 30); assert.equal(r.body.slot, '2026-10-15T00:00:00.000Z'); assert.equal(r.body.metadata_repaired, db.s.events[0].id);
    assert.deepEqual(ff.counts, { top100: 1, border: 1, list: 1, finalBorder: 0, finalTop100: 0, master: 3 });
});
test('current: known complete event -> HTTP exactly 2; second call same slot inserts 0', async () => {
    const ff = fakeFetch(); const db = fakeDb({ events: [liveEvent()] });
    const a = await run(db, ff, '2026-10-15T00:03:00Z'); const b = await run(db, ff, '2026-10-15T00:04:30Z');
    assert.equal(a.body.inserted, 30); assert.equal(b.body.inserted, 0); assert.deepEqual(ff.counts, { top100: 2, border: 2, list: 0, finalBorder: 0, finalTop100: 0, master: 0 });
});
test('frozen: no snapshot, no finals; due with unpublished finals: finalize_deferred, 200, HTTP 2 + 2', async () => {
    const ff = fakeFetch({ finalBorder: (id) => json({ ...fx('final-border-181'), eventId: id, borderRankings: [] }) }); const db = fakeDb({ events: [liveEvent()] });
    const f = await run(db, ff, '2026-10-19T13:05:00Z'); assert.equal(f.body.branch, 'frozen'); assert.equal(f.body.inserted, 0); assert.equal(ff.counts.finalBorder, 0);
    const d = await run(db, ff, '2026-10-19T13:30:00Z'); assert.equal(d.status, 200); assert.equal(d.body.branch, 'due'); assert.equal(d.body.finalize_deferred.length, 1); assert.equal(ff.counts.finalBorder, 1); assert.equal(ff.counts.finalTop100, 1);
});
test('eligible pending events are finalized on a normal current round; one failing event -> 500 with snapshots written and others finalized', async () => {
    const old = (id) => ({ ...liveEvent(), id, name: 'old' + id, start_at: T('2026-10-01T07:00:00Z'), aggregate_at: T('2026-10-09T12:59:59Z'), ranking_announce_at: T('2026-10-09T13:09:59Z') });
    const ff = fakeFetch({ finalBorder: (id) => id === 180 ? json({}, 500) : json({ ...fx('final-border-181'), eventId: id }) });
    const db = fakeDb({ events: [old(180), old(181), liveEvent()] });
    const r = await run(db, ff, '2026-10-15T00:03:00Z');
    assert.equal(r.status, 500); assert.equal(r.body.inserted, 30); assert.deepEqual(r.body.finalized, [181]); assert.equal(r.body.finalize_failed[0].id, 180); assert.equal(r.body.finalize_failed[0].reason, 'fetch:http_500');
});
test('validate failure short-circuits: 500 / error / validate / event_mismatch; HTTP exactly 2; no finals, no master', async () => {
    const ff = fakeFetch({ liveBorder: () => json({ ...fx('live-border'), id: fx('live-border').id + 1 }) });
    const db = fakeDb({ events: [{ ...liveEvent(), id: 181, metadata_status: 'pending', ranking_announce_at: T('2026-10-09T13:09:59Z'), aggregate_at: T('2026-10-09T12:59:59Z'), start_at: T('2026-10-01T07:00:00Z') }] });
    const r = await run(db, ff, '2026-10-15T00:03:00Z');
    assert.equal(r.status, 500); assert.equal(r.body.branch, 'error'); assert.equal(r.body.phase, 'validate'); assert.equal(r.body.error_code, 'event_mismatch'); assert.deepEqual(r.body.partial.inserted, 0);
    assert.deepEqual(ff.counts, { top100: 1, border: 1, list: 0, finalBorder: 0, finalTop100: 0, master: 0 });
});
test('a future event row in the db does not change started-latest: known live event stays current', async () => {
    const ff = fakeFetch(); const db = fakeDb({ events: [liveEvent(), { ...liveEvent(), id: 190, start_at: T('2027-01-01T00:00:00Z'), aggregate_at: T('2027-01-09T00:00:00Z'), ranking_announce_at: T('2027-01-09T00:10:00Z') }] });
    const r = await run(db, ff, '2026-10-15T00:03:00Z'); assert.equal(r.status, 200); assert.equal(r.body.branch, 'current');
});
test('one deferred and one failed in the same round -> 500; not-yet-eligible pending untouched; failed event retried next round -> 200', async () => {
    const old = (id, ann) => ({ ...liveEvent(), id, name: 'e' + id, start_at: T('2026-10-01T07:00:00Z'), aggregate_at: T('2026-10-09T12:59:59Z'), ranking_announce_at: T(ann) });
    let flaky = true;
    const ff = fakeFetch({ finalBorder: (id) => id === 180 ? json({ ...fx('final-border-181'), eventId: 180, borderRankings: [] }) : (id === 181 && flaky) ? json({}, 500) : json({ ...fx('final-border-181'), eventId: id }) });
    const db = fakeDb({ events: [old(180, '2026-10-09T13:09:59Z'), old(181, '2026-10-09T13:09:59Z'), old(179, '2026-10-14T23:55:00Z'), liveEvent()] });
    const r1 = await run(db, ff, '2026-10-15T00:03:00Z');
    assert.equal(r1.status, 500); assert.deepEqual(r1.body.finalize_deferred.map((x) => x.id), [180]); assert.deepEqual(r1.body.finalize_failed.map((x) => x.id), [181]);
    assert.equal(db.s.events.find((e) => e.id === 179).finalized_at, null);
    flaky = false; const r2 = await run(db, ff, '2026-10-15T00:08:00Z');
    assert.equal(r2.status, 200); assert.deepEqual(r2.body.finalized, [181]); assert.deepEqual(r2.body.finalize_deferred.map((x) => x.id), [180]);
});
test('metadata candidates: a missing row older than 30 days costs exactly one master request when still absent', async () => {
    const ff = fakeFetch(); const ghost = { ...liveEvent(), id: 999999, name: 'ghost', metadata_status: 'missing', metadata_checked_at: T('2026-08-01T00:00:00Z'), start_at: T('2026-07-01T00:00:00Z'), aggregate_at: T('2026-07-09T00:00:00Z'), ranking_announce_at: T('2026-07-09T00:10:00Z'), finalized_at: T('2026-07-09T01:00:00Z') };
    const db = fakeDb({ events: [ghost, liveEvent()] }); db.loadMetadataCandidate = async () => ghost;
    const r = await run(db, ff, '2026-10-15T00:03:00Z'); assert.equal(r.status, 200); assert.equal(ff.counts.master, 1);
});
test('regress short-circuits', async () => {
    const ff = fakeFetch(); const db = fakeDb({ events: [{ ...liveEvent(), id: 999, start_at: T('2026-10-01T00:00:00Z') }] });
    const r = await run(db, ff, '2026-10-15T00:03:00Z'); assert.equal(r.status, 500); assert.equal(r.body.phase, 'regress');
    assert.deepEqual(ff.counts, { top100: 1, border: 1, list: 0, finalBorder: 0, finalTop100: 0, master: 0 });
});
test('stale-live: finalized live event -> 200, nothing inserted, exactly the two live requests', async () => {
    const ff = fakeFetch(); const db = fakeDb({ events: [{ ...liveEvent(), finalized_at: T('2026-10-19T14:00:00Z') }] });
    const r = await run(db, ff, '2026-10-20T00:03:00Z'); assert.equal(r.status, 200); assert.equal(r.body.branch, 'stale-live'); assert.equal(r.body.inserted, 0);
    assert.deepEqual(ff.counts, { top100: 1, border: 1, list: 0, finalBorder: 0, finalTop100: 0, master: 0 });
});
test('pre-start: nothing inserted, branch pre-start, scan still runs', async () => {
    const t = fx('live-top100'), b = fx('live-border');
    const fut = { start_at: '2026-10-21T07:00:00Z', aggregate_at: '2026-10-29T12:59:59Z', ranking_announce_at: '2026-10-29T13:09:59Z' };
    const ff = fakeFetch({ liveTop100: () => json({ ...t, id: 183, ...fut }), liveBorder: () => json({ ...b, id: 183, ...fut }), list: () => [...fx('event-list').filter((e) => e.id !== 183), { id: 183, name: 'next', chapters: [], closed_at: fut.aggregate_at, ...fut }] });
    const db = fakeDb({ events: [liveEvent()] });
    const r = await run(db, ff, '2026-10-20T00:03:00Z');
    assert.equal(r.status, 200); assert.equal(r.body.branch, 'pre-start'); assert.equal(r.body.inserted, 0); assert.equal(db.s.events.length, 1); assert.deepEqual(ff.counts, { top100: 1, border: 1, list: 1, finalBorder: 0, finalTop100: 0, master: 0 });
});
for (const phase of ['db-read', 'event-write', 'snapshot-write', 'finalize-scan', 'metadata']) {
    test(`db failure at ${phase} -> 500 with phase and preserved partial`, async () => {
        const ff = fakeFetch(); const db = fakeDb({ events: phase === 'db-read' || phase === 'event-write' ? [] : [{ ...liveEvent(), metadata_status: 'pending' }], failAt: phase });
        const r = await run(db, ff, '2026-10-15T00:03:00Z');
        assert.equal(r.status, 500); assert.equal(r.body.branch, 'error'); assert.equal(r.body.phase, phase);
        assert.equal(r.body.partial.inserted, phase === 'finalize-scan' || phase === 'metadata' ? 30 : 0);
    });
}
test('metadata DB failure on the update (not only the candidate query) is phase metadata', async () => {
    const ff = fakeFetch(); const db = fakeDb({ events: [{ ...liveEvent(), metadata_status: 'pending' }] });
    db.updateMetadata = async () => { throw new DbError('metadata', 'injected-update'); };
    const r = await run(db, ff, '2026-10-15T00:03:00Z'); assert.equal(r.body.phase, 'metadata'); assert.equal(r.body.partial.inserted, 30);
});
test('fetch timeout covers body parsing', async () => {
    const slowBody = { ok: true, status: 200, headers: { get: () => null }, json: () => new Promise(() => {}) };
    const up = makeUpstream({ fetchImpl: async () => slowBody, userAgent: 't', timeoutMs: 50 });
    await assert.rejects(up.eventList(), (e) => e.phase === 'fetch' && e.code === 'timeout');
});
test('minIntervalMs spaces every HTTP request, including the two inside finals()', async () => {
    const stamps = []; const ff = fakeFetch(); const impl = async (u) => { stamps.push(Date.now()); return ff.impl(u); };
    const up = makeUpstream({ fetchImpl: impl, userAgent: 't', minIntervalMs: 30 });
    await up.finals(181); await up.eventList();
    assert.equal(stamps.length, 3); for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i] - stamps[i - 1] >= 29, `gap ${stamps[i] - stamps[i - 1]}`);
});
```

- [ ] **Step 2: 跑測試確認失敗** — `node --test test/run.test.js 2>&1 | head -3` → `Cannot find module`。

- [ ] **Step 3: 實作**

```js
// src/fetch.js
import { UpstreamError } from './errors.js';
const BASE = 'https://api.hisekai.org/tw';
const MASTER = 'https://raw.githubusercontent.com/Sekai-World/sekai-master-db-tc-diff/main/';

// All upstream HTTP goes through one gate so a backfill can enforce >= minIntervalMs between EVERY request.
export function makeUpstream({ fetchImpl = globalThis.fetch, userAgent = 'sekai-border', minIntervalMs = 0, timeoutMs = 10000 } = {}) {
    let last = 0; let chain = Promise.resolve();
    const gate = () => (chain = chain.then(async () => { const wait = last + minIntervalMs - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); last = Date.now(); }));
    async function getJson(url, extraHeaders = {}) {
        await gate();
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            let res;
            try { res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json', ...extraHeaders }, signal: ctrl.signal }); }
            catch (e) { throw new UpstreamError('fetch', e.name === 'AbortError' ? 'timeout' : 'network', { url }); }
            if (res.status === 304) return { status: 304, etag: res.headers.get('etag'), body: null };
            if (!res.ok) throw new UpstreamError('fetch', `http_${res.status}`, { url });
            // Body parsing races the same timer: a stalled body must not hang the round.
            const body = await Promise.race([res.json().catch(() => { throw new UpstreamError('fetch', 'json', { url }); }), new Promise((_, rej) => ctrl.signal.addEventListener('abort', () => rej(new UpstreamError('fetch', 'timeout', { url }))))]);
            return { status: 200, etag: res.headers.get('etag'), body };
        } finally { clearTimeout(t); }
    }
    return {
        async live() { const [t, b] = await Promise.all([getJson(`${BASE}/event/live/top100`), getJson(`${BASE}/event/live/border`)]); return { top100: t.body, border: b.body }; }, // parallel (spec §4.1); the gate still spaces them when minIntervalMs > 0
        async eventList() { return (await getJson(`${BASE}/event/list`)).body; },
        async finals(id) { const b = await getJson(`${BASE}/event/${id}/border`); const t = await getJson(`${BASE}/event/${id}/top100`); return { border: b.body, top100: t.body }; },
        async master(name, etag) { return getJson(MASTER + name, etag ? { 'If-None-Match': etag } : {}); },
    };
}
```

```js
// src/db.js
// The only module that talks to supabase-js. Every method throws DbError(phase) on {error}.
import { DbError } from './errors.js';
const toDates = (e) => e && ({ ...e, start_at: new Date(e.start_at), aggregate_at: new Date(e.aggregate_at), ranking_announce_at: new Date(e.ranking_announce_at), finalized_at: e.finalized_at ? new Date(e.finalized_at) : null, metadata_checked_at: e.metadata_checked_at ? new Date(e.metadata_checked_at) : null });
const chk = (phase, { error, data }) => { if (error) throw new DbError(phase, error.message); return data; };

export function makeDb(client) {
    const ev = () => client.from('sekai_border_events'); const rk = () => client.from('sekai_border_rankings');
    return {
        async loadKnown(id) { return toDates(chk('db-read', await ev().select('*').eq('id', id).maybeSingle())); },
        async loadStartedLatest(now) { return toDates(chk('db-read', await ev().select('*').lte('start_at', now.toISOString()).order('id', { ascending: false }).limit(1).maybeSingle())); },
        async loadEligible(now) { const cutoff = new Date(now.getTime() - 15 * 60000).toISOString(); return chk('finalize-scan', await ev().select('*').is('finalized_at', null).lte('ranking_announce_at', cutoff).order('id')).map(toDates); },
        async insertEvent(row) { chk('event-write', await ev().insert(row)); },
        // PostgREST returns only the rows this statement actually inserted when ON CONFLICT DO NOTHING skips the rest.
        async insertSnapshot(rows, slot) { const data = chk('snapshot-write', await rk().upsert(rows.map((r) => ({ ...r, taken_at: slot.toISOString(), is_final: false })), { onConflict: 'event_id,chapter,rank,taken_at,is_final', ignoreDuplicates: true }).select('rank')); return data.length; },
        async finalize(id, finals) { return chk('finalize', await client.rpc('sekai_border_finalize', { p_event_id: id, p_finals: finals })); },
        async loadMetadataCandidate(now) {
            const h6 = new Date(now.getTime() - 6 * 3600000).toISOString(), d30 = new Date(now.getTime() - 30 * 86400000).toISOString();
            return toDates(chk('metadata', await ev().select('*').or(`and(metadata_status.eq.pending,or(metadata_checked_at.is.null,metadata_checked_at.lt.${h6})),and(metadata_status.in.(missing,mismatch),metadata_checked_at.lt.${d30})`).order('id').limit(1).maybeSingle()));
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
    const touch = async () => { await db.updateMetadata(row.id, { metadata_checked_at: now.toISOString() }); return { repaired: null }; };
    let events, ec, cards;
    try {
        const r = await upstream.master('events.json', cache.etag);
        if (r.status === 200) { cache.etag = r.etag; cache.events = r.body; }
        events = cache.events;
    } catch { return touch(); }
    const m = events.find((e) => e.id === row.id);
    if (!m) {
        const miss = row.metadata_miss_count + 1;
        const old = now.getTime() - row.aggregate_at.getTime() >= 7 * 86400000;
        await db.updateMetadata(row.id, { metadata_miss_count: miss, metadata_checked_at: now.toISOString(), metadata_status: miss >= 3 && old ? 'missing' : (row.metadata_status === 'missing' ? 'missing' : 'pending') });
        return { repaired: null };
    }
    if (String(m.name ?? '').trim() !== String(row.name).trim()) { await db.updateMetadata(row.id, { metadata_status: 'mismatch', metadata_miss_count: 0, metadata_checked_at: now.toISOString(), event_type: null, unit: null, bonus_characters: [] }); return { repaired: null }; }
    try { ec = (await upstream.master('eventCards.json')).body; cards = (await upstream.master('cards.json')).body; } catch { return touch(); }
    const cardIds = new Set(ec.filter((x) => x.eventId === row.id).map((x) => x.cardId));
    const chars = [...new Set(cards.filter((c) => cardIds.has(c.id)).map((c) => c.characterId))].sort((a, b) => a - b);
    await db.updateMetadata(row.id, { event_type: m.eventType, unit: m.unit ?? null, bonus_characters: chars, metadata_status: 'complete', metadata_miss_count: 0, metadata_checked_at: now.toISOString() });
    return { repaired: row.id };
}
```

```js
// src/finalize.js
import { validateFinal } from './validate.js';
import { isEligibleForFinalize } from './state.js';
import { log } from './log.js';
// Tries every eligible event independently (spec §4.2 step 3).
export async function finalizePending({ db, upstream, now }) {
    const out = { finalized: [], deferred: [], failed: [] };
    const eligible = (await db.loadEligible(now)).filter((e) => isEligibleForFinalize(e, now));
    for (const e of eligible) {
        try {
            const { border, top100 } = await upstream.finals(e.id);
            const { rows, deferred } = validateFinal(e.id, border, top100, e.chapters ?? []);
            if (deferred) { out.deferred.push({ id: e.id, reason: 'not_published' }); continue; }
            const r = await db.finalize(e.id, rows); out.finalized.push(e.id); log('info', 'finalized', { event_id: e.id, ...r });
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
    try { const { top100, border } = await upstream.live(); ({ event: live, rows } = validateLive(top100, border, { wlIngest })); }
    catch (e) { log('error', 'live failed', { phase: e.phase, code: e.code, ...(e.detail ?? {}) }); return error(e.phase ?? 'fetch', e.code ?? 'unknown'); }

    let known, startedLatest, listEntry = null;
    try { known = await db.loadKnown(live.id); startedLatest = await db.loadStartedLatest(now); } catch (e) { return error('db-read', e.message, live.id); }
    let preStart = false;
    if (!known && !(startedLatest && live.id < startedLatest.id)) {
        try { listEntry = validateEventListEntry(await upstream.eventList(), live.id, live); } catch (e) { log('error', 'event list failed', { phase: e.phase, code: e.code }); return error(e.phase ?? 'event-list', e.code ?? 'unknown', live.id); }
        preStart = new Date(listEntry.start_at) > now;
    }
    const d = decide({ live, known, startedLatest, now, preStart });
    if (d.ensure === 'regress') { log('error', 'regress', { live_id: live.id, latest_id: startedLatest?.id }); return error('regress', 'live_id_below_latest', live.id); }
    if (d.ensure === 'insert') {
        const chapters = (listEntry.chapters ?? []).map((c) => ({ chapter: c.chapter, chapter_id: c.id, character_id: c.character, start_at: c.start_at, aggregate_at: c.aggregate_at, ranking_announce_at: c.ranking_announce_at }));
        if (!String(listEntry.name ?? '').trim()) return error('event-list', 'name_empty', live.id);
        try { await db.insertEvent({ id: live.id, name: String(listEntry.name).trim(), start_at: live.start_at.toISOString(), aggregate_at: live.aggregate_at.toISOString(), ranking_announce_at: live.ranking_announce_at.toISOString(), chapters, metadata_status: 'pending' }); } catch (e) { return error('event-write', e.message, live.id); }
    }
    if (d.branch === 'current') { try { partial.inserted = await db.insertSnapshot(rows.map((r) => ({ event_id: live.id, ...r })), slot); } catch (e) { return error('snapshot-write', e.message, live.id); } }

    let fin; try { fin = await finalizePending({ db, upstream, now }); } catch (e) { return error('finalize-scan', e.message, live.id); }
    Object.assign(partial, { finalized: fin.finalized, finalize_deferred: fin.deferred, finalize_failed: fin.failed });
    let repaired = null; try { ({ repaired } = await repairOne({ db, upstream, now, cache })); } catch (e) { return error('metadata', e.message, live.id); }

    const body = { slot: slot.toISOString(), event_id: live.id, branch: d.branch, inserted: partial.inserted, finalized: fin.finalized, finalize_deferred: fin.deferred, finalize_failed: fin.failed, metadata_repaired: repaired };
    log(fin.failed.length ? 'error' : 'info', 'round', body);
    return { status: fin.failed.length ? 500 : 200, body };
}
```

- [ ] **Step 4: 跑單元測試** — `npm test 2>&1 | grep -E "ℹ (pass|fail)|not ok"` → `fail 0`。

- [ ] **Step 5: metadata 單元測試**

```js
// test/metadata.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { repairOne } from '../src/metadata.js';
const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
const T = (s) => new Date(s);
const row = (over = {}) => ({ id: 182, name: '與你相繫的Heart Beat', aggregate_at: T('2026-10-19T12:59:59Z'), metadata_status: 'pending', metadata_miss_count: 0, metadata_checked_at: null, ...over });
const mk = (r, o = {}) => {
    const patches = []; const db = { loadMetadataCandidate: async () => r, updateMetadata: async (id, p) => patches.push(p) };
    const upstream = { master: async (name, etag) => { if (o.failOn === name || o.failOn === 'all') throw new Error('net'); if (name === 'events.json' && etag === 'E1') return { status: 304, etag: 'E1', body: null }; return { status: 200, etag: 'E1', body: o[name] ?? fx('master-' + name.replace('.json', '')) }; } };
    return { db, upstream, patches };
};
test('found with same name -> complete with type, unit, bonus characters', async () => {
    const m = mk(row()); const r = await repairOne({ ...m, now: T('2026-10-16T00:00:00Z'), cache: {} });
    assert.equal(r.repaired, 182); assert.equal(m.patches[0].metadata_status, 'complete'); assert.equal(m.patches[0].event_type, 'marathon'); assert.deepEqual(m.patches[0].bonus_characters, [1, 2, 3, 4, 25]);
});
test('found with different name -> mismatch, miss count reset, attributes cleared (even when previously set)', async () => {
    const m = mk(row({ name: 'other', metadata_miss_count: 2, event_type: 'marathon', unit: 'light_sound', bonus_characters: [1, 2] })); await repairOne({ ...m, now: T('2026-10-16T00:00:00Z'), cache: {} });
    assert.deepEqual(m.patches[0], { metadata_status: 'mismatch', metadata_miss_count: 0, metadata_checked_at: '2026-10-16T00:00:00.000Z', event_type: null, unit: null, bonus_characters: [] });
});
test('absent: miss 1, 2 stay pending; third miss -> missing only when ended 7+ days ago', async () => {
    const r = row({ id: 999999 });
    let m = mk(r); await repairOne({ ...m, now: T('2026-10-16T00:00:00Z'), cache: {} }); assert.deepEqual([m.patches[0].metadata_status, m.patches[0].metadata_miss_count], ['pending', 1]);
    m = mk({ ...r, metadata_miss_count: 2 }); await repairOne({ ...m, now: T('2026-10-20T00:00:00Z'), cache: {} }); assert.equal(m.patches[0].metadata_status, 'pending');
    m = mk({ ...r, metadata_miss_count: 2 }); await repairOne({ ...m, now: T('2026-11-01T00:00:00Z'), cache: {} }); assert.equal(m.patches[0].metadata_status, 'missing');
});
test('miss -> miss -> mismatch -> miss ends with count 1', async () => {
    let r = row({ id: 182, name: 'other' }); let m;
    m = mk({ ...r, id: 999999, metadata_miss_count: 0 }); await repairOne({ ...m, now: T('2026-10-16T00:00:00Z'), cache: {} }); assert.equal(m.patches[0].metadata_miss_count, 1);
    m = mk({ ...r, id: 999999, metadata_miss_count: 1 }); await repairOne({ ...m, now: T('2026-10-16T06:00:00Z'), cache: {} }); assert.equal(m.patches[0].metadata_miss_count, 2);
    m = mk({ ...r, metadata_miss_count: 2 }); await repairOne({ ...m, now: T('2026-10-16T12:00:00Z'), cache: {} }); assert.equal(m.patches[0].metadata_status, 'mismatch'); assert.equal(m.patches[0].metadata_miss_count, 0);
    m = mk({ ...r, id: 999999, metadata_miss_count: 0 }); await repairOne({ ...m, now: T('2026-10-16T18:00:00Z'), cache: {} }); assert.equal(m.patches[0].metadata_miss_count, 1);
});
test('any of the three master fetches failing only touches checked_at', async () => {
    for (const failOn of ['events.json', 'eventCards.json', 'cards.json']) {
        const m = mk(row({ metadata_miss_count: 1 }), { failOn }); await repairOne({ ...m, now: T('2026-10-16T00:00:00Z'), cache: {} });
        assert.deepEqual(Object.keys(m.patches.at(-1)), ['metadata_checked_at'], failOn);
    }
});
test('ETag 304 reuses cached events', async () => {
    const m = mk(row()); const r = await repairOne({ ...m, now: T('2026-10-16T00:00:00Z'), cache: { etag: 'E1', events: fx('master-events') } }); assert.equal(r.repaired, 182);
});
```

Run `npm test` → `fail 0`。

- [ ] **Step 6: 整合測試（真 DB、fake 上游；含同 slot 並行）**

```js
// test/integration/run.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { admin, truncate, insertEvent } from './helpers.js';
import { makeDb } from '../../src/db.js';
import { runOnce } from '../../src/run.js';
const fx = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8'));
const T = (s) => new Date(s);
const upstream = (published = true) => ({ live: async () => ({ top100: fx('live-top100'), border: fx('live-border') }), eventList: async () => fx('event-list'), finals: async (id) => ({ border: { ...fx('final-border-181'), eventId: id, ...(published ? {} : { borderRankings: [] }) }, top100: fx('final-top100-181') }), master: async (name) => ({ status: 200, etag: 'x', body: fx('master-' + name.replace('.json', '')) }) });
test.beforeEach(truncate);

test('stale-live is a no-op and regress is a 500 against the real db', async () => {
    const db = makeDb(admin); const id = fx('live-top100').id;
    await admin.from('sekai_border_events').insert({ id, name: 'done', start_at: '2026-10-11T07:00:00Z', aggregate_at: '2026-10-19T12:59:59Z', ranking_announce_at: '2026-10-19T13:09:59Z', finalized_at: '2026-10-19T14:00:00Z' });
    const a = await runOnce({ db, upstream: upstream(), now: T('2026-10-20T00:03:00Z'), cache: {} }); assert.equal(a.status, 200); assert.equal(a.body.branch, 'stale-live'); assert.equal(a.body.inserted, 0);
    await admin.from('sekai_border_events').insert({ id: 999, name: 'ahead', start_at: '2026-10-01T07:00:00Z', aggregate_at: '2026-10-09T12:59:59Z', ranking_announce_at: '2026-10-09T13:09:59Z', finalized_at: '2026-10-09T14:00:00Z' });
    await admin.from('sekai_border_events').delete().eq('id', id);
    const b = await runOnce({ db, upstream: upstream(), now: T('2026-10-20T00:03:00Z'), cache: {} }); assert.equal(b.status, 500); assert.equal(b.body.phase, 'regress');
});
test('loadMetadataCandidate (real query): due pending first by id; missing/mismatch only after 30 days; null when nothing is due', async () => {
    const db = makeDb(admin); const now = T('2026-10-20T00:00:00Z'); const ago = (h) => new Date(now.getTime() - h * 3600000).toISOString();
    await insertEvent({ id: 101, metadata_status: 'pending', metadata_checked_at: ago(5) });            // checked < 6 h ago: not due
    await insertEvent({ id: 102, metadata_status: 'missing', metadata_checked_at: ago(29 * 24) });     // < 30 d: not due
    await insertEvent({ id: 103, metadata_status: 'mismatch', metadata_checked_at: ago(31 * 24) });    // due
    await insertEvent({ id: 104, metadata_status: 'pending', metadata_checked_at: null });             // never checked: due
    await insertEvent({ id: 105, metadata_status: 'complete', metadata_checked_at: ago(400 * 24) });   // never a candidate
    assert.equal((await db.loadMetadataCandidate(now)).id, 103);
    await admin.from('sekai_border_events').update({ metadata_status: 'complete' }).eq('id', 103);
    assert.equal((await db.loadMetadataCandidate(now)).id, 104);
    await admin.from('sekai_border_events').update({ metadata_checked_at: ago(1) }).eq('id', 104);
    assert.equal(await db.loadMetadataCandidate(now), null);
});
test('bootstrap, concurrent same-slot rounds total 30, hourly round, deferred then finalized via real RPC', async () => {
    const db = makeDb(admin);
    const [a, b] = await Promise.all([runOnce({ db, upstream: upstream(), now: T('2026-10-15T00:03:00Z'), cache: {} }), runOnce({ db, upstream: upstream(), now: T('2026-10-15T00:03:30Z'), cache: {} })]);
    // one of them may hit event-write conflict (duplicate key) if both try to insert the event: that is a 500 with phase event-write; the other must succeed
    const ok = [a, b].filter((r) => r.status === 200); assert.ok(ok.length >= 1, JSON.stringify([a.body, b.body]));
    const { count } = await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true }).eq('taken_at', '2026-10-15T00:00:00Z'); assert.equal(count, 30);
    const c = await runOnce({ db, upstream: upstream(), now: T('2026-10-15T01:00:00Z'), cache: {} }); assert.equal(c.body.inserted, 30);
    await admin.from('sekai_border_events').update({ aggregate_at: '2026-10-15T01:10:00Z', ranking_announce_at: '2026-10-15T01:20:00Z' }).eq('id', fx('live-top100').id);
    const due = await runOnce({ db, upstream: upstream(false), now: T('2026-10-15T01:40:00Z'), cache: {} }); assert.equal(due.body.finalize_deferred.length, 1);
    const fin = await runOnce({ db, upstream: upstream(true), now: T('2026-10-15T01:45:00Z'), cache: {} }); assert.deepEqual(fin.body.finalized, [fx('live-top100').id]);
    const ev = await admin.from('sekai_border_events').select('finalized_at,event_type,metadata_status').eq('id', fx('live-top100').id).single(); assert.ok(ev.data.finalized_at); assert.equal(ev.data.metadata_status, 'complete');
});
```

Run `npm run test:integration` → `fail 0`。（並行 bootstrap 的 `event-write` 衝突是 spec 允許的 500：下一輪會自行恢復；測試只要求快照總數 30。）

- [ ] **Step 7: Commit** — `git add src test && git commit -m "feat: 上游抓取（請求閘門、逾時涵蓋 body）、DB 存取（實際插入數）、屬性修補、待結算掃描與單輪編排"`

---

### Task 5: HTTP 伺服器、`--once`、JWT 角色檢查、Dockerfile（spec §4.6、§5.1、§5.2、S2）

**Files:** Create `src/server.js`、`src/env.js`、`index.js`；Delete `index.cjs`、`fetch_all_rankings.cjs`；Modify `package.json`（start → `node index.js`）、`Dockerfile`（CMD 回 `index.js`）；Test `test/server.test.js`、`test/env.test.js`

- [ ] **Step 1: 寫失敗的測試**

```js
// test/env.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../src/env.js';
const jwt = (role) => 'h.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.s';
test('accepts a service_role JWT and defaults', () => { const e = loadEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: jwt('service_role') }); assert.equal(e.schema, 'public'); assert.equal(e.wlIngest, false); });
test('rejects anon role, missing vars, legacy SUPABASE_KEY; never leaks the key', () => {
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
async function withServer(handler, fn) { const srv = createServer({ handler }); await new Promise((r) => srv.listen(0, r)); try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { await new Promise((r) => srv.close(r)); } }
test('POST /run relays handler status/body', async () => { await withServer(async () => ({ status: 200, body: { ok: 1 } }), async (b) => { const r = await fetch(b + '/run', { method: 'POST' }); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: 1 }); }); });
test('other routes 404 without calling the handler', async () => { let calls = 0; await withServer(async () => { calls++; return { status: 200, body: {} }; }, async (b) => { for (const [m, p] of [['GET', '/'], ['POST', '/'], ['GET', '/run']]) assert.equal((await fetch(b + p, { method: m })).status, 404); }); assert.equal(calls, 0); });
test('handler throw -> 500 unhandled', async () => { await withServer(async () => { throw new Error('boom'); }, async (b) => { const r = await fetch(b + '/run', { method: 'POST' }); assert.equal(r.status, 500); assert.equal((await r.json()).phase, 'unhandled'); }); });
```

- [ ] **Step 2: 確認失敗** — `node --test test/env.test.js test/server.test.js 2>&1 | head -3` → `Cannot find module`。

- [ ] **Step 3: 實作**

```js
// src/env.js
export function loadEnv(env = process.env) {
    for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) if (!env[k]) throw new Error(`env: ${k} is required`);
    let role; try { role = JSON.parse(Buffer.from(env.SUPABASE_SERVICE_ROLE_KEY.split('.')[1], 'base64url').toString('utf8')).role; } catch { throw new Error('env: SUPABASE_SERVICE_ROLE_KEY is not a JWT'); }
    if (role !== 'service_role') throw new Error('env: SUPABASE_SERVICE_ROLE_KEY role must be service_role');
    return { url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, schema: env.SUPABASE_SCHEMA || 'public', botContact: env.BOT_CONTACT || 'sekai-border', wlIngest: env.WL_INGEST === 'on' };
}
```

```js
// src/server.js
import http from 'node:http';
// headersSent guard: the error path must never throw a second time (LESSONS 2026-07-28).
export function sendJson(res, status, body) { if (res.headersSent) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
export function createServer({ handler }) {
    return http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/run') return sendJson(res, 404, { error: 'not_found' });
        try { const { status, body } = await handler(); sendJson(res, status, body); }
        catch (e) { console.error(JSON.stringify({ severity: 'ERROR', msg: 'unhandled', error: String(e?.message) })); sendJson(res, 500, { branch: 'error', phase: 'unhandled', error_code: 'unhandled' }); }
    });
}
```

```js
// index.js  — `node index.js` (server) / `node index.js --once` (one round; exit 0 on 200, 1 otherwise)
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './src/env.js';
import { makeDb } from './src/db.js';
import { makeUpstream } from './src/fetch.js';
import { runOnce } from './src/run.js';
import { createServer } from './src/server.js';
const env = loadEnv();
console.log(JSON.stringify({ severity: 'INFO', msg: 'boot', supabase_ref: new URL(env.url).hostname.split('.')[0], schema: env.schema, wl_ingest: env.wlIngest, revision: process.env.K_REVISION ?? null }));
const db = makeDb(createClient(env.url, env.key, { db: { schema: env.schema } }));
const upstream = makeUpstream({ userAgent: env.botContact });
const handler = () => runOnce({ db, upstream, now: new Date(), wlIngest: env.wlIngest });
if (process.argv.includes('--once')) { const r = await handler(); console.log(JSON.stringify(r.body)); process.exit(r.status === 200 ? 0 : 1); }
else { const port = Number(process.env.PORT || 8080); createServer({ handler }).listen(port, () => console.log(JSON.stringify({ severity: 'INFO', msg: 'listening', port }))); }
```

```bash
cd /home/cholate/sekai-border && git rm -q index.cjs fetch_all_rankings.cjs && sed -i 's/CMD \["node", "index.cjs"\]/CMD ["node", "index.js"]/' Dockerfile && node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.scripts.start='node index.js';fs.writeFileSync('package.json',JSON.stringify(p,null,4)+'\n')" && grep -n "FROM\|CMD\|npm ci" Dockerfile && grep -n '"start"' package.json
```

Expected: Dockerfile `node:22-slim`、`npm ci --omit=dev`、`CMD ["node", "index.js"]`；start 為 `node index.js`。

- [ ] **Step 4: 測試、本機 `--once`、Docker**

```bash
cd /home/cholate/sekai-border && npm test 2>&1 | grep -E "ℹ (pass|fail)|not ok" && set -a && . ./.env && set +a && SUPABASE_SCHEMA=test node index.js --once; echo "once exit=$?"; docker build -t sekai-border-test . 2>&1 | tail -1 && docker run --rm --env-file .env -e SUPABASE_SCHEMA=test sekai-border-test node index.js --once; echo "container once exit=$?"; docker run --rm sekai-border-test sh -c 'test ! -e /app/.env && test ! -e /app/.git && echo "no secrets in image"'
```

Expected: 單元 `fail 0`；`no secrets in image`；兩次 `--once` 都印 boot（`supabase_ref: bwhhtfcyagqhcddzssas`、`schema: test`）與一行 body，exit 0（整合測試清空後首次是 bootstrap `inserted: 30`，同 slot 第二次 `inserted: 0`）。

- [ ] **Step 5: Commit** — `git add -A src index.js test Dockerfile package.json && git commit -m "feat: POST /run 伺服器、--once、service_role JWT 檢查；移除舊 .cjs 入口"`

---

### Task 6: 回填（含屬性）與單一交易的舊資料遷移（spec §7 步驟 4、6；S9a、S9b）

**Files:**
- Create: `scripts/confirm.js`、`scripts/backfill.js`、`scripts/migrate-legacy.js`
- Create: `supabase/migrations/0001b_exec_sql.sql.tmpl`（`sekai_border_exec_migration(p_event_id, p_cutover, p_candidate_slot, p_allow_skipped)`）
- Create: `supabase/migrations/0001d_legacy_freeze.sql.tmpl`（Scheduler 暫停後、切流量前凍結舊表的 statement trigger：舊 revision 的任何殘留寫入直接 RAISE）
- Create: `supabase/migrations/0001c_rollback_export.sql.tmpl`（`sekai_border_export_to_legacy(p_event_id) → jsonb {deleted_other_event_rows, exported, after_slot}`：觀察期回滾用的反向匯入——刪舊表裡其他期的列、只補舊表最後觀測 slot 之後的快照）
- Test: `test/backfill.test.js`、`test/integration/migrate.test.js`

**Interfaces:**
- `backfill({ db, upstream, now, from, to, log })`：先抓三個 master 檔**一次**，再對 `list` 中 `ranking_announce_at + 15 min < now` 且 id 在範圍內的期：`finalized_at` 非 null → `skipped`；否則 **upsert** events 列（含 chapters 與 master 屬性：`event_type`、`unit`、`bonus_characters`、`metadata_status` 依同名/缺席規則）→ 抓 finals → `validateFinal` → `db.finalize`。`upstream` 由呼叫端以 `minIntervalMs: 1000` 建立，所以每個 HTTP 請求都間隔 ≥ 1 秒。
- `db.upsertEvent(row)`（Task 4 的 db.js 加一個方法：`ev().upsert(row, { onConflict: 'id' })`，phase `event-write`）。
- 遷移函式 `sekai_border_exec_migration(p_event_id, p_cutover, p_candidate_slot, p_allow_skipped)` 回傳 `{inserted, deleted_candidate_rows, skipped_invalid_id_rows, skipped_partial_slot_rows, verified_slots}`；`p_candidate_slot` 是候選版本驗收那一輪寫的 slot（可 null），該 slot 以舊表觀測為準；任何斷言失敗 RAISE（整體回滾）。
- `{{legacy_schema}}.sekai_border_legacy_freeze()` 觸發器函式與同名 statement trigger（0001d）：對 `{{legacy_schema}}.event_rankings` 的 INSERT/UPDATE/DELETE/TRUNCATE 一律 RAISE `... is frozen`。

- [ ] **Step 1: 遷移與回滾匯出 template**

```sql
-- supabase/migrations/0001b_exec_sql.sql.tmpl
-- One-transaction legacy copy for ONE event (spec §7 step 4). Reads {{legacy_schema}}.event_rankings
-- (legacy, text event_id) and writes {{schema}}.sekai_border_rankings main-board rows before p_cutover.
-- p_candidate_slot: the slot written by the no-traffic validation run (Task 8 step 4); those rows are replaced by the
-- legacy observation of the same slot because the old crawler was still the system of record at that time.
-- Deterministic on rerun: destination rows that already match the staged source are left alone.
create or replace function {{schema}}.sekai_border_exec_migration(p_event_id integer, p_cutover timestamptz, p_candidate_slot timestamptz default null, p_allow_skipped integer default 0) returns jsonb
language plpgsql security definer set search_path = {{schema}}, {{legacy_schema}}, pg_temp as $$
declare n_del int; n_cand int := 0; n_ins int; n_bad int; n_partial int; n_slots int; n_mismatch int; n_total int; cnt int;
begin
    if date_trunc('minute', p_cutover) <> p_cutover or extract(minute from p_cutover)::int % 5 <> 0 then raise exception 'cutover_slot must be 5-minute aligned'; end if;
    if p_candidate_slot is not null and p_candidate_slot >= p_cutover then raise exception 'candidate_slot must be before cutover'; end if;
    if not exists (select 1 from sekai_border_events where id = p_event_id) then raise exception 'unknown event %', p_event_id; end if;

    -- (1) parse safely (nested CASE: the cast only runs on validated text), then keep this event's rows only
    create temp table parsed on commit drop as
    select case when pg_input_is_valid(event_id, 'integer') then case when event_id::int > 0 then event_id::int end end as event_id,
           rank, score, created_at, to_timestamp(floor(extract(epoch from created_at) / 300) * 300) as slot
    from {{legacy_schema}}.event_rankings;
    select count(*) into n_bad from parsed q where q.event_id is null or not exists (select 1 from sekai_border_events e where e.id = q.event_id);   -- unparseable, non-positive, or not an events row (spec §7 step 4)
    create temp table batch on commit drop as select * from parsed where event_id = p_event_id and slot < p_cutover;   -- other valid events are ignored, not counted
    select count(*) into n_total from parsed;   -- the whole legacy table: the 1% allowance is relative to it (spec §7 step 4)
    create temp table dedup on commit drop as
    select rank, score, slot, row_number() over (partition by rank, slot order by created_at desc) as rn from batch;   -- keep the latest observation per slot
    create temp table slots on commit drop as select slot, count(*) filter (where rn = 1) as n_ranks from dedup group by slot;
    create temp table src on commit drop as select p_event_id as event_id, d.rank, d.score, d.slot from dedup d join slots s on s.slot = d.slot where d.rn = 1 and s.n_ranks = 30;
    select count(*) into n_partial from dedup d join slots s on s.slot = d.slot where s.n_ranks <> 30;   -- actual rows in incomplete slots
    select count(distinct slot) into n_slots from src;
    if (select count(*) from src) = 0 then raise exception 'validated source set is empty'; end if;

    -- (2) fail closed if any destination row at a source key holds a different score. The candidate validation slot is
    --     exempt: the old crawler was the system of record then, so the legacy observation wins (3a replaces it).
    select count(*) into n_mismatch from src s join sekai_border_rankings r on r.event_id = s.event_id and r.chapter = 0 and r.rank = s.rank and r.taken_at = s.slot and r.is_final = false
    where r.score <> s.score and (p_candidate_slot is null or r.taken_at <> p_candidate_slot);
    if n_mismatch <> 0 then raise exception 'source/destination mismatch on % rows', n_mismatch; end if;

    -- (3a) candidate slot: drop every row that is not identical (key AND score) to the legacy observation -> a rerun deletes 0
    if p_candidate_slot is not null then
        delete from sekai_border_rankings r where r.event_id = p_event_id and r.chapter = 0 and r.is_final = false and r.taken_at = p_candidate_slot
            and not exists (select 1 from src s where s.rank = r.rank and s.slot = r.taken_at and s.score = r.score);
        get diagnostics n_cand = row_count;
    end if;
    -- (3b) remove this event's other pre-cutover rows that are NOT in the source set
    delete from sekai_border_rankings r where r.event_id = p_event_id and r.chapter = 0 and r.is_final = false and r.taken_at < p_cutover
        and (p_candidate_slot is null or r.taken_at <> p_candidate_slot)
        and not exists (select 1 from src s where s.rank = r.rank and s.slot = r.taken_at);
    get diagnostics n_del = row_count;

    -- (4) copy (rows already present with equal scores are skipped -> rerun inserts 0)
    insert into sekai_border_rankings (event_id, chapter, rank, score, taken_at, is_final)
    select event_id, 0, rank, score, slot, false from src on conflict (event_id, chapter, rank, taken_at, is_final) do nothing;
    get diagnostics n_ins = row_count;

    -- (5) fail-closed checks
    select count(distinct rank) into cnt from sekai_border_rankings where event_id = p_event_id and chapter = 0 and is_final = false and taken_at = p_cutover;
    if cnt <> 30 then raise exception 'cutover slot must hold exactly 30 live rows for event %, found %', p_event_id, cnt; end if;
    if (n_bad + n_partial) > greatest(p_allow_skipped, n_total / 100) then raise exception 'skipped % rows (invalid %, partial %) exceeds allowance', n_bad + n_partial, n_bad, n_partial; end if;

    return jsonb_build_object('inserted', n_ins, 'deleted_candidate_rows', n_cand + n_del, 'skipped_invalid_id_rows', n_bad, 'skipped_partial_slot_rows', n_partial, 'verified_slots', n_slots);
end $$;
revoke all on function {{schema}}.sekai_border_exec_migration(integer, timestamptz, timestamptz, integer) from public;
grant execute on function {{schema}}.sekai_border_exec_migration(integer, timestamptz, timestamptz, integer) to service_role;
```

```sql
-- supabase/migrations/0001c_rollback_export.sql.tmpl
-- Observation-period rollback helper (spec §7.1 step 2), one transaction: make the legacy table hold exactly what the old
-- crawler expects for the live event p_event_id. (1) Rows of other events are deleted here: the old crawler clears other
-- events only when the NEWEST legacy row has a different id, which after this export is never the case. (2) Snapshots are
-- copied for slots strictly after the legacy table's last observation of this event, floored to its slot (legacy
-- timestamps are second-level, slots are not, so an exact-timestamp dedup would duplicate the pre-cutover rows); when the
-- legacy table has no row of this event, the whole curve is copied. Rerun exports 0.
create or replace function {{schema}}.sekai_border_export_to_legacy(p_event_id integer) returns jsonb
language plpgsql security definer set search_path = {{schema}}, {{legacy_schema}}, pg_temp as $$
declare n_other int; n_exp int; last_slot timestamptz;
begin
    if not exists (select 1 from sekai_border_events where id = p_event_id) then raise exception 'unknown event %', p_event_id; end if;
    delete from {{legacy_schema}}.event_rankings where event_id is distinct from p_event_id::text;
    get diagnostics n_other = row_count;
    select to_timestamp(floor(extract(epoch from max(created_at)) / 300) * 300) into last_slot from {{legacy_schema}}.event_rankings where event_id = p_event_id::text;
    insert into {{legacy_schema}}.event_rankings (event_id, rank, score, created_at)
    select event_id::text, rank, score, taken_at from sekai_border_rankings
    where event_id = p_event_id and chapter = 0 and is_final = false and (last_slot is null or taken_at > last_slot)
    order by taken_at, rank;
    get diagnostics n_exp = row_count;
    return jsonb_build_object('deleted_other_event_rows', n_other, 'exported', n_exp, 'after_slot', last_slot);
end $$;
revoke all on function {{schema}}.sekai_border_export_to_legacy(integer) from public;
grant execute on function {{schema}}.sekai_border_export_to_legacy(integer) to service_role;
```

```sql
-- supabase/migrations/0001d_legacy_freeze.sql.tmpl
-- Installed while Scheduler is paused and BEFORE traffic moves to the new crawler (Task 8 step 5b), and kept through the legacy copy (step 6). The old
-- crawler has no fetch timeout and, on an event switch, deletes every legacy row of other events (index.js
-- checkAndClearOldEvent), so a straggler request from the old revision could otherwise still mutate what the migration and
-- the still-live legacy views read. With this trigger every such write fails. Dropped only by the observation-period
-- rollback runbook (step 10); the table drop in step 12 removes it for good.
create or replace function {{legacy_schema}}.sekai_border_legacy_freeze() returns trigger language plpgsql as $$
begin raise exception 'event_rankings is frozen: the new crawler owns snapshots now (sekai_border_legacy_freeze)'; end $$;
drop trigger if exists sekai_border_legacy_freeze on {{legacy_schema}}.event_rankings;
create trigger sekai_border_legacy_freeze before insert or update or delete or truncate on {{legacy_schema}}.event_rankings
    for each statement execute function {{legacy_schema}}.sekai_border_legacy_freeze();
```

- [ ] **Step 2: 整合測試先寫、先跑 RED（函式尚未套用）**

```js
// test/integration/migrate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, truncate, insertEvent } from './helpers.js';
import { ALLOWED_RANKS } from '../../src/constants.js';
const legacy = (rows) => admin.rpc('sekai_border_test_seed_legacy', { p_rows: rows }).then(({ error }) => { if (error) throw new Error(error.message); });
const run = (cutover, allow = 0, eventId = 182) => admin.rpc('sekai_border_exec_migration', { p_event_id: eventId, p_cutover: cutover, p_candidate_slot: null, p_allow_skipped: allow });
const rows = (eventId, createdAt, base = 1000, ranks = ALLOWED_RANKS) => ranks.map((rank, i) => ({ event_id: String(eventId), rank, score: base - i, created_at: createdAt }));
const live = (takenAt, base = 5000, eventId = 182) => ALLOWED_RANKS.map((rank, i) => ({ event_id: eventId, chapter: 0, rank, score: base - i, taken_at: takenAt, is_final: false }));
const ins = (r) => admin.from('sekai_border_rankings').insert(r).then(({ error }) => { if (error) throw new Error(error.message); });
const countAll = async () => (await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true })).count;
test.beforeEach(async () => {
    await truncate();
    for (const [fn, args] of [['sekai_border_test_legacy_freeze', { p_on: false }], ['sekai_border_test_clear_legacy', {}]]) { const { error } = await admin.rpc(fn, args); if (error) throw new Error(`${fn}: ${error.message}`); }   // unfreeze first, or the clear is rejected
});

test('happy path: dedup keeps latest, partial-slot rows counted, candidate rows deleted, cutover slot owned by new table, post-cutover rows untouched, other events ignored, positive-but-unknown ids counted as invalid', async () => {
    await insertEvent(); await insertEvent({ id: 181, name: 'old', start_at: '2026-10-01T07:00:00Z', aggregate_at: '2026-10-09T12:59:59Z', ranking_announce_at: '2026-10-09T13:09:59Z', finalized_at: '2026-10-09T14:00:00Z' });
    await ins([...live('2026-10-05T00:00:00Z', 700, 181), ...live('2026-10-20T11:45:00Z', 100), ...live('2026-10-20T12:05:00Z'), ...live('2026-10-20T12:10:00Z', 9000)]);   // bases >= 29: score has a >= 0 CHECK
    await legacy([...rows(181, '2026-10-05T00:00:10Z', 9), ...rows(182, '2026-10-20T11:50:10Z'), ...rows(182, '2026-10-20T11:50:40Z', 1100), ...rows(182, '2026-10-20T11:55:05Z', 1200), ...rows(182, '2026-10-20T12:00:03Z', 1300, ALLOWED_RANKS.slice(0, 29)), ...rows(182, '2026-10-20T12:05:02Z', 1400), { event_id: 'unknown_event', rank: 1, score: 1, created_at: '2026-10-20T11:55:05Z' }, { event_id: '99999999999', rank: 1, score: 1, created_at: '2026-10-20T11:55:05Z' }, { event_id: '-5', rank: 1, score: 1, created_at: '2026-10-20T11:55:05Z' }, { event_id: '777', rank: 1, score: 1, created_at: '2026-10-20T11:55:05Z' }]);   // 777 parses but is not an events row
    const r = await run('2026-10-20T12:05:00Z', 100);
    assert.equal(r.error, null, r.error?.message);
    assert.deepEqual(r.data, { inserted: 60, deleted_candidate_rows: 30, skipped_invalid_id_rows: 4, skipped_partial_slot_rows: 29, verified_slots: 2 });
    const { data } = await admin.from('sekai_border_rankings').select('taken_at,score').eq('event_id', 182).eq('rank', 1).order('taken_at');
    assert.deepEqual(data.map((d) => [new Date(d.taken_at).toISOString(), d.score]), [['2026-10-20T11:50:00.000Z', 1100], ['2026-10-20T11:55:00.000Z', 1200], ['2026-10-20T12:05:00.000Z', 5000], ['2026-10-20T12:10:00.000Z', 9000]]);   // 12:10 is after the cutover: untouched
    assert.equal((await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true }).eq('event_id', 181)).count, 30);
});
test('rerun is deterministic: inserted 0, deleted 0, same skipped counts', async () => {
    await insertEvent(); await ins(live('2026-10-20T12:05:00Z'));
    await legacy([...rows(182, '2026-10-20T11:50:10Z'), { event_id: 'x', rank: 1, score: 1, created_at: '2026-10-20T11:55:05Z' }]);
    const a = await run('2026-10-20T12:05:00Z', 5); const b = await run('2026-10-20T12:05:00Z', 5);
    assert.equal(a.error, null, a.error?.message); assert.equal(a.data.inserted, 30);
    assert.deepEqual(b.data, { ...a.data, inserted: 0, deleted_candidate_rows: 0 });
});
test('rolls back: cutover slot missing; all-invalid; allowance exceeded; unaligned; destination mismatch at a source key', async () => {
    await insertEvent(); await legacy(rows(182, '2026-10-20T11:50:10Z'));
    let r = await run('2026-10-20T12:05:00Z'); assert.match(r.error.message, /cutover slot/); assert.equal(await countAll(), 0);
    await ins(live('2026-10-20T12:05:00Z'));
    await admin.rpc('sekai_border_test_clear_legacy', {}); await legacy([{ event_id: 'unknown_event', rank: 1, score: 1, created_at: '2026-10-20T11:55:05Z' }]);
    r = await run('2026-10-20T12:05:00Z'); assert.match(r.error.message, /empty/);
    await admin.rpc('sekai_border_test_clear_legacy', {}); await legacy([...rows(182, '2026-10-20T11:50:10Z'), ...Array.from({ length: 5 }, (_, i) => ({ event_id: 'bad' + i, rank: 1, score: 1, created_at: '2026-10-20T11:55:05Z' }))]);
    r = await run('2026-10-20T12:05:00Z'); assert.match(r.error.message, /exceeds allowance/);
    r = await run('2026-10-20T12:03:00Z', 5); assert.match(r.error.message, /aligned/);
    await ins([{ event_id: 182, chapter: 0, rank: 1, score: 42, taken_at: '2026-10-20T11:50:00Z', is_final: false }]);   // same key as a source row with a different score
    r = await run('2026-10-20T12:05:00Z', 5); assert.match(r.error.message, /mismatch/);
    assert.equal((await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true }).eq('event_id', 182)).count, 31);   // rolled back: 30 live + the 42 row
});
test('candidate slot overlap: the legacy observation of the candidate slot wins; a differing score elsewhere still fails closed', async () => {
    await insertEvent(); await ins([...live('2026-10-20T11:50:00Z', 100), ...live('2026-10-20T12:05:00Z')]);   // candidate run wrote 11:50 with scores 100..71; legacy has 11:50 with 1000..971
    await legacy([...rows(182, '2026-10-20T11:50:10Z'), ...rows(182, '2026-10-20T11:55:05Z', 1200)]);
    const a = await admin.rpc('sekai_border_exec_migration', { p_event_id: 182, p_cutover: '2026-10-20T12:05:00Z', p_candidate_slot: '2026-10-20T11:50:00Z', p_allow_skipped: 0 });
    assert.equal(a.error, null, a.error?.message); assert.deepEqual(a.data, { inserted: 60, deleted_candidate_rows: 30, skipped_invalid_id_rows: 0, skipped_partial_slot_rows: 0, verified_slots: 2 });
    const { data } = await admin.from('sekai_border_rankings').select('score').eq('event_id', 182).eq('rank', 1).eq('taken_at', '2026-10-20T11:50:00Z'); assert.equal(data[0].score, 1000);
    const again = await admin.rpc('sekai_border_exec_migration', { p_event_id: 182, p_cutover: '2026-10-20T12:05:00Z', p_candidate_slot: '2026-10-20T11:50:00Z', p_allow_skipped: 0 });
    assert.deepEqual(again.data, { inserted: 0, deleted_candidate_rows: 0, skipped_invalid_id_rows: 0, skipped_partial_slot_rows: 0, verified_slots: 2 });   // rerun with the candidate slot is deterministic too
    await ins([{ event_id: 182, chapter: 0, rank: 2, score: 7, taken_at: '2026-10-20T11:40:00Z', is_final: false }]); await legacy(rows(182, '2026-10-20T11:40:20Z', 900));   // a non-candidate overlap with a different score
    const b = await admin.rpc('sekai_border_exec_migration', { p_event_id: 182, p_cutover: '2026-10-20T12:05:00Z', p_candidate_slot: '2026-10-20T11:50:00Z', p_allow_skipped: 0 }); assert.match(b.error.message, /mismatch/);
});
test('legacy freeze: with the trigger on, legacy inserts and the rollback export fail; dropping it restores both', async () => {
    await insertEvent(); await ins(live('2026-10-20T12:05:00Z'));
    await admin.rpc('sekai_border_test_legacy_freeze', { p_on: true });
    await assert.rejects(legacy(rows(182, '2026-10-20T12:00:03Z')), /frozen/);
    const f = await admin.rpc('sekai_border_export_to_legacy', { p_event_id: 182 }); assert.match(f.error.message, /frozen/);
    await admin.rpc('sekai_border_test_legacy_freeze', { p_on: false });
    const ok = await admin.rpc('sekai_border_export_to_legacy', { p_event_id: 182 }); assert.equal(ok.error, null, ok.error?.message); assert.equal(ok.data.exported, 30);
});
test('rollback export before an event transition: only slots after the last legacy observation (floored), idempotent', async () => {
    await insertEvent(); await ins([...live('2026-10-20T11:50:00Z', 1000), ...live('2026-10-20T11:55:00Z', 1200), ...live('2026-10-20T12:05:00Z'), ...live('2026-10-20T12:10:00Z', 6000)]);
    await legacy([...rows(182, '2026-10-20T11:50:10Z'), ...rows(182, '2026-10-20T11:55:05Z', 1200)]);   // second-level timestamps, as the old crawler writes them
    const a = await admin.rpc('sekai_border_export_to_legacy', { p_event_id: 182 }); assert.equal(a.error, null, a.error?.message);
    assert.equal(a.data.deleted_other_event_rows, 0); assert.equal(a.data.exported, 60); assert.equal(new Date(a.data.after_slot).toISOString(), '2026-10-20T11:55:00.000Z');
    const b = await admin.rpc('sekai_border_export_to_legacy', { p_event_id: 182 }); assert.equal(b.data.exported, 0); assert.equal(new Date(b.data.after_slot).toISOString(), '2026-10-20T12:10:00.000Z');
    assert.equal((await admin.from('event_rankings').select('*', { count: 'exact', head: true })).count, 120);   // 60 legacy + 60 exported, no duplicates of 11:50 / 11:55
});
test('rollback export after an event transition: the previous event is removed from the legacy table and the whole current curve is exported', async () => {
    await insertEvent({ id: 181, name: 'old', start_at: '2026-10-01T07:00:00Z', aggregate_at: '2026-10-09T12:59:59Z', ranking_announce_at: '2026-10-09T13:09:59Z', finalized_at: '2026-10-09T14:00:00Z' }); await insertEvent();
    await legacy(rows(181, '2026-10-09T12:55:03Z')); await ins([...live('2026-10-11T07:05:00Z', 100), ...live('2026-10-11T07:10:00Z', 200)]);
    const a = await admin.rpc('sekai_border_export_to_legacy', { p_event_id: 182 }); assert.equal(a.error, null, a.error?.message);
    assert.deepEqual(a.data, { deleted_other_event_rows: 30, exported: 60, after_slot: null });
    const { data } = await admin.from('event_rankings').select('event_id'); assert.equal(data.length, 60); assert.ok(data.every((r) => r.event_id === '182'));
});
```

Run（RED）: `npm run test:integration 2>&1 | grep -E "ℹ (pass|fail)|not ok"` → migrate.test.js 的 7 案全 FAIL（`function test.sekai_border_exec_migration(...) does not exist` 或 helper 不存在）。

- [ ] **Step 3: 渲染並套到 test schema**

```bash
cd /home/cholate/sekai-border && for f in 0001b_exec_sql 0001c_rollback_export 0001d_legacy_freeze; do node scripts/render-sql.js supabase/migrations/$f.sql.tmpl test test > /tmp/${f}_test.sql && echo "$f placeholders left: $(grep -c '{{' /tmp/${f}_test.sql)"; done
```

Expected: 三行 `placeholders left: 0`；MCP `apply_migration` 套三檔（name `0001b_exec_migration_test`、`0001c_rollback_export_test`、`0001d_legacy_freeze_test`），再套下面的 test-only 開關（name `test_only_legacy_freeze_toggle`）：

```sql
-- test-only: toggle the legacy freeze trigger (same CREATE TRIGGER statement as 0001d) so one test exercises it without blocking the others
create or replace function test.sekai_border_test_legacy_freeze(p_on boolean) returns void language plpgsql security definer set search_path = test as $$
begin
    execute 'drop trigger if exists sekai_border_legacy_freeze on test.event_rankings';
    if p_on then execute 'create trigger sekai_border_legacy_freeze before insert or update or delete or truncate on test.event_rankings for each statement execute function test.sekai_border_legacy_freeze()'; end if;
end $$;
revoke all on function test.sekai_border_test_legacy_freeze(boolean) from public, anon, authenticated;
grant execute on function test.sekai_border_test_legacy_freeze(boolean) to service_role;
```

- [ ] **Step 4: 跑 GREEN** — `npm run test:integration 2>&1 | grep -E "ℹ (pass|fail)|not ok"` → `fail 0`。

- [ ] **Step 5: 腳本**

```js
// scripts/confirm.js
import { createInterface } from 'node:readline/promises';
export async function confirmTarget({ url, schema, argv, extra = '' }) {
    console.log(`target supabase ref=${new URL(url).hostname.split('.')[0]} schema=${schema} ${extra}`);
    if (argv.includes('--yes')) return;
    const rl = createInterface({ input: process.stdin, output: process.stdout }); const a = await rl.question('type yes to continue: '); rl.close();
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

// Derives master-db attributes for one list entry (same rules as src/metadata.js, applied against the known row).
function attributes(e, master, known, now) {
    const checked = now.toISOString();
    const m = master.events.find((x) => x.id === e.id);
    if (!m) {
        const miss = (known?.metadata_miss_count ?? 0) + 1;
        const old = now.getTime() - new Date(e.aggregate_at).getTime() >= 7 * 86400000;
        return { metadata_status: miss >= 3 && old ? 'missing' : 'pending', metadata_miss_count: miss, metadata_checked_at: checked };
    }
    if (String(m.name ?? '').trim() !== String(e.name).trim()) return { metadata_status: 'mismatch', metadata_miss_count: 0, metadata_checked_at: checked, event_type: null, unit: null, bonus_characters: [] };
    const cardIds = new Set(master.eventCards.filter((x) => x.eventId === e.id).map((x) => x.cardId));
    const chars = [...new Set(master.cards.filter((c) => cardIds.has(c.id)).map((c) => c.characterId))].sort((a, b) => a - b);
    return { event_type: m.eventType, unit: m.unit ?? null, bonus_characters: chars, metadata_status: 'complete', metadata_miss_count: 0, metadata_checked_at: checked };
}

export async function backfill({ db, upstream, now = new Date(), from = 1, to = 999999, log = console.log }) {
    const list = await upstream.eventList();
    const master = { events: (await upstream.master('events.json')).body, eventCards: (await upstream.master('eventCards.json')).body, cards: (await upstream.master('cards.json')).body };
    const done = [];
    for (const e of list.filter((x) => x.id >= from && x.id <= to && new Date(x.ranking_announce_at).getTime() + ANNOUNCE_GRACE_MS < now.getTime()).sort((a, b) => a.id - b.id)) {
        const known = await db.loadKnown(e.id);
        if (known?.finalized_at) { done.push({ id: e.id, action: 'skipped' }); log(JSON.stringify(done.at(-1))); continue; }
        const chapters = (e.chapters ?? []).map((c) => ({ chapter: c.chapter, chapter_id: c.id, character_id: c.character, start_at: c.start_at, aggregate_at: c.aggregate_at, ranking_announce_at: c.ranking_announce_at }));
        try {
            await db.upsertEvent({ id: e.id, name: e.name, start_at: e.start_at, aggregate_at: e.aggregate_at, ranking_announce_at: e.ranking_announce_at, chapters, ...attributes(e, master, known, now) });
            const { border, top100 } = await upstream.finals(e.id);
            const { rows, deferred } = validateFinal(e.id, border, top100, chapters);
            if (deferred) done.push({ id: e.id, action: 'deferred' }); else { await db.finalize(e.id, rows); done.push({ id: e.id, action: 'finalized' }); }
        } catch (err) { done.push({ id: e.id, action: 'failed', reason: `${err.phase ?? 'db'}:${err.code ?? err.message}` }); }
        log(JSON.stringify(done.at(-1)));
    }
    return done;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const env = loadEnv();
    await confirmTarget({ url: env.url, schema: env.schema, argv: process.argv, extra: `range=${arg('--from', 1)}..${arg('--to', 999999)}` });
    const db = makeDb(createClient(env.url, env.key, { db: { schema: env.schema } }));
    const res = await backfill({ db, upstream: makeUpstream({ userAgent: env.botContact, minIntervalMs: 1000 }), from: arg('--from', 1), to: arg('--to', 999999) });
    const summary = res.reduce((m, r) => ((m[r.action] = (m[r.action] || 0) + 1), m), {});
    console.log(JSON.stringify({ summary, failed: res.filter((r) => r.action === 'failed') }));
    process.exit(summary.failed ? 1 : 0);
}
```

```js
// scripts/migrate-legacy.js   usage: --event <id> --cutover <ISO 5-min slot> [--candidate-slot <ISO 5-min slot>] [--allow-skipped N] [--yes]
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../src/env.js';
import { confirmTarget } from './confirm.js';
const opt = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const eventId = Number(opt('--event')), cutover = opt('--cutover'), candidate = opt('--candidate-slot') ?? null, allow = Number(opt('--allow-skipped') ?? 0);
if (!Number.isInteger(eventId) || !cutover || !/^\d{4}-\d{2}-\d{2}T\d{2}:[0-5][05]:00(\.000)?Z$/.test(cutover)) { console.error('usage: migrate-legacy.js --event <id> --cutover <YYYY-MM-DDTHH:M5:00Z> [--allow-skipped N] [--yes]'); process.exit(2); }
const env = loadEnv();
await confirmTarget({ url: env.url, schema: env.schema, argv: process.argv, extra: `event=${eventId} cutover=${cutover} candidate_slot=${candidate} allow_skipped=${allow}` });
const client = createClient(env.url, env.key, { db: { schema: env.schema } });
const { data, error } = await client.rpc('sekai_border_exec_migration', { p_event_id: eventId, p_cutover: cutover, p_candidate_slot: candidate, p_allow_skipped: allow });
if (error) { console.error(JSON.stringify({ migrated: false, error: error.message })); process.exit(1); }
console.log(JSON.stringify({ migrated: true, ...data }));
```

`src/db.js` 加：`async upsertEvent(row) { chk('event-write', await ev().upsert(row, { onConflict: 'id' })); }`。

- [ ] **Step 6: backfill 單元測試（fake db；真 `makeUpstream` + 以時間戳記錄的 fake fetch）**

```js
// test/backfill.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backfill } from '../scripts/backfill.js';
import { makeUpstream } from '../src/fetch.js';
const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
const json = (body, status = 200) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body });
function env(events = []) {
    const s = { events: [...events], finalized: [], stamps: [] };
    const db = { loadKnown: async (id) => s.events.find((e) => e.id === id) ?? null, upsertEvent: async (r) => { const i = s.events.findIndex((e) => e.id === r.id); if (i >= 0) s.events[i] = { ...s.events[i], ...r }; else s.events.push({ ...r, finalized_at: null }); }, finalize: async (id) => { s.finalized.push(id); s.events.find((e) => e.id === id).finalized_at = new Date(); } };
    const fetchImpl = async (url) => { const u = String(url); s.stamps.push(Date.now());
        if (u.endsWith('/event/list')) return json(fx('event-list'));
        if (u.includes('raw.githubusercontent')) return json(fx('master-' + u.split('/').pop().replace('.json', '')));
        const m = u.match(/\/event\/(\d+)\/(border|top100)$/); const id = Number(m[1]);
        if (id === 180) return json({}, 500);
        if (id === 179) return json(fx(m[2] === 'border' ? 'final-border-179' : 'final-top100-179'));
        return json(m[2] === 'border' ? { ...fx('final-border-181'), eventId: id } : fx('final-top100-181')); };
    return { s, db, upstream: makeUpstream({ fetchImpl, userAgent: 't', minIntervalMs: 15 }) };
}
test('ended events in range: skipped if finalized, else upserted with attributes and finalized; failure isolated; every HTTP request spaced', async () => {
    const { s, db, upstream } = env([{ id: 181, finalized_at: new Date() }]);
    const res = await backfill({ db, upstream, now: new Date('2026-10-16T00:00:00Z'), from: 178, to: 182, log: () => {} });
    assert.deepEqual(res.map((r) => [r.id, r.action]), [[178, 'finalized'], [179, 'finalized'], [180, 'failed'], [181, 'skipped']]);
    const e178 = s.events.find((e) => e.id === 178); assert.equal(e178.metadata_status, 'complete'); assert.ok(Array.isArray(e178.bonus_characters));
    for (let i = 1; i < s.stamps.length; i++) assert.ok(s.stamps[i] - s.stamps[i - 1] >= 14, `gap ${s.stamps[i] - s.stamps[i - 1]}`);
    assert.equal(s.stamps.length, 9); // list 1 + master 3 + 178 (2) + 179 (2) + 180 (border 500 -> top100 never requested: 1); 181 skipped
});
test('resume: event row exists without finals -> finalized on rerun, not duplicated', async () => {
    const { s, db, upstream } = env([{ id: 178, finalized_at: null }]);
    await backfill({ db, upstream, now: new Date('2026-10-16T00:00:00Z'), from: 178, to: 178, log: () => {} });
    assert.deepEqual(s.finalized, [178]); assert.equal(s.events.filter((e) => e.id === 178).length, 1);
});
```

Run `npm test` → `fail 0`（179 成功的前提是 event-list fixture 的章節角色與 179 最終 fixture 的 `gameCharacterId` 一致，Task 0 Step 3 已印出兩者）。

- [ ] **Step 7: 對 test schema 實跑回填（3 期，含一期 WL）與中斷續跑**

```bash
cd /home/cholate/sekai-border && set -a && . ./.env && set +a && SUPABASE_SCHEMA=test node scripts/backfill.js --from 179 --to 181 --yes; echo "exit=$?"
```

Expected：179、180、181 各 `finalized`，summary 無 failed，總耗時 ≥ 7 秒（1 + 3 + 3×2 個請求 × 1 秒）。SQL：`select event_id, chapter, count(*) from test.sekai_border_rankings where is_final group by 1,2 order by 1,2` → 179 的 chapter 0 為 30、chapter 1..6 各 28，180/181 各 chapter 0 30；`select id, metadata_status, event_type, bonus_characters from test.sekai_border_events order by id` → 三列 `complete`。中斷續跑：`update test.sekai_border_events set finalized_at = null where id = 180; delete from test.sekai_border_rankings where event_id = 180 and is_final;` 再跑同指令 → 180 `finalized`、其餘 `skipped`。

- [ ] **Step 8: Commit** — `git add scripts supabase src/db.js test && git commit -m "feat: 回填（屬性、upsert、請求閘門）、單一活動的交易式舊資料遷移、回滾匯出函式、舊表凍結觸發器"`

---

### Task 7: 文件與專案設定

**Files:** Rewrite `README.md`；Modify `CLAUDE.md`（Stack / layout / 禁區）、`PROJECT.toml`（`[commands]`：`once`、`backfill`、`migrate`）

- [ ] **Step 1: 改寫**（README 含：`POST /run` + OIDC、環境變數、`npm test` / `test:integration`（需 Exposed schema `test` 與 `.env`）、`node index.js --once`、`scripts/backfill.js`、`scripts/migrate-legacy.js --event --cutover`、`WL_INGEST`、部署與回滾 runbook 指向 Task 8）
- [ ] **Step 2: 驗收** — `grep -c "fetch_all_rankings\|SUPABASE_KEY" README.md CLAUDE.md` 皆 0；`grep -n "POST /run\|SUPABASE_SERVICE_ROLE_KEY\|--once\|test:integration\|migrate-legacy" README.md` 五個都出現。
- [ ] **Step 3: Commit** — `git add README.md CLAUDE.md PROJECT.toml && git commit -m "docs: 新架構的 README、CLAUDE.md 禁區與 PROJECT.toml 指令"`

---

### Task 8: 正式環境 rollout runbook（spec §7、§6、§7.1；GCP 指令由 user 執行）

每個區塊都以同一段前言開頭（變數初始化 + 嚴格模式），可直接貼：

```bash
set -euo pipefail
PROJECT=sekai-archive; REGION=asia-east1; SERVICE=sekai-border; SA=sekai-border-scheduler@sekai-archive.iam.gserviceaccount.com
LEDGER=/home/cholate/sekai-border/.superpowers/rollout-ledger.txt; mkdir -p "$(dirname "$LEDGER")"; touch "$LEDGER"
```

每步做完 `echo "step N done $(date -u +%FT%TZ) <關鍵值>" >> "$LEDGER"`。**步驟 5a–5c 必須在活動進行中（current）執行，實際切流量在 5c。**

- [ ] **Step 0: S3 歷史掃描（repo 與歷史不得含 service role key）**

```bash
cd /home/cholate/sekai-border && git fetch --all -q && HITS=$(git log -p --all | grep -cE 'eyJ[A-Za-z0-9_-]{20,}\.' || true); echo "jwt-like hits in history: $HITS"; grep -n '^\.env' .gitignore
```

Expected：`hits in history: 0`；`.gitignore` 列出 `.env`。有命中 → 停：這是 S3 的驗收，不是建議。

- [ ] **Step 1: 套 schema 到 public（不刪舊物件）**

```bash
cd /home/cholate/sekai-border && node scripts/render-sql.js supabase/migrations/0001_sekai_border.sql.tmpl public > /tmp/0001_public.sql && node scripts/render-sql.js supabase/migrations/0001b_exec_sql.sql.tmpl public public > /tmp/0001b_public.sql && node scripts/render-sql.js supabase/migrations/0001c_rollback_export.sql.tmpl public public > /tmp/0001c_public.sql && if grep -n '{{' /tmp/0001_public.sql /tmp/0001b_public.sql /tmp/0001c_public.sql; then echo 'placeholders left'; false; else echo 'placeholders left: 0'; fi
```

以 MCP `apply_migration` 套三檔（名稱 `0001_sekai_border`、`0001b_exec_migration`、`0001c_rollback_export`）。Expected：皆成功。目錄驗收 SQL（全部 schema-qualified）：

```sql
select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('sekai_border_events','sekai_border_rankings');   -- true, true
select tablename, policyname, cmd, roles from pg_policies where schemaname='public' and tablename like 'sekai_border_%';   -- 2 rows, SELECT, {anon,authenticated}
select r, t, p from (values ('anon'),('authenticated')) a(r), (values ('sekai_border_events'),('sekai_border_rankings'),('sekai_border_current_report'),('sekai_border_daily_report')) b(t), (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) c(p) where has_table_privilege(r, 'public.'||t, p) <> (p = 'SELECT');   -- 0 rows
select has_function_privilege('anon', to_regprocedure('public.sekai_border_finalize(integer,jsonb)'), 'EXECUTE') a, has_function_privilege('authenticated', to_regprocedure('public.sekai_border_finalize(integer,jsonb)'), 'EXECUTE') b, has_function_privilege('service_role', to_regprocedure('public.sekai_border_finalize(integer,jsonb)'), 'EXECUTE') c;   -- false false true
select count(*) from aclexplode((select proacl from pg_proc where oid = to_regprocedure('public.sekai_border_finalize(integer,jsonb)'))) where grantee = 0;   -- 0
select c.relname, (select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('sekai_border_current_report','sekai_border_daily_report');   -- on, on
-- role DML, each its own transaction, for anon and then authenticated (Task 3 Step 6b with public.*):
begin; set local role anon; select count(*) from public.sekai_border_events; rollback;                                                  -- number
begin; set local role anon; insert into public.sekai_border_rankings (event_id, chapter, rank, score, taken_at) values (1, 0, 1, 1, now()); rollback;   -- ERROR permission denied
begin; set local role anon; update public.sekai_border_events set name = name; rollback;                                                 -- ERROR permission denied
begin; set local role anon; delete from public.sekai_border_events where id = -1; rollback;                                              -- ERROR permission denied
```

- [ ] **Step 2: Scheduler 改 OIDC、服務設私有（user；舊爬蟲接受任何路徑，所以可以先做）**

```bash
set -euo pipefail; PROJECT=sekai-archive; REGION=asia-east1; SERVICE=sekai-border; SA=sekai-border-scheduler@sekai-archive.iam.gserviceaccount.com; LEDGER=/home/cholate/sekai-border/.superpowers/rollout-ledger.txt
OLD_REVISION=$(gcloud run services describe $SERVICE --region $REGION --project $PROJECT --format 'value(status.latestReadyRevisionName)'); echo "OLD_REVISION=$OLD_REVISION" | tee -a "$LEDGER"
gcloud scheduler jobs pause $SERVICE --location $REGION --project $PROJECT
gcloud iam service-accounts create sekai-border-scheduler --project $PROJECT || true
SERVICE_URL=$(gcloud run services describe $SERVICE --region $REGION --project $PROJECT --format 'value(status.url)'); echo "SERVICE_URL=$SERVICE_URL" | tee -a "$LEDGER"
gcloud scheduler jobs update http $SERVICE --location $REGION --project $PROJECT --uri "$SERVICE_URL/run" --http-method POST --oidc-service-account-email $SA --oidc-token-audience "$SERVICE_URL"
cat > /tmp/run-policy.yaml <<'Y'
bindings:
- members: ['serviceAccount:sekai-border-scheduler@sekai-archive.iam.gserviceaccount.com']
  role: roles/run.invoker
Y
gcloud run services set-iam-policy $SERVICE /tmp/run-policy.yaml --region $REGION --project $PROJECT --quiet   # authoritative: replaces allUsers etc.
gcloud run services get-iam-policy $SERVICE --region $REGION --project $PROJECT                                # Expected: only that binding
gcloud scheduler jobs resume $SERVICE --location $REGION --project $PROJECT
gcloud scheduler jobs run $SERVICE --location $REGION --project $PROJECT; sleep 25
gcloud scheduler jobs describe $SERVICE --location $REGION --project $PROJECT --format 'yaml(httpTarget.uri,httpTarget.httpMethod,httpTarget.oidcToken)'   # Expected: uri .../run, POST, serviceAccountEmail = $SA, audience = $SERVICE_URL (S1)
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="sekai-border" AND httpRequest.requestUrl:"/run"' --project $PROJECT --limit 1 --format 'value(httpRequest.status)'   # Expected: 200
test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$SERVICE_URL/run")" = 403 && echo "unauthenticated -> 403 OK"
echo "step 2 done $(date -u +%FT%TZ)" >> "$LEDGER"
```

- [ ] **Step 3: Secret Manager 與候選版本（user；服務已私有，候選版本不會被公開觸發）**

```bash
set -euo pipefail; PROJECT=sekai-archive; REGION=asia-east1; SERVICE=sekai-border; LEDGER=/home/cholate/sekai-border/.superpowers/rollout-ledger.txt
read -rsp 'service role key: ' K; echo; printf '%s' "$K" | gcloud secrets create sekai-border-service-role --project $PROJECT --data-file=- ; unset K   # the key never appears on a command line
RUNTIME_SA=$(gcloud run services describe $SERVICE --region $REGION --project $PROJECT --format 'value(spec.template.spec.serviceAccountName)'); RUNTIME_SA=${RUNTIME_SA:-$(gcloud projects describe $PROJECT --format 'value(projectNumber)')-compute@developer.gserviceaccount.com}
gcloud secrets add-iam-policy-binding sekai-border-service-role --project $PROJECT --member "serviceAccount:$RUNTIME_SA" --role roles/secretmanager.secretAccessor
read -rp 'BOT_CONTACT (User-Agent contact, no commas): ' BOT_CONTACT; test -n "$BOT_CONTACT"
cd /home/cholate/sekai-border && docker build -t sekai-border-test . && docker run --rm sekai-border-test sh -c 'test ! -e /app/.env' && gcloud run deploy $SERVICE --source . --region $REGION --project $PROJECT --no-traffic --tag candidate \
  --set-secrets SUPABASE_SERVICE_ROLE_KEY=sekai-border-service-role:latest --set-env-vars "SUPABASE_URL=https://bwhhtfcyagqhcddzssas.supabase.co,BOT_CONTACT=$BOT_CONTACT,WL_INGEST=off"
echo "step 3 done $(date -u +%FT%TZ)" >> "$LEDGER"
```

Expected：部署成功；`gcloud run services describe ... --format json` 的 `status.traffic` 含 `tag: candidate`。

- [ ] **Step 4: 驗候選版本（user；token 現鑄現用；impersonation 授權只在這個區塊內存在）**

```bash
(   # whole block in a subshell: the EXIT trap fires when the subshell ends (success, set -e abort, Ctrl-C), not when your terminal closes
set -euo pipefail; PROJECT=sekai-archive; REGION=asia-east1; SERVICE=sekai-border; SA=sekai-border-scheduler@sekai-archive.iam.gserviceaccount.com; LEDGER=/home/cholate/sekai-border/.superpowers/rollout-ledger.txt
SERVICE_URL=$(gcloud run services describe $SERVICE --region $REGION --project $PROJECT --format 'value(status.url)')
# temporary impersonation grant: the trap is armed BEFORE the grant so every exit path (success, failed assertion, Ctrl-C) removes it
trap 'gcloud iam service-accounts remove-iam-policy-binding $SA --project $PROJECT --member "user:$(gcloud config get-value account)" --role roles/iam.serviceAccountTokenCreator --quiet >/dev/null || true' EXIT
gcloud iam service-accounts add-iam-policy-binding $SA --project $PROJECT --member "user:$(gcloud config get-value account)" --role roles/iam.serviceAccountTokenCreator --quiet >/dev/null; sleep 60   # IAM propagation
CANDIDATE_URL=$(gcloud run services describe $SERVICE --region $REGION --project $PROJECT --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.status.traffic.find(t=>t.tag==="candidate")||{}).url||"")})'); test -n "$CANDIDATE_URL"; echo "candidate: $CANDIDATE_URL"
TOKEN=$(gcloud auth print-identity-token --impersonate-service-account $SA --audiences "$SERVICE_URL")
curl -sf -X POST -H "Authorization: Bearer $TOKEN" "$CANDIDATE_URL/run" | tee /tmp/candidate.json
node -e 'const j=require("/tmp/candidate.json"); const ok = (j.branch==="current"&&j.inserted===30)||(["frozen","due"].includes(j.branch)&&j.inserted===0); if(!ok){console.error("unexpected",JSON.stringify(j));process.exit(1)} console.log("CANDIDATE_BRANCH="+j.branch+"\nCANDIDATE_SLOT="+(j.branch==="current"?j.slot:"")+"\nCANDIDATE_EVENT_ID="+j.event_id)' | tee /tmp/candidate.env | tee -a "$LEDGER"
echo "step 4 done $(date -u +%FT%TZ)" >> "$LEDGER"
)
```

Expected：`CANDIDATE_BRANCH` 為 `current`（此時 `CANDIDATE_SLOT=<slot>`）或 `frozen` / `due`（此時 `CANDIDATE_SLOT=` 空），三者皆通過；`CANDIDATE_EVENT_ID=<id>`；`public.sekai_border_events` 多一列；區塊結束後（成功或失敗皆然）`gcloud iam service-accounts get-iam-policy $SA --project $PROJECT` 不含 `user:` 成員。

- [ ] **Step 5a: 暫停 Scheduler 並等舊請求收尾（user；必須在活動進行中）**

```bash
set -euo pipefail; PROJECT=sekai-archive; REGION=asia-east1; SERVICE=sekai-border; LEDGER=/home/cholate/sekai-border/.superpowers/rollout-ledger.txt
gcloud scheduler jobs pause $SERVICE --location $REGION --project $PROJECT
# Best-effort drain: wait until the newest /run request log entry is older than 120 s. This is NOT the correctness
# guarantee: the old crawler has no fetch timeout, and a straggler could still insert or, on an event switch, delete the
# legacy table's rows (index.js checkAndClearOldEvent). Step 5b freezes the legacy table BEFORE traffic moves, so a
# straggler that finishes later fails instead of writing; this wait only avoids error noise.
AGE=0; for i in $(seq 1 30); do LAST=$(gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="sekai-border" AND httpRequest.requestUrl:"/run"' --project $PROJECT --limit 1 --format 'value(timestamp)'); AGE=$(( $(date -u +%s) - $(date -u -d "$LAST" +%s) )); echo "last request ${AGE}s ago"; [ "$AGE" -ge 120 ] && break; sleep 10; done; [ "$AGE" -ge 120 ]
echo "step 5a done $(date -u +%FT%TZ)" >> "$LEDGER"
```

Expected：`last request ≥120s ago`。Scheduler 暫停期間舊 revision 仍掛著流量但不再被觸發。

- [ ] **Step 5b: 凍結舊表（我；MCP SQL；Scheduler 已暫停、流量尚未切）**

```bash
cd /home/cholate/sekai-border && node scripts/render-sql.js supabase/migrations/0001d_legacy_freeze.sql.tmpl public public > /tmp/0001d_public.sql && if grep -n '{{' /tmp/0001d_public.sql; then echo 'placeholders left'; false; else echo 'placeholders left: 0'; fi
```

MCP `apply_migration`（name `0001d_legacy_freeze`）套 `/tmp/0001d_public.sql`，再以 `execute_sql` 各自獨立驗證：

```sql
begin; insert into public.event_rankings (event_id, rank, score, created_at) values ('0', 1, 1, now()); rollback;   -- Expected: ERROR ... event_rankings is frozen
select count(*) from public.event_rankings;                                                                           -- Expected: a number (reads still work; old views stay live until step 7)
```

Expected：`placeholders left: 0`；insert 被 RAISE 拒絕。從此刻起舊表只讀：舊 revision 的任何殘留寫入都失敗（Cloud Logging 可能出現該 revision 的錯誤，屬預期），遷移來源不再變動。若 5c 失敗要回到舊爬蟲，先由我 `drop trigger if exists sekai_border_legacy_freeze on public.event_rankings;` 再切回。

- [ ] **Step 5c: 切流量、取得 cutover slot（user；impersonation 授權只在這個區塊內存在）**

```bash
(   # whole block in a subshell: the EXIT trap fires when the subshell ends (success, set -e abort, Ctrl-C)
set -euo pipefail; PROJECT=sekai-archive; REGION=asia-east1; SERVICE=sekai-border; SA=sekai-border-scheduler@sekai-archive.iam.gserviceaccount.com; LEDGER=/home/cholate/sekai-border/.superpowers/rollout-ledger.txt
SERVICE_URL=$(gcloud run services describe $SERVICE --region $REGION --project $PROJECT --format 'value(status.url)')
trap 'gcloud iam service-accounts remove-iam-policy-binding $SA --project $PROJECT --member "user:$(gcloud config get-value account)" --role roles/iam.serviceAccountTokenCreator --quiet >/dev/null || true' EXIT
gcloud iam service-accounts add-iam-policy-binding $SA --project $PROJECT --member "user:$(gcloud config get-value account)" --role roles/iam.serviceAccountTokenCreator --quiet >/dev/null; sleep 60   # IAM propagation
gcloud run services update-traffic $SERVICE --to-latest --region $REGION --project $PROJECT
# wait for the NEXT 5-minute boundary, then call once and keep the body
NOW=$(date -u +%s); sleep $(( 300 - NOW % 300 + 10 ))
TOKEN=$(gcloud auth print-identity-token --impersonate-service-account $SA --audiences "$SERVICE_URL")
curl -sf -X POST -H "Authorization: Bearer $TOKEN" "$SERVICE_URL/run" | tee /tmp/cutover.json
node -e 'const j=require("/tmp/cutover.json"); if(j.branch!=="current"||j.inserted!==30){console.error("NOT current/30:",JSON.stringify(j));process.exit(1)} console.log("CUTOVER_SLOT="+j.slot+"\nCUTOVER_EVENT_ID="+j.event_id)' | tee /tmp/cutover.env | tee -a "$LEDGER"
gcloud scheduler jobs resume $SERVICE --location $REGION --project $PROJECT
echo "step 5c done $(date -u +%FT%TZ)" >> "$LEDGER"
)
```

Expected：`/tmp/cutover.env` 兩行；區塊結束後（成功或失敗皆然）`gcloud iam service-accounts get-iam-policy $SA --project $PROJECT` 不含 `user:` 成員。若 node 印 `NOT current/30`（`pipefail` 讓區塊停在這裡，Scheduler 仍暫停）：(1) 我以 MCP `execute_sql` 執行 `drop trigger if exists sekai_border_legacy_freeze on public.event_rankings;`；(2) user 執行 `gcloud run services update-traffic $SERVICE --to-revisions $(grep '^OLD_REVISION=' "$LEDGER" | tail -1 | cut -d= -f2)=100 --region $REGION --project $PROJECT && gcloud scheduler jobs resume $SERVICE --location $REGION --project $PROJECT`；等活動進行中再從 5a 重來。

- [ ] **Step 6: 搬舊資料（我；用 user 的 .env）**

```bash
set -euo pipefail; cd /home/cholate/sekai-border && set -a && . ./.env && . /tmp/cutover.env && . /tmp/candidate.env && set +a
# the candidate slot is handed over only when it belongs to the cutover event; a candidate row set of an EARLIER event is a valid
# snapshot of that event (the legacy table never holds it: the old crawler deletes other events' rows) and needs no cleanup
CAND=(); if [ -n "${CANDIDATE_SLOT:-}" ] && [ "$CANDIDATE_EVENT_ID" = "$CUTOVER_EVENT_ID" ]; then CAND=(--candidate-slot "$CANDIDATE_SLOT"); fi; echo "candidate args: ${CAND[*]:-none}" | tee -a .superpowers/rollout-ledger.txt
SUPABASE_SCHEMA=public node scripts/migrate-legacy.js --event "$CUTOVER_EVENT_ID" --cutover "$CUTOVER_SLOT" ${CAND[@]+"${CAND[@]}"} | tee -a .superpowers/rollout-ledger.txt
```

Expected：`{migrated: true, inserted: N, deleted_candidate_rows: 30（Step 4 為 current，該 slot 以舊表觀測取代）或 0, skipped_invalid_id_rows: 報告值（看一眼原因分布；`'unknown_event'` 之類）, skipped_partial_slot_rows: ≤ 60, verified_slots: ≈ N/30}`；兩個 skipped 合計必須在允許量內（預設舊表列數的 1%），否則函式已 RAISE 回滾——超過時依報告決定 `--allow-skipped`。

- [ ] **Step 7: view 比對與網站切換**

MCP SQL（同一時刻；中途落入新快照時最多差 30 列，重跑一次）：

```sql
(select 'old' as side, * from public.view_all_ranking_report except select 'old', * from public.sekai_border_current_report)
union all (select 'new', * from public.sekai_border_current_report except select 'new', * from public.view_all_ranking_report);   -- Expected: 0 rows
(select 'old', * from public.view_day_ranking_report except select 'old', * from public.sekai_border_daily_report)
union all (select 'new', * from public.sekai_border_daily_report except select 'new', * from public.view_day_ranking_report);   -- Expected: 0 rows
```

```bash
set -euo pipefail; cd /home/cholate/sekai-archive && sed -i "s/from('view_all_ranking_report')/from('sekai_border_current_report')/; s/from('view_day_ranking_report')/from('sekai_border_daily_report')/" context/RankContext.js && test "$(grep -c "sekai_border_" context/RankContext.js)" = 2
npm run smoke > /tmp/smoke.log 2>&1; test "$(grep -c '^PASS' /tmp/smoke.log)" = 4 && test "$(grep -c '^FAIL' /tmp/smoke.log)" = 0
git add context/RankContext.js && git commit -m "feat: 排行頁改讀 sekai_border_* 相容 view" && git push origin main
```

Expected：全部通過；部署後用子專案 0 的 Playwright 檢查正式站兩個視圖各 10 列。

- [ ] **Step 8: 回填歷史（我；深夜）**

```bash
set -euo pipefail; cd /home/cholate/sekai-border && set -a && . ./.env && set +a && SUPABASE_SCHEMA=public node scripts/backfill.js | tee -a .superpowers/rollout-ledger.txt
```

Expected：summary `finalized` ≈ 180、`failed` 0；耗時 ≈ (1 + 3 + 180 × 2) 秒。驗收 SQL：`select event_id, chapter from public.sekai_border_rankings where is_final group by 1, 2 having count(distinct rank) filter (where rank <> all (array[1500, 2500])) <> 28 or count(*) <> count(distinct rank)` → 0 列（結算函式已斷言，這是事後複查）；`select count(*) filter (where n = 30), count(*) filter (where n = 28) from (select event_id, count(*) n from public.sekai_border_rankings where is_final and chapter = 0 group by 1) x` → 約第 110 期起為 30、更早為 28，人工看分界合理；WL 期 `select event_id, count(distinct chapter) from public.sekai_border_rankings where is_final and chapter > 0 group by 1` 等於章節數；`select metadata_status, count(*) from public.sekai_border_events group by 1`，`missing`/`mismatch` 列出人工看。

- [ ] **Step 9: 拆網站端 RAG（sekai-archive）**

```bash
set -euo pipefail; cd /home/cholate/sekai-archive && git rm -q lib/tools/definitions/knowledge.js lib/tools/implementations/knowledge.js && { grep -rn "knowledge\|search_knowledge_base\|embeddings" lib app hooks components --include=*.js | cut -c1-120 || true; }
```

依 grep 移除 registry 項、system prompt 第 7 條的知識庫句、`hooks/useLLM.js` 的 `allowed_tools`（改 `[]`）、`hooks/useStatelessLLM.js` 的 toolMap 項。`npm run lint` 與 smoke（同 Step 7 的斷言）綠 → commit、push。Expected：`grep -rn knowledge lib app hooks components` 零命中。

- [ ] **Step 10: 觀察期回滾 runbook（只在需要時；每步在觀察期內可行）**

順序固定：先停 Scheduler（user）→ 拆凍結（我）→ 反向匯入**當期**並切回（user）。匯入的是新表裡「目前進行中的那一期」，不是 cutover 那一期——觀察期要跨過一次活動更替。匯出函式自己刪掉舊表裡其他期的列（舊爬蟲的 `checkAndClearOldEvent` 只看最新一列的 id，匯入後最新一列已是當期，不會替我們刪）。

(1) user：

```bash
set -euo pipefail; PROJECT=sekai-archive; REGION=asia-east1; SERVICE=sekai-border
gcloud scheduler jobs pause $SERVICE --location $REGION --project $PROJECT; sleep 120
```

(2) 我（MCP `execute_sql`）：`drop trigger if exists sekai_border_legacy_freeze on public.event_rankings;`

(3) user：

```bash
set -euo pipefail; PROJECT=sekai-archive; REGION=asia-east1; SERVICE=sekai-border; LEDGER=/home/cholate/sekai-border/.superpowers/rollout-ledger.txt
OLD_REVISION=$(grep '^OLD_REVISION=' "$LEDGER" | tail -1 | cut -d= -f2); test -n "$OLD_REVISION"
cd /home/cholate/sekai-border && set -a && . ./.env && set +a && node --input-type=module -e '
import { createClient } from "@supabase/supabase-js"; const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ev = await c.from("sekai_border_events").select("id").is("finalized_at", null).lte("start_at", new Date().toISOString()).order("start_at", { ascending: false }).limit(1).maybeSingle();
if (ev.error || !ev.data) { console.error("no live event in the new table", ev.error?.message); process.exit(1); }
const r = await c.rpc("sekai_border_export_to_legacy", { p_event_id: ev.data.id }); if (r.error) { console.error(r.error.message); process.exit(1); } console.log(JSON.stringify({ event_id: ev.data.id, ...r.data }));' | tee -a "$LEDGER"
cd /home/cholate/sekai-archive && sed -i "s/from('sekai_border_current_report')/from('view_all_ranking_report')/; s/from('sekai_border_daily_report')/from('view_day_ranking_report')/" context/RankContext.js && git commit -am "revert: 排行頁暫回舊 view" && git push origin main
gcloud run services update-traffic $SERVICE --to-revisions "$OLD_REVISION=100" --region $REGION --project $PROJECT
gcloud scheduler jobs resume $SERVICE --location $REGION --project $PROJECT
```

Expected：`export_to_legacy` 回傳 `{deleted_other_event_rows: 更替後為上一期在舊表的列數、否則 0, exported: 舊表最後觀測 slot 之後的 slot 數 × 30（舊表無該期時 = 該期全部快照）, after_slot}`；舊表只剩當期；舊 view 最新 `created_at` 為最近的 slot；Scheduler 下一輪 200。

- [ ] **Step 11: 觀察期**（至少跨過一次活動更替，約 10 天）：每天看 Scheduler 執行紀錄全 200；更替後 SQL 確認 `finalized_at` 已寫、該期非整點列已刪、主榜 `is_final` 30 列（WL 章節各 28）。

- [ ] **Step 12: 拆舊（觀察期後）**

```sql
drop view if exists public.view_all_ranking_report; drop view if exists public.view_day_ranking_report;
drop function if exists public.sekai_border_export_to_legacy(integer);
drop table if exists public.event_rankings;   -- also drops the freeze trigger
drop function if exists public.sekai_border_legacy_freeze();
drop function if exists public.match_documents(vector, double precision, integer);
drop table if exists public.documents;
drop extension if exists vector;
```

Expected：`get_advisors(security)` 零 finding；`list_tables` 只剩 `sekai_border_events`、`sekai_border_rankings`、`ai_inferences`；`gcloud run revisions delete $OLD_REVISION`；更新兩個 repo 的 PROJECT.toml。

---

## 執行模型建議（kit-workflow 要求）

| Phase | 建議主模型 / effort | 理由 | 升級觸發 |
|---|---|---|---|
| Task 0–2 | Opus 5.5 / medium | 規格與測試碼已在計畫裡 | fixture 與 spec 形狀不符 |
| Task 3、3b、6（plpgsql 交易、遷移） | Fable 5.1 / high | 交易語意與容量判定最容易錯 | 整合測試出現非預期 rollback |
| Task 4、5 | Opus 5.5 / medium | 介面凍結 | 整合與單元結論不一致 |
| Task 8 | Fable 5.1 / high | 不可逆操作、正式資料、user 協作 | 任何一步 Expected 不符 → 停 |
