import test from 'node:test';
import assert from 'node:assert/strict';
import { combine, interval, pathTimes, buildPath, confidenceOf, checkRow } from '../src/forecast/combine.js';
import { makeParams } from './helpers/params.js';
const T = (s) => new Date(s);

test('combine: inverse-variance weights in log space, unusable members dropped, P50 >= sNow, method = heaviest (profile -> model)', () => {
    const p = makeParams({ sigma: { cell: { 'main:G1:0': { linear: { s: 0.1, n: 10 }, profile: { s: 0.05, n: 10 }, measured: { s: 0.5, n: 10 } } }, group: {}, family: {} } });
    const c = combine({ sNow: 100, preds: { linear: 200, measured: 400, prior: null, profile: 300 }, params: p, family: 'main', group: 'G1', bin: 0 });
    const w = { linear: 100, profile: 400, measured: 4 }, sw = 504;
    assert.ok(Math.abs(c.p50 - Math.round(Math.exp((w.linear * Math.log(200) + w.profile * Math.log(300) + w.measured * Math.log(400)) / sw))) <= 1);
    assert.equal(c.method, 'model'); assert.ok(Math.abs(c.weights.profile - 400 / 504) < 1e-12); assert.equal('prior' in c.weights, false);
    assert.equal(combine({ sNow: 100, preds: { linear: 50, measured: null, prior: NaN, profile: 0 }, params: p, family: 'main', group: 'G1', bin: 0 }), null);
    const tie = combine({ sNow: 100, preds: { linear: 150, measured: 150, prior: null, profile: null }, params: makeParams(), family: 'wl', group: 'G3', bin: 1 });
    assert.equal(tie.method, 'linear'); assert.equal(tie.p50, 150);
    assert.equal(combine({ sNow: 1000, preds: { linear: 1000, measured: null, prior: null, profile: null }, params: makeParams(), family: 'main', group: 'G1', bin: 0 }).p50, 1000);
});
test('interval: clamped order holds for normal, all-positive and all-negative residuals; integers', () => {
    assert.deepEqual(interval({ p50: 1000, sNow: 500, q10: -0.2, q90: 0.3 }), { p10: Math.round(1000 * Math.exp(-0.3)), p50: 1000, p90: Math.round(1000 * Math.exp(0.2)) });
    const pos = interval({ p50: 1000, sNow: 500, q10: 0.1, q90: 0.3 });   // all residuals positive: exp(-q10) < 1 -> P90 clamps to P50
    assert.ok(pos.p10 <= pos.p50 && pos.p50 <= pos.p90); assert.equal(pos.p90, 1000);
    const neg = interval({ p50: 1000, sNow: 500, q10: -0.3, q90: -0.1 });   // all negative: exp(-q90) > 1 -> P10 clamps to P50
    assert.ok(neg.p10 <= neg.p50 && neg.p50 <= neg.p90); assert.equal(neg.p10, 1000);
    const low = interval({ p50: 520, sNow: 500, q10: -0.2, q90: 0.9 }); assert.equal(low.p10, 500);   // floor at sNow
    for (const r of [pos, neg, low]) assert.ok([r.p10, r.p50, r.p90].every(Number.isInteger));
});
test('pathTimes: on-the-hour computed_at starts at the NEXT hour; whole hours strictly before wEnd; wEnd last (Review Focus 4)', () => {
    assert.deepEqual(pathTimes(T('2026-10-11T07:00:00Z'), T('2026-10-11T10:30:00Z')).map((d) => d.toISOString()), ['2026-10-11T08:00:00.000Z', '2026-10-11T09:00:00.000Z', '2026-10-11T10:00:00.000Z', '2026-10-11T10:30:00.000Z']);
    assert.deepEqual(pathTimes(T('2026-10-11T07:05:00Z'), T('2026-10-11T08:00:00Z')).map((d) => d.toISOString()), ['2026-10-11T08:00:00.000Z']);   // t0 == wEnd: one point
    assert.deepEqual(pathTimes(T('2026-10-11T07:05:00Z'), T('2026-10-11T07:59:59Z')).map((d) => d.toISOString()), ['2026-10-11T07:59:59.000Z']);
    assert.equal(pathTimes(T('2026-10-11T07:00:00Z'), T('2026-11-01T06:59:59Z')).length, 504);   // 21 days: 503 whole hours after 07:00, plus the end point
});
test('buildPath: non-decreasing, ends exactly at the finals, starts from F(t0)', () => {
    const times = pathTimes(T('2026-10-11T07:30:00Z'), T('2026-10-11T12:00:00Z'));
    const F = (t) => (t.getTime() - T('2026-10-11T07:30:00Z').getTime()) / (T('2026-10-11T12:00:00Z').getTime() - T('2026-10-11T07:30:00Z').getTime());
    const p = buildPath({ sNow: 1000, finals: { p10: 1000, p50: 1450, p90: 1900 }, times, F });
    assert.equal(p.t0, '2026-10-11T08:00:00.000Z'); assert.equal(p.p50.length, 5); assert.deepEqual([p.p10.at(-1), p.p50.at(-1), p.p90.at(-1)], [1000, 1450, 1900]);
    assert.deepEqual(p.p10, [1000, 1000, 1000, 1000, 1000]); assert.equal(p.p50[0], 1050);
    for (const k of ['p10', 'p50', 'p90']) for (let i = 1; i < p[k].length; i++) assert.ok(p[k][i] >= p[k][i - 1]);
});
test('confidenceOf and checkRow (A4)', () => {
    assert.equal(confidenceOf({ method: 'model', quantLevel: 1, quantN: 25 }), 'normal');
    assert.equal(confidenceOf({ method: 'linear', quantLevel: 1, quantN: 25 }), 'low'); assert.equal(confidenceOf({ method: 'prior', quantLevel: 1, quantN: 25 }), 'low');
    assert.equal(confidenceOf({ method: 'measured', quantLevel: 3, quantN: 25 }), 'low'); assert.equal(confidenceOf({ method: 'measured', quantLevel: 2, quantN: 19 }), 'low'); assert.equal(confidenceOf({ method: 'measured', quantLevel: 2, quantN: 20 }), 'normal');
    const ok = { current_score: 100, final_p10: 110, final_p50: 120, final_p90: 130, path: { t0: 'x', p10: [105, 110], p50: [110, 120], p90: [115, 130] }, method: 'linear', confidence: 'low' };
    assert.doesNotThrow(() => checkRow(ok, 2));
    assert.throws(() => checkRow({ ...ok, final_p10: 99 }, 2), /order/);
    assert.throws(() => checkRow({ ...ok, final_p50: 120.5 }, 2), /integer/);
    assert.throws(() => checkRow({ ...ok, path: { ...ok.path, p50: [125, 120] } }, 2), /decreasing/);
    assert.throws(() => checkRow({ ...ok, path: { ...ok.path, p90: [115, 131] } }, 2), /end/);
    assert.throws(() => checkRow(ok, 3), /length/);
    assert.throws(() => checkRow({ ...ok, method: 'profile' }, 2), /enum/);
});
