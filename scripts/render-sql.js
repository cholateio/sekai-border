// scripts/render-sql.js
// usage: node scripts/render-sql.js <file.tmpl> <schema> [legacy_schema]   ({{schema}} / {{legacy_schema}})
import { readFileSync } from 'node:fs';
const [file, schema, legacy = schema] = process.argv.slice(2);
if (!file || !/^[a-z_]+$/.test(schema ?? '') || !/^[a-z_]+$/.test(legacy)) { console.error('usage: render-sql.js <file.tmpl> <schema> [legacy_schema]'); process.exit(2); }
process.stdout.write(readFileSync(file, 'utf8').replaceAll('{{schema}}', schema).replaceAll('{{legacy_schema}}', legacy));
