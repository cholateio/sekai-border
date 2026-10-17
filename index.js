// index.js  — `node index.js` (server) / `node index.js --once` (one round; exit 0 on 200, 1 otherwise)
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './src/env.js';
import { makeDb } from './src/db.js';
import { makeUpstream } from './src/fetch.js';
import { runOnce } from './src/run.js';
import { createServer } from './src/server.js';
const env = loadEnv();
console.log(JSON.stringify({ severity: 'INFO', msg: 'boot', supabase_ref: new URL(env.url).hostname.split('.')[0], schema: env.schema, revision: process.env.K_REVISION ?? null }));
const db = makeDb(createClient(env.url, env.key, { db: { schema: env.schema } }));
const upstream = makeUpstream({ userAgent: env.botContact });
const handler = () => runOnce({ db, upstream, now: new Date() });
if (process.argv.includes('--once')) { const r = await handler(); console.log(JSON.stringify(r.body)); process.exit(r.status === 200 ? 0 : 1); }
else { const port = Number(process.env.PORT || 8080); createServer({ handler }).listen(port, () => console.log(JSON.stringify({ severity: 'INFO', msg: 'listening', port }))); }
