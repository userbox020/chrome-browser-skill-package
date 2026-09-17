import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { COMMANDS, COMMAND_OPTIONS, LOCAL_COMMANDS, matchCommand } from '../extension/commands.js';
import { EXTENSION_ID } from '../extension/identity.js';
import { getOrCreatePairingSecret } from './pairing.mjs';
import { getHealth, PORT, readServerState, requestJson } from './protocol.mjs';
import { bridgeStatus, doctor, startBridge, stopBridge } from './lifecycle.mjs';
import { browserError, errorInfo } from '../extension/errors.js';
import { agentEnvelope } from './output.mjs';

export async function main(argv, entryPath) {
  const options = takeGlobalOptions(argv);
  const tokens = options.tokens;
  const first = tokens[0];

  if (!first || first === 'help' || first === '--help' || first === '-h') {
    showHelp(tokens.slice(1), options);
    return;
  }
  if (['status', 'doctor'].includes(first)) {
    if (tokens.length !== 1) throw new UsageError('This command takes no arguments.');
    printOutput(first, first === 'doctor' ? await doctor() : await bridgeStatus(), options);
    return;
  }
  if (first === 'server' && tokens.length > 1) {
    const action = tokens[1];
    if (tokens.length !== 2 || !['start', 'stop', 'restart'].includes(action)) throw new UsageError('Use server start, server stop, or server restart.');
    if (action === 'stop' || action === 'restart') {
      const stopped = await stopBridge();
      if (action === 'stop') { printOutput('server.stop', stopped, options); return; }
    }
    printOutput(`server.${action}`, await startBridge(entryPath), options);
    return;
  }
  if (first === 'pair') {
    const url = `chrome-extension://${EXTENSION_ID}/pair.html#${getOrCreatePairingSecret()}`;
    printOutput('pair', { url, instructions: 'Open this URL in Chrome after loading the unpacked extension. Treat the URL as a local secret.' }, options);
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
  const parsed = parseCommandOptions(definition, commandTokens);
  const { args, local } = parseArguments(definition, parsed.tokens);
  Object.assign(args, parsed.options);
  if (options.agent && ['page.elements', 'page.snap', 'page.accessibility', 'tabs.list'].includes(definition.name)) {
    args.limit ??= 20;
    if (['page.elements', 'page.snap'].includes(definition.name) && !args.includeHidden) args.visible ??= true;
  }

  const state = await ensureServer(entryPath);
  const response = await requestJson('/cmd', {
    port: state.port,
    method: 'POST',
    headers: { 'Authorization': `Bearer ${state.token}`, 'Content-Type': 'application/json' },
    body: { cmd: definition.name, args, includeSensitive: options.includeSensitive, confirm: options.confirm, ...((Object.keys(parsed.options).length || args.limit || definition.name === 'element.inspect') ? { requiredCapability: 'discovery-v1' } : {}) },
    timeout: 35_000,
  }).catch(error => { throw browserError(error.code === 'ECONNREFUSED' ? 'bridge-unavailable' : 'outcome-unknown'); });
  const payload = response.body;

  if (payload.confirmationRequired) {
    if (options.agent) console.log(JSON.stringify(agentEnvelope(definition.name, payload)));
    else if (options.json) console.log(JSON.stringify(payload, null, 2));
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
    next: payload.next,
  });

  const result = definition.name.startsWith('screenshot')
    ? saveScreenshot(payload.result, local.file)
    : payload.result;
  printOutput(definition.name, result, options);
}

export function takeGlobalOptions(argv) {
  const tokens = [];
  let json = false;
  let agent = false;
  let includeSensitive = false;
  let confirm = null;
  let parseFlags = true;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (parseFlags && token === '--') { parseFlags = false; tokens.push('--'); }
    else if (parseFlags && token === '--json') json = true;
    else if (parseFlags && token === '--agent') agent = true;
    else if (parseFlags && token === '--include-sensitive') includeSensitive = true;
    else if (parseFlags && token === '--confirm') {
      confirm = argv[++index];
      if (!confirm || confirm.startsWith('--')) throw new UsageError('--confirm requires a challenge value');
    } else tokens.push(token);
  }
  return { tokens, json, agent, includeSensitive, confirm };
}

export function parseCommandOptions(definition, tokens) {
  const specs = COMMAND_OPTIONS[definition.name] || {};
  const positional = [];
  const options = {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '--') { positional.push(...tokens.slice(index + 1)); break; }
    if (!token.startsWith('--') || !Object.keys(specs).length) { positional.push(token); continue; }
    const name = token.slice(2);
    const type = specs[name];
    if (!type) throw new UsageError(`Unsupported option ${token}. Use help ${definition.path.join(' ')}.`);
    const key = name === 'include-hidden' ? 'includeHidden' : name;
    if (key in options) throw new UsageError(`Duplicate option ${token}.`);
    const value = type === 'boolean' ? true : tokens[++index];
    if (value == null || value === '' || (typeof value === 'string' && value.startsWith('--'))) throw new UsageError(`Missing value for ${token}.`);
    if (type === 'integer') {
      const number = Number(value);
      if (!Number.isInteger(number) || number < (name === 'limit' ? 1 : 0) || (name === 'limit' && number > 300)) throw new UsageError(`${token} must be ${name === 'limit' ? 'between 1 and 300' : 'a nonnegative integer'}.`);
      options[key] = number;
    } else options[key] = value;
  }
  if (options.visible && options.includeHidden) throw new UsageError('--visible and --include-hidden are mutually exclusive.');
  return { tokens: positional, options };
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
    await startBridge(entryPath);
  }
  const health = await getHealth(PORT);
  if (!health) throw browserError('bridge-unavailable');
  const state = readServerState();
  if (!state || state.port !== PORT || state.protocol !== health.protocol) throw browserError('auth-unavailable');
  let connected = health.extensionConnected;
  for (let attempt = 0; !connected && attempt < 25; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    connected = Boolean((await getHealth(PORT))?.extensionConnected);
  }
  if (!connected) throw browserError('extension-disconnected');
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

function printOutput(command, result, options) {
  if (options.agent) console.log(JSON.stringify(agentEnvelope(command, { ok: true, result })));
  else printResult(result, options.json);
}

function showHelp(query = [], options = {}) {
  const commands = [...LOCAL_COMMANDS, ...COMMANDS].filter(item => query.every((part, index) => item.path[index] === part));
  if (!commands.length) throw new UsageError('No matching command. Use help for the command list.');
  if (options.json || options.agent) {
    printOutput('help', { commands: commands.map(item => ({ ...item, options: COMMAND_OPTIONS[item.name] || {} })), globalOptions: ['--agent', '--json', '--include-sensitive', '--confirm <challenge>', '--'] }, options);
    return;
  }
  console.log('chrome-browser - control a selected live Chrome tab');
  console.log('');
  console.log('Usage: browser <command> [args] [--agent|--json] [--include-sensitive] [--confirm <challenge>] [-- <literal values>]');
  console.log('       browser server');
  console.log('       browser pair');
  console.log('');
  for (const item of commands) {
    console.log(`  ${item.usage.padEnd(54)} ${item.description}`);
    const flags = Object.entries(COMMAND_OPTIONS[item.name] || {}).map(([name, type]) => `--${name}${type === 'boolean' ? '' : ` <${type}>`}`);
    if (flags.length) console.log(`    Options: ${flags.join(', ')}`);
  }
}

export class UsageError extends Error { constructor(message) { super(message); this.code = 'usage-error'; } }

export function reportError(error, argv) {
  const flags = argv.slice(0, argv.includes('--') ? argv.indexOf('--') : argv.length);
  const info = errorInfo(error.code);
  const message = error instanceof UsageError ? error.message : flags.includes('--include-sensitive') ? error.message : info.message;
  const payload = { ok: false, code: info.code, error: message, details: error.details || null, next: error.next || info.next };
  const definition = matchCommand(flags.filter(token => !token.startsWith('--')));
  if (flags.includes('--agent')) console.log(JSON.stringify(agentEnvelope(definition?.name || null, payload)));
  else if (flags.includes('--json')) console.error(JSON.stringify({ ok: false, error: { code: info.code, message, details: payload.details }, next: payload.next }, null, 2));
  else console.error(`Error [${info.code}]: ${message}\nNext: ${payload.next.instruction}`);
  process.exitCode = 1;
}
