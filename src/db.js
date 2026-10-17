// src/db.js
// The only module that talks to supabase-js. Every method throws DbError(phase) on {error}.
import { DbError } from './errors.js';
const toDates = (e) => e && ({ ...e, start_at: new Date(e.start_at), aggregate_at: new Date(e.aggregate_at), ranking_announce_at: new Date(e.ranking_announce_at), finalized_at: e.finalized_at ? new Date(e.finalized_at) : null, metadata_checked_at: e.metadata_checked_at ? new Date(e.metadata_checked_at) : null });
const chk = (phase, { error, data }) => { if (error) throw new DbError(phase, error.message); return data; };

export function makeDb(client) {
    const ev = () => client.from('sekai_border_events'); const rk = () => client.from('sekai_border_rankings');
    const sig = (q, signal) => (signal ? q.abortSignal(signal) : q);
    // PostgREST caps a response at 1000 rows: page by range() until a short page
    const pageAll = async (phase, mk, signal) => { const out = []; for (let from = 0; ; from += 1000) { const d = chk(phase, await sig(mk().range(from, from + 999), signal)); out.push(...d); if (d.length < 1000) break; } return out; };
    return {
        async loadKnown(id) { return toDates(chk('db-read', await ev().select('*').eq('id', id).maybeSingle())); },
        async loadStartedLatest(now) { return toDates(chk('db-read', await ev().select('*').lte('start_at', now.toISOString()).order('id', { ascending: false }).limit(1).maybeSingle())); },
        async loadEligible(now) { const cutoff = new Date(now.getTime() - 15 * 60000).toISOString(); return chk('finalize-scan', await ev().select('*').is('finalized_at', null).lte('ranking_announce_at', cutoff).order('id')).map(toDates); },
        // two Scheduler rounds may both see a new event as unknown; the loser's insert is a no-op, not an error
        async insertEvent(row) { chk('event-write', await ev().upsert(row, { onConflict: 'id', ignoreDuplicates: true })); },
        async upsertEvent(row) { chk('event-write', await ev().upsert(row, { onConflict: 'id' })); },
        // PostgREST returns only the rows this statement actually inserted when ON CONFLICT DO NOTHING skips the rest.
        async insertSnapshot(rows, slot) { const data = chk('snapshot-write', await rk().upsert(rows.map((r) => ({ ...r, taken_at: slot.toISOString(), is_final: false })), { onConflict: 'event_id,chapter,rank,taken_at,is_final', ignoreDuplicates: true }).select('rank')); return data.length; },
        async finalize(id, finals) { return chk('finalize', await client.rpc('sekai_border_finalize', { p_event_id: id, p_finals: finals })); },
        async loadMetadataCandidate(now) {
            const h6 = new Date(now.getTime() - 6 * 3600000).toISOString(), d30 = new Date(now.getTime() - 30 * 86400000).toISOString();
            return toDates(chk('metadata', await ev().select('*').or(`and(metadata_status.eq.pending,or(metadata_checked_at.is.null,metadata_checked_at.lt.${h6})),and(metadata_status.in.(missing,mismatch),metadata_checked_at.lt.${d30})`).order('id').limit(1).maybeSingle()));
        },
        async updateMetadata(id, patch) { chk('metadata', await ev().update(patch).eq('id', id)); },
        async loadSlots(eventId, slots, signal) { return chk('forecast-read', await sig(rk().select('chapter,rank,score,taken_at').eq('event_id', eventId).eq('is_final', false).in('taken_at', slots.map((s) => s.toISOString())), signal)); },
        async loadModel(signal) { return chk('forecast-read', await sig(client.from('sekai_border_model').select('trained_at,params').eq('id', 1).maybeSingle(), signal)); },
        // Monotonic on trained_at: a slower training round must not overwrite a newer model. update-if-older, insert-if-absent,
        // then one more update covers the row appearing between the two statements. Returns false when the row is newer.
        async saveModel(params, trainedAt, signal) {
            const at = trainedAt.toISOString(), row = { id: 1, trained_at: at, params };
            const upd = () => sig(client.from('sekai_border_model').update(row).eq('id', 1).lt('trained_at', at).select('id'), signal);
            if (chk('train-write', await upd()).length) return true;
            if (chk('train-write', await sig(client.from('sekai_border_model').upsert(row, { onConflict: 'id', ignoreDuplicates: true }).select('id'), signal)).length) return true;
            return chk('train-write', await upd()).length > 0;
        },
        async putForecasts(eventId, computedAt, rows, signal) { return chk('forecast-write', await sig(client.rpc('sekai_border_put_forecasts', { p_event_id: eventId, p_computed_at: computedAt.toISOString(), p_rows: rows }), signal)); },
        async putSeries(eventId, rows) { return chk('series-write', await client.rpc('sekai_border_put_series', { p_event_id: eventId, p_rows: rows })); },
        async loadFinalizedEvents(signal) { return (await pageAll('train-read', () => ev().select('*').not('finalized_at', 'is', null).order('start_at').order('id'), signal)).map(toDates); },
        async loadFinals(signal) { return pageAll('train-read', () => rk().select('event_id,chapter,rank,score').eq('is_final', true).order('event_id').order('chapter').order('rank'), signal); },
        async loadSeries(ids, signal) { return ids.length ? pageAll('train-read', () => client.from('sekai_border_series').select('event_id,chapter,rank,start_at,scores').in('event_id', ids).order('event_id').order('chapter').order('rank'), signal) : []; },
        async loadCompacted(ids, signal) { return ids.length ? pageAll('train-read', () => rk().select('event_id,chapter,rank,score,taken_at').in('event_id', ids).eq('is_final', false).gt('rank', 1000).order('event_id').order('chapter').order('rank').order('taken_at'), signal) : []; },
        async loadEventSnapshots(eventId, signal) { return pageAll('series-read', () => rk().select('chapter,rank,score,taken_at').eq('event_id', eventId).eq('is_final', false).order('taken_at').order('chapter').order('rank'), signal); },
    };
}
