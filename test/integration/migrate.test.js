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
    await insertEvent(); await insertEvent({ id: 181, name: 'old', start_at: '2026-10-01T07:00:00Z', aggregate_at: '2026-10-09T12:59:59Z', ranking_announce_at: '2026-10-09T13:09:59Z' });
    await ins([...live('2026-10-05T00:00:00Z', 700, 181), ...live('2026-10-20T11:45:00Z', 100), ...live('2026-10-20T12:05:00Z'), ...live('2026-10-20T12:10:00Z', 9000)]);   // bases >= 29: score has a >= 0 CHECK
    await admin.from('sekai_border_events').update({ finalized_at: '2026-10-09T14:00:00Z' }).eq('id', 181);   // finalized afterwards: the write guard rejects snapshots into an already-finalized event
    await legacy([...rows(181, '2026-10-05T00:00:10Z', 9), ...rows(182, '2026-10-20T11:50:10Z'), ...rows(182, '2026-10-20T11:50:40Z', 1100), ...rows(182, '2026-10-20T11:55:05Z', 1200), ...rows(182, '2026-10-20T12:00:03Z', 1300, ALLOWED_RANKS.slice(0, 29)), ...rows(182, '2026-10-20T12:05:02Z', 1400), { event_id: 'unknown_event', rank: 1, score: 1, created_at: '2026-10-20T11:55:05Z' }, { event_id: '99999999999', rank: 1, score: 1, created_at: '2026-10-20T11:55:05Z' }, { event_id: '-5', rank: 1, score: 1, created_at: '2026-10-20T11:55:05Z' }, { event_id: '777', rank: 1, score: 1, created_at: '2026-10-20T11:55:05Z' }]);   // 777 parses but is not an events row
    const r = await admin.rpc('sekai_border_exec_migration', { p_event_id: 182, p_cutover: '2026-10-20T12:05:00Z', p_candidate_slot: '2026-10-20T11:45:00Z', p_allow_skipped: 100 });   // 11:45 = the candidate run's slot
    assert.equal(r.error, null, r.error?.message);
    assert.deepEqual(r.data, { inserted: 60, deleted_candidate_rows: 30, skipped_invalid_id_rows: 4, skipped_partial_slot_rows: 29, verified_slots: 2, destination_slots: 4 });
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
test('rolls back: cutover later or earlier than the first new-crawler slot; candidate slot holding a partial row set', async () => {
    await insertEvent(); await ins([...live('2026-10-20T12:05:00Z'), ...live('2026-10-20T12:10:00Z', 6000)]);
    await legacy(rows(182, '2026-10-20T11:50:10Z'));
    let r = await run('2026-10-20T12:10:00Z'); assert.match(r.error?.message ?? '', /not the first new-crawler slot/);   // would have deleted the real 12:05 snapshot
    r = await run('2026-10-20T12:00:00Z'); assert.match(r.error?.message ?? '', /not the first new-crawler slot/);
    await ins(live('2026-10-20T11:40:00Z', 300).slice(0, 10));
    r = await admin.rpc('sekai_border_exec_migration', { p_event_id: 182, p_cutover: '2026-10-20T12:05:00Z', p_candidate_slot: '2026-10-20T11:40:00Z', p_allow_skipped: 0 });
    assert.match(r.error?.message ?? '', /candidate_slot/);
    assert.equal(await countAll(), 70);
});
test('equal legacy timestamps: the later-inserted legacy row wins, so reruns are deterministic', async () => {
    await insertEvent(); await ins(live('2026-10-20T12:05:00Z'));
    await legacy([...rows(182, '2026-10-20T11:50:10Z'), { event_id: '182', rank: 1, score: 4242, created_at: '2026-10-20T11:50:10Z' }]);
    const r = await run('2026-10-20T12:05:00Z'); assert.equal(r.error, null, r.error?.message);
    const { data } = await admin.from('sekai_border_rankings').select('score').eq('event_id', 182).eq('rank', 1).eq('taken_at', '2026-10-20T11:50:00Z');
    assert.equal(data[0].score, 4242);
});
test('candidate slot overlap: the legacy observation of the candidate slot wins; a differing score elsewhere still fails closed', async () => {
    await insertEvent(); await ins([...live('2026-10-20T11:50:00Z', 100), ...live('2026-10-20T12:05:00Z')]);   // candidate run wrote 11:50 with scores 100..71; legacy has 11:50 with 1000..971
    await legacy([...rows(182, '2026-10-20T11:50:10Z'), ...rows(182, '2026-10-20T11:55:05Z', 1200)]);
    const a = await admin.rpc('sekai_border_exec_migration', { p_event_id: 182, p_cutover: '2026-10-20T12:05:00Z', p_candidate_slot: '2026-10-20T11:50:00Z', p_allow_skipped: 0 });
    assert.equal(a.error, null, a.error?.message); assert.deepEqual(a.data, { inserted: 60, deleted_candidate_rows: 30, skipped_invalid_id_rows: 0, skipped_partial_slot_rows: 0, verified_slots: 2, destination_slots: 3 });
    const { data } = await admin.from('sekai_border_rankings').select('score').eq('event_id', 182).eq('rank', 1).eq('taken_at', '2026-10-20T11:50:00Z'); assert.equal(data[0].score, 1000);
    const again = await admin.rpc('sekai_border_exec_migration', { p_event_id: 182, p_cutover: '2026-10-20T12:05:00Z', p_candidate_slot: '2026-10-20T11:50:00Z', p_allow_skipped: 0 });
    assert.deepEqual(again.data, { inserted: 0, deleted_candidate_rows: 0, skipped_invalid_id_rows: 0, skipped_partial_slot_rows: 0, verified_slots: 2, destination_slots: 3 });   // rerun with the candidate slot is deterministic too
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
test('rollback export refuses an event that is not the live one and leaves the legacy table untouched', async () => {
    await insertEvent({ id: 181, name: 'old', start_at: '2026-10-01T07:00:00Z', aggregate_at: '2026-10-09T12:59:59Z', ranking_announce_at: '2026-10-09T13:09:59Z', finalized_at: '2026-10-09T14:00:00Z' }); await insertEvent();
    await ins(live('2026-10-20T12:05:00Z')); await legacy(rows(182, '2026-10-20T11:50:10Z'));
    const bad = await admin.rpc('sekai_border_export_to_legacy', { p_event_id: 181 }); assert.match(bad.error?.message ?? '', /not the live event/);
    assert.equal((await admin.from('event_rankings').select('*', { count: 'exact', head: true })).count, 30);
});
test('rollback export: an incomplete last legacy slot is dropped and refilled from the new table, never left half-filled', async () => {
    await insertEvent(); await ins([...live('2026-10-20T11:50:00Z', 1000), ...live('2026-10-20T11:55:00Z', 1200), ...live('2026-10-20T12:05:00Z')]);
    await legacy([...rows(182, '2026-10-20T11:50:10Z'), ...rows(182, '2026-10-20T11:55:05Z', 1200, ALLOWED_RANKS.slice(0, 10))]);
    const a = await admin.rpc('sekai_border_export_to_legacy', { p_event_id: 182 }); assert.equal(a.error, null, a.error?.message);
    assert.equal(a.data.dropped_partial_legacy_rows, 10); assert.equal(a.data.exported, 60); assert.equal(new Date(a.data.after_slot).toISOString(), '2026-10-20T11:50:00.000Z');
    assert.equal((await admin.from('event_rankings').select('*', { count: 'exact', head: true })).count, 90);
});
test('rollback export after an event transition: the previous event is removed from the legacy table and the whole current curve is exported', async () => {
    await insertEvent({ id: 181, name: 'old', start_at: '2026-10-01T07:00:00Z', aggregate_at: '2026-10-09T12:59:59Z', ranking_announce_at: '2026-10-09T13:09:59Z', finalized_at: '2026-10-09T14:00:00Z' }); await insertEvent();
    await legacy(rows(181, '2026-10-09T12:55:03Z')); await ins([...live('2026-10-11T07:05:00Z', 100), ...live('2026-10-11T07:10:00Z', 200)]);
    const a = await admin.rpc('sekai_border_export_to_legacy', { p_event_id: 182 }); assert.equal(a.error, null, a.error?.message);
    assert.deepEqual(a.data, { deleted_other_event_rows: 30, dropped_partial_legacy_rows: 0, exported: 60, after_slot: null });
    const { data } = await admin.from('event_rankings').select('event_id'); assert.equal(data.length, 60); assert.ok(data.every((r) => r.event_id === '182'));
});
