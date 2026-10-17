// node scripts/series-from-backup.js <event_id> [--yes]   (spec §9 step 3)
// Union of every local backup of the event and the DB's remaining non-final rows (DB wins); writes series via put_series,
// which asserts agreement with the DB-held snapshots and rolls back on any failure. Never deletes anything.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../src/env.js';
import { makeDb } from '../src/db.js';
import { buildSeries } from '../src/forecast/series.js';
import { readBackupRows, unionSnapshots } from './lib/backup-csv.js';
import { confirmTarget } from './confirm.js';
const id = Number(process.argv[2]);
if (!Number.isInteger(id) || id < 1) { console.error('usage: series-from-backup.js <event_id> [--yes]'); process.exit(2); }
const env = loadEnv();
const db = makeDb(createClient(env.url, env.key, { db: { schema: env.schema } }));
const ev = await db.loadKnown(id);
if (!ev) { console.error(`event ${id} unknown`); process.exit(1); }
if (!ev.finalized_at) { console.error(`event ${id} is not finalized; finalize writes the series itself`); process.exit(1); }
const dir = new URL('../.superpowers/backup/', import.meta.url);
const files = (() => { try { return readdirSync(dir).filter((f) => f.startsWith(`event-${id}-raw-`) && f.endsWith('.csv.gz')); } catch { return []; } })();
const backup = files.flatMap((f) => readBackupRows(join(dir.pathname, f))).filter((r) => r.event_id === id && !r.is_final);
const dbRows = await db.loadEventSnapshots(id);
const union = unionSnapshots(backup, dbRows);
const windows = [{ chapter: 0, wStart: ev.start_at, wEnd: ev.aggregate_at }, ...(ev.chapters ?? []).map((c) => ({ chapter: c.chapter, wStart: new Date(c.start_at), wEnd: new Date(c.aggregate_at) }))];
const rows = [];
for (const w of windows) {
    const s = buildSeries(union.filter((r) => r.chapter === w.chapter), w.wStart, w.wEnd);
    for (const [rank, v] of [...s].sort((a, b) => a[0] - b[0])) {
        const idx = v.scores.map((x, i) => (x == null ? -1 : i)).filter((i) => i >= 0);
        console.log(JSON.stringify({ chapter: w.chapter, rank, length: v.scores.length, first_non_null: idx[0] ?? null, last_non_null: idx.at(-1) ?? null, nulls: v.scores.length - idx.length }));
        rows.push({ chapter: w.chapter, rank, start_at: v.start_at.toISOString(), scores: v.scores });
    }
}
await confirmTarget({ url: env.url, schema: env.schema, argv: process.argv, extra: `event=${id} backups=${files.length} backup_rows=${backup.length} db_rows=${dbRows.length} union=${union.length} series_rows=${rows.length}` });
console.log(JSON.stringify(await db.putSeries(id, rows)));
