import assert from 'node:assert/strict';
import test from 'node:test';

test('network controller recursively routes capture and request/response interception through child sessions', async t => {
  const storage = {};
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        async get(key) { return { [key]: storage[key] }; },
        async set(value) { Object.assign(storage, structuredClone(value)); },
      },
    },
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  t.after(() => { delete globalThis.chrome; });

  const { NetworkController } = await import(`../extension/network.js?test=${Date.now()}`);
  const manager = new FakeManager();
  const controller = new NetworkController(manager);

  await controller.start(7);
  await controller.onAttachedTarget({ tabId: 7 }, {
    sessionId: 'frame-1',
    targetInfo: { targetId: 'target-frame-1', type: 'iframe', url: 'https://frame.example.test/' },
    waitingForDebugger: true,
  });
  await controller.onAttachedTarget({ tabId: 7, sessionId: 'frame-1' }, {
    sessionId: 'worker-1',
    targetInfo: { targetId: 'target-worker-1', type: 'worker', url: 'https://frame.example.test/worker.js' },
    waitingForDebugger: true,
  });

  assert.ok(manager.commands.some(command => command.method === 'Target.setAutoAttach' && command.source.sessionId === 'frame-1'));
  assert.ok(manager.commands.some(command => command.method === 'Network.enable' && command.source.sessionId === 'worker-1'));
  assert.ok(manager.commands.some(command => command.method === 'Runtime.runIfWaitingForDebugger' && command.source.sessionId === 'worker-1'));

  controller.onEvent({ tabId: 7 }, 'Network.requestWillBeSent', networkRequest('same-id', 'https://root.example.test/api?ABC123'));
  controller.onEvent({ tabId: 7, sessionId: 'frame-1' }, 'Network.requestWillBeSent', networkRequest('same-id', 'https://frame.example.test/api'));
  controller.onEvent({ tabId: 7, sessionId: 'frame-1' }, 'Network.responseReceived', networkResponse('same-id', 200));
  controller.onEvent({ tabId: 7, sessionId: 'frame-1' }, 'Network.loadingFinished', { requestId: 'same-id', encodedDataLength: 12, timestamp: 2 });

  const captured = controller.list(7).requests;
  assert.equal(captured.length, 2);
  assert.notEqual(captured[0].requestId, captured[1].requestId);
  assert.match(captured.find(request => request.targetType === 'iframe').requestId, /-S1:same-id$/);
  assert.deepEqual(controller.summary(7).requests.find(request => request.host === 'root.example.test').queryKeys, ['[redacted]']);

  manager.responses.set('Network.getResponseBody', { body: '{"ok":true}', base64Encoded: false });
  const iframeRequest = captured.find(request => request.targetType === 'iframe');
  const body = await controller.body(7, iframeRequest.requestId);
  assert.equal(body.body, '{"ok":true}');
  assert.equal(manager.commands.at(-1).source.sessionId, 'frame-1');
  assert.equal(manager.commands.at(-1).params.requestId, 'same-id');

  await controller.setRule('rewrite', {
    match: { urlPattern: '*://frame.example.test/api*', methods: ['POST'], resourceTypes: ['XHR'], statusCodes: [200] },
    request: { body: { jsonSet: [{ path: 'amount', value: 1 }] } },
    response: { statusCode: 201, body: { jsonSet: [{ path: 'modified', value: true }] } },
  });
  await controller.setRule('bodyless', {
    match: { urlPattern: '*://frame.example.test/bodyless*', statusCodes: [200] },
    response: {
      statusCode: 204,
      headers: { set: [{ name: 'Content-Length', value: '7' }] },
      body: { text: 'ignored' },
    },
  });
  await controller.setRule('multiple', {
    match: { urlPattern: '*://frame.example.test/multiple*', statusCodes: [300] },
    response: { body: { text: 'changed choices' } },
  });
  const activeNames = 'rewrite bodyless multiple';
  const challenge = await controller.startInterception(7, activeNames, false, null);
  assert.equal(challenge.confirmationRequired, true);
  await controller.startInterception(7, activeNames, true, challenge.approvalContext);

  const requestCommandStart = manager.commands.length;
  controller.onRequestPaused({ tabId: 7, sessionId: 'frame-1' }, {
    requestId: 'fetch-request-1',
    request: { url: 'https://frame.example.test/api/order', method: 'POST', headers: { 'Content-Type': 'application/json' }, postData: '{"amount":99}' },
    resourceType: 'XHR',
  });
  await waitFor(() => manager.commands.slice(requestCommandStart).some(command => command.method === 'Fetch.continueRequest'));
  const continued = manager.commands.slice(requestCommandStart).find(command => command.method === 'Fetch.continueRequest');
  assert.equal(continued.source.sessionId, 'frame-1');
  assert.equal(Buffer.from(continued.params.postData, 'base64').toString(), '{"amount":1}');

  manager.responses.set('Fetch.getResponseBody', { body: '{"modified":false}', base64Encoded: false });
  const delayedBody = manager.deferNext('Fetch.getResponseBody');
  const responseCommandStart = manager.commands.length;
  controller.onRequestPaused({ tabId: 7, sessionId: 'frame-1' }, {
    requestId: 'fetch-response-1',
    request: { url: 'https://frame.example.test/api/order', method: 'POST', headers: {} },
    resourceType: 'XHR',
    responseStatusCode: 200,
    responseStatusText: 'OK',
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Content-Length', value: '18' }],
  });
  await waitFor(() => manager.commands.slice(responseCommandStart).some(command => command.method === 'Fetch.getResponseBody'));
  assert.equal([...controller.state(7).paused.values()][0].watchdogArmed, false);
  assert.equal(manager.commands.slice(responseCommandStart).some(command => command.method === 'Fetch.continueRequest'), false);
  const stopDuringBodyRead = controller.stopInterception(7);
  await waitFor(() => controller.state(7).interceptionActive === false);
  assert.equal(manager.commands.slice(responseCommandStart).some(command => command.method === 'Fetch.disable'), false);
  delayedBody.resolve({});
  await waitFor(() => manager.commands.slice(responseCommandStart).some(command => command.method === 'Fetch.fulfillRequest'));
  await stopDuringBodyRead;
  const fulfilled = manager.commands.slice(responseCommandStart).find(command => command.method === 'Fetch.fulfillRequest');
  assert.equal(fulfilled.source.sessionId, 'frame-1');
  assert.equal(fulfilled.params.responseCode, 201);
  assert.equal(Object.hasOwn(fulfilled.params, 'responsePhrase'), false);
  assert.equal(Buffer.from(fulfilled.params.body, 'base64').toString(), '{"modified":true}');
  assert.equal(fulfilled.params.responseHeaders.some(header => header.name.toLowerCase() === 'content-length'), false);

  const restartChallenge = await controller.startInterception(7, activeNames, false, null);
  await controller.startInterception(7, activeNames, true, restartChallenge.approvalContext);

  const bodylessCommandStart = manager.commands.length;
  controller.onRequestPaused({ tabId: 7, sessionId: 'frame-1' }, {
    requestId: 'fetch-response-bodyless',
    request: { url: 'https://frame.example.test/bodyless', method: 'GET', headers: {} },
    resourceType: 'XHR',
    responseStatusCode: 200,
    responseStatusText: 'OK',
    responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }, { name: 'Content-Length', value: '4' }],
  });
  await waitFor(() => manager.commands.slice(bodylessCommandStart).some(command => command.method === 'Fetch.fulfillRequest'));
  const bodylessCommands = manager.commands.slice(bodylessCommandStart);
  const bodyless = bodylessCommands.find(command => command.method === 'Fetch.fulfillRequest');
  assert.equal(bodylessCommands.some(command => command.method === 'Fetch.getResponseBody'), false);
  assert.equal(bodyless.params.responseCode, 204);
  assert.equal(bodyless.params.body, '');
  assert.equal(bodyless.params.responseHeaders.some(header => header.name.toLowerCase() === 'content-length'), false);

  manager.responses.set('Fetch.getResponseBody', { body: 'original choices', base64Encoded: false });
  const multipleCommandStart = manager.commands.length;
  controller.onRequestPaused({ tabId: 7, sessionId: 'frame-1' }, {
    requestId: 'fetch-response-multiple',
    request: { url: 'https://frame.example.test/multiple', method: 'GET', headers: {} },
    resourceType: 'Document',
    responseStatusCode: 300,
    responseStatusText: 'Multiple Choices',
    responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }],
  });
  await waitFor(() => manager.commands.slice(multipleCommandStart).some(command => command.method === 'Fetch.fulfillRequest'));
  const multipleCommands = manager.commands.slice(multipleCommandStart);
  const multiple = multipleCommands.find(command => command.method === 'Fetch.fulfillRequest');
  assert.equal(multipleCommands.some(command => command.method === 'Fetch.getResponseBody'), false);
  assert.equal(Buffer.from(multiple.params.body, 'base64').toString(), 'changed choices');
  assert.equal(multiple.params.responsePhrase, 'Multiple Choices');

  const delayedContinue = manager.deferNext('Fetch.continueRequest');
  const delayedCommandStart = manager.commands.length;
  controller.onRequestPaused({ tabId: 7, sessionId: 'frame-1' }, {
    requestId: 'fetch-delayed',
    request: { url: 'https://frame.example.test/unmatched', method: 'GET', headers: {} },
    resourceType: 'XHR',
  });
  await waitFor(() => manager.commands.slice(delayedCommandStart).some(command => command.method === 'Fetch.continueRequest'));
  assert.equal(controller.state(7).paused.size, 1);
  delayedContinue.resolve({});
  await waitFor(() => controller.state(7).paused.size === 0);

  const delayedEnable = manager.deferNext('Network.enable');
  const attachCommandStart = manager.commands.length;
  const attaching = controller.onAttachedTarget({ tabId: 7 }, {
    sessionId: 'worker-race',
    targetInfo: { targetId: 'target-worker-race', type: 'worker', url: 'https://frame.example.test/race.js' },
    waitingForDebugger: true,
  });
  await waitFor(() => manager.commands.slice(attachCommandStart).some(command => command.method === 'Network.enable' && command.source.sessionId === 'worker-race'));
  const stoppingCapture = controller.stop(7);
  delayedEnable.resolve({});
  await Promise.all([attaching, stoppingCapture]);
  assert.equal(controller.state(7).targets.get('worker-race').networkEnabled, false);
  assert.equal(controller.state(7).targets.get('worker-race').fetchEnabled, true);
  assert.equal(manager.commands.every(command => command.options?.attach === false), true);

  const delayedDisable = manager.deferNext('Fetch.disable');
  const disableCommandStart = manager.commands.length;
  const stoppingNamed = controller.stopInterception(7);
  await waitFor(() => manager.commands.slice(disableCommandStart).some(command => command.method === 'Fetch.disable'));
  const addingLegacy = controller.addModifier(7, '/checkout', 'amount', 1);
  assert.equal(controller.state(7).modifiers.length, 0);
  delayedDisable.resolve({});
  await Promise.all([stoppingNamed, addingLegacy]);
  assert.equal(controller.state(7).interceptionMode, 'legacy');
  assert.equal(controller.state(7).modifiers.length, 1);
  assert.equal(controller.state(7).targets.get('root').fetchEnabled, true);
  await controller.clearModifiers(7);
  await controller.setRule('constructor', { request: { block: 'Aborted' } });
  await controller.setRule('toString', { request: { block: 'Aborted' } });
  assert.equal((await controller.listRules('constructor')).rules[0].name, 'constructor');
  assert.equal((await controller.listRules('toString')).rules[0].name, 'toString');
  await controller.cleanup(7);

  manager.pinError = new Error('pin failed');
  await assert.rejects(controller.addModifier(8, '/checkout', 'amount', 1), /pin failed/);
  assert.deepEqual(controller.state(8).modifiers, []);
  assert.equal(controller.state(8).interceptionMode, null);

  await controller.addModifier(9, '/checkout', 'amount', 1);
  const namedStop = await controller.stopInterception(9);
  assert.equal(namedStop.stopped, false);
  assert.equal(namedStop.active, true);
  assert.equal(namedStop.mode, 'legacy');
  await controller.clearModifiers(9);
  await controller.cleanup(8);
  await controller.cleanup(9);
});

class FakeManager {
  constructor() {
    this.commands = [];
    this.responses = new Map();
    this.events = [];
    this.detaches = [];
    this.deferred = new Map();
    this.pinError = null;
  }
  onEvent(listener) { this.events.push(listener); return () => {}; }
  onDetach(listener) { this.detaches.push(listener); return () => {}; }
  async attach(tabId) { this.attached = tabId; }
  async pin() {
    if (!this.pinError) return;
    const error = this.pinError;
    this.pinError = null;
    throw error;
  }
  unpin() {}
  async detach() {}
  async sendSession(source, method, params = {}, options = {}) {
    this.commands.push({ source: { ...source }, method, params: structuredClone(params), options: structuredClone(options) });
    const deferred = this.deferred.get(method)?.shift();
    if (deferred) await deferred.promise;
    return structuredClone(this.responses.get(method) || {});
  }
  deferNext(method) {
    const item = deferred();
    const queue = this.deferred.get(method) || [];
    queue.push(item);
    this.deferred.set(method, queue);
    return item;
  }
}

function networkRequest(requestId, url) {
  return {
    requestId,
    loaderId: 'loader',
    request: { url, method: 'GET', headers: {} },
    type: 'XHR',
    timestamp: 1,
    wallTime: 1,
    initiator: { type: 'script' },
  };
}

function networkResponse(requestId, status) {
  return {
    requestId,
    response: { status, statusText: 'OK', headers: {}, mimeType: 'application/json', protocol: 'h2' },
    timestamp: 2,
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Condition was not reached');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
