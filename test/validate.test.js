// test/validate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateLive, validateWl, validateFinal, validateEventListEntry, chaptersFromList, safeDetail } from '../src/validate.js';
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
test('validateLive accepts recorded live responses: 30 rows, event name kept, wlRaw passed through untouched', () => {
    const { event, rows, wlRaw } = validateLive(fx('live-top100'), fx('live-border'));
    assert.equal(rows.length, 30);
    assert.deepEqual(rows.map((r) => r.rank).sort((a, b) => a - b), [...ALLOWED_RANKS].sort((a, b) => a - b));
    assert.ok(rows.every((r) => r.chapter === 0 && Number.isInteger(r.score) && r.score >= 0));
    assert.equal(typeof event.id, 'number'); assert.ok(event.name.length > 0);
    assert.deepEqual(wlRaw, { border: fx('live-border').world_link_border_rankings, top100: fx('live-top100').world_link_top_100_rankings });
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
test('validateLive never inspects world_link_* fields: garbage there still yields 30 main rows', () => {
    const t = clone(fx('live-top100')); t.world_link_top_100_rankings = 'garbage'; const b = clone(fx('live-border')); delete b.world_link_border_rankings;
    const { rows, wlRaw } = validateLive(t, b); assert.equal(rows.length, 30); assert.equal(wlRaw.top100, 'garbage'); assert.equal(wlRaw.border, undefined);
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
test('validateFinal WL: an empty child ranking array is deferred in either collection; a malformed collection rejects even when the other is empty', () => {
    const border = fx('final-border-179'); const top = fx('final-top100-179'); const chapters = chaptersFor(border);
    const b = clone(border); b.userWorldBloomChapterRankingBorders[3].borderRankings = [];
    assert.deepEqual(validateFinal(179, b, top, chapters), { rows: [], deferred: true });
    const t = clone(top); t.userWorldBloomChapterRankings[0].rankings = [];
    assert.deepEqual(validateFinal(179, border, t, chapters), { rows: [], deferred: true });
    const e = clone(border); e.userWorldBloomChapterRankingBorders = []; const m = clone(top); delete m.userWorldBloomChapterRankings[1].rankings;
    assert.throws(() => validateFinal(179, e, m, chapters), (x) => x.code === 'shape');
});
test('validateFinal: non-empty WL final collections with no declared chapters reject instead of finalizing the main board alone', () => {
    assert.throws(() => validateFinal(179, fx('final-border-179'), fx('final-top100-179'), []), (e) => e.code === 'wl_chapters');
});
test('chaptersFromList: a list entry without a chapters array is an upstream contract break, not "no chapters"', () => {
    assert.throws(() => chaptersFromList({ id: 179 }), (e) => e.phase === 'event-list' && e.code === 'chapters_shape');
    assert.throws(() => chaptersFromList({ id: 179, chapters: 'x' }), (e) => e.code === 'chapters_shape');
    assert.deepEqual(chaptersFromList({ id: 181, chapters: [] }), []);
});
test('chaptersFromList keeps only chapters naming a character (event 180 lists a character-0 placeholder)', () => {
    const list = fx('event-list');
    assert.deepEqual(chaptersFromList(list.find((e) => e.id === 180)), []);
    const c179 = chaptersFromList(list.find((e) => e.id === 179));
    assert.equal(c179.length, 6); assert.ok(c179.every((c) => c.character_id > 0));
    assert.deepEqual(Object.keys(c179[0]).sort(), ['aggregate_at', 'chapter', 'chapter_id', 'character_id', 'ranking_announce_at', 'start_at']);
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

const WL_CH = [{ chapter: 1, character_id: 23, start_at: '2026-09-06T12:00:00Z', aggregate_at: '2026-09-08T11:59:59Z' }, { chapter: 2, character_id: 21, start_at: '2026-09-08T12:00:00Z', aggregate_at: '2026-09-10T11:59:59Z' }];
// hisekai docs (2026-10-17): a world_link element carries id/event/chapter/character/times plus ONE ranking array per endpoint
const wlEl = (chapter, character, key, list) => ({ id: 17900 + chapter, event: 179, chapter, character, start_at: WL_CH[chapter - 1].start_at, aggregate_at: WL_CH[chapter - 1].aggregate_at, ranking_announce_at: WL_CH[chapter - 1].aggregate_at, [key]: list });
const top = (base = 5000) => [...TOP_TARGET].map((rank) => ({ rank, name: 'x', score: base * 1000 - rank * 1000 }));
const bord = (base = 5000) => [...BORDER_TARGET].filter((r) => !FINAL_OPTIONAL.has(r)).map((rank) => ({ rank, name: 'x', score: base * 100 - rank }));
const live = (chapters = WL_CH) => ({ border: chapters.map((c) => wlEl(c.chapter, c.character_id, 'player_border_rankings', bord())), top100: chapters.map((c) => wlEl(c.chapter, c.character_id, 'player_top_100_rankings', top())) });
const SLOT = new Date('2026-09-07T00:00:00Z');   // chapter 1 active, chapter 2 not yet

test('validateWl: only the active chapter is returned, 28 rows (1500/2500 optional), merged from both endpoints', () => {
    const rows = validateWl({ ...live(), eventId: 179, slot: SLOT, chapters: WL_CH });
    assert.equal(rows.length, 28); assert.ok(rows.every((r) => r.chapter === 1));
    assert.deepEqual(rows.map((r) => r.rank).sort((a, b) => a - b), ALLOWED_RANKS.filter((r) => !FINAL_OPTIONAL.has(r)));
    assert.ok(rows.every((r) => !('name' in r)));
});
test('validateWl: no declared/active chapter -> [] without error (non-WL events have empty arrays); empty arrays with an ACTIVE chapter -> wl_chapters; future and ended chapters are ignored silently', () => {
    assert.deepEqual(validateWl({ border: [], top100: [], eventId: 182, slot: SLOT, chapters: [] }), []);
    assert.deepEqual(validateWl({ border: 'anything', top100: null, eventId: 182, slot: SLOT, chapters: [] }), []);   // nothing active: WL fields not even looked at
    assert.throws(() => validateWl({ border: [], top100: [], eventId: 179, slot: SLOT, chapters: WL_CH }), (e) => e instanceof UpstreamError && e.code === 'wl_chapters' && e.detail.chapter === 1);
    assert.deepEqual(validateWl({ ...live(), eventId: 179, slot: new Date('2026-09-11T00:00:00Z'), chapters: WL_CH }), []);   // all ended
    const rows = validateWl({ ...live(), eventId: 179, slot: new Date('2026-09-08T12:00:00Z'), chapters: WL_CH });   // chapter 2 starts exactly now, chapter 1 ended at 11:59:59
    assert.ok(rows.every((r) => r.chapter === 2));
});
test('validateWl: shape errors, character/event mismatch, missing active chapter, bad rank set/order -> UpstreamError with chapter', () => {
    const err = (code, chapter) => (e) => e instanceof UpstreamError && e.phase === 'wl' && e.code === code && e.detail.chapter === chapter;
    assert.throws(() => validateWl({ border: 'nope', top100: live().top100, eventId: 179, slot: SLOT, chapters: WL_CH }), err('shape', null));
    assert.throws(() => validateWl({ border: null, top100: live().top100, eventId: 179, slot: SLOT, chapters: WL_CH }), err('shape', null));
    const l1 = live(); l1.border[0].character = 99; assert.throws(() => validateWl({ ...l1, eventId: 179, slot: SLOT, chapters: WL_CH }), err('wl_chapters', 1));
    const l2 = live(); l2.top100[0].event = 178; assert.throws(() => validateWl({ ...l2, eventId: 179, slot: SLOT, chapters: WL_CH }), err('event_mismatch', 1));
    const l3 = live(); l3.border = [l3.border[1]]; assert.throws(() => validateWl({ ...l3, eventId: 179, slot: SLOT, chapters: WL_CH }), err('wl_chapters', 1));   // active chapter missing from border
    const l4 = live(); l4.border[0].player_border_rankings = l4.border[0].player_border_rankings.filter((r) => r.rank !== 200); assert.throws(() => validateWl({ ...l4, eventId: 179, slot: SLOT, chapters: WL_CH }), err('rank_set', 1));
    const l5 = live(); l5.top100[0].player_top_100_rankings.find((r) => r.rank === 2).score = 1; assert.throws(() => validateWl({ ...l5, eventId: 179, slot: SLOT, chapters: WL_CH }), err('score_order', 1));
    const l6 = live(); l6.top100[0].player_top_100_rankings = 'x'; assert.throws(() => validateWl({ ...l6, eventId: 179, slot: SLOT, chapters: WL_CH }), err('shape', 1));
    const l7 = live(); l7.border.push(l7.border[0]); assert.throws(() => validateWl({ ...l7, eventId: 179, slot: SLOT, chapters: WL_CH }), err('wl_chapters', 1));   // duplicate element
    const l8 = live(); l8.border[0].player_border_rankings.push({ rank: 1500, score: 10 ** 9 }); assert.throws(() => validateWl({ ...l8, eventId: 179, slot: SLOT, chapters: WL_CH }), err('score_order', 1));   // 1500 present but out of order
});
test('validateWl: 1500/2500 present and consistent are kept (30 rows)', () => {
    const l = live(); l.border[0].player_border_rankings.push({ rank: 1500, score: 5000 * 100 - 1500 }, { rank: 2500, score: 5000 * 100 - 2500 });
    assert.equal(validateWl({ ...l, eventId: 179, slot: SLOT, chapters: WL_CH }).length, 30);
});
