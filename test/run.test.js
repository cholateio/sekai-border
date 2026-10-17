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
test('a final still unpublished 24 h after announcement logs at error severity but stays deferred with 200', async () => {
    const ff = fakeFetch({ finalBorder: (id) => json({ ...fx('final-border-181'), eventId: id, borderRankings: [] }) });
    const old = { ...liveEvent(), id: 180, name: 'e180', start_at: T('2026-10-01T07:00:00Z'), aggregate_at: T('2026-10-09T12:59:59Z'), ranking_announce_at: T('2026-10-09T13:09:59Z') };
    const db = fakeDb({ events: [old, liveEvent()] });
    const lines = []; const orig = console.error; console.error = (l) => lines.push(l);
    let r; try { r = await run(db, ff, '2026-10-15T00:03:00Z'); } finally { console.error = orig; }
    assert.equal(r.status, 200); assert.deepEqual(r.body.finalize_deferred.map((x) => x.id), [180]);
    assert.ok(lines.some((l) => l.includes('"msg":"finalize deferred"') && l.includes('"event_id":180')), lines.join('\n'));
});
test('bootstrap with an event-list entry missing its chapters array -> 500 phase event-list, no event row, no snapshot', async () => {
    const id = fx('live-top100').id;
    const ff = fakeFetch({ list: () => fx('event-list').map((e) => { if (e.id !== id) return e; const { chapters, ...rest } = e; void chapters; return rest; }) });
    const db = fakeDb(); const r = await run(db, ff, '2026-10-15T00:03:00Z');
    assert.equal(r.status, 500); assert.equal(r.body.phase, 'event-list'); assert.equal(r.body.error_code, 'chapters_shape'); assert.equal(db.s.events.length, 0); assert.equal(db.s.snapshots.length, 0);
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
    assert.equal(r.status, 200); assert.equal(r.body.branch, 'pre-start'); assert.equal(r.body.inserted, 0); assert.equal(db.s.events.length, 1);
    assert.deepEqual(r.body.finalized, [182]); assert.deepEqual(ff.counts, { top100: 1, border: 1, list: 1, finalBorder: 1, finalTop100: 1, master: 0 }); // the eligible previous event is finalized on a pre-start round
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

const WL_CH = [{ chapter: 1, chapter_id: 17901, character_id: 23, start_at: '2026-10-11T07:00:00Z', aggregate_at: '2026-10-13T06:59:59Z', ranking_announce_at: '2026-10-13T07:09:59Z' }];
const wlEl = (key, list) => ({ id: 17901, event: 182, chapter: 1, character: 23, start_at: WL_CH[0].start_at, aggregate_at: WL_CH[0].aggregate_at, ranking_announce_at: WL_CH[0].ranking_announce_at, [key]: list });
function wlLive({ breakTop = false, character = 23 } = {}) {
    const t = fx('live-top100'), b = fx('live-border');
    const top = t.player_top_100_rankings.filter((r) => r.rank <= 100), bd = b.player_border_rankings.filter((r) => r.rank > 100 && r.rank !== 1500 && r.rank !== 2500);
    return { liveTop100: () => json({ ...t, world_link_top_100_rankings: [{ ...wlEl('player_top_100_rankings', breakTop ? 'x' : top), character }] }), liveBorder: () => json({ ...b, world_link_border_rankings: [wlEl('player_border_rankings', bd)] }) };
}
test('A8: active chapter rows are written in a second insert; wl_inserted 28; HTTP still 2', async () => {
    const ff = fakeFetch(wlLive()); const db = fakeDb({ events: [{ ...liveEvent(), chapters: WL_CH }] });
    const r = await run(db, ff, '2026-10-12T00:03:00Z');
    assert.equal(r.status, 200); assert.equal(r.body.inserted, 30); assert.equal(r.body.wl_inserted, 28);
    assert.equal(db.s.snapshots.filter((k) => k.startsWith('182:1:')).length, 28);
    assert.deepEqual(ff.counts, { top100: 1, border: 1, list: 0, finalBorder: 0, finalTop100: 0, master: 0 });
});
test('A8: chapter shape error / character mismatch / chapter write failure -> main board written, wl_inserted 0, status 200, ERROR logged', async () => {
    for (const [over, failAt] of [[{ breakTop: true }, null], [{ character: 99 }, null], [{}, 'wl-write']]) {
        const ff = fakeFetch(wlLive(over)); const db = fakeDb({ events: [{ ...liveEvent(), chapters: WL_CH }] });
        if (failAt) { const orig = db.insertSnapshot; db.insertSnapshot = async (rows, slot) => { if (rows.some((x) => x.chapter !== 0)) throw new DbError('snapshot-write', 'injected'); return orig(rows, slot); }; }
        const logs = []; const origErr = console.error; console.error = (l) => logs.push(l);
        try { const r = await run(db, ff, '2026-10-12T00:03:00Z'); assert.equal(r.status, 200); assert.equal(r.body.inserted, 30); assert.equal(r.body.wl_inserted, 0); }
        finally { console.error = origErr; }
        assert.ok(logs.some((l) => l.includes('wl ingest failed')), JSON.stringify(over));
        assert.ok(logs.every((l) => !l.includes('"name"')));
    }
});
test('A8: active chapter but empty upstream WL arrays -> wl ingest failed logged, main board written, status 200', async () => {
    const ff = fakeFetch(); const db = fakeDb({ events: [{ ...liveEvent(), chapters: WL_CH }] });   // fixture arrays are empty (event 182 is not WL)
    const logs = []; const origErr = console.error; console.error = (l) => logs.push(l);
    try { const r = await run(db, ff, '2026-10-12T00:03:00Z'); assert.equal(r.status, 200); assert.equal(r.body.inserted, 30); assert.equal(r.body.wl_inserted, 0); } finally { console.error = origErr; }
    assert.ok(logs.some((l) => l.includes('wl ingest failed') && l.includes('wl_chapters')));
});
test('A8: non-WL event (empty arrays) writes no chapter rows and logs no error', async () => {
    const ff = fakeFetch(); const db = fakeDb({ events: [liveEvent()] });
    const logs = []; const origErr = console.error; console.error = (l) => logs.push(l);
    try { const r = await run(db, ff, '2026-10-12T00:03:00Z'); assert.equal(r.body.wl_inserted, 0); } finally { console.error = origErr; }
    assert.equal(logs.length, 0);
});
test('A8: first round of a new WL event takes chapters from event/list and writes chapter rows', async () => {
    const list = fx('event-list').map((e) => (e.id === fx('live-top100').id ? { ...e, chapters: [{ id: 17901, event: 182, chapter: 1, character: 23, start_at: WL_CH[0].start_at, aggregate_at: WL_CH[0].aggregate_at, ranking_announce_at: WL_CH[0].ranking_announce_at }] } : e));
    const ff = fakeFetch({ ...wlLive(), list: () => list }); const db = fakeDb();
    const r = await run(db, ff, '2026-10-12T00:03:00Z');
    assert.equal(r.body.inserted, 30); assert.equal(r.body.wl_inserted, 28); assert.equal(ff.counts.list, 1);
});
