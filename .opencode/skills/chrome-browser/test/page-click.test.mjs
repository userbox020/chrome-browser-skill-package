import assert from 'node:assert/strict';
import test from 'node:test';
import { clickSemanticTarget } from '../extension/page.js';

class FakeElement {
  constructor(options = {}) {
    this.tagName = options.tagName || 'INPUT';
    this.id = options.id || '';
    this.name = options.name || '';
    this.type = options.type || '';
    this.value = options.value || '';
    this.innerText = options.innerText || '';
    this.textContent = options.textContent || this.innerText;
    this.form = options.form || null;
    this.row = options.row || null;
    this.attrs = { ...(options.attrs || {}) };
    this.href = options.href || '';
    this.formAction = options.formAction || '';
    this.formMethod = options.formMethod || '';
    this.formEnctype = options.formEnctype || '';
    this.isConnected = options.isConnected ?? true;
    this.clicked = 0;
    this.onFocus = options.onFocus || null;
  }

  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  closest() { return this.row; }
  scrollIntoView() {}
  focus() { this.onFocus?.(); }
  click() { this.clicked++; }
  getBoundingClientRect() { return { width: 20, height: 10 }; }
}

class FakeInputElement extends FakeElement {}

class FakeRow extends FakeElement {
  constructor({ controls = [], links = [], tagName = 'TR', role = '' } = {}) {
    super({ tagName, attrs: role ? { role } : {} });
    this.controls = controls;
    this.links = links;
  }

  querySelectorAll(selector) {
    return selector.startsWith('input[') ? this.controls : selector === 'a[href]' ? this.links : [];
  }
}

function checkbox(value, { name = 'resource', attributeValue = value } = {}) {
  const attrs = { type: 'checkbox', name };
  if (attributeValue !== null) attrs.value = attributeValue;
  return new FakeInputElement({ type: 'checkbox', name, value, attrs });
}

function editLink(href) {
  return new FakeElement({ tagName: 'A', href, attrs: { href } });
}

function setup(options = {}) {
  const form = options.form || {
    action: 'https://example.test/manage/pause?token=old&mode=pause&gig_id=gig-1#confirm',
    method: 'post',
    enctype: 'application/x-www-form-urlencoded',
    id: 'manage-form',
    name: 'manage',
  };
  const row = options.row === undefined ? new FakeRow({ controls: [checkbox('resource-1')] }) : options.row;
  let element = new FakeInputElement({
    id: options.id ?? 'pause',
    name: options.name ?? 'operation',
    type: options.type ?? 'submit',
    value: options.value ?? 'Pause',
    form,
    row,
    attrs: {
      type: options.type ?? 'submit',
      name: options.name ?? 'operation',
      value: options.value ?? 'Pause',
      ...(options.attrs || {}),
    },
    formAction: options.formAction,
    formMethod: options.formMethod,
    formEnctype: options.formEnctype,
    onFocus: options.onFocus,
  });
  const peers = options.peers || (row ? [row] : []);
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    HTMLInputElement: globalThis.HTMLInputElement,
    getComputedStyle: globalThis.getComputedStyle,
  };
  const previousPerformanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  globalThis.location = { href: options.href || 'https://example.test/manage', origin: 'https://example.test' };
  globalThis.document = {
    baseURI: 'https://example.test/manage',
    querySelector: query => query === '#pause' ? element : null,
    querySelectorAll: query => query === 'tr,[role="row"],li,article' ? peers : [element],
  };
  globalThis.HTMLInputElement = FakeInputElement;
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  Object.defineProperty(globalThis, 'performance', {
    value: { timeOrigin: options.timeOrigin ?? 1000 }, configurable: true, writable: true,
  });
  return {
    form,
    peers,
    get element() { return element; },
    set element(value) { element = value; },
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
      if (previousPerformanceDescriptor) Object.defineProperty(globalThis, 'performance', previousPerformanceDescriptor);
      else delete globalThis.performance;
    },
  };
}

const challenge = () => clickSemanticTarget('selector', '#pause', false, null);
const replay = context => clickSemanticTarget('selector', '#pause', true, context);

test('query token, mode, and resource ID values fail closed by default despite a strong binding', async t => {
  for (const [name, action] of [
    ['token', 'https://example.test/manage/pause?token=new&mode=pause&gig_id=gig-1#confirm'],
    ['mode pause to delete', 'https://example.test/manage/pause?token=old&mode=delete&gig_id=gig-1#confirm'],
    ['gig_id', 'https://example.test/manage/pause?token=old&mode=pause&gig_id=gig-2#confirm'],
  ]) {
    await t.test(name, child => {
      const page = setup();
      child.after(() => page.restore());
      const first = challenge();
      assert.equal(first.approvalContext.resourceBinding.state, 'strong-unique');
      page.form.action = action;
      const result = replay(first.approvalContext);
      assert.equal(result.confirmationRequired, true);
      assert.deepEqual(result.diagnostics.changedFields, ['form.action.query.value']);
      assert.equal(page.element.clicked, 0);
    });
  }
});

test('query key order, cardinality, additions, removals, and duplicates are exact', async t => {
  for (const [name, action] of [
    ['add', 'https://example.test/manage/pause?token=old&mode=pause&gig_id=gig-1&extra=x#confirm'],
    ['remove', 'https://example.test/manage/pause?token=old&gig_id=gig-1#confirm'],
    ['reorder', 'https://example.test/manage/pause?mode=pause&token=old&gig_id=gig-1#confirm'],
    ['duplicate add', 'https://example.test/manage/pause?token=old&mode=pause&gig_id=gig-1&gig_id=gig-1#confirm'],
    ['duplicate reorder', 'https://example.test/manage/pause?token=old&gig_id=gig-1&mode=pause&gig_id=gig-1#confirm'],
  ]) {
    await t.test(name, child => {
      const page = setup({ form: {
        action: name === 'duplicate reorder'
          ? 'https://example.test/manage/pause?token=old&gig_id=gig-1&gig_id=gig-1&mode=pause#confirm'
          : 'https://example.test/manage/pause?token=old&mode=pause&gig_id=gig-1#confirm',
        method: 'post', enctype: 'application/x-www-form-urlencoded', id: 'f', name: 'f',
      } });
      child.after(() => page.restore());
      const first = challenge();
      page.form.action = action;
      const result = replay(first.approvalContext);
      assert.equal(result.confirmationRequired, true);
      assert.ok(result.diagnostics.changedFields.includes('form.action.query.shape'));
      assert.equal(page.element.clicked, 0);
    });
  }
});

test('generic controls and non-unique control identities are not strong bindings', async t => {
  await t.test('selected=on', child => {
    const row = new FakeRow({ controls: [checkbox('on', { name: 'selected' })] });
    const page = setup({ row });
    child.after(() => page.restore());
    assert.deepEqual(challenge().approvalContext.resourceBinding, { state: 'unbound-row' });
  });
  await t.test('effective value differs from attribute', child => {
    const row = new FakeRow({ controls: [checkbox('resource-2', { attributeValue: 'resource-1' })] });
    const page = setup({ row });
    child.after(() => page.restore());
    assert.deepEqual(challenge().approvalContext.resourceBinding, { state: 'unbound-row' });
  });
  await t.test('duplicate peer identity', child => {
    const row = new FakeRow({ controls: [checkbox('resource-1')] });
    const duplicate = new FakeRow({ controls: [checkbox('resource-1')] });
    const page = setup({ row, peers: [row, duplicate] });
    child.after(() => page.restore());
    assert.deepEqual(challenge().approvalContext.resourceBinding, { state: 'unbound-row' });
  });
});

test('consequential targets in unbound rows never consume prior approval', async t => {
  await t.test('switching between indistinguishable weak rows fails closed', child => {
    const firstRow = new FakeRow({ controls: [checkbox('on', { name: 'selected' })] });
    const secondRow = new FakeRow({ controls: [checkbox('on', { name: 'selected' })] });
    const page = setup({ row: firstRow, peers: [firstRow, secondRow] });
    child.after(() => page.restore());
    const first = challenge();
    assert.deepEqual(first.approvalContext.resourceBinding, { state: 'unbound-row' });
    page.element.row = secondRow;
    const result = replay(first.approvalContext);
    assert.equal(result.confirmationRequired, true);
    assert.ok(result.diagnostics.changedFields.includes('resourceBinding.unbound'));
    assert.equal(page.element.clicked, 0);
  });

  await t.test('unchanged weak row also requires a fresh confirmation', child => {
    const row = new FakeRow({ controls: [checkbox('on', { name: 'selected' })] });
    const page = setup({ row });
    child.after(() => page.restore());
    const first = challenge();
    const result = replay(first.approvalContext);
    assert.equal(result.confirmationRequired, true);
    assert.deepEqual(result.diagnostics.changedFields, ['resourceBinding.unbound']);
    assert.equal(page.element.clicked, 0);
  });
});

test('unchanged strong-bound target clicks exactly once after approval', t => {
  const page = setup();
  t.after(() => page.restore());
  const first = challenge();
  assert.equal(first.approvalContext.resourceBinding.state, 'strong-unique');
  const result = replay(first.approvalContext);
  assert.equal(result.clicked, true);
  assert.equal(page.element.clicked, 1);
});

test('edit links require a distinct path resource or exact query identity', async t => {
  await t.test('/edit without identity is weak', child => {
    const row = new FakeRow({ links: [editLink('https://example.test/edit')] });
    const page = setup({ row });
    child.after(() => page.restore());
    assert.deepEqual(challenge().approvalContext.resourceBinding, { state: 'unbound-row' });
  });
  await t.test('/edit?id preserves exact identity', child => {
    const link = editLink('https://example.test/edit?id=resource-1');
    const row = new FakeRow({ links: [link] });
    const page = setup({ row });
    child.after(() => page.restore());
    const first = challenge();
    assert.deepEqual(first.approvalContext.resourceBinding.editLinks[0].query, [{ key: 'id', value: 'resource-1' }]);
    link.href = 'https://example.test/edit?id=resource-2';
    link.attrs.href = link.href;
    const result = replay(first.approvalContext);
    assert.equal(result.confirmationRequired, true);
    assert.ok(result.diagnostics.changedFields.includes('resourceBinding.identity'));
  });
  await t.test('distinct canonical edit path is strong', child => {
    const row = new FakeRow({ links: [editLink('https://example.test/resources/resource-1/edit')] });
    const page = setup({ row });
    child.after(() => page.restore());
    assert.equal(challenge().approvalContext.resourceBinding.state, 'strong-unique');
  });
});

test('origin, path, fragment, method, and submitter operation changes fail closed', async t => {
  for (const [name, mutate, changedField] of [
    ['origin', page => { page.form.action = 'https://other.test/manage/pause?token=old&mode=pause&gig_id=gig-1#confirm'; }, 'form.action.origin'],
    ['path', page => { page.form.action = 'https://example.test/manage/delete?token=old&mode=pause&gig_id=gig-1#confirm'; }, 'form.action.pathname'],
    ['fragment', page => { page.form.action = 'https://example.test/manage/pause?token=old&mode=pause&gig_id=gig-1#changed'; }, 'form.action.fragment'],
    ['method', page => { page.form.method = 'get'; }, 'form.method'],
    ['Pause to Delete', page => { page.element.value = 'Delete'; page.element.attrs.value = 'Delete'; }, 'submitter.value'],
  ]) {
    await t.test(name, child => {
      const page = setup();
      child.after(() => page.restore());
      const first = challenge();
      mutate(page);
      const result = replay(first.approvalContext);
      assert.equal(result.confirmationRequired, true);
      assert.ok(result.diagnostics.changedFields.includes(changedField));
      assert.equal(page.element.clicked, 0);
    });
  }
});

test('image submit inputs are consequential native submitters', t => {
  const page = setup({ type: 'image', value: '' });
  t.after(() => page.restore());
  const result = challenge();
  assert.equal(result.confirmationRequired, true);
  assert.equal(result.approvalContext.submitter.type, 'image');
  assert.equal(page.element.clicked, 0);
});

test('non-HTTP and credential-bearing actions retain exact opaque raw comparison', async t => {
  for (const [name, original, changed] of [
    ['non-http', 'javascript:submitOne()', 'javascript:submitTwo()'],
    ['credentials', 'https://user:secret@example.test/pause?x=1', 'https://user:other@example.test/pause?x=1'],
    ['unparsable', 'http://[invalid-one', 'http://[invalid-two'],
  ]) {
    await t.test(name, child => {
      const page = setup({ form: { action: original, method: 'post', enctype: 'text/plain', id: 'f', name: 'f' } });
      child.after(() => page.restore());
      const first = challenge();
      assert.deepEqual(first.approvalContext.form.action, { kind: 'opaque', raw: original });
      page.form.action = changed;
      const result = replay(first.approvalContext);
      assert.equal(result.confirmationRequired, true);
      assert.ok(result.diagnostics.changedFields.includes('form.action.raw'));
      assert.equal(page.element.clicked, 0);
    });
  }
});

test('same-injection document identity change fails closed', t => {
  const page = setup();
  t.after(() => page.restore());
  const first = challenge();
  globalThis.location.href = 'https://example.test/other-document';
  const result = replay(first.approvalContext);
  assert.equal(result.confirmationRequired, true);
  assert.ok(result.diagnostics.changedFields.includes('document.href'));
  assert.equal(page.element.clicked, 0);
});

test('same URL with changed timeOrigin fails closed', t => {
  const page = setup({ timeOrigin: 1000 });
  t.after(() => page.restore());
  const first = challenge();
  globalThis.performance.timeOrigin = 2000;
  const result = replay(first.approvalContext);
  assert.equal(result.confirmationRequired, true);
  assert.ok(result.diagnostics.changedFields.includes('document.timeOrigin'));
  assert.equal(globalThis.location.href, first.approvalContext.document.href);
  assert.equal(page.element.clicked, 0);
});

test('formaction, formmethod, and formenctype overrides are effective and replay-exact', async t => {
  const original = {
    attrs: { formaction: '/override/pause?nonce=abc#keep', formmethod: 'get', formenctype: 'multipart/form-data' },
    formAction: 'https://example.test/override/pause?nonce=abc#keep',
    formMethod: 'get',
    formEnctype: 'multipart/form-data',
  };
  const page = setup(original);
  t.after(() => page.restore());
  const first = challenge();
  assert.deepEqual(first.approvalContext.form.action, {
    kind: 'http', origin: 'https://example.test', pathname: '/override/pause',
    query: [{ key: 'nonce', value: 'abc' }], fragment: '#keep',
  });
  assert.equal(first.approvalContext.form.method, 'GET');
  assert.equal(first.approvalContext.form.enctype, 'multipart/form-data');

  for (const [name, mutate, changedField] of [
    ['formaction', element => { element.attrs.formaction = '/override/delete?nonce=abc#keep'; element.formAction = 'https://example.test/override/delete?nonce=abc#keep'; }, 'form.action.pathname'],
    ['formmethod', element => { element.attrs.formmethod = 'post'; element.formMethod = 'post'; }, 'form.method'],
    ['formenctype', element => { element.attrs.formenctype = 'text/plain'; element.formEnctype = 'text/plain'; }, 'form.enctype'],
  ]) {
    await t.test(name, () => {
      const saved = { attrs: { ...page.element.attrs }, formAction: page.element.formAction, formMethod: page.element.formMethod, formEnctype: page.element.formEnctype };
      mutate(page.element);
      const result = replay(first.approvalContext);
      assert.equal(result.confirmationRequired, true);
      assert.ok(result.diagnostics.changedFields.includes(changedField));
      page.element.attrs = saved.attrs;
      page.element.formAction = saved.formAction;
      page.element.formMethod = saved.formMethod;
      page.element.formEnctype = saved.formEnctype;
    });
  }
});

test('focus-time row and query mutation is detected before click', t => {
  let page;
  page = setup({ onFocus: () => {
    page.form.action = 'https://example.test/manage/pause?token=changed&mode=pause&gig_id=gig-1#confirm';
    page.element.row = new FakeRow({ controls: [checkbox('resource-2')] });
  } });
  t.after(() => page.restore());
  const first = challenge();
  const result = replay(first.approvalContext);
  assert.equal(result.confirmationRequired, true);
  assert.ok(result.diagnostics.changedFields.includes('form.action.query.value'));
  assert.ok(result.diagnostics.changedFields.includes('resourceBinding.identity'));
  assert.equal(page.element.clicked, 0);
});

test('mismatch diagnostics contain only controlled paths, never raw values', t => {
  const page = setup({ row: null });
  t.after(() => page.restore());
  const first = challenge();
  assert.deepEqual(first.approvalContext.resourceBinding, { state: 'no-container' });
  page.form.action = 'https://private-secret.example/sensitive-account?token=raw-secret#private-fragment';
  page.element.id = 'private-identifier';
  const result = replay(first.approvalContext);
  const diagnostics = JSON.stringify({ summary: result.summary, diagnostics: result.diagnostics });
  assert.equal(result.confirmationRequired, true);
  assert.doesNotMatch(diagnostics, /private-secret|sensitive-account|raw-secret|private-fragment|private-identifier/);
  assert.match(diagnostics, /form\.action\.origin|submitter\.id/);
});

test('text locators share the versioned semantic context', t => {
  const page = setup();
  t.after(() => page.restore());
  const first = clickSemanticTarget('text', 'Pause', false, null);
  assert.equal(first.approvalContext.version, 3);
  assert.deepEqual(first.approvalContext.locator, { kind: 'text', value: 'Pause' });
  assert.equal(first.approvalContext.document.href, 'https://example.test/manage');
});
