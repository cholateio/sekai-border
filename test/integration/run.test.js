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
