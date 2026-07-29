import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getCommand } from '../extension/commands.js';
import { parseArguments, takeGlobalOptions, UsageError } from '../src/cli.mjs';

test('global flags are removed without changing command arguments', () => {
  assert.deepEqual(
    takeGlobalOptions(['page', 'snap', '--json', '--include-sensitive', '--confirm', 'abc']),
    { tokens: ['page', 'snap'], json: true, includeSensitive: true, confirm: 'abc' },
  );
});

test('the option terminator preserves flag-looking command values', () => {
  assert.deepEqual(
    takeGlobalOptions(['type', '--', '--include-sensitive']),
    { tokens: ['type', '--include-sensitive'], json: false, includeSensitive: false, confirm: null },
  );
});

test('rest arguments preserve space-containing interaction values', () => {
  const parsed = parseArguments(getCommand('fill'), ['#search', 'hello', 'browser']);
  assert.deepEqual(parsed.args, { selector: '#search', value: 'hello browser' });
});

test('page element queries preserve spaces', () => {
  assert.deepEqual(parseArguments(getCommand('page.elements'), ['show', 'all']).args, { query: 'show all' });
});

test('new control and wait commands parse refs and values', () => {
  assert.deepEqual(parseArguments(getCommand('select'), ['@e2', 'United', 'States']).args, { target: '@e2', value: 'United States' });
  assert.deepEqual(parseArguments(getCommand('wait.element'), ['@e3', 'enabled', '2500']).args, { target: '@e3', state: 'enabled', timeout: 2500 });
  assert.deepEqual(parseArguments(getCommand('screenshot.element'), ['@e4', 'element.png']), { args: { target: '@e4' }, local: { file: 'element.png' } });
});

test('upload paths are resolved and validated locally', () => {
  const file = fileURLToPath(import.meta.url);
  const parsed = parseArguments(getCommand('upload'), ['@e5', JSON.stringify([file])]);
  assert.deepEqual(parsed.args, { target: '@e5', files: [file] });
  assert.throws(() => parseArguments(getCommand('upload'), ['@e5', '["missing-file"]']), /does not exist/i);
});

test('request modifier values use JSON types when possible', () => {
  assert.deepEqual(
    parseArguments(getCommand('request.modify'), ['checkout', 'total.amount', '1']).args,
    { urlFilter: 'checkout', jsonKey: 'total.amount', value: 1 },
  );
  assert.deepEqual(
    parseArguments(getCommand('request.modify'), ['checkout', 'enabled', 'true']).args.value,
    true,
  );
});

test('screenshot path remains local to the CLI', () => {
  const parsed = parseArguments(getCommand('screenshot'), ['output.png']);
  assert.deepEqual(parsed.args, {});
  assert.deepEqual(parsed.local, { file: 'output.png' });
});

test('invalid and missing arguments fail before reaching Chrome', () => {
  assert.throws(() => parseArguments(getCommand('tabs.use'), ['nope']), UsageError);
  assert.throws(() => parseArguments(getCommand('navigate'), []), UsageError);
  assert.throws(() => parseArguments(getCommand('page.snap'), ['extra']), UsageError);
});

test('named interception rules parse JSON and ordered activation names', () => {
  const rule = parseArguments(getCommand('intercept.rule.set'), ['checkout', '{"request":{"block":"Aborted"}}']);
  assert.deepEqual(rule.args, { name: 'checkout', rule: { request: { block: 'Aborted' } } });
  const start = parseArguments(getCommand('intercept.start'), ['checkout', 'headers']);
  assert.deepEqual(start.args, { names: 'checkout headers' });
});
