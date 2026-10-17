// node scripts/capacity-model.js [--yes]   (A1 model-row size; TEST SCHEMA ONLY)
// Fits params on the A15 full-size synthetic input and stores exactly that document in test.sekai_border_model, so the gate
// can read pg_column_size(params) for a production-shaped model instead of a three-event one.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../src/env.js';
import { buildPeriods, fitParams } from '../src/forecast/train.js';
import { synth } from '../test/helpers/synth.js';
import { confirmTarget } from './confirm.js';
const env = loadEnv();
if (env.schema !== 'test') { console.error('capacity-model.js writes only to the test schema (SUPABASE_SCHEMA=test)'); process.exit(2); }
const main = synth({ n: 40, idFrom: 1, shape: true }), wl = synth({ n: 20, chapters: 2, type: 'world_bloom', idFrom: 1000, from: '2024-02-01T07:00:00Z', shape: true }), hist = synth({ n: 120, idFrom: 5000, from: '2019-01-01T07:00:00Z' });
hist.series = []; hist.compacted = [];
const d = { events: [...hist.events, ...main.events, ...wl.events], series: [...main.series, ...wl.series], compacted: [...main.compacted, ...wl.compacted], finals: [...hist.finals, ...main.finals, ...wl.finals] };
const params = await fitParams({ periods: buildPeriods(d.events), ...d, now: new Date() });
await confirmTarget({ url: env.url, schema: env.schema, argv: process.argv, extra: `model row: main ${params.input.main_periods} wl ${params.input.wl_periods} profile ${Object.keys(params.profile).length} json ${(JSON.stringify(params).length / 1024).toFixed(1)} kB` });
const db = createClient(env.url, env.key, { db: { schema: 'test' } });
const { error } = await db.from('sekai_border_model').upsert({ id: 1, trained_at: new Date().toISOString(), params }, { onConflict: 'id' }); if (error) { console.error(error.message); process.exit(1); }
console.log(JSON.stringify({ saved: true, profile: Object.keys(params.profile) }));
