// src/finalize.js
import { validateFinal } from './validate.js';
import { isEligibleForFinalize } from './state.js';
import { log } from './log.js';
const STALE_DEFER_MS = 24 * 3600 * 1000;
// Tries every eligible event independently (spec §4.2 step 3).
export async function finalizePending({ db, upstream, now }) {
    const out = { finalized: [], deferred: [], failed: [] };
    const eligible = (await db.loadEligible(now)).filter((e) => isEligibleForFinalize(e, now));
    for (const e of eligible) {
        try {
            const { border, top100 } = await upstream.finals(e.id);
            const { rows, deferred } = validateFinal(e.id, border, top100, e.chapters ?? []);
            if (deferred) {
                out.deferred.push({ id: e.id, reason: 'not_published' });
                log(now.getTime() - e.ranking_announce_at.getTime() > STALE_DEFER_MS ? 'error' : 'info', 'finalize deferred', { event_id: e.id });
                continue;
            }
            const r = await db.finalize(e.id, rows); out.finalized.push(e.id); log('info', 'finalized', { event_id: e.id, ...r });
        } catch (err) {
            out.failed.push({ id: e.id, reason: `${err.phase ?? 'finalize'}:${err.code ?? err.message}` });
            log('error', 'finalize failed', { event_id: e.id, phase: err.phase ?? 'finalize', code: err.code ?? err.message, ...(err.detail ?? {}) });
        }
    }
    return out;
}
