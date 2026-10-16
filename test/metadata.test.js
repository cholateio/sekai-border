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
test('a malformed events.json 200 is not cached and only touches checked_at; a 304 with nothing cached cannot happen because no ETag is sent', async () => {
    const m = mk(row(), { 'events.json': { not: 'an array' } }); const cache = {};
    await repairOne({ ...m, now: T('2026-10-16T00:00:00Z'), cache });
    assert.deepEqual(Object.keys(m.patches[0]), ['metadata_checked_at']); assert.equal(cache.events, undefined);
    const m2 = mk(row()); const r = await repairOne({ ...m2, now: T('2026-10-16T00:00:00Z'), cache: { etag: 'E1', events: null } });
    assert.equal(r.repaired, 182);
});
test('ETag 304 reuses cached events', async () => {
    const m = mk(row()); const r = await repairOne({ ...m, now: T('2026-10-16T00:00:00Z'), cache: { etag: 'E1', events: fx('master-events') } }); assert.equal(r.repaired, 182);
});
