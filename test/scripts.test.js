import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readBackupRows, unionSnapshots } from '../scripts/lib/backup-csv.js';

test('readBackupRows parses the backup-event.mjs CSV and normalizes timestamps; wrong header rejected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bk-')); const f = join(dir, 'event-182-raw-x.csv.gz');
    writeFileSync(f, gzipSync('event_id,chapter,rank,score,taken_at,is_final\n182,0,1,100,2026-10-11T07:50:00+00:00,false\n182,0,1,999,2026-10-19T12:59:59+00:00,true\n'));
    assert.deepEqual(readBackupRows(f), [{ event_id: 182, chapter: 0, rank: 1, score: 100, taken_at: '2026-10-11T07:50:00.000Z', is_final: false }, { event_id: 182, chapter: 0, rank: 1, score: 999, taken_at: '2026-10-19T12:59:59.000Z', is_final: true }]);
    const bad = join(dir, 'bad.csv.gz'); writeFileSync(bad, gzipSync('a,b\n1,2\n')); assert.throws(() => readBackupRows(bad), /unexpected columns/);
});
test('unionSnapshots: DB wins on the same key, backup fills the rest', () => {
    const u = unionSnapshots([{ chapter: 0, rank: 1, score: 1, taken_at: '2026-10-11T07:50:00.000Z' }, { chapter: 0, rank: 1, score: 2, taken_at: '2026-10-11T07:55:00.000Z' }], [{ chapter: 0, rank: 1, score: 9, taken_at: '2026-10-11T07:55:00+00:00' }]);
    assert.deepEqual(u.map((r) => [r.taken_at, r.score]).sort(), [['2026-10-11T07:50:00.000Z', 1], ['2026-10-11T07:55:00.000Z', 9]]);
});
test('render-sql --set replaces extra tokens and refuses leftovers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-')); const f = join(dir, 'x.sql.tmpl'); writeFileSync(f, 'select {{schema}}.f(array[{{ids}}]::int[]);\n');
    assert.equal(execFileSync('node', ['scripts/render-sql.js', f, 'test', '--set', 'ids=1,2'], { encoding: 'utf8' }), 'select test.f(array[1,2]::int[]);\n');
    assert.equal(execFileSync('node', ['scripts/render-sql.js', f, 'test', '--set', 'ids='], { encoding: 'utf8' }), 'select test.f(array[]::int[]);\n');
    assert.throws(() => execFileSync('node', ['scripts/render-sql.js', f, 'test'], { encoding: 'utf8', stdio: 'pipe' }), /status 2|unreplaced/);
});
