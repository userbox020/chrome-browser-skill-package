import assert from 'node:assert/strict';
import test from 'node:test';
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
  wildcardMatch,
} from '../extension/network-utils.js';

test('nested request keys are created safely', () => {
  const value = { purchase: { currency: 'USD' } };
  setNested(value, 'purchase.amount.total', 1);
  assert.deepEqual(value, { purchase: { currency: 'USD', amount: { total: 1 } } });
});

test('prototype-polluting request paths are rejected', () => {
  assert.throws(() => setNested({}, '__proto__.polluted', true), /unsafe/i);
  assert.equal(Object.prototype.polluted, undefined);
});

test('only matching JSON requests are modified', () => {
  const modifiers = [{ urlFilter: '/checkout', jsonKey: 'total', value: 1 }];
  assert.deepEqual(
    applyRequestModifiers('{"total":99}', 'https://example.test/checkout', modifiers),
    { changed: true, postData: '{"total":1}' },
  );
  assert.deepEqual(
    applyRequestModifiers('{"total":99}', 'https://example.test/profile', modifiers),
    { changed: false, postData: '{"total":99}' },
  );
  assert.deepEqual(
    applyRequestModifiers('not-json', 'https://example.test/checkout', modifiers),
    { changed: false, postData: 'not-json' },
  );
});

test('long path identifiers are shortened in summaries', () => {
  assert.equal(redactPath('/orders/0123456789abcdef0123456789abcdef/detail'), '/orders/012345../detail');
  assert.equal(redactPath('/users/alice@example.com/detail'), '/users/[redacted]/detail');
  assert.equal(redactPath('/app;jsessionid=private-session/detail'), '/[redacted]/detail');
  assert.equal(redactPath('/reset/123456/detail'), '/reset/[redacted]/detail');
  assert.equal(redactPath('/ssn/123456789/detail'), '/ssn/[redacted]/detail');
});

test('named rules normalize request and response actions', () => {
  const rule = normalizeRule('checkout', {
    match: { urlPattern: '*://api.example.test/checkout*', methods: ['post'], resourceTypes: ['XHR'], statusCodes: [200] },
    request: {
      method: 'put',
      headers: { set: [{ name: 'X-Test', value: 'enabled' }], remove: ['Authorization'] },
      body: { jsonSet: [{ path: 'purchase.total', value: 1 }] },
    },
    response: {
      statusCode: 201,
      body: { jsonSet: [{ path: 'debug.modified', value: true }] },
    },
  });
  assert.equal(rule.request.method, 'PUT');
  assert.equal(rule.response.statusCode, 201);
  assert.equal(matchesRule(rule, { url: 'https://api.example.test/checkout/1', method: 'POST', resourceType: 'XHR' }, 'Request'), true);
  assert.equal(matchesRule(rule, { url: 'https://api.example.test/checkout/1', method: 'POST', resourceType: 'XHR', statusCode: 404 }, 'Response'), false);
  assert.deepEqual(compileFetchPatterns([rule]), [
    { urlPattern: '*://api.example.test/checkout*', requestStage: 'Request', resourceType: 'XHR' },
    { urlPattern: '*://api.example.test/checkout*', requestStage: 'Response', resourceType: 'XHR' },
  ]);
});

test('wildcard matching follows CDP star, question, and escape semantics', () => {
  assert.equal(wildcardMatch('*://*.example.test/api/?', 'https://shop.example.test/api/1'), true);
  assert.equal(wildcardMatch('*://example.test/literal\\*', 'https://example.test/literal*'), true);
  assert.equal(wildcardMatch('*://example.test/literal\\*', 'https://example.test/literal-x'), false);
});

test('header actions are case-insensitive and preserve unrelated duplicates', () => {
  const result = applyHeaderActions([
    { name: 'Set-Cookie', value: 'a=1' },
    { name: 'Set-Cookie', value: 'b=2' },
    { name: 'Authorization', value: 'secret' },
  ], {
    set: [{ name: 'X-Test', value: 'yes' }],
    remove: ['authorization'],
  });
  assert.deepEqual(result, [
    { name: 'Set-Cookie', value: 'a=1' },
    { name: 'Set-Cookie', value: 'b=2' },
    { name: 'X-Test', value: 'yes' },
  ]);
});

test('body actions support JSON, text, and binary replacement', () => {
  const json = applyBodyAction('{"purchase":{"total":99}}', false, { jsonSet: [{ path: 'purchase.total', value: 1 }] });
  assert.equal(Buffer.from(json.base64, 'base64').toString(), '{"purchase":{"total":1}}');
  assert.equal(Buffer.from(applyBodyAction('', false, { text: 'hello' }).base64, 'base64').toString(), 'hello');
  assert.deepEqual([...Buffer.from(applyBodyAction('', false, { base64: 'AAEC' }).base64, 'base64')], [0, 1, 2]);
});

test('rule validation rejects unsafe or ambiguous actions', () => {
  assert.throws(() => normalizeRule('bad name', { request: { block: 'Aborted' } }), /name/i);
  assert.throws(() => normalizeRule('bad', { request: { block: 'NotAReason' } }), /block/i);
  assert.throws(() => normalizeRule('bad', { request: { headers: { set: [{ name: 'X-Test\r\nBad', value: 'x' }] } } }), /header/i);
  assert.throws(() => normalizeRule('bad', { request: { headers: { set: [{ name: 'X Test', value: 'x' }] } } }), /header/i);
  assert.throws(() => normalizeRule('bad', { response: { headers: { set: [{ name: 'X-Test', value: 'safe\r\nInjected: yes' }] } } }), /control/i);
  assert.throws(() => normalizeRule('bad', { response: { body: { text: 'x', base64: 'eA==' } } }), /exactly one/i);
});

test('rule summaries and digests omit values and remain deterministic', async () => {
  const rule = normalizeRule('headers', { request: { headers: { set: [{ name: 'Authorization', value: 'secret' }] } } });
  assert.deepEqual(summarizeRule(rule).request.headers.set, [{ name: 'Authorization', valueLength: 6 }]);
  assert.equal(await ruleSetDigest(['headers'], [rule]), await ruleSetDigest(['headers'], [structuredClone(rule)]));
});
