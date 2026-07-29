const PROTOCOL_VERSION = '1.3';
const IDLE_TIMEOUT = 60_000;

export class DebuggerManager {
  constructor() {
    this.sessions = new Map();
    this.attaching = new Map();
    this.eventListeners = new Set();
    this.detachListeners = new Set();
    this.executionContexts = new Map();
    chrome.debugger.onEvent.addListener((source, method, params) => {
      this.trackExecutionContext(source, method, params);
      for (const listener of this.eventListeners) listener(source, method, params);
    });
    chrome.debugger.onDetach.addListener((source, reason) => {
      const tabId = source.tabId;
      if (tabId != null) {
        const session = this.sessions.get(tabId);
        if (session?.timer) clearTimeout(session.timer);
        this.sessions.delete(tabId);
        this.executionContexts.delete(tabId);
      }
      for (const listener of this.detachListeners) listener(source, reason);
    });
  }

  async attach(tabId) {
    let session = this.sessions.get(tabId);
    if (session?.attached) {
      this.touch(tabId);
      return;
    }
    if (!this.attaching.has(tabId)) {
      const attaching = callChrome(chrome.debugger.attach, { tabId }, PROTOCOL_VERSION)
        .then(() => {
          const attached = { attached: true, pins: new Set(), timer: null };
          this.sessions.set(tabId, attached);
        })
        .finally(() => this.attaching.delete(tabId));
      this.attaching.set(tabId, attaching);
    }
    await this.attaching.get(tabId);
    this.touch(tabId);
  }

  async send(tabId, method, params = {}) {
    return this.sendSession({ tabId }, method, params);
  }

  async sendSession(source, method, params = {}, options = {}) {
    const tabId = source?.tabId;
    if (!Number.isInteger(tabId)) throw new Error('Debugger session requires a tab ID');
    if (options.attach === false) {
      if (!this.sessions.get(tabId)?.attached) throw new Error('Debugger root session is not attached');
    } else {
      await this.attach(tabId);
    }
    try {
      const target = source.sessionId ? { tabId, sessionId: source.sessionId } : { tabId };
      return await callChrome(chrome.debugger.sendCommand, target, method, params);
    } finally {
      this.touch(tabId);
    }
  }

  async pin(tabId, reason) {
    await this.attach(tabId);
    const session = this.sessions.get(tabId);
    session.pins.add(reason);
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
  }

  unpin(tabId, reason) {
    const session = this.sessions.get(tabId);
    if (!session) return;
    session.pins.delete(reason);
    this.touch(tabId);
  }

  async detach(tabId) {
    if (this.attaching.has(tabId)) await this.attaching.get(tabId).catch(() => {});
    const session = this.sessions.get(tabId);
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    this.sessions.delete(tabId);
    this.executionContexts.delete(tabId);
    await callChrome(chrome.debugger.detach, { tabId }).catch(() => {});
  }

  touch(tabId) {
    const session = this.sessions.get(tabId);
    if (!session || session.pins.size) return;
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => this.detach(tabId), IDLE_TIMEOUT);
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onDetach(listener) {
    this.detachListeners.add(listener);
    return () => this.detachListeners.delete(listener);
  }

  contexts(tabId, sessionId = null) {
    return [...(this.executionContexts.get(tabId)?.values() || [])].filter(item => (item.sessionId || null) === sessionId);
  }

  trackExecutionContext(source, method, params) {
    if (!Number.isInteger(source?.tabId)) return;
    let contexts = this.executionContexts.get(source.tabId);
    if (!contexts) {
      contexts = new Map();
      this.executionContexts.set(source.tabId, contexts);
    }
    if (method === 'Runtime.executionContextCreated' && params.context?.id != null) {
      contexts.set(params.context.id, { ...params.context, sessionId: source.sessionId || null });
    } else if (method === 'Runtime.executionContextDestroyed') contexts.delete(params.executionContextId);
    else if (method === 'Runtime.executionContextsCleared') {
      for (const [id, item] of contexts) if ((item.sessionId || null) === (source.sessionId || null)) contexts.delete(id);
    }
  }
}

function callChrome(method, ...args) {
  return new Promise((resolve, reject) => {
    method.call(chrome.debugger, ...args, result => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

export const debuggerManager = new DebuggerManager();
