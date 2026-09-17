import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { VERSION } from '../extension/version.js';

test('worker offers one-click pairing, waits for server acknowledgement, and diagnoses version mismatch', async t => {
  const previous = { chrome: globalThis.chrome, WebSocket: globalThis.WebSocket };
  const id = 'ognccladlndjhpjnaidfjbimhhefddeg';
  const secret = 'ab'.repeat(32);
  const storage = {};
  let onMessage;
  let onSuspend;
  const badges = [];
  globalThis.chrome = {
    runtime: {
      id, getURL: path => `chrome-extension://${id}/${path}`,
      onMessage: { addListener(listener) { onMessage = listener; } },
      onSuspend: { addListener(listener) { onSuspend = listener; } },
    },
    storage: { session: { async get() { return {}; } }, local: { async get() { return storage; } } },
    tabs: { onRemoved: { addListener() {} } },
    debugger: { onEvent: { addListener() {} }, onDetach: { addListener() {} } },
    action: { async setBadgeText(value) { badges.push(value.text); }, async setBadgeBackgroundColor() {}, async setTitle() {} },
  };
  globalThis.WebSocket = FakeSocket;
  t.after(() => {
    onSuspend?.();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  });
  await import('../extension/background.js');
  await Promise.resolve();
  const sender = { id, url: `chrome-extension://${id}/popup.html` };
  const message = type => new Promise(resolve => onMessage({ type }, sender, resolve));
  const status = () => message('pairing.status');
  const challenge = socket => {
    const nonce = socket.sent.find(item => item.type === 'hello').clientNonce;
    const serverNonce = 'cd'.repeat(32);
    return { type: 'challenge', protocol: 1, version: VERSION, clientNonce: nonce, serverNonce, pairingUrl: `chrome-extension://${id}/pair.html#${secret}`, proof: createHmac('sha256', Buffer.from(secret, 'hex')).update(`server:${nonce}:${serverNonce}`).digest('hex') };
  };
  const first = FakeSocket.instances[0];
  first.open();
  await first.receive(challenge(first));
  assert.equal((await status()).state, 'pairing-required');
  assert.match((await status()).pairingUrl, /^chrome-extension:/);
  storage.bridgeSecret = secret;
  await message('pairing.updated');
  const second = FakeSocket.instances[1];
  second.open();
  await second.receive(challenge(second));
  assert.equal((await status()).state, 'authenticating');
  assert.equal((await status()).connected, false);
  assert.equal(second.sent.at(-1).type, 'ready');
  await second.receive({ type: 'authenticated', protocol: 1, version: VERSION });
  assert.equal((await status()).connected, true);
  assert.equal((await status()).pairingUrl, null);
  assert.equal(badges.at(-1), 'ON');
  let leaked = false;
  onMessage({ type: 'pairing.status' }, { id, url: 'https://unrelated.test/' }, () => { leaked = true; });
  assert.equal(leaked, false);
  await second.receive({ ...challenge(second), version: '2.3.0' });
  assert.equal((await status()).state, 'version-mismatch');
  assert.equal((await status()).connected, false);
});

class FakeSocket {
  static instances = [];
  static CONNECTING = 0;
  static OPEN = 1;
  constructor() { this.readyState = 0; this.sent = []; FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen(); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  async receive(value) { await this.onmessage({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; this.onclose(); }
}
