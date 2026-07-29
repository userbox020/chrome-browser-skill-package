import assert from 'node:assert/strict';
import test from 'node:test';

test('debugger manager serializes root attachment and routes child commands by session ID', async t => {
  const calls = [];
  const listeners = { event: [], detach: [] };
  globalThis.chrome = {
    runtime: { lastError: null },
    debugger: {
      onEvent: { addListener: listener => listeners.event.push(listener) },
      onDetach: { addListener: listener => listeners.detach.push(listener) },
      attach(target, version, callback) { calls.push({ type: 'attach', target, version }); setTimeout(callback, 5); },
      sendCommand(target, method, params, callback) { calls.push({ type: 'command', target, method, params }); callback({ ok: true }); },
      detach(target, callback) { calls.push({ type: 'detach', target }); callback(); },
    },
  };
  t.after(() => { delete globalThis.chrome; });

  const { DebuggerManager } = await import(`../extension/debugger.js?test=${Date.now()}`);
  const manager = new DebuggerManager();
  await Promise.all([
    manager.sendSession({ tabId: 7 }, 'Network.enable', {}),
    manager.sendSession({ tabId: 7, sessionId: 'child-1' }, 'Fetch.enable', { patterns: [] }),
  ]);
  assert.equal(calls.filter(call => call.type === 'attach').length, 1);
  assert.deepEqual(calls.find(call => call.method === 'Network.enable').target, { tabId: 7 });
  assert.deepEqual(calls.find(call => call.method === 'Fetch.enable').target, { tabId: 7, sessionId: 'child-1' });
  await manager.detach(7);
});
