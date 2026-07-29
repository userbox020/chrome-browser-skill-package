import assert from 'node:assert/strict';
import test from 'node:test';
import { sameContext } from '../extension/context.js';

test('confirmation contexts ignore object key order but not value or array order', () => {
  assert.equal(sameContext({ target: { role: 'button', form: null }, values: [1, 2] }, { values: [1, 2], target: { form: null, role: 'button' } }), true);
  assert.equal(sameContext({ values: [1, 2] }, { values: [2, 1] }), false);
  assert.equal(sameContext({ value: 'one' }, { value: 'two' }), false);
});
