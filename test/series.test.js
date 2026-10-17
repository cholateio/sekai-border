import test from 'node:test';
import assert from 'node:assert/strict';
import { floorHour, seriesLength, bucketIndex, buildSeries, SERIES_MAX_RANK } from '../src/forecast/series.js';
const T = (s) => new Date(s);
const snap = (rank, score, at) => ({ rank, score, taken_at: at });

test('floorHour / seriesLength: :59:59 end includes the last hour bucket, :00:00 end does not', () => {
    assert.equal(floorHour(T('2026-10-11T07:35:12Z')).toISOString(), '2026-10-11T07:00:00.000Z');
    assert.equal(seriesLength(T('2026-10-11T07:00:00Z'), T('2026-10-11T12:59:59Z')), 6);   // 07..12
    assert.equal(seriesLength(T('2026-10-11T07:00:00Z'), T('2026-10-11T13:00:00Z')), 6);   // 07..12, 13 excluded
    assert.equal(seriesLength(T('2026-10-11T07:30:00Z'), T('2026-10-11T09:00:00Z')), 2);   // 07 (from 07:30), 08
    assert.equal(bucketIndex(T('2026-10-11T08:55:00Z'), T('2026-10-11T07:00:00Z')), 1);
});
test('buildSeries: last snapshot per bucket, null gaps, rank without snapshots absent, rank > 1000 ignored', () => {
    const wStart = T('2026-10-11T07:00:00Z'), wEnd = T('2026-10-11T12:59:59Z');
    const rows = [snap(1, 10, '2026-10-11T07:05:00Z'), snap(1, 20, '2026-10-11T07:55:00Z'), snap(1, 30, '2026-10-11T09:00:00Z'), snap(1, 40, '2026-10-11T12:55:00Z'),
        snap(1000, 5, '2026-10-11T10:10:00Z'), snap(1500, 1, '2026-10-11T10:10:00Z'), snap(2, 7, '2026-10-11T13:00:00Z') /* outside window */];
    const s = buildSeries(rows, wStart, wEnd);
    assert.deepEqual([...s.keys()].sort((a, b) => a - b), [1, 1000]);
    assert.equal(s.get(1).start_at.toISOString(), '2026-10-11T07:00:00.000Z');
    assert.deepEqual(s.get(1).scores, [20, null, 30, null, null, 40]);
    assert.deepEqual(s.get(1000).scores, [null, null, null, 5, null, null]);
    assert.equal(SERIES_MAX_RANK, 1000);
});
test('buildSeries: unaligned window start keeps only snapshots at or after W_start in bucket 0', () => {
    const s = buildSeries([snap(1, 1, '2026-10-11T07:10:00Z'), snap(1, 2, '2026-10-11T07:40:00Z')], T('2026-10-11T07:30:00Z'), T('2026-10-11T09:00:00Z'));
    assert.deepEqual(s.get(1).scores, [2, null]);
});
test('buildSeries: snapshot exactly at W_end is excluded, at W_start included', () => {
    const s = buildSeries([snap(1, 1, '2026-10-11T07:00:00Z'), snap(1, 9, '2026-10-11T08:00:00Z')], T('2026-10-11T07:00:00Z'), T('2026-10-11T08:00:00Z'));
    assert.deepEqual(s.get(1).scores, [1]);
});
