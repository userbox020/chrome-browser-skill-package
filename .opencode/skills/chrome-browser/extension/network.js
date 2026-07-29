import { debuggerManager } from './debugger.js';
import { sameContext } from './context.js';
import {
  applyBodyAction,
  applyHeaderActions,
  applyRequestModifiers,
  compileFetchPatterns,
  matchesRule,
  normalizeRule,
  redactPath,
  ruleSetDigest,
  setNested,
  summarizeRule,
  validateRuleName,
} from './network-utils.js';

const MAX_REQUESTS = 500;
const MAX_STORED_POST_DATA = 64 * 1024;
const MAX_FRAMES_PER_SOCKET = 100;
const MAX_FRAME_PAYLOAD = 64 * 1024;
const MAX_DIAGNOSTICS = 50;
const PAUSE_WATCHDOG = 5_000;
const RULE_STORE_KEY = 'interceptionRulesV1';
const ACCEPTED_TARGET_TYPES = new Set(['iframe', 'worker']);
const TARGET_FILTER = [
  { type: 'iframe', exclude: false },
  { type: 'worker', exclude: false },
  { exclude: true },
];
const NETWORK_OPTIONS = {
  maxTotalBufferSize: 50 * 1024 * 1024,
  maxResourceBufferSize: 5 * 1024 * 1024,
  maxPostDataSize: MAX_STORED_POST_DATA,
};

export class NetworkController {
  constructor(manager = debuggerManager) {
    this.manager = manager;
    this.states = new Map();
    this.operations = new Map();
    manager.onEvent((source, method, params) => this.onEvent(source, method, params));
    manager.onDetach((source, reason) => this.onRootDetach(source, reason));
  }

  state(tabId) {
    let state = this.states.get(tabId);
    if (!state) {
      state = {
        captureActive: false,
        requests: [],
        byId: new Map(),
        byRaw: new Map(),
        requestExtra: new Map(),
        responseExtra: new Map(),
        modifiers: [],
        interceptionActive: false,
        interceptionMode: null,
        ruleNames: [],
        rules: [],
        ruleDigest: null,
        interceptionGeneration: 0,
        paused: new Map(),
        diagnostics: [],
        targets: new Map(),
        attachGeneration: 0,
        nextTargetOrdinal: 1,
        lifecycleGeneration: 0,
        setupPromises: new Set(),
        closing: false,
      };
      this.states.set(tabId, state);
    }
    return state;
  }

  start(tabId) {
    return this.serialize(tabId, () => this.startLocked(tabId));
  }

  async startLocked(tabId) {
    const state = this.state(tabId);
    if (state.captureActive) return this.status(tabId);
    let pinned = false;
    try {
      await this.manager.pin(tabId, 'network');
      pinned = true;
      state.captureActive = true;
      await this.ensureRootTarget(tabId, state);
      await this.forEachLiveTarget(state, target => this.enableNetwork(target, state));
      await this.refreshAutoAttach(state);
    } catch (error) {
      state.captureActive = false;
      await this.forEachLiveTarget(state, target => this.disableNetwork(target));
      if (pinned) this.manager.unpin(tabId, 'network');
      throw error;
    }
    return this.status(tabId);
  }

  stop(tabId) {
    return this.serialize(tabId, () => this.stopLocked(tabId));
  }

  async stopLocked(tabId) {
    const state = this.state(tabId);
    state.captureActive = false;
    state.lifecycleGeneration++;
    await this.waitForSetups(state, PAUSE_WATCHDOG + 1_000);
    await this.forEachLiveTarget(state, target => this.disableNetwork(target));
    this.manager.unpin(tabId, 'network');
    await this.refreshAutoAttach(state);
    return this.status(tabId);
  }

  list(tabId, filter) {
    const state = this.state(tabId);
    const needle = String(filter || '').toLowerCase();
    const requests = state.requests.filter(item => !needle || [item.url, item.method, item.type, item.status, item.targetType].some(value => String(value || '').toLowerCase().includes(needle)));
    return {
      active: state.captureActive,
      total: state.requests.length,
      filtered: requests.length,
      targets: this.targetSummary(state),
      requests: requests.map(item => ({
        requestId: item.requestId,
        method: item.method,
        status: item.failed ? 'FAILED' : item.status,
        type: item.type,
        targetType: item.targetType,
        targetUrl: item.targetUrl,
        url: item.url,
        finished: item.finished,
        encodedDataLength: item.encodedDataLength || 0,
      })),
    };
  }

  summary(tabId, filter) {
    const listed = this.list(tabId, filter);
    return {
      ...listed,
      requests: listed.requests.map(item => {
        let host = '';
        let path = item.url;
        let queryKeys = [];
        try {
          const url = new URL(item.url);
          host = url.host;
          path = redactPath(url.pathname);
          queryKeys = [...url.searchParams.entries()].slice(0, 20).map(([key, value]) => value === '' ? '[redacted]' : key);
        } catch {}
        return { ...item, url: undefined, host, path, queryKeys };
      }),
    };
  }

  detail(tabId, requestId) {
    return { ...this.findRequest(tabId, requestId) };
  }

  async body(tabId, requestId) {
    const request = this.findRequest(tabId, requestId);
    if (!request.finished) throw new Error('Request has not finished');
    if (request.failed) throw new Error(`Request failed: ${request.errorText}`);
    const target = this.state(tabId).targets.get(request.targetKey);
    if (!target?.alive) throw new Error('The request target session is detached; its body is no longer available');
    const result = await this.manager.sendSession(request.source, 'Network.getResponseBody', { requestId: request.rawRequestId }, { attach: false });
    return { requestId: request.requestId, url: request.url, status: request.status, body: result.body, base64Encoded: Boolean(result.base64Encoded) };
  }

  clear(tabId) {
    const state = this.state(tabId);
    state.requests = [];
    state.byId.clear();
    state.byRaw.clear();
    state.requestExtra.clear();
    state.responseExtra.clear();
    return { cleared: true };
  }

  async setRule(name, input) {
    const rule = normalizeRule(name, input);
    if (this.isRuleActive(name)) throw new Error(`Stop interception before changing active rule: ${name}`);
    const store = await this.loadRuleStore();
    if (!Object.hasOwn(store.rules, name) && Object.keys(store.rules).length >= 100) throw new Error('At most 100 named interception rules are allowed');
    setOwn(store.rules, name, rule);
    await chrome.storage.local.set({ [RULE_STORE_KEY]: store });
    return { stored: true, rule };
  }

  async listRules(name) {
    const store = await this.loadRuleStore();
    if (name) {
      validateRuleName(name);
      if (!Object.hasOwn(store.rules, name)) throw new Error(`No interception rule named: ${name}`);
      return { rules: [store.rules[name]] };
    }
    return { rules: Object.values(store.rules).sort((left, right) => left.name.localeCompare(right.name)) };
  }

  async removeRule(name) {
    validateRuleName(name);
    if (this.isRuleActive(name)) throw new Error(`Stop interception before removing active rule: ${name}`);
    const store = await this.loadRuleStore();
    const removed = Object.hasOwn(store.rules, name);
    delete store.rules[name];
    await chrome.storage.local.set({ [RULE_STORE_KEY]: store });
    return { removed, name };
  }

  startInterception(tabId, namesInput, confirmed, approvedContext) {
    return this.serialize(tabId, () => this.startInterceptionLocked(tabId, namesInput, confirmed, approvedContext));
  }

  async startInterceptionLocked(tabId, namesInput, confirmed, approvedContext) {
    const names = parseRuleNames(namesInput);
    const store = await this.loadRuleStore();
    const rules = names.map(name => {
      if (!Object.hasOwn(store.rules, name)) throw new Error(`No interception rule named: ${name}`);
      const rule = store.rules[name];
      return normalizeRule(name, rule);
    });
    const digest = await ruleSetDigest(names, rules);
    const approvalContext = {
      scope: 'selected-tab-and-related-iframe-worker-targets',
      names,
      ruleSetDigest: digest,
      rules: rules.map(summarizeRule),
    };
    if (!confirmed || !sameContext(approvedContext, approvalContext)) {
      return {
        confirmationRequired: true,
        summary: `Start request/response interception with rules: ${names.join(', ')}. It remains active across navigation until stopped or the selected tab changes.`,
        approvalContext,
      };
    }

    const state = this.state(tabId);
    if (state.modifiers.length) throw new Error('Clear legacy request modifiers before starting named interception');
    if (state.interceptionActive) throw new Error('Interception is already active. Stop it before changing active rules.');
    let pinned = false;
    try {
      await this.manager.pin(tabId, 'interception');
      pinned = true;
      state.interceptionActive = true;
      state.interceptionMode = 'named';
      state.ruleNames = names;
      state.rules = structuredClone(rules);
      state.ruleDigest = digest;
      state.interceptionGeneration++;
      await this.ensureRootTarget(tabId, state);
      await this.forEachLiveTarget(state, target => this.enableFetch(target, compileFetchPatterns(state.rules), state));
      await this.refreshAutoAttach(state);
    } catch (error) {
      if (pinned) await this.rollbackInterception(tabId, state);
      throw error;
    }
    return this.interceptionStatus(tabId);
  }

  stopInterception(tabId) {
    return this.serialize(tabId, () => this.stopInterceptionLocked(tabId));
  }

  async stopInterceptionLocked(tabId) {
    const state = this.state(tabId);
    if (state.interceptionMode !== 'named') {
      return { ...this.interceptionStatus(tabId), stopped: false, note: state.interceptionMode === 'legacy' ? 'Legacy modifiers remain active; use request clear.' : 'Named interception is not active.' };
    }
    state.interceptionActive = false;
    state.interceptionGeneration++;
    state.lifecycleGeneration++;
    await Promise.all([this.waitForSetups(state, PAUSE_WATCHDOG + 1_000), this.waitForPaused(state, PAUSE_WATCHDOG + 1_000)]);
    await this.forEachLiveTarget(state, target => this.disableFetch(target));
    state.interceptionMode = null;
    state.ruleNames = [];
    state.rules = [];
    state.ruleDigest = null;
    this.manager.unpin(tabId, 'interception');
    await this.refreshAutoAttach(state);
    return this.interceptionStatus(tabId);
  }

  interceptionStatus(tabId) {
    const state = this.state(tabId);
    return {
      active: state.interceptionActive || state.modifiers.length > 0,
      mode: state.interceptionMode,
      ruleNames: state.ruleNames,
      ruleSetDigest: state.ruleDigest,
      modifiers: state.modifiers.map(item => ({ urlFilter: item.urlFilter, jsonKey: item.jsonKey, value: item.value })),
      targets: this.targetSummary(state),
      paused: state.paused.size,
      diagnostics: state.diagnostics.slice(-10),
    };
  }

  status(tabId) {
    const state = this.state(tabId);
    return {
      active: state.captureActive,
      count: state.requests.length,
      targets: this.targetSummary(state),
      interception: this.interceptionStatus(tabId),
    };
  }

  addModifier(tabId, urlFilter, jsonKey, value) {
    return this.serialize(tabId, () => this.addModifierLocked(tabId, urlFilter, jsonKey, value));
  }

  async addModifierLocked(tabId, urlFilter, jsonKey, value) {
    if (!urlFilter || !jsonKey) throw new Error('URL filter and JSON key are required');
    setNested({}, jsonKey, value);
    const state = this.state(tabId);
    if (state.interceptionActive && state.interceptionMode === 'named') throw new Error('Stop named interception before using legacy request modifiers');
    const existing = state.modifiers.find(item => item.urlFilter === urlFilter && item.jsonKey === jsonKey);
    const previousValue = existing?.value;
    const previousMode = state.interceptionMode;
    let pinned = false;
    try {
      await this.manager.pin(tabId, 'interception');
      pinned = true;
      if (existing) existing.value = value;
      else state.modifiers.push({ urlFilter, jsonKey, value });
      state.interceptionMode = 'legacy';
      await this.ensureRootTarget(tabId, state);
      await this.forEachLiveTarget(state, target => this.enableFetch(target, [{ urlPattern: '*', requestStage: 'Request' }], state));
      await this.refreshAutoAttach(state);
    } catch (error) {
      if (existing) existing.value = previousValue;
      else state.modifiers = state.modifiers.filter(item => item.urlFilter !== urlFilter || item.jsonKey !== jsonKey);
      state.interceptionMode = previousMode;
      if (pinned && !state.modifiers.length) {
        state.lifecycleGeneration++;
        await this.forEachLiveTarget(state, target => this.disableFetch(target));
        this.manager.unpin(tabId, 'interception');
        await this.refreshAutoAttach(state).catch(() => {});
      }
      throw error;
    }
    return { registered: true, urlFilter, jsonKey, value, count: state.modifiers.length };
  }

  clearModifiers(tabId) {
    return this.serialize(tabId, () => this.clearModifiersLocked(tabId));
  }

  async clearModifiersLocked(tabId) {
    const state = this.state(tabId);
    state.modifiers = [];
    if (state.interceptionMode === 'legacy') {
      state.interceptionMode = null;
      state.interceptionGeneration++;
      state.lifecycleGeneration++;
      await Promise.all([this.waitForSetups(state, PAUSE_WATCHDOG + 1_000), this.waitForPaused(state, PAUSE_WATCHDOG + 1_000)]);
      await this.forEachLiveTarget(state, target => this.disableFetch(target));
      this.manager.unpin(tabId, 'interception');
      await this.refreshAutoAttach(state);
    }
    return { cleared: true };
  }

  cleanup(tabId) {
    return this.serialize(tabId, () => this.cleanupLocked(tabId));
  }

  async cleanupLocked(tabId) {
    const state = this.states.get(tabId);
    if (!state) return;
    state.captureActive = false;
    state.interceptionActive = false;
    state.modifiers = [];
    state.interceptionGeneration++;
    state.lifecycleGeneration++;
    state.closing = true;
    await Promise.all([this.waitForSetups(state, PAUSE_WATCHDOG + 1_000), this.waitForPaused(state, PAUSE_WATCHDOG + 1_000)]);
    await this.forEachLiveTarget(state, async target => {
      await this.disableFetch(target);
      await this.disableNetwork(target);
    });
    await this.manager.detach(tabId);
    this.states.delete(tabId);
  }

  findRequest(tabId, requestId) {
    const state = this.state(tabId);
    const exact = state.byId.get(requestId);
    if (exact) return exact;
    const matches = state.requests.filter(item => item.requestId.includes(requestId));
    if (!matches.length) throw new Error(`Request not found: ${requestId}`);
    if (matches.length > 1) throw new Error(`Ambiguous request ID: ${requestId}`);
    return matches[0];
  }

  onEvent(source, method, params = {}) {
    const tabId = source?.tabId;
    if (!Number.isInteger(tabId)) return;
    if (method === 'Target.attachedToTarget') {
      this.onAttachedTarget(source, params).catch(error => {
        const current = this.states.get(tabId);
        if (current) this.recordError(current, 'target-attach', null, error);
      });
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      this.onDetachedTarget(tabId, params);
      return;
    }
    if (method === 'Fetch.requestPaused') {
      this.onRequestPaused(source, params);
      return;
    }
    const state = this.states.get(tabId);
    if (!state?.captureActive) return;
    const target = this.targetForSource(state, source);
    if (!target) return;
    if (method === 'Network.requestWillBeSent') this.onRequest(state, target, params);
    else if (method === 'Network.responseReceived') this.onResponse(state, target, params);
    else if (method === 'Network.loadingFinished') this.onFinished(state, target, params);
    else if (method === 'Network.loadingFailed') this.onFailed(state, target, params);
    else if (method === 'Network.requestWillBeSentExtraInfo') this.onRequestExtra(state, target, params);
    else if (method === 'Network.responseReceivedExtraInfo') this.onResponseExtra(state, target, params);
    else if (method === 'Network.webSocketCreated') this.onWebSocketCreated(state, target, params);
    else if (method === 'Network.webSocketWillSendHandshakeRequest') this.onWebSocketRequest(state, target, params);
    else if (method === 'Network.webSocketHandshakeResponseReceived') this.onWebSocketResponse(state, target, params);
    else if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') this.onWebSocketFrame(state, target, method, params);
    else if (method === 'Network.webSocketClosed') this.onWebSocketClosed(state, target, params);
    else if (method === 'Network.eventSourceMessageReceived') this.onEventSourceMessage(state, target, params);
    else if (method === 'Network.webTransportCreated') this.onWebTransportCreated(state, target, params);
    else if (method === 'Network.webTransportConnectionEstablished') this.onWebTransportEstablished(state, target, params);
    else if (method === 'Network.webTransportClosed') this.onWebTransportClosed(state, target, params);
  }

  async ensureRootTarget(tabId, state) {
    await this.manager.attach(tabId);
    let root = state.targets.get('root');
    if (!root?.alive) {
      state.attachGeneration++;
      root = {
        key: 'root',
        source: { tabId },
        sessionId: null,
        parentSessionId: null,
        targetId: null,
        type: 'page',
        url: '',
        ordinal: 0,
        alive: true,
        networkEnabled: false,
        fetchEnabled: false,
        autoAttachEnabled: false,
      };
      state.targets.set('root', root);
    }
    return root;
  }

  async refreshAutoAttach(state) {
    const enabled = state.captureActive || this.isIntercepting(state);
    const targets = [...state.targets.values()].filter(target => target.alive).sort((left, right) => enabled ? left.ordinal - right.ordinal : right.ordinal - left.ordinal);
    for (const target of targets) {
      try {
        await this.manager.sendSession(target.source, 'Target.setAutoAttach', {
          autoAttach: enabled,
          waitForDebuggerOnStart: enabled,
          flatten: true,
          ...(enabled ? { filter: TARGET_FILTER } : {}),
        }, { attach: false });
        target.autoAttachEnabled = enabled;
      } catch (error) {
        this.recordError(state, 'auto-attach', target, error);
        if (target.key === 'root' && enabled) throw error;
      }
    }
  }

  async onAttachedTarget(parentSource, params) {
    const state = this.states.get(parentSource.tabId);
    const setup = this.setupAttachedTarget(parentSource, params, state);
    if (state) state.setupPromises.add(setup);
    try {
      await setup;
    } finally {
      state?.setupPromises.delete(setup);
    }
  }

  async setupAttachedTarget(parentSource, params, state) {
    if (!state) {
      await this.resumeTarget({ tabId: parentSource.tabId, sessionId: params.sessionId }, params.waitingForDebugger);
      return;
    }
    const childSource = { tabId: parentSource.tabId, sessionId: params.sessionId };
    const type = params.targetInfo?.type || 'other';
    if (state.closing || !ACCEPTED_TARGET_TYPES.has(type)) {
      await this.resumeTarget(childSource, params.waitingForDebugger);
      await this.manager.sendSession(parentSource, 'Target.detachFromTarget', { sessionId: params.sessionId }, { attach: false }).catch(() => {});
      return;
    }
    const target = {
      key: params.sessionId,
      source: childSource,
      sessionId: params.sessionId,
      parentSessionId: parentSource.sessionId || null,
      targetId: params.targetInfo?.targetId || null,
      type,
      url: params.targetInfo?.url || '',
      ordinal: state.nextTargetOrdinal++,
      alive: true,
      networkEnabled: false,
      fetchEnabled: false,
      autoAttachEnabled: false,
    };
    state.targets.set(target.key, target);
    let setupComplete = false;
    try {
      if (state.captureActive) await this.enableNetwork(target, state);
      if (this.isIntercepting(state)) await this.enableFetch(target, this.currentFetchPatterns(state), state);
      if (this.isTargetCurrent(state, target) && (state.captureActive || this.isIntercepting(state))) {
        await this.manager.sendSession(target.source, 'Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: TARGET_FILTER,
        }, { attach: false });
        if (this.isTargetCurrent(state, target) && (state.captureActive || this.isIntercepting(state))) {
          target.autoAttachEnabled = true;
        } else {
          await this.manager.sendSession(target.source, 'Target.setAutoAttach', {
            autoAttach: false,
            waitForDebuggerOnStart: false,
            flatten: true,
          }, { attach: false }).catch(() => {});
        }
      }
      setupComplete = true;
    } finally {
      await this.resumeTarget(childSource, params.waitingForDebugger);
      if (!setupComplete || !this.isTargetCurrent(state, target) || (!state.captureActive && !this.isIntercepting(state))) {
        target.alive = false;
        state.targets.delete(target.key);
        await this.manager.sendSession(parentSource, 'Target.detachFromTarget', { sessionId: params.sessionId }, { attach: false }).catch(() => {});
      }
    }
  }

  onDetachedTarget(tabId, params) {
    const state = this.states.get(tabId);
    const target = state?.targets.get(params.sessionId);
    if (!target) return;
    target.alive = false;
    target.networkEnabled = false;
    target.fetchEnabled = false;
    for (const request of state.requests) if (request.targetKey === target.key) request.targetDetached = true;
    this.clearTargetTransientState(state, target);
    state.targets.delete(target.key);
  }

  onRootDetach(source, reason) {
    const state = this.states.get(source.tabId);
    if (!state) return;
    state.captureActive = false;
    state.interceptionActive = false;
    state.interceptionMode = null;
    state.modifiers = [];
    state.rules = [];
    state.ruleNames = [];
    state.ruleDigest = null;
    state.interceptionGeneration++;
    state.lifecycleGeneration++;
    for (const record of state.paused.values()) clearTimeout(record.timer);
    state.paused.clear();
    state.byRaw.clear();
    state.requestExtra.clear();
    state.responseExtra.clear();
    for (const target of state.targets.values()) target.alive = false;
    state.targets.clear();
    this.recordError(state, 'debugger-detached', null, new Error(reason || 'Debugger detached'));
  }

  async enableNetwork(target, state = null) {
    if (target.networkEnabled || !target.alive) return;
    await this.manager.sendSession(target.source, 'Network.enable', NETWORK_OPTIONS, { attach: false });
    if (state && (!state.captureActive || !this.isTargetCurrent(state, target))) {
      await this.manager.sendSession(target.source, 'Network.disable', {}, { attach: false }).catch(() => {});
      return;
    }
    target.networkEnabled = true;
  }

  async disableNetwork(target) {
    if (!target.networkEnabled || !target.alive) return;
    await this.manager.sendSession(target.source, 'Network.disable', {}, { attach: false }).catch(() => {});
    target.networkEnabled = false;
  }

  async enableFetch(target, patterns, state = null) {
    if (!target.alive) return;
    await this.manager.sendSession(target.source, 'Fetch.enable', { patterns }, { attach: false });
    if (state && (!this.isIntercepting(state) || !this.isTargetCurrent(state, target))) {
      await this.manager.sendSession(target.source, 'Fetch.disable', {}, { attach: false }).catch(() => {});
      return;
    }
    target.fetchEnabled = true;
  }

  async disableFetch(target) {
    if (!target.fetchEnabled || !target.alive) return;
    await this.manager.sendSession(target.source, 'Fetch.disable', {}, { attach: false }).catch(() => {});
    target.fetchEnabled = false;
  }

  onRequest(state, target, params) {
    const request = this.ensureRequest(state, target, params.requestId, params.request.url, params.request.method, params.type || 'Other');
    if (params.redirectResponse) request.redirects.push({ url: request.url, status: params.redirectResponse.status });
    Object.assign(request, {
      loaderId: params.loaderId,
      url: params.request.url,
      method: params.request.method,
      requestHeaders: state.requestExtra.get(this.rawKey(target, params.requestId)) || params.request.headers || {},
      postData: params.request.postData ? params.request.postData.slice(0, MAX_STORED_POST_DATA) : null,
      postDataTruncated: Boolean(params.request.postData && params.request.postData.length > MAX_STORED_POST_DATA),
      hasPostData: Boolean(params.request.hasPostData),
      type: params.type || 'Other',
      timestamp: params.timestamp,
      wallTime: params.wallTime,
      initiator: params.initiator || null,
      status: null,
      finished: false,
      failed: false,
    });
    state.requestExtra.delete(this.rawKey(target, params.requestId));
    const responseExtra = state.responseExtra.get(this.rawKey(target, params.requestId));
    if (responseExtra) {
      request.responseHeaders = responseExtra;
      state.responseExtra.delete(this.rawKey(target, params.requestId));
    }
  }

  onResponse(state, target, params) {
    const request = this.findRawRequest(state, target, params.requestId);
    if (!request) return;
    Object.assign(request, {
      status: params.response.status,
      statusText: params.response.statusText,
      responseHeaders: request.responseHeaders || params.response.headers || {},
      mimeType: params.response.mimeType,
      protocol: params.response.protocol,
      fromDiskCache: params.response.fromDiskCache,
      responseTimestamp: params.timestamp,
      timing: params.response.timing || null,
    });
  }

  onFinished(state, target, params) {
    const request = this.findRawRequest(state, target, params.requestId);
    if (!request) return;
    request.finished = true;
    request.encodedDataLength = params.encodedDataLength || 0;
    request.finishedTimestamp = params.timestamp;
  }

  onFailed(state, target, params) {
    const request = this.findRawRequest(state, target, params.requestId);
    if (!request) return;
    request.finished = true;
    request.failed = true;
    request.errorText = params.errorText || 'Unknown network failure';
    request.canceled = Boolean(params.canceled);
  }

  onRequestExtra(state, target, params) {
    const request = this.findRawRequest(state, target, params.requestId);
    if (request) request.requestHeaders = params.headers || request.requestHeaders;
    else boundedSet(state.requestExtra, this.rawKey(target, params.requestId), params.headers || {});
  }

  onResponseExtra(state, target, params) {
    const request = this.findRawRequest(state, target, params.requestId);
    if (request) request.responseHeaders = params.headers || request.responseHeaders;
    else boundedSet(state.responseExtra, this.rawKey(target, params.requestId), params.headers || {});
  }

  onWebSocketCreated(state, target, params) {
    const request = this.ensureRequest(state, target, params.requestId, params.url, 'GET', 'WebSocket');
    request.initiator = params.initiator || null;
    request.webSocketFrames = [];
  }

  onWebSocketRequest(state, target, params) {
    const request = this.findRawRequest(state, target, params.requestId);
    if (request) request.requestHeaders = params.request?.headers || {};
  }

  onWebSocketResponse(state, target, params) {
    const request = this.findRawRequest(state, target, params.requestId);
    if (!request) return;
    request.status = params.response?.status || 101;
    request.responseHeaders = params.response?.headers || {};
  }

  onWebSocketFrame(state, target, method, params) {
    const request = this.findRawRequest(state, target, params.requestId);
    if (!request) return;
    request.webSocketFrames ||= [];
    request.webSocketFrames.push({
      direction: method.endsWith('Sent') ? 'sent' : 'received',
      timestamp: params.timestamp,
      opcode: params.response?.opcode,
      mask: params.response?.mask,
      payloadData: String(params.response?.payloadData || '').slice(0, MAX_FRAME_PAYLOAD),
      truncated: String(params.response?.payloadData || '').length > MAX_FRAME_PAYLOAD,
    });
    if (request.webSocketFrames.length > MAX_FRAMES_PER_SOCKET) request.webSocketFrames.shift();
  }

  onWebSocketClosed(state, target, params) {
    const request = this.findRawRequest(state, target, params.requestId);
    if (request) request.finished = true;
  }

  onEventSourceMessage(state, target, params) {
    const request = this.findRawRequest(state, target, params.requestId);
    if (!request) return;
    request.eventSourceMessages ||= [];
    request.eventSourceMessages.push({ eventName: params.eventName, eventId: params.eventId, data: String(params.data || '').slice(0, MAX_FRAME_PAYLOAD), timestamp: params.timestamp });
    if (request.eventSourceMessages.length > MAX_FRAMES_PER_SOCKET) request.eventSourceMessages.shift();
  }

  onWebTransportCreated(state, target, params) {
    const request = this.ensureRequest(state, target, params.transportId, params.url, 'CONNECT', 'WebTransport');
    request.timestamp = params.timestamp;
    request.initiator = params.initiator || null;
  }

  onWebTransportEstablished(state, target, params) {
    const request = this.findRawRequest(state, target, params.transportId);
    if (request) request.status = 'CONNECTED';
  }

  onWebTransportClosed(state, target, params) {
    const request = this.findRawRequest(state, target, params.transportId);
    if (request) request.finished = true;
  }

  onRequestPaused(source, params) {
    const state = this.states.get(source.tabId);
    const target = state && this.targetForSource(state, source);
    if (!state || !target) {
      this.manager.sendSession(source, 'Fetch.continueRequest', { requestId: params.requestId }, { attach: false }).catch(() => {});
      return;
    }
    const pauseKey = `${target.key}:${params.requestId}`;
    const record = { settled: false, inFlight: null, bodyRead: null, generation: state.interceptionGeneration, target, requestId: params.requestId };
    state.paused.set(pauseKey, record);
    const disarmWatchdog = () => {
      clearTimeout(record.timer);
      record.watchdogArmed = false;
    };
    const armWatchdog = () => {
      disarmWatchdog();
      if (record.settled || record.inFlight || !this.isIntercepting(state) || !this.isTargetCurrent(state, target)) return;
      record.watchdogArmed = true;
      record.timer = setTimeout(watchdog, PAUSE_WATCHDOG);
    };
    const watchdog = () => {
      record.watchdogArmed = false;
      terminal('Fetch.continueRequest', { requestId: params.requestId }).catch(error => {
        this.recordError(state, 'pause-watchdog', target, error);
      });
      this.recordError(state, 'pause-watchdog', target, new Error('Paused request continued unchanged after timeout'));
    };
    const terminal = async (method, commandParams) => {
      if (record.settled) return false;
      if (record.inFlight) return record.inFlight;
      disarmWatchdog();
      const attempt = this.manager.sendSession(source, method, commandParams, { attach: false });
      record.inFlight = attempt;
      try {
        await attempt;
        record.settled = true;
        state.paused.delete(pauseKey);
        return true;
      } catch (error) {
        record.inFlight = null;
        armWatchdog();
        throw error;
      }
    };
    terminal.disarmWatchdog = disarmWatchdog;
    terminal.armWatchdog = armWatchdog;
    terminal.waitForBodyRead = async promise => {
      record.bodyRead = promise;
      try {
        return await promise;
      } finally {
        if (record.bodyRead === promise) record.bodyRead = null;
      }
    };
    armWatchdog();
    this.handlePausedRequest(state, target, params, record, terminal).catch(async error => {
      this.recordError(state, 'interception', target, error);
      await terminal('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
    });
  }

  async handlePausedRequest(state, target, params, record, terminal) {
    if (record.generation !== state.interceptionGeneration || !this.isIntercepting(state)) {
      await terminal('Fetch.continueRequest', { requestId: params.requestId });
      return;
    }
    if (state.interceptionMode === 'legacy') {
      const { changed, postData } = applyRequestModifiers(params.request.postData, params.request.url, state.modifiers);
      await terminal('Fetch.continueRequest', { requestId: params.requestId, ...(changed ? { postData: encodeUtf8Base64(postData) } : {}) });
      return;
    }
    const responseStage = params.responseStatusCode != null || params.responseErrorReason != null;
    if (responseStage) await this.handleResponsePause(state, target, params, terminal);
    else await this.handleRequestPause(state, target, params, terminal);
  }

  async handleRequestPause(state, target, params, terminal) {
    const matching = state.rules.filter(rule => matchesRule(rule, {
      url: params.request.url,
      method: params.request.method,
      resourceType: params.resourceType,
    }, 'Request'));
    if (!matching.length) return terminal('Fetch.continueRequest', { requestId: params.requestId });

    let working = {
      url: params.request.url,
      method: params.request.method,
      headers: headersToList(params.request.headers),
      body: params.request.postData || '',
      bodyBase64: false,
      bodyChanged: false,
      terminal: null,
    };
    for (const rule of matching) {
      try {
        const draft = structuredClone(working);
        const action = rule.request;
        if (action.url) draft.url = action.url;
        if (action.method) draft.method = action.method;
        if (action.headers) draft.headers = applyHeaderActions(draft.headers, action.headers);
        if (action.body) {
          const transformed = applyBodyAction(draft.body, draft.bodyBase64, action.body);
          draft.body = transformed.base64;
          draft.bodyBase64 = true;
          draft.bodyChanged = true;
          draft.headers = removeHeaders(draft.headers, ['content-length']);
        }
        if (action.block) draft.terminal = { type: 'block', reason: action.block };
        if (action.fulfill) draft.terminal = { type: 'fulfill', value: action.fulfill };
        working = draft;
      } catch (error) {
        this.recordError(state, `request-rule:${rule.name}`, target, error);
      }
    }

    if (working.terminal?.type === 'block') {
      return terminal('Fetch.failRequest', { requestId: params.requestId, errorReason: working.terminal.reason });
    }
    if (working.terminal?.type === 'fulfill') {
      const fulfill = working.terminal.value;
      let headers = fulfill.headers || [];
      let body;
      if (fulfill.body) {
        body = applyBodyAction('', false, fulfill.body).base64;
        headers = removeHeaders(headers, ['content-length']);
      }
      if ([204, 205, 304].includes(fulfill.statusCode)) {
        body = undefined;
        headers = removeHeaders(headers, ['content-length', 'content-encoding', 'content-md5', 'digest', 'transfer-encoding']);
      } else if (params.request.method === 'HEAD') {
        body = undefined;
      }
      return terminal('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: fulfill.statusCode,
        ...(fulfill.statusText ? { responsePhrase: fulfill.statusText } : {}),
        responseHeaders: headers,
        ...(body ? { body } : {}),
      });
    }
    const changedUrl = working.url !== params.request.url;
    const changedMethod = working.method !== params.request.method;
    const changedHeaders = JSON.stringify(working.headers) !== JSON.stringify(headersToList(params.request.headers));
    return terminal('Fetch.continueRequest', {
      requestId: params.requestId,
      ...(changedUrl ? { url: working.url } : {}),
      ...(changedMethod ? { method: working.method } : {}),
      ...(changedHeaders ? { headers: working.headers } : {}),
      ...(working.bodyChanged ? { postData: working.body } : {}),
    });
  }

  async handleResponsePause(state, target, params, terminal) {
    const matching = state.rules.filter(rule => matchesRule(rule, {
      url: params.request.url,
      method: params.request.method,
      resourceType: params.resourceType,
      statusCode: params.responseStatusCode,
    }, 'Response'));
    if (!matching.length || params.responseErrorReason) return terminal('Fetch.continueRequest', { requestId: params.requestId });

    let statusCode = params.responseStatusCode;
    let statusText = params.responseStatusText || '';
    let statusTextOverridden = false;
    let headers = params.responseHeaders || [];
    const bodyActions = [];
    for (const rule of matching) {
      const action = rule.response;
      if (action.statusCode) statusCode = action.statusCode;
      if (Object.hasOwn(action, 'statusText')) {
        statusText = action.statusText;
        statusTextOverridden = true;
      }
      if (action.headers) headers = applyHeaderActions(headers, action.headers);
      if (action.body) bodyActions.push({ name: rule.name, action: action.body });
    }

    let body;
    const finalBodyless = params.request.method === 'HEAD' || [204, 205, 304].includes(statusCode);
    const sourceBodyless = params.request.method === 'HEAD' || [204, 205, 304].includes(params.responseStatusCode);
    const redirectResponse = [301, 302, 303, 307, 308].includes(params.responseStatusCode)
      && (params.responseHeaders || []).some(header => header.name.toLowerCase() === 'location');
    const contentType = (params.responseHeaders || []).find(header => header.name.toLowerCase() === 'content-type')?.value || '';
    const streamingResponse = params.resourceType === 'EventSource' || /^(text\/event-stream|application\/(x-ndjson|stream\+json)|multipart\/x-mixed-replace)\b/i.test(contentType);
    if (bodyActions.length) {
      if (finalBodyless || sourceBodyless || redirectResponse || streamingResponse) {
        this.recordError(state, 'response-body', target, new Error('Response body transformation skipped for bodyless, redirect, or streaming response'));
      } else {
        const lastReplacement = bodyActions.findLastIndex(item => Object.hasOwn(item.action, 'text') || Object.hasOwn(item.action, 'base64'));
        let currentBody = '';
        let currentBase64 = false;
        let firstAction = lastReplacement;
        if (lastReplacement < 0) {
          terminal.disarmWatchdog();
          let original;
          try {
            original = await terminal.waitForBodyRead(this.manager.sendSession(target.source, 'Fetch.getResponseBody', { requestId: params.requestId }, { attach: false }));
          } finally {
            terminal.armWatchdog();
          }
          if (String(original.body || '').length > 7 * 1024 * 1024) throw new Error('Response body exceeds interception limit');
          currentBody = original.body || '';
          currentBase64 = Boolean(original.base64Encoded);
          firstAction = 0;
        }
        let transformedAny = false;
        for (const item of bodyActions.slice(firstAction)) {
          try {
            const transformed = applyBodyAction(currentBody, currentBase64, item.action);
            currentBody = transformed.base64;
            currentBase64 = true;
            transformedAny = true;
          } catch (error) {
            this.recordError(state, `response-rule:${item.name}`, target, error);
          }
        }
        if (transformedAny) {
          body = currentBody;
          headers = removeHeaders(headers, ['content-length', 'content-encoding', 'content-md5', 'digest', 'etag']);
        }
      }
    }
    if (finalBodyless) {
      body = '';
      if (!sourceBodyless) headers = removeHeaders(headers, ['content-length', 'content-encoding', 'content-md5', 'digest', 'transfer-encoding']);
    }
    return terminal('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: statusCode,
      ...((statusTextOverridden || statusCode === params.responseStatusCode) && statusText ? { responsePhrase: statusText } : {}),
      responseHeaders: headers,
      ...(body != null ? { body } : {}),
    });
  }

  ensureRequest(state, target, rawRequestId, url, method, type) {
    let request = this.findRawRequest(state, target, rawRequestId);
    if (request) return request;
    const requestId = `T${target.source.tabId}-G${state.attachGeneration}-S${target.ordinal}:${rawRequestId}`;
    request = {
      requestId,
      rawRequestId,
      source: { ...target.source },
      targetKey: target.key,
      targetType: target.type,
      targetId: target.targetId,
      targetUrl: target.url,
      url,
      method,
      type,
      redirects: [],
      status: null,
      finished: false,
      failed: false,
    };
    state.requests.push(request);
    state.byId.set(requestId, request);
    state.byRaw.set(this.rawKey(target, rawRequestId), request);
    if (state.requests.length > MAX_REQUESTS) {
      const removed = state.requests.shift();
      state.byId.delete(removed.requestId);
      state.byRaw.delete(`${removed.targetKey}:${removed.rawRequestId}`);
    }
    return request;
  }

  findRawRequest(state, target, rawRequestId) {
    return state.byRaw.get(this.rawKey(target, rawRequestId));
  }

  rawKey(target, rawRequestId) {
    return `${target.key}:${rawRequestId}`;
  }

  targetForSource(state, source) {
    return state.targets.get(source.sessionId || 'root');
  }

  targetSummary(state) {
    return [...state.targets.values()].filter(target => target.alive).map(target => ({
      key: `S${target.ordinal}`,
      type: target.type,
      url: target.url,
      networkEnabled: target.networkEnabled,
      fetchEnabled: target.fetchEnabled,
    }));
  }

  currentFetchPatterns(state) {
    return state.interceptionMode === 'named'
      ? compileFetchPatterns(state.rules)
      : [{ urlPattern: '*', requestStage: 'Request' }];
  }

  isIntercepting(state) {
    return state.interceptionActive || state.modifiers.length > 0;
  }

  isRuleActive(name) {
    return [...this.states.values()].some(state => state.interceptionActive && state.ruleNames.includes(name));
  }

  async loadRuleStore() {
    const value = await chrome.storage.local.get(RULE_STORE_KEY);
    const store = value[RULE_STORE_KEY];
    if (!store || store.version !== 1 || !store.rules || typeof store.rules !== 'object' || Array.isArray(store.rules)) return { version: 1, rules: {} };
    const rules = {};
    for (const [name, rule] of Object.entries(store.rules)) setOwn(rules, name, structuredClone(rule));
    return { version: 1, rules };
  }

  async forEachLiveTarget(state, operation) {
    const targets = [...state.targets.values()].filter(target => target.alive);
    for (const target of targets) await operation(target);
  }

  async serialize(tabId, operation) {
    const previous = this.operations.get(tabId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.operations.set(tabId, current);
    try {
      return await current;
    } finally {
      if (this.operations.get(tabId) === current) this.operations.delete(tabId);
    }
  }

  async resumeTarget(source, waiting) {
    if (!waiting) return;
    await this.manager.sendSession(source, 'Runtime.runIfWaitingForDebugger', {}, { attach: false }).catch(() => {});
  }

  async rollbackInterception(tabId, state) {
    state.interceptionActive = false;
    state.interceptionMode = null;
    state.rules = [];
    state.ruleNames = [];
    state.ruleDigest = null;
    state.interceptionGeneration++;
    state.lifecycleGeneration++;
    await Promise.all([this.waitForSetups(state, PAUSE_WATCHDOG + 1_000), this.waitForPaused(state, PAUSE_WATCHDOG + 1_000)]);
    await this.forEachLiveTarget(state, target => this.disableFetch(target));
    this.manager.unpin(tabId, 'interception');
    await this.refreshAutoAttach(state).catch(() => {});
  }

  async waitForPaused(state, timeout) {
    let deadline = Date.now() + timeout;
    while (state.paused.size) {
      const bodyReads = [...state.paused.values()].map(record => record.bodyRead).filter(Boolean);
      if (bodyReads.length) {
        await Promise.allSettled(bodyReads);
        deadline = Date.now() + timeout;
        continue;
      }
      if (Date.now() >= deadline) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  async waitForSetups(state, timeout) {
    const deadline = Date.now() + timeout;
    while (state.setupPromises.size && Date.now() < deadline) {
      const remaining = Math.max(0, deadline - Date.now());
      await Promise.race([
        Promise.allSettled([...state.setupPromises]),
        new Promise(resolve => setTimeout(resolve, Math.min(remaining, 20))),
      ]);
    }
  }

  isTargetCurrent(state, target) {
    return !state.closing && target.alive && state.targets.get(target.key) === target;
  }

  clearTargetTransientState(state, target) {
    const prefix = `${target.key}:`;
    for (const key of state.byRaw.keys()) if (key.startsWith(prefix)) state.byRaw.delete(key);
    for (const key of state.requestExtra.keys()) if (key.startsWith(prefix)) state.requestExtra.delete(key);
    for (const key of state.responseExtra.keys()) if (key.startsWith(prefix)) state.responseExtra.delete(key);
    for (const [key, record] of state.paused) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(record.timer);
      state.paused.delete(key);
    }
  }

  recordError(state, operation, target, error) {
    state.diagnostics.push({
      time: new Date().toISOString(),
      operation,
      targetType: target?.type || 'root',
      targetKey: target ? `S${target.ordinal}` : null,
      error: String(error?.message || error).slice(0, 500),
    });
    if (state.diagnostics.length > MAX_DIAGNOSTICS) state.diagnostics.shift();
  }
}

function parseRuleNames(value) {
  const names = String(value || '').split(/[\s,]+/).filter(Boolean);
  if (!names.length) throw new Error('At least one interception rule name is required');
  const unique = [...new Set(names)];
  unique.forEach(validateRuleName);
  return unique;
}

function headersToList(headers) {
  if (Array.isArray(headers)) return headers.map(header => ({ name: header.name, value: String(header.value ?? '') }));
  return Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value) }));
}

function removeHeaders(headers, names) {
  const removed = new Set(names.map(name => name.toLowerCase()));
  return headers.filter(header => !removed.has(header.name.toLowerCase()));
}

function boundedSet(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_REQUESTS) map.delete(map.keys().next().value);
}

function encodeUtf8Base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function setOwn(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
}

export const networkController = new NetworkController();
