// src/fetch.js
import { UpstreamError } from './errors.js';
const BASE = 'https://api.hisekai.org/tw';
const MASTER = 'https://raw.githubusercontent.com/Sekai-World/sekai-master-db-tc-diff/main/';

// All upstream HTTP goes through one gate so a backfill can enforce >= minIntervalMs between EVERY request.
export function makeUpstream({ fetchImpl = globalThis.fetch, userAgent = 'sekai-border', minIntervalMs = 0, timeoutMs = 10000 } = {}) {
    let last = 0; let chain = Promise.resolve();
    const gate = () => (chain = chain.then(async () => { const wait = last + minIntervalMs - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); last = Date.now(); }));
    async function getJson(url, extraHeaders = {}) {
        await gate();
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            let res;
            try { res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json', ...extraHeaders }, signal: ctrl.signal }); }
            catch (e) { throw new UpstreamError('fetch', e.name === 'AbortError' ? 'timeout' : 'network', { url }); }
            if (res.status === 304) return { status: 304, etag: res.headers.get('etag'), body: null };
            if (!res.ok) throw new UpstreamError('fetch', `http_${res.status}`, { url });
            // Body parsing races the same timer: a stalled body must not hang the round.
            const body = await Promise.race([res.json().catch(() => { throw new UpstreamError('fetch', 'json', { url }); }), new Promise((_, rej) => ctrl.signal.addEventListener('abort', () => rej(new UpstreamError('fetch', 'timeout', { url }))))]);
            return { status: 200, etag: res.headers.get('etag'), body };
        } finally { clearTimeout(t); }
    }
    return {
        async live() { const [t, b] = await Promise.all([getJson(`${BASE}/event/live/top100`), getJson(`${BASE}/event/live/border`)]); return { top100: t.body, border: b.body }; }, // parallel (spec §4.1); the gate still spaces them when minIntervalMs > 0
        async eventList() { return (await getJson(`${BASE}/event/list`)).body; },
        async finals(id) { const b = await getJson(`${BASE}/event/${id}/border`); const t = await getJson(`${BASE}/event/${id}/top100`); return { border: b.body, top100: t.body }; },
        async master(name, etag) { return getJson(MASTER + name, etag ? { 'If-None-Match': etag } : {}); },
    };
}
