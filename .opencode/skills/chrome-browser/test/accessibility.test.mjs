import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.chrome = {
  debugger: {
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  },
};
const { AccessibilityController } = await import('../extension/accessibility.js');

test('accessibility controller exposes stable closed-shadow-capable refs and boxes', async () => {
  const manager = new FakeManager();
  const controller = new AccessibilityController(manager);
  const first = await controller.elements(7, 'save');
  assert.equal(first.total, 1);
  assert.match(first.elements[0].ref, /^@a[a-f0-9]{8}-1$/);
  assert.equal(first.elements[0].role, 'button');
  assert.equal(first.elements[0].name, 'Save changes');

  const repeated = await controller.elements(7, '');
  assert.equal(repeated.elements[0].ref, first.elements[0].ref);
  assert.deepEqual(await controller.box(7, first.elements[0].ref), {
    point: { x: 60, y: 35 },
    bounds: { x: 10, y: 20, width: 100, height: 30 },
  });
});

test('accessibility click preparation uses CDP scrolling, isolated execution, hit testing, and submit confirmation', async () => {
  const manager = new FakeManager();
  const controller = new AccessibilityController(manager);
  const ref = (await controller.elements(7)).elements[0].ref;
  const prepared = await controller.prepareClick(7, ref, false, null);
  assert.equal(prepared.confirmationRequired, true);
  assert.ok(manager.calls.some(call => call.method === 'DOM.scrollIntoViewIfNeeded'));
  assert.ok(manager.calls.some(call => call.method === 'Page.createIsolatedWorld'));
  assert.ok(manager.calls.some(call => call.method === 'DOM.getNodeForLocation'));
  const runtimeCall = manager.calls.find(call => call.method === 'Runtime.callFunctionOn' && call.params.arguments?.[0]?.value === 'context');
  assert.equal(runtimeCall.params.userGesture, false);
});

test('accessibility controller never reuses refs after a document reset', async () => {
  const manager = new FakeManager();
  const controller = new AccessibilityController(manager);
  const oldRef = (await controller.elements(7)).elements[0].ref;
  manager.loaderId = 'loader-2';
  const newRef = (await controller.elements(7)).elements[0].ref;
  assert.notEqual(newRef, oldRef);
  await assert.rejects(controller.describe(7, oldRef), error => error.code === 'stale');
});

test('accessibility approval detects a fresh AX name change and covered targets', async () => {
  const manager = new FakeManager();
  const controller = new AccessibilityController(manager);
  const ref = (await controller.elements(7)).elements[0].ref;
  const first = await controller.prepareClick(7, ref, false, null);
  manager.name = 'Delete account';
  const changed = await controller.prepareClick(7, ref, true, first.approvalContext);
  assert.equal(changed.confirmationRequired, true);

  manager.hitBackendNodeId = 99;
  manager.hitContained = false;
  await assert.rejects(controller.prepareClick(7, ref, false, null), error => error.code === 'obscured');
});

test('accessibility refs invalidate when the root loader changes', async () => {
  const manager = new FakeManager();
  const controller = new AccessibilityController(manager);
  const ref = (await controller.elements(7)).elements[0].ref;
  manager.loaderId = 'loader-2';
  await assert.rejects(controller.describe(7, ref), error => {
    assert.equal(error.code, 'stale');
    return true;
  });
});

class FakeManager {
  constructor() {
    this.loaderId = 'loader-1';
    this.calls = [];
    this.name = 'Save changes';
    this.hitBackendNodeId = 42;
    this.hitContained = true;
  }
  async send(_tabId, method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root-frame', loaderId: this.loaderId } } };
    if (method === 'Accessibility.getFullAXTree' || method === 'Accessibility.getPartialAXTree') return { nodes: [{
      ignored: false,
      backendDOMNodeId: 42,
      role: { value: 'button' },
      name: { value: this.name },
      properties: [{ name: 'focusable', value: { value: true } }, { name: 'disabled', value: { value: false } }],
    }] };
    if (method === 'DOM.getBoxModel') return { model: { content: [10, 20, 110, 20, 110, 50, 10, 50] } };
    if (method === 'DOM.scrollIntoViewIfNeeded' || method === 'Runtime.releaseObjectGroup') return {};
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: this.hitBackendNodeId };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'target' } };
    if (method === 'Runtime.callFunctionOn') {
      if (params.functionDeclaration.startsWith('function(hit)')) return { result: { value: this.hitContained } };
      const operation = params.arguments?.[0]?.value;
      if (operation === 'context') return { result: { value: { ok: true, consequential: true, element: { role: 'button', tag: 'button', state: { disabled: false } }, approvalContext: { version: 4, target: { ref: params.arguments[2].value, role: 'button', tag: 'BUTTON', label: params.arguments[3].value.name } } } } };
      if (operation === 'describe') return { result: { value: { ok: true, element: { role: 'button', tag: 'button', state: { disabled: false } } } } };
    }
    if (method === 'Page.enable' || method === 'Accessibility.enable') return {};
    throw new Error(`Unexpected method: ${method}`);
  }
}
