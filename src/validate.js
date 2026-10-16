// src/validate.js
import { createHash } from 'node:crypto';
import { ALLOWED_RANKS, TOP_TARGET, BORDER_TARGET, FINAL_OPTIONAL } from './constants.js';
import { UpstreamError } from './errors.js';

const ALLOWED = new Set(ALLOWED_RANKS);
const NONE = new Set();

export function safeDetail(payload) {
    const out = { sha256: createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex') };
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        for (const [k, v] of Object.entries(payload)) out[k] = Array.isArray(v) ? `array[${v.length}]` : typeof v;
    }
    return out;
}
const fail = (phase, code, payload) => new UpstreamError(phase, code, safeDetail(payload));

function eventHeader(p) {
    if (!Number.isInteger(p?.id) || p.id <= 0) throw fail('validate', 'event_id', p);
    const d = (v) => { const x = new Date(v); if (Number.isNaN(x.getTime())) throw fail('validate', 'event_time', p); return x; };
    const start_at = d(p.start_at), aggregate_at = d(p.aggregate_at), ranking_announce_at = d(p.ranking_announce_at);
    if (!(start_at < aggregate_at) || !(aggregate_at <= ranking_announce_at)) throw fail('validate', 'event_time', p);
    return { id: p.id, name: String(p.name ?? ''), start_at, aggregate_at, ranking_announce_at };
}

function pick(list, target, payload) {
    if (!Array.isArray(list)) throw fail('validate', 'shape', payload);
    return list.filter((r) => target.has(r?.rank)).map((r) => ({ rank: r.rank, score: r.score }));
}

// Every allowed rank except `optional` present, no duplicates, non-negative integer scores, scores non-increasing with rank.
function checkRows(rows, payload, optional = NONE) {
    const seen = new Set();
    for (const r of rows) {
        if (!Number.isInteger(r.rank) || !ALLOWED.has(r.rank) || seen.has(r.rank)) throw fail('validate', 'rank_set', payload);
        if (!Number.isInteger(r.score) || r.score < 0) throw fail('validate', 'score', payload);
        seen.add(r.rank);
    }
    for (const r of ALLOWED) if (!optional.has(r) && !seen.has(r)) throw fail('validate', 'rank_set', payload);
    const sorted = [...rows].sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].score > sorted[i - 1].score) throw fail('validate', 'score_order', payload);
    return sorted.map(({ rank, score }) => ({ rank, score }));
}

export function validateLive(top100, border, { wlIngest = false } = {}) {
    const a = eventHeader(top100), b = eventHeader(border);
    const payload = { top100: safeDetail(top100), border: safeDetail(border) };
    if (a.id !== b.id || a.aggregate_at.getTime() !== b.aggregate_at.getTime() || a.ranking_announce_at.getTime() !== b.ranking_announce_at.getTime()) throw new UpstreamError('validate', 'event_mismatch', payload);
    const rows = checkRows([...pick(top100.player_top_100_rankings, TOP_TARGET, top100), ...pick(border.player_border_rankings, BORDER_TARGET, border)], payload);
    void wlIngest; // live WL payload shape is unverified until the next WL event (spec §5.4)
    return { event: a, rows: rows.map((r) => ({ chapter: 0, ...r })) };
}

// One WL array (border or top100 chapters): bijection against declared chapters; deferred while upstream has not filled it.
function chapterRows(entries, key, target, id, chapters, payload) {
    if (!Array.isArray(entries)) throw fail('validate', 'shape', payload);
    if (entries.length === 0) return { out: [], deferred: true };
    const byChar = new Map();
    for (const c of entries) {
        if (c?.eventId !== id) throw new UpstreamError('validate', 'event_mismatch', payload);
        if (byChar.has(c.gameCharacterId)) throw new UpstreamError('validate', 'wl_chapters', payload);
        byChar.set(c.gameCharacterId, c);
    }
    if (byChar.size !== chapters.length) throw new UpstreamError('validate', 'wl_chapters', payload);
    const out = [];
    for (const ch of chapters) {
        const c = byChar.get(ch.character_id);
        if (!c) throw new UpstreamError('validate', 'wl_chapters', payload);
        out.push({ chapter: ch.chapter, rows: pick(c[key], target, payload) });
    }
    return { out, deferred: false };
}

export function validateFinal(id, border, top100, chapters = []) {
    if (border?.eventId !== id) throw fail('validate', 'event_mismatch', border);
    // Upstream aggregate flags are false for every event (probed 2026-10-16); readiness is time-gated by the caller.
    if (border.borderRankings?.length === 0 || top100?.rankings?.length === 0) return { rows: [], deferred: true };
    const payload = { border: safeDetail(border), top100: safeDetail(top100) };
    const rows = checkRows([...pick(top100?.rankings, TOP_TARGET, top100), ...pick(border.borderRankings, BORDER_TARGET, border)], payload, FINAL_OPTIONAL).map((r) => ({ chapter: 0, ...r }));
    if (chapters.length > 0) {
        const b = chapterRows(border.userWorldBloomChapterRankingBorders, 'borderRankings', BORDER_TARGET, id, chapters, payload);
        const t = chapterRows(top100.userWorldBloomChapterRankings, 'rankings', TOP_TARGET, id, chapters, payload);
        if (b.deferred || t.deferred) return { rows: [], deferred: true };
        for (const ch of chapters) {
            const br = b.out.find((x) => x.chapter === ch.chapter).rows, tr = t.out.find((x) => x.chapter === ch.chapter).rows;
            rows.push(...checkRows([...tr, ...br], payload, FINAL_OPTIONAL).map((r) => ({ chapter: ch.chapter, ...r })));
        }
    }
    return { rows, deferred: false };
}

export function validateEventListEntry(list, id, live) {
    if (!Array.isArray(list)) throw new UpstreamError('event-list', 'shape', safeDetail(list));
    const matches = list.filter((e) => e?.id === id);
    if (matches.length !== 1) throw new UpstreamError('event-list', 'not_unique', { id, matches: matches.length });
    const e = matches[0];
    const same = (x, y) => new Date(x).getTime() === y.getTime();
    if (!same(e.start_at, live.start_at) || !same(e.aggregate_at, live.aggregate_at) || !same(e.ranking_announce_at, live.ranking_announce_at)) throw new UpstreamError('event-list', 'time_mismatch', { id });
    return e;
}
