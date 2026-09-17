import { runDomAgent } from './dom-agent.js';

const REF_PATTERN = /^@e[a-f0-9]+-\d+$/;

export class DOMController {
  constructor(scripting = globalThis.chrome?.scripting) {
    this.scripting = scripting;
    this.tabs = new Map();
  }

  state(tabId) {
    let state = this.tabs.get(tabId);
    if (!state) {
      state = { epoch: crypto.randomUUID().replaceAll('-', '').slice(0, 8), nextRef: 1, refs: new Map(), reverse: new Map(), frameDocuments: new Map() };
      this.tabs.set(tabId, state);
    }
    return state;
  }

  clear(tabId) {
    this.tabs.delete(tabId);
  }

  async snapshot(tabId, query = '', includeText = true, options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 300, 300));
    const target = options.frame == null ? { allFrames: true } : { frameIds: [Number(options.frame)] };
    const results = await this.execute(tabId, { op: includeText ? 'snapshot' : 'elements', query, role: options.role, name: options.name, visible: options.visible, includeHidden: options.includeHidden, limit }, target);
    const state = this.state(tabId);
    const frames = [];
    for (const entry of results) {
      if (!entry.result?.ok) continue;
      this.invalidateFrame(state, entry.frameId, entry.documentId);
      frames.push({
        frameId: entry.frameId,
        documentId: entry.documentId,
        url: entry.result.url,
        title: entry.result.title,
        text: entry.result.text,
        textLength: entry.result.textLength,
        truncated: entry.result.truncated,
        total: entry.result.total ?? entry.result.elements?.length ?? 0,
        elements: (entry.result.elements || []).map(element => this.decorate(state, entry, element)),
      });
    }
    frames.sort((left, right) => left.frameId - right.frameId);
    const top = frames.find(frame => frame.frameId === 0) || frames[0];
    if (!top) throw this.error('injection-failed', 'No accessible frame returned a DOM snapshot');
    const frameSummary = frames.map(frame => ({ frameId: frame.frameId, documentId: frame.documentId, url: frame.url, title: frame.title, elementCount: frame.total }));
    const elements = frames.flatMap(frame => frame.elements).slice(0, limit);
    const total = frames.reduce((sum, frame) => sum + frame.total, 0);
    const failedFrameCount = results.filter(entry => !entry.result?.ok).length;
    if (!includeText) return { total, returned: elements.length, truncated: total > elements.length, elements, frames: frameSummary, ...(failedFrameCount ? { failedFrameCount } : {}) };
    return {
      title: top.title,
      url: top.url,
      text: top.text,
      textLength: top.textLength,
      truncated: Boolean(top.truncated) || total > elements.length,
      total,
      returned: elements.length,
      elements,
      frames: frameSummary,
    };
  }

  async run(tabId, op, target, params = {}, kind = 'css') {
    const spec = this.target(tabId, target, kind);
    let entries;
    try {
      entries = await this.execute(tabId, { op, target: spec.target, ...params }, spec.documentId ? { documentIds: [spec.documentId] } : { frameIds: [spec.frameId] });
    } catch (error) {
      if (spec.documentId && /document|frame.*removed|no frame/i.test(error.message)) {
        this.clearStaleRef(tabId, spec.publicRef);
        throw this.error('wrong-document', 'The target document is no longer available');
      }
      throw error;
    }
    const entry = entries[0];
    if (!entry) throw this.error('injection-failed', 'Target frame did not return a result');
    if (spec.documentId && entry.documentId !== spec.documentId) {
      this.clearStaleRef(tabId, spec.publicRef);
      throw this.error('wrong-document', `Element ref belongs to an older document: ${spec.publicRef}`, { ref: spec.publicRef });
    }
    const state = this.state(tabId);
    this.invalidateFrame(state, entry.frameId, entry.documentId);
    if (!entry.result?.ok) {
      const details = { ...(entry.result?.error || {}) };
      if (details.candidates) details.candidates = details.candidates.map(item => this.decorate(state, entry, item));
      if (details.covering) details.covering = this.decorate(state, entry, details.covering);
      throw this.error(details.code || 'operation-failed', details.message || 'DOM operation failed', details);
    }
    return this.decorateResult(state, entry, entry.result);
  }

  async active(tabId) {
    const entries = await this.execute(tabId, { op: 'active-context' }, { allFrames: true });
    const candidates = entries.filter(entry => entry.result?.ok && !['body', 'html', 'iframe'].includes(entry.result.element?.tag));
    if (candidates.length > 1) throw this.error('ambiguous-focus', 'Multiple frames reported a focused actionable element');
    const entry = candidates[0];
    if (!entry) throw this.error('not-focused', 'No actionable element is focused in the selected tab');
    const state = this.state(tabId);
    this.invalidateFrame(state, entry.frameId, entry.documentId);
    const result = this.decorateResult(state, entry, entry.result);
    return { ...result, frameId: entry.frameId, documentId: entry.documentId };
  }

  target(tabId, value, kind = 'css') {
    if (typeof value === 'string' && REF_PATTERN.test(value)) {
      const item = this.state(tabId).refs.get(value);
      if (!item) throw this.error('stale', `Unknown or stale element ref: ${value}`, { ref: value });
      return { publicRef: value, frameId: item.frameId, documentId: item.documentId, target: { kind: 'ref', value: item.localRef } };
    }
    if (value && typeof value === 'object') return { publicRef: null, frameId: Number(value.frameId) || 0, documentId: null, target: value };
    return { publicRef: null, frameId: 0, documentId: null, target: { kind, value: String(value || '') } };
  }

  async execute(tabId, request, target) {
    return this.scripting.executeScript({ target: { tabId, ...target }, world: 'ISOLATED', func: runDomAgent, args: [request] });
  }

  decorate(state, entry, element) {
    if (!element?.ref) return element;
    const key = `${entry.frameId}:${entry.documentId}:${element.ref}`;
    let publicRef = state.reverse.get(key);
    if (!publicRef) {
      publicRef = `@e${state.epoch}-${state.nextRef++}`;
      state.reverse.set(key, publicRef);
      state.refs.set(publicRef, { frameId: entry.frameId, documentId: entry.documentId, localRef: element.ref });
    }
    return { ...element, ref: publicRef, frameId: entry.frameId, documentId: entry.documentId };
  }

  decorateResult(state, entry, result) {
    const copy = { ...result };
    if (copy.element) copy.element = this.decorate(state, entry, copy.element);
    if (copy.covering) copy.covering = this.decorate(state, entry, copy.covering);
    return copy;
  }

  invalidateFrame(state, frameId, documentId) {
    const previous = state.frameDocuments.get(frameId);
    if (previous && previous !== documentId) {
      for (const [ref, item] of state.refs) {
        if (item.frameId !== frameId) continue;
        state.refs.delete(ref);
        state.reverse.delete(`${item.frameId}:${item.documentId}:${item.localRef}`);
      }
    }
    state.frameDocuments.set(frameId, documentId);
  }

  clearStaleRef(tabId, ref) {
    if (!ref) return;
    const state = this.tabs.get(tabId);
    const item = state?.refs.get(ref);
    if (!item) return;
    state.refs.delete(ref);
    state.reverse.delete(`${item.frameId}:${item.documentId}:${item.localRef}`);
  }

  error(code, message, details = {}) {
    return Object.assign(new Error(message), { code, details });
  }
}

export const domController = new DOMController();
