// A2: validateWl runs with fetch trapped; the module is loaded only after the trap is installed
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.fetch = () => { throw new Error('validate code must never call fetch'); };
const { validateWl } = await import('../src/validate.js');
test('validateWl does not touch fetch', () => {
    assert.deepEqual(validateWl({ border: [], top100: [], eventId: 1, slot: new Date(), chapters: [] }), []);
});
