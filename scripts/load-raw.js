// node scripts/load-raw.js <csv.gz> --as <event_id> [--yes]   (A1 capacity input; TEST SCHEMA ONLY)
// Copies the event's metadata from public (read-only) under a new id and loads every non-final row of the backup under it.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../src/env.js';
import { readBackupRows } from './lib/backup-csv.js';
import { confirmTarget } from './confirm.js';
const file = process.argv[2], i = process.argv.indexOf('--as'), asId = Number(process.argv[i + 1]);
if (!file || i < 0 || !Number.isInteger(asId) || asId < 1) { console.error('usage: load-raw.js <csv.gz> --as <event_id> [--yes]'); process.exit(2); }
const env = loadEnv();
if (env.schema !== 'test') { console.error('load-raw.js writes only to the test schema (SUPABASE_SCHEMA=test)'); process.exit(2); }
const rows = readBackupRows(file).filter((r) => !r.is_final);
const srcId = rows[0]?.event_id; if (!srcId) { console.error('no non-final rows'); process.exit(1); }
const pub = createClient(env.url, env.key, { db: { schema: 'public' } }), test = createClient(env.url, env.key, { db: { schema: 'test' } });
const { data: src, error } = await pub.from('sekai_border_events').select('name,start_at,aggregate_at,ranking_announce_at,chapters,event_type').eq('id', srcId).single(); if (error) { console.error(error.message); process.exit(1); }
await confirmTarget({ url: env.url, schema: env.schema, argv: process.argv, extra: `load ${rows.length} rows of event ${srcId} as ${asId}` });
const e = await test.from('sekai_border_events').upsert({ id: asId, ...src, name: `capacity-${srcId}` }, { onConflict: 'id' }); if (e.error) { console.error(e.error.message); process.exit(1); }
for (let k = 0; k < rows.length; k += 1000) { const r = await test.from('sekai_border_rankings').upsert(rows.slice(k, k + 1000).map((x) => ({ ...x, event_id: asId })), { onConflict: 'event_id,chapter,rank,taken_at,is_final', ignoreDuplicates: true }); if (r.error) { console.error(r.error.message); process.exit(1); } }
console.log(JSON.stringify({ loaded: rows.length, as: asId }));
