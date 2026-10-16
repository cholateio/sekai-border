// test/backfill.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backfill } from '../scripts/backfill.js';
import { makeUpstream } from '../src/fetch.js';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
const json = (body, status = 200) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body });
function env(events = [], list = fx('event-list')) {
    const s = { events: [...events], finalized: [], stamps: [] };
    const db = { loadKnown: async (id) => s.events.find((e) => e.id === id) ?? null, upsertEvent: async (r) => { const i = s.events.findIndex((e) => e.id === r.id); if (i >= 0) s.events[i] = { ...s.events[i], ...r }; else s.events.push({ ...r, finalized_at: null }); }, finalize: async (id) => { s.finalized.push(id); s.events.find((e) => e.id === id).finalized_at = new Date(); } };
    const fetchImpl = async (url) => { const u = String(url); s.stamps.push(Date.now());
        if (u.endsWith('/event/list')) return json(list);
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
test('an event finalized by the online crawler between the check and the upsert is reported as skipped, not failed', async () => {
    const { s, db, upstream } = env([{ id: 178, finalized_at: null }]);
    db.upsertEvent = async () => { s.events[0].finalized_at = new Date(); throw new Error('event 178 is finalized: name, times and chapters are frozen'); };
    const res = await backfill({ db, upstream, now: new Date('2026-10-16T00:00:00Z'), from: 178, to: 178, log: () => {} });
    assert.deepEqual(res.map((r) => [r.id, r.action]), [[178, 'skipped']]); assert.deepEqual(s.finalized, []);
});
test('a list entry without a chapters array fails that event only; nothing is written for it', async () => {
    const list = fx('event-list').map((e) => { if (e.id !== 179) return e; const { chapters, ...rest } = e; void chapters; return rest; });
    const { s, db, upstream } = env([], list);
    const res = await backfill({ db, upstream, now: new Date('2026-10-16T00:00:00Z'), from: 178, to: 179, log: () => {} });
    assert.deepEqual(res.map((r) => [r.id, r.action, r.reason]), [[178, 'finalized', undefined], [179, 'failed', 'event-list:chapters_shape']]);
    assert.equal(s.events.some((e) => e.id === 179), false);
});
test('CLIs reject bad arguments with exit 2 before reading any environment', () => {
    // cwd = tmpdir so dotenv/config cannot pick up the repo .env; stdin closed
    const run = (script, args) => spawnSync(process.execPath, [new URL(`../scripts/${script}`, import.meta.url).pathname, ...args], { cwd: tmpdir(), env: { PATH: process.env.PATH }, input: '', encoding: 'utf8' });
    for (const a of [['--from', 'nope'], ['--from', '0'], ['--from', '5', '--to', '3']]) assert.equal(run('backfill.js', a).status, 2, a.join(' '));
    for (const a of [['--event', '0', '--cutover', '2026-10-20T12:05:00Z'], ['--event', '182', '--cutover', '2026-10-20T12:05:00Z', '--allow-skipped', '-1'], ['--event', '182', '--cutover', '2026-10-20T12:05:00Z', '--candidate-slot', 'nope'], ['--event', '182', '--cutover', '2026-99-99T99:55:00Z'], ['--event', '182', '--cutover', '2026-10-20T12:05:00Z', '--candidate-slot', '2026-10-20T12:05:00Z']]) assert.equal(run('migrate-legacy.js', a).status, 2, a.join(' '));
});
test('resume: event row exists without finals -> finalized on rerun, not duplicated', async () => {
    const { s, db, upstream } = env([{ id: 178, finalized_at: null }]);
    await backfill({ db, upstream, now: new Date('2026-10-16T00:00:00Z'), from: 178, to: 178, log: () => {} });
    assert.deepEqual(s.finalized, [178]); assert.equal(s.events.filter((e) => e.id === 178).length, 1);
});
