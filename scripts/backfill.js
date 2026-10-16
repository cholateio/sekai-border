// scripts/backfill.js
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../src/env.js';
import { makeDb } from '../src/db.js';
import { makeUpstream } from '../src/fetch.js';
import { validateFinal, chaptersFromList } from '../src/validate.js';
import { ANNOUNCE_GRACE_MS } from '../src/constants.js';
import { attributesFrom } from '../src/metadata.js';
import { confirmTarget } from './confirm.js';
const arg = (k, d) => { const i = process.argv.indexOf(k); if (i < 0) return d; const v = Number(process.argv[i + 1]); if (!Number.isInteger(v) || v < 1) { console.error(`${k} must be a positive integer`); process.exit(2); } return v; };

// Derives master-db attributes for one list entry (same rules as src/metadata.js, applied against the known row).
function attributes(e, master, known, now) {
    const checked = now.toISOString();
    const m = master.events.find((x) => x.id === e.id);
    if (!m) {
        const miss = (known?.metadata_miss_count ?? 0) + 1;
        const old = now.getTime() - new Date(e.aggregate_at).getTime() >= 7 * 86400000;
        return { metadata_status: miss >= 3 && old ? 'missing' : 'pending', metadata_miss_count: miss, metadata_checked_at: checked };
    }
    if (String(m.name ?? '').trim() !== String(e.name).trim()) return { metadata_status: 'mismatch', metadata_miss_count: 0, metadata_checked_at: checked, event_type: null, unit: null, bonus_characters: [] };
    const a = attributesFrom(m, master.eventCards, master.cards);
    return a ? { ...a, metadata_status: 'complete', metadata_miss_count: 0, metadata_checked_at: checked } : { metadata_status: 'pending', metadata_checked_at: checked };
}

export async function backfill({ db, upstream, now = new Date(), from = 1, to = 999999, log = console.log }) {
    const list = await upstream.eventList();
    const master = { events: (await upstream.master('events.json')).body, eventCards: (await upstream.master('eventCards.json')).body, cards: (await upstream.master('cards.json')).body };
    const done = [];
    for (const e of list.filter((x) => x.id >= from && x.id <= to && new Date(x.ranking_announce_at).getTime() + ANNOUNCE_GRACE_MS < now.getTime()).sort((a, b) => a.id - b.id)) {
        const known = await db.loadKnown(e.id);
        if (known?.finalized_at) { done.push({ id: e.id, action: 'skipped' }); log(JSON.stringify(done.at(-1))); continue; }
        try {
            const chapters = chaptersFromList(e);
            try { await db.upsertEvent({ id: e.id, name: e.name, start_at: e.start_at, aggregate_at: e.aggregate_at, ranking_announce_at: e.ranking_announce_at, chapters, ...attributes(e, master, known, now) }); }
            catch (err) {
                // the online crawler finalized it after loadKnown: the DB guard rejected the upsert, and the event is done
                if (!(await db.loadKnown(e.id))?.finalized_at) throw err;
                done.push({ id: e.id, action: 'skipped' }); log(JSON.stringify(done.at(-1))); continue;
            }
            const { border, top100 } = await upstream.finals(e.id);
            const { rows, deferred } = validateFinal(e.id, border, top100, chapters);
            if (deferred) done.push({ id: e.id, action: 'deferred' }); else { await db.finalize(e.id, rows); done.push({ id: e.id, action: 'finalized' }); }
        } catch (err) { done.push({ id: e.id, action: 'failed', reason: `${err.phase ?? 'db'}:${err.code ?? err.message}` }); }
        log(JSON.stringify(done.at(-1)));
    }
    return done;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const from = arg('--from', 1), to = arg('--to', 999999);
    if (from > to) { console.error('--from must be <= --to'); process.exit(2); }
    const env = loadEnv();
    await confirmTarget({ url: env.url, schema: env.schema, argv: process.argv, extra: `range=${from}..${to}` });
    const db = makeDb(createClient(env.url, env.key, { db: { schema: env.schema } }));
    const res = await backfill({ db, upstream: makeUpstream({ userAgent: env.botContact, minIntervalMs: 1000 }), from, to });
    const summary = res.reduce((m, r) => ((m[r.action] = (m[r.action] || 0) + 1), m), {});
    console.log(JSON.stringify({ summary, failed: res.filter((r) => r.action === 'failed'), deferred: res.filter((r) => r.action === 'deferred') }));
    process.exit(summary.failed || summary.deferred ? 1 : 0);
}
