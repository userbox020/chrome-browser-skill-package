import assert from 'node:assert/strict';
import test from 'node:test';

test('CDP screenshots support viewport, full-page, and element clips', async t => {
  const fake = installChrome();
  const { captureScreenshot } = await import(`../extension/capture.js?capture=${Date.now()}`);
  const { domController } = await import('../extension/dom-controller.js');
  const { debuggerManager } = await import('../extension/debugger.js');
  domController.scripting = globalThis.chrome.scripting;
  domController.clear(7);
  t.after(async () => { await debuggerManager.detach(7); fake.restore(); });

  const viewport = await captureScreenshot(7);
  assert.equal(viewport.mode, 'viewport');
  assert.equal(viewport.width, 800);
  assert.equal(viewport.height, 600);
  assert.match(viewport.dataUrl, /^data:image\/png;base64,/);
  assert.equal(viewport.devicePixelRatio, 2);

  const full = await captureScreenshot(7, 'full');
  assert.equal(full.width, 1200);
  assert.equal(full.height, 2400);
  assert.deepEqual(fake.commands.filter(item => item.method === 'Page.captureScreenshot').at(-1).params.clip, { x: 0, y: 0, width: 1200, height: 2400, scale: 1 });

  const clipped = await captureScreenshot(7, 'element', '#save');
  assert.equal(clipped.width, 100);
  assert.equal(clipped.height, 40);
  assert.deepEqual(fake.commands.filter(item => item.method === 'Page.captureScreenshot').at(-1).params.clip, { x: 30, y: 60, width: 100, height: 40, scale: 1 });

  fake.screenshotData = 'a'.repeat(14 * 1024 * 1024 + 1);
  await assert.rejects(captureScreenshot(7), error => error.code === 'screenshot-too-large');
});

function installChrome() {
  const previous = globalThis.chrome;
  const fake = {
    commands: [],
    screenshotData: Buffer.from('png').toString('base64'),
    restore() { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; },
  };
  globalThis.chrome = {
    runtime: { lastError: null },
    scripting: {
      async executeScript(details) {
        const request = details.args[0];
        if (request.op === 'capture-geometry') return [{
          frameId: 0,
          documentId: 'doc',
          result: {
            ok: true,
            bounds: { x: 20, y: 30, width: 100, height: 40 },
            element: { ref: 'r1', frameId: 0, tag: 'button', role: 'button', name: 'Save', state: { visible: true }, bounds: { x: 20, y: 30, width: 100, height: 40 } },
          },
        }];
        throw new Error(`Unexpected operation: ${request.op}`);
      },
    },
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
      attach(_target, _version, callback) { callback(); },
      detach(_target, callback) { callback(); },
      sendCommand(_target, method, params, callback) {
        fake.commands.push({ method, params: structuredClone(params) });
        if (method === 'Page.getLayoutMetrics') return callback({
           cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 10, pageY: 30, scale: 1 },
          cssContentSize: { x: 0, y: 0, width: 1200, height: 2400 },
        });
        if (method === 'Page.captureScreenshot') return callback({ data: fake.screenshotData });
        if (method === 'Runtime.evaluate') return callback({ result: { value: 2 } });
        callback({});
      },
    },
  };
  return fake;
}
