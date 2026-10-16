// src/env.js
export function loadEnv(env = process.env) {
    for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) if (!env[k]) throw new Error(`env: ${k} is required`);
    let role; try { role = JSON.parse(Buffer.from(env.SUPABASE_SERVICE_ROLE_KEY.split('.')[1], 'base64url').toString('utf8')).role; } catch { throw new Error('env: SUPABASE_SERVICE_ROLE_KEY is not a JWT'); }
    if (role !== 'service_role') throw new Error('env: SUPABASE_SERVICE_ROLE_KEY role must be service_role');
    return { url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, schema: env.SUPABASE_SCHEMA || 'public', botContact: env.BOT_CONTACT || 'sekai-border', wlIngest: env.WL_INGEST === 'on' };
}
