// src/server.js
import http from 'node:http';
// headersSent guard: the error path must never throw a second time (LESSONS 2026-07-28).
export function sendJson(res, status, body) { if (res.headersSent) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
export function createServer({ handler }) {
    return http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/run') return sendJson(res, 404, { error: 'not_found' });
        try { const { status, body } = await handler(); sendJson(res, status, body); }
        catch (e) { console.error(JSON.stringify({ severity: 'ERROR', msg: 'unhandled', error: String(e?.message) })); sendJson(res, 500, { branch: 'error', phase: 'unhandled', error_code: 'unhandled' }); }
    });
}
