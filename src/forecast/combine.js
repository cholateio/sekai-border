// Ensemble, interval, path and row invariants (spec §4.3, A4). Pure.
import { MEMBERS, lookupSigma } from './params.js';
import { usable } from './members.js';
const HOUR = 3600000;
export function combine({ sNow, preds, params, family, group, bin }) {
    let sw = 0, acc = 0; const weights = {};
    for (const m of MEMBERS) {
        const p = preds[m]; if (p == null || !usable(p, sNow)) continue;
        const { sigma } = lookupSigma(params, family, group, bin, m); const w = 1 / (sigma * sigma);
        weights[m] = w; sw += w; acc += w * Math.log(p);
    }
    if (sw === 0) return null;
    for (const m of Object.keys(weights)) weights[m] /= sw;
    const best = MEMBERS.filter((m) => m in weights).reduce((a, m) => (weights[m] > weights[a] ? m : a));
    return { p50: Math.max(Math.round(Math.exp(acc / sw)), sNow), weights, method: best === 'profile' ? 'model' : best };
}
export function interval({ p50, sNow, q10, q90 }) {
    let p10 = Math.round(Math.min(p50, Math.max(sNow, p50 * Math.exp(-q90))));
    let p90 = Math.round(Math.max(p50, p50 * Math.exp(-q10)));
    p10 = Math.max(p10, sNow); const mid = Math.max(p50, p10); p90 = Math.max(p90, mid);
    return { p10, p50: mid, p90 };
}
export function pathTimes(computedAt, wEnd) {
    const out = []; let t = (Math.floor(computedAt.getTime() / HOUR) + 1) * HOUR;
    while (t < wEnd.getTime()) { out.push(new Date(t)); t += HOUR; }
    out.push(new Date(wEnd.getTime()));
    return out;
}
export function buildPath({ sNow, finals, times, F }) {
    const q = (final) => { const a = times.map((t, i) => (i === times.length - 1 ? final : Math.round(sNow + (final - sNow) * Math.min(1, Math.max(0, F(t)))))); for (let i = 1; i < a.length; i++) a[i] = Math.max(a[i], a[i - 1]); return a; };
    return { t0: times[0].toISOString(), p10: q(finals.p10), p50: q(finals.p50), p90: q(finals.p90) };
}
export const confidenceOf = ({ method, quantLevel, quantN }) => (method === 'linear' || method === 'prior' || quantLevel >= 3 || quantN < 20 ? 'low' : 'normal');
export function checkRow(row, nTimes) {
    const all = [row.current_score, row.final_p10, row.final_p50, row.final_p90, ...row.path.p10, ...row.path.p50, ...row.path.p90];
    if (!all.every(Number.isInteger)) throw new Error('non-integer value');
    if (!(row.current_score <= row.final_p10 && row.final_p10 <= row.final_p50 && row.final_p50 <= row.final_p90)) throw new Error('order violated');
    for (const [k, fin] of [['p10', row.final_p10], ['p50', row.final_p50], ['p90', row.final_p90]]) {
        const a = row.path[k]; if (a.length !== nTimes) throw new Error(`path ${k} length ${a.length} <> ${nTimes}`); if (a[a.length - 1] !== fin) throw new Error(`path ${k} end <> final`);
        for (let i = 1; i < a.length; i++) if (a[i] < a[i - 1]) throw new Error(`path ${k} decreasing at ${i}`);
    }
    if (!['model', 'measured', 'prior', 'linear'].includes(row.method) || !['normal', 'low'].includes(row.confidence)) throw new Error('enum value');
}
