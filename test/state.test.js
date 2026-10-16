// test/state.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { slotOf, decide, classify, isEligibleForFinalize } from '../src/state.js';
const T = (s) => new Date(s);
const ev = (over = {}) => ({ id: 182, start_at: T('2026-10-11T07:00:00Z'), aggregate_at: T('2026-10-19T12:59:59Z'), ranking_announce_at: T('2026-10-19T13:09:59Z'), finalized_at: null, ...over });

test('slotOf floors to 5 minutes', () => {
    assert.equal(slotOf(T('2026-10-16T12:04:59.999Z')).toISOString(), '2026-10-16T12:00:00.000Z');
    assert.equal(slotOf(T('2026-10-16T12:05:00.000Z')).toISOString(), '2026-10-16T12:05:00.000Z');
});
test('classify boundaries', () => {
    assert.equal(classify(ev(), T('2026-10-15T00:00:00Z')), 'current');
    assert.equal(classify(ev(), T('2026-10-19T12:59:59Z')), 'frozen');
    assert.equal(classify(ev(), T('2026-10-19T13:24:58Z')), 'frozen');
    assert.equal(classify(ev(), T('2026-10-19T13:24:59Z')), 'due');
    assert.equal(classify(ev({ finalized_at: T('2026-10-19T14:00:00Z') }), T('2026-10-20T00:00:00Z')), 'stale-live');
});
test('isEligibleForFinalize', () => {
    assert.equal(isEligibleForFinalize(ev(), T('2026-10-19T13:24:58Z')), false);
    assert.equal(isEligibleForFinalize(ev(), T('2026-10-19T13:24:59Z')), true);
    assert.equal(isEligibleForFinalize(ev({ finalized_at: T('2026-10-19T14:00:00Z') }), T('2026-10-20T00:00:00Z')), false);
});
test('known x {current, frozen, due, stale-live}', () => {
    assert.deepEqual(decide({ live: ev(), known: ev(), startedLatest: ev(), now: T('2026-10-15T00:00:00Z'), preStart: false }), { ensure: 'none', branch: 'current' });
    assert.deepEqual(decide({ live: ev(), known: ev(), startedLatest: ev(), now: T('2026-10-19T13:00:00Z'), preStart: false }), { ensure: 'none', branch: 'frozen' });
    assert.deepEqual(decide({ live: ev(), known: ev(), startedLatest: ev(), now: T('2026-10-19T13:30:00Z'), preStart: false }), { ensure: 'none', branch: 'due' });
    const done = ev({ finalized_at: T('2026-10-19T14:00:00Z') });
    assert.deepEqual(decide({ live: ev(), known: done, startedLatest: done, now: T('2026-10-20T00:00:00Z'), preStart: false }), { ensure: 'none', branch: 'stale-live' });
});
test('new-event (incl. bootstrap) x {current, frozen, due}', () => {
    assert.deepEqual(decide({ live: ev(), known: null, startedLatest: null, now: T('2026-10-15T00:00:00Z'), preStart: false }), { ensure: 'insert', branch: 'current' });
    const prev = ev({ id: 181 });
    assert.deepEqual(decide({ live: ev(), known: null, startedLatest: prev, now: T('2026-10-19T13:00:00Z'), preStart: false }), { ensure: 'insert', branch: 'frozen' });
    assert.deepEqual(decide({ live: ev(), known: null, startedLatest: prev, now: T('2026-10-19T13:30:00Z'), preStart: false }), { ensure: 'insert', branch: 'due' });
});
test('pre-start inserts nothing; regress terminates', () => {
    assert.deepEqual(decide({ live: ev({ id: 183 }), known: null, startedLatest: ev(), now: T('2026-10-20T00:00:00Z'), preStart: true }), { ensure: 'pre-start', branch: 'pre-start' });
    assert.deepEqual(decide({ live: ev({ id: 180 }), known: null, startedLatest: ev(), now: T('2026-10-15T00:00:00Z'), preStart: false }), { ensure: 'regress', branch: null });
});
