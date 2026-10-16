// src/db.js
// The only module that talks to supabase-js. Every method throws DbError(phase) on {error}.
import { DbError } from './errors.js';
const toDates = (e) => e && ({ ...e, start_at: new Date(e.start_at), aggregate_at: new Date(e.aggregate_at), ranking_announce_at: new Date(e.ranking_announce_at), finalized_at: e.finalized_at ? new Date(e.finalized_at) : null, metadata_checked_at: e.metadata_checked_at ? new Date(e.metadata_checked_at) : null });
const chk = (phase, { error, data }) => { if (error) throw new DbError(phase, error.message); return data; };

export function makeDb(client) {
    const ev = () => client.from('sekai_border_events'); const rk = () => client.from('sekai_border_rankings');
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
    };
}
