import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParams } from './helpers/params.js';
import { synth } from './helpers/synth.js';
globalThis.fetch = () => { throw new Error('forecast code must never call fetch'); };
const { buildPeriods, fitParams, trainRound } = await import('../src/forecast/train.js');
const { validateParams } = await import('../src/forecast/params.js');
const T = (s) => new Date(s); const H = 3600000, DAY = 86400000;

test('buildPeriods: main + chapters, per-family order and seq, exclusions', () => {
    const { events } = synth({ n: 3, chapters: 2 });
    const p = buildPeriods(events, { exclude: [2] });
    assert.deepEqual(p.main.map((x) => x.eventId), [1, 3]); assert.deepEqual(p.main.map((x) => x.seq), [0, 1]); assert.equal(p.main[0].days, 9); assert.equal(p.main[0].type, 'marathon');
    assert.deepEqual(p.wl.map((x) => x.key), ['1:1', '1:2', '3:1', '3:2']); assert.equal(p.wl[0].days, 2); assert.equal(p.wl[0].family, 'wl');
});
test('A10: rolling origin — every fold trains only on periods that ended before it started; folds are in time order', async () => {
    const d = synth({ n: 6 }); const folds = [];
    await fitParams({ periods: buildPeriods(d.events), ...d, now: T('2026-01-01T00:00:00Z'), onFold: async ({ period, training }) => folds.push({ period, training }) });
    assert.ok(folds.length >= 6);
    for (const f of folds) assert.ok(f.training.every((t) => t.wEnd < f.period.wStart), `${f.period.key} saw a later period`);
    for (let i = 1; i < folds.length; i++) if (folds[i].period.family === folds[i - 1].period.family) assert.ok(folds[i].period.wStart >= folds[i - 1].period.wStart);
});
test('params from synthetic data validate; sigma/resid cells have counts; prior table is populated; per-period mae recorded', async () => {
    const d = synth({ n: 10, noise: 0.1 });
    const p = await fitParams({ periods: buildPeriods(d.events), ...d, now: T('2026-01-01T00:00:00Z') });
    assert.deepEqual(validateParams(p), { ok: true, errors: [] });
    assert.equal(p.input.main_periods, 10); assert.equal(p.input.wl_periods, 0);
    assert.ok(p.sigma.cell['main:G1:0'].linear.n >= 8); assert.ok(p.resid.family.main.n >= 20);
    assert.ok(p.prior['main:marathon:9:1'].n >= 2); assert.ok(Object.keys(p.periods).length === 10);
    assert.ok(Object.values(p.periods).every((x) => Number.isFinite(x.mae)));
});
test('A11: profile activates only with >= 3 periods with data AND lower mean |e| than linear (n >= 8)', async () => {
    const two = synth({ n: 2 }); const p2 = await fitParams({ periods: buildPeriods(two.events), ...two, now: T('2026-01-01T00:00:00Z') });
    assert.deepEqual(Object.keys(p2.profile), []);
    // strongly time-of-day-shaped rates: profile beats linear in every group, G6 included (8 hod bins)
    const d = synth({ n: 8, shape: true });
    const p = await fitParams({ periods: buildPeriods(d.events), ...d, now: T('2026-01-01T00:00:00Z') });
    assert.ok(p.profile['main:G1'], 'profile active for G1'); assert.equal(p.profile['main:G1'].hod.length, 24);
    assert.ok(p.profile['main:G6'], 'profile active for G6'); assert.equal(p.profile['main:G6'].hod.length, 8);
    assert.ok(p.sigma.group['main:G1'].profile.s < p.sigma.group['main:G1'].linear.s);
    // mixed coverage: 8 periods have data overall, but only 2 have G6 compacted points -> G6 must NOT activate even though its fold samples reach n >= 8
    const m = synth({ n: 8, shape: true }); m.compacted = m.compacted.filter((c) => c.event_id <= 2);
    const pm = await fitParams({ periods: buildPeriods(m.events), ...m, now: T('2026-01-01T00:00:00Z') });
    assert.ok(pm.profile['main:G1']); assert.equal(pm.profile['main:G6'], undefined);
    assert.ok((pm.sigma.group['main:G6']?.profile?.n ?? 0) >= 8, 'the guard, not the sample count, blocks G6');
});
test('A15 caps: 50 main events -> 40 series periods used; 130 -> 120 prior folds; prior strata keep <= 12', async () => {
    const d = synth({ n: 50 }); const folds = [];
    const p = await fitParams({ periods: buildPeriods(d.events), ...d, now: T('2026-01-01T00:00:00Z'), onFold: async ({ period }) => folds.push(period.key) });
    assert.equal(p.input.main_periods, 40); assert.ok(folds.length <= 50);
    assert.ok(Object.values(p.prior).every((x) => x.n <= 12));
    const big = synth({ n: 130 }); big.series = []; big.compacted = []; const f2 = [];
    const p2 = await fitParams({ periods: buildPeriods(big.events), ...big, now: T('2026-01-01T00:00:00Z'), onFold: async ({ period }) => f2.push(period.key) });
    assert.equal(f2.length, 120); assert.equal(p2.input.main_periods, 0); assert.ok(p2.sigma.family.main.prior.n > 0);
});
test('A15 time: full-size input (40 main + 40 chapters with series and compacted, 180 finals histories) trains in < 10 s', async () => {
    const main = synth({ n: 40, idFrom: 1 }), wl = synth({ n: 20, chapters: 2, type: 'world_bloom', idFrom: 1000, from: '2024-02-01T07:00:00Z' }), hist = synth({ n: 120, idFrom: 5000, from: '2019-01-01T07:00:00Z' });
    hist.series = []; hist.compacted = [];
    const d = { events: [...hist.events, ...main.events, ...wl.events], series: [...main.series, ...wl.series], compacted: [...main.compacted, ...wl.compacted], finals: [...hist.finals, ...main.finals, ...wl.finals] };
    const t0 = Date.now(); const p = await fitParams({ periods: buildPeriods(d.events), ...d, now: T('2026-01-01T00:00:00Z') }); const ms = Date.now() - t0;
    console.log(`train full-size input: ${ms} ms`);
    assert.ok(ms < 10000, `took ${ms} ms`); assert.equal(p.input.main_periods, 40); assert.equal(p.input.wl_periods, 40);
    assert.ok(JSON.stringify(p).length < 200 * 1024, 'params under 200 kB');
});
function fakeDb(d, { hang = null, saveDelay = 0 } = {}) {
    const calls = { save: 0 }; const wrap = (name, v) => (...a) => new Promise((res, rej) => { const signal = a.at(-1); if (hang === name) { signal.addEventListener('abort', () => rej(new Error('aborted'))); return; } res(v); });
    return { calls, loadFinalizedEvents: wrap('events', d.events), loadSeries: wrap('series', d.series), loadCompacted: wrap('compacted', d.compacted), loadFinals: wrap('finals', d.finals),
        saveModel: (params, at, signal) => new Promise((res, rej) => { if (hang === 'save') { signal.addEventListener('abort', () => rej(new Error('aborted'))); return; } setTimeout(() => { calls.save++; res(); }, saveDelay); }) };
}
test('trainRound: saves validated params; A14 (c) hanging read or save -> throws, nothing saved', async () => {
    const d = synth({ n: 5 }); const db = fakeDb(d);
    const r = await trainRound({ db, now: T('2026-01-01T00:00:00Z'), log: () => {} }); assert.equal(r.saved, true); assert.equal(db.calls.save, 1); assert.equal(r.main_periods, 5);
    for (const hang of ['events', 'finals', 'save']) { const h = fakeDb(d, { hang }); await assert.rejects(trainRound({ db: h, now: T('2026-01-01T00:00:00Z'), log: () => {}, deadlineMs: 60, saveWithinMs: 50 }), /deadline|budget/); assert.equal(h.calls.save, 0); }
});
test('A14 (d): slow folds stop at the next yield after the deadline; save is skipped past the save budget', async () => {
    const d = synth({ n: 5 }); const db = fakeDb(d);
    await assert.rejects(trainRound({ db, now: T('2026-01-01T00:00:00Z'), log: () => {}, deadlineMs: 40, saveWithinMs: 30, slowFoldMs: 25 }), /deadline/);
    assert.equal(db.calls.save, 0);
});
test('trainRound: exclude drops events from every input and is recorded', async () => {
    const d = synth({ n: 5 }); const db = fakeDb(d);
    const r = await trainRound({ db, now: T('2026-01-01T00:00:00Z'), log: () => {}, exclude: [3] }); assert.equal(r.main_periods, 4); assert.deepEqual(r.excluded, [3]);
});
