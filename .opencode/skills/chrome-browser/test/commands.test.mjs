import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { COMMANDS, getCommand, matchCommand } from '../extension/commands.js';
import { EXTENSION_ID } from '../extension/identity.js';

test('command names and paths are unique', () => {
  assert.equal(new Set(COMMANDS.map(item => item.name)).size, COMMANDS.length);
  assert.equal(new Set(COMMANDS.map(item => item.path.join(' '))).size, COMMANDS.length);
});

test('all command definitions are complete and rest arguments are final', () => {
  for (const command of COMMANDS) {
    assert.ok(command.name);
    assert.ok(command.usage);
    assert.ok(command.description);
    assert.ok(['none', 'always', 'unsafe-method', 'dynamic'].includes(command.risk));
    const restIndex = command.args.findIndex(argument => argument.rest);
    if (restIndex >= 0) assert.equal(restIndex, command.args.length - 1, command.usage);
  }
});

test('longest command path wins', () => {
  assert.equal(matchCommand(['network', 'summary', 'api']).name, 'network.summary');
  assert.equal(matchCommand(['webmcp', 'forms']).name, 'webmcp.forms');
  assert.equal(getCommand('extract.forms').usage, 'extract forms [scope]');
  assert.equal(getCommand('page.elements').usage, 'page elements [query]');
  assert.equal(getCommand('page.accessibility').usage, 'page accessibility [query]');
});

test('the manifest public key produces the pinned extension ID', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16);
  const id = [...digest].flatMap(byte => [byte >> 4, byte & 15]).map(value => String.fromCharCode(97 + value)).join('');
  assert.equal(id, EXTENSION_ID);
});

test('escape hatches and consequential browser actions are risk classified', () => {
  assert.equal(getCommand('page.eval').risk, 'always');
  assert.equal(getCommand('dialog.accept').risk, 'dynamic');
  assert.equal(getCommand('press').risk, 'dynamic');
  assert.equal(getCommand('webmcp.call').risk, 'dynamic');
  assert.equal(getCommand('intercept.start').risk, 'dynamic');
  assert.equal(getCommand('intercept.rule.set').risk, 'none');
  assert.equal(getCommand('upload').risk, 'dynamic');
  assert.equal(getCommand('drag').risk, 'dynamic');
  assert.equal(getCommand('check').risk, 'dynamic');
  assert.equal(getCommand('uncheck').risk, 'dynamic');
});

test('named interception commands use separate rule and activation namespaces', () => {
  assert.equal(matchCommand(['intercept', 'rule', 'set', 'checkout', '{}']).name, 'intercept.rule.set');
  assert.equal(matchCommand(['intercept', 'start', 'checkout']).name, 'intercept.start');
  assert.equal(getCommand('intercept.rule.list').usage, 'intercept rule list [name]');
});
