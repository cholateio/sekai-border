import test from 'node:test';
import assert from 'node:assert/strict';
import { taiwanHour, isTaiwanWeekend, features, seriesObservations, compactedObservations, fitProfile, multiplier, expectedUnits, profileMember } from '../src/forecast/profile.js';
const T = (s) => new Date(s); const H = 3600000;

test('features: Taiwan hour/weekend, hte and hfs bins with open last bins, G6 3-hour hod bins', () => {
    assert.equal(taiwanHour(T('2026-10-11T16:30:00Z')), 0); assert.equal(isTaiwanWeekend(T('2026-10-10T16:30:00Z')), true);   // Sat 00:30 Taipei
    assert.equal(isTaiwanWeekend(T('2026-10-12T15:00:00Z')), false);   // Mon 23:00 Taipei
    const w = { wStart: T('2026-10-11T07:00:00Z'), wEnd: T('2026-10-20T07:00:00Z') };
    assert.deepEqual(features({ tm: T('2026-10-11T07:30:00Z'), ...w, hodBins: 24 }), { hod: 15, hte: 9, hfs: 0, wk: 1 });
    assert.deepEqual(features({ tm: T('2026-10-20T04:30:00Z'), ...w, hodBins: 8 }), { hod: 4, hte: 2, hfs: 6, wk: 0 });   // 12:30 Taipei Tue; 2.5 h to end -> bin 2; 212.5 h from start -> last
    assert.deepEqual(features({ tm: T('2026-10-11T12:00:00Z'), ...w, hodBins: 24 }).hfs, 3);   // 5 h -> [3,6)
});
test('seriesObservations: adjacent non-null pairs only, rho clamped at 0, midpoint at i+1.5 h', () => {
    const obs = seriesObservations({ line: 'a', startAt: T('2026-10-11T07:00:00Z'), scores: [10, 30, null, 50, 40], wStart: T('2026-10-11T07:00:00Z'), wEnd: T('2026-10-12T07:00:00Z'), hodBins: 24 });
    assert.equal(obs.length, 2); assert.ok(Math.abs(obs[0].y - Math.log(21)) < 1e-12); assert.equal(obs[1].y, 0);
    assert.equal(obs[0].f.hod, taiwanHour(T('2026-10-11T08:30:00Z')));
});
test('compactedObservations: only before wEnd - 24 h, only adjacent 3 h buckets, rate per actual hour gap', () => {
    const pts = [['2026-10-11T07:55:00Z', 100], ['2026-10-11T10:55:00Z', 400], ['2026-10-11T16:55:00Z', 1000], ['2026-10-11T19:50:00Z', 1300], ['2026-10-19T08:00:00Z', 5000], ['2026-10-19T11:00:00Z', 6000]].map(([t, s]) => ({ taken_at: T(t), score: s }));
    const obs = compactedObservations({ line: 'g6', points: pts, wStart: T('2026-10-11T07:00:00Z'), wEnd: T('2026-10-20T07:00:00Z'), hodBins: 8 });
    assert.equal(obs.length, 2);   // (07:55,10:55) adjacent; (10:55,16:55) skips a bucket; (16:55,19:50) adjacent; the 10-19 points are inside the last 24 h
    assert.ok(Math.abs(obs[0].y - Math.log(100 + 1)) < 1e-12);           // 300 / 3 h
    assert.ok(Math.abs(obs[1].y - Math.log(300 / (175 / 60) + 1)) < 1e-9);   // 300 over 2 h 55 min
});
test('fitProfile recovers known coefficients from noiseless data with per-line intercepts (within transformation)', () => {
    const hodBins = 24, truth = { hod: [0, ...Array.from({ length: 23 }, (_, i) => Math.sin(i / 3) * 0.3)], hte: [0, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05, 0.02], hfs: [0, 0.6, 0.4, 0.3, 0.2, 0.1, 0.05], wk: 0.2 };
    const wStart = T('2026-10-11T07:00:00Z'), wEnd = T('2026-10-21T07:00:00Z');
    const obs = [];
    for (const [line, a] of [['l1', 1.0], ['l2', 2.5], ['l3', -0.3]]) for (let i = 0; i < 239; i++) { const f = features({ tm: new Date(wStart.getTime() + (i + 1.5) * H), wStart, wEnd, hodBins }); obs.push({ line, y: a + truth.hod[f.hod] + truth.hte[f.hte] + truth.hfs[f.hfs] + truth.wk * f.wk, f }); }
    const c = fitProfile(obs, { hodBins });
    // hfs bin 0 is never observed (first midpoint is W_start + 1.5 h), so hfs is identified relative to bin 1: expect truth shifted, bin 0 = 0
    const want = { hod: truth.hod, hte: truth.hte, hfs: truth.hfs.map((x, i) => (i === 0 ? 0 : x - truth.hfs[1])) };
    for (const k of ['hod', 'hte', 'hfs']) for (let i = 0; i < want[k].length; i++) assert.ok(Math.abs(c[k][i] - want[k][i]) < 1e-6, `${k}[${i}] ${c[k][i]} vs ${want[k][i]}`);
    assert.ok(Math.abs(c.wk - truth.wk) < 1e-6); assert.equal(c.n, obs.length); assert.equal(c.lines, 3);
    assert.equal(c.hod.length, 24); assert.equal(c.hte.length, 10); assert.equal(c.hfs.length, 7);
});
test('fitProfile with an unobserved bin (no weekend) stays finite and leaves that coefficient at 0', () => {
    const wStart = T('2026-10-12T16:00:00Z'), wEnd = T('2026-10-13T16:00:00Z');   // Tue 00:00 -> Wed 00:00 Taipei
    const obs = []; for (let i = 0; i < 23; i++) { const f = features({ tm: new Date(wStart.getTime() + (i + 1.5) * H), wStart, wEnd, hodBins: 8 }); obs.push({ line: 'x', y: 0.1 * f.hod, f }); }
    const c = fitProfile(obs, { hodBins: 8 }); assert.equal(c.wk, 0); assert.ok([...c.hod, ...c.hte, ...c.hfs].every(Number.isFinite));
});
test('multiplier/expectedUnits/profileMember: flat profile gives time-proportional units; rHat scales; non-finite or non-positive rHat -> null', () => {
    const flat = { hod: new Array(24).fill(0), hte: new Array(10).fill(0), hfs: new Array(7).fill(0), wk: 0 };
    const wStart = T('2026-10-11T07:00:00Z'), wEnd = T('2026-10-12T07:00:00Z'), now = T('2026-10-11T19:30:00Z');
    assert.equal(multiplier(flat, { hod: 3, hte: 2, hfs: 1, wk: 1 }), 1);
    assert.ok(Math.abs(expectedUnits({ coef: flat, from: now, to: wEnd, wStart, wEnd, hodBins: 24 }) - 11.5) < 1e-9);
    assert.ok(Math.abs(profileMember({ sNow: 1000, s6: 400, coef: flat, now, wStart, wEnd, hodBins: 24 }) - (1000 + 100 * 11.5)) < 1e-9);
    assert.equal(profileMember({ sNow: 400, s6: 400, coef: flat, now, wStart, wEnd, hodBins: 24 }), null);   // rHat 0
    assert.equal(profileMember({ sNow: 1000, s6: null, coef: flat, now, wStart, wEnd, hodBins: 24 }), null);
    assert.equal(profileMember({ sNow: 1000, s6: 400, coef: null, now, wStart, wEnd, hodBins: 24 }), null);
});
