// scripts/migrate-legacy.js   usage: --event <id> --cutover <ISO 5-min slot> [--candidate-slot <ISO 5-min slot>] [--allow-skipped N] [--yes]
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../src/env.js';
import { confirmTarget } from './confirm.js';
const opt = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const eventId = Number(opt('--event')), cutover = opt('--cutover'), candidate = opt('--candidate-slot') ?? null, allow = Number(opt('--allow-skipped') ?? 0);
if (!Number.isInteger(eventId) || !cutover || !/^\d{4}-\d{2}-\d{2}T\d{2}:[0-5][05]:00(\.000)?Z$/.test(cutover)) { console.error('usage: migrate-legacy.js --event <id> --cutover <YYYY-MM-DDTHH:M5:00Z> [--allow-skipped N] [--yes]'); process.exit(2); }
const env = loadEnv();
await confirmTarget({ url: env.url, schema: env.schema, argv: process.argv, extra: `event=${eventId} cutover=${cutover} candidate_slot=${candidate} allow_skipped=${allow}` });
const client = createClient(env.url, env.key, { db: { schema: env.schema } });
const { data, error } = await client.rpc('sekai_border_exec_migration', { p_event_id: eventId, p_cutover: cutover, p_candidate_slot: candidate, p_allow_skipped: allow });
if (error) { console.error(JSON.stringify({ migrated: false, error: error.message })); process.exit(1); }
console.log(JSON.stringify({ migrated: true, ...data }));
