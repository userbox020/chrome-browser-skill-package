import assert from 'node:assert/strict';
import test from 'node:test';
import { agentEnvelope } from '../src/output.mjs';

test('agent discovery output is smaller while retaining exact refs, states and truncation', t => {
  const elements = Array.from({ length: 20 }, (_, index) => ({ ref: `@e12345678-${index + 1}`, role: 'button', tag: 'button', type: 'submit', name: `Action ${index}`, text: `Action ${index}`, documentId: 'long-document-identifier-123456789', frameId: 0, bounds: { x: 10, y: 20, width: 100, height: 30 }, state: { visible: true, disabled: false } }));
  const result = { total: 25, returned: 20, truncated: true, elements, frames: [{ frameId: 0, documentId: 'document', elementCount: 25 }, { frameId: 4, elementCount: 0 }] };
  const output = agentEnvelope('page.elements', { ok: true, result });
  assert.deepEqual(output.data.elements.map(item => item.ref), elements.map(item => item.ref));
  assert.deepEqual(output.data.elements[0].state, elements[0].state);
  assert.equal(output.truncated, true);
  assert.equal(output.data.emptyFrameCount, 1);
  const before = Buffer.byteLength(JSON.stringify(result, null, 2));
  const after = Buffer.byteLength(JSON.stringify(output));
  assert.ok(after < before / 2);
  t.diagnostic(`20-element fixture: ${before} -> ${after} output bytes (${Math.round((1 - after / before) * 100)}% smaller)`);
});

test('agent bounds arbitrary output and preserves confirmation tokens and non-retryable errors', () => {
  const output = agentEnvelope('page.snap', { ok: true, result: { text: 'x'.repeat(100_000), elements: [] } });
  assert.equal(output.truncated, true);
  assert.ok(JSON.stringify(output).length < 13_000);
  const confirmation = agentEnvelope('click', { confirmationRequired: true, challenge: 'exact-token', summary: 'Confirm action', details: { text: 'x'.repeat(100_000) } });
  assert.equal(confirmation.confirmation.challenge, 'exact-token');
  assert.equal(confirmation.status, 'confirmation-required');
  const error = agentEnvelope('click', { ok: false, code: 'outcome-unknown' });
  assert.equal(error.error.retryable, false);
  assert.match(error.next.instruction, /Do not blindly repeat/);
});
