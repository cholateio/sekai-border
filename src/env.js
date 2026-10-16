// src/env.js
export function loadEnv(env = process.env) {
    for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) if (!env[k]) throw new Error(`env: ${k} is required`);
    const parts = env.SUPABASE_SERVICE_ROLE_KEY.split('.');
    let role; try { if (parts.length !== 3 || parts.some((p) => !p)) throw new Error(); role = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role; } catch { throw new Error('env: SUPABASE_SERVICE_ROLE_KEY is not a JWT'); }
    if (role !== 'service_role') throw new Error('env: SUPABASE_SERVICE_ROLE_KEY role must be service_role');
    return { url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, schema: env.SUPABASE_SCHEMA || 'public', botContact: env.BOT_CONTACT || 'sekai-border', wlIngest: env.WL_INGEST === 'on' };
}
