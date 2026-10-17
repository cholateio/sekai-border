import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// 2026-10-17 receipt: a JS String.replace insertion turned `$$` into `$` in 0002 and the committed template stopped parsing.
test('migration templates: every dollar quote is a $$ pair (no lone $)', () => {
    const dir = new URL('../supabase/migrations/', import.meta.url);
    for (const f of readdirSync(dir).filter((n) => /^000[2-9].*\.sql\.tmpl$/.test(n) || n === 'test_only_helpers.sql')) {
        const lone = readFileSync(new URL(f, dir), 'utf8').split('\n').map((l, i) => [i + 1, l.replaceAll('$$', '')]).filter(([, l]) => l.includes('$'));
        assert.deepEqual(lone.map(([n]) => n), [], f);
    }
});
