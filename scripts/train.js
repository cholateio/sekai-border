// node scripts/train.js [--exclude 1,2] [--yes]   (writes sekai_border_model in SUPABASE_SCHEMA)
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../src/env.js';
import { makeDb } from '../src/db.js';
import { trainRound } from '../src/forecast/train.js';
import { log } from '../src/log.js';
import { confirmTarget } from './confirm.js';
const i = process.argv.indexOf('--exclude'); const exclude = i < 0 ? [] : String(process.argv[i + 1] ?? '').split(',').filter(Boolean).map(Number);
if (exclude.some((x) => !Number.isInteger(x) || x < 1)) { console.error('--exclude takes positive integers separated by commas'); process.exit(2); }
const env = loadEnv();
await confirmTarget({ url: env.url, schema: env.schema, argv: process.argv, extra: `train exclude=[${exclude}]` });
const db = makeDb(createClient(env.url, env.key, { db: { schema: env.schema } }));
const r = await trainRound({ db, now: new Date(), log, exclude });
console.log(JSON.stringify(r));
