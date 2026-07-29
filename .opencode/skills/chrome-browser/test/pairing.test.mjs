import assert from 'node:assert/strict';
import test from 'node:test';
import { localPairingUrl, parsePairingValue } from '../extension/pairing.js';

const extensionId = 'ognccladlndjhpjnaidfjbimhhefddeg';
const secret = 'ab'.repeat(32);

test('pairing accepts the local secret or this extension pairing URL', () => {
  assert.equal(parsePairingValue(secret.toUpperCase(), extensionId), secret);
  assert.equal(parsePairingValue(`chrome-extension://${extensionId}/pair.html#${secret}`, extensionId), secret);
});

test('pairing rejects foreign extension URLs and malformed secrets', () => {
  assert.throws(() => parsePairingValue(`chrome-extension://${'a'.repeat(32)}/pair.html#${secret}`, extensionId), /different extension/i);
  assert.throws(() => parsePairingValue(`https://example.test/pair.html#${secret}`, extensionId), /different extension/i);
  assert.throws(() => parsePairingValue('not-a-secret', extensionId), /complete pairing URL/i);
});

test('pairing URL is obtained directly from the local bridge', async () => {
  const url = `chrome-extension://${extensionId}/pair.html#${secret}`;
  const result = await localPairingUrl(async (requestUrl, options) => {
    assert.equal(requestUrl, 'http://127.0.0.1:9998/pair');
    assert.equal(options.cache, 'no-store');
    return { ok: true, async json() { return { url }; } };
  }, extensionId);
  assert.equal(result, url);
});
