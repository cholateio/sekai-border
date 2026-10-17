import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParams } from './helpers/params.js';
// A2: trap fetch BEFORE the module under test loads; any upstream call from the forecast tree throws here
globalThis.fetch = () => { throw new Error('forecast code must never call fetch'); };
const { forecastLines, inferRound, activeWindows, slotOf } = await import('../src/forecast/infer.js');
const { makeDeadline } = await import('../src/forecast/deadline.js');
const T = (s) => new Date(s); const H = 3600000;
const EVENT = { id: 182, event_type: 'marathon', start_at: '2026-10-11T07:00:00Z', aggregate_at: '2026-10-19T12:59:59Z', chapters: [] };
const WLEV = { id: 179, event_type: 'world_bloom', start_at: '2026-09-06T12:00:00Z', aggregate_at: '2026-09-10T11:59:59Z', chapters: [
    { chapter: 1, character_id: 23, start_at: '2026-09-06T12:00:00Z', aggregate_at: '2026-09-08T11:59:59Z' }, { chapter: 2, character_id: 21, start_at: '2026-09-08T12:00:00Z', aggregate_at: '2026-09-10T11:59:59Z' }] };
const RANKS = [1, 10, 100, 1000, 10000];
// rows at slot / -6 h / -24 h, with score(t) = base * hours since start
const rowsFor = (event, slot, ranks = RANKS, chapters = [0], { skip = [] } = {}) => {
    const out = []; for (const dt of [0, 6, 24]) { const t = new Date(slot.getTime() - dt * H); const hrs = (t.getTime() - T(event.start_at).getTime()) / H; if (hrs < 0) continue;
        for (const chapter of chapters) for (const rank of ranks) { if (skip.some((s) => s.chapter === chapter && s.rank === rank && s.dt === dt)) continue; out.push({ chapter, rank, score: Math.round(1000 * (11 - Math.log10(rank)) * hrs), taken_at: t.toISOString() }); } }
    return out;
};

test('activeWindows: main always (if inside and <= 21 d), chapters only when active; > 21 d dropped', () => {
    const w = activeWindows(WLEV, T('2026-09-07T00:00:00Z')); assert.deepEqual(w.map((x) => x.chapter), [0, 1]); assert.deepEqual(w.map((x) => x.days), [4, 2]);
    assert.deepEqual(activeWindows(WLEV, T('2026-09-08T12:00:00Z')).map((x) => x.chapter), [0, 2]);
    assert.deepEqual(activeWindows(EVENT, T('2026-10-19T12:59:59Z')), []);
    assert.deepEqual(activeWindows({ ...EVENT, aggregate_at: '2026-11-02T07:00:00Z' }, T('2026-10-12T00:00:00Z')), []);   // 22 days
    assert.equal(slotOf(T('2026-10-12T00:07:30Z')).toISOString(), '2026-10-12T00:05:00.000Z');
});
test('forecastLines: one row per line at the slot, all invariants hold, computed_at = slot, path ends at wEnd', () => {
    const now = T('2026-10-13T08:03:00Z'), slot = slotOf(now);
    const rows = forecastLines({ now, event: EVENT, params: makeParams(), slotRows: rowsFor(EVENT, slot) });
    assert.equal(rows.length, RANKS.length);
    for (const r of rows) {
        assert.equal(r.event_id, 182); assert.equal(r.chapter, 0); assert.equal(r.computed_at, slot.toISOString());
        assert.ok(r.current_score <= r.final_p10 && r.final_p10 <= r.final_p50 && r.final_p50 <= r.final_p90);
        assert.equal(r.path.t0, '2026-10-13T09:00:00.000Z'); assert.equal(r.path.p50.length, 148 + 1); assert.equal(r.path.p90.at(-1), r.final_p90);
        assert.equal(r.confidence, 'low');   // default-level quantiles
        assert.ok(['linear', 'measured'].includes(r.method));
    }
});
test('forecastLines: missing slot row -> that line skipped (Review Focus 1); zero score line -> no row (A9)', () => {
    const now = T('2026-10-13T08:03:00Z'), slot = slotOf(now);
    const rows = forecastLines({ now, event: EVENT, params: makeParams(), slotRows: rowsFor(EVENT, slot, RANKS, [0], { skip: [{ chapter: 0, rank: 10, dt: 0 }] }) });
    assert.deepEqual(rows.map((r) => r.rank), [1, 100, 1000, 10000]);
    const zero = forecastLines({ now, event: EVENT, params: makeParams(), slotRows: [{ chapter: 0, rank: 1, score: 0, taken_at: slot.toISOString() }] });
    assert.deepEqual(zero, []);
});
test('forecastLines: only active chapters (Review Focus 2); prior used when the stratum exists; profile skipped without the 6 h slot (Review Focus 3)', () => {
    const now = T('2026-09-07T00:03:00Z'), slot = slotOf(now);
    const p = makeParams({ prior: { 'main:world_bloom:4:1': { m: Math.log(5e6), n: 5 }, 'wl:-:2:1': { m: Math.log(2e6), n: 5 } },
        sigma: { cell: {}, group: {}, family: { main: { prior: { s: 0.05, n: 50 }, linear: { s: 0.5, n: 50 } }, wl: { prior: { s: 0.05, n: 50 }, linear: { s: 0.5, n: 50 } } } },
        profile: { 'wl:G1': { hod: new Array(24).fill(0), hte: new Array(10).fill(0), hfs: new Array(7).fill(0), wk: 0, n: 100, lines: 3 } } });
    const rows = forecastLines({ now, event: WLEV, params: p, slotRows: rowsFor(WLEV, slot, [1], [0, 1, 2]) });
    assert.deepEqual(rows.map((r) => [r.chapter, r.rank]), [[0, 1], [1, 1]]);   // chapter 2 not active
    // chapter 1 ends 2026-09-08T11:59:59; slot 11:55 < end <= now 11:59:59 -> no chapter-1 row (Review Focus 2); the main board (ends 09-10) is still forecast
    const edge = forecastLines({ now: T('2026-09-08T11:59:59Z'), event: WLEV, params: p, slotRows: rowsFor(WLEV, T('2026-09-08T11:55:00Z'), [1], [0, 1]) });
    assert.deepEqual(edge.map((r) => r.chapter), [0]);
    assert.equal(rows[0].method, 'prior'); assert.equal(rows[1].method, 'prior');   // prior sigma 0.05 outweighs linear 0.5 and the default-sigma members
    assert.equal(rows[1].confidence, 'low');
    // the flat profile is usable here (rHat > 0) and silently unavailable when the 6 h slot is missing: no throw, the line still gets a row
    const noSix = forecastLines({ now, event: WLEV, params: p, slotRows: rowsFor(WLEV, slot, [1], [1], { skip: [{ chapter: 1, rank: 1, dt: 6 }] }) });
    assert.equal(noSix.length, 1); assert.equal(noSix[0].method, 'prior');
});
test('forecastLines: a row that fails checkRow is dropped and logged, never written (A4 run-time check)', () => {
    const now = T('2026-10-13T08:03:00Z'), slot = slotOf(now);
    // params are not re-validated inside forecastLines; a NaN quantile makes every interval non-integer -> checkRow rejects each row
    const logs = []; const rows = forecastLines({ now, event: EVENT, params: makeParams({ resid: { cell: {}, group: {}, family: { main: { q10: NaN, q90: 0.2, n: 50, mae: 0.1, cover: 0.8 } } } }), slotRows: rowsFor(EVENT, slot), log: (lvl, msg, d) => logs.push({ lvl, msg, d }) });
    assert.deepEqual(rows, []); assert.equal(logs.length, RANKS.length); assert.ok(logs.every((l) => l.lvl === 'error' && l.msg === 'forecast row invalid'));
});
function fakeDb({ model = { trained_at: 'x', params: makeParams() }, slotsDelay = 0, hang = false, putResult = { written: true, upserted: 5, deleted: 0 } } = {}) {
    const calls = { put: 0, aborted: 0 };
    return { calls,
        loadModel: async () => model,
        loadSlots: (eventId, slots, signal) => new Promise((res, rej) => { if (hang) { signal.addEventListener('abort', () => { calls.aborted++; rej(new Error('aborted')); }); return; } setTimeout(() => res(rowsFor(EVENT, slots[0])), slotsDelay); }),
        putForecasts: async () => { calls.put++; return putResult; } };
}
test('inferRound: happy path writes once; no params -> no write, reason no_params; invalid params -> invalid_params', async () => {
    const db = fakeDb(); const r = await inferRound({ db, now: T('2026-10-13T08:03:00Z'), event: EVENT, log: () => {} });
    assert.deepEqual(r, { rows: 5, written: true, reason: null }); assert.equal(db.calls.put, 1);
    const none = fakeDb({ model: null }); assert.deepEqual(await inferRound({ db: none, now: T('2026-10-13T08:03:00Z'), event: EVENT, log: () => {} }), { rows: 0, written: false, reason: 'no_params' }); assert.equal(none.calls.put, 0);
    const bad = fakeDb({ model: { trained_at: 'x', params: { version: 2 } } }); assert.equal((await inferRound({ db: bad, now: T('2026-10-13T08:03:00Z'), event: EVENT, log: () => {} })).reason, 'invalid_params');
});
test('A14 (a): a hanging read is aborted at the deadline, nothing written, error thrown', async () => {
    const db = fakeDb({ hang: true });
    await assert.rejects(inferRound({ db, now: T('2026-10-13T08:03:00Z'), event: EVENT, log: () => {}, deadlineMs: 60, writeWithinMs: 40 }), /deadline/);
    assert.equal(db.calls.put, 0); assert.equal(db.calls.aborted, 1);
});
test('A14 (b): a read that completes after the write budget -> no write, timeout error', async () => {
    const db = fakeDb({ slotsDelay: 80 });
    await assert.rejects(inferRound({ db, now: T('2026-10-13T08:03:00Z'), event: EVENT, log: () => {}, deadlineMs: 500, writeWithinMs: 40 }), /write budget/);
    assert.equal(db.calls.put, 0);
});
test('inferRound: busy/stale from the RPC are reported, not thrown', async () => {
    const db = fakeDb({ putResult: { written: false, reason: 'busy' } }); const logs = [];
    assert.deepEqual(await inferRound({ db, now: T('2026-10-13T08:03:00Z'), event: EVENT, log: (l, m, d) => logs.push([l, m, d]) }), { rows: 5, written: false, reason: 'busy' });
    assert.ok(logs.some(([l, m]) => l === 'warn' && m === 'forecast not written'));
});
test('makeDeadline: race rejects after ms and aborts the signal; clear stops the timer', async () => {
    const d = makeDeadline(30); await assert.rejects(d.race(new Promise(() => {})), /deadline/); assert.equal(d.expired(), true);
    const d2 = makeDeadline(10000); assert.equal(await d2.race(Promise.resolve(7)), 7); d2.clear(); assert.equal(d2.expired(), false);
});
