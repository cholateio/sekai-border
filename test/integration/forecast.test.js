import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, anon, truncate, insertEvent, insertRows, finalsFor, rpc, RANKS_LE_1000 } from './helpers.js';
import { ALLOWED_RANKS } from '../../src/constants.js';
import { buildSeries } from '../../src/forecast/series.js';
import { makeDb } from '../../src/db.js';
import { runOnce } from '../../src/run.js';
import { makeParams } from '../helpers/params.js';
import { readFileSync } from 'node:fs';
const T = (s) => new Date(s);
const WL = { id: 179, name: 'wl', start_at: '2026-09-06T12:00:00Z', aggregate_at: '2026-09-10T11:59:59Z', ranking_announce_at: '2026-09-10T12:09:59Z',
    chapters: [{ chapter: 1, chapter_id: 17901, character_id: 23, start_at: '2026-09-06T12:00:00Z', aggregate_at: '2026-09-08T11:59:59Z', ranking_announce_at: '2026-09-08T12:09:59Z' },
               { chapter: 2, chapter_id: 17902, character_id: 21, start_at: '2026-09-08T12:00:00Z', aggregate_at: '2026-09-10T11:59:59Z', ranking_announce_at: '2026-09-10T12:09:59Z' }] };
const WL_RANKS = ALLOWED_RANKS.filter((r) => r !== 1500 && r !== 2500);
// 5-minute snapshots for ranks over [from, to), optionally skipping a set of whole hours (gaps)
function snapshots(eventId, chapter, ranks, from, to, { skipHours = [], base = 1000 } = {}) {
    const out = []; for (let t = T(from).getTime(), k = 0; t < T(to).getTime(); t += 300000, k++) {
        if (skipHours.includes(new Date(t).toISOString().slice(0, 13))) continue;
        for (const rank of ranks) out.push({ event_id: eventId, chapter, rank, score: base * (1 + ranks.indexOf(rank)) + k, taken_at: new Date(t).toISOString(), is_final: false });
    } return out;
}
test.beforeEach(truncate);

test('A5: SQL series_rows equals buildSeries for :59:59 end, whole-hour end, gaps, absent rank, unaligned start, chapter window', async () => {
    await insertEvent({ id: 182, start_at: '2026-10-11T07:30:00Z', aggregate_at: '2026-10-11T19:59:59Z' });
    const rows = snapshots(182, 0, [1, 2, 1000, 1500], '2026-10-11T07:30:00Z', '2026-10-11T20:00:00Z', { skipHours: ['2026-10-11T10', '2026-10-11T11'] }).filter((r) => !(r.rank === 2 && r.taken_at > '2026-10-11T09'));
    await insertRows(rows);
    const sql = await rpc('sekai_border_test_series_rows', { p_event_id: 182, p_chapter: 0 });
    const js = buildSeries(rows, T('2026-10-11T07:30:00Z'), T('2026-10-11T19:59:59Z'));
    assert.deepEqual(sql.map((r) => r.rank), [1, 2, 1000]);   // 1500 excluded, 2 present (has early snapshots)
    for (const r of sql) { assert.equal(T(r.start_at).toISOString(), js.get(r.rank).start_at.toISOString()); assert.deepEqual(r.scores, js.get(r.rank).scores); }
    assert.equal(sql[0].scores.length, 13);   // 07..19
    assert.equal(sql[0].scores[3], null); assert.equal(sql[0].scores[4], null);   // 10h, 11h gaps
    // whole-hour end excludes the end bucket
    await admin.from('sekai_border_events').update({ aggregate_at: '2026-10-11T19:00:00Z', ranking_announce_at: '2026-10-11T19:10:00Z' }).eq('id', 182);
    const sql2 = await rpc('sekai_border_test_series_rows', { p_event_id: 182, p_chapter: 0 });
    assert.equal(sql2[0].scores.length, 12); assert.deepEqual(sql2[0].scores, buildSeries(rows, T('2026-10-11T07:30:00Z'), T('2026-10-11T19:00:00Z')).get(1).scores);
    // chapter window
    await admin.from('sekai_border_events').insert(WL);
    const ch = snapshots(179, 1, [1, 100], '2026-09-06T12:00:00Z', '2026-09-08T12:00:00Z');
    await insertRows(ch);
    const sqlc = await rpc('sekai_border_test_series_rows', { p_event_id: 179, p_chapter: 1 });
    assert.equal(sqlc.length, 2); assert.equal(sqlc[0].scores.length, 48);
    assert.deepEqual(sqlc[0].scores, buildSeries(ch, T('2026-09-06T12:00:00Z'), T('2026-09-08T11:59:59Z')).get(1).scores);
});

test('A6 phase 1: finalize writes series, keeps rank <= 1000 raw rows, compacts rank > 1000; series failure rolls everything back', async () => {
    await insertEvent({ id: 182, start_at: '2026-10-11T07:00:00Z', aggregate_at: '2026-10-13T06:59:59Z', ranking_announce_at: '2026-10-13T07:09:59Z' });
    const rows = snapshots(182, 0, ALLOWED_RANKS, '2026-10-11T07:00:00Z', '2026-10-13T07:00:00Z');   // 48 h x 12 x 30 = 17,280
    await insertRows(rows);
    const finals = finalsFor(0, ALLOWED_RANKS);
    // injected failure: nothing changes
    const bad = await admin.rpc('sekai_border_test_finalize_failing_series', { p_event_id: 182, p_finals: finals });
    assert.match(bad.error?.message ?? '', /injected series failure/);
    const { count: c0 } = await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true }).eq('event_id', 182); assert.equal(c0, rows.length);
    const ev0 = await admin.from('sekai_border_events').select('finalized_at').eq('id', 182).single(); assert.equal(ev0.data.finalized_at, null);
    const { count: s0 } = await admin.from('sekai_border_series').select('*', { count: 'exact', head: true }); assert.equal(s0, 0);
    // success
    const r = await rpc('sekai_border_finalize', { p_event_id: 182, p_finals: finals });
    assert.equal(r.series_rows, 24); assert.equal(r.purged_snapshots, 0); assert.equal(r.inserted_finals, 30);
    const { count: le } = await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true }).eq('event_id', 182).eq('is_final', false).lte('rank', 1000); assert.equal(le, 24 * 576);
    const { count: gt } = await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true }).eq('event_id', 182).eq('is_final', false).gt('rank', 1000); assert.equal(gt, 6 * (24 + 9));   // 24 hourly (from Oct 12 06:59:59) + 9 epoch-aligned 3 h buckets (Oct 11 06-09 .. Oct 12 06-09)
    const s = await admin.from('sekai_border_series').select('rank,start_at,scores').eq('event_id', 182).eq('rank', 1).single();
    assert.equal(s.data.scores.length, 48); assert.ok(s.data.scores.every((x) => x !== null));
    // strict verify passes on untouched raw data
    assert.equal(await rpc('sekai_border_series_verify', { p_event_id: 182, p_chapter: 0 }), 24);
});

test('A6 phase 2 guard: purge_dup verifies then deletes listed events only; tampered series (one bucket / short array / extra value) roll back', async () => {
    await insertEvent({ id: 182, start_at: '2026-10-11T07:00:00Z', aggregate_at: '2026-10-11T12:59:59Z', ranking_announce_at: '2026-10-11T13:09:59Z' });
    await insertEvent({ id: 183, start_at: '2026-10-12T07:00:00Z', aggregate_at: '2026-10-12T12:59:59Z', ranking_announce_at: '2026-10-12T13:09:59Z' });
    await insertRows([...snapshots(182, 0, ALLOWED_RANKS, '2026-10-11T07:00:00Z', '2026-10-11T13:00:00Z'), ...snapshots(183, 0, ALLOWED_RANKS, '2026-10-12T07:00:00Z', '2026-10-12T13:00:00Z')]);
    await rpc('sekai_border_finalize', { p_event_id: 182, p_finals: finalsFor(0, ALLOWED_RANKS) });
    await rpc('sekai_border_finalize', { p_event_id: 183, p_finals: finalsFor(0, ALLOWED_RANKS) });
    const raw = async (id) => (await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true }).eq('event_id', id).eq('is_final', false).lte('rank', 1000)).count;
    assert.equal(await raw(182), 24 * 72); assert.equal(await raw(183), 24 * 72);
    const good = (await admin.from('sekai_border_series').select('scores').eq('event_id', 182).eq('chapter', 0).eq('rank', 1).single()).data.scores;
    for (const scores of [[...good.slice(0, 2), good[2] + 1, ...good.slice(3)], good.slice(0, -1), good.map((x, i) => (i === 3 ? null : x))]) {
        await admin.from('sekai_border_series').update({ scores }).eq('event_id', 182).eq('chapter', 0).eq('rank', 1);
        const r = await admin.rpc('sekai_border_purge_dup', { p_event_ids: [182, 183], p_chapter_lo: 0, p_chapter_hi: 0 });
        assert.match(r.error?.message ?? '', /differs|mismatch/);
        assert.equal(await raw(182), 24 * 72); assert.equal(await raw(183), 24 * 72);   // whole call rolled back, 183 untouched too
    }
    await admin.from('sekai_border_series').update({ scores: good }).eq('event_id', 182).eq('chapter', 0).eq('rank', 1);
    const ok = await rpc('sekai_border_purge_dup', { p_event_ids: [182], p_chapter_lo: 0, p_chapter_hi: 0 });
    assert.equal(ok.deleted_snapshots, 24 * 72); assert.equal(ok.verified_rows, 24);
    assert.equal(await raw(182), 0); assert.equal(await raw(183), 24 * 72);   // not in the list: untouched
    const again = await admin.rpc('sekai_border_purge_dup', { p_event_ids: [182], p_chapter_lo: 0, p_chapter_hi: 0 }); assert.match(again.error?.message ?? '', /differs|no series|mismatch/);   // raw rows gone: verification fails, nothing is assumed
    const { count: gt } = await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true }).eq('event_id', 182).eq('is_final', false).gt('rank', 1000); assert.equal(gt, 6 * 6);
    const nf = await admin.rpc('sekai_border_purge_dup', { p_event_ids: [999], p_chapter_lo: 0, p_chapter_hi: 0 }); assert.match(nf.error?.message ?? '', /not finalized/);
});

test('A7 (tables): anon reads forecasts only; writes and series/model reads are 42501; RLS on', async () => {
    await insertEvent();
    const p = await rpc('sekai_border_test_privileges2', {});
    assert.deepEqual(p.rls, { sekai_border_series: true, sekai_border_model: true, sekai_border_forecasts: true });
    for (const x of p.privs) assert.equal(x.has, x.rel === 'sekai_border_forecasts' && x.priv === 'SELECT', JSON.stringify(x));
    for (const t of ['sekai_border_series', 'sekai_border_model']) { const r = await anon.from(t).select('*'); assert.equal(r.error?.code, '42501', t); }
    const f = await anon.from('sekai_border_forecasts').select('*'); assert.equal(f.error, null);
    const w = await anon.from('sekai_border_forecasts').insert({ event_id: 182, chapter: 0, rank: 1, computed_at: '2026-10-12T00:00:00Z', current_score: 1, final_p10: 1, final_p50: 1, final_p90: 1, path: {}, method: 'linear', confidence: 'low' }); assert.equal(w.error?.code, '42501');
});

const frow = (eventId, rank, computedAt, over = {}) => ({ event_id: eventId, chapter: 0, rank, computed_at: computedAt, current_score: 100, final_p10: 110, final_p50: 120, final_p90: 130, path: { t0: '2026-10-12T01:00:00Z', p10: [105, 110], p50: [110, 120], p90: [115, 130] }, method: 'linear', confidence: 'low', ...over });
const count = async () => (await admin.from('sekai_border_forecasts').select('*', { count: 'exact', head: true })).count;
const maxComputed = async () => { const r = await admin.from('sekai_border_forecasts').select('computed_at').order('computed_at', { ascending: false }).limit(1); return r.data[0]?.computed_at ?? null; };

test('A13: monotonic writes — stale on T1 < T2 and on repeat T2; empty is a no-op that keeps the watermark; a new event deletes the old one; mismatched rows raise', async () => {
    await insertEvent({ id: 182 }); await insertEvent({ id: 183, start_at: '2026-10-21T07:00:00Z', aggregate_at: '2026-10-29T12:59:59Z', ranking_announce_at: '2026-10-29T13:09:59Z' });
    const T1 = '2026-10-12T00:00:00+00:00', T2 = '2026-10-12T00:05:00+00:00', T3 = '2026-10-12T00:10:00+00:00';
    const w2 = await rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: T2, p_rows: [frow(182, 1, T2), frow(182, 2, T2)] });
    assert.deepEqual(w2, { written: true, upserted: 2, deleted: 0 }); assert.equal(await count(), 2);
    assert.deepEqual(await rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: T1, p_rows: [frow(182, 1, T1, { current_score: 999, final_p10: 999, final_p50: 999, final_p90: 999 })] }), { written: false, reason: 'stale' });
    assert.deepEqual(await rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: T2, p_rows: [frow(182, 3, T2)] }), { written: false, reason: 'stale' });
    assert.equal(await count(), 2); assert.equal((await admin.from('sekai_border_forecasts').select('current_score').eq('rank', 1).single()).data.current_score, 100);
    assert.deepEqual(await rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: T3, p_rows: [] }), { written: false, reason: 'empty' });
    assert.equal(await count(), 2); assert.equal(T(await maxComputed()).toISOString(), T(T2).toISOString());
    assert.deepEqual(await rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: T1, p_rows: [frow(182, 1, T1)] }), { written: false, reason: 'stale' });
    // new event at T3: old event's rows deleted; old event at T1 afterwards cannot delete the new rows
    const w3 = await rpc('sekai_border_put_forecasts', { p_event_id: 183, p_computed_at: T3, p_rows: [frow(183, 1, T3)] });
    assert.deepEqual(w3, { written: true, upserted: 1, deleted: 2 });
    assert.deepEqual(await rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: T1, p_rows: [frow(182, 1, T1)] }), { written: false, reason: 'stale' });
    assert.equal(await count(), 1);
    // same-event rows not in p_rows are dropped
    const T4 = '2026-10-12T00:15:00+00:00';
    assert.deepEqual(await rpc('sekai_border_put_forecasts', { p_event_id: 183, p_computed_at: T4, p_rows: [frow(183, 2, T4)] }), { written: true, upserted: 1, deleted: 1 });
    // mismatched event_id / computed_at raise, table unchanged
    for (const rows of [[frow(182, 1, T4)], [frow(183, 1, T3)]]) { const r = await admin.rpc('sekai_border_put_forecasts', { p_event_id: 183, p_computed_at: T4, p_rows: rows }); assert.match(r.error?.message ?? '', /does not match/); }
    assert.equal(await count(), 1); assert.equal(T(await maxComputed()).toISOString(), T(T4).toISOString());
    // check constraint
    const bad = await admin.rpc('sekai_border_put_forecasts', { p_event_id: 183, p_computed_at: '2026-10-12T00:20:00Z', p_rows: [frow(183, 1, '2026-10-12T00:20:00Z', { final_p10: 90 })] }); assert.match(bad.error?.message ?? '', /sekai_border_forecasts_order/);
});

test('A14 (locks): conflicting locks -> busy, table unchanged, no late commit; ACCESS SHARE reader -> written; 121 rows / 506-point path raise', async () => {
    await insertEvent({ id: 182 });
    const T1 = '2026-10-12T00:00:00+00:00';
    await rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: T1, p_rows: [frow(182, 1, T1)] });
    let t = 1;
    for (const mode of ['row_exclusive', 'share', 'access_exclusive']) {
        const at = `2026-10-12T00:${String(5 * t++).padStart(2, '0')}:00+00:00`;
        const holder = admin.rpc('sekai_border_test_hold_lock', { p_mode: mode, p_seconds: 2.5 }).then((x) => x);   // PostgREST builders are lazy: .then() sends now
        await new Promise((r) => setTimeout(r, 600));
        const started = Date.now();
        const res = await rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: at, p_rows: [frow(182, 1, at, { current_score: 105 })] });
        assert.deepEqual(res, { written: false, reason: 'busy' }, mode); assert.ok(Date.now() - started < 1500, `${mode}: returned immediately`);
        const h = await holder; assert.equal(h.error, null, mode);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal((await admin.from('sekai_border_forecasts').select('current_score').eq('rank', 1).single()).data.current_score, 100, `${mode}: no late commit`);
    }
    const at = '2026-10-12T01:00:00+00:00';
    const reader = admin.rpc('sekai_border_test_hold_lock', { p_mode: 'access_share', p_seconds: 2 }).then((x) => x);
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(await rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: at, p_rows: [frow(182, 1, at, { current_score: 101 })] }), { written: true, upserted: 1, deleted: 0 });
    await reader;
    const at2 = '2026-10-12T02:00:00+00:00';
    const many = Array.from({ length: 121 }, (_, i) => frow(182, 1, at2, { chapter: Math.floor(i / 30), rank: ALLOWED_RANKS[i % 30] }));
    const r1 = await admin.rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: at2, p_rows: many }); assert.match(r1.error?.message ?? '', /max 120/);
    const long = frow(182, 1, at2, { path: { t0: at2, p10: new Array(506).fill(100), p50: new Array(506).fill(100), p90: new Array(506).fill(100) } });
    const r2 = await admin.rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: at2, p_rows: [long] }); assert.match(r2.error?.message ?? '', /505/);
    assert.equal((await admin.from('sekai_border_forecasts').select('current_score').eq('rank', 1).single()).data.current_score, 101);
});

test('A7 (functions): anon/authenticated cannot execute the RPCs and an anon call fails', async () => {
    const p = await rpc('sekai_border_test_privileges2', {});
    for (const [f, v] of Object.entries(p.fn)) { assert.equal(v.anon, false, f); assert.equal(v.authenticated, false, f); assert.equal(v.service_role, !f.startsWith('sekai_border_finalize_core'), f); }   // core is reachable only through the security-definer wrappers
    const r = await anon.rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: '2026-10-12T00:00:00Z', p_rows: [] }); assert.ok(r.error, 'anon rpc must fail');
});

// Exact 0001 compaction rule: last observation per bucket; hourly inside the final 24 h before aggregate_at, 3-hourly (epoch-aligned) earlier.
function compactLegacy(rows, aggregateAt) {
    const cut = Date.parse(aggregateAt) - 24 * 3600000, last = new Map();
    for (const r of rows) { const t = Date.parse(r.taken_at), g = t >= cut ? 3600000 : 10800000, k = `${r.chapter}:${r.rank}:${g}:${Math.floor(t / g)}`; const prev = last.get(k); if (!prev || Date.parse(prev.taken_at) < t) last.set(k, r); }
    return new Set([...last.values()].map((r) => `${r.chapter}:${r.rank}:${r.taken_at}`));
}
test('put_series (spec §9 step 3): only finalized events; null-only updates; agreement with DB-held raw snapshots; failure rolls back', async () => {
    // 30 h window: the first 6 h compact to 3 h buckets (hours 07, 09, 10 end up unobserved), the rest hourly
    await insertEvent({ id: 182, start_at: '2026-10-11T07:00:00Z', aggregate_at: '2026-10-12T12:59:59Z', ranking_announce_at: '2026-10-12T13:09:59Z' });
    const rows = snapshots(182, 0, [1, 1000, 1500], '2026-10-11T07:00:00Z', '2026-10-12T13:00:00Z');
    await insertRows(rows);
    const full = buildSeries(rows, T('2026-10-11T07:00:00Z'), T('2026-10-12T12:59:59Z'));
    const row = (rank, scores) => ({ chapter: 0, rank, start_at: '2026-10-11T07:00:00Z', scores });
    const notFinal = await admin.rpc('sekai_border_put_series', { p_event_id: 182, p_rows: [row(1, full.get(1).scores)] }); assert.match(notFinal.error?.message ?? '', /not finalized/);
    // emulate a database finalized under the sub-project-1 rule: finalize (phase 1 keeps rank <= 1000 raw), drop the series it wrote, compact rank <= 1000 by the exact 0001 rule
    await rpc('sekai_border_finalize', { p_event_id: 182, p_finals: finalsFor(0, ALLOWED_RANKS) });
    await admin.from('sekai_border_series').delete().eq('event_id', 182);
    const keep = compactLegacy(rows.filter((r) => r.rank <= 1000), '2026-10-12T12:59:59Z');
    for (const rank of [1, 1000]) { const drop = rows.filter((r) => r.rank === rank && !keep.has(`0:${rank}:${r.taken_at}`)).map((r) => r.taken_at); const { error } = await admin.from('sekai_border_rankings').delete().eq('event_id', 182).eq('rank', rank).eq('is_final', false).in('taken_at', drop); if (error) throw new Error(error.message); }
    const kept = keep.size;   // 2 ranks x (3 three-hour buckets + 24 hourly) = 54
    assert.equal(kept, 54);
    assert.equal(full.get(1).scores.length, 30);
    // partial series (gap at bucket 2 = hour 09, unobserved after compaction) then the full one: insert, then null-only update
    const partial = full.get(1).scores.map((x, i) => (i === 2 ? null : x));
    assert.deepEqual(await rpc('sekai_border_put_series', { p_event_id: 182, p_rows: [row(1, partial), row(1000, full.get(1000).scores)] }), { inserted: 2, updated: 0, checked: kept });
    assert.deepEqual(await rpc('sekai_border_put_series', { p_event_id: 182, p_rows: [row(1, full.get(1).scores)] }), { inserted: 0, updated: 1, checked: kept });
    const changed = full.get(1).scores.map((x, i) => (i === 0 ? x + 1 : x));
    const c = await admin.rpc('sekai_border_put_series', { p_event_id: 182, p_rows: [row(1, changed)] }); assert.match(c.error?.message ?? '', /would change/);
    // a series that disagrees with a DB-held snapshot is rejected (bucket 1 = hour 08 holds the 08:55 point)
    await admin.from('sekai_border_series').delete().eq('event_id', 182).eq('rank', 1000);
    const wrong = full.get(1000).scores.map((x, i) => (i === 1 ? x + 1 : x));
    const d = await admin.rpc('sekai_border_put_series', { p_event_id: 182, p_rows: [row(1000, wrong)] }); assert.match(d.error?.message ?? '', /disagree/);
    const { count } = await admin.from('sekai_border_series').select('*', { count: 'exact', head: true }).eq('event_id', 182); assert.equal(count, 1);   // rolled back
    const bad = await admin.rpc('sekai_border_put_series', { p_event_id: 182, p_rows: [row(1000, full.get(1000).scores.slice(1))] }); assert.match(bad.error?.message ?? '', /length/);
});

test('finalize_core with purge enabled deletes only in-window rank <= 1000 raw rows; a snapshot at/after W_end survives (codex phase-A review)', async () => {
    await insertEvent({ id: 182, start_at: '2026-10-11T07:00:00Z', aggregate_at: '2026-10-11T12:59:59Z', ranking_announce_at: '2026-10-11T13:09:59Z' });
    await insertRows([...snapshots(182, 0, ALLOWED_RANKS, '2026-10-11T07:00:00Z', '2026-10-11T13:00:00Z'), { event_id: 182, chapter: 0, rank: 1, score: 1, taken_at: '2026-10-11T13:00:00Z', is_final: false }]);
    const r = await rpc('sekai_border_test_finalize_core', { p_event_id: 182, p_finals: finalsFor(0, ALLOWED_RANKS), p_purge_max_chapter: 0 });
    assert.equal(r.series_rows, 24); assert.equal(r.purged_snapshots, 24 * 72);
    const left = await admin.from('sekai_border_rankings').select('taken_at').eq('event_id', 182).eq('is_final', false).lte('rank', 1000);
    assert.deepEqual(left.data.map((x) => T(x.taken_at).toISOString()), ['2026-10-11T13:00:00.000Z']);
});

test('put_series rejects an existing row whose start_at or length does not match the window (codex phase-A review)', async () => {
    await insertEvent({ id: 182, start_at: '2026-10-11T07:00:00Z', aggregate_at: '2026-10-11T12:59:59Z', ranking_announce_at: '2026-10-11T13:09:59Z' });
    const rows = snapshots(182, 0, [1], '2026-10-11T07:00:00Z', '2026-10-11T13:00:00Z');
    await insertRows(rows);
    await rpc('sekai_border_finalize', { p_event_id: 182, p_finals: finalsFor(0, ALLOWED_RANKS) });
    const good = buildSeries(rows, T('2026-10-11T07:00:00Z'), T('2026-10-11T12:59:59Z')).get(1).scores;
    const row = { chapter: 0, rank: 1, start_at: '2026-10-11T07:00:00Z', scores: good };
    await admin.from('sekai_border_series').update({ start_at: '2026-10-11T08:00:00Z' }).eq('event_id', 182).eq('rank', 1);
    assert.match((await admin.rpc('sekai_border_put_series', { p_event_id: 182, p_rows: [row] })).error?.message ?? '', /structure/);
    await admin.from('sekai_border_series').update({ start_at: '2026-10-11T07:00:00Z', scores: [...good, 5] }).eq('event_id', 182).eq('rank', 1);
    assert.match((await admin.rpc('sekai_border_put_series', { p_event_id: 182, p_rows: [row] })).error?.message ?? '', /structure/);
    // a stored row not named in p_rows but structurally wrong also fails the consistency pass
    await admin.from('sekai_border_series').update({ scores: good, start_at: '2026-10-11T08:00:00Z' }).eq('event_id', 182).eq('rank', 1);
    assert.match((await admin.rpc('sekai_border_put_series', { p_event_id: 182, p_rows: [] })).error?.message ?? '', /disagree/);
});

test('put_forecasts: SQL NULL arguments raise before any delete; rows and the watermark survive (codex phase-A review r2)', async () => {
    await insertEvent({ id: 182 });
    const T2 = '2026-10-12T00:05:00+00:00', T3 = '2026-10-12T00:10:00+00:00';
    await rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: T2, p_rows: [frow(182, 1, T2), frow(182, 2, T2)] });
    for (const args of [{ p_event_id: 182, p_computed_at: T3, p_rows: null }, { p_event_id: 182, p_computed_at: null, p_rows: [frow(182, 1, T3)] }, { p_event_id: null, p_computed_at: T3, p_rows: [frow(182, 1, T3)] }]) {
        const r = await admin.rpc('sekai_border_put_forecasts', args); assert.match(r.error?.message ?? '', /must not be null/, JSON.stringify(args));
    }
    assert.equal(await count(), 2); assert.equal(T(await maxComputed()).toISOString(), T(T2).toISOString());
});
const fx = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8'));
const upstreamFx = () => ({ live: async () => ({ top100: fx('live-top100'), border: fx('live-border') }), eventList: async () => fx('event-list'), finals: async (id) => ({ border: { ...fx('final-border-181'), eventId: id }, top100: fx('final-top100-181') }), master: async (name) => ({ status: 200, etag: 'x', body: fx('master-' + name.replace('.json', '')) }) });

test('end to end: a round with a seeded model writes forecasts for every live line; the same slot again is stale; finalize then trains and saves the model', async () => {
    const db = makeDb(admin); const id = fx('live-top100').id;
    await insertEvent({ id, metadata_status: 'complete' });
    await admin.from('sekai_border_model').upsert({ id: 1, trained_at: '2026-10-14T00:00:00Z', params: makeParams() });
    const slot = T('2026-10-15T00:00:00Z');
    await insertRows([6, 24].flatMap((h) => ALLOWED_RANKS.map((rank, i) => ({ event_id: id, chapter: 0, rank, score: 1_000_000 - i * 1000 - h * 100, taken_at: new Date(slot.getTime() - h * 3600000).toISOString(), is_final: false }))));
    const a = await runOnce({ db, upstream: upstreamFx(), now: T('2026-10-15T00:03:00Z'), cache: {} });
    assert.equal(a.status, 200); assert.equal(a.body.forecast.written, true); assert.equal(a.body.forecast.rows, 30);
    const { data: rows } = await admin.from('sekai_border_forecasts').select('*').eq('event_id', id); assert.equal(rows.length, 30);
    assert.ok(rows.every((r) => T(r.computed_at).getTime() === slot.getTime() && r.current_score <= r.final_p10 && r.path.p50.length === r.path.p90.length));
    const anonRead = await anon.from('sekai_border_forecasts').select('rank,final_p50').eq('rank', 1); assert.equal(anonRead.error, null); assert.equal(anonRead.data.length, 1);
    const b = await runOnce({ db, upstream: upstreamFx(), now: T('2026-10-15T00:04:30Z'), cache: {} }); assert.deepEqual(b.body.forecast, { rows: 30, written: false, reason: 'stale' });
    // finalize -> train -> model row refreshed
    await admin.from('sekai_border_events').update({ aggregate_at: '2026-10-15T01:10:00Z', ranking_announce_at: '2026-10-15T01:20:00Z' }).eq('id', id);
    const c = await runOnce({ db, upstream: upstreamFx(), now: T('2026-10-15T01:45:00Z'), cache: {} });
    assert.deepEqual(c.body.finalized, [id]); assert.equal(c.body.trained.saved, true); assert.equal(c.body.trained.main_periods, 1);
    const m = await admin.from('sekai_border_model').select('trained_at,params').eq('id', 1).single(); assert.equal(T(m.data.trained_at).toISOString(), '2026-10-15T01:45:00.000Z'); assert.equal(m.data.params.input.main_periods, 1);
    assert.equal(c.body.forecast, null);   // branch was 'due', nothing to forecast
});

test('put_forecasts: infinite computed_at and malformed paths (missing quantile / t0, unequal or empty lengths) raise; table unchanged (codex phase-A review r3)', async () => {
    await insertEvent({ id: 182 });
    const T2 = '2026-10-12T00:05:00+00:00', T3 = '2026-10-12T00:10:00+00:00';
    await rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: T2, p_rows: [frow(182, 1, T2)] });
    const inf = await admin.rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: 'infinity', p_rows: [frow(182, 1, 'infinity')] }); assert.match(inf.error?.message ?? '', /finite/);
    const base = frow(182, 1, T3).path;
    for (const path of [{ t0: base.t0, p10: base.p10, p50: base.p50 }, { p10: base.p10, p50: base.p50, p90: base.p90 }, { ...base, p90: [130] }, { t0: base.t0, p10: [], p50: [], p90: [] }, 'x']) {
        const r = await admin.rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: T3, p_rows: [frow(182, 1, T3, { path })] }); assert.match(r.error?.message ?? '', /path/, JSON.stringify(path));
    }
    assert.equal(await count(), 1); assert.equal(T(await maxComputed()).toISOString(), T(T2).toISOString());
});

test('purge_dup: NULL, reversed or out-of-range chapter bounds and a NULL id list raise without touching anything (codex phase-A review r3)', async () => {
    await insertEvent({ id: 182, start_at: '2026-10-11T07:00:00Z', aggregate_at: '2026-10-11T12:59:59Z', ranking_announce_at: '2026-10-11T13:09:59Z' });
    await insertRows(snapshots(182, 0, ALLOWED_RANKS, '2026-10-11T07:00:00Z', '2026-10-11T13:00:00Z'));
    await rpc('sekai_border_finalize', { p_event_id: 182, p_finals: finalsFor(0, ALLOWED_RANKS) });
    for (const [ids, lo, hi] of [[[182], null, 0], [[182], 0, null], [[182], 1, 0], [[182], -1, 0], [[182], 0, 7], [null, 0, 0]]) {
        const r = await admin.rpc('sekai_border_purge_dup', { p_event_ids: ids, p_chapter_lo: lo, p_chapter_hi: hi }); assert.match(r.error?.message ?? '', /bounds|must not be null/, JSON.stringify([ids, lo, hi]));
    }
    const { count: raw } = await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true }).eq('event_id', 182).eq('is_final', false).lte('rank', 1000); assert.equal(raw, 24 * 72);
});

test('purge_dup: an empty id list or an event with no chapter in range fails instead of a silent no-op (codex phase-A review r4)', async () => {
    await insertEvent({ id: 182, start_at: '2026-10-11T07:00:00Z', aggregate_at: '2026-10-11T12:59:59Z', ranking_announce_at: '2026-10-11T13:09:59Z' });
    await insertRows(snapshots(182, 0, ALLOWED_RANKS, '2026-10-11T07:00:00Z', '2026-10-11T13:00:00Z'));
    await rpc('sekai_border_finalize', { p_event_id: 182, p_finals: finalsFor(0, ALLOWED_RANKS) });
    const empty = await admin.rpc('sekai_border_purge_dup', { p_event_ids: [], p_chapter_lo: 0, p_chapter_hi: 0 }); assert.match(empty.error?.message ?? '', /empty/);
    const noCh = await admin.rpc('sekai_border_purge_dup', { p_event_ids: [182], p_chapter_lo: 1, p_chapter_hi: 6 }); assert.match(noCh.error?.message ?? '', /no chapter/);
    const { count: raw } = await admin.from('sekai_border_rankings').select('*', { count: 'exact', head: true }).eq('event_id', 182).eq('is_final', false).lte('rank', 1000); assert.equal(raw, 24 * 72);
});

test('db.saveModel is monotonic on trained_at: an older candidate never replaces a newer row (codex final r1)', async () => {
    const db = makeDb(admin);
    assert.equal(await db.saveModel(makeParams({ input: { main_periods: 2, wl_periods: 0, prior_rows: 0, excluded: [] } }), T('2026-10-15T02:00:00Z')), true);
    assert.equal(await db.saveModel(makeParams({ input: { main_periods: 1, wl_periods: 0, prior_rows: 0, excluded: [] } }), T('2026-10-15T01:00:00Z')), false);
    let m = await admin.from('sekai_border_model').select('trained_at,params').eq('id', 1).single(); assert.equal(m.data.params.input.main_periods, 2); assert.equal(T(m.data.trained_at).toISOString(), '2026-10-15T02:00:00.000Z');
    assert.equal(await db.saveModel(makeParams({ input: { main_periods: 3, wl_periods: 0, prior_rows: 0, excluded: [] } }), T('2026-10-15T03:00:00Z')), true);
    m = await admin.from('sekai_border_model').select('params').eq('id', 1).single(); assert.equal(m.data.params.input.main_periods, 3);
});
