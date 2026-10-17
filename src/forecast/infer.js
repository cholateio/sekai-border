// Per-round inference (spec §4.2-4.4, §7). Reads only the three slots it needs; writes through the put_forecasts RPC.
import { ALLOWED_RANKS, SLOT_MS } from '../constants.js';
import { rankGroup, progressBin, familyOf, lookupQuantiles, PROFILE_HOD_BINS, groupKey, validateParams } from './params.js';
import { linearMember, measuredMember, priorMember } from './members.js';
import { profileMember, expectedUnits } from './profile.js';
import { combine, interval, pathTimes, buildPath, confidenceOf, checkRow } from './combine.js';
import { makeDeadline } from './deadline.js';
const HOUR = 3600000, DAY = 86400000, MAX_WINDOW_MS = 21 * DAY;
export const slotOf = (d) => new Date(Math.floor(d.getTime() / SLOT_MS) * SLOT_MS);
const D = (x) => (x instanceof Date ? x : new Date(x));

export function activeWindows(event, at) {
    const wins = [{ chapter: 0, wStart: D(event.start_at), wEnd: D(event.aggregate_at) }, ...(event.chapters ?? []).map((c) => ({ chapter: c.chapter, wStart: D(c.start_at), wEnd: D(c.aggregate_at) }))];
    return wins.filter((w) => w.wStart <= at && at < w.wEnd && w.wEnd.getTime() - w.wStart.getTime() <= MAX_WINDOW_MS).map((w) => ({ ...w, days: Math.round((w.wEnd.getTime() - w.wStart.getTime()) / DAY) }));
}

export function forecastLines({ now, event, params, slotRows, log = () => {} }) {
    const slot = slotOf(now), t6 = new Date(slot.getTime() - 6 * HOUR), t24 = new Date(slot.getTime() - 24 * HOUR);
    const idx = new Map(slotRows.map((r) => [`${r.chapter}:${r.rank}:${new Date(r.taken_at).getTime()}`, r.score]));
    const at = (chapter, rank, t) => idx.get(`${chapter}:${rank}:${t.getTime()}`) ?? null;
    const rows = [];
    // windows are selected at `now` (a chapter that ended between slot and now is not forecast); scores and computed_at use the slot
    for (const w of activeWindows(event, now)) {
        const family = familyOf(w.chapter), len = w.wEnd.getTime() - w.wStart.getTime();
        const tau = (slot.getTime() - w.wStart.getTime()) / len, hoursElapsed = (slot.getTime() - w.wStart.getTime()) / HOUR, hoursLeft = (w.wEnd.getTime() - slot.getTime()) / HOUR;
        const times = pathTimes(slot, w.wEnd);
        for (const rank of ALLOWED_RANKS) {
            const sNow = at(w.chapter, rank, slot); if (sNow == null) continue;
            const s6 = at(w.chapter, rank, t6), s24 = at(w.chapter, rank, t24);
            const group = rankGroup(rank), bin = progressBin(tau), hodBins = PROFILE_HOD_BINS(group), coef = params.profile[groupKey(family, group)] ?? null;
            const preds = {
                linear: linearMember({ sNow, tau }),
                measured: measuredMember({ sNow, s6, s24, hoursElapsed, hoursLeft }),
                prior: priorMember({ table: params.prior, family, type: event.event_type ?? null, days: w.days, rank }),
                profile: profileMember({ sNow, s6, coef, now: slot, wStart: w.wStart, wEnd: w.wEnd, hodBins }),
            };
            const c = combine({ sNow, preds, params, family, group, bin }); if (!c) continue;
            const q = lookupQuantiles(params, family, group, bin);
            const fin = interval({ p50: c.p50, sNow, q10: q.q10, q90: q.q90 });
            const total = c.weights.profile ? expectedUnits({ coef, from: slot, to: w.wEnd, wStart: w.wStart, wEnd: w.wEnd, hodBins }) : null;
            const F = c.weights.profile && total > 0 ? (t) => expectedUnits({ coef, from: slot, to: t, wStart: w.wStart, wEnd: w.wEnd, hodBins }) / total : (t) => (t.getTime() - slot.getTime()) / (w.wEnd.getTime() - slot.getTime());
            const row = { event_id: event.id, chapter: w.chapter, rank, computed_at: slot.toISOString(), current_score: sNow, final_p10: fin.p10, final_p50: fin.p50, final_p90: fin.p90,
                path: buildPath({ sNow, finals: fin, times, F }), method: c.method, confidence: confidenceOf({ method: c.method, quantLevel: q.level, quantN: q.n }) };
            try { checkRow(row, times.length); rows.push(row); } catch (e) { log('error', 'forecast row invalid', { chapter: w.chapter, rank, reason: e.message }); }
        }
    }
    return rows;
}

export async function inferRound({ db, now, event, log = () => {}, deadlineMs = 20000, writeWithinMs = 15000 }) {
    const dl = makeDeadline(deadlineMs);
    try {
        return await dl.race((async () => {
            const model = await db.loadModel(dl.signal);
            if (!model) { log('warn', 'forecast skipped', { reason: 'no_params' }); return { rows: 0, written: false, reason: 'no_params' }; }
            const v = validateParams(model.params);
            if (!v.ok) { log('warn', 'forecast skipped', { reason: 'invalid_params', errors: v.errors.slice(0, 3) }); return { rows: 0, written: false, reason: 'invalid_params' }; }
            const slot = slotOf(now);
            const slotRows = await db.loadSlots(event.id, [slot, new Date(slot.getTime() - 6 * HOUR), new Date(slot.getTime() - 24 * HOUR)], dl.signal);
            const rows = forecastLines({ now, event, params: model.params, slotRows, log });
            if (rows.length === 0) return { rows: 0, written: false, reason: 'no_lines' };
            if (dl.elapsed() > writeWithinMs) throw new Error(`write budget ${writeWithinMs} ms exceeded`);
            const r = await db.putForecasts(event.id, slot, rows, dl.signal);
            if (!r.written) log('warn', 'forecast not written', { reason: r.reason });
            return { rows: rows.length, written: !!r.written, reason: r.reason ?? null };
        })());
    } finally { dl.clear(); }
}
