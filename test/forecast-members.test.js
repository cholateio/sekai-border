import test from 'node:test';
import assert from 'node:assert/strict';
import { usable, linearMember, measuredMember, priorMember, buildPriorTable } from '../src/forecast/members.js';
const T = (s) => new Date(s);

test('usable: finite, > 0, >= sNow', () => {
    assert.equal(usable(10, 5), true); assert.equal(usable(5, 5), true); assert.equal(usable(4, 5), false); assert.equal(usable(0, 0), false); assert.equal(usable(NaN, 0), false); assert.equal(usable(Infinity, 0), false);
});
test('linear: sNow / tau; unavailable below tau 0.02 or at sNow 0', () => {
    assert.equal(linearMember({ sNow: 100, tau: 0.5 }), 200);
    assert.equal(linearMember({ sNow: 100, tau: 0.019 }), null); assert.equal(linearMember({ sNow: 0, tau: 0.5 }), null);
});
test('measured: 24 h speed once 24 h elapsed, else 6 h; missing past value or negative speed -> null; zero speed -> sNow', () => {
    assert.equal(measuredMember({ sNow: 1000, s6: 400, s24: 100, hoursElapsed: 30, hoursLeft: 10 }), 1000 + (900 / 24) * 10);
    assert.equal(measuredMember({ sNow: 1000, s6: 400, s24: null, hoursElapsed: 30, hoursLeft: 10 }), null);
    assert.equal(measuredMember({ sNow: 1000, s6: 400, s24: null, hoursElapsed: 12, hoursLeft: 10 }), 2000);
    assert.equal(measuredMember({ sNow: 1000, s6: null, s24: null, hoursElapsed: 12, hoursLeft: 10 }), null);
    assert.equal(measuredMember({ sNow: 1000, s6: 400, s24: null, hoursElapsed: 5, hoursLeft: 10 }), null);
    assert.equal(measuredMember({ sNow: 300, s6: 400, s24: null, hoursElapsed: 12, hoursLeft: 10 }), null);   // v < 0 (A9)
    assert.equal(measuredMember({ sNow: 0, s6: 0, s24: null, hoursElapsed: 12, hoursLeft: 10 }), 0);        // finite, but usable() rejects 0
});
const periods = [1, 2, 3, 4].map((i) => ({ key: `${100 + i}:0`, family: 'main', type: 'marathon', days: 9, seq: i - 1, wStart: T(`2026-0${i}-01T00:00:00Z`), wEnd: T(`2026-0${i}-10T00:00:00Z`) }));
const finals = new Map(periods.map((p, i) => [p.key, new Map([[1, 1000 * (i + 1)], [100, i === 1 ? 0 : 10 * (i + 1)]])]));
test('buildPriorTable: weighted log mean with half-life 6, zero finals excluded and not counted, before/nowSeq respected', () => {
    const t = buildPriorTable(periods, finals);
    const w = (seq) => Math.pow(0.5, (4 - seq) / 6);
    const expected = [0, 1, 2, 3].reduce((a, s) => a + w(s) * Math.log(1000 * (s + 1)), 0) / [0, 1, 2, 3].reduce((a, s) => a + w(s), 0);
    assert.ok(Math.abs(t['main:marathon:9:1'].m - expected) < 1e-12); assert.equal(t['main:marathon:9:1'].n, 4);
    assert.equal(t['main:marathon:9:100'].n, 3);   // the zero final is excluded
    const early = buildPriorTable(periods, finals, { before: periods[2].wStart, nowSeq: 2 });
    assert.equal(early['main:marathon:9:1'].n, 2);
    assert.equal(priorMember({ table: early, family: 'main', type: 'marathon', days: 9, rank: 1 }), Math.exp(early['main:marathon:9:1'].m));
    assert.equal(priorMember({ table: buildPriorTable(periods.slice(0, 1), finals), family: 'main', type: 'marathon', days: 9, rank: 1 }), null);   // n = 1 < 2
    assert.equal(priorMember({ table: t, family: 'main', type: 'cheerful_carnival', days: 9, rank: 1 }), null);
});
test('buildPriorTable keeps only the 12 most recent positive samples per stratum, even when older ones are plenty (A15)', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ key: `${i}:0`, family: 'main', type: 'marathon', days: 9, seq: i, wStart: T('2020-01-01T00:00:00Z'), wEnd: T('2020-01-10T00:00:00Z') }));
    const f = new Map(many.map((p, i) => [p.key, new Map([[1, i < 18 ? 1 : 1000]])]));   // the 12 newest are all 1000
    const t = buildPriorTable(many, f);
    assert.equal(t['main:marathon:9:1'].n, 12); assert.ok(Math.abs(t['main:marathon:9:1'].m - Math.log(1000)) < 1e-12);
});
test('buildPriorTable: a sparse stratum with 2 samples, one very old, still yields n = 2 (A15)', () => {
    const ps = [{ key: 'a:0', family: 'main', type: 'cheerful_carnival', days: 7, seq: 0, wStart: T('2019-01-01T00:00:00Z'), wEnd: T('2019-01-08T00:00:00Z') }, { key: 'b:0', family: 'main', type: 'cheerful_carnival', days: 7, seq: 150, wStart: T('2026-01-01T00:00:00Z'), wEnd: T('2026-01-08T00:00:00Z') }];
    const t = buildPriorTable(ps, new Map([['a:0', new Map([[1, 10]])], ['b:0', new Map([[1, 20]])]]));
    assert.equal(t['main:cheerful_carnival:7:1'].n, 2); assert.ok(Number.isFinite(t['main:cheerful_carnival:7:1'].m));
});
