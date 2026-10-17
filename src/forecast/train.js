// Training = rolling-origin backtest (spec §4.5-4.6): per fold, prior and profile see only periods that ended before the fold
// started; pass 1 collects member log errors (sigma), pass 2 the ensemble residuals (quantiles, coverage). Pure except trainRound.
import { ALLOWED_RANKS } from '../constants.js';
import { MEMBERS, BIN_MID, rankGroup, familyOf, cellKey, groupKey, PROFILE_HOD_BINS, validateParams, GROUPS } from './params.js';
import { linearMember, measuredMember, priorMember, buildPriorTable, usable } from './members.js';
import { seriesObservations, compactedObservations, fitProfile, profileMember } from './profile.js';
import { combine, interval } from './combine.js';
import { makeDeadline } from './deadline.js';
const HOUR = 3600000, DAY = 86400000, LAG_TOLERANCE_MS = 5 * 60000, SERIES_CAP = 40, PRIOR_EVAL_CAP = 120, MIN_PROFILE_PERIODS = 3, MIN_PROFILE_OBS = 24;
const D = (x) => (x instanceof Date ? x : new Date(x));

export function buildPeriods(events, { exclude = [] } = {}) {
    const ex = new Set(exclude), out = { main: [], wl: [] };
    for (const e of events) {
        if (ex.has(e.id)) continue;
        const ws = D(e.start_at), we = D(e.aggregate_at);
        out.main.push({ key: `${e.id}:0`, eventId: e.id, chapter: 0, family: 'main', type: e.event_type ?? null, days: Math.round((we - ws) / DAY), wStart: ws, wEnd: we });
        for (const c of e.chapters ?? []) { const cs = D(c.start_at), ce = D(c.aggregate_at); out.wl.push({ key: `${e.id}:${c.chapter}`, eventId: e.id, chapter: c.chapter, family: 'wl', type: null, days: Math.round((ce - cs) / DAY), wStart: cs, wEnd: ce }); }
    }
    for (const fam of ['main', 'wl']) { out[fam].sort((a, b) => a.wStart - b.wStart || a.eventId - b.eventId || a.chapter - b.chapter); out[fam].forEach((p, i) => { p.seq = i; }); }
    return out;
}
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
const push = (obj, key, member, e) => { ((obj[key] ??= {})[member] ??= []).push(e); };
// state of one line at time tEff (an hour boundary): last series bucket that ended at or before tEff, and the values 6 h / 24 h earlier
function stateFromSeries(s, tEff) {
    if (!s) return { sNow: null, s6: null, s24: null };
    const i = Math.floor((tEff.getTime() - s.startAt.getTime()) / HOUR) - 1;
    const v = (k) => (k >= 0 && k < s.scores.length ? s.scores[k] : null);
    return { sNow: v(i), s6: v(i - 6), s24: v(i - 24) };
}
// pts sorted by taken_at; last point at or before t. A compacted point can be up to 3 h older than tEff, so its own time is
// returned and the line is evaluated at that time (at). The 6 h / 24 h past values count only when a point sits at that exact
// lag (one slot of tolerance), as live inference requires; otherwise measured/profile are unavailable for the line.
export function stateFromPoints(pts, tEff) {
    const last = (t) => { let v = null; for (const p of pts) { if (p.taken_at.getTime() <= t) v = p; else break; } return v; };
    const a = last(tEff.getTime()); if (!a) return { sNow: null, s6: null, s24: null };
    const lag = (h) => { const p = last(a.taken_at.getTime() - h * HOUR); return p && a.taken_at.getTime() - p.taken_at.getTime() - h * HOUR <= LAG_TOLERANCE_MS ? p : null; };
    const b = lag(6), c = lag(24);
    return { sNow: a.score, s6: b?.score ?? null, s24: c?.score ?? null, at: a.taken_at, at6: b?.taken_at ?? null };
}

// onFold: once per fold (pass 1) with the fold's training set; onYield: before every fold evaluation of both passes (deadline checks).
export async function fitParams({ periods, series, compacted, finals, now, excluded = [], onFold = null, onYield = null }) {
    const finalsBy = new Map(); for (const f of finals) { const k = `${f.event_id}:${f.chapter}`; if (!finalsBy.has(k)) finalsBy.set(k, new Map()); finalsBy.get(k).set(f.rank, f.score); }
    const seriesBy = new Map(); for (const s of series) { const k = `${s.event_id}:${s.chapter}`; if (!seriesBy.has(k)) seriesBy.set(k, new Map()); seriesBy.get(k).set(s.rank, { startAt: D(s.start_at), scores: s.scores }); }
    const pointsBy = new Map(); for (const c of compacted) { const k = `${c.event_id}:${c.chapter}`; if (!pointsBy.has(k)) pointsBy.set(k, new Map()); const m = pointsBy.get(k); if (!m.has(c.rank)) m.set(c.rank, []); m.get(c.rank).push({ taken_at: D(c.taken_at), score: c.score }); }
    for (const m of pointsBy.values()) for (const a of m.values()) a.sort((x, y) => x.taken_at - y.taken_at);
    const params = { version: 1, trained_at: now.toISOString(), input: { main_periods: 0, wl_periods: 0, prior_rows: finals.length, excluded: [...excluded] }, profile: {}, sigma: { cell: {}, group: {}, family: {} }, resid: { cell: {}, group: {}, family: {} }, prior: {}, periods: {} };
    const memberErr = { cell: {}, group: {}, family: {} }, residSamples = { cell: {}, group: {}, family: {} }, profileCache = new Map(), perPeriod = {};
    const lineObs = (p, rank, hodBins) => {
        if (rankGroup(rank) === 'G6') { const pts = pointsBy.get(p.key)?.get(rank); return pts ? compactedObservations({ line: `${p.key}:${rank}`, points: pts, wStart: p.wStart, wEnd: p.wEnd, hodBins }) : []; }
        const s = seriesBy.get(p.key)?.get(rank); return s ? seriesObservations({ line: `${p.key}:${rank}`, startAt: s.startAt, scores: s.scores, wStart: p.wStart, wEnd: p.wEnd, hodBins }) : [];
    };
    const fitGroup = (group, training) => { const hodBins = PROFILE_HOD_BINS(group); const obs = training.flatMap((p) => ALLOWED_RANKS.filter((r) => rankGroup(r) === group).flatMap((r) => lineObs(p, r, hodBins))); return obs.length >= MIN_PROFILE_OBS ? fitProfile(obs, { hodBins }) : null; };
    const hasData = (p) => seriesBy.has(p.key) || pointsBy.has(p.key);
    const sigmaTables = (keep) => { const out = { cell: {}, group: {}, family: {} };
        for (const lvl of ['cell', 'group', 'family']) for (const [k, members] of Object.entries(memberErr[lvl])) for (const [m, xs] of Object.entries(members)) { const es = xs.filter(keep).map((x) => x.e); if (es.length) (out[lvl][k] ??= {})[m] = { s: Math.min(1.999, Math.max(1e-6, rms(es))), n: es.length }; }
        return out; };
    const maeOf = (es) => es.reduce((a, x) => a + Math.abs(x), 0) / es.length;

    for (const family of ['main', 'wl']) {
        const P = periods[family], withData = P.filter(hasData).slice(-SERIES_CAP), seriesSet = new Set(withData.map((p) => p.key)), priorEval = new Set(P.slice(-PRIOR_EVAL_CAP).map((p) => p.key));
        params.input[`${family}_periods`] = withData.length;
        Object.assign(params.prior, buildPriorTable(P, finalsBy));
        const folds = P.filter((p) => seriesSet.has(p.key) || priorEval.has(p.key));
        // One fold = one period j evaluated at every bin representative. `training` is exactly what prior and profile may see.
        const evalFold = async (j, pass) => {
            const training = P.filter((p) => p.wEnd < j.wStart), trainingData = training.filter((p) => seriesSet.has(p.key));
            if (onYield) await onYield();
            if (onFold && pass === 1) await onFold({ period: j, training });
            const priorTable = buildPriorTable(training, finalsBy, { nowSeq: j.seq });
            const coefs = {};
            if (seriesSet.has(j.key)) for (const g of GROUPS) { const ck = `${j.key}:${g}`; if (!profileCache.has(ck)) profileCache.set(ck, trainingData.length ? fitGroup(g, trainingData) : null); coefs[g] = profileCache.get(ck); }
            const fin = finalsBy.get(j.key) ?? new Map(), len = j.wEnd.getTime() - j.wStart.getTime(), es = [];
            // rolling origin for the ensemble too: weights come from member errors of folds that ended before this one started
            const sigmaView = pass === 2 ? { sigma: sigmaTables((x) => x.wEnd < j.wStart) } : null;
            for (let b = 0; b < BIN_MID.length; b++) {
                const t = new Date(j.wStart.getTime() + BIN_MID[b] * len), tEff = new Date(Math.floor(t.getTime() / HOUR) * HOUR);
                if (tEff <= j.wStart) continue;
                for (const rank of ALLOWED_RANKS) {
                    const final = fin.get(rank); if (!(final > 0)) continue;
                    const group = rankGroup(rank), keys = [['cell', cellKey(family, group, b)], ['group', groupKey(family, group)], ['family', family]];
                    let st = { sNow: null, s6: null, s24: null };
                    if (seriesSet.has(j.key)) st = group === 'G6' ? stateFromPoints(pointsBy.get(j.key)?.get(rank) ?? [], tEff) : stateFromSeries(seriesBy.get(j.key)?.get(rank), tEff);
                    const preds = { prior: priorEval.has(j.key) ? priorMember({ table: priorTable, family, type: j.type, days: j.days, rank }) : null };
                    const at = st.at ?? tEff, tau = (at.getTime() - j.wStart.getTime()) / len, hoursElapsed = (at.getTime() - j.wStart.getTime()) / HOUR, hoursLeft = (j.wEnd.getTime() - at.getTime()) / HOUR;
                    if (st.sNow != null) {
                        preds.linear = linearMember({ sNow: st.sNow, tau });
                        preds.measured = measuredMember({ sNow: st.sNow, s6: st.s6, s24: st.s24, hoursElapsed, hoursLeft });
                        preds.profile = profileMember({ sNow: st.sNow, s6: st.s6, coef: coefs[group] ?? null, now: at, pastAt: st.at6 ?? null, wStart: j.wStart, wEnd: j.wEnd, hodBins: PROFILE_HOD_BINS(group) });
                    }
                    const sNow = st.sNow ?? 0;
                    if (pass === 1) { for (const m of MEMBERS) if (preds[m] != null && usable(preds[m], sNow)) for (const [lvl, k] of keys) push(memberErr[lvl], k, m, { e: Math.log(preds[m] / final), wEnd: j.wEnd }); continue; }
                    const c = combine({ sNow, preds, params: sigmaView, family, group, bin: b }); if (!c) continue;
                    const e = Math.log(c.p50 / final); es.push(Math.abs(e));
                    for (const [lvl, k] of keys) push(residSamples[lvl], k, 's', { e, p50: c.p50, sNow, final });
                }
            }
            if (pass === 2 && es.length) perPeriod[j.key] = { mae: maeOf(es), n: es.length };
        };
        for (const j of folds) await evalFold(j, 1);
        for (const j of folds) await evalFold(j, 2);
        // the deployed sigma uses every fold (all history is in the past at inference time)
        const all = sigmaTables(() => true); for (const lvl of ['cell', 'group', 'family']) Object.assign(params.sigma[lvl], all[lvl]);
        // quantiles from the ensemble residuals; coverage re-evaluates every sample's interval with the level's own quantiles
        for (const lvl of ['cell', 'group', 'family']) for (const [k, v] of Object.entries(residSamples[lvl])) {
            if (!k.startsWith(family)) continue;
            const es = v.s.map((x) => x.e).sort((a, b) => a - b), q10 = pct(es, 0.1), q90 = pct(es, 0.9);
            const hits = v.s.filter((x) => { const iv = interval({ p50: x.p50, sNow: x.sNow, q10, q90 }); return iv.p10 <= x.final && x.final <= iv.p90; }).length;
            params.resid[lvl][k] = { q10, q90, n: es.length, mae: maeOf(es), cover: hits / es.length };
        }
        // profile activation (spec §4.6): >= 3 periods with observations FOR THIS GROUP, profile beats linear on the pooled group errors with n >= 8
        for (const g of GROUPS) {
            const gk = groupKey(family, g), ep = memberErr.group[gk]?.profile?.map((x) => x.e), el = memberErr.group[gk]?.linear?.map((x) => x.e), hodBins = PROFILE_HOD_BINS(g);
            const groupPeriods = withData.filter((p) => ALLOWED_RANKS.some((r) => rankGroup(r) === g && lineObs(p, r, hodBins).length > 0)).length;
            if (groupPeriods >= MIN_PROFILE_PERIODS && ep && ep.length >= 8 && el && maeOf(ep) < maeOf(el)) { const coef = fitGroup(g, withData); if (coef) params.profile[gk] = coef; }
        }
    }
    params.periods = perPeriod;
    return params;
}
export async function loadTrainingInputs(db, signal, { exclude = [] } = {}) {
    const events = (await db.loadFinalizedEvents(signal)).filter((e) => !exclude.includes(e.id));
    const periods = buildPeriods(events);
    const ids = new Set([...periods.main.slice(-SERIES_CAP), ...periods.wl.slice(-SERIES_CAP)].map((p) => p.eventId));
    const [series, compacted, finals] = [await db.loadSeries([...ids], signal), await db.loadCompacted([...ids], signal), await db.loadFinals(signal)];
    return { events, periods, series, compacted, finals };
}
export async function trainRound({ db, now, log = () => {}, exclude = [], deadlineMs = 60000, saveWithinMs = 50000, slowFoldMs = 0 }) {
    const dl = makeDeadline(deadlineMs);
    try {
        return await dl.race((async () => {
            const inputs = await loadTrainingInputs(db, dl.signal, { exclude });
            const onYield = async () => { if (slowFoldMs) await new Promise((r) => setTimeout(r, slowFoldMs)); await new Promise((r) => setImmediate(r)); if (dl.expired()) throw new Error(`deadline ${deadlineMs} ms exceeded at fold`); };
            const params = await fitParams({ ...inputs, now, excluded: exclude, onYield });
            const v = validateParams(params); if (!v.ok) { log('error', 'train failed', { reason: 'invalid_params', errors: v.errors.slice(0, 5) }); throw new Error('params validation failed'); }
            if (dl.elapsed() > saveWithinMs) throw new Error(`save budget ${saveWithinMs} ms exceeded`);
            const ok = await db.saveModel(params, now, dl.signal);
            if (ok === false) log('warn', 'model not saved', { reason: 'stale' });
            return { saved: ok !== false, reason: ok === false ? 'stale' : null, main_periods: params.input.main_periods, wl_periods: params.input.wl_periods, profile: Object.keys(params.profile), excluded: exclude };
        })());
    } finally { dl.clear(); }
}
