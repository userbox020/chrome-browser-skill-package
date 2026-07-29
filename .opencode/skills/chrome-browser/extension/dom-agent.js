// Deliberately self-contained: chrome.scripting serializes this function into
// an isolated world where module-scope helpers are unavailable.
export async function runDomAgent(request = {}) {
  const MAX_REFS = 1_000;
  const MAX_ELEMENTS = 300;
  const MAX_TEXT = 5_000;
  const REGISTRY_KEY = '__opencodeChromeDomAgentV1';
  const normalize = value => String(value || '').replace(/[\s\u00a0]+/g, ' ').trim();
  const failure = (code, message, details = {}) => ({ ok: false, error: { code, message, ...details } });
  const documentKey = String(performance.timeOrigin);
  let registry = globalThis[REGISTRY_KEY];
  if (!registry || registry.documentKey !== documentKey) {
    registry = { documentKey, epoch: crypto.randomUUID(), nextRef: 1, nodes: new Map(), reverse: new WeakMap() };
    globalThis[REGISTRY_KEY] = registry;
  }

  const roots = () => {
    const values = [document];
    for (let index = 0; index < values.length; index++) {
      const root = values[index];
      for (const element of root.querySelectorAll?.('*') || []) {
        if (element.shadowRoot && !values.includes(element.shadowRoot)) values.push(element.shadowRoot);
      }
    }
    return values;
  };
  const queryAll = selector => {
    try {
      return [...new Set(roots().flatMap(root => [...root.querySelectorAll(selector)]))];
    } catch (error) {
      return failure('invalid-selector', `Invalid CSS selector: ${selector}`, { reason: String(error?.message || error) });
    }
  };
  const parentOrHost = element => element?.parentElement || element?.getRootNode?.()?.host || null;
  const nextLayout = () => new Promise(resolve => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(finish, 100);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
  const styleOf = element => {
    try { return getComputedStyle(element); } catch { return null; }
  };
  const visible = element => {
    if (!element?.isConnected || element.hidden || element.closest?.('[hidden],[inert]')) return false;
    for (let current = element; current; current = parentOrHost(current)) {
      const style = styleOf(current);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;
      if (current.getAttribute?.('aria-hidden') === 'true') return false;
    }
    const rect = element.getBoundingClientRect?.();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  };
  const disabled = element => Boolean(element?.disabled || element?.getAttribute?.('aria-disabled') === 'true' || element?.closest?.('fieldset[disabled]'));
  const readonly = element => Boolean(element?.readOnly || element?.getAttribute?.('aria-readonly') === 'true');
  const editable = element => {
    const tag = String(element?.tagName || '').toLowerCase();
    const type = String(element?.type || '').toLowerCase();
    if (tag === 'textarea') return !disabled(element) && !readonly(element);
    if (tag === 'input') return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type) && !disabled(element) && !readonly(element);
    return Boolean(element?.isContentEditable && !disabled(element) && !readonly(element));
  };
  const roleOf = element => {
    const explicit = normalize(element?.getAttribute?.('role'));
    if (explicit) return explicit;
    const tag = String(element?.tagName || '').toLowerCase();
    const type = String(element?.type || '').toLowerCase();
    if (tag === 'a' && element.hasAttribute?.('href')) return 'link';
    if (tag === 'button' || (tag === 'input' && ['button', 'image', 'reset', 'submit'].includes(type))) return 'button';
    if (tag === 'input' && type === 'checkbox') return 'checkbox';
    if (tag === 'input' && type === 'radio') return 'radio';
    if (tag === 'input' && type === 'range') return 'slider';
    if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea' || tag === 'input' || element?.isContentEditable) return 'textbox';
    if (tag === 'summary') return 'button';
    return '';
  };
  const labelledBy = element => normalize(element?.getAttribute?.('aria-labelledby')).split(' ').filter(Boolean).map(id => {
    const root = element.getRootNode?.();
    return root?.getElementById?.(id)?.textContent || document.getElementById?.(id)?.textContent || '';
  }).join(' ');
  const nameOf = element => {
    const aria = normalize(element?.getAttribute?.('aria-label'));
    if (aria) return aria;
    const referenced = normalize(labelledBy(element));
    if (referenced) return referenced;
    const labels = normalize([...(element?.labels || [])].map(label => label.textContent).join(' '));
    if (labels) return labels;
    const alt = normalize(element?.getAttribute?.('alt'));
    if (alt) return alt;
    const tag = String(element?.tagName || '').toLowerCase();
    const type = String(element?.type || '').toLowerCase();
    if (tag === 'input' && ['button', 'image', 'reset', 'submit'].includes(type) && normalize(element.value)) return normalize(element.value);
    return normalize(element?.innerText || element?.textContent || element?.getAttribute?.('title') || element?.getAttribute?.('placeholder')).slice(0, 300);
  };
  const refFor = element => {
    let ref = registry.reverse.get(element);
    if (ref && registry.nodes.has(ref)) return ref;
    ref = `${registry.epoch}:r${registry.nextRef++}`;
    registry.reverse.set(element, ref);
    registry.nodes.set(ref, element);
    if (registry.nodes.size > MAX_REFS) registry.nodes.delete(registry.nodes.keys().next().value);
    return ref;
  };
  const boundsOf = element => {
    const rect = element.getBoundingClientRect?.();
    if (!rect) return null;
    return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
  };
  const describe = element => ({
    ref: refFor(element),
    tag: String(element.tagName || '').toLowerCase(),
    role: roleOf(element),
    name: nameOf(element),
    type: String(element.type || '').toLowerCase(),
    text: normalize(element.innerText || element.textContent).slice(0, 300),
    state: {
      visible: visible(element),
      disabled: disabled(element),
      readonly: readonly(element),
      editable: editable(element),
      checked: typeof element.checked === 'boolean' ? element.checked : undefined,
      selected: typeof element.selected === 'boolean' ? element.selected : undefined,
      required: Boolean(element.required),
      expanded: element.getAttribute?.('aria-expanded') ?? undefined,
    },
    bounds: boundsOf(element),
  });
  const actionShape = action => {
    const raw = String(action || '');
    try {
      const url = new URL(raw || location.href, document.baseURI || location.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return { kind: 'opaque', raw };
      return {
        kind: 'http',
        origin: url.origin,
        pathname: url.pathname,
        query: [...url.searchParams.entries()].map(([key, value]) => ({ key, value })),
        fragment: url.hash,
      };
    } catch {
      return { kind: 'opaque', raw };
    }
  };
  const successfulControls = (form, submitter) => {
    if (!form?.elements) return [];
    return [...form.elements].flatMap(control => {
      const name = String(control.name || control.getAttribute?.('name') || '');
      const type = String(control.type || '').toLowerCase();
      if (!name || control.disabled || (['checkbox', 'radio'].includes(type) && !control.checked)) return [];
      if (['button', 'reset', 'submit', 'image'].includes(type) && control !== submitter) return [];
      let values;
      if (type === 'file') values = [...(control.files || [])].map(file => ({ name: file.name, size: file.size, type: file.type }));
      else if (String(control.tagName || '').toLowerCase() === 'select' && control.multiple) values = [...control.selectedOptions].map(option => String(option.value));
      else values = [String(control.value ?? '')];
      return [{ name, type, values, checked: typeof control.checked === 'boolean' ? control.checked : undefined }];
    });
  };
  const clickContext = element => {
    const form = element.form || null;
    const anchor = element.closest?.('a[href]') || null;
    const actionOverride = element.getAttribute?.('formaction');
    const methodOverride = element.getAttribute?.('formmethod');
    const enctypeOverride = element.getAttribute?.('formenctype');
    const rawAction = actionOverride != null ? (element.formAction || actionOverride || location.href) : (form?.action || location.href);
    return {
      version: 4,
      document: { href: String(location.href), timeOrigin: String(performance.timeOrigin) },
      target: {
        ref: refFor(element),
        tag: String(element.tagName || '').toUpperCase(),
        role: roleOf(element),
        id: String(element.id || ''),
        name: String(element.name || element.getAttribute?.('name') || ''),
        type: String(element.type || element.getAttribute?.('type') || '').toLowerCase(),
        value: String(element.value || element.getAttribute?.('value') || ''),
        label: nameOf(element),
      },
      anchor: anchor ? {
        href: actionShape(anchor.href || anchor.getAttribute?.('href')),
        target: String(anchor.target || anchor.getAttribute?.('target') || ''),
        download: String(anchor.download || anchor.getAttribute?.('download') || ''),
      } : null,
      form: form ? {
        action: actionShape(rawAction),
        method: String(methodOverride != null ? (element.formMethod || methodOverride || 'get') : (form.method || 'get')).toUpperCase(),
        enctype: String(enctypeOverride != null ? (element.formEnctype || enctypeOverride || 'application/x-www-form-urlencoded') : (form.enctype || 'application/x-www-form-urlencoded')).toLowerCase(),
        target: String(element.formTarget || element.getAttribute?.('formtarget') || form.target || ''),
        noValidate: Boolean(element.formNoValidate || form.noValidate),
        id: String(form.id || ''),
        name: String(form.name || form.getAttribute?.('name') || ''),
        controls: successfulControls(form, element),
      } : null,
    };
  };
  const contextChanges = (expected, current) => {
    if (!expected || expected.version !== 4) return ['context.schema'];
    const changed = [];
    const canonical = value => {
      if (Array.isArray(value)) return value.map(item => item === undefined ? null : canonical(item));
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
    };
    const compare = (path, left, right) => { if (JSON.stringify(canonical(left)) !== JSON.stringify(canonical(right))) changed.push(path); };
    compare('document', expected.document, current.document);
    compare('target.ref', expected.target?.ref, current.target.ref);
    compare('target.identity', expected.target && { ...expected.target, ref: undefined }, { ...current.target, ref: undefined });
    compare('anchor', expected.anchor ?? null, current.anchor ?? null);
    compare('form', expected.form ?? null, current.form ?? null);
    return changed;
  };
  const activeElement = () => {
    let current = document.activeElement;
    while (current?.shadowRoot?.activeElement) current = current.shadowRoot.activeElement;
    return current && !['BODY', 'HTML'].includes(String(current.tagName || '').toUpperCase()) ? current : null;
  };
  const consequential = (element, context) => {
    const label = context.target.label;
    const actionText = JSON.stringify({ anchor: context.anchor?.href, form: context.form?.action });
    return Boolean(element.form && ['submit', 'image'].includes(context.target.type))
      || /confirm|complete\s+(checkout|purchase|order)|submit\s+(order|payment)|place\s+order|checkout|purchase|buy\s+now|pay|publish|send|finali[sz]e|finalizar|comprar|pagar|transfer|delete|remove|revoke|disable|pause/i.test(`${label} ${actionText}`);
  };
  const interactiveElements = () => {
    const selector = 'a[href],button,input,select,textarea,summary,[role],[tabindex],label[for],[contenteditable]:not([contenteditable="false"])';
    const result = queryAll(selector);
    return result?.ok === false ? result : result.filter(element => roleOf(element) || editable(element) || element.matches?.('label[for]'));
  };
  const candidates = values => values.slice(0, 20).map(element => {
    const item = describe(element);
    return { ref: item.ref, tag: item.tag, role: item.role, name: item.name, text: item.text, state: item.state };
  });
  const resolve = target => {
    if (!target || typeof target !== 'object') return failure('invalid-target', 'Target must be a ref or locator');
    let matches;
    if (target.kind === 'ref') {
      const element = registry.nodes.get(String(target.value || ''));
      if (!element) return failure('stale', `Element ref is stale: ${target.value}`);
      if (!element.isConnected) return failure('stale', `Element ref is detached: ${target.value}`);
      return { ok: true, element };
    }
    if (target.kind === 'css') {
      const result = queryAll(String(target.value || ''));
      if (result?.ok === false) return result;
      matches = result;
    } else if (target.kind === 'text') {
      const wanted = normalize(target.value);
      const all = interactiveElements();
      if (all?.ok === false) return all;
      matches = all.filter(element => nameOf(element) === wanted || normalize(element.innerText || element.textContent) === wanted);
    } else if (target.kind === 'role') {
      const wantedRole = normalize(target.role || target.value).toLowerCase();
      const wantedName = target.name == null ? null : normalize(target.name);
      const all = interactiveElements();
      if (all?.ok === false) return all;
      matches = all.filter(element => roleOf(element).toLowerCase() === wantedRole && (wantedName == null || nameOf(element) === wantedName));
    } else return failure('invalid-target', `Unknown target kind: ${target.kind}`);
    if (!matches.length) return failure('not-found', `No element matches ${target.kind}: ${target.value || target.role}`);
    const actionable = target.includeHidden ? matches : matches.filter(visible);
    if (!actionable.length) return failure('hidden', 'Matching elements are not visible', { matchCount: matches.length, candidates: candidates(matches) });
    const index = target.nth == null ? null : Number(target.nth);
    if (index != null && Number.isInteger(index) && index >= 0 && index < actionable.length) return { ok: true, element: actionable[index] };
    if (actionable.length > 1) return failure('ambiguous', `${actionable.length} visible elements match`, { matchCount: actionable.length, candidates: candidates(actionable) });
    return { ok: true, element: actionable[0] };
  };
  const pointerActionability = element => {
    if (!visible(element)) return failure('hidden', 'Element is not visible');
    if (disabled(element)) return failure('disabled', 'Element is disabled');
    const style = styleOf(element);
    if (style?.pointerEvents === 'none') return failure('obscured', 'Element does not receive pointer events');
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    let hit = document.elementFromPoint?.(x, y);
    while (hit?.shadowRoot?.elementFromPoint) {
      const nested = hit.shadowRoot.elementFromPoint(x, y);
      if (!nested || nested === hit) break;
      hit = nested;
    }
    const composedContains = node => {
      for (let current = node; current; current = current.parentNode || current.getRootNode?.()?.host) if (current === element) return true;
      return false;
    };
    if (hit && !composedContains(hit) && !element.contains?.(hit)) return failure('obscured', 'Element is covered by another element', { covering: describe(hit) });
    return { ok: true, point: { x, y }, bounds: boundsOf(element) };
  };
  const preparePointer = async element => {
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const before = boundsOf(element);
    await nextLayout();
    const after = boundsOf(element);
    if (!before || !after || ['x', 'y', 'width', 'height'].some(key => Math.abs(before[key] - after[key]) > 1)) {
      return failure('moving', 'Element bounds did not stabilize');
    }
    return pointerActionability(element);
  };
  const setTextValue = (element, value) => {
    const tag = String(element.tagName || '').toLowerCase();
    if (!editable(element)) return failure(disabled(element) ? 'disabled' : readonly(element) ? 'readonly' : 'wrong-control', 'Element is not editable');
    element.focus?.();
    element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: value }));
    if (tag === 'input' || tag === 'textarea') {
      const prototype = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
    } else element.textContent = value;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    const actual = tag === 'input' || tag === 'textarea' ? String(element.value) : String(element.textContent || '');
    if (actual !== value) return failure('verification-failed', 'Element value did not match the requested value', { expectedLength: value.length, actualLength: actual.length });
    return { ok: true, filled: true, length: value.length, element: describe(element) };
  };
  const stateMatches = (state, resolution) => {
    if (state === 'detached') return resolution.ok === false && ['not-found', 'stale'].includes(resolution.error.code);
    if (!resolution.ok) return false;
    const element = resolution.element;
    if (state === 'attached') return element.isConnected;
    if (state === 'visible') return visible(element);
    if (state === 'hidden') return !visible(element);
    if (state === 'enabled') return !disabled(element);
    if (state === 'disabled') return disabled(element);
    if (state === 'editable') return editable(element);
    if (state === 'checked') return Boolean(element.checked);
    if (state === 'unchecked') return !element.checked;
    return false;
  };

  if (request.op === 'snapshot' || request.op === 'elements') {
    const text = normalize(document.body?.innerText || '');
    let elements = interactiveElements();
    if (elements?.ok === false) return elements;
    const query = normalize(request.query).toLowerCase();
    if (query) elements = elements.filter(element => `${roleOf(element)} ${nameOf(element)} ${normalize(element.innerText || element.textContent)}`.toLowerCase().includes(query));
    elements = elements.slice(0, MAX_ELEMENTS).map(describe);
    return {
      ok: true,
      documentKey,
      url: location.href,
      title: document.title,
      text: request.op === 'snapshot' ? text.slice(0, MAX_TEXT) : undefined,
      textLength: request.op === 'snapshot' ? text.length : undefined,
      truncated: request.op === 'snapshot' ? text.length > MAX_TEXT : undefined,
      elements,
    };
  }

  if (request.op === 'active-context') {
    if (!document.hasFocus()) return failure('not-focused', 'This frame does not own browser focus');
    const element = activeElement();
    if (!element) return failure('not-focused', 'No actionable element is focused in this frame');
    return { ok: true, documentKey, element: describe(element), approvalContext: clickContext(element) };
  }

  if (request.op === 'wait') {
    const timeout = Math.max(0, Math.min(Number(request.timeout) || 5_000, 20_000));
    const state = String(request.state || 'visible').toLowerCase();
    if (!['attached', 'detached', 'visible', 'hidden', 'enabled', 'disabled', 'editable', 'checked', 'unchecked'].includes(state)) return failure('invalid-state', `Unsupported element state: ${state}`);
    const deadline = Date.now() + timeout;
    let resolution = resolve(request.target);
    while (!stateMatches(state, resolution) && Date.now() < deadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
      resolution = resolve(request.target);
    }
    if (!stateMatches(state, resolution)) return failure('timeout', `Timed out waiting for element to become ${state}`, { timeout, state, lastError: resolution.error });
    return { ok: true, waited: true, state, timeout, element: resolution.ok ? describe(resolution.element) : null };
  }

  const resolution = resolve(request.target);
  if (!resolution.ok) return resolution;
  const element = resolution.element;
  if (request.op === 'describe') return { ok: true, documentKey, element: describe(element) };
  if (request.op === 'context') return { ok: true, documentKey, element: describe(element), approvalContext: clickContext(element) };
  if (request.op === 'scroll') {
    element.scrollIntoView({ block: request.block || 'center', inline: 'center' });
    return { ok: true, scrolled: true, element: describe(element) };
  }
  if (request.op === 'focus') {
    if (!visible(element)) return failure('hidden', 'Element is not visible');
    if (disabled(element)) return failure('disabled', 'Element is disabled');
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus?.();
    const root = element.getRootNode?.();
    if (document.activeElement !== element && root?.activeElement !== element) return failure('verification-failed', 'Element did not receive focus');
    return { ok: true, focused: true, element: describe(element) };
  }
  if (request.op === 'fill') return setTextValue(element, String(request.value ?? ''));
  if (request.op === 'clear') return setTextValue(element, '');
  if (request.op === 'select') {
    if (String(element.tagName || '').toLowerCase() !== 'select') return failure('wrong-control', 'Element is not a select control');
    if (disabled(element)) return failure('disabled', 'Select control is disabled');
    const wanted = String(request.value ?? '');
    const options = [...element.options].filter(option => String(option.value) === wanted || normalize(option.textContent) === normalize(wanted));
    if (!options.length) return failure('not-found', `No option matches: ${wanted}`);
    if (options.length > 1) return failure('ambiguous', `Multiple options match: ${wanted}`);
    element.value = options[0].value;
    options[0].selected = true;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selected: true, value: element.value, label: normalize(options[0].textContent), element: describe(element) };
  }
  if (request.op === 'check') {
    const type = String(element.type || '').toLowerCase();
    if (!['checkbox', 'radio'].includes(type)) return failure('wrong-control', 'Element is not a checkbox or radio control');
    if (disabled(element)) return failure('disabled', 'Control is disabled');
    const desired = Boolean(request.checked);
    if (type === 'radio' && !desired) return failure('wrong-control', 'Radio controls cannot be unchecked directly');
    const before = Boolean(element.checked);
    if (before !== desired) element.click();
    if (Boolean(element.checked) !== desired) return failure('verification-failed', 'Control did not reach the requested checked state');
    return { ok: true, checked: desired, changed: before !== desired, element: describe(element) };
  }
  if (request.op === 'prepare-upload') {
    if (String(element.tagName || '').toLowerCase() !== 'input' || String(element.type || '').toLowerCase() !== 'file') {
      return failure('wrong-control', 'Element is not a file input');
    }
    if (disabled(element)) return failure('disabled', 'File input is disabled');
    return { ok: true, prepared: true, element: describe(element) };
  }
  if (request.op === 'prepare-click') {
    const actionable = await preparePointer(element);
    if (!actionable.ok) return actionable;
    const approvalContext = clickContext(element);
    const isConsequential = consequential(element, approvalContext);
    if (request.approved) {
      const changedFields = contextChanges(request.expectedContext, approvalContext);
      if (changedFields.length) {
        return {
          ok: true,
          confirmationRequired: true,
          summary: `The click target changed and requires new approval (changed fields: ${changedFields.join(', ')})`,
          diagnostics: { changedFields },
          approvalContext,
          element: describe(element),
        };
      }
    } else if (isConsequential) {
      return {
        ok: true,
        confirmationRequired: true,
        summary: `Click consequential ${approvalContext.target.role || approvalContext.target.tag.toLowerCase()}: ${approvalContext.target.label}`,
        approvalContext,
        element: describe(element),
      };
    }
    return { ok: true, prepared: true, consequential: isConsequential, approvalContext, element: describe(element), scroll: { x: scrollX, y: scrollY }, ...actionable };
  }
  if (request.op === 'click-dom') {
    const actionable = await preparePointer(element);
    if (!actionable.ok) return actionable;
    element.click();
    return { ok: true, clicked: true, trusted: false, element: describe(element) };
  }
  if (request.op === 'commit-click') {
    const actionable = pointerActionability(element);
    if (!actionable.ok) return actionable;
    const approvalContext = clickContext(element);
    const changedFields = contextChanges(request.expectedContext, approvalContext);
    if (changedFields.length) return { ok: true, confirmationRequired: true, summary: 'The click target changed and requires new approval', diagnostics: { changedFields }, approvalContext, element: describe(element) };
    element.click();
    return { ok: true, clicked: true, trusted: false, consequential: consequential(element, approvalContext), element: describe(element) };
  }
  if (request.op === 'hover-dom') {
    const actionable = await preparePointer(element);
    if (!actionable.ok) return actionable;
    element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: actionable.point.x, clientY: actionable.point.y }));
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: actionable.point.x, clientY: actionable.point.y }));
    return { ok: true, hovered: true, trusted: false, element: describe(element) };
  }
  if (request.op === 'center') {
    const actionable = await preparePointer(element);
    if (!actionable.ok) return actionable;
    return { ok: true, documentKey, element: describe(element), scroll: { x: scrollX, y: scrollY }, ...actionable };
  }
  if (request.op === 'point') {
    const actionable = pointerActionability(element);
    if (!actionable.ok) return actionable;
    return { ok: true, documentKey, element: describe(element), scroll: { x: scrollX, y: scrollY }, ...actionable };
  }
  if (request.op === 'capture-geometry') {
    if (!visible(element)) return failure('hidden', 'Element is not visible');
    element.scrollIntoView({ block: 'center', inline: 'center' });
    await nextLayout();
    const bounds = boundsOf(element);
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return failure('hidden', 'Element has no visible area');
    return { ok: true, documentKey, element: describe(element), bounds };
  }
  return failure('unsupported-operation', `Unsupported DOM operation: ${request.op}`);
}
