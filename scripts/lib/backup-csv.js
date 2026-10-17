// Reads the gzipped CSV written by .superpowers/rollout/backup-event.mjs (columns fixed) and merges it with DB rows.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const COLS = 'event_id,chapter,rank,score,taken_at,is_final';
export function readBackupRows(file) {
    const lines = gunzipSync(readFileSync(file)).toString('utf8').trim().split('\n');
    if (lines[0] !== COLS) throw new Error(`unexpected columns in ${file}: ${lines[0]}`);
    return lines.slice(1).map((l) => { const [event_id, chapter, rank, score, taken_at, is_final] = l.split(','); return { event_id: Number(event_id), chapter: Number(chapter), rank: Number(rank), score: Number(score), taken_at: new Date(taken_at).toISOString(), is_final: is_final === 'true' }; });
}
export function unionSnapshots(backupRows, dbRows) {
    const m = new Map(); const key = (r) => `${r.chapter}:${r.rank}:${new Date(r.taken_at).toISOString()}`;
    for (const r of backupRows) m.set(key(r), { chapter: r.chapter, rank: r.rank, score: r.score, taken_at: new Date(r.taken_at).toISOString() });
    for (const r of dbRows) m.set(key(r), { chapter: r.chapter, rank: r.rank, score: r.score, taken_at: new Date(r.taken_at).toISOString() });
    return [...m.values()];
}
