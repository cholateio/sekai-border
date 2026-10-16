// scripts/record-fixtures.js
// Records upstream responses for unit tests. Player-identifying fields are stripped ONLY inside player-ranking
// arrays; event-level fields (event name, chapter data) are preserved (spec §1 non-goals, §5.3).
import { writeFile, mkdir } from 'node:fs/promises';

const OUT = new URL('../test/fixtures/', import.meta.url);
const UA = process.env.BOT_CONTACT || 'sekai-border-fixture-recorder';
const PLAYER_ARRAYS = /^(player_top_100_rankings|player_border_rankings|world_link_top_100_rankings|world_link_border_rankings|rankings|borderRankings)$/;
const PLAYER_KEEP = new Set(['rank', 'score']);

function strip(value, inPlayers = false) {
    if (Array.isArray(value)) return value.map((v) => strip(v, inPlayers));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .filter(([k]) => !inPlayers || PLAYER_KEEP.has(k))
            .map(([k, v]) => [k, strip(v, inPlayers || PLAYER_ARRAYS.test(k))]));
    }
    return value;
}

async function get(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_EVENT_ID = 202;

const jobs = [
    ['live-top100.json', 'https://api.hisekai.org/tw/event/live/top100'],
    ['live-border.json', 'https://api.hisekai.org/tw/event/live/border'],
    ['event-list.json', 'https://api.hisekai.org/tw/event/list'],
    ['final-border-181.json', 'https://api.hisekai.org/tw/event/181/border'],
    ['final-top100-181.json', 'https://api.hisekai.org/tw/event/181/top100'],
    ['final-border-179.json', 'https://api.hisekai.org/tw/event/179/border'],
    ['final-top100-179.json', 'https://api.hisekai.org/tw/event/179/top100'],
];
await mkdir(OUT, { recursive: true });
for (const [file, url] of jobs) {
    await writeFile(new URL(file, OUT), JSON.stringify(strip(await get(url)), null, 1));
    console.log('recorded', file);
    await sleep(1000);
}
const MASTER = 'https://raw.githubusercontent.com/Sekai-World/sekai-master-db-tc-diff/main/';
const events = (await get(MASTER + 'events.json')).filter((e) => e.id <= MAX_EVENT_ID).map(({ id, eventType, name, unit, startAt, aggregateAt }) => ({ id, eventType, name, unit, startAt, aggregateAt }));
await writeFile(new URL('master-events.json', OUT), JSON.stringify(events));
const eventCards = (await get(MASTER + 'eventCards.json')).filter((c) => c.eventId <= MAX_EVENT_ID).map(({ eventId, cardId }) => ({ eventId, cardId }));
await writeFile(new URL('master-eventCards.json', OUT), JSON.stringify(eventCards));
const needed = new Set(eventCards.map((c) => c.cardId));
const cards = (await get(MASTER + 'cards.json')).filter((c) => needed.has(c.id)).map(({ id, characterId }) => ({ id, characterId }));
await writeFile(new URL('master-cards.json', OUT), JSON.stringify(cards));
console.log('recorded master data', { events: events.length, eventCards: eventCards.length, cards: cards.length });
