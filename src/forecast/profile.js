// Hourly rate profile (spec §4.2): ln(rho + 1) = a_line + f_hod + f_hte + f_hfs + f_wk, least squares with per-line intercepts
// removed analytically (within transformation), reference bins fixed at 0. Taiwan time = UTC + 8, no DST.
import { HTE_EDGES, HFS_EDGES } from './params.js';
const HOUR = 3600000;
export const taiwanHour = (d) => (d.getUTCHours() + 8) % 24;
export const isTaiwanWeekend = (d) => { const wd = new Date(d.getTime() + 8 * HOUR).getUTCDay(); return wd === 0 || wd === 6; };
const binOf = (edges, x) => { let i = 0; while (i + 1 < edges.length && x >= edges[i + 1]) i++; return i; };
export function features({ tm, wStart, wEnd, hodBins }) {
    const h = taiwanHour(tm);
    return { hod: hodBins === 8 ? Math.floor(h / 3) : h, hte: binOf(HTE_EDGES, (wEnd.getTime() - tm.getTime()) / HOUR), hfs: binOf(HFS_EDGES, (tm.getTime() - wStart.getTime()) / HOUR), wk: isTaiwanWeekend(tm) ? 1 : 0 };
}
export function seriesObservations({ line, startAt, scores, wStart, wEnd, hodBins }) {
    const out = [];
    for (let i = 0; i + 1 < scores.length; i++) {
        if (scores[i] == null || scores[i + 1] == null) continue;
        const rho = Math.max(0, scores[i + 1] - scores[i]);
        out.push({ line, y: Math.log(rho + 1), f: features({ tm: new Date(startAt.getTime() + (i + 1.5) * HOUR), wStart, wEnd, hodBins }) });
    }
    return out;
}
export function compactedObservations({ line, points, wStart, wEnd, hodBins }) {
    const cut = wEnd.getTime() - 24 * HOUR, out = [];
    const pts = points.filter((p) => p.taken_at.getTime() >= wStart.getTime() && p.taken_at.getTime() < cut).sort((a, b) => a.taken_at - b.taken_at);
    for (let i = 0; i + 1 < pts.length; i++) {
        const b0 = Math.floor(pts[i].taken_at.getTime() / (3 * HOUR)), b1 = Math.floor(pts[i + 1].taken_at.getTime() / (3 * HOUR));
        if (b1 !== b0 + 1) continue;
        const k = (pts[i + 1].taken_at.getTime() - pts[i].taken_at.getTime()) / HOUR; if (!(k > 0)) continue;
        const rho = Math.max(0, (pts[i + 1].score - pts[i].score) / k);
        out.push({ line, y: Math.log(rho + 1), f: features({ tm: new Date((pts[i].taken_at.getTime() + pts[i + 1].taken_at.getTime()) / 2), wStart, wEnd, hodBins }) });
    }
    return out;
}
export function fitProfile(obs, { hodBins }) {
    // Reference bin per factor = its lowest observed bin (hfs bin 0 is never observed from hourly series: the first pair's
    // midpoint is W_start + 1.5 h). Unobserved bins get no column and stay 0, so the fit is identifiable.
    const sizes = { hod: hodBins, hte: 10, hfs: 7 }, seen = { hod: new Set(), hte: new Set(), hfs: new Set() };
    let wkSeen = false;
    for (const o of obs) { seen.hod.add(o.f.hod); seen.hte.add(o.f.hte); seen.hfs.add(o.f.hfs); if (o.f.wk) wkSeen = true; }
    const col = {}; let P = 0;
    for (const k of ['hod', 'hte', 'hfs']) { const ref = Math.min(...seen[k], Infinity); col[k] = new Array(sizes[k]).fill(-1); for (let i = 0; i < sizes[k]; i++) if (seen[k].has(i) && i !== ref) col[k][i] = P++; }
    const wkCol = wkSeen ? P++ : -1;
    const cols = (f) => { const v = []; for (const k of ['hod', 'hte', 'hfs']) if (col[k][f[k]] >= 0) v.push(col[k][f[k]]); if (f.wk && wkCol >= 0) v.push(wkCol); return v; };
    const A = Array.from({ length: P }, () => new Float64Array(P)), b = new Float64Array(P), lines = new Map();
    for (const o of obs) {
        const v = cols(o.f);
        for (const i of v) { b[i] += o.y; for (const j of v) A[i][j] += 1; }
        let L = lines.get(o.line); if (!L) { L = { n: 0, sx: new Float64Array(P), sy: 0 }; lines.set(o.line, L); }
        L.n++; L.sy += o.y; for (const i of v) L.sx[i] += 1;
    }
    for (const L of lines.values()) {
        const yb = L.sy / L.n;
        for (let i = 0; i < P; i++) { const xi = L.sx[i] / L.n; if (xi === 0) continue; b[i] -= L.n * xi * yb; for (let j = 0; j < P; j++) A[i][j] -= L.n * xi * (L.sx[j] / L.n); }
    }
    for (let i = 0; i < P; i++) A[i][i] += 1e-9;   // ridge: a factor level collinear with the line intercepts (e.g. one line, one weekday state) stays near 0
    const beta = solve(A, b);
    const clean = (x) => (Math.abs(x) < 1e-9 ? 0 : x);
    const coef = (k) => col[k].map((c) => (c >= 0 ? clean(beta[c]) : 0));
    return { hod: coef('hod'), hte: coef('hte'), hfs: coef('hfs'), wk: wkCol >= 0 ? clean(beta[wkCol]) : 0, n: obs.length, lines: lines.size };
}
function solve(A, b) {
    const n = b.length, M = A.map((r) => Float64Array.from(r)), rhs = Float64Array.from(b), x = new Float64Array(n);
    for (let c = 0; c < n; c++) {
        let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        [M[c], M[p]] = [M[p], M[c]]; const t = rhs[c]; rhs[c] = rhs[p]; rhs[p] = t;
        const d = M[c][c]; if (Math.abs(d) < 1e-15) continue;
        for (let r = c + 1; r < n; r++) { const f = M[r][c] / d; if (f === 0) continue; for (let k = c; k < n; k++) M[r][k] -= f * M[c][k]; rhs[r] -= f * rhs[c]; }
    }
    for (let c = n - 1; c >= 0; c--) { let s = rhs[c]; for (let k = c + 1; k < n; k++) s -= M[c][k] * x[k]; x[c] = Math.abs(M[c][c]) < 1e-15 ? 0 : s / M[c][c]; }
    return x;
}
export const multiplier = (coef, f) => Math.exp(coef.hod[f.hod] + coef.hte[f.hte] + coef.hfs[f.hfs] + coef.wk * f.wk);
export function expectedUnits({ coef, from, to, wStart, wEnd, hodBins }) {
    let sum = 0, t = from.getTime(); const end = to.getTime();
    while (t < end) { const next = Math.min(end, (Math.floor(t / HOUR) + 1) * HOUR); sum += multiplier(coef, features({ tm: new Date((t + next) / 2), wStart, wEnd, hodBins })) * (next - t) / HOUR; t = next; }
    return sum;
}
// pastAt: time of the s6 value when it is not exactly now - 6 h (training on 3-hourly compacted points)
export function profileMember({ sNow, s6, coef, now, wStart, wEnd, hodBins, pastAt = null }) {
    if (coef == null || s6 == null || !Number.isFinite(s6)) return null;
    const past = expectedUnits({ coef, from: pastAt ?? new Date(now.getTime() - 6 * HOUR), to: now, wStart, wEnd, hodBins });
    const rHat = (sNow - s6) / past;
    if (!Number.isFinite(rHat) || !(rHat > 0)) return null;
    return sNow + rHat * expectedUnits({ coef, from: now, to: wEnd, wStart, wEnd, hodBins });
}
