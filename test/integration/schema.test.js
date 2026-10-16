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

test('finalize accepts 28 finals without the optional 1500/2500 on the main board and on a declared WL chapter', async () => {
    const ch = { chapter: 1, chapter_id: 17901, character_id: 21, start_at: '2026-09-06T12:00:00Z', aggregate_at: '2026-09-07T11:59:59Z', ranking_announce_at: '2026-09-07T12:09:59Z' };
    await insertEvent({ id: 179, name: 'wl', start_at: '2026-09-06T12:00:00Z', aggregate_at: '2026-09-10T11:59:59Z', ranking_announce_at: '2026-09-10T12:09:59Z', chapters: [ch] });
    const req = finals.filter((f) => f.rank !== 1500 && f.rank !== 2500);
    const r = await admin.rpc('sekai_border_finalize', { p_event_id: 179, p_finals: [...req, ...req.map((f) => ({ ...f, chapter: 1 }))] });
    assert.equal(r.error, null, r.error?.message); assert.equal(r.data.inserted_finals, 56);
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
