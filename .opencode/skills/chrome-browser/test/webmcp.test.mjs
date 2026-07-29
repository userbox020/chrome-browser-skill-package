import assert from 'node:assert/strict';
import test from 'node:test';
import { getCommand } from '../extension/commands.js';
import { serializeWebMcpInput } from '../extension/webmcp.js';
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
