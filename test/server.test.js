// test/server.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
async function withServer(handler, fn) { const srv = createServer({ handler }); await new Promise((r) => srv.listen(0, r)); try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { await new Promise((r) => srv.close(r)); } }
test('POST /run relays handler status/body', async () => { await withServer(async () => ({ status: 200, body: { ok: 1 } }), async (b) => { const r = await fetch(b + '/run', { method: 'POST' }); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: 1 }); }); });
test('other routes 404 without calling the handler', async () => { let calls = 0; await withServer(async () => { calls++; return { status: 200, body: {} }; }, async (b) => { for (const [m, p] of [['GET', '/'], ['POST', '/'], ['GET', '/run']]) assert.equal((await fetch(b + p, { method: m })).status, 404); }); assert.equal(calls, 0); });
test('handler throw -> 500 unhandled', async () => { await withServer(async () => { throw new Error('boom'); }, async (b) => { const r = await fetch(b + '/run', { method: 'POST' }); assert.equal(r.status, 500); assert.equal((await r.json()).phase, 'unhandled'); }); });
