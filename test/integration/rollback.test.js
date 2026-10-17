// Runs only after 0002_rollback.sql.tmpl has been applied to the test schema (ROLLBACK_APPLIED=1, Task 15 rehearsal).
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, truncate, insertEvent, insertRows, finalsFor, rpc } from './helpers.js';
import { ALLOWED_RANKS } from '../../src/constants.js';
const skip = process.env.ROLLBACK_APPLIED !== '1';
test('after 0002_rollback: finalize compacts every rank, writes no series, put_forecasts is gone', { skip }, async () => {
    await truncate();
    await insertEvent({ id: 182, start_at: '2026-10-11T07:00:00Z', aggregate_at: '2026-10-11T12:59:59Z', ranking_announce_at: '2026-10-11T13:09:59Z' });
    const rows = []; for (let t = Date.parse('2026-10-11T07:00:00Z'), k = 0; t < Date.parse('2026-10-11T13:00:00Z'); t += 300000, k++) for (const rank of ALLOWED_RANKS) rows.push({ event_id: 182, chapter: 0, rank, score: 1000 + k, taken_at: new Date(t).toISOString(), is_final: false });
    await insertRows(rows);
    const r = await rpc('sekai_border_finalize', { p_event_id: 182, p_finals: finalsFor(0, ALLOWED_RANKS) });
    assert.equal(r.series_rows, undefined); assert.equal(r.deleted_snapshots, rows.length - 30 * 6);
    const { count } = await admin.from('sekai_border_series').select('*', { count: 'exact', head: true }); assert.equal(count, 0);
    const pf = await admin.rpc('sekai_border_put_forecasts', { p_event_id: 182, p_computed_at: '2026-10-11T08:00:00Z', p_rows: [] }); assert.ok(pf.error);
});
