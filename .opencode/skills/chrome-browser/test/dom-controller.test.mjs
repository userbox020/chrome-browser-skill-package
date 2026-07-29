import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMController } from '../extension/dom-controller.js';

test('DOM controller creates stable public refs across frames and routes actions', async () => {
  const scripting = new FakeScripting();
  const controller = new DOMController(scripting);
  const snapshot = await controller.snapshot(7);

  assert.equal(snapshot.elements.length, 2);
  assert.match(snapshot.elements[0].ref, /^@e[a-f0-9]{8}-1$/);
  assert.match(snapshot.elements[1].ref, /^@e[a-f0-9]{8}-2$/);
  assert.equal(snapshot.elements[1].frameId, 4);
  assert.equal(snapshot.frames.length, 2);

  const repeated = await controller.snapshot(7);
  assert.deepEqual(repeated.elements.map(item => item.ref), snapshot.elements.map(item => item.ref));

  const result = await controller.run(7, 'focus', snapshot.elements[1].ref);
  assert.equal(result.focused, true);
  assert.equal(result.element.ref, snapshot.elements[1].ref);
  assert.deepEqual(scripting.calls.at(-1).target.frameIds, [4]);
  assert.deepEqual(scripting.calls.at(-1).args[0].target, { kind: 'ref', value: 'r1' });
});

test('DOM controller never reuses refs after tab state is cleared', async () => {
  const controller = new DOMController(new FakeScripting());
  const oldRef = (await controller.snapshot(7)).elements[0].ref;
  controller.clear(7);
  const newRef = (await controller.snapshot(7)).elements[0].ref;
  assert.notEqual(newRef, oldRef);
  await assert.rejects(controller.run(7, 'focus', oldRef), error => error.code === 'stale');
});

test('DOM controller invalidates refs after a frame document changes', async () => {
  const scripting = new FakeScripting();
  const controller = new DOMController(scripting);
  const snapshot = await controller.snapshot(7);
  const ref = snapshot.elements[1].ref;
  scripting.childDocument = 'child-doc-2';

  await assert.rejects(controller.run(7, 'describe', ref), error => {
    assert.equal(error.code, 'wrong-document');
    return true;
  });
  await assert.rejects(controller.run(7, 'describe', ref), error => {
    assert.equal(error.code, 'stale');
    return true;
  });
});

test('DOM controller preserves structured locator failures', async () => {
  const scripting = new FakeScripting();
  scripting.failure = { code: 'ambiguous', message: 'Two elements match', matchCount: 2, candidates: [{ ref: 'r1' }, { ref: 'r2' }] };
  const controller = new DOMController(scripting);
  await assert.rejects(controller.run(7, 'focus', '#save'), error => {
    assert.equal(error.code, 'ambiguous');
    assert.equal(error.details.matchCount, 2);
    return true;
  });
});

class FakeScripting {
  constructor() {
    this.calls = [];
    this.childDocument = 'child-doc-1';
    this.failure = null;
  }

  async executeScript(details) {
    this.calls.push(structuredClone({ target: details.target, world: details.world, args: details.args }));
    if (details.target.allFrames) {
      return [
        frame(0, 'root-doc', 'r1', 'Root button'),
        frame(4, this.childDocument, 'r1', 'Frame button'),
      ];
    }
    const frameId = details.target.frameIds[0];
    if (this.failure) return [{ frameId, documentId: frameId === 4 ? this.childDocument : 'root-doc', result: { ok: false, error: this.failure } }];
    return [{
      frameId,
      documentId: frameId === 4 ? this.childDocument : 'root-doc',
      result: { ok: true, focused: true, element: element('r1', frameId === 4 ? 'Frame button' : 'Root button') },
    }];
  }
}

function frame(frameId, documentId, ref, name) {
  return {
    frameId,
    documentId,
    result: {
      ok: true,
      url: frameId ? 'https://frame.example.test/' : 'https://root.example.test/',
      title: frameId ? 'Frame' : 'Root',
      text: name,
      textLength: name.length,
      truncated: false,
      elements: [element(ref, name)],
    },
  };
}

function element(ref, name) {
  return {
    ref,
    tag: 'button',
    role: 'button',
    name,
    text: name,
    type: '',
    state: { visible: true, disabled: false, editable: false },
    bounds: { x: 1, y: 2, width: 30, height: 10 },
  };
}
