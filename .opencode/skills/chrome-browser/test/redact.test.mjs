import assert from 'node:assert/strict';
import test from 'node:test';
import { redactResult } from '../src/redact.mjs';

test('storage and cookies preserve metadata while masking values', () => {
  const result = redactResult('page.storage', {
    origin: 'https://example.test',
    localStorage: { token: 'secret', theme: 'dark' },
    sessionStorage: { cart: '123' },
    cookies: [{ name: 'session', value: 'cookie-value' }],
  });
  assert.equal(result.origin, 'https://example.test');
  assert.match(result.localStorage.token, /^\[redacted:/);
  assert.match(result.localStorage.theme, /^\[redacted:/);
  assert.equal(result.cookies[0].name, 'session');
  assert.match(result.cookies[0].value, /^\[redacted:/);
});

test('network details mask query values, headers, and request bodies', () => {
  const result = redactResult('network.detail', {
    url: 'https://example.test/api?token=abc&id=42',
    requestHeaders: { Authorization: 'Bearer secret', Accept: 'application/json' },
    postData: '{"password":"secret"}',
  });
  assert.match(result.url, /token=%5Bredacted%5D/);
  assert.match(result.requestHeaders.Authorization, /^\[redacted:/);
  assert.match(result.requestHeaders.Accept, /^\[redacted:/);
  assert.match(result.postData, /^\[redacted:/);
  assert.deepEqual(result.postDataShape, { type: 'object', keyCount: 1 });

  const headerList = redactResult('network.detail', {
    requestHeaders: [
      { name: 'Authorization', value: 'Bearer secret' },
      { name: 'Accept', value: 'application/json' },
    ],
    responseHeaders: [{ name: 'Set-Cookie', value: 'session=secret' }],
  });
  assert.match(headerList.requestHeaders[0].value, /^\[redacted:/);
  assert.match(headerList.requestHeaders[1].value, /^\[redacted:/);
  assert.match(headerList.responseHeaders[0].value, /^\[redacted:/);
});

test('sensitive output opt-in returns unmodified values', () => {
  const original = { body: 'secret' };
  assert.equal(redactResult('network.body', original, true), original);
});

test('nested sensitive containers and arbitrary HTML are hidden by default', () => {
  const nested = redactResult('tabs.list', [{
    url: 'https://user:pass@example.test/order/0123456789abcdef0123456789abcdef?token=abc#secret',
    authorization: { value: 'Bearer secret' },
  }]);
  assert.match(nested[0].authorization, /^\[redacted:/);
  assert.doesNotMatch(nested[0].url, /user|pass|abc|secret/);
  assert.match(nested[0].url, /012345\.\./);

  const html = redactResult('page.html', { html: '<input value="secret">', length: 22 });
  assert.match(html.html, /^\[redacted:/);
  assert.equal(html.length, 22);
});

test('structured evaluation output, error strings, and relative URLs fail closed', () => {
  const evaluated = redactResult('page.eval', { value: 'private-cookie', nested: { token: 'secret' } });
  assert.match(evaluated, /^\[redacted:/);
  const error = redactResult('error', { message: 'private-cookie', details: { reason: 'secret', count: 2 } });
  assert.match(error.message, /^\[redacted:/);
  assert.match(error.details.reason, /^\[redacted:/);
  assert.equal(error.details.count, 2);
  const relative = redactResult('tabs.list', { url: '/reset/private-token?secret=value' });
  assert.match(relative.url, /^\[redacted:/);
});

test('console text and request JSON key paths are hidden by default', () => {
  const consoleResult = redactResult('console', { entries: [{ level: 'log', text: 'Bearer private-token' }] });
  assert.match(consoleResult.entries[0].text, /^\[redacted:/);
  const modifier = redactResult('request.modify', { jsonKey: 'account.password', value: 'secret' });
  assert.match(modifier.jsonKey, /^\[redacted:/);
  assert.match(modifier.value, /^\[redacted:/);
});

test('payment and identity form values are masked', () => {
  const result = redactResult('page.inspect', {
    hiddenInputs: [],
    csrfTokens: [],
    forms: [{ fields: [
      { name: 'cardNumber', autocomplete: 'cc-number', value: '4111111111111111' },
      { name: 'securityCode', autocomplete: 'cc-csc', value: '123' },
      { name: 'displayName', value: 'Alice' },
    ] }],
  });
  assert.match(result.forms[0].fields[0].value, /^\[redacted:/);
  assert.match(result.forms[0].fields[1].value, /^\[redacted:/);
  assert.equal(result.forms[0].fields[2].value, 'Alice');
});

test('named interception rule values and streamed message payloads are masked', () => {
  const rules = redactResult('intercept.rule.list', {
    rules: [{
      name: 'rewrite',
      match: { urlPattern: 'https://user:pass@example.test/reset/123456?*token=secret' },
      request: {
        headers: { set: [{ name: 'X-Secret', value: 'header-value' }], remove: [] },
        body: { jsonSet: [{ path: 'amount', value: 1 }] },
      },
      response: { body: { text: 'response-value' } },
    }],
  });
  assert.doesNotMatch(rules.rules[0].match.urlPattern, /user:pass|token=secret/);
  assert.match(rules.rules[0].request.headers.set[0].value, /^\[redacted:/);
  assert.match(rules.rules[0].request.body.jsonSet[0].value, /^\[redacted:/);
  assert.match(rules.rules[0].request.body.jsonSet[0].path, /^\[redacted:/);
  assert.match(rules.rules[0].response.body.text, /^\[redacted:/);

  const detail = redactResult('network.detail', {
    statusText: 'account-specific reason',
    webSocketFrames: [{ direction: 'received', payloadData: 'private-message' }],
    eventSourceMessages: [{ eventName: 'private-name', eventId: 'private-cursor', data: 'private-event' }],
  });
  assert.match(detail.statusText, /^\[redacted:/);
  assert.match(detail.webSocketFrames[0].payloadData, /^\[redacted:/);
  assert.match(detail.eventSourceMessages[0].eventName, /^\[redacted:/);
  assert.match(detail.eventSourceMessages[0].eventId, /^\[redacted:/);
  assert.match(detail.eventSourceMessages[0].data, /^\[redacted:/);
});

test('interception statuses and confirmation details hide diagnostics and configured values', () => {
  const status = redactResult('network.start', {
    active: true,
    interception: {
      ruleSetDigest: 'abcdef',
      modifiers: [{ urlFilter: 'https://user:pass@example.test/checkout?token=secret#private', jsonKey: 'password', value: 'secret' }],
      diagnostics: [{ operation: 'response-rule:test', error: 'Unexpected token near secret-value' }],
    },
  });
  assert.match(status.interception.modifiers[0].value, /^\[redacted:/);
  assert.match(status.interception.ruleSetDigest, /^\[redacted:/);
  assert.doesNotMatch(status.interception.modifiers[0].urlFilter, /user:pass|token=secret|private/);
  assert.match(status.interception.diagnostics[0].error, /^\[redacted:/);

  const challenge = redactResult('challenge', {
    ruleSetDigest: 'abc123',
    rules: [{
      name: 'rewrite',
      match: { urlPattern: 'https://user:pass@example.test/api?token=secret' },
      response: { statusText: 'secret phrase', body: { text: 'private body' } },
    }],
  });
  assert.doesNotMatch(challenge.rules[0].match.urlPattern, /user:pass|123456|token=secret/);
  assert.match(challenge.ruleSetDigest, /^\[redacted:/);
  assert.match(challenge.rules[0].response.statusText, /^\[redacted:/);
  assert.match(challenge.rules[0].response.body.text, /^\[redacted:/);

  const response = redactResult('request.send', {
    url: 'https://example.test/api?token=secret',
    headers: { 'X-Auth-Token': 'private', Location: 'https://user:pass@example.test/private?key=value' },
    body: 'private body',
  });
  assert.match(response.headers['X-Auth-Token'], /^\[redacted:/);
  assert.match(response.headers.Location, /^\[redacted:/);
  assert.match(response.body, /^\[redacted:/);

  const paths = redactResult('tabs.list', [
    { url: 'https://example.test/users/alice@example.com' },
    { url: 'https://example.test/app;jsessionid=private-session' },
    { url: 'https://example.test/reset/123456?ABC123' },
    { url: 'blob:https://example.test/private-id' },
  ]);
  assert.doesNotMatch(paths[0].url, /alice/);
  assert.doesNotMatch(paths[1].url, /jsessionid|private-session/);
  assert.doesNotMatch(paths[2].url, /123456|ABC123/);
  assert.equal(paths[3].url, 'blob:[redacted]');
});

test('semantic click challenge details mask locators, URLs, query entries, and identifiers', () => {
  const challenge = redactResult('challenge', {
    version: 3,
    document: { href: 'https://secret.example/private-document?token=raw-secret', timeOrigin: 'private-time-origin' },
    locator: { kind: 'selector', value: '#private-id' },
    submitter: { tag: 'INPUT', id: 'private-id', name: 'operation', type: 'submit', value: 'Pause secret', label: 'Pause secret' },
    form: {
      action: {
        kind: 'http',
        origin: 'https://secret.example',
        pathname: '/accounts/private-id/pause',
        query: [{ key: 'token', value: 'raw-secret' }],
        fragment: '#private',
      },
      method: 'POST',
      enctype: 'application/x-www-form-urlencoded',
      id: 'private-form',
      name: 'private-name',
    },
    resourceBinding: {
      scope: { tag: 'TR', role: '' },
      state: 'strong-unique',
      controls: [{ tag: 'INPUT', type: 'checkbox', name: 'resource', value: 'private-resource', attributeValue: 'private-resource' }],
      editLinks: [{ origin: 'https://secret.example', pathname: '/resource/private-resource/edit', query: [{ key: 'id', value: 'private-resource' }], fragment: '#private-resource' }],
    },
  });
  const rendered = JSON.stringify(challenge);
  assert.doesNotMatch(rendered, /private-id|secret\.example|raw-secret|private-resource|private-form|private-name/);
  assert.equal(challenge.locator.kind, 'selector');
  assert.equal(challenge.submitter.type, 'submit');
  assert.equal(challenge.form.method, 'POST');
  assert.match(challenge.form.action.query[0].value, /^\[redacted:/);
  assert.match(challenge.document.href, /^\[redacted:/);
});

test('opaque credential actions are masked in semantic challenge details', () => {
  const challenge = redactResult('challenge', {
    version: 3,
    document: { href: 'https://example.test/manage', timeOrigin: '1000' },
    locator: { kind: 'selector', value: '#private-action' },
    submitter: { tag: 'INPUT', id: 'private-action', name: 'operation', type: 'submit', value: 'Pause', label: 'Pause' },
    form: {
      action: { kind: 'opaque', raw: 'https://private-user:private-password@example.test/pause?token=raw-secret' },
      method: 'POST', enctype: 'text/plain', id: 'private-form', name: 'private-form',
    },
    resourceBinding: { state: 'no-container' },
  });
  const rendered = JSON.stringify(challenge);
  assert.doesNotMatch(rendered, /private-user|private-password|raw-secret|private-action|private-form/);
  assert.match(challenge.form.action.raw, /^\[redacted:/);
});

test('unknown semantic context versions are redacted fail-safe', () => {
  const challenge = redactResult('challenge', {
    version: 999,
    document: { href: 'https://secret.example/private?token=raw-secret', timeOrigin: 'private-origin' },
    locator: { kind: 'selector', value: '#private-id' },
    submitter: { tag: 'INPUT', id: 'private-id', name: 'private-name', type: 'submit', value: 'private-value', label: 'private-label' },
    form: { action: { kind: 'opaque', raw: 'https://user:password@secret.example/private' }, method: 'POST' },
    resourceBinding: { state: 'strong-unique', controls: [{ name: 'private-resource', value: 'raw-resource' }] },
  });
  assert.deepEqual(Object.keys(challenge), ['redacted']);
  assert.match(challenge.redacted, /^\[redacted:/);
  assert.doesNotMatch(JSON.stringify(challenge), /private|secret\.example|raw-resource|password/);
});

test('version 4 interaction contexts mask exact refs, destinations, and form payloads', () => {
  const result = redactResult('challenge', {
    version: 4,
    document: { href: 'https://private.example/checkout', timeOrigin: '123' },
    target: { ref: 'epoch:r1', tag: 'BUTTON', role: 'button', id: 'pay-private', name: 'operation', type: 'submit', value: 'pay', label: 'Pay Alice' },
    anchor: { href: { kind: 'http', origin: 'https://private.example', pathname: '/pay/alice', query: [{ key: 'token', value: 'secret' }], fragment: '#private' }, target: '_blank', download: '' },
    form: {
      action: { kind: 'http', origin: 'https://private.example', pathname: '/charge', query: [{ key: 'account', value: 'alice' }], fragment: '' },
      method: 'POST', enctype: 'application/x-www-form-urlencoded', target: '_self', noValidate: false, id: 'payment', name: 'payment',
      controls: [{ name: 'cardNumber', type: 'text', values: ['4111111111111111'] }],
    },
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private\.example|alice|secret|411111|pay-private|epoch:r1/);
  assert.equal(result.version, 4);
  assert.equal(result.target.role, 'button');
  assert.equal(result.form.method, 'POST');
  assert.match(result.target.ref, /^\[redacted:/);
  assert.match(result.form.controls[0].values, /^\[redacted:/);
});
