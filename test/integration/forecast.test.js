import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, anon, truncate, insertEvent, insertRows, finalsFor, rpc, RANKS_LE_1000 } from './helpers.js';
import { ALLOWED_RANKS } from '../../src/constants.js';
import { buildSeries } from '../../src/forecast/series.js';
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
