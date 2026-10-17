// n finalized main events of `days` days, 2 weeks apart, finals = rate * hours (rate depends on rank), series = hourly cumulative, compacted = 3 h points
// shape: hourly rate x3 from 12:00 to 24:00 Taipei, x0.2 otherwise (applied to series and compacted alike) so a profile can beat linear
const T = (s) => new Date(s); const H = 3600000, DAY = 86400000;
const LE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 1000], GT = [1500, 2000, 2500, 3000, 5000, 10000];
export function synth({ n, days = 9, from = '2024-01-01T07:00:00Z', ranks = LE, gtRanks = GT, chapters = 0, type = 'marathon', idFrom = 1, noise = 0, shape = false }) {
    const events = [], series = [], compacted = [], finals = [];
    for (let k = 0; k < n; k++) {
        const id = idFrom + k, start = new Date(T(from).getTime() + k * 14 * DAY), end = new Date(start.getTime() + days * DAY - 1000);
        const chs = Array.from({ length: chapters }, (_, c) => ({ chapter: c + 1, character_id: 21 + c, start_at: new Date(start.getTime() + c * 2 * DAY).toISOString(), aggregate_at: new Date(start.getTime() + (c + 1) * 2 * DAY - 1000).toISOString() }));
        events.push({ id, event_type: type, start_at: start.toISOString(), aggregate_at: end.toISOString(), chapters: chs, finalized_at: end.toISOString() });
        const windows = [{ chapter: 0, s: start, e: end }, ...chs.map((c) => ({ chapter: c.chapter, s: T(c.start_at), e: T(c.aggregate_at) }))];
        for (const w of windows) {
            const hours = Math.ceil((w.e - w.s) / H), rate = (r) => 1000 * (11 - Math.log10(r)) * (1 + noise * Math.sin(id));
            const mult = (h) => { if (!shape) return 1; const tw = (w.s.getUTCHours() + 8 + h) % 24; return tw >= 12 ? 3 : 0.2; };   // hour h of the window
            const cum = (r, h) => { let a = 0; for (let k = 0; k < h; k++) a += rate(r) * mult(k); return Math.round(a); };
            for (const r of ranks) { series.push({ event_id: id, chapter: w.chapter, rank: r, start_at: w.s.toISOString(), scores: Array.from({ length: hours }, (_, i) => cum(r, i + 1)) }); finals.push({ event_id: id, chapter: w.chapter, rank: r, score: cum(r, hours) }); }
            for (const r of gtRanks) { for (let h = 3; h < hours; h += 3) compacted.push({ event_id: id, chapter: w.chapter, rank: r, score: cum(r, h), taken_at: new Date(w.s.getTime() + h * H - 300000).toISOString() }); finals.push({ event_id: id, chapter: w.chapter, rank: r, score: cum(r, hours) }); }
        }
    }
    return { events, series, compacted, finals };
}
