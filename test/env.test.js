// test/env.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../src/env.js';
const jwt = (role) => 'h.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.s';
test('accepts a service_role JWT and defaults', () => { const e = loadEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: jwt('service_role') }); assert.equal(e.schema, 'public'); assert.equal(e.wlIngest, false); });
test('rejects anon role, missing vars, legacy SUPABASE_KEY; never leaks the key', () => {
    const k = jwt('anon');
    assert.throws(() => loadEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: k }), (e) => /role/.test(e.message) && !e.message.includes(k));
    assert.throws(() => loadEnv({ SUPABASE_URL: 'https://x.supabase.co' }), /SUPABASE_SERVICE_ROLE_KEY/);
    assert.throws(() => loadEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: jwt('service_role').split('.').slice(0, 2).join('.') }), /not a JWT/);
    assert.throws(() => loadEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_KEY: jwt('service_role') }), /SUPABASE_SERVICE_ROLE_KEY/);
});
