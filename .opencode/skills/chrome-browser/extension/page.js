import { browserError } from './errors.js';

const MAX_TEXT = 5_000;
const MAX_HTML = 2_000_000;

export function isInspectableUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

export async function listTabs(selectedTabId, options = {}) {
  const tabs = await chrome.tabs.query({});
  const needle = String(options.query || '').toLowerCase();
  const matches = tabs.filter(tab => !needle || `${tab.title || ''} ${tab.url || ''}`.toLowerCase().includes(needle));
  const limit = options.limit == null ? matches.length : Math.max(1, Math.min(Number(options.limit) || 20, 300));
  const result = matches.slice(0, limit).map(tab => ({
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    selected: tab.id === selectedTabId,
    inspectable: isInspectableUrl(tab.url),
    title: tab.title || '',
    url: tab.url || '',
  }));
  return options.limit == null && options.query == null ? result : { total: matches.length, returned: result.length, truncated: matches.length > result.length, tabs: result };
}

export async function selectTab(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) throw new Error(`Invalid tab ID: ${tabId}`);
  const tab = await chrome.tabs.get(id);
  if (!isInspectableUrl(tab.url)) throw browserError('unsupported-page');
  await chrome.tabs.update(id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return tabInfo(tab, true);
}

export async function requireSelectedTab(tabId) {
  if (!Number.isInteger(tabId)) throw browserError('no-tab-selected');
  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch { throw browserError('tab-closed'); }
  if (!isInspectableUrl(tab.url)) throw browserError('unsupported-page');
  return tab;
}

export function tabInfo(tab, selected = true) {
  return { tabId: tab.id, windowId: tab.windowId, title: tab.title || '', url: tab.url || '', selected };
}

export async function pageContext(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: () => ({ url: location.href, origin: location.origin, title: document.title }),
  });
  const entry = results?.[0];
  if (!entry?.documentId || !entry.result) throw new Error('Could not identify the selected document');
  return { tabId, ...entry.result, documentId: entry.documentId };
}

export async function pageSnap(tabId) {
  return execute(tabId, limit => ({
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || '').slice(0, limit),
  }), [MAX_TEXT]);
}

export async function pageHtml(tabId, selector) {
  return execute(tabId, (query, limit) => {
    const element = query ? document.querySelector(query) : document.documentElement;
    if (!element) return { error: `Element not found: ${query}` };
    const html = element.outerHTML || '';
    return { html: html.slice(0, limit), truncated: html.length > limit, length: html.length };
  }, [selector || null, MAX_HTML]);
}

export async function pageInspect(tabId) {
  return execute(tabId, () => {
    const hiddenInputs = [...document.querySelectorAll('input[type="hidden"]')].map(element => ({
      name: element.name || '', id: element.id || '', value: (element.value || '').slice(0, 200),
    }));
    const forms = [...document.querySelectorAll('form')].map((form, index) => ({
      index,
      action: form.action || '',
      method: (form.method || 'get').toUpperCase(),
      fields: [...form.querySelectorAll('input, select, textarea, button')].map(element => ({
        tag: element.tagName.toLowerCase(),
        type: element.type || element.tagName.toLowerCase(),
        name: element.name || '',
        id: element.id || '',
        value: (element.value || '').slice(0, 200),
        autocomplete: element.autocomplete || '',
        required: Boolean(element.required),
      })),
    }));
    const priceSelector = '[data-price], [data-amount], .price, .amount, .total, .subtotal, [class*="price" i], [class*="amount" i], [class*="total" i], [id*="price" i], [id*="amount" i], [id*="total" i]';
    const priceElements = [...document.querySelectorAll(priceSelector)].slice(0, 100).map(element => ({
      tag: element.tagName,
      id: element.id || '',
      class: typeof element.className === 'string' ? element.className.slice(0, 120) : '',
      text: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    }));
    const csrfTokens = [...document.querySelectorAll('meta[name*="csrf" i], input[name*="csrf" i], input[name*="xsrf" i]')].map(element => ({
      source: element.tagName.toLowerCase(),
      name: element.getAttribute('name') || '',
      value: (element.content || element.value || '').slice(0, 200),
    }));
    return { hiddenInputs, forms, priceElements, csrfTokens, scriptCount: document.scripts.length };
  });
}

export async function pageStorage(tabId) {
  return execute(tabId, () => {
    const read = storage => {
      const output = {};
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        output[key] = (storage.getItem(key) || '').slice(0, 10_000);
      }
      return output;
    };
    const cookies = document.cookie.split(';').map(item => item.trim()).filter(Boolean).map(item => {
      const separator = item.indexOf('=');
      return separator < 0
        ? { name: item, value: '' }
        : { name: item.slice(0, separator), value: item.slice(separator + 1) };
    });
    return { origin: location.origin, localStorage: read(localStorage), sessionStorage: read(sessionStorage), cookies };
  });
}

// This function is deliberately self-contained: Chrome serializes it into the page's
// MAIN world, where module-scope helpers are unavailable. Both locator commands use
// this one builder/comparator so their confirmation semantics cannot drift.
export function clickSemanticTarget(locatorKind, locatorValue, approved, expectedContext) {
  const normalizeText = value => String(value || '').replace(/\s+/g, ' ').trim();
  const attribute = (element, name) => element?.getAttribute?.(name);
  const sortObjects = values => values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const resolveTarget = () => {
    if (locatorKind === 'selector') {
      const element = document.querySelector(locatorValue);
      return element ? { element } : { error: `Element not found: ${locatorValue}` };
    }
    const clickableSelector = 'button, a[href], input[type="button"], input[type="submit"], input[type="image"], [role="button"]';
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const matches = [...document.querySelectorAll(clickableSelector)].filter(visible).filter(element => {
      const label = element instanceof HTMLInputElement
        ? element.value || attribute(element, 'aria-label')
        : element.innerText || attribute(element, 'aria-label') || element.textContent;
      return normalizeText(label) === normalizeText(locatorValue);
    });
    if (!matches.length) return { error: `No visible clickable element has exact text: ${locatorValue}` };
    if (matches.length > 1) return {
      error: `Ambiguous exact text: ${matches.length} elements match`,
      candidates: matches.slice(0, 20).map(element => ({
        tag: element.tagName,
        id: element.id || '',
        text: normalizeText(element.textContent).slice(0, 120),
      })),
    };
    return { element: matches[0] };
  };
  const actionShape = action => {
    const raw = String(action || '');
    try {
      const url = new URL(raw || location.href, document.baseURI || location.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        return { kind: 'opaque', raw };
      }
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
  const resourceBinding = element => {
    const container = element.closest?.('tr,[role="row"],li,article');
    if (!container) return { state: 'no-container' };
    const candidates = candidateContainer => {
      const genericValues = new Set(['', 'on', 'off', 'true', 'false', 'yes', 'no', '1', '0', 'selected']);
      const controls = [...candidateContainer.querySelectorAll('input[type="checkbox"][name], input[type="radio"][name]')]
        .flatMap(control => {
          const attributeValue = attribute(control, 'value');
          const effectiveValue = String(control.value ?? '');
          const name = String(control.name || attribute(control, 'name') || '');
          // A native default such as name=selected,value=on is not a resource ID.
          // Requiring an explicit attribute equal to the effective property avoids
          // treating transient/default control state as a stable binding.
          if (!name || attributeValue === null || String(attributeValue) !== effectiveValue || genericValues.has(effectiveValue.toLowerCase())) return [];
          return [{
            tag: String(control.tagName || '').toUpperCase(),
            type: String(control.type || attribute(control, 'type') || '').toLowerCase(),
            name,
            value: effectiveValue,
            attributeValue: String(attributeValue),
          }];
        });
      const editLinks = [...candidateContainer.querySelectorAll('a[href]')].flatMap(link => {
        const rawHref = String(link.href || attribute(link, 'href') || '');
        try {
          const url = new URL(rawHref, document.baseURI || location.href);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
          const segments = url.pathname.split('/').filter(Boolean);
          const editIndex = segments.findIndex(segment => segment.toLowerCase() === 'edit');
          if (editIndex < 0) return [];
          const preceding = editIndex > 0 ? segments[editIndex - 1] : '';
          const genericSegments = new Set(['', 'resource', 'resources', 'item', 'items', 'record', 'records', 'manage']);
          const hasPathIdentity = preceding && !genericSegments.has(preceding.toLowerCase());
          const query = [...url.searchParams.entries()].map(([key, value]) => ({ key, value }));
          const idEntries = query.filter(entry => entry.key === 'id' && entry.value && !genericValues.has(entry.value.toLowerCase()));
          // /edit?id=... is usable only when its exact query identity is retained;
          // otherwise the path itself must carry a distinct resource segment.
          if (!hasPathIdentity && idEntries.length !== 1) return [];
          return [{
            origin: url.origin,
            pathname: url.pathname,
            query,
            fragment: url.hash,
          }];
        } catch { return []; }
      });
      return { controls: sortObjects(controls), editLinks: sortObjects(editLinks) };
    };
    const current = candidates(container);
    if (!current.controls.length && !current.editLinks.length) return { state: 'unbound-row' };
    const identity = JSON.stringify(current);
    const peers = [...document.querySelectorAll('tr,[role="row"],li,article')];
    if (peers.length) {
      const matches = peers.filter(peer => JSON.stringify(candidates(peer)) === identity);
      if (matches.length !== 1 || matches[0] !== container) return { state: 'unbound-row' };
    }
    return {
      state: 'strong-unique',
      scope: { tag: String(container.tagName || '').toUpperCase(), role: String(attribute(container, 'role') || '') },
      controls: current.controls,
      editLinks: current.editLinks,
    };
  };
  const buildContext = element => {
    const form = element.form || null;
    const label = normalizeText(element.innerText || element.value || attribute(element, 'aria-label') || element.textContent).slice(0, 200);
    const actionOverride = attribute(element, 'formaction');
    const rawAction = actionOverride !== null && actionOverride !== undefined
      ? (element.formAction || actionOverride || location.href)
      : (form?.action || location.href);
    const methodOverride = attribute(element, 'formmethod');
    const enctypeOverride = attribute(element, 'formenctype');
    return {
      version: 3,
      document: { href: String(location.href), timeOrigin: String(performance.timeOrigin) },
      locator: { kind: locatorKind, value: String(locatorValue) },
      submitter: {
        tag: String(element.tagName || '').toUpperCase(),
        id: String(element.id || ''),
        name: String(element.name || attribute(element, 'name') || ''),
        type: String(element.type || attribute(element, 'type') || '').toLowerCase(),
        value: String(element.value || attribute(element, 'value') || ''),
        label,
      },
      form: {
        action: actionShape(rawAction),
        method: String(methodOverride !== null && methodOverride !== undefined
          ? (element.formMethod || methodOverride || 'get')
          : (form?.method || 'get')).toUpperCase(),
        enctype: String(enctypeOverride !== null && enctypeOverride !== undefined
          ? (element.formEnctype || enctypeOverride || 'application/x-www-form-urlencoded')
          : (form?.enctype || 'application/x-www-form-urlencoded')).toLowerCase(),
        id: String(form?.id || ''),
        name: String(form?.name || attribute(form, 'name') || ''),
      },
      resourceBinding: resourceBinding(element),
    };
  };
  const compareContexts = (expected, current, rejectUnboundRow = false) => {
    const changed = new Set();
    const check = (path, left, right) => { if (left !== right) changed.add(path); };
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
      changed.add('context.schema');
      return [...changed];
    }
    check('version', expected.version, current.version);
    for (const field of ['href', 'timeOrigin']) check(`document.${field}`, expected.document?.[field], current.document[field]);
    for (const field of ['kind', 'value']) check(`locator.${field}`, expected.locator?.[field], current.locator[field]);
    for (const field of ['tag', 'id', 'name', 'type', 'value', 'label']) check(`submitter.${field}`, expected.submitter?.[field], current.submitter[field]);
    check('form.action.kind', expected.form?.action?.kind, current.form.action.kind);
    if (expected.form?.action?.kind === 'opaque' || current.form.action.kind === 'opaque') {
      check('form.action.raw', expected.form?.action?.raw, current.form.action.raw);
    } else {
      for (const field of ['origin', 'pathname', 'fragment']) check(`form.action.${field}`, expected.form?.action?.[field], current.form.action[field]);
    }
    for (const field of ['method', 'enctype', 'id', 'name']) check(`form.${field}`, expected.form?.[field], current.form[field]);

    const expectedResource = expected.resourceBinding ?? null;
    const resourceMatches = JSON.stringify(expectedResource) === JSON.stringify(current.resourceBinding);
    check('resourceBinding.state', expectedResource?.state, current.resourceBinding?.state);
    if (!resourceMatches) changed.add('resourceBinding.identity');
    if (rejectUnboundRow && (expectedResource?.state === 'unbound-row' || current.resourceBinding?.state === 'unbound-row')) {
      changed.add('resourceBinding.unbound');
    }
    const expectedQuery = expected.form?.action?.query;
    const currentQuery = current.form.action.query;
    const auditedVolatileQueryAllowlist = [];
    const mayIgnoreValue = entry => resourceMatches
      && current.resourceBinding?.state === 'strong-unique'
      && auditedVolatileQueryAllowlist.some(rule => rule.origin === current.form.action.origin
        && rule.pathname === current.form.action.pathname
        && rule.parameter === entry.key);
    if (current.form.action.kind === 'http' && (!Array.isArray(expectedQuery) || expectedQuery.length !== currentQuery.length)) {
      changed.add('form.action.query.shape');
    } else if (current.form.action.kind === 'http') {
      for (let index = 0; index < currentQuery.length; index++) {
        if (expectedQuery[index]?.key !== currentQuery[index].key) changed.add('form.action.query.shape');
        if (expectedQuery[index]?.value !== currentQuery[index].value && !mayIgnoreValue(currentQuery[index])) {
          changed.add('form.action.query.value');
        }
      }
    }
    return [...changed].sort();
  };
  const consequentialTarget = (element, context) => Boolean(element.form && ['submit', 'image'].includes(context.submitter.type))
    || /confirm|complete\s+(checkout|purchase|order)|submit\s+(order|payment)|place\s+order|checkout|purchase|buy\s+now|pay|finali[sz]e|finalizar|comprar|pagar|transfer|delete\s+account|remove\s+account/i.test(context.submitter.label);
  const mismatch = (context, changedFields) => ({
    confirmationRequired: true,
    summary: `The click target changed and requires new approval (changed fields: ${changedFields.join(', ')})`,
    diagnostics: { changedFields },
    approvalContext: context,
  });

  const initial = resolveTarget();
  if (initial.error) return initial;
  const initialContext = buildContext(initial.element);
  const initialConsequential = consequentialTarget(initial.element, initialContext);
  if (approved) {
    const changedFields = compareContexts(expectedContext, initialContext, initialConsequential);
    if (changedFields.length) return mismatch(initialContext, changedFields);
  }
  if (initialConsequential && !approved) {
    return { confirmationRequired: true, summary: `Click consequential element: ${initialContext.submitter.label}`, approvalContext: initialContext };
  }

  initial.element.scrollIntoView({ block: 'center', inline: 'center' });
  initial.element.focus?.();

  // Focus can synchronously rerender or mutate controls. Resolve from the exact
  // locator again and validate immediately before dispatching the click.
  const prepared = resolveTarget();
  if (prepared.error || !prepared.element?.isConnected) return mismatch(initialContext, ['locator.target']);
  const preparedContext = buildContext(prepared.element);
  const preparedConsequential = consequentialTarget(prepared.element, preparedContext);
  const changedAfterFocus = compareContexts(approved ? expectedContext : initialContext, preparedContext, approved && preparedConsequential);
  if (changedAfterFocus.length) return mismatch(preparedContext, changedAfterFocus);
  if (preparedConsequential && !approved) {
    return { confirmationRequired: true, summary: `Click consequential element: ${preparedContext.submitter.label}`, approvalContext: preparedContext };
  }
  prepared.element.click();
  return { clicked: true, tag: prepared.element.tagName, label: preparedContext.submitter.label };
}

export async function clickSelector(tabId, selector, confirmed, approvedContext) {
  return execute(tabId, clickSemanticTarget, ['selector', selector, Boolean(confirmed), approvedContext || null]);
}

export async function clickText(tabId, text, confirmed, approvedContext) {
  return execute(tabId, clickSemanticTarget, ['text', text, Boolean(confirmed), approvedContext || null]);
}

export async function fill(tabId, selector, value) {
  return execute(tabId, (query, text) => {
    const element = document.querySelector(query);
    if (!element) return { error: `Element not found: ${query}` };
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, text);
      else element.value = text;
    } else if (element.isContentEditable) {
      element.textContent = text;
    } else return { error: `Element is not editable: ${query}` };
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: true, tag: element.tagName, length: String(text).length };
  }, [selector, String(value)]);
}

export async function scroll(tabId, x = 0, y = 0) {
  return execute(tabId, (left, top) => {
    window.scrollBy(left, top);
    return { x: window.scrollX, y: window.scrollY };
  }, [x || 0, y || 0]);
}

export async function elementCenter(tabId, selector) {
  return execute(tabId, query => {
    const element = document.querySelector(query);
    if (!element) return { error: `Element not found: ${query}` };
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tag: element.tagName };
  }, [selector]);
}

export async function dragCenters(tabId, fromSelector, toSelector) {
  return execute(tabId, (fromQuery, toQuery) => {
    const from = document.querySelector(fromQuery);
    const to = document.querySelector(toQuery);
    if (!from) return { error: `Element not found: ${fromQuery}` };
    if (!to) return { error: `Element not found: ${toQuery}` };
    const fromRect = from.getBoundingClientRect();
    const toRect = to.getBoundingClientRect();
    return {
      from: { x: fromRect.left + fromRect.width / 2, y: fromRect.top + fromRect.height / 2 },
      to: { x: toRect.left + toRect.width / 2, y: toRect.top + toRect.height / 2 },
    };
  }, [fromSelector, toSelector]);
}

export async function extractTable(tabId, selector) {
  return execute(tabId, query => {
    let table = document.querySelector(query);
    if (!table) return { error: `Element not found: ${query}` };
    if (table.tagName !== 'TABLE') table = table.querySelector('table');
    if (!table) return { error: `No table found in: ${query}` };
    const headers = [...(table.querySelector('thead tr') || table.querySelector('tr'))?.querySelectorAll('th, td') || []].map(cell => cell.textContent.trim());
    const rows = [...table.querySelectorAll('tbody tr')].map(row => Object.fromEntries([...row.querySelectorAll('th, td')].map((cell, index) => [headers[index] || `column${index + 1}`, cell.textContent.trim()])));
    return { headers, rowCount: rows.length, rows };
  }, [selector]);
}

export async function extractLinks(tabId, scope) {
  return execute(tabId, query => {
    const root = query ? document.querySelector(query) : document;
    if (!root) return { error: `Scope not found: ${query}` };
    return [...root.querySelectorAll('a[href]')].map(anchor => ({ text: (anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200), href: anchor.href }));
  }, [scope || null]);
}

export async function extractForms(tabId, scope) {
  return execute(tabId, query => {
    const root = query ? document.querySelector(query) : document;
    if (!root) return { error: `Scope not found: ${query}` };
    return [...root.querySelectorAll('form')].map((form, index) => ({
      index,
      action: form.action || '',
      method: (form.method || 'get').toUpperCase(),
      fields: [...form.elements].filter(element => element.name).map(element => ({
        name: element.name,
        tag: element.tagName.toLowerCase(),
        type: element.type || element.tagName.toLowerCase(),
        value: String(element.value || '').slice(0, 500),
        required: Boolean(element.required),
      })),
    }));
  }, [scope || null]);
}

export async function performanceInfo(tabId) {
  return execute(tabId, () => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const paints = Object.fromEntries(performance.getEntriesByType('paint').map(item => [item.name, Math.round(item.startTime)]));
    const resources = performance.getEntriesByType('resource');
    return {
      navigationType: navigation?.type || null,
      domInteractiveMs: navigation ? Math.round(navigation.domInteractive) : null,
      domContentLoadedMs: navigation ? Math.round(navigation.domContentLoadedEventEnd) : null,
      loadCompleteMs: navigation ? Math.round(navigation.loadEventEnd) : null,
      firstPaintMs: paints['first-paint'] ?? null,
      firstContentfulPaintMs: paints['first-contentful-paint'] ?? null,
      resourceCount: resources.length,
      transferBytes: resources.reduce((total, item) => total + (item.transferSize || 0), 0),
    };
  });
}

export async function sendPageRequest(tabId, method, url, body, headers, expectedContext = null) {
  return execute(tabId, async (requestMethod, requestUrl, requestBody, requestHeaders, expected) => {
    try {
      const resolved = new URL(requestUrl, location.href).href;
      const normalizedHeaders = { ...(requestHeaders || {}) };
      let payload = requestBody;
      if (payload != null && typeof payload === 'object') {
        payload = JSON.stringify(payload);
        if (!Object.keys(normalizedHeaders).some(key => key.toLowerCase() === 'content-type')) normalizedHeaders['Content-Type'] = 'application/json';
      }
      const response = await fetch(resolved, {
        method: requestMethod.toUpperCase(),
        headers: normalizedHeaders,
        body: ['GET', 'HEAD'].includes(requestMethod.toUpperCase()) ? undefined : payload,
        credentials: 'include',
      });
      const text = await response.text();
      return {
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: text.slice(0, 100_000),
        truncated: text.length > 100_000,
      };
    } catch (error) {
      return { error: error?.message || String(error) };
    }
  }, [method, url, body ?? null, headers || {}, expectedContext], 'MAIN', expectedContext?.documentId ? { documentIds: [expectedContext.documentId] } : {});
}

export async function captureScreenshot(tabId) {
  const tab = await requireSelectedTab(tabId);
  await chrome.tabs.update(tabId, { active: true });
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const dimensions = await execute(tabId, () => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
  return { dataUrl, ...dimensions };
}

export async function execute(tabId, func, args = [], world = 'MAIN', target = {}) {
  const results = await chrome.scripting.executeScript({ target: { tabId, ...target }, world, func, args });
  const value = results?.[0]?.result;
  if (value && typeof value === 'object' && value.error) throw new Error(value.error);
  return value;
}
