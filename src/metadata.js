// src/metadata.js
// Repairs one event row per round from master db (spec §4.4). `cache` persists ETag + parsed events in-process.
// Master db rows are dereferenced field by field below; a malformed element must never reach the cache or the lookup.
const rowsOf = (a, keys) => Array.isArray(a) && a.every((x) => x !== null && typeof x === 'object' && keys.every((k) => Number.isInteger(x[k])));

export async function repairOne({ db, upstream, now, cache }) {
    const row = await db.loadMetadataCandidate(now);
    if (!row) return { repaired: null };
    const touch = async () => { await db.updateMetadata(row.id, { metadata_checked_at: now.toISOString() }); return { repaired: null }; };
    let events, ec, cards;
    try {
        // only a validated body is cached, and the ETag is sent only when there is a cached body a 304 can refer to
        const r = await upstream.master('events.json', rowsOf(cache.events, ['id']) ? cache.etag : undefined);
        if (r.status === 200 && rowsOf(r.body, ['id'])) { cache.etag = r.etag; cache.events = r.body; }
        events = r.status === 200 ? r.body : cache.events;
    } catch { return touch(); }
    if (!rowsOf(events, ['id'])) return touch();
    const m = events.find((e) => e.id === row.id);
    if (!m) {
        const miss = row.metadata_miss_count + 1;
        const old = now.getTime() - row.aggregate_at.getTime() >= 7 * 86400000;
        await db.updateMetadata(row.id, { metadata_miss_count: miss, metadata_checked_at: now.toISOString(), metadata_status: miss >= 3 && old ? 'missing' : (row.metadata_status === 'missing' ? 'missing' : 'pending') });
        return { repaired: null };
    }
    if (String(m.name ?? '').trim() !== String(row.name).trim()) { await db.updateMetadata(row.id, { metadata_status: 'mismatch', metadata_miss_count: 0, metadata_checked_at: now.toISOString(), event_type: null, unit: null, bonus_characters: [] }); return { repaired: null }; }
    try { ec = (await upstream.master('eventCards.json')).body; cards = (await upstream.master('cards.json')).body; } catch { return touch(); }
    if (!rowsOf(ec, ['eventId', 'cardId']) || !rowsOf(cards, ['id', 'characterId'])) return touch();
    const cardIds = new Set(ec.filter((x) => x.eventId === row.id).map((x) => x.cardId));
    const chars = [...new Set(cards.filter((c) => cardIds.has(c.id)).map((c) => c.characterId))].sort((a, b) => a - b);
    await db.updateMetadata(row.id, { event_type: m.eventType, unit: m.unit ?? null, bonus_characters: chars, metadata_status: 'complete', metadata_miss_count: 0, metadata_checked_at: now.toISOString() });
    return { repaired: row.id };
}
