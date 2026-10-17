// Spec A2: the forecast tree may import only src/forecast/* and src/constants.js; no bare or node: specifiers, no dynamic
// import / require, no fetch-like identifiers, no process.getBuiltinModule / process.binding. Threat model: our own mistakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const FORECAST = resolve(ROOT, 'src/forecast'), CONSTANTS = resolve(ROOT, 'src/constants.js');
const BANNED = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']);
const rel = (p) => relative(ROOT, p);

function violations(entry, { allowDirs = [FORECAST], allowFiles = [CONSTANTS] } = {}) {
    const out = [], seen = new Set();
    const allowed = (abs) => allowFiles.includes(abs) || allowDirs.some((d) => abs.startsWith(d + '/'));
    const visit = (abs) => {
        if (seen.has(abs)) return; seen.add(abs);
        let ast; try { ast = acorn.parse(readFileSync(abs, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }); } catch (e) { out.push(`${rel(abs)}: parse error ${e.message}`); return; }
        const next = [];
        const spec = (node, s) => {
            if (!s.startsWith('./') && !s.startsWith('../')) { out.push(`${rel(abs)}: specifier '${s}' is not a relative path`); return; }
            const target = resolve(dirname(abs), s);
            if (!allowed(target)) { out.push(`${rel(abs)}: '${s}' resolves outside the whitelist`); return; }
            next.push(target);
        };
        const walk = (node) => {
            if (!node || typeof node.type !== 'string') return;
            if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) spec(node, node.source.value);
            if (node.type === 'ImportExpression') out.push(`${rel(abs)}: dynamic import()`);
            if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') out.push(`${rel(abs)}: require()`);
            if (node.type === 'Identifier' && BANNED.has(node.name)) out.push(`${rel(abs)}: identifier '${node.name}'`);
            if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'process' && node.property.type === 'Identifier' && ['getBuiltinModule', 'binding'].includes(node.property.name)) out.push(`${rel(abs)}: process.${node.property.name}`);
            for (const k of Object.keys(node)) { const v = node[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
        };
        walk(ast);
        next.forEach(visit);
    };
    visit(entry);
    return out;
}
const FX = resolve(ROOT, 'test/isolation-fixtures');

test('A2: every src/forecast/*.js entry has zero violations', () => {
    for (const f of readdirSync(FORECAST).filter((x) => x.endsWith('.js'))) assert.deepEqual(violations(resolve(FORECAST, f)), [], f);
});
test('A2: the clean fixture passes under a fixture whitelist', () => {
    assert.deepEqual(violations(resolve(FX, 'good.js'), { allowDirs: [FX], allowFiles: [CONSTANTS] }), []);
});
test('A2: every negative fixture is flagged, including the indirect node:https through a local wrapper', () => {
    const expect = { 'bad-http2.js': /node:http2/, 'bad-createrequire.js': /node:module/, 'bad-wrapper.js': /wrapper-https\.js: specifier 'node:https'/, 'bad-builtin.js': /process\.getBuiltinModule/, 'bad-binding.js': /process\.binding/,
        'bad-fetch.js': /identifier 'fetch'/, 'bad-xhr.js': /XMLHttpRequest/, 'bad-ws.js': /WebSocket/, 'bad-es.js': /EventSource/, 'bad-dynamic.js': /dynamic import/, 'bad-require.js': /require\(\)/, 'bad-bare.js': /'acorn' is not a relative path/ };
    for (const [f, re] of Object.entries(expect)) { const v = violations(resolve(FX, f), { allowDirs: [FX], allowFiles: [CONSTANTS] }); assert.ok(v.some((x) => re.test(x)), `${f}: ${JSON.stringify(v)}`); }
});
