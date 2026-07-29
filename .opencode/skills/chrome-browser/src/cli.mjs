import { spawn } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { COMMANDS, matchCommand } from '../extension/commands.js';
import { EXTENSION_ID } from '../extension/identity.js';
import { getOrCreatePairingSecret } from './pairing.mjs';
import { getHealth, HOST, PORT, RUNTIME_DIR, readServerState, requestJson } from './protocol.mjs';

export async function main(argv, entryPath) {
  const options = takeGlobalOptions(argv);
  const tokens = options.tokens;
  const first = tokens[0];

  if (!first || first === 'help' || first === '--help' || first === '-h') {
    showHelp();
    return;
  }
  if (first === 'pair') {
    const url = `chrome-extension://${EXTENSION_ID}/pair.html#${getOrCreatePairingSecret()}`;
    printResult({ url, instructions: 'Open this URL in Chrome after loading the unpacked extension. Treat the URL as a local secret.' }, options.json);
    return;
  }
  if (first === 'server' || first === '_server') {
    const { startServer } = await import('./server.mjs');
    const server = await startServer();
    if (first === 'server') {
      console.log(`Chrome browser bridge listening at http://${server.host}:${server.port}`);
      console.log('Load the unpacked extension from .opencode/skills/chrome-browser/extension');
    }
    const shutdown = async () => { await server.close(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return new Promise(() => {});
  }

  const definition = matchCommand(tokens);
  if (!definition) throw new UsageError(`Unknown command: ${tokens.join(' ')}`);
  const commandTokens = tokens.slice(definition.path.length);
  const { args, local } = parseArguments(definition, commandTokens);

  const state = await ensureServer(entryPath);
  const response = await requestJson('/cmd', {
    port: state.port,
    method: 'POST',
    headers: { 'Authorization': `Bearer ${state.token}`, 'Content-Type': 'application/json' },
    body: { cmd: definition.name, args, includeSensitive: options.includeSensitive, confirm: options.confirm },
    timeout: 35_000,
  });
  const payload = response.body;

  if (payload.confirmationRequired) {
    if (options.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.error(`Confirmation required: ${payload.summary}`);
      if (payload.target) console.error(`Target: tab ${payload.target.tabId} ${payload.target.title || ''} ${payload.target.url || ''}`.trim());
      if (payload.details) console.error(`Details: ${JSON.stringify(payload.details)}`);
      console.error(`After the user explicitly approves, rerun with --confirm ${payload.challenge}`);
    }
    process.exitCode = 2;
    return;
  }
  if (response.statusCode < 200 || response.statusCode >= 300 || !payload.ok) throw Object.assign(new Error(payload.error || `Bridge returned HTTP ${response.statusCode}`), {
    code: payload.code || 'bridge-error',
    details: payload.details || null,
    json: options.json,
  });

  const result = definition.name.startsWith('screenshot')
    ? saveScreenshot(payload.result, local.file)
    : payload.result;
  printResult(result, options.json);
}

export function takeGlobalOptions(argv) {
  const tokens = [];
  let json = false;
  let includeSensitive = false;
  let confirm = null;
  let parseFlags = true;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (parseFlags && token === '--') parseFlags = false;
    else if (parseFlags && token === '--json') json = true;
    else if (parseFlags && token === '--include-sensitive') includeSensitive = true;
    else if (parseFlags && token === '--confirm') {
      confirm = argv[++index];
      if (!confirm) throw new UsageError('--confirm requires a challenge value');
    } else tokens.push(token);
  }
  return { tokens, json, includeSensitive, confirm };
}

export function parseArguments(definition, tokens) {
  const args = {};
  const local = {};
  let index = 0;
  for (const spec of definition.args) {
    let raw;
    if (spec.rest) {
      raw = tokens.slice(index).join(' ');
      index = tokens.length;
    } else {
      raw = tokens[index++];
    }
    if (raw == null || raw === '') {
      if (!spec.optional) throw new UsageError(`Missing <${spec.name}>. Usage: ${definition.usage}`);
      continue;
    }
    const value = parseValue(raw, spec.type, spec.name);
    if (spec.local) local[spec.name] = value;
    else args[spec.name] = value;
  }
  if (index < tokens.length) throw new UsageError(`Too many arguments. Usage: ${definition.usage}`);
  return { args, local };
}

function parseValue(raw, type, name) {
  if (type === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new UsageError(`${name} must be a number`);
    return value;
  }
  if (type === 'json') {
    try { return JSON.parse(raw); }
    catch (error) { throw new UsageError(`${name} must be valid JSON: ${error.message}`); }
  }
  if (type === 'auto') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  if (type === 'files') {
    let values;
    try { values = JSON.parse(raw); }
    catch (error) { throw new UsageError(`${name} must be a JSON array of local file paths: ${error.message}`); }
    if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !value)) {
      throw new UsageError(`${name} must be a non-empty JSON array of local file paths`);
    }
    return values.map(value => {
      const file = resolve(value);
      if (!existsSync(file)) throw new UsageError(`Upload file does not exist: ${value}`);
      return file;
    });
  }
  return raw;
}

async function ensureServer(entryPath) {
  const existing = await getHealth(PORT);
  if (!existing) {
    const child = spawn(process.execPath, [entryPath, '_server'], { detached: true, stdio: 'ignore' });
    child.unref();
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (await getHealth(PORT)) break;
    }
  }
  const health = await getHealth(PORT);
  if (!health) throw new Error(`Cannot start chrome-browser bridge on ${HOST}:${PORT}. Stop any older bridge using that port.`);
  const state = readServerState();
  if (!state || state.port !== PORT || state.protocol !== health.protocol) throw new Error(`Bridge authentication state is unavailable at ${RUNTIME_DIR}. Restart the chrome-browser bridge.`);
  let connected = health.extensionConnected;
  for (let attempt = 0; !connected && attempt < 25; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    connected = Boolean((await getHealth(PORT))?.extensionConnected);
  }
  if (!connected) throw new Error('Bridge server is running, but the Chrome Browser Bridge extension is not connected. Load or reload .opencode/skills/chrome-browser/extension.');
  return state;
}

function saveScreenshot(result, requestedFile) {
  if (!result?.dataUrl?.startsWith('data:image/png;base64,')) throw new Error('Extension returned an invalid screenshot');
  const file = resolve(requestedFile || `chrome-screenshot-${Date.now()}.png`);
  writeFileSync(file, Buffer.from(result.dataUrl.split(',')[1], 'base64'));
  return { file, width: result.width, height: result.height, devicePixelRatio: result.devicePixelRatio };
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (typeof result === 'string') console.log(result);
  else if (result == null) console.log('(no result)');
  else console.log(JSON.stringify(result, null, 2));
}

function showHelp() {
  console.log('chrome-browser - control a selected live Chrome tab');
  console.log('');
  console.log('Usage: browser <command> [args] [--json] [--include-sensitive] [--confirm <challenge>] [-- <literal values>]');
  console.log('       browser server');
  console.log('       browser pair');
  console.log('');
  for (const item of COMMANDS) console.log(`  ${item.usage.padEnd(54)} ${item.description}`);
}

export class UsageError extends Error {}
