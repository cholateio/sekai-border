// test/fixtures.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
const dir = new URL('./fixtures/', import.meta.url);
const fx = (n) => JSON.parse(readFileSync(new URL(n + '.json', dir), 'utf8'));
test('no player-identifying fields in any fixture', () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) assert.doesNotMatch(readFileSync(new URL(f, dir), 'utf8'), /"userId"|"userCard"|"userProfile"/, f);
});
test('event-level names and WL chapter data are preserved', () => {
    assert.ok(fx('live-top100').name.length > 0);
    assert.deepEqual(Object.keys(fx('live-top100').player_top_100_rankings[0]).sort(), ['rank', 'score']);
    assert.ok(fx('event-list').every((e) => typeof e.name === 'string' && e.name.length > 0));
    const chars179 = fx('final-border-179').userWorldBloomChapterRankingBorders.map((c) => c.gameCharacterId).sort();
    assert.deepEqual(fx('event-list').find((e) => e.id === 179).chapters.map((c) => c.character).sort(), chars179);
});
