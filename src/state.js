// src/state.js
// Pure decisions only; the caller loads DB rows and performs effects (spec §4.2).
import { SLOT_MS, ANNOUNCE_GRACE_MS } from './constants.js';
export const slotOf = (date) => new Date(Math.floor(date.getTime() / SLOT_MS) * SLOT_MS);
export const isEligibleForFinalize = (row, now) => row.finalized_at == null && now.getTime() >= row.ranking_announce_at.getTime() + ANNOUNCE_GRACE_MS;
export function classify(row, now) {
    if (row.finalized_at != null) return 'stale-live';
    const t = now.getTime();
    if (t < row.aggregate_at.getTime()) return 'current';
    if (t < row.ranking_announce_at.getTime() + ANNOUNCE_GRACE_MS) return 'frozen';
    return 'due';
}
export function decide({ live, known, startedLatest, now, preStart }) {
    if (known) return { ensure: 'none', branch: classify(known, now) };
    if (startedLatest && live.id < startedLatest.id) return { ensure: 'regress', branch: null };
    if (preStart) return { ensure: 'pre-start', branch: 'pre-start' };
    return { ensure: 'insert', branch: classify({ ...live, finalized_at: null }, now) };
}
