export function applyRequestModifiers(postData, url, modifiers) {
  if (!postData || !modifiers?.length) return { changed: false, postData };
  let parsed;
  try { parsed = JSON.parse(postData); }
  catch { return { changed: false, postData }; }
  let changed = false;
  for (const modifier of modifiers) {
    if (!url.includes(modifier.urlFilter)) continue;
    setNested(parsed, modifier.jsonKey, modifier.value);
    changed = true;
  }
  return { changed, postData: changed ? JSON.stringify(parsed) : postData };
}

const RULE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HTTP_METHOD = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_RULE_BYTES = 64 * 1024;
const MAX_STATIC_BODY_BYTES = 1024 * 1024;
const FETCH_ERROR_REASONS = new Set([
  'Failed', 'Aborted', 'TimedOut', 'AccessDenied', 'ConnectionClosed',
  'ConnectionReset', 'ConnectionRefused', 'ConnectionAborted', 'ConnectionFailed',
  'NameNotResolved', 'InternetDisconnected', 'AddressUnreachable', 'BlockedByClient', 'BlockedByResponse',
]);

export function validateRuleName(name) {
  if (!RULE_NAME.test(name || '')) throw new Error('Rule name must be 1-64 letters, numbers, dots, underscores, or hyphens');
  return name;
}

export function normalizeRule(name, input) {
  validateRuleName(name);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Rule must be a JSON object');
  if (JSON.stringify(input).length > MAX_RULE_BYTES) throw new Error(`Rule exceeds ${MAX_RULE_BYTES} serialized bytes`);

  const rule = {
    version: 1,
    name,
    match: normalizeMatch(input.match),
  };
  if (input.request != null) rule.request = normalizeRequest(input.request);
  if (input.response != null) rule.response = normalizeResponse(input.response);
  if (!rule.request && !rule.response) throw new Error('Rule requires request and/or response actions');
  if (input.name != null && input.name !== name) throw new Error('Stored rule name does not match its key');
  rejectUnknown(input, ['version', 'name', 'match', 'request', 'response'], 'rule');
  return rule;
}

export function compileFetchPatterns(rules) {
  const unique = new Map();
  for (const rule of rules) {
    const resourceTypes = rule.match.resourceTypes.length ? rule.match.resourceTypes : [null];
    for (const resourceType of resourceTypes) {
      if (rule.request) addPattern('Request', rule.match.urlPattern, resourceType);
      if (rule.response) addPattern('Response', rule.match.urlPattern, resourceType);
    }
  }
  return [...unique.values()];

  function addPattern(requestStage, urlPattern, resourceType) {
    const pattern = { urlPattern, requestStage, ...(resourceType ? { resourceType } : {}) };
    unique.set(JSON.stringify(pattern), pattern);
  }
}

export function matchesRule(rule, details, stage) {
  if (!wildcardMatch(rule.match.urlPattern, details.url || '')) return false;
  if (rule.match.methods.length && !rule.match.methods.includes(String(details.method || '').toUpperCase())) return false;
  if (rule.match.resourceTypes.length && !rule.match.resourceTypes.includes(details.resourceType)) return false;
  if (stage === 'Response' && rule.match.statusCodes.length && !rule.match.statusCodes.includes(Number(details.statusCode))) return false;
  return Boolean(stage === 'Request' ? rule.request : rule.response);
}

export function applyHeaderActions(headers, actions) {
  let result = normalizeHeaderList(headers);
  if (!actions) return result;
  const removed = new Set(actions.remove.map(name => name.toLowerCase()));
  result = result.filter(header => !removed.has(header.name.toLowerCase()));
  for (const header of actions.set) {
    const lower = header.name.toLowerCase();
    result = result.filter(existing => existing.name.toLowerCase() !== lower);
    result.push({ name: header.name, value: header.value });
  }
  return result;
}

export function applyBodyAction(body, base64Encoded, action) {
  if (!action) return { changed: false, base64: bodyToBase64(body || '', base64Encoded) };
  let bytes;
  if (Object.hasOwn(action, 'text')) bytes = new TextEncoder().encode(action.text);
  else if (Object.hasOwn(action, 'base64')) bytes = base64ToBytes(action.base64);
  else {
    const original = new TextDecoder('utf-8', { fatal: true }).decode(base64Encoded ? base64ToBytes(body) : new TextEncoder().encode(body || ''));
    const parsed = JSON.parse(original);
    for (const item of action.jsonSet) setNested(parsed, item.path, structuredClone(item.value));
    bytes = new TextEncoder().encode(JSON.stringify(parsed));
  }
  if (bytes.byteLength > MAX_STATIC_BODY_BYTES * 5) throw new Error('Transformed body exceeds 5 MiB');
  return { changed: true, base64: bytesToBase64(bytes), byteLength: bytes.byteLength };
}

export function summarizeRule(rule) {
  const summary = {
    name: rule.name,
    match: structuredClone(rule.match),
    stages: [rule.request && 'Request', rule.response && 'Response'].filter(Boolean),
  };
  if (rule.request) summary.request = summarizeAction(rule.request);
  if (rule.response) summary.response = summarizeAction(rule.response);
  return summary;
}

export async function ruleSetDigest(names, rules) {
  const canonical = stableStringify({ names, rules });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function wildcardMatch(pattern, value) {
  let source = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '\\' && index + 1 < pattern.length) source += escapeRegExp(pattern[++index]);
    else if (character === '*') source += '.*';
    else if (character === '?') source += '.';
    else source += escapeRegExp(character);
  }
  return new RegExp(`${source}$`).test(value);
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('Invalid base64 body');
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function setNested(object, path, value) {
  const parts = path.split('.').filter(Boolean);
  if (!parts.length) throw new Error('JSON key cannot be empty');
  if (parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Unsafe JSON key path');
  let target = object;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== 'object') target[part] = {};
    target = target[part];
  }
  target[parts.at(-1)] = value;
}

export function redactPath(path) {
  const segments = path.split('/');
  return segments.map((segment, index) => {
    let parent = segments[index - 1] || '';
    try { parent = decodeURIComponent(parent); } catch {}
    if (/^(reset|session|sessions|token|tokens|ssn|card|cards|user|users|account|accounts|customer|customers|profile|profiles)$/i.test(parent)) return '[redacted]';
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch {}
    if (/[@;~]|(?:session|token|secret|auth|key|reset|password)(?:[=:_~.-])/i.test(decoded)) return '[redacted]';
    return decoded.length >= 20 ? `${segment.slice(0, 6)}..` : segment;
  }).join('/');
}

function normalizeMatch(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('match must be an object');
  const match = {
    urlPattern: input.urlPattern == null ? '*' : requireString(input.urlPattern, 'match.urlPattern'),
    methods: normalizeStringArray(input.methods, 'match.methods').map(method => {
      const normalized = method.toUpperCase();
      if (!HTTP_METHOD.test(normalized)) throw new Error(`Invalid HTTP method: ${method}`);
      return normalized;
    }),
    resourceTypes: normalizeStringArray(input.resourceTypes, 'match.resourceTypes'),
    statusCodes: normalizeNumberArray(input.statusCodes, 'match.statusCodes').map(code => {
      if (!Number.isInteger(code) || code < 100 || code > 599) throw new Error(`Invalid status code: ${code}`);
      return code;
    }),
  };
  rejectUnknown(input, ['urlPattern', 'methods', 'resourceTypes', 'statusCodes'], 'match');
  return match;
}

function normalizeRequest(input) {
  requireObject(input, 'request');
  const request = {};
  if (input.url != null) {
    const url = new URL(requireString(input.url, 'request.url'));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('request.url must use HTTP or HTTPS');
    request.url = url.href;
  }
  if (input.method != null) {
    request.method = requireString(input.method, 'request.method').toUpperCase();
    if (!HTTP_METHOD.test(request.method)) throw new Error(`Invalid request method: ${request.method}`);
  }
  if (input.headers != null) request.headers = normalizeHeaderActions(input.headers);
  if (input.body != null) request.body = normalizeBodyAction(input.body, 'request.body');
  if (input.block != null) {
    request.block = requireString(input.block, 'request.block');
    if (!FETCH_ERROR_REASONS.has(request.block)) throw new Error(`Unsupported request.block reason: ${request.block}`);
  }
  if (input.fulfill != null) request.fulfill = normalizeFulfill(input.fulfill);
  rejectUnknown(input, ['url', 'method', 'headers', 'body', 'block', 'fulfill'], 'request');
  if (!Object.keys(request).length) throw new Error('request action cannot be empty');
  if (request.block && request.fulfill) throw new Error('request.block and request.fulfill are mutually exclusive');
  return request;
}

function normalizeResponse(input) {
  requireObject(input, 'response');
  const response = {};
  if (input.statusCode != null) response.statusCode = normalizeStatus(input.statusCode, 'response.statusCode');
  if (input.statusText != null) response.statusText = cleanHeaderValue(requireString(input.statusText, 'response.statusText'), 'response.statusText');
  if (input.headers != null) response.headers = normalizeHeaderActions(input.headers);
  if (input.body != null) response.body = normalizeBodyAction(input.body, 'response.body');
  rejectUnknown(input, ['statusCode', 'statusText', 'headers', 'body'], 'response');
  if (!Object.keys(response).length) throw new Error('response action cannot be empty');
  return response;
}

function normalizeFulfill(input) {
  requireObject(input, 'request.fulfill');
  const fulfill = { statusCode: normalizeStatus(input.statusCode ?? 200, 'request.fulfill.statusCode') };
  if (input.statusText != null) fulfill.statusText = cleanHeaderValue(requireString(input.statusText, 'request.fulfill.statusText'), 'request.fulfill.statusText');
  if (input.headers != null) fulfill.headers = normalizeHeaderList(input.headers);
  if (input.body != null) {
    fulfill.body = normalizeBodyAction(input.body, 'request.fulfill.body');
    if (fulfill.body.jsonSet) throw new Error('request.fulfill.body cannot use jsonSet without an original body');
  }
  rejectUnknown(input, ['statusCode', 'statusText', 'headers', 'body'], 'request.fulfill');
  return fulfill;
}

function normalizeHeaderActions(input) {
  requireObject(input, 'headers');
  const actions = {
    set: normalizeHeaderList(input.set || []),
    remove: normalizeStringArray(input.remove, 'headers.remove').map(validateHeaderName),
  };
  rejectUnknown(input, ['set', 'remove'], 'headers');
  return actions;
}

function normalizeHeaderList(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    if (typeof input !== 'object') throw new Error('Headers must be an array or object');
    input = Object.entries(input).map(([name, value]) => ({ name, value: String(value) }));
  }
  return input.map((header, index) => {
    requireObject(header, `headers[${index}]`);
    return {
      name: validateHeaderName(requireString(header.name, `headers[${index}].name`)),
      value: cleanHeaderValue(requireString(header.value, `headers[${index}].value`), `headers[${index}].value`),
    };
  });
}

function normalizeBodyAction(input, label) {
  requireObject(input, label);
  const keys = ['text', 'base64', 'jsonSet'].filter(key => Object.hasOwn(input, key));
  if (keys.length !== 1) throw new Error(`${label} requires exactly one of text, base64, or jsonSet`);
  rejectUnknown(input, ['text', 'base64', 'jsonSet'], label);
  if (keys[0] === 'text') {
    const text = requireString(input.text, `${label}.text`);
    if (new TextEncoder().encode(text).byteLength > MAX_STATIC_BODY_BYTES) throw new Error(`${label}.text exceeds 1 MiB`);
    return { text };
  }
  if (keys[0] === 'base64') {
    const base64 = requireString(input.base64, `${label}.base64`);
    if (base64ToBytes(base64).byteLength > MAX_STATIC_BODY_BYTES) throw new Error(`${label}.base64 exceeds 1 MiB`);
    return { base64 };
  }
  if (!Array.isArray(input.jsonSet) || !input.jsonSet.length) throw new Error(`${label}.jsonSet must be a non-empty array`);
  return { jsonSet: input.jsonSet.map((item, index) => {
    requireObject(item, `${label}.jsonSet[${index}]`);
    if (!Object.hasOwn(item, 'value')) throw new Error(`${label}.jsonSet[${index}].value is required`);
    const path = requireString(item.path, `${label}.jsonSet[${index}].path`);
    setNested({}, path, null);
    rejectUnknown(item, ['path', 'value'], `${label}.jsonSet[${index}]`);
    return { path, value: structuredClone(item.value) };
  }) };
}

function normalizeStringArray(input, label) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`);
  return [...new Set(input.map((value, index) => requireString(value, `${label}[${index}]`)))];
}

function normalizeNumberArray(input, label) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`);
  return [...new Set(input.map(value => Number(value)))];
}

function normalizeStatus(value, label) {
  const status = Number(value);
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error(`${label} must be between 100 and 599`);
  return status;
}

function validateHeaderName(value) {
  if (!HEADER_NAME.test(value || '')) throw new Error(`Invalid header name: ${value}`);
  return value;
}

function cleanHeaderValue(value, label) {
  if (/[\0-\x08\x0A-\x1F\x7F]/.test(value)) throw new Error(`${label} cannot contain control characters`);
  return value;
}

function summarizeAction(action) {
  const result = {};
  if (action.url) result.url = action.url;
  if (action.method) result.method = action.method;
  if (action.block) result.block = action.block;
  if (action.headers) result.headers = Array.isArray(action.headers)
    ? { set: action.headers.map(header => ({ name: header.name, valueLength: header.value.length })), remove: [] }
    : { set: action.headers.set.map(header => ({ name: header.name, valueLength: header.value.length })), remove: action.headers.remove };
  if (action.body) result.body = summarizeBody(action.body);
  if (action.statusCode) result.statusCode = action.statusCode;
  if (action.statusText) result.statusText = action.statusText;
  if (action.fulfill) result.fulfill = summarizeAction(action.fulfill);
  return result;
}

function summarizeBody(body) {
  if (Object.hasOwn(body, 'text')) return { type: 'text', length: body.text.length };
  if (Object.hasOwn(body, 'base64')) return { type: 'base64', length: body.base64.length };
  return { type: 'jsonSet', paths: body.jsonSet.map(item => item.path), valueLengths: body.jsonSet.map(item => JSON.stringify(item.value)?.length || 0) };
}

function bodyToBase64(body, base64Encoded) {
  return base64Encoded ? body : bytesToBase64(new TextEncoder().encode(body));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.length) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(', ')}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
