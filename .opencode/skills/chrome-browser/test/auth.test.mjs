import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { hmacHex, randomNonce, safeEqual } from '../extension/auth.js';
import { getOrCreatePairingSecret } from '../src/pairing.mjs';

test('extension HMAC matches the Node bridge implementation', async () => {
  const secret = '42'.repeat(32);
  const message = 'server:client-nonce:server-nonce';
  const expected = createHmac('sha256', Buffer.from(secret, 'hex')).update(message).digest('hex');
  assert.equal(await hmacHex(secret, message), expected);
  assert.equal(safeEqual(expected, expected), true);
  assert.equal(safeEqual(expected, expected.replace(/^./, expected[0] === 'a' ? 'b' : 'a')), false);
});

test('authentication nonces are 256-bit hex values', () => {
  assert.match(randomNonce(), /^[a-f0-9]{64}$/);
  assert.notEqual(randomNonce(), randomNonce());
});

test('the pairing secret is generated once and reused', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'chrome-browser-pair-'));
  const file = resolve(directory, 'pairing.key');
  try {
    const first = getOrCreatePairingSecret(file);
    const second = getOrCreatePairingSecret(file);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(second, first);
    assert.equal(readFileSync(file, 'utf8'), first);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
