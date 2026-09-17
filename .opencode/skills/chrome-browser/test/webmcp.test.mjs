import assert from 'node:assert/strict';
import test from 'node:test';
import { getCommand } from '../extension/commands.js';
import { callWebMcpTool, serializeWebMcpInput } from '../extension/webmcp.js';
import { runInNewContext } from 'node:vm';
import { parseArguments } from '../src/cli.mjs';

test('WebMCP call inputs are parsed as objects rather than retained as JSON strings', () => {
  const parsed = parseArguments(getCommand('webmcp.call'), ['searchFlights', '{"origin":"LHR","destination":"JFK"}']);
  assert.deepEqual(parsed.args, {
    toolName: 'searchFlights',
    input: { origin: 'LHR', destination: 'JFK' },
  });
});

test('WebMCP objects are serialized at the browser API boundary', () => {
  assert.equal(serializeWebMcpInput({ origin: 'LHR' }), '{"origin":"LHR"}');
  assert.equal(serializeWebMcpInput(undefined), '{}');
});

test('WebMCP calls are dynamically risk classified', () => {
  assert.equal(getCommand('webmcp.call').risk, 'dynamic');
  assert.notEqual(getCommand('webmcp.forms').name, getCommand('extract.forms').name);
});

test('approved WebMCP executes the serialized callback without module closures', async t => {
  const previous = globalThis.chrome;
  t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; });
  const tool = { name: 'fixture', description: 'Fixture tool', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };
  const calls = [];
  const context = { async getTools() { return [tool]; }, async executeTool(target, input) { calls.push({ name: target.name, input }); return { done: true }; } };
  globalThis.chrome = { scripting: { async executeScript({ func, args }) {
    const callback = runInNewContext(`(${func.toString()})`, { document: { modelContext: context }, navigator: {}, location: { origin: 'https://fixture.test' } });
    return [{ result: await callback(...args) }];
  } } };
  const challenge = await callWebMcpTool(7, 'fixture', { query: 'hello' }, false, null);
  assert.equal(challenge.confirmationRequired, true);
  assert.equal(calls.length, 0);
  const reordered = Object.fromEntries(Object.entries(challenge.approvalContext).reverse());
  const result = await callWebMcpTool(7, 'fixture', { query: 'hello' }, true, reordered);
  assert.equal(result.executed, true);
  assert.equal(calls.length, 1);
  tool.description = 'Changed operation';
  const changed = await callWebMcpTool(7, 'fixture', {}, true, reordered);
  assert.equal(changed.confirmationRequired, true);
  assert.equal(calls.length, 1);
});
