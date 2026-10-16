// test/backfill.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backfill } from '../scripts/backfill.js';
import { makeUpstream } from '../src/fetch.js';
const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
const json = (body, status = 200) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body });
function env(events = []) {
    const s = { events: [...events], finalized: [], stamps: [] };
    const db = { loadKnown: async (id) => s.events.find((e) => e.id === id) ?? null, upsertEvent: async (r) => { const i = s.events.findIndex((e) => e.id === r.id); if (i >= 0) s.events[i] = { ...s.events[i], ...r }; else s.events.push({ ...r, finalized_at: null }); }, finalize: async (id) => { s.finalized.push(id); s.events.find((e) => e.id === id).finalized_at = new Date(); } };
    const fetchImpl = async (url) => { const u = String(url); s.stamps.push(Date.now());
        if (u.endsWith('/event/list')) return json(fx('event-list'));
        if (u.includes('raw.githubusercontent')) return json(fx('master-' + u.split('/').pop().replace('.json', '')));
        const m = u.match(/\/event\/(\d+)\/(border|top100)$/); const id = Number(m[1]);
        if (id === 180) return json({}, 500);
        if (id === 179) return json(fx(m[2] === 'border' ? 'final-border-179' : 'final-top100-179'));
        return json(m[2] === 'border' ? { ...fx('final-border-181'), eventId: id } : fx('final-top100-181')); };
    return { s, db, upstream: makeUpstream({ fetchImpl, userAgent: 't', minIntervalMs: 15 }) };
}
test('ended events in range: skipped if finalized, else upserted with attributes and finalized; failure isolated; every HTTP request spaced', async () => {
    const { s, db, upstream } = env([{ id: 181, finalized_at: new Date() }]);
    const res = await backfill({ db, upstream, now: new Date('2026-10-16T00:00:00Z'), from: 178, to: 182, log: () => {} });
    assert.deepEqual(res.map((r) => [r.id, r.action]), [[178, 'finalized'], [179, 'finalized'], [180, 'failed'], [181, 'skipped']]);
    const e178 = s.events.find((e) => e.id === 178); assert.equal(e178.metadata_status, 'complete'); assert.ok(Array.isArray(e178.bonus_characters));
    for (let i = 1; i < s.stamps.length; i++) assert.ok(s.stamps[i] - s.stamps[i - 1] >= 14, `gap ${s.stamps[i] - s.stamps[i - 1]}`);
    assert.equal(s.stamps.length, 9); // list 1 + master 3 + 178 (2) + 179 (2) + 180 (border 500 -> top100 never requested: 1); 181 skipped
});
test('resume: event row exists without finals -> finalized on rerun, not duplicated', async () => {
    const { s, db, upstream } = env([{ id: 178, finalized_at: null }]);
    await backfill({ db, upstream, now: new Date('2026-10-16T00:00:00Z'), from: 178, to: 178, log: () => {} });
    assert.deepEqual(s.finalized, [178]); assert.equal(s.events.filter((e) => e.id === 178).length, 1);
});
