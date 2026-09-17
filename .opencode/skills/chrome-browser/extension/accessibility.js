import { debuggerManager } from './debugger.js';
import { sameContext } from './context.js';

const AX_REF = /^@a[a-f0-9]+-\d+$/;
const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'gridcell', 'link', 'listbox', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'scrollbar', 'searchbox', 'slider', 'spinbutton', 'switch',
  'tab', 'textbox', 'treeitem',
]);

export class AccessibilityController {
  constructor(manager = debuggerManager) {
    this.manager = manager;
    this.tabs = new Map();
  }

  isRef(value) {
    return typeof value === 'string' && AX_REF.test(value);
  }

  clear(tabId) {
    this.tabs.delete(tabId);
  }

  async elements(tabId, query = '', options = {}) {
    const state = await this.state(tabId);
    await this.manager.send(tabId, 'Accessibility.enable');
    const tree = await this.manager.send(tabId, 'Accessibility.getFullAXTree');
    const needle = String(query || '').toLowerCase();
    const elements = [];
    const limit = Math.max(1, Math.min(Number(options.limit) || 300, 300));
    let total = 0;
    for (const node of tree.nodes || []) {
      const role = String(node.role?.value || '').toLowerCase();
      const name = String(node.name?.value || '');
      if (node.ignored || !node.backendDOMNodeId || (!INTERACTIVE_ROLES.has(role) && !node.properties?.some(property => property.name === 'focusable' && property.value?.value))) continue;
      if (needle && !`${role} ${name}`.toLowerCase().includes(needle)) continue;
      if (options.role && role !== String(options.role).toLowerCase()) continue;
      if (options.name != null && name !== String(options.name)) continue;
      total++;
      if (elements.length >= limit) continue;
      const properties = Object.fromEntries((node.properties || []).map(property => [property.name, property.value?.value]));
      const metadata = { role, name, properties };
      const ref = this.remember(state, node.backendDOMNodeId, metadata);
      elements.push({
        ref,
        source: 'accessibility',
        role,
        name: name.slice(0, 300),
        state: {
          disabled: Boolean(properties.disabled),
          editable: Boolean(properties.editable),
          focusable: Boolean(properties.focusable),
          checked: properties.checked,
          selected: properties.selected,
          expanded: properties.expanded,
        },
      });
    }
    return { total, returned: elements.length, truncated: total > elements.length, documentId: state.loaderId, elements };
  }

  async describe(tabId, ref) {
    const item = await this.resolve(tabId, ref);
    await this.refreshItem(tabId, item, ref);
    return this.call(tabId, item, 'describe', ref);
  }

  async context(tabId, ref) {
    const item = await this.resolve(tabId, ref);
    await this.refreshItem(tabId, item, ref);
    return this.call(tabId, item, 'context', ref);
  }

  async focused(tabId) {
    const state = await this.state(tabId);
    await this.manager.send(tabId, 'Accessibility.enable');
    const tree = await this.manager.send(tabId, 'Accessibility.getFullAXTree');
    const candidates = (tree.nodes || []).filter(node => node.backendDOMNodeId && propertyValue(node, 'focused') === true);
    const node = candidates.find(candidate => INTERACTIVE_ROLES.has(String(candidate.role?.value || '').toLowerCase()))
      || candidates.find(candidate => propertyValue(candidate, 'focusable') === true && !['rootwebarea', 'webarea', 'iframe'].includes(String(candidate.role?.value || '').toLowerCase()));
    if (!node) return null;
    const properties = Object.fromEntries((node.properties || []).map(property => [property.name, property.value?.value]));
    const ref = this.remember(state, node.backendDOMNodeId, { role: String(node.role?.value || '').toLowerCase(), name: String(node.name?.value || ''), properties });
    return this.call(tabId, state.refs.get(ref), 'context', ref);
  }

  async prepareClick(tabId, ref, approved, expectedContext) {
    const item = await this.resolve(tabId, ref);
    await this.scrollItem(tabId, item, ref);
    await this.refreshItem(tabId, item, ref);
    const described = await this.call(tabId, item, 'context', ref);
    const firstBox = await this.box(tabId, item, ref);
    await new Promise(resolve => setTimeout(resolve, 34));
    const box = await this.box(tabId, item, ref);
    if (['x', 'y', 'width', 'height'].some(key => Math.abs(firstBox.bounds[key] - box.bounds[key]) > 1)) throw this.error('moving', 'Accessibility target bounds did not stabilize');
    await this.verifyHit(tabId, item, box.point, ref);
    const context = described.approvalContext;
    const consequential = Boolean(described.consequential);
    if (approved && !sameContext(expectedContext, context)) {
      return { confirmationRequired: true, summary: 'The accessibility target changed and requires new approval', diagnostics: { changedFields: ['target.context'] }, approvalContext: context, element: described.element };
    }
    if (consequential && !approved) {
      return { confirmationRequired: true, summary: `Click consequential ${context.target.role || context.target.tag.toLowerCase()}: ${context.target.label}`, approvalContext: context, element: described.element };
    }
    return { prepared: true, consequential, approvalContext: context, element: described.element, ...box };
  }

  async focus(tabId, ref) {
    const item = await this.resolve(tabId, ref);
    await this.scrollItem(tabId, item, ref);
    try {
      await this.manager.send(tabId, 'DOM.focus', { backendNodeId: item.backendNodeId });
    } catch (error) {
      throw this.nodeError(error, ref);
    }
    return { focused: true, element: (await this.describe(tabId, ref)).element };
  }

  async scroll(tabId, ref) {
    const item = await this.resolve(tabId, ref);
    await this.scrollItem(tabId, item, ref);
    return { scrolled: true, element: (await this.call(tabId, item, 'describe', ref)).element };
  }

  async fill(tabId, ref, value) {
    const item = await this.resolve(tabId, ref);
    return this.call(tabId, item, 'fill', ref, String(value));
  }

  clearValue(tabId, ref) {
    return this.fill(tabId, ref, '');
  }

  async select(tabId, ref, value) {
    const item = await this.resolve(tabId, ref);
    return this.call(tabId, item, 'select', ref, String(value));
  }

  async setChecked(tabId, ref, checked) {
    const item = await this.resolve(tabId, ref);
    return this.call(tabId, item, 'check', ref, Boolean(checked));
  }

  async markUpload(tabId, ref, files) {
    const item = await this.resolve(tabId, ref);
    await this.manager.send(tabId, 'DOM.setFileInputFiles', { backendNodeId: item.backendNodeId, files });
    return { uploaded: true, fileCount: files.length, element: (await this.call(tabId, item, 'describe', ref)).element };
  }

  async wait(tabId, ref, wantedState = 'visible', timeout = 5_000) {
    wantedState = String(wantedState || 'visible').toLowerCase();
    const states = new Set(['attached', 'detached', 'visible', 'hidden', 'enabled', 'disabled', 'editable', 'checked', 'unchecked']);
    if (!states.has(wantedState)) throw this.error('invalid-state', `Unsupported element state: ${wantedState}`);
    const duration = Math.max(100, Math.min(Number(timeout) || 5_000, 20_000));
    const deadline = Date.now() + duration;
    let lastError = null;
    while (Date.now() <= deadline) {
      try {
        const described = await this.describe(tabId, ref);
        const state = described.element.state;
        let matched = false;
        if (wantedState === 'attached') matched = true;
        else if (wantedState === 'enabled') matched = !state.disabled;
        else if (wantedState === 'disabled') matched = state.disabled;
        else if (wantedState === 'editable') matched = state.editable;
        else if (wantedState === 'checked') matched = Boolean(state.checked);
        else if (wantedState === 'unchecked') matched = !state.checked;
        else if (wantedState === 'visible') { await this.box(tabId, ref); matched = true; }
        else if (wantedState === 'hidden') { try { await this.box(tabId, ref); } catch (error) { if (['hidden', 'stale'].includes(error.code)) matched = true; else throw error; } }
        if (matched) return { waited: true, state: wantedState, timeout: duration, element: described.element };
      } catch (error) {
        lastError = error;
        if (['detached', 'hidden'].includes(wantedState) && error.code === 'stale') return { waited: true, state: wantedState, timeout: duration, element: null };
        if (!['hidden', 'stale'].includes(error.code)) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw this.error('timeout', `Timed out waiting for accessibility target to become ${wantedState}`, { timeout: duration, lastError: lastError?.message || null });
  }

  async box(tabId, itemOrRef, knownRef = null) {
    const item = typeof itemOrRef === 'string' ? await this.resolve(tabId, itemOrRef) : itemOrRef;
    let result;
    try {
      result = await this.manager.send(tabId, 'DOM.getBoxModel', { backendNodeId: item.backendNodeId });
    } catch (error) {
      throw this.nodeError(error, knownRef || (typeof itemOrRef === 'string' ? itemOrRef : null));
    }
    const quad = result.model?.content || result.model?.border;
    if (!Array.isArray(quad) || quad.length < 8) throw this.error('hidden', 'Accessibility target has no visible box');
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const bounds = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    if (!(bounds.width > 0) || !(bounds.height > 0)) throw this.error('hidden', 'Accessibility target has no visible area');
    return { point: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, bounds };
  }

  async actionableBox(tabId, ref, scroll = true) {
    const item = await this.resolve(tabId, ref);
    if (scroll) await this.scrollItem(tabId, item, ref);
    const box = await this.box(tabId, item, ref);
    await this.verifyHit(tabId, item, box.point, ref);
    const described = await this.call(tabId, item, 'describe', ref);
    if (described.element.state.disabled) throw this.error('disabled', 'Accessibility target is disabled');
    return { ...box, element: { ...described.element, frameId: 0 } };
  }

  async state(tabId) {
    await this.manager.send(tabId, 'Page.enable');
    const frameTree = await this.manager.send(tabId, 'Page.getFrameTree');
    const loaderId = String(frameTree.frameTree?.frame?.loaderId || '');
    let state = this.tabs.get(tabId);
    if (!state || state.loaderId !== loaderId) {
      state = { epoch: crypto.randomUUID().replaceAll('-', '').slice(0, 8), loaderId, rootFrameId: String(frameTree.frameTree?.frame?.id || ''), nextRef: 1, refs: new Map(), reverse: new Map(), executionContextId: null };
      this.tabs.set(tabId, state);
    }
    return state;
  }

  remember(state, backendNodeId, metadata = null) {
    let ref = state.reverse.get(backendNodeId);
    if (!ref) {
      ref = `@a${state.epoch}-${state.nextRef++}`;
      state.reverse.set(backendNodeId, ref);
      state.refs.set(ref, { backendNodeId, loaderId: state.loaderId, metadata });
    }
    if (metadata) state.refs.get(ref).metadata = metadata;
    return ref;
  }

  async resolve(tabId, ref) {
    if (!this.isRef(ref)) throw this.error('invalid-target', `Invalid accessibility ref: ${ref}`);
    const state = await this.state(tabId);
    const item = state.refs.get(ref);
    if (!item) throw this.error('stale', `Unknown or stale accessibility ref: ${ref}`);
    return item;
  }

  async call(tabId, item, operation, ref, value) {
    const state = await this.state(tabId);
    const executionContextId = await this.executionContext(tabId, state);
    let resolved;
    try {
      resolved = await this.manager.send(tabId, 'DOM.resolveNode', { backendNodeId: item.backendNodeId, executionContextId, objectGroup: 'opencode-interaction' });
    } catch (error) {
      throw this.nodeError(error, ref);
    }
    const objectId = resolved.object?.objectId;
    if (!objectId) throw this.error('stale', `Could not resolve accessibility ref: ${ref}`);
    try {
      const response = await this.manager.send(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: AX_FUNCTION,
        arguments: [{ value: operation }, { value }, { value: ref }, { value: item.metadata || null }],
        awaitPromise: true,
        returnByValue: true,
        userGesture: false,
      });
      if (response.exceptionDetails) throw this.error('operation-failed', response.exceptionDetails.text || 'Accessibility operation failed');
      const result = response.result?.value;
      if (!result?.ok) throw this.error(result?.error?.code || 'operation-failed', result?.error?.message || 'Accessibility operation failed', result?.error || {});
      return result;
    } finally {
      await this.manager.send(tabId, 'Runtime.releaseObjectGroup', { objectGroup: 'opencode-interaction' }).catch(() => {});
    }
  }

  async scrollItem(tabId, item, ref) {
    try {
      await this.manager.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: item.backendNodeId });
    } catch (error) {
      throw this.nodeError(error, ref);
    }
  }

  async executionContext(tabId, state) {
    if (state.executionContextId) return state.executionContextId;
    const result = await this.manager.send(tabId, 'Page.createIsolatedWorld', { frameId: state.rootFrameId, worldName: 'opencode-accessibility', grantUniveralAccess: false });
    state.executionContextId = result.executionContextId;
    return state.executionContextId;
  }

  async refreshItem(tabId, item, ref) {
    let tree;
    try {
      tree = await this.manager.send(tabId, 'Accessibility.getPartialAXTree', { backendNodeId: item.backendNodeId, fetchRelatives: false });
    } catch (error) {
      throw this.nodeError(error, ref);
    }
    const node = (tree.nodes || []).find(candidate => candidate.backendDOMNodeId === item.backendNodeId && !candidate.ignored);
    if (!node) throw this.error('stale', `Accessibility ref is detached or stale: ${ref}`);
    item.metadata = {
      role: String(node.role?.value || '').toLowerCase(),
      name: String(node.name?.value || ''),
      properties: Object.fromEntries((node.properties || []).map(property => [property.name, property.value?.value])),
    };
  }

  async verifyHit(tabId, item, point, ref) {
    const hit = await this.manager.send(tabId, 'DOM.getNodeForLocation', { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: true });
    if (!hit.backendNodeId) throw this.error('obscured', 'Accessibility target could not be hit tested');
    if (hit.backendNodeId === item.backendNodeId) return;
    const state = await this.state(tabId);
    const executionContextId = await this.executionContext(tabId, state);
    const group = 'opencode-hit-test';
    try {
      const [target, covering] = await Promise.all([
        this.manager.send(tabId, 'DOM.resolveNode', { backendNodeId: item.backendNodeId, executionContextId, objectGroup: group }),
        this.manager.send(tabId, 'DOM.resolveNode', { backendNodeId: hit.backendNodeId, executionContextId, objectGroup: group }),
      ]);
      const response = await this.manager.send(tabId, 'Runtime.callFunctionOn', {
        objectId: target.object?.objectId,
        functionDeclaration: 'function(hit) { for (let node = hit; node; node = node.parentNode || node.getRootNode?.().host) if (node === this) return true; return false; }',
        arguments: [{ objectId: covering.object?.objectId }],
        returnByValue: true,
      });
      if (response.result?.value !== true) throw this.error('obscured', 'Accessibility target is covered by another element', { ref });
    } finally {
      await this.manager.send(tabId, 'Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
    }
  }

  nodeError(error, ref) {
    const message = String(error?.message || error);
    if (/layout object|compute box|not visible/i.test(message)) return this.error('hidden', 'Accessibility target has no visible box');
    if (/no node|find node|could not resolve|detached|execution context|cannot find context|cannot find object/i.test(message)) return this.error('stale', `Accessibility ref is detached or stale: ${ref || '[unknown]'}`);
    return error;
  }

  error(code, message, details = {}) {
    return Object.assign(new Error(message), { code, details });
  }
}

const AX_FUNCTION = `function(operation, value, ref, metadata) {
  const element = this;
  const normalize = input => String(input || '').replace(/[\\s\\u00a0]+/g, ' ').trim();
  const fail = (code, message) => ({ ok: false, error: { code, message } });
  if (!element.isConnected) return fail('stale', 'Accessibility target is detached');
  const role = normalize(metadata && metadata.role) || normalize(element.getAttribute && element.getAttribute('role')) || ({ A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox' }[element.tagName] || (element.type === 'checkbox' ? 'checkbox' : element.type === 'radio' ? 'radio' : element.tagName === 'INPUT' ? 'textbox' : ''));
  const labelledBy = normalize(element.getAttribute && element.getAttribute('aria-labelledby')).split(' ').filter(Boolean).map(id => element.getRootNode().getElementById?.(id)?.textContent || document.getElementById(id)?.textContent || '').join(' ');
  const label = normalize(metadata && metadata.name) || normalize(element.getAttribute && element.getAttribute('aria-label')) || normalize(labelledBy) || normalize(element.labels && Array.from(element.labels).map(item => item.textContent).join(' ')) || normalize(element.innerText || element.textContent || element.getAttribute?.('title') || element.getAttribute?.('placeholder'));
  const inputType = String(element.type || '').toLowerCase();
  const isEditable = Boolean(element.isContentEditable || element.tagName === 'TEXTAREA' || (element.tagName === 'INPUT' && !['button','checkbox','color','file','hidden','image','radio','range','reset','submit'].includes(inputType)));
  const isDisabled = Boolean(element.disabled || element.getAttribute?.('aria-disabled') === 'true' || element.closest?.('fieldset[disabled],[inert]'));
  const descriptor = { ref, source: 'accessibility', tag: String(element.tagName || '').toLowerCase(), role, name: label, type: inputType, state: { disabled: isDisabled, readonly: Boolean(element.readOnly), editable: isEditable && !isDisabled && !element.readOnly, checked: typeof element.checked === 'boolean' ? element.checked : undefined } };
  const action = raw => { const source = String(raw || ''); try { const url = new URL(source || location.href, document.baseURI || location.href); if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return { kind: 'opaque', raw: source }; return { kind: 'http', origin: url.origin, pathname: url.pathname, query: Array.from(url.searchParams.entries()).map(([key, value]) => ({ key, value })), fragment: url.hash }; } catch { return { kind: 'opaque', raw: source }; } };
  const form = element.form || null;
  const anchor = element.closest && element.closest('a[href]');
  const controls = form ? Array.from(form.elements).filter(control => control.name && !control.disabled && (!['checkbox','radio'].includes(control.type) || control.checked)).map(control => ({ name: String(control.name), type: String(control.type || '').toLowerCase(), values: control.type === 'file' ? Array.from(control.files || []).map(file => ({ name: file.name, size: file.size, type: file.type })) : [String(control.value || '')] })) : [];
  const actionOverride = element.getAttribute?.('formaction');
  const methodOverride = element.getAttribute?.('formmethod');
  const enctypeOverride = element.getAttribute?.('formenctype');
  const rawAction = actionOverride != null ? (element.formAction || actionOverride || location.href) : (form?.action || location.href);
  const context = { version: 4, document: { href: String(location.href), timeOrigin: String(performance.timeOrigin) }, target: { ref, tag: String(element.tagName || '').toUpperCase(), role, id: String(element.id || ''), name: String(element.name || ''), type: String(element.type || '').toLowerCase(), value: String(element.value || ''), label }, anchor: anchor ? { href: action(anchor.href), target: String(anchor.target || ''), download: String(anchor.download || '') } : null, form: form ? { action: action(rawAction), method: String(methodOverride != null ? (element.formMethod || methodOverride || 'get') : (form.method || 'get')).toUpperCase(), enctype: String(enctypeOverride != null ? (element.formEnctype || enctypeOverride || '') : (form.enctype || '')).toLowerCase(), target: String(element.formTarget || form.target || ''), noValidate: Boolean(element.formNoValidate || form.noValidate), id: String(form.id || ''), name: String(form.name || ''), controls } : null };
  const submitter = Boolean(form && ((element.tagName === 'BUTTON' && inputType !== 'button' && inputType !== 'reset') || (element.tagName === 'INPUT' && ['submit','image'].includes(inputType))));
  const consequential = submitter || /confirm|complete\s+(checkout|purchase|order)|submit\s+(order|payment)|place\s+order|checkout|purchase|buy\s+now|pay|publish|send|finali[sz]e|transfer|delete|remove|revoke|disable|pause/i.test(JSON.stringify({ label, anchor: context.anchor, form: context.form && context.form.action }));
  if (operation === 'describe') return { ok: true, element: descriptor };
  if (operation === 'context') return { ok: true, element: descriptor, approvalContext: context, consequential };
  if (isDisabled) return fail('disabled', 'Element is disabled');
  if (operation === 'focus') { element.focus(); return document.activeElement === element || element.getRootNode().activeElement === element ? { ok: true, focused: true, element: descriptor } : fail('verification-failed', 'Element did not receive focus'); }
  if (operation === 'fill') { if (!descriptor.state.editable) return fail(element.readOnly ? 'readonly' : 'wrong-control', 'Element is not editable'); if ('value' in element) { const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (setter) setter.call(element, String(value)); else element.value = String(value); } else element.textContent = String(value); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, filled: true, length: String(value).length, element: descriptor }; }
  if (operation === 'select') { if (element.tagName !== 'SELECT') return fail('wrong-control', 'Element is not a select control'); const options = Array.from(element.options).filter(option => String(option.value) === String(value) || normalize(option.textContent) === normalize(value)); if (options.length !== 1) return fail(options.length ? 'ambiguous' : 'not-found', 'Option did not resolve uniquely'); element.value = options[0].value; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, selected: true, value: element.value, element: descriptor }; }
  if (operation === 'check') { if (!['checkbox','radio'].includes(element.type)) return fail('wrong-control', 'Element is not a checkbox or radio'); const desired = Boolean(value); if (element.type === 'radio' && !desired) return fail('wrong-control', 'Radio controls cannot be unchecked'); if (Boolean(element.checked) !== desired) element.click(); return Boolean(element.checked) === desired ? { ok: true, checked: desired, element: descriptor } : fail('verification-failed', 'Checked state did not change'); }
  return fail('unsupported-operation', 'Unsupported accessibility operation');
}`;

export const accessibilityController = new AccessibilityController();

function propertyValue(node, name) {
  return (node.properties || []).find(property => property.name === name)?.value?.value;
}
