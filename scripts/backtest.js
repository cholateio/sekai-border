// read-only: fits params from the DB inputs and prints the backtest summary (spec A10); writes nothing
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../src/env.js';
import { makeDb } from '../src/db.js';
import { loadTrainingInputs, fitParams } from '../src/forecast/train.js';
const env = loadEnv();
const db = makeDb(createClient(env.url, env.key, { db: { schema: env.schema } }));
const inputs = await loadTrainingInputs(db, undefined);
const p = await fitParams({ ...inputs, now: new Date() });
console.log(`inputs: main ${p.input.main_periods} wl ${p.input.wl_periods} finals ${p.input.prior_rows}; profile active: ${Object.keys(p.profile).join(' ') || '-'}`);
console.log('cell                 n     mae    q10     q90    cover');
for (const [k, v] of Object.entries(p.resid.cell).sort()) console.log(`${k.padEnd(20)} ${String(v.n).padStart(4)} ${v.mae.toFixed(3).padStart(7)} ${v.q10.toFixed(3).padStart(7)} ${v.q90.toFixed(3).padStart(7)} ${v.cover.toFixed(2).padStart(6)}`);
console.log('member sigma by group:'); for (const [k, v] of Object.entries(p.sigma.group).sort()) console.log(`  ${k.padEnd(10)} ${Object.entries(v).map(([m, x]) => `${m}=${x.s.toFixed(3)}(${x.n})`).join(' ')}`);
console.log('per period mae (latest 10):'); for (const [k, v] of Object.entries(p.periods).slice(-10)) console.log(`  ${k.padEnd(8)} ${v.mae.toFixed(3)} (${v.n})`);
console.log(`params size: ${(JSON.stringify(p).length / 1024).toFixed(1)} kB`);
