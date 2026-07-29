const SENSITIVE_KEY = /authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|csrf|xsrf|card[-_ ]?(number|no)?|cc[-_ ]?number|cvv|cvc|security[-_ ]?code|ssn|social[-_ ]?security|iban|routing[-_ ]?number|account[-_ ]?number/i;
const SENSITIVE_CONTAINER_EXCEPTIONS = new Set(['cookies', 'csrfTokens']);
const URL_KEY = /^(url|href|action|targetUrl|formAction)$/i;
const INTERCEPTION_STATUS_COMMANDS = new Set(['intercept.start', 'intercept.status', 'intercept.stop', 'network.start', 'network.stop']);

export function redactResult(command, result, includeSensitive = false) {
  if (includeSensitive || result == null) return result;
  const copy = structuredClone(result);

  if (command === 'page.html' && copy && typeof copy === 'object' && 'html' in copy) copy.html = mask(copy.html);
  if (command === 'page.eval') return mask(copy);
  if (command === 'error') return maskStringLeaves(copy);
  if (command === 'challenge-target' && copy && typeof copy === 'object' && 'title' in copy) copy.title = mask(copy.title);

  if (command === 'page.storage') redactStorage(copy);
  if (command === 'page.inspect') redactInspection(copy);
  if (command === 'cookies.list' || command === 'cookies.set') redactCookies(copy);
  if (command === 'extract.forms') redactFormValues(copy);
  if (command === 'console') for (const entry of copy?.entries || []) if ('text' in entry) entry.text = mask(entry.text);
  if (command === 'network.list' || command === 'network.summary' || command === 'network.detail' || command === 'network.body') redactNetwork(copy);
  if (command === 'network.body') redactBody(copy);
  if (command === 'request.send') {
    redactBody(copy);
    redactHeaders(copy?.headers);
  }
  if (command === 'request.modify' && copy && typeof copy === 'object') {
    if ('value' in copy) copy.value = mask(copy.value);
    if ('jsonKey' in copy) copy.jsonKey = mask(copy.jsonKey);
    if (typeof copy.urlFilter === 'string') copy.urlFilter = redactFilter(copy.urlFilter);
  }
  if (command === 'intercept.rule.set' || command === 'intercept.rule.list') redactRuleContainer(copy);
  if (command === 'challenge') {
    if (Array.isArray(copy?.rules)) redactRuleContainer(copy);
    if (copy && 'ruleSetDigest' in copy) copy.ruleSetDigest = mask(copy.ruleSetDigest);
    redactClickApprovalContext(copy);
    if (copy?.kind === 'dialog') {
      if ('message' in copy) copy.message = mask(copy.message);
      if ('url' in copy) copy.url = redactUrl(copy.url);
      if ('frameId' in copy) copy.frameId = mask(copy.frameId);
    }
    if (copy?.kind === 'webmcp') {
      for (const key of ['name', 'description', 'origin', 'annotations', 'inputSchema']) if (key in copy) copy[key] = mask(copy[key]);
    }
  }
  if (INTERCEPTION_STATUS_COMMANDS.has(command)) redactInterceptionStatus(copy);

  sanitizeUrls(copy);
  return redactKeys(copy);
}

export function redactKeys(value) {
  if (Array.isArray(value)) return value.map(redactKeys);
  if (!value || typeof value !== 'object') return value;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && (!SENSITIVE_CONTAINER_EXCEPTIONS.has(key) || child == null || typeof child !== 'object')) value[key] = mask(child);
    else value[key] = redactKeys(child);
  }
  return value;
}

function redactStorage(result) {
  for (const area of ['localStorage', 'sessionStorage']) {
    if (!result?.[area] || typeof result[area] !== 'object') continue;
    for (const key of Object.keys(result[area])) result[area][key] = mask(result[area][key]);
  }
  if (Array.isArray(result?.cookies)) {
    for (const cookie of result.cookies) {
      if ('value' in cookie) cookie.value = mask(cookie.value);
    }
  }
}

function redactInspection(result) {
  for (const input of result?.hiddenInputs || []) {
    if ('value' in input) input.value = mask(input.value);
  }
  for (const token of result?.csrfTokens || []) {
    if ('value' in token) token.value = mask(token.value);
  }
  for (const form of result?.forms || []) {
    for (const field of form.fields || []) {
      if (isSensitiveField(field) && 'value' in field) field.value = mask(field.value);
    }
  }
}

function redactCookies(result) {
  const cookies = Array.isArray(result) ? result : [result];
  for (const cookie of cookies) {
    if (cookie && typeof cookie === 'object' && 'value' in cookie) cookie.value = mask(cookie.value);
  }
}

function redactFormValues(result) {
  const forms = Array.isArray(result) ? result : [];
  for (const form of forms) {
    for (const field of form?.fields || []) {
      if ('value' in field) field.value = mask(field.value);
    }
  }
}

function redactNetwork(result) {
  visit(result, (parent, key, value) => {
    if (key === 'url' && typeof value === 'string') parent[key] = redactUrl(value);
    if (/^(request|response)Headers$/i.test(key)) redactHeaders(value);
    if (key === 'postData' && value != null) {
      parent.postDataShape = bodyShape(value);
      parent[key] = mask(value);
    }
    if (key === 'payloadData') parent[key] = mask(value);
    if (key === 'data' && parent && typeof parent === 'object' && 'eventName' in parent) parent[key] = mask(value);
    if (key === 'eventName' || key === 'eventId' || key === 'statusText') parent[key] = mask(value);
  });
}

function redactRuleContainer(result) {
  const rules = result?.rules || (result?.rule ? [result.rule] : []);
  for (const rule of rules) redactRule(rule);
}

function redactClickApprovalContext(result) {
  if (result?.kind === 'drag') {
    redactClickApprovalContext(result.source);
    redactClickApprovalContext(result.destination);
    return;
  }
  if (result?.kind === 'upload') {
    redactClickApprovalContext(result.target);
    return;
  }
  if (result?.version === 4 && result.target) {
    for (const key of ['href', 'timeOrigin']) if (key in (result.document || {})) result.document[key] = mask(result.document[key]);
    for (const key of ['ref', 'id', 'name', 'value', 'label']) if (key in result.target) result.target[key] = mask(result.target[key]);
    redactActionShape(result.anchor?.href);
    if (result.anchor) {
      if ('target' in result.anchor) result.anchor.target = mask(result.anchor.target);
      if ('download' in result.anchor) result.anchor.download = mask(result.anchor.download);
    }
    if (result.form) {
      for (const key of ['id', 'name', 'target']) if (key in result.form) result.form[key] = mask(result.form[key]);
      redactActionShape(result.form.action);
      for (const control of result.form.controls || []) {
        if ('name' in control) control.name = mask(control.name);
        if ('values' in control) control.values = mask(control.values);
      }
    }
    return;
  }
  if (!result?.locator || !result.submitter || !result.form?.action) return;
  if (![1, 2, 3].includes(result.version)) {
    const replacement = mask(result);
    for (const key of Object.keys(result)) delete result[key];
    result.redacted = replacement;
    return;
  }
  for (const key of ['href', 'timeOrigin']) {
    if (key in (result.document || {})) result.document[key] = mask(result.document[key]);
  }
  if ('value' in result.locator) result.locator.value = mask(result.locator.value);
  for (const key of ['id', 'name', 'value', 'label']) {
    if (key in result.submitter) result.submitter[key] = mask(result.submitter[key]);
  }
  for (const key of ['id', 'name']) {
    if (key in result.form) result.form[key] = mask(result.form[key]);
  }
  for (const key of ['origin', 'pathname', 'fragment', 'raw']) {
    if (key in result.form.action) result.form.action[key] = mask(result.form.action[key]);
  }
  for (const entry of result.form.action.query || []) {
    if ('key' in entry) entry.key = mask(entry.key);
    if ('value' in entry) entry.value = mask(entry.value);
  }
  const binding = result.resourceBinding;
  if (!binding || typeof binding !== 'object') return;
  for (const control of binding.controls || []) {
    if ('name' in control) control.name = mask(control.name);
    if ('value' in control) control.value = mask(control.value);
    if ('attributeValue' in control) control.attributeValue = mask(control.attributeValue);
  }
  for (const link of binding.editLinks || []) {
    if ('origin' in link) link.origin = mask(link.origin);
    if ('pathname' in link) link.pathname = mask(link.pathname);
    if ('fragment' in link) link.fragment = mask(link.fragment);
    for (const entry of link.query || []) {
      if ('key' in entry) entry.key = mask(entry.key);
      if ('value' in entry) entry.value = mask(entry.value);
    }
  }
}

function redactActionShape(action) {
  if (!action || typeof action !== 'object') return;
  for (const key of ['origin', 'pathname', 'fragment', 'raw']) if (key in action) action[key] = mask(action[key]);
  for (const entry of action.query || []) {
    if ('key' in entry) entry.key = mask(entry.key);
    if ('value' in entry) entry.value = mask(entry.value);
  }
}

function redactRule(rule) {
  if (!rule || typeof rule !== 'object') return;
  if (rule.match?.urlPattern) rule.match.urlPattern = redactPattern(rule.match.urlPattern);
  redactRuleAction(rule.request);
  redactRuleAction(rule.response);
}

function redactRuleAction(action) {
  if (!action || typeof action !== 'object') return;
  if (Array.isArray(action.headers)) {
    for (const header of action.headers) if ('value' in header) header.value = mask(header.value);
  } else if (action.headers?.set) {
    for (const header of action.headers.set) if ('value' in header) header.value = mask(header.value);
  }
  if ('statusText' in action) action.statusText = mask(action.statusText);
  redactRuleBody(action.body);
  redactRuleAction(action.fulfill);
}

function redactRuleBody(body) {
  if (!body || typeof body !== 'object') return;
  if ('text' in body) body.text = mask(body.text);
  if ('base64' in body) body.base64 = mask(body.base64);
  for (const item of body.jsonSet || []) {
    if ('path' in item) item.path = mask(item.path);
    if ('value' in item) item.value = mask(item.value);
  }
}

function redactInterceptionStatus(result) {
  for (const status of [result, result?.interception]) {
    for (const modifier of status?.modifiers || []) if ('value' in modifier) modifier.value = mask(modifier.value);
    for (const modifier of status?.modifiers || []) if (typeof modifier.urlFilter === 'string') modifier.urlFilter = redactFilter(modifier.urlFilter);
    for (const diagnostic of status?.diagnostics || []) if ('error' in diagnostic) diagnostic.error = mask(diagnostic.error);
    if (status && 'ruleSetDigest' in status) status.ruleSetDigest = mask(status.ruleSetDigest);
  }
}

function redactHeaders(headers) {
  if (Array.isArray(headers)) {
    for (const header of headers) if (header && 'value' in header) header.value = mask(header.value);
    return;
  }
  if (!headers || typeof headers !== 'object') return;
  for (const key of Object.keys(headers)) headers[key] = mask(headers[key]);
}

function redactBody(result) {
  if (!result || typeof result !== 'object' || !('body' in result)) return;
  const body = result.body;
  result.body = mask(body);
  result.bodyShape = bodyShape(body);
}

function isSensitiveField(field) {
  return SENSITIVE_KEY.test(`${field?.name || ''} ${field?.type || ''} ${field?.id || ''} ${field?.autocomplete || ''}`);
}

function bodyShape(body) {
  if (body == null) return null;
  if (typeof body !== 'string') return { type: typeof body };
  try {
    const value = JSON.parse(body);
    if (value && typeof value === 'object') return Array.isArray(value)
      ? { type: 'array', length: value.length }
      : { type: 'object', keyCount: Object.keys(value).length };
  } catch {}
  return { type: 'string', length: body.length };
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return `${url.protocol}[redacted]`;
    if (url.username) url.username = '[redacted]';
    if (url.password) url.password = '[redacted]';
    const query = [...url.searchParams.entries()];
    url.search = '';
    for (const [key, queryValue] of query) url.searchParams.append(queryValue === '' ? '[redacted]' : key, '[redacted]');
    url.pathname = redactPathSegments(url.pathname.split('/')).join('/');
    url.hash = '';
    return url.href;
  } catch {
    return mask(value);
  }
}

function redactPattern(value) {
  let result = String(value)
    .replace(/([?&][^=&#]+)=([^&#]*)/g, '$1=[redacted]')
    .replace(/([?&])([^=&#]+)(?=(&|$))/g, '$1[redacted]')
    .replace(/\/\/[^/@*]+@/g, '//[redacted]@')
    .replace(/#.*$/, '');
  const schemeEnd = result.indexOf('://');
  const pathStart = result.indexOf('/', schemeEnd >= 0 ? schemeEnd + 3 : 0);
  if (pathStart < 0) return result;
  const queryStart = result.indexOf('?', pathStart);
  const pathEnd = queryStart < 0 ? result.length : queryStart;
  const path = redactPathSegments(result.slice(pathStart, pathEnd).split('/')).join('/');
  return `${result.slice(0, pathStart)}${path}${result.slice(pathEnd)}`;
}

function redactFilter(value) {
  const redacted = redactUrl(value);
  return redacted === value ? redactPattern(value) : redacted;
}

function redactPathSegment(segment) {
  let decoded = segment;
  try { decoded = decodeURIComponent(segment); } catch {}
  if (/[@;~]|(?:session|token|secret|auth|key|reset|password)(?:[=:_~.-])/i.test(decoded)) return '[redacted]';
  return decoded.length >= 20 ? `${segment.slice(0, 6)}..` : segment;
}

function redactPathSegments(segments) {
  return segments.map((segment, index) => {
    let parent = segments[index - 1] || '';
    try { parent = decodeURIComponent(parent); } catch {}
    if (/^(reset|session|sessions|token|tokens|ssn|card|cards|user|users|account|accounts|customer|customers|profile|profiles)$/i.test(parent)) return '[redacted]';
    return redactPathSegment(segment);
  });
}

function sanitizeUrls(value) {
  visit(value, (parent, key, child) => {
    if (URL_KEY.test(key) && typeof child === 'string') parent[key] = redactUrl(child);
  });
}

function visit(value, callback) {
  if (Array.isArray(value)) {
    for (const child of value) visit(child, callback);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    callback(value, key, child);
    visit(value[key], callback);
  }
}

function mask(value) {
  if (value == null) return '[redacted]';
  const length = typeof value === 'string' ? value.length : JSON.stringify(value)?.length || 0;
  return `[redacted:${length}]`;
}

function maskStringLeaves(value) {
  if (Array.isArray(value)) return value.map(maskStringLeaves);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? mask(value) : value;
  for (const [key, child] of Object.entries(value)) value[key] = maskStringLeaves(child);
  return value;
}
