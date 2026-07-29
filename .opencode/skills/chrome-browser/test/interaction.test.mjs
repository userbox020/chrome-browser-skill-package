import assert from 'node:assert/strict';
import test from 'node:test';

test('top-frame clicks revalidate after pointer movement before native input', async t => {
  const fake = installChrome();
  const { clickTarget } = await import(`../extension/interaction.js?interaction=${Date.now()}`);
  const { domController } = await import('../extension/dom-controller.js');
  const { debuggerManager } = await import('../extension/debugger.js');
  domController.scripting = globalThis.chrome.scripting;
  domController.clear(7);
  t.after(async () => { await debuggerManager.detach(7); fake.restore(); });

  const result = await clickTarget(7, '#save');
  assert.equal(result.clicked, true);
  assert.equal(result.trusted, true);
  assert.equal(fake.prepareCalls, 3);
  assert.deepEqual(fake.commands.filter(item => item.method === 'Input.dispatchMouseEvent').map(item => item.params.type), [
    'mouseMoved', 'mousePressed', 'mouseReleased',
  ]);
});

test('consequential clicks return a context without dispatching input', async t => {
  const fake = installChrome();
  fake.consequential = true;
  t.after(fake.restore);
  const { clickTarget } = await import(`../extension/interaction.js?challenge=${Date.now()}`);
  const { domController } = await import('../extension/dom-controller.js');
  domController.scripting = globalThis.chrome.scripting;
  domController.clear(7);

  const result = await clickTarget(7, '#pay');
  assert.equal(result.confirmationRequired, true);
  assert.equal(result.approvalContext.version, 4);
  assert.equal(fake.commands.some(item => item.method === 'Input.dispatchMouseEvent'), false);
});

test('failed pointer release is retried by click cleanup', async t => {
  const fake = installChrome();
  fake.failFirstRelease = true;
  const { clickTarget } = await import(`../extension/interaction.js?cleanup=${Date.now()}`);
  const { domController } = await import('../extension/dom-controller.js');
  const { debuggerManager } = await import('../extension/debugger.js');
  domController.scripting = globalThis.chrome.scripting;
  domController.clear(7);
  t.after(async () => { await debuggerManager.detach(7); fake.restore(); });

  await assert.rejects(clickTarget(7, '#save'), /release failed/);
  assert.equal(fake.commands.filter(item => item.method === 'Input.dispatchMouseEvent' && item.params.type === 'mouseReleased').length, 2);
});

test('drag rechecks source geometry and reports held pointer buttons', async t => {
  const fake = installChrome();
  const { dragTargets } = await import(`../extension/interaction.js?drag=${Date.now()}`);
  const { domController } = await import('../extension/dom-controller.js');
  const { debuggerManager } = await import('../extension/debugger.js');
  domController.scripting = globalThis.chrome.scripting;
  domController.clear(7);
  t.after(async () => { await debuggerManager.detach(7); fake.restore(); });

  const challenge = await dragTargets(7, '#source', '#target');
  assert.equal(challenge.confirmationRequired, true);
  const result = await dragTargets(7, '#source', '#target', true, challenge.approvalContext);
  assert.equal(result.dragged, true);
  assert.deepEqual(fake.domOps, ['center:#source', 'center:#target', 'point:#source', 'point:#source', 'point:#target']);
  const events = fake.commands.filter(item => item.method === 'Input.dispatchMouseEvent').map(item => item.params);
  assert.equal(events.find(item => item.type === 'mousePressed').buttons, 1);
  assert.ok(events.filter(item => item.type === 'mouseMoved' && item.button === 'left').every(item => item.buttons === 1));
  assert.equal(events.find(item => item.type === 'mouseReleased').buttons, 0);
});

test('upload resolves the exact isolated-world element object without a DOM marker', async t => {
  const fake = installChrome();
  const { uploadTarget } = await import(`../extension/interaction.js?upload=${Date.now()}`);
  const { domController } = await import('../extension/dom-controller.js');
  const { debuggerManager } = await import('../extension/debugger.js');
  domController.scripting = globalThis.chrome.scripting;
  domController.clear(7);
  debuggerManager.trackExecutionContext({ tabId: 7 }, 'Runtime.executionContextCreated', { context: { id: 9, auxData: { isDefault: false } } });
  t.after(async () => { await debuggerManager.detach(7); fake.restore(); });

  const files = ['C:\\safe\\fixture.txt'];
  const challenge = await uploadTarget(7, '#file', files);
  assert.equal(challenge.confirmationRequired, true);
  const result = await uploadTarget(7, '#file', files, true, challenge.approvalContext);
  assert.equal(result.uploaded, true);
  const upload = fake.commands.find(item => item.method === 'DOM.setFileInputFiles');
  assert.equal(upload.params.objectId, 'file-object');
  assert.deepEqual(upload.params.files, files);
  assert.equal(fake.domOps.some(operation => operation.includes('mark-upload')), false);
});

function installChrome() {
  const previous = globalThis.chrome;
  const fake = {
    commands: [],
    domOps: [],
    prepareCalls: 0,
    consequential: false,
    failFirstRelease: false,
    failedRelease: false,
    restore() { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; },
  };
  const context = {
    version: 4,
    document: { href: 'https://example.test/', timeOrigin: '1' },
    target: { ref: 'epoch:r1', tag: 'BUTTON', role: 'button', id: 'save', name: '', type: 'button', value: '', label: 'Save' },
    anchor: null,
    form: null,
  };
  globalThis.chrome = {
    runtime: { lastError: null },
    scripting: {
      async executeScript(details) {
        const request = details.args[0];
        if (request.op === 'prepare-click') {
          fake.prepareCalls++;
          if (fake.consequential && !request.approved) {
            return [{ frameId: 0, documentId: 'doc', result: { ok: true, confirmationRequired: true, summary: 'Confirm click', approvalContext: context, element: element() } }];
          }
          return [{ frameId: 0, documentId: 'doc', result: { ok: true, prepared: true, consequential: fake.consequential, approvalContext: context, point: { x: 10, y: 20 }, bounds: { x: 5, y: 15, width: 10, height: 10 }, element: element() } }];
        }
        if (request.op === 'center' || request.op === 'point') {
          fake.domOps.push(`${request.op}:${request.target.value}`);
          const source = request.target.value === '#source';
          return [{ frameId: 0, documentId: 'doc', result: { ok: true, point: source ? { x: 10, y: 20 } : { x: 80, y: 90 }, bounds: { x: 5, y: 15, width: 10, height: 10 }, element: element() } }];
        }
        if (request.op === 'context') return [{ frameId: 0, documentId: 'doc', result: { ok: true, approvalContext: context, element: element() } }];
        if (request.op === 'prepare-upload') return [{ frameId: 0, documentId: 'doc', result: { ok: true, prepared: true, element: { ...element(), tag: 'input', role: 'button', type: 'file' } } }];
        throw new Error(`Unexpected DOM operation: ${request.op}`);
      },
    },
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
      attach(_target, _version, callback) { callback(); },
      detach(_target, callback) { callback(); },
      sendCommand(_target, method, params, callback) {
        fake.commands.push({ method, params: structuredClone(params) });
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && fake.failFirstRelease && !fake.failedRelease) {
          fake.failedRelease = true;
          globalThis.chrome.runtime.lastError = { message: 'release failed' };
          callback();
          globalThis.chrome.runtime.lastError = null;
          return;
        }
        if (method === 'Runtime.evaluate') {
          if (params.returnByValue) return callback({ result: { value: true } });
          return callback({ result: { objectId: 'file-object' } });
        }
        callback({});
      },
    },
  };
  return fake;
}

function element() {
  return {
    ref: 'epoch:r1', tag: 'button', role: 'button', name: 'Save', type: 'button', text: 'Save',
    state: { visible: true, disabled: false, editable: false }, bounds: { x: 5, y: 15, width: 10, height: 10 },
  };
}
