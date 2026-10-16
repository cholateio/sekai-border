// src/run.js
// One scheduler round (spec §4). Pure decisions come from state.js; effects go through db/upstream.
import { validateLive, validateEventListEntry, chaptersFromList } from './validate.js';
import { decide, slotOf } from './state.js';
import { finalizePending } from './finalize.js';
import { repairOne } from './metadata.js';
import { log } from './log.js';
const metaCache = { etag: null, events: null };

export async function runOnce({ db, upstream, now = new Date(), wlIngest = false, cache = metaCache }) {
    const slot = slotOf(now);
    const partial = { inserted: 0, finalized: [], finalize_deferred: [], finalize_failed: [] };
    const error = (phase, code, event_id = null) => ({ status: 500, body: { slot: slot.toISOString(), branch: 'error', phase, error_code: code, event_id, partial } });
    let live, rows;
    try { const { top100, border } = await upstream.live(); ({ event: live, rows } = validateLive(top100, border, { wlIngest })); }
    catch (e) { log('error', 'live failed', { phase: e.phase, code: e.code, ...(e.detail ?? {}) }); return error(e.phase ?? 'fetch', e.code ?? 'unknown'); }

    let known, startedLatest, listEntry = null, chapters = [];
    try { known = await db.loadKnown(live.id); startedLatest = await db.loadStartedLatest(now); } catch (e) { return error('db-read', e.message, live.id); }
    let preStart = false;
    if (!known && !(startedLatest && live.id < startedLatest.id)) {
        try { listEntry = validateEventListEntry(await upstream.eventList(), live.id, live); chapters = chaptersFromList(listEntry); } catch (e) { log('error', 'event list failed', { phase: e.phase, code: e.code }); return error(e.phase ?? 'event-list', e.code ?? 'unknown', live.id); }
        preStart = new Date(listEntry.start_at) > now;
    }
    const d = decide({ live, known, startedLatest, now, preStart });
    if (d.ensure === 'regress') { log('error', 'regress', { live_id: live.id, latest_id: startedLatest?.id }); return error('regress', 'live_id_below_latest', live.id); }
    if (d.ensure === 'insert') {
        if (!String(listEntry.name ?? '').trim()) return error('event-list', 'name_empty', live.id);
        try { await db.insertEvent({ id: live.id, name: String(listEntry.name).trim(), start_at: live.start_at.toISOString(), aggregate_at: live.aggregate_at.toISOString(), ranking_announce_at: live.ranking_announce_at.toISOString(), chapters, metadata_status: 'pending' }); } catch (e) { return error('event-write', e.message, live.id); }
    }
    if (d.branch === 'current') { try { partial.inserted = await db.insertSnapshot(rows.map((r) => ({ event_id: live.id, ...r })), slot); } catch (e) { return error('snapshot-write', e.message, live.id); } }

    let fin; try { fin = await finalizePending({ db, upstream, now }); } catch (e) { return error('finalize-scan', e.message, live.id); }
    Object.assign(partial, { finalized: fin.finalized, finalize_deferred: fin.deferred, finalize_failed: fin.failed });
    let repaired = null; try { ({ repaired } = await repairOne({ db, upstream, now, cache })); } catch (e) { return error('metadata', e.message, live.id); }

    const body = { slot: slot.toISOString(), event_id: live.id, branch: d.branch, inserted: partial.inserted, finalized: fin.finalized, finalize_deferred: fin.deferred, finalize_failed: fin.failed, metadata_repaired: repaired };
    log(fin.failed.length ? 'error' : 'info', 'round', body);
    return { status: fin.failed.length ? 500 : 200, body };
}
