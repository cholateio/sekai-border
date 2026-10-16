// scripts/confirm.js
import { createInterface } from 'node:readline/promises';
export async function confirmTarget({ url, schema, argv, extra = '' }) {
    console.log(`target supabase ref=${new URL(url).hostname.split('.')[0]} schema=${schema} ${extra}`);
    if (argv.includes('--yes')) return;
    const rl = createInterface({ input: process.stdin, output: process.stdout }); const a = await rl.question('type yes to continue: '); rl.close();
    if (a.trim() !== 'yes') { console.log('aborted'); process.exit(1); }
}
