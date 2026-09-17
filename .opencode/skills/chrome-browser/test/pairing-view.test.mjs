import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionView } from '../extension/connection-state.js';
import { mountPairingView } from '../extension/pairing-view.js';

test('popup and pairing page transition from pairing to confirmed connection without HTTP retrieval', async t => {
  const previous = { chrome: globalThis.chrome, window: globalThis.window };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  });
  const extensionId = 'ognccladlndjhpjnaidfjbimhhefddeg';
  let current = { state: 'pairing-required', pairingUrl: `chrome-extension://${extensionId}/pair.html#${'a'.repeat(64)}` };
  const stored = [];
  globalThis.chrome = {
    runtime: { id: extensionId, async sendMessage(message) { if (message.type === 'pairing.updated') current = { state: 'connected', connected: true }; return current; } },
    storage: { local: { async set(value) { stored.push(value); } } },
  };
  globalThis.window = { addEventListener() {} };
  const node = () => ({ value: '', textContent: '', dataset: {}, hidden: false, disabled: false, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
  const view = { input: node(), button: node(), status: node(), message: node(), controls: node(), retry: node() };
  const stop = await mountPairingView(view);
  t.after(stop);
  assert.equal(view.button.disabled, false);
  assert.equal(view.controls.hidden, false);
  await view.button.listeners.click();
  assert.equal(stored.length, 1);
  assert.equal(view.status.textContent, 'Connected');
  assert.equal(view.controls.hidden, true);
  assert.equal(view.input.value, '');
  assert.doesNotMatch(view.message.textContent, /could not|error/i);
});

test('connection view distinguishes offline, auth failure and version mismatch; authenticating is not connected', () => {
  for (const state of ['bridge-offline', 'auth-failed', 'version-mismatch']) assert.equal(connectionView({ state }).error, true);
  assert.equal(connectionView({ state: 'authenticating' }).connected, false);
  assert.equal(connectionView({ state: 'connected' }).badge, 'ON');
});
