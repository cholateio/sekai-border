import test from 'node:test';
import assert from 'node:assert/strict';
import { rankGroup, progressBin, familyOf, priorKey, lookupSigma, lookupQuantiles, validateParams, BIN_MID, DEFAULT_SIGMA, DEFAULT_Q10, DEFAULT_Q90, SIGMA_FLOOR, PROFILE_HOD_BINS } from '../src/forecast/params.js';
import { makeParams } from './helpers/params.js';

test('strata: rank groups, progress bins (edges belong to the upper bin), families, hod bins', () => {
    assert.deepEqual([1, 3, 4, 10, 20, 100, 200, 500, 1000, 1500, 10000].map(rankGroup), ['G1', 'G1', 'G2', 'G2', 'G3', 'G3', 'G4', 'G4', 'G5', 'G6', 'G6']);
    assert.deepEqual([0, 0.1, 0.15, 0.29, 0.3, 0.5, 0.7, 0.85, 0.99, 1, 1.2, -0.1].map(progressBin), [0, 0, 1, 1, 2, 3, 4, 5, 5, 5, 5, 0]);
    assert.deepEqual(BIN_MID, [0.075, 0.225, 0.4, 0.6, 0.775, 0.925]);
    assert.equal(familyOf(0), 'main'); assert.equal(familyOf(3), 'wl');
    assert.equal(PROFILE_HOD_BINS('G6'), 8); assert.equal(PROFILE_HOD_BINS('G1'), 24);
    assert.equal(priorKey('main', 'marathon', 9, 100), 'main:marathon:9:100'); assert.equal(priorKey('wl', 'world_bloom', 2, 100), 'wl:-:2:100'); assert.equal(priorKey('main', null, 9, 1), 'main:-:9:1');
});
test('lookupSigma backs off cell (n>=8) -> group -> family -> default, applies the floor', () => {
    const p = makeParams({ sigma: { cell: { 'main:G1:0': { linear: { s: 0.1, n: 8 }, prior: { s: 0.01, n: 9 }, measured: { s: 0.5, n: 7 } } }, group: { 'main:G1': { measured: { s: 0.2, n: 30 } } }, family: { main: { profile: { s: 0.3, n: 50 } } } } });
    assert.deepEqual(lookupSigma(p, 'main', 'G1', 0, 'linear'), { sigma: 0.1, level: 1 });
    assert.deepEqual(lookupSigma(p, 'main', 'G1', 0, 'prior'), { sigma: SIGMA_FLOOR, level: 1 });
    assert.deepEqual(lookupSigma(p, 'main', 'G1', 0, 'measured'), { sigma: 0.2, level: 2 });   // cell n = 7 < 8
    assert.deepEqual(lookupSigma(p, 'main', 'G1', 0, 'profile'), { sigma: 0.3, level: 3 });
    assert.deepEqual(lookupSigma(p, 'wl', 'G1', 0, 'linear'), { sigma: DEFAULT_SIGMA, level: 4 });
});
test('lookupQuantiles needs n>=20 at each level; default level 4 has n 0', () => {
    const p = makeParams({ resid: { cell: { 'main:G3:2': { q10: -0.1, q90: 0.2, n: 19, mae: 0.1, cover: 0.8 } }, group: { 'main:G3': { q10: -0.15, q90: 0.25, n: 20, mae: 0.1, cover: 0.8 } } } });
    assert.deepEqual(lookupQuantiles(p, 'main', 'G3', 2), { q10: -0.15, q90: 0.25, n: 20, level: 2 });
    assert.deepEqual(lookupQuantiles(p, 'main', 'G4', 2), { q10: DEFAULT_Q10, q90: DEFAULT_Q90, n: 0, level: 4 });
});
test('validateParams: accepts the empty params; rejects non-finite, sigma out of (0,2), q10 > q90, negative/non-integer n, wrong profile lengths, bad version', () => {
    assert.deepEqual(validateParams(makeParams()), { ok: true, errors: [] });
    const bad = [
        makeParams({ sigma: { cell: { 'main:G1:0': { linear: { s: NaN, n: 8 } } }, group: {}, family: {} } }),
        makeParams({ sigma: { cell: { 'main:G1:0': { linear: { s: 2, n: 8 } } }, group: {}, family: {} } }),
        makeParams({ sigma: { cell: { 'main:G1:0': { linear: { s: 0, n: 8 } } }, group: {}, family: {} } }),
        makeParams({ resid: { cell: { 'main:G1:0': { q10: 0.3, q90: 0.2, n: 20, mae: 0.1, cover: 0.5 } }, group: {}, family: {} } }),
        makeParams({ resid: { cell: { 'main:G1:0': { q10: -0.3, q90: 0.2, n: -1, mae: 0.1, cover: 0.5 } }, group: {}, family: {} } }),
        makeParams({ resid: { cell: { 'main:G1:0': { q10: -0.3, q90: 0.2, n: 2.5, mae: 0.1, cover: 0.5 } }, group: {}, family: {} } }),
        makeParams({ profile: { 'main:G1': { hod: new Array(8).fill(0), hte: new Array(10).fill(0), hfs: new Array(7).fill(0), wk: 0, n: 1, lines: 1 } } }),
        makeParams({ profile: { 'main:G6': { hod: new Array(8).fill(0), hte: new Array(10).fill(0), hfs: new Array(7).fill(Infinity), wk: 0, n: 1, lines: 1 } } }),
        makeParams({ prior: { 'main:marathon:9:1': { m: 'x', n: 3 } } }),
        makeParams({ version: 2 }),
        { ...makeParams(), trained_at: 'not a date' },
    ];
    for (const [i, p] of bad.entries()) { const v = validateParams(p); assert.equal(v.ok, false, `case ${i}`); assert.ok(v.errors.length > 0); }
    assert.equal(validateParams(null).ok, false); assert.equal(validateParams('x').ok, false);
});
