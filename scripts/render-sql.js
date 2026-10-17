// usage: node scripts/render-sql.js <file.tmpl> <schema> [legacy_schema] [--set key=value ...]   ({{schema}} / {{legacy_schema}} / {{key}})
import { readFileSync } from 'node:fs';
const argv = process.argv.slice(2), sets = {}; const pos = [];
for (let i = 0; i < argv.length; i++) { if (argv[i] === '--set') { const [k, ...v] = String(argv[++i] ?? '').split('='); sets[k] = v.join('='); } else pos.push(argv[i]); }
const [file, schema, legacy = schema] = pos;
if (!file || !/^[a-z_]+$/.test(schema ?? '') || !/^[a-z_]+$/.test(legacy)) { console.error('usage: render-sql.js <file.tmpl> <schema> [legacy_schema] [--set key=value]'); process.exit(2); }
let out = readFileSync(file, 'utf8').replaceAll('{{schema}}', schema).replaceAll('{{legacy_schema}}', legacy);
for (const [k, v] of Object.entries(sets)) { if (!/^[a-z_]+$/.test(k) || !/^[0-9,\s]*$/.test(v)) { console.error(`--set ${k}: key must be [a-z_], value must be digits/commas`); process.exit(2); } out = out.replaceAll(`{{${k}}}`, v); }
const left = out.match(/\{\{[a-z_]+\}\}/g); if (left) { console.error(`unreplaced tokens: ${[...new Set(left)].join(' ')}`); process.exit(2); }
process.stdout.write(out);
