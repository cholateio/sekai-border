// test/integration/helpers.js
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
export const SCHEMA = process.env.SUPABASE_SCHEMA;
if (SCHEMA !== 'test') { console.error('integration tests run only with SUPABASE_SCHEMA=test'); process.exit(2); }
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY']) if (!process.env[k]) { console.error(`missing ${k}`); process.exit(2); }
export const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: SCHEMA } });
export const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { db: { schema: SCHEMA } });
export async function truncate() {
    for (const [t, c] of [['sekai_border_rankings', 'event_id'], ['sekai_border_events', 'id']]) { const { error } = await admin.from(t).delete().gte(c, 0); if (error) throw new Error(error.message); }
}
export async function insertEvent(over = {}) {
    const row = { id: 182, name: '與你相繫的Heart Beat', start_at: '2026-10-11T07:00:00Z', aggregate_at: '2026-10-19T12:59:59Z', ranking_announce_at: '2026-10-19T13:09:59Z', ...over };
    const { error } = await admin.from('sekai_border_events').insert(row); if (error) throw new Error(error.message); return row;
}
