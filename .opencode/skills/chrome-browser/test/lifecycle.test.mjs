import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { bridgeStatus, stopBridge, windowsLaunchCommand } from '../src/lifecycle.mjs';
import { requestJson } from '../src/protocol.mjs';
import { VERSION } from '../extension/version.js';

test('status is authenticated, exposes versions without tokens, and shutdown rejects web origins', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-lifecycle-'));
  const stateFile = join(directory, 'server.json');
  const server = await startServer({ port: 0, stateFile, pairingSecret: '11'.repeat(32) });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const options = { port: server.port, stateFile };
  const status = await bridgeStatus(options);
  assert.equal(status.bridgeVersion, VERSION);
  assert.equal(status.state, 'extension-disconnected');
  assert.equal(JSON.stringify(status).includes(server.token), false);
  const forbidden = await requestJson('/admin/stop', { port: server.port, method: 'POST', headers: { Authorization: `Bearer ${server.token}`, Origin: 'https://example.test' } });
  assert.equal(forbidden.statusCode, 403);
  const unauthorized = await requestJson('/admin/stop', { port: server.port, method: 'POST' });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal((await stopBridge(options)).stopped, true);
  assert.equal((await bridgeStatus(options)).state, 'stopped');
});

test('Windows background launch quotes spaces and apostrophes without shell interpolation', () => {
  const command = windowsLaunchCommand('C:\\Program Files\\nodejs\\node.exe', "C:\\User's Work\\skill\\browser.mjs");
  assert.ok(command.includes("-FilePath 'C:\\Program Files\\nodejs\\node.exe'"));
  assert.ok(command.includes(`'"C:\\User''s Work\\skill\\browser.mjs"'`));
  assert.throws(() => windowsLaunchCommand('node', 'script";evil'), error => error.code === 'usage-error');
});
