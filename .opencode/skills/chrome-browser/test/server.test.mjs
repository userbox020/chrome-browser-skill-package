import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { EXTENSION_ORIGIN } from '../extension/identity.js';
import { startServer } from '../src/server.mjs';
import { VERSION, CAPABILITIES } from '../extension/version.js';

test('server authenticates commands and enforces static and dynamic challenges', async t => {
  const temp = mkdtempSync(resolve(tmpdir(), 'chrome-browser-test-'));
  const stateFile = resolve(temp, 'server.json');
  const pairingSecret = '11'.repeat(32);
  const server = await startServer({ port: 0, stateFile, pairingSecret, handshakeTimeout: 100 });
  const base = `http://${server.host}:${server.port}`;

  t.after(async () => {
    await server.close();
    rmSync(temp, { recursive: true, force: true });
  });

  const healthBefore = await fetch(`${base}/health`).then(response => response.json());
  assert.equal(healthBefore.extensionConnected, false);

  const forbiddenPairing = await fetch(`${base}/pair`);
  assert.equal(forbiddenPairing.status, 403);
  const localPairing = await fetch(`${base}/pair`, { headers: { Origin: EXTENSION_ORIGIN } });
  assert.equal(localPairing.status, 200);
  assert.equal(localPairing.headers.get('access-control-allow-private-network'), 'true');
  assert.match((await localPairing.json()).url, new RegExp(`^${EXTENSION_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pair\\.html#[a-f0-9]{64}$`));
  const pairingPreflight = await fetch(`${base}/pair`, { method: 'OPTIONS', headers: { Origin: EXTENSION_ORIGIN, 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(pairingPreflight.status, 204);
  assert.equal(pairingPreflight.headers.get('access-control-allow-private-network'), 'true');

  const unauthorized = await fetch(`${base}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'tabs.list', args: {} }),
  });
  assert.equal(unauthorized.status, 401);

  const wrongOriginStatus = await rejectedWebSocketStatus(`ws://${server.host}:${server.port}/extension`, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(wrongOriginStatus, 403);

  const wrongProtocol = new WebSocket(`ws://${server.host}:${server.port}/extension`, { origin: EXTENSION_ORIGIN });
  await once(wrongProtocol, 'open');
  await authenticate(wrongProtocol, pairingSecret, 999);
  const [wrongProtocolCode] = await once(wrongProtocol, 'close');
  assert.equal(wrongProtocolCode, 4003);
  await waitFor(async () => !(await fetch(`${base}/health`).then(response => response.json())).extensionConnected);

  const unauthenticatedExtension = new WebSocket(`ws://${server.host}:${server.port}/extension`, { origin: EXTENSION_ORIGIN });
  await once(unauthenticatedExtension, 'open');
  unauthenticatedExtension.send(JSON.stringify({ type: 'ready', protocol: 1, version: '2.0.0', proof: '00'.repeat(32) }));
  const [unauthenticatedCode] = await once(unauthenticatedExtension, 'close');
  assert.equal(unauthenticatedCode, 4003);

  const idleCandidate = new WebSocket(`ws://${server.host}:${server.port}/extension`, { origin: EXTENSION_ORIGIN });
  await once(idleCandidate, 'open');

  const extension = new WebSocket(`ws://${server.host}:${server.port}/extension`, {
    origin: EXTENSION_ORIGIN,
  });
  await once(extension, 'open');
  t.after(() => extension.close());

  const notReady = await fetch(`${base}/health`).then(response => response.json());
  assert.equal(notReady.extensionConnected, false);

  let contextUrl = 'https://user:pass@shop.example.test/checkout?token=secret#private';
  let holdTabsInfo = false;
  let resolveHeldCommand;
  let heldTabsInfoMessage;
  let pageEvalExecutions = 0;
  let structuredFailure = false;
  let lastRequestSendArgs = null;

  extension.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'command') return;
    if (message.cmd === 'system.status') {
      extension.send(JSON.stringify({ type: 'result', id: message.id, ok: true, result: { selectedTab: { tabId: 7, url: contextUrl, title: 'Fixture' } } }));
      return;
    }
    if (message.cmd === 'system.context') {
      extension.send(JSON.stringify({ type: 'result', id: message.id, ok: true, result: { tabId: 7, url: contextUrl, origin: 'https://shop.example.test', title: 'Order for Alice', documentId: `1:${contextUrl}` } }));
      return;
    }
    if (message.cmd === 'tabs.info' && structuredFailure) {
      extension.send(JSON.stringify({ type: 'result', id: message.id, ok: false, error: 'Element is obscured', code: 'obscured', details: { targetUrl: 'https://example.test/private?token=secret', matchCount: 2 } }));
      return;
    }
    if (message.cmd === 'tabs.info' && holdTabsInfo) {
      heldTabsInfoMessage = message;
      resolveHeldCommand?.();
      return;
    }
    if (message.cmd === 'page.eval') pageEvalExecutions++;
    if (message.cmd === 'request.send') lastRequestSendArgs = message.args;
    if (message.cmd === 'click' && !message.args.confirmed) {
      extension.send(JSON.stringify({ type: 'result', id: message.id, ok: true, result: { confirmationRequired: true, summary: 'Click Pay now', approvalContext: { selector: '#pay', label: 'Pay now' } } }));
      return;
    }
    if (message.cmd === 'intercept.start' && !message.args.confirmed) {
      extension.send(JSON.stringify({ type: 'result', id: message.id, ok: true, result: {
        confirmationRequired: true,
        summary: 'Start interception with checkout',
        approvalContext: { scope: 'selected-tab-and-related-iframe-worker-targets', names: ['checkout'], ruleSetDigest: 'abc123', rules: [{ name: 'checkout', stages: ['Request', 'Response'] }] },
      } }));
      return;
    }
    extension.send(JSON.stringify({ type: 'result', id: message.id, ok: true, result: { command: message.cmd, confirmed: message.args.confirmed, approvalContext: message.args.approvalContext || null } }));
  });

  await authenticate(extension, pairingSecret);
  await waitFor(async () => (await fetch(`${base}/health`).then(response => response.json())).extensionConnected);
  const [idleCandidateCode] = await once(idleCandidate, 'close');
  assert.equal(idleCandidateCode, 4004);

  const duplicate = new WebSocket(`ws://${server.host}:${server.port}/extension`, { origin: EXTENSION_ORIGIN });
  await once(duplicate, 'open');
  const [duplicateCode] = await once(duplicate, 'close');
  assert.equal(duplicateCode, 4002);

  const healthAfter = await fetch(`${base}/health`).then(response => response.json());
  assert.equal(healthAfter.extensionConnected, true);
  assert.equal(healthAfter.extensionVersion, VERSION);
  const metadata = await fetch(`${base}/admin/status`, { method: 'POST', headers: { Authorization: `Bearer ${server.token}` } }).then(response => response.json());
  assert.equal(metadata.result.selectedTab.tabId, 7);
  assert.deepEqual(metadata.result.extensionCapabilities, CAPABILITIES);
  assert.doesNotMatch(JSON.stringify(metadata), /token=secret|user:pass/);

  const normal = await command(base, server.token, { cmd: 'tabs.list', args: {} });
  assert.equal(normal.status, 200);
  assert.deepEqual(normal.body.result, { command: 'tabs.list', approvalContext: null });

  structuredFailure = true;
  const failed = await command(base, server.token, { cmd: 'tabs.info', args: {} });
  structuredFailure = false;
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, 'obscured');
  assert.equal(failed.body.error, 'Another element covers the target.');
  assert.equal(failed.body.details.matchCount, 2);
  assert.doesNotMatch(failed.body.details.targetUrl, /token=secret/);

  const staticFirst = await command(base, server.token, { cmd: 'request.modify', args: { urlFilter: 'checkout', jsonKey: 'total', value: 1 } });
  assert.equal(staticFirst.status, 409);
  assert.equal(staticFirst.body.confirmationRequired, true);
  assert.equal(staticFirst.body.target.tabId, 7);
  assert.doesNotMatch(staticFirst.body.target.url, /user:pass|token=secret|private/);
  assert.match(staticFirst.body.target.title, /^\[redacted:/);
  assert.match(staticFirst.body.summary, /request\.modify|checkout/);
  assert.doesNotMatch(staticFirst.body.summary, /total/);
  assert.doesNotMatch(staticFirst.body.summary, /"value":1/);
  assert.match(staticFirst.body.summary, /\[redacted:/);

  const sensitiveFilter = await command(base, server.token, {
    cmd: 'request.modify',
    args: { urlFilter: 'https://user:pass@example.test/checkout?token=secret', jsonKey: 'total', value: 1 },
  });
  assert.equal(sensitiveFilter.status, 409);
  assert.doesNotMatch(sensitiveFilter.body.summary, /user:pass|token=secret/);
  assert.match(sensitiveFilter.body.summary, /checkout|token=\[redacted\]/);

  const sensitiveUrl = await command(base, server.token, {
    cmd: 'request.send',
    args: { method: 'POST', url: 'https://user:pass@example.test/pay?token=secret', body: { amount: 1 } },
  });
  assert.equal(sensitiveUrl.status, 409);
  assert.doesNotMatch(sensitiveUrl.body.summary, /user:pass|token=secret/);
  assert.match(sensitiveUrl.body.summary, /pay|redacted/);

  const staticConfirmed = await command(base, server.token, {
    cmd: 'request.modify',
    args: { urlFilter: 'checkout', jsonKey: 'total', value: 1 },
    confirm: staticFirst.body.challenge,
  });
  assert.equal(staticConfirmed.status, 200);
  assert.equal(staticConfirmed.body.result.confirmed, true);

  const dynamicFirst = await command(base, server.token, { cmd: 'click', args: { selector: '#pay' } });
  assert.equal(dynamicFirst.status, 409);
  assert.equal(dynamicFirst.body.summary, 'Confirm click on the selected tab');

  const dynamicConfirmed = await command(base, server.token, {
    cmd: 'click',
    args: { selector: '#pay' },
    confirm: dynamicFirst.body.challenge,
  });
  assert.equal(dynamicConfirmed.status, 200);
  assert.equal(dynamicConfirmed.body.result.confirmed, true);
  assert.deepEqual(dynamicConfirmed.body.result.approvalContext, { selector: '#pay', label: 'Pay now' });

  const relativeRequest = await command(base, server.token, { cmd: 'request.send', args: { method: 'POST', url: '/api/pay', body: '{}' } });
  const relativeConfirmed = await command(base, server.token, { cmd: 'request.send', args: { method: 'POST', url: '/api/pay', body: '{}' }, confirm: relativeRequest.body.challenge });
  assert.equal(relativeConfirmed.status, 200);
  assert.equal(lastRequestSendArgs.url, 'https://shop.example.test/api/pay');
  assert.equal(lastRequestSendArgs.expectedBrowserContext.documentId, `1:${contextUrl}`);

  const interceptFirst = await command(base, server.token, { cmd: 'intercept.start', args: { names: 'checkout' } });
  assert.equal(interceptFirst.status, 409);
  assert.equal(interceptFirst.body.target.tabId, 7);
  assert.match(interceptFirst.body.details.ruleSetDigest, /^\[redacted:/);
  const interceptConfirmed = await command(base, server.token, {
    cmd: 'intercept.start',
    args: { names: 'checkout' },
    confirm: interceptFirst.body.challenge,
  });
  assert.equal(interceptConfirmed.status, 200);
  assert.equal(interceptConfirmed.body.result.confirmed, true);

  const reused = await command(base, server.token, {
    cmd: 'click',
    args: { selector: '#pay' },
    confirm: dynamicFirst.body.challenge,
  });
  assert.equal(reused.status, 409);
  assert.match(reused.body.error, /invalid|expired|already used/i);

  const contextFirst = await command(base, server.token, { cmd: 'page.eval', args: { expression: 'location.href' } });
  assert.equal(contextFirst.status, 409);
  contextUrl = 'https://shop.example.test/account';
  const changedContext = await command(base, server.token, {
    cmd: 'page.eval',
    args: { expression: 'location.href' },
    confirm: contextFirst.body.challenge,
  });
  assert.equal(changedContext.status, 409);
  assert.match(changedContext.body.error, /different arguments|invalid|expired/i);

  const queuedChallenge = await command(base, server.token, { cmd: 'page.eval', args: { expression: 'document.cookie' } });
  assert.equal(queuedChallenge.status, 409);
  holdTabsInfo = true;
  const blockerReceived = new Promise(resolve => { resolveHeldCommand = resolve; });
  const blockerResponse = command(base, server.token, { cmd: 'tabs.info', args: {} });
  await blockerReceived;
  const busyStop = await fetch(`${base}/admin/stop`, { method: 'POST', headers: { Authorization: `Bearer ${server.token}` } });
  assert.equal((await busyStop.json()).code, 'bridge-busy');
  const controller = new AbortController();
  const queuedFetch = fetch(`${base}/cmd`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${server.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'page.eval', args: { expression: 'document.cookie' }, confirm: queuedChallenge.body.challenge }),
    signal: controller.signal,
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(queuedFetch, /abort/i);
  holdTabsInfo = false;
  extension.send(JSON.stringify({ type: 'result', id: heldTabsInfoMessage.id, ok: true, result: { command: 'tabs.info' } }));
  await blockerResponse;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(pageEvalExecutions, 0);

  const heldCommand = new Promise(resolve => { resolveHeldCommand = resolve; });
  holdTabsInfo = true;
  const pendingResponse = command(base, server.token, { cmd: 'tabs.info', args: {} });
  await heldCommand;
  const disconnectStarted = Date.now();
  extension.close();
  await once(extension, 'close');
  const disconnected = await pendingResponse;
  assert.equal(disconnected.status, 500);
  assert.equal(disconnected.body.code, 'outcome-unknown');
  assert.match(disconnected.body.next.instruction, /Do not blindly repeat/);
  assert.ok(Date.now() - disconnectStarted < 2_000);
});

async function command(base, token, value) {
  const response = await fetch(`${base}/cmd`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Condition was not reached');
}

function rejectedWebSocketStatus(url, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('error', error => {
      if (!String(error.message).includes('Unexpected server response')) reject(error);
    });
  });
}

async function authenticate(socket, secret, protocol = 1) {
  const clientNonce = randomBytes(32).toString('hex');
  socket.send(JSON.stringify({ type: 'hello', clientNonce }));
  const challenge = await nextMessage(socket, message => message.type === 'challenge');
  const expectedServerProof = hmac(secret, `server:${clientNonce}:${challenge.serverNonce}`);
  assert.equal(challenge.proof, expectedServerProof);
  socket.send(JSON.stringify({
    type: 'ready',
    protocol,
    version: VERSION,
    capabilities: CAPABILITIES,
    proof: hmac(secret, `extension:${clientNonce}:${challenge.serverNonce}`),
  }));
}

function nextMessage(socket, predicate) {
  return new Promise(resolve => {
    const listener = raw => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      socket.off('message', listener);
      resolve(message);
    };
    socket.on('message', listener);
  });
}

function hmac(secret, value) {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(value).digest('hex');
}
