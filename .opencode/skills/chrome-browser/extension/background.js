import { COMMANDS } from './commands.js';
import { VERSION, CAPABILITIES } from './version.js';
import { connectionView } from './connection-state.js';
import { hmacHex, randomNonce, safeEqual } from './auth.js';
import {
  acceptDialog,
  captureConsole,
  dismissDialog,
  emulate,
  evaluate,
  pressKey,
  setGeolocation,
} from './advanced.js';
import { debuggerManager } from './debugger.js';
import { accessibilityController } from './accessibility.js';
import { captureScreenshot } from './capture.js';
import { domController } from './dom-controller.js';
import {
  clickTarget,
  checkTarget,
  clearTarget,
  dragTargets,
  fillTarget,
  focusTarget,
  hoverTarget,
  preparePress,
  scrollToTarget,
  selectTarget,
  typeIntoTarget,
  typeFocused,
  uploadTarget,
  waitForElement,
} from './interaction.js';
import { networkController } from './network.js';
import { httpUrl, navigateAndWait, reloadAndWait, waitForLoad, waitForUrl } from './navigation.js';
import {
  extractForms,
  extractLinks,
  extractTable,
  listTabs,
  pageHtml,
  pageInspect,
  pageContext,
  pageStorage,
  performanceInfo,
  requireSelectedTab,
  scroll,
  selectTab,
  sendPageRequest,
  tabInfo,
} from './page.js';
import {
  callWebMcpTool,
  getWebMcpForm,
  getWebMcpSchema,
  listWebMcpForms,
  listWebMcpTools,
} from './webmcp.js';

const BRIDGE_URL = 'ws://127.0.0.1:9998/extension';
const PROTOCOL_VERSION = 1;
const RECONNECT_DELAY = 2_000;
const PING_INTERVAL = 20_000;

let socket = null;
let reconnectTimer = null;
let pingTimer = null;
let selectedTabId = null;
let clientNonce = null;
let serverAuthenticated = false;
let reconnectImmediately = false;
let pairingRequired = false;
let pendingPairingUrl = null;
let connectionState = 'connecting';
let bridgeVersion = null;
let proofSent = false;

const selectedReady = chrome.storage.session.get('selectedTabId').then(value => {
  if (Number.isInteger(value.selectedTabId)) selectedTabId = value.selectedTabId;
});

const handlers = {
  'system.status': async () => {
    await selectedReady;
    const tab = Number.isInteger(selectedTabId) ? await chrome.tabs.get(selectedTabId).catch(() => null) : null;
    return { selectedTab: tab ? tabInfo(tab, true) : null };
  },
  'system.cleanup': async () => {
    await selectedReady;
    if (Number.isInteger(selectedTabId)) {
      await networkController.cleanup(selectedTabId);
      await debuggerManager.detach(selectedTabId);
      domController.clear(selectedTabId);
      accessibilityController.clear(selectedTabId);
    }
    return { cleaned: true };
  },
  'system.context': async args => withTab(tab => args.shallow
    ? { tabId: tab.id, url: tab.url, origin: new URL(tab.url).origin, title: tab.title || '', documentId: null }
    : pageContext(tab.id)),
  'tabs.list': async args => { await selectedReady; return listTabs(selectedTabId, args); },
  'tabs.use': async args => {
    const info = await selectTab(args.tabId);
    if (Number.isInteger(selectedTabId) && selectedTabId !== info.tabId) {
      domController.clear(selectedTabId);
      accessibilityController.clear(selectedTabId);
      await networkController.cleanup(selectedTabId);
    }
    selectedTabId = info.tabId;
    await chrome.storage.session.set({ selectedTabId });
    return info;
  },
  'tabs.info': async () => withTab(tab => tabInfo(tab, true)),

  'page.snap': async args => withTab(tab => domController.snapshot(tab.id, '', true, args)),
  'page.elements': async args => withTab(tab => domController.snapshot(tab.id, args.query || '', false, args)),
  'page.accessibility': async args => withTab(tab => accessibilityController.elements(tab.id, args.query || '', args)),
  'element.inspect': async args => withTab(tab => accessibilityController.isRef(args.target) ? accessibilityController.describe(tab.id, args.target) : domController.run(tab.id, 'inspect', args.target)),
  'page.html': async args => withTab(tab => pageHtml(tab.id, args.selector)),
  'page.eval': async args => withApprovedTab(args, tab => evaluate(tab.id, args.expression, args.expectedBrowserContext)),
  'page.inspect': async () => withTab(tab => pageInspect(tab.id)),
  'page.storage': async () => withTab(tab => pageStorage(tab.id)),

  navigate: async args => withTab(async tab => {
    domController.clear(tab.id);
    accessibilityController.clear(tab.id);
    return { tabId: tab.id, ...(await navigateAndWait(tab.id, args.url, undefined, debuggerManager)) };
  }),
  open: async args => {
    const parsed = httpUrl(args.url);
    const tab = await chrome.tabs.create({ url: parsed.href, active: true });
    if (Number.isInteger(selectedTabId) && selectedTabId !== tab.id) {
      domController.clear(selectedTabId);
      accessibilityController.clear(selectedTabId);
      await networkController.cleanup(selectedTabId);
    }
    selectedTabId = tab.id;
    await chrome.storage.session.set({ selectedTabId });
    return { ...tabInfo(tab, true), ...(await waitForLoad(tab.id)) };
  },
  reload: async () => withTab(async tab => {
    domController.clear(tab.id);
    accessibilityController.clear(tab.id);
    return { tabId: tab.id, ...(await reloadAndWait(tab.id)) };
  }),

  click: async args => withApprovedTab(args, tab => clickTarget(tab.id, args.selector, 'css', args.confirmed, args.approvalContext)),
  'click-text': async args => withApprovedTab(args, tab => clickTarget(tab.id, args.text, 'text', args.confirmed, args.approvalContext)),
  fill: async args => withTab(tab => fillTarget(tab.id, args.selector, args.value)),
  focus: async args => withTab(tab => focusTarget(tab.id, args.target)),
  'type-into': async args => withTab(tab => typeIntoTarget(tab.id, args.target, args.text)),
  clear: async args => withTab(tab => clearTarget(tab.id, args.target)),
  select: async args => withTab(tab => selectTarget(tab.id, args.target, args.value)),
  check: async args => withApprovedTab(args, tab => checkTarget(tab.id, args.target, true, args.confirmed, args.approvalContext)),
  uncheck: async args => withApprovedTab(args, tab => checkTarget(tab.id, args.target, false, args.confirmed, args.approvalContext)),
  upload: async args => withApprovedTab(args, tab => uploadTarget(tab.id, args.target, args.files, args.confirmed, args.approvalContext)),
  type: async args => withTab(tab => typeFocused(tab.id, args.text)),
  press: async args => withApprovedTab(args, async tab => {
    if (['Enter', 'NumpadEnter', ' ', 'Space'].includes(args.key)) {
      const prepared = await preparePress(tab.id, args.key, args.modifiers, args.confirmed, args.approvalContext);
      if (prepared.confirmationRequired) return prepared;
    }
    return pressKey(tab.id, args.key, args.modifiers);
  }),
  hover: async args => withTab(tab => hoverTarget(tab.id, args.selector)),
  drag: async args => withApprovedTab(args, tab => dragTargets(tab.id, args.fromSelector, args.toSelector, args.confirmed, args.approvalContext)),
  scroll: async args => withTab(tab => scroll(tab.id, args.x, args.y)),
  'scroll-to': async args => withTab(tab => scrollToTarget(tab.id, args.target)),
  screenshot: async () => withTab(tab => captureScreenshot(tab.id)),
  'screenshot.full': async () => withTab(tab => captureScreenshot(tab.id, 'full')),
  'screenshot.element': async args => withTab(tab => captureScreenshot(tab.id, 'element', args.target)),
  'wait.element': async args => withTab(tab => waitForElement(tab.id, args.target, args.state || 'visible', args.timeout)),
  'wait.url': async args => withTab(tab => waitForUrl(tab.id, args.pattern, args.timeout)),
  'wait.load': async args => withTab(tab => waitForLoad(tab.id, args.state || 'domcontentloaded', args.timeout)),

  'network.start': async () => withTab(tab => networkController.start(tab.id)),
  'network.list': async args => withTab(tab => networkController.list(tab.id, args.filter)),
  'network.summary': async args => withTab(tab => networkController.summary(tab.id, args.filter)),
  'network.detail': async args => withTab(tab => networkController.detail(tab.id, args.requestId)),
  'network.body': async args => withTab(tab => networkController.body(tab.id, args.requestId)),
  'network.clear': async () => withTab(tab => networkController.clear(tab.id)),
  'network.stop': async () => withTab(tab => networkController.stop(tab.id)),

  'intercept.rule.set': async args => networkController.setRule(args.name, args.rule),
  'intercept.rule.list': async args => networkController.listRules(args.name),
  'intercept.rule.remove': async args => networkController.removeRule(args.name),
  'intercept.start': async args => withApprovedTab(args, tab => networkController.startInterception(tab.id, args.names, args.confirmed, args.approvalContext)),
  'intercept.status': async () => withTab(tab => networkController.interceptionStatus(tab.id)),
  'intercept.stop': async () => withTab(tab => networkController.stopInterception(tab.id)),

  'request.modify': async args => withApprovedTab(args, tab => networkController.addModifier(tab.id, args.urlFilter, args.jsonKey, args.value)),
  'request.clear': async () => withTab(tab => networkController.clearModifiers(tab.id)),
  'request.send': async args => withApprovedTab(args, tab => sendPageRequest(tab.id, args.method, args.url, args.body, args.headers, args.expectedBrowserContext)),

  'extract.table': async args => withTab(tab => extractTable(tab.id, args.selector)),
  'extract.links': async args => withTab(tab => extractLinks(tab.id, args.scope)),
  'extract.forms': async args => withTab(tab => extractForms(tab.id, args.scope)),

  'cookies.list': async () => withTab(async tab => (await chrome.cookies.getAll({ url: tab.url })).map(normalizeCookie)),
  'cookies.set': async args => withApprovedTab(args, async tab => {
    const cookie = await chrome.cookies.set({ url: approvedUrl(args, tab.url), name: args.name, value: args.value, ...(args.domain ? { domain: args.domain } : {}) });
    if (!cookie) throw new Error('Chrome refused to set the cookie');
    return normalizeCookie(cookie);
  }),
  'cookies.clear': async args => withApprovedTab(args, async tab => {
    const cookies = await chrome.cookies.getAll({ url: approvedUrl(args, tab.url), ...(args.name ? { name: args.name } : {}) });
    for (const cookie of cookies) await chrome.cookies.remove({ url: cookieRemovalUrl(cookie), name: cookie.name, storeId: cookie.storeId });
    return { cleared: cookies.length, name: args.name || null };
  }),
  console: async args => withTab(tab => captureConsole(tab.id, args.milliseconds)),
  'dialog.accept': async args => withApprovedTab(args, tab => acceptDialog(tab.id, args.text, args.confirmed, args.approvalContext)),
  'dialog.dismiss': async () => withTab(tab => dismissDialog(tab.id)),
  performance: async () => withTab(tab => performanceInfo(tab.id)),
  emulate: async args => withTab(tab => emulate(tab.id, args.device)),
  geo: async args => withTab(tab => setGeolocation(tab.id, args.latitude, args.longitude)),

  'webmcp.tools': async () => withTab(tab => listWebMcpTools(tab.id)),
  'webmcp.schema': async args => withTab(tab => getWebMcpSchema(tab.id, args.toolName)),
  'webmcp.call': async args => withApprovedTab(args, tab => callWebMcpTool(tab.id, args.toolName, args.input, args.confirmed, args.approvalContext)),
  'webmcp.forms': async () => withTab(tab => listWebMcpForms(tab.id)),
  'webmcp.form': async args => withTab(tab => getWebMcpForm(tab.id, args.toolName)),
};

const missingHandlers = COMMANDS.filter(command => typeof handlers[command.name] !== 'function');
if (missingHandlers.length) console.error('[chrome-browser] Missing command handlers:', missingHandlers.map(item => item.name));

async function withTab(operation) {
  await selectedReady;
  const tab = await requireSelectedTab(selectedTabId);
  return operation(tab);
}

async function withApprovedTab(args, operation) {
  return withTab(async tab => {
    if (args.expectedBrowserContext) await validateBrowserContext(args.expectedBrowserContext);
    return operation(tab);
  });
}

function approvedUrl(args, fallback) {
  const url = new URL(args.expectedBrowserContext?.url || fallback);
  url.username = '';
  url.password = '';
  return url.href;
}

function connect() {
  if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) return;
  const connection = new WebSocket(BRIDGE_URL);
  socket = connection;
  connectionState = 'connecting';
  proofSent = false;
  connection.onopen = () => {
    if (socket !== connection) return;
    serverAuthenticated = false;
    updateActionStatus();
    clientNonce = randomNonce();
    socket.send(JSON.stringify({ type: 'hello', clientNonce }));
  };
  connection.onmessage = event => handleMessage(event.data, connection).catch(() => {
    if (socket !== connection) return;
    connectionState = 'auth-failed';
    connection.close(4004, 'Bridge authentication failed');
  });
  connection.onerror = () => { if (socket === connection) connectionState = 'bridge-offline'; connection.close(); };
  connection.onclose = () => {
    if (socket !== connection) return;
    clearInterval(pingTimer);
    pingTimer = null;
    serverAuthenticated = false;
    clientNonce = null;
    socket = null;
    proofSent = false;
    if (['connected', 'authenticating', 'connecting'].includes(connectionState)) connectionState = 'disconnected';
    updateActionStatus();
    if (pairingRequired) return;
    const delay = reconnectImmediately ? 0 : RECONNECT_DELAY;
    reconnectImmediately = false;
    if (!reconnectTimer) reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };
}

async function handleMessage(raw, connection = socket) {
  if (connection !== socket) return;
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (message.type === 'challenge') {
    if (message.protocol !== PROTOCOL_VERSION || message.clientNonce !== clientNonce || !/^[a-f0-9]{64}$/i.test(message.serverNonce || '')) {
      throw new Error('Invalid server challenge');
    }
    bridgeVersion = message.version || null;
    if (bridgeVersion !== VERSION) {
      connectionState = 'version-mismatch';
      pairingRequired = true;
      updateActionStatus();
      connection.close(4003, 'Matching bridge version required');
      return;
    }
    const { bridgeSecret } = await chrome.storage.local.get('bridgeSecret');
    if (connection !== socket) return;
    const pairingUrl = typeof message.pairingUrl === 'string' && new RegExp(`^chrome-extension://${chrome.runtime.id}/pair\\.html#[a-f0-9]{64}$`, 'i').test(message.pairingUrl) ? message.pairingUrl : null;
    if (!bridgeSecret) {
      pendingPairingUrl = pairingUrl;
      connectionState = 'pairing-required';
      pairingRequired = true;
      updateActionStatus();
      socket?.close(4005, 'Pairing required');
      return;
    }
    const expected = await hmacHex(bridgeSecret, `server:${clientNonce}:${message.serverNonce}`);
    if (connection !== socket) return;
    if (!safeEqual(message.proof, expected)) {
      pendingPairingUrl = pairingUrl;
      connectionState = 'auth-failed';
      pairingRequired = true;
      updateActionStatus();
      connection.close(4004, 'Pairing mismatch');
      return;
    }
    const proof = await hmacHex(bridgeSecret, `extension:${clientNonce}:${message.serverNonce}`);
    if (connection !== socket) return;
    proofSent = true;
    connectionState = 'authenticating';
    socket.send(JSON.stringify({ type: 'ready', protocol: PROTOCOL_VERSION, version: VERSION, capabilities: CAPABILITIES, proof }));
    updateActionStatus();
    return;
  }
  if (message.type === 'authenticated' && proofSent && message.protocol === PROTOCOL_VERSION && message.version === VERSION) {
    serverAuthenticated = true;
    connectionState = 'connected';
    pairingRequired = false;
    pendingPairingUrl = null;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping', time: Date.now() }), PING_INTERVAL);
    updateActionStatus();
    return;
  }
  if (message.type === 'pong') return;
  if (!serverAuthenticated || message.type !== 'command' || message.id == null) return;
  const handler = handlers[message.cmd];
  if (!handler) return send({ type: 'result', id: message.id, ok: false, error: `Unknown command: ${message.cmd}` });
  try {
    const args = message.args || {};
    if (args.expectedBrowserContext) await validateBrowserContext(args.expectedBrowserContext);
    const result = await handler(args);
    send({ type: 'result', id: message.id, ok: true, result });
  } catch (error) {
    send({
      type: 'result',
      id: message.id,
      ok: false,
      error: error?.message || String(error),
      code: error?.code || 'browser-command-failed',
      details: error?.details || null,
    });
  }
}

async function validateBrowserContext(expected) {
  await selectedReady;
  if (!Number.isInteger(selectedTabId) || selectedTabId !== expected.tabId) throw Object.assign(new Error('The selected tab changed after approval'), { code: 'wrong-document' });
  const tab = await requireSelectedTab(selectedTabId);
  if (expected.documentId == null) {
    if (String(tab.url || '') !== String(expected.url || '')) throw Object.assign(new Error('The selected page changed after approval'), { code: 'wrong-document' });
    return;
  }
  const current = await pageContext(tab.id);
  if (current.documentId !== expected.documentId || current.url !== expected.url || current.origin !== expected.origin) {
    throw Object.assign(new Error('The selected document changed after approval'), { code: 'wrong-document' });
  }
}

function send(value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (message?.type === 'pairing.status') {
    chrome.storage.local.get('bridgeSecret').then(({ bridgeSecret }) => {
      sendResponse({ state: connectionState, paired: /^[a-f0-9]{64}$/i.test(bridgeSecret || ''), connected: serverAuthenticated && socket?.readyState === WebSocket.OPEN, pairingUrl: pendingPairingUrl, bridgeVersion, extensionVersion: VERSION });
    });
    return true;
  }
  if (message?.type === 'pairing.updated' || message?.type === 'pairing.retry') {
    pairingRequired = false;
    pendingPairingUrl = null;
    connectionState = 'connecting';
    serverAuthenticated = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (socket) { reconnectImmediately = true; socket.close(4000, 'Pairing updated'); }
    else connect();
    updateActionStatus();
    sendResponse({ reconnecting: true });
  }
});

async function updateActionStatus() {
  const view = connectionView({ state: connectionState, pairingUrl: pendingPairingUrl });
  await Promise.all([
    chrome.action.setBadgeBackgroundColor({ color: view.connected ? '#2f7d32' : view.error ? '#8b3a34' : '#8a6d1d' }),
    chrome.action.setBadgeText({ text: view.badge }),
    chrome.action.setTitle({ title: `Chrome Browser Bridge: ${view.label}` }),
  ]).catch(() => {});
}

function normalizeCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
    storeId: cookie.storeId,
  };
}

function cookieRemovalUrl(cookie) {
  const host = cookie.domain.replace(/^\./, '');
  return `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;
}

chrome.tabs.onRemoved.addListener(tabId => {
  domController.clear(tabId);
  accessibilityController.clear(tabId);
  if (tabId === selectedTabId) {
    selectedTabId = null;
    chrome.storage.session.remove('selectedTabId');
  }
  networkController.cleanup(tabId).catch(() => {});
});

chrome.runtime.onSuspend.addListener(() => {
  clearInterval(pingTimer);
});

chrome.storage.local.get('bridgeSecret').then(() => {
  connect();
  updateActionStatus();
});
