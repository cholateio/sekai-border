// JS twin of {{schema}}.sekai_border_series_rows (0002): same buckets, same window rules (spec §3.2). Epoch-aligned hours.
export const SERIES_MAX_RANK = 1000;
const HOUR = 3600000;
export const floorHour = (d) => new Date(Math.floor(d.getTime() / HOUR) * HOUR);
export const seriesLength = (wStart, wEnd) => Math.ceil((wEnd.getTime() - floorHour(wStart).getTime()) / HOUR);
export const bucketIndex = (takenAt, startAt) => Math.floor((takenAt.getTime() - startAt.getTime()) / HOUR);

export function buildSeries(rows, wStart, wEnd) {
    const startAt = floorHour(wStart), n = seriesLength(wStart, wEnd), out = new Map();
    const last = new Map();   // `${rank}:${i}` -> { t, score }
    for (const r of rows) {
        if (r.rank > SERIES_MAX_RANK) continue;
        const t = r.taken_at instanceof Date ? r.taken_at : new Date(r.taken_at);
        if (t < wStart || t >= wEnd) continue;
        const i = bucketIndex(t, startAt), k = `${r.rank}:${i}`, prev = last.get(k);
        if (!prev || t > prev.t) last.set(k, { t, score: r.score });
        if (!out.has(r.rank)) out.set(r.rank, { start_at: startAt, scores: new Array(n).fill(null) });
    }
    for (const [k, v] of last) { const [rank, i] = k.split(':').map(Number); out.get(rank).scores[i] = v.score; }
    return out;
}
