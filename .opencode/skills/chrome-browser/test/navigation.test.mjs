import assert from 'node:assert/strict';
import test from 'node:test';
import { navigateAndWait, reloadAndWait, waitForLoad, waitForUrl } from '../extension/navigation.js';

test('navigation waits for a new ready document and reports the final URL', async t => {
  const fake = installChrome();
  t.after(fake.restore);
  fake.state = { url: 'https://example.test/old', readyState: 'complete', documentKey: 'old' };
  fake.onUpdate = url => { fake.state = { url, readyState: 'interactive', documentKey: 'new' }; };

  const result = await navigateAndWait(7, 'https://example.test/new');
  assert.equal(result.loaded, true);
  assert.equal(result.url, 'https://example.test/new');
  assert.equal(result.documentKey, 'new');
  assert.deepEqual(fake.updates, [{ tabId: 7, properties: { url: 'https://example.test/new' } }]);
});

test('reload waits for a replacement document at the same URL', async t => {
  const fake = installChrome();
  t.after(fake.restore);
  fake.state = { url: 'https://example.test/', readyState: 'complete', documentKey: 'old' };
  fake.onReload = () => { fake.state = { url: 'https://example.test/', readyState: 'complete', documentKey: 'new' }; };

  const result = await reloadAndWait(7);
  assert.equal(result.reloaded, true);
  assert.equal(result.documentKey, 'new');
  assert.deepEqual(fake.reloads, [7]);
});

test('fragment navigation accepts the same document but requires the exact destination URL', async t => {
  const fake = installChrome();
  t.after(fake.restore);
  fake.state = { url: 'https://example.test/page#old', readyState: 'complete', documentKey: 'same' };
  fake.onUpdate = url => { fake.state = { url, readyState: 'complete', documentKey: 'same' }; };
  const result = await navigateAndWait(7, 'https://example.test/page#new', 100);
  assert.equal(result.url, 'https://example.test/page#new');
  assert.equal(result.documentKey, 'same');
});

test('CDP navigation accepts redirects only for the initiated loader', async t => {
  const fake = installChrome();
  t.after(fake.restore);
  fake.state = { url: 'https://example.test/old', readyState: 'complete', documentKey: 'old' };
  const manager = {
    async send(_tabId, method) {
      if (method === 'Page.enable') return {};
      if (method === 'Page.navigate') {
        fake.state = { url: 'https://example.test/canonical/', readyState: 'complete', documentKey: 'new' };
        return { loaderId: 'initiated-loader' };
      }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { loaderId: 'initiated-loader' } } };
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  const result = await navigateAndWait(7, 'http://example.test/start', 100, manager);
  assert.equal(result.url, 'https://example.test/canonical/');
  assert.deepEqual(fake.updates, []);
});

test('URL and load waits support wildcards and bounded timeout diagnostics', async t => {
  const fake = installChrome();
  t.after(fake.restore);
  fake.state = { url: 'https://example.test/dashboard/42', readyState: 'interactive', documentKey: 'doc' };
  assert.equal((await waitForUrl(7, '*dashboard/*', 100)).matched, true);
  assert.equal((await waitForLoad(7, 'domcontentloaded', 100)).loaded, true);
  await assert.rejects(waitForUrl(7, '*missing*', 100), error => {
    assert.equal(error.code, 'timeout');
    assert.equal(error.details.lastUrl, 'https://example.test/dashboard/42');
    return true;
  });
});

function installChrome() {
  const previous = globalThis.chrome;
  const fake = {
    state: null,
    updates: [],
    reloads: [],
    onUpdate: null,
    onReload: null,
    restore() { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; },
  };
  globalThis.chrome = {
    scripting: {
      async executeScript() { return [{ frameId: 0, documentId: fake.state.documentKey, result: { ...fake.state } }]; },
    },
    tabs: {
      async update(tabId, properties) { fake.updates.push({ tabId, properties }); fake.onUpdate?.(properties.url); },
      async reload(tabId) { fake.reloads.push(tabId); fake.onReload?.(); },
    },
  };
  return fake;
}
