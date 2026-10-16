// scripts/migrate-legacy.js   usage: --event <id> --cutover <ISO 5-min slot> [--candidate-slot <ISO 5-min slot>] [--allow-skipped N] [--yes]
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../src/env.js';
import { confirmTarget } from './confirm.js';
const opt = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const eventId = Number(opt('--event')), cutover = opt('--cutover'), candidate = opt('--candidate-slot') ?? null, allow = Number(opt('--allow-skipped') ?? 0);
// a real 5-minute UTC slot: the shape check plus a round trip, so 2026-99-99T99:55:00Z is rejected instead of reaching the RPC
const isSlot = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:[0-5][05]:00(\.000)?Z$/.test(s ?? '') && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 19) === s.slice(0, 19);
if (!Number.isInteger(eventId) || eventId < 1 || !isSlot(cutover) || (candidate !== null && (!isSlot(candidate) || Date.parse(candidate) >= Date.parse(cutover))) || !Number.isInteger(allow) || allow < 0) { console.error('usage: migrate-legacy.js --event <id> --cutover <YYYY-MM-DDTHH:M5:00Z> [--candidate-slot <YYYY-MM-DDTHH:M5:00Z>] [--allow-skipped N>=0] [--yes]'); process.exit(2); }
const env = loadEnv();
await confirmTarget({ url: env.url, schema: env.schema, argv: process.argv, extra: `event=${eventId} cutover=${cutover} candidate_slot=${candidate} allow_skipped=${allow}` });
const client = createClient(env.url, env.key, { db: { schema: env.schema } });
const { data, error } = await client.rpc('sekai_border_exec_migration', { p_event_id: eventId, p_cutover: cutover, p_candidate_slot: candidate, p_allow_skipped: allow });
if (error) { console.error(JSON.stringify({ migrated: false, error: error.message })); process.exit(1); }
console.log(JSON.stringify({ migrated: true, ...data }));
