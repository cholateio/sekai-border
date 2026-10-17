// Member predictors (spec §4.2) and the historical prior table (spec §4.5). All pure.
import { priorKey, PRIOR_MAX_SAMPLES } from './params.js';
export const usable = (pred, sNow) => Number.isFinite(pred) && pred > 0 && pred >= sNow;
export function linearMember({ sNow, tau }) { if (!(tau >= 0.02) || !(sNow > 0)) return null; return sNow / tau; }
export function measuredMember({ sNow, s6, s24, hoursElapsed, hoursLeft }) {
    if (!(hoursElapsed >= 6)) return null;
    const L = hoursElapsed >= 24 ? 24 : 6, past = L === 24 ? s24 : s6;
    if (past == null || !Number.isFinite(past)) return null;
    const v = (sNow - past) / L;
    if (!(v >= 0)) return null;
    return sNow + v * hoursLeft;
}
export function priorMember({ table, family, type, days, rank }) { const e = table?.[priorKey(family, type, days, rank)]; if (!e || !(e.n >= 2)) return null; return Math.exp(e.m); }
export function buildPriorTable(periods, finals, { before = null, nowSeq = null } = {}) {
    const used = periods.filter((p) => before == null || p.wEnd < before);
    const seqNow = nowSeq ?? (periods.length ? periods[periods.length - 1].seq + 1 : 0);
    const strata = new Map();
    for (const p of used) {
        const f = finals.get(p.key); if (!f) continue;
        for (const [rank, score] of f) { if (!(score > 0)) continue; const k = priorKey(p.family, p.type, p.days, rank); if (!strata.has(k)) strata.set(k, []); strata.get(k).push({ seq: p.seq, lnv: Math.log(score) }); }
    }
    const out = {};
    for (const [k, arr] of strata) {
        arr.sort((a, b) => a.seq - b.seq);
        const last = arr.slice(-PRIOR_MAX_SAMPLES); let sw = 0, s = 0;
        for (const x of last) { const w = Math.pow(0.5, (seqNow - x.seq) / 6); sw += w; s += w * x.lnv; }
        out[k] = { m: s / sw, n: last.length };
    }
    return out;
}
