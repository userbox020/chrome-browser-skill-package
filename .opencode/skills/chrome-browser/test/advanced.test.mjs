import assert from 'node:assert/strict';
import test from 'node:test';

test('keyboard dispatch handles Space, NumpadEnter, modifiers, and cleanup', async t => {
  const fake = installChrome();
  const { acceptDialog, evaluate, pressKey } = await import(`../extension/advanced.js?keys=${Date.now()}`);
  const { debuggerManager } = await import('../extension/debugger.js');
  t.after(async () => { await debuggerManager.detach(7); fake.restore(); });

  await pressKey(7, 'Space', '');
  let events = fake.commands.filter(item => item.method === 'Input.dispatchKeyEvent').map(item => item.params);
  assert.deepEqual(events.map(item => item.type), ['rawKeyDown', 'char', 'keyUp']);

  fake.eventListener({ tabId: 7 }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete record?', url: 'https://example.test/', frameId: 'root' });
  const dialog = await acceptDialog(7, '', false, null);
  assert.equal(dialog.confirmationRequired, true);
  fake.eventListener({ tabId: 7 }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Transfer funds?', url: 'https://example.test/', frameId: 'root' });
  const replaced = await acceptDialog(7, '', true, dialog.approvalContext);
  assert.equal(replaced.confirmationRequired, true);
  assert.equal(fake.commands.some(item => item.method === 'Page.handleJavaScriptDialog'), false);
  const accepted = await acceptDialog(7, '', true, replaced.approvalContext);
  assert.equal(accepted.accepted, true);

  fake.commands = [];
  fake.eventListener({ tabId: 7 }, 'Runtime.executionContextCreated', { context: { id: 11, uniqueId: 'main-context', auxData: { isDefault: true } } });
  await evaluate(7, 'document.cookie', { documentId: 'document-1' });
  const evaluation = fake.commands.find(item => item.method === 'Runtime.evaluate' && item.params.expression === 'document.cookie');
  assert.equal(evaluation.params.uniqueContextId, 'main-context');
  assert.equal(events[0].key, ' ');
  assert.equal(events[0].code, 'Space');
  assert.equal(events[1].text, ' ');

  fake.commands = [];
  await pressKey(7, 'a', 'ctrl');
  events = fake.commands.filter(item => item.method === 'Input.dispatchKeyEvent').map(item => item.params);
  assert.deepEqual(events.map(item => item.type), ['rawKeyDown', 'keyUp']);

  fake.commands = [];
  await pressKey(7, '1', 'shift');
  events = fake.commands.filter(item => item.method === 'Input.dispatchKeyEvent').map(item => item.params);
  assert.equal(events[0].key, '!');
  assert.equal(events[0].code, 'Digit1');
  assert.equal(events[1].text, '!');
  assert.equal(events[1].unmodifiedText, '1');

  fake.commands = [];
  await pressKey(7, 'NumpadEnter', '');
  events = fake.commands.filter(item => item.method === 'Input.dispatchKeyEvent').map(item => item.params);
  assert.equal(events[0].code, 'NumpadEnter');
  assert.equal(events[0].key, 'Enter');
  assert.equal(events[0].location, 3);
  assert.equal(events[0].windowsVirtualKeyCode, 13);

  fake.commands = [];
  fake.failChar = true;
  await assert.rejects(pressKey(7, 'x', ''), /char failed/);
  events = fake.commands.filter(item => item.method === 'Input.dispatchKeyEvent').map(item => item.params);
  assert.deepEqual(events.map(item => item.type), ['rawKeyDown', 'char', 'keyUp']);
});

function installChrome() {
  const previous = globalThis.chrome;
  const fake = {
    commands: [],
    failChar: false,
    eventListener: null,
    restore() { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; },
  };
  globalThis.chrome = {
    runtime: { lastError: null },
    scripting: {
      async executeScript(details) { return [{ frameId: 0, documentId: details.target.documentIds?.[0] || 'document-1', result: true }]; },
    },
    debugger: {
      onEvent: { addListener(listener) { fake.eventListener = listener; } },
      onDetach: { addListener() {} },
      attach(_target, _version, callback) { callback(); },
      detach(_target, callback) { callback(); },
      sendCommand(_target, method, params, callback) {
        fake.commands.push({ method, params: structuredClone(params) });
        if (method === 'Input.dispatchKeyEvent' && params.type === 'char' && fake.failChar) {
          fake.failChar = false;
          globalThis.chrome.runtime.lastError = { message: 'char failed' };
          callback();
          globalThis.chrome.runtime.lastError = null;
          return;
        }
        if (method === 'Runtime.evaluate') return callback({ result: { value: params.expression === 'document.cookie' ? 'ok' : true } });
        callback({});
      },
    },
  };
  return fake;
}
