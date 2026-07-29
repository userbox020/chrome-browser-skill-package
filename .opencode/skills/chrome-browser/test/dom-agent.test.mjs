import assert from 'node:assert/strict';
import test from 'node:test';
import { runDomAgent } from '../extension/dom-agent.js';

test('DOM agent discovers accessible elements in open shadow roots and keeps stable refs', async t => {
  const page = installDOM();
  t.after(page.restore);

  const snapshot = await runDomAgent({ op: 'snapshot' });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.text, 'Visible page text');
  assert.equal(snapshot.elements.length, 2);
  assert.deepEqual(snapshot.elements.map(item => [item.role, item.name]), [['button', 'Root action'], ['button', 'Shadow action']]);
  assert.match(snapshot.elements[0].ref, /^[0-9a-f-]+:r1$/i);

  const filtered = await runDomAgent({ op: 'elements', query: 'shadow' });
  assert.equal(filtered.elements.length, 1);
  assert.equal(filtered.elements[0].ref, snapshot.elements[1].ref);
});

test('DOM agent confirms generic submitters, detects commit mutation, and hit-tests inside open shadows', async t => {
  const page = installDOM();
  t.after(page.restore);
  globalThis.requestAnimationFrame = callback => callback();

  page.rootButton.type = 'submit';
  page.rootButton.form = { action: 'https://example.test/save', method: 'post', enctype: 'application/x-www-form-urlencoded', target: '', id: 'form', name: '', elements: [page.rootButton] };
  page.setHit(page.rootButton);
  const ref = (await runDomAgent({ op: 'elements', query: 'root' })).elements[0].ref;
  const prepared = await runDomAgent({ op: 'prepare-click', target: { kind: 'ref', value: ref } });
  assert.equal(prepared.confirmationRequired, true);
  page.rootButton.form.action = 'https://example.test/delete';
  const commit = await runDomAgent({ op: 'commit-click', target: { kind: 'ref', value: ref }, expectedContext: prepared.approvalContext });
  assert.equal(commit.confirmationRequired, true);
  assert.equal(page.rootButton.clicks, 0);

  page.setHit(page.host);
  const shadowRef = (await runDomAgent({ op: 'elements', query: 'shadow' })).elements[0].ref;
  const shadow = await runDomAgent({ op: 'prepare-click', target: { kind: 'ref', value: shadowRef } });
  assert.equal(shadow.prepared, true);
  const replayContext = { ...structuredClone(shadow.approvalContext), target: Object.fromEntries(Object.entries(shadow.approvalContext.target).reverse()) };
  delete replayContext.anchor;
  delete replayContext.form;
  const replayed = await runDomAgent({ op: 'prepare-click', target: { kind: 'ref', value: shadowRef }, approved: true, expectedContext: replayContext });
  assert.equal(replayed.prepared, true);
  const invalidWait = await runDomAgent({ op: 'wait', target: { kind: 'ref', value: shadowRef }, state: 'visble', timeout: 100 });
  assert.equal(invalidWait.error.code, 'invalid-state');
});

function installDOM() {
  const keys = ['document', 'location', 'getComputedStyle', 'innerWidth', 'innerHeight', 'requestAnimationFrame', 'scrollX', 'scrollY'];
  const previous = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const rootButton = new FakeElement({ tagName: 'BUTTON', text: 'Root action' });
  const shadowButton = new FakeElement({ tagName: 'BUTTON', text: 'Shadow action' });
  const shadowRoot = new FakeRoot([shadowButton]);
  const host = new FakeElement({ tagName: 'DIV', text: '', shadowRoot });
  rootButton.root = null;
  shadowButton.root = shadowRoot;
  host.root = null;
  const documentRoot = new FakeRoot([host, rootButton]);
  let hit = rootButton;
  const document = {
    ...documentRoot,
    title: 'Fixture',
    body: { innerText: 'Visible page text' },
    activeElement: null,
    getElementById() { return null; },
    elementFromPoint() { return hit; },
    hasFocus() { return true; },
  };
  document.querySelectorAll = documentRoot.querySelectorAll.bind(documentRoot);
  globalThis.document = document;
  globalThis.location = { href: 'https://example.test/', origin: 'https://example.test' };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' });
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  globalThis.scrollX = 0;
  globalThis.scrollY = 0;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { timeOrigin: 123 } });
  delete globalThis.__opencodeChromeDomAgentV1;
  return {
    rootButton,
    shadowButton,
    host,
    setHit(element) { hit = element; },
    restore() {
      delete globalThis.__opencodeChromeDomAgentV1;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
      if (performanceDescriptor) Object.defineProperty(globalThis, 'performance', performanceDescriptor);
      else delete globalThis.performance;
    },
  };
}

class FakeRoot {
  constructor(elements) { this.elements = elements; }
  querySelectorAll(selector) {
    if (selector === '*') return this.elements;
    return this.elements.filter(element => element.tagName === 'BUTTON');
  }
  getElementById() { return null; }
  elementFromPoint() { return this.elements[0] || null; }
}

class FakeElement {
  constructor({ tagName, text, shadowRoot = null }) {
    this.tagName = tagName;
    this.innerText = text;
    this.textContent = text;
    this.shadowRoot = shadowRoot;
    this.isConnected = true;
    this.hidden = false;
    this.labels = [];
    this.parentElement = null;
    this.root = null;
    this.id = '';
    this.type = '';
    this.required = false;
    this.disabled = false;
    this.readOnly = false;
    this.name = '';
    this.value = '';
    this.form = null;
    this.clicks = 0;
  }
  getAttribute() { return null; }
  hasAttribute(name) { return name === 'href' ? false : false; }
  closest() { return null; }
  matches(selector) { return selector === 'label[for]' && this.tagName === 'LABEL'; }
  getRootNode() { return this.root || globalThis.document; }
  getBoundingClientRect() { return { left: 10, top: 10, width: 100, height: 30 }; }
  scrollIntoView() {}
  contains(node) { return node === this; }
  click() { this.clicks++; }
}
