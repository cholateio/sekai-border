// src/metadata.js
// Repairs one event row per round from master db (spec §4.4). `cache` persists ETag + parsed events in-process.
export async function repairOne({ db, upstream, now, cache }) {
    const row = await db.loadMetadataCandidate(now);
    if (!row) return { repaired: null };
    const touch = async () => { await db.updateMetadata(row.id, { metadata_checked_at: now.toISOString() }); return { repaired: null }; };
    let events, ec, cards;
    try {
        const r = await upstream.master('events.json', cache.etag);
        if (r.status === 200) { cache.etag = r.etag; cache.events = r.body; }
        events = cache.events;
    } catch { return touch(); }
    const m = events.find((e) => e.id === row.id);
    if (!m) {
        const miss = row.metadata_miss_count + 1;
        const old = now.getTime() - row.aggregate_at.getTime() >= 7 * 86400000;
        await db.updateMetadata(row.id, { metadata_miss_count: miss, metadata_checked_at: now.toISOString(), metadata_status: miss >= 3 && old ? 'missing' : (row.metadata_status === 'missing' ? 'missing' : 'pending') });
        return { repaired: null };
    }
    if (String(m.name ?? '').trim() !== String(row.name).trim()) { await db.updateMetadata(row.id, { metadata_status: 'mismatch', metadata_miss_count: 0, metadata_checked_at: now.toISOString(), event_type: null, unit: null, bonus_characters: [] }); return { repaired: null }; }
    try { ec = (await upstream.master('eventCards.json')).body; cards = (await upstream.master('cards.json')).body; } catch { return touch(); }
    const cardIds = new Set(ec.filter((x) => x.eventId === row.id).map((x) => x.cardId));
    const chars = [...new Set(cards.filter((c) => cardIds.has(c.id)).map((c) => c.characterId))].sort((a, b) => a - b);
    await db.updateMetadata(row.id, { event_type: m.eventType, unit: m.unit ?? null, bonus_characters: chars, metadata_status: 'complete', metadata_miss_count: 0, metadata_checked_at: now.toISOString() });
    return { repaired: row.id };
}
