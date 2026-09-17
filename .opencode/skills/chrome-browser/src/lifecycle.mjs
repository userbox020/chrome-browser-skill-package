import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PORT, SERVICE, PROTOCOL_VERSION, readServerState, requestJson } from './protocol.mjs';
import { VERSION } from '../extension/version.js';
import { browserError } from '../extension/errors.js';

const require = createRequire(import.meta.url);
const skillDirectory = fileURLToPath(new URL('../', import.meta.url));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function bridgeStatus(options = {}) {
  const port = options.port ?? PORT;
  const state = readServerState(options.stateFile);
  let health;
  try { health = await requestJson('/health', { port, timeout: 1_000 }); }
  catch (error) {
    return { running: false, reachable: error.code !== 'ECONNREFUSED', connected: false, version: VERSION, state: error.code === 'ECONNREFUSED' ? 'stopped' : 'unreachable' };
  }
  if (health.body?.service !== SERVICE) return { running: false, reachable: true, connected: false, version: VERSION, state: 'port-in-use' };
  const info = { running: true, reachable: true, connected: Boolean(health.body.extensionConnected), version: VERSION, bridgeVersion: health.body.version || null, protocol: health.body.protocol, extensionVersion: health.body.extensionVersion || null, capabilities: health.body.capabilities || [], selectedTab: null };
  if (health.body.protocol !== PROTOCOL_VERSION) return { ...info, state: 'incompatible-protocol' };
  if (!state || state.port !== port) return { ...info, state: 'auth-unavailable' };
  const authenticated = await requestJson('/admin/status', { port, method: 'POST', headers: { Authorization: `Bearer ${state.token}` }, timeout: 4_000 }).catch(() => null);
  if (authenticated?.statusCode === 401) return { ...info, state: 'auth-unavailable' };
  if (authenticated?.body?.ok) Object.assign(info, authenticated.body.result);
  if (!authenticated) return { ...info, state: 'unreachable' };
  if (authenticated.statusCode === 404) return { ...info, state: 'bridge-outdated' };
  if (!authenticated.body?.ok) return { ...info, state: 'auth-unavailable' };
  const versionsMatch = info.bridgeVersion === VERSION && (!info.connected || info.extensionVersion === VERSION);
  return { ...info, state: !versionsMatch ? 'version-mismatch' : !info.connected ? 'extension-disconnected' : !info.selectedTab ? 'no-tab-selected' : 'ready' };
}

export async function doctor(options = {}) {
  let dependencies = true;
  try { require.resolve('ws'); } catch { dependencies = false; }
  const bridge = await bridgeStatus(options);
  const nodeSupported = Number(process.versions.node.split('.')[0]) >= 22;
  const next = [];
  if (!nodeSupported) next.push('Install Node.js 22 or newer.');
  if (!dependencies) next.push(`npm ci --prefix "${skillDirectory}"`);
  if (bridge.state === 'stopped') next.push('server start');
  else if (bridge.state === 'no-tab-selected') next.push('tabs list --query <site>');
  else if (bridge.state === 'extension-disconnected') next.push('Open the extension popup and click Pair now if prompted.');
  else if (bridge.state === 'version-mismatch') {
    if (bridge.bridgeVersion !== VERSION) next.push('server restart');
    if (bridge.connected && bridge.extensionVersion !== VERSION) next.push('Reload the unpacked extension at chrome://extensions.');
  } else if (bridge.state === 'port-in-use') next.push(`Another service is responding on port ${options.port ?? PORT}; verify the process before stopping it.`);
  else if (bridge.state === 'bridge-outdated') next.push('Stop the older bridge from its original terminal, then run server start.');
  else if (bridge.state !== 'ready') next.push('Check bridge authentication and protocol state; do not stop an unidentified process.');
  return { ready: nodeSupported && dependencies && bridge.state === 'ready', node: { version: process.versions.node, supported: nodeSupported }, dependencies, skillDirectory, extensionDirectory: fileURLToPath(new URL('../extension/', import.meta.url)), bridge, next };
}

export async function startBridge(entryPath, options = {}) {
  const port = options.port ?? PORT;
  const existing = await bridgeStatus(options);
  if (existing.running) {
    if (['auth-unavailable', 'incompatible-protocol'].includes(existing.state)) throw browserError('auth-unavailable');
    return { started: false, ...existing };
  }
  if (existing.reachable) throw browserError('port-in-use');
  try { require.resolve('ws'); } catch { throw browserError('dependencies-missing'); }
  await launchBridge(entryPath);
  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(100);
    const response = await requestJson('/health', { port, timeout: 300 }).catch(() => null);
    if (response?.body?.service === SERVICE) return { started: true, ...(await bridgeStatus(options)) };
  }
  throw browserError('bridge-unavailable');
}

export function windowsLaunchCommand(executable, entryPath) {
  const literal = value => `'${String(value).replaceAll("'", "''")}'`;
  // Start-Process joins ArgumentList; quote the script path for the native process as well.
  if (/["\r\n]/.test(entryPath) || /[\r\n]/.test(executable)) throw browserError('usage-error');
  return `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${literal(executable)} -ArgumentList @(${literal(`"${entryPath}"`)}, '_server') -WindowStyle Hidden`;
}

function launchBridge(entryPath) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      const launcher = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsLaunchCommand(process.execPath, entryPath)], { stdio: 'ignore', windowsHide: true });
      const deadline = setTimeout(() => { launcher.kill(); reject(browserError('bridge-unavailable')); }, 10_000);
      launcher.once('error', () => { clearTimeout(deadline); reject(browserError('bridge-unavailable')); });
      launcher.once('close', code => { clearTimeout(deadline); if (code === 0) resolve(); else reject(browserError('bridge-unavailable')); });
    } else {
      const child = spawn(process.execPath, [entryPath, '_server'], { detached: true, stdio: 'ignore' });
      child.once('error', () => reject(browserError('bridge-unavailable')));
      child.once('spawn', () => { child.unref(); resolve(); });
    }
  });
}

export async function stopBridge(options = {}) {
  const status = await bridgeStatus(options);
  if (!status.running && !status.reachable) return { stopped: false, state: 'stopped' };
  if (!status.running) throw browserError('port-in-use');
  if (!status.capabilities.includes('lifecycle-v1')) throw browserError('lifecycle-unsupported');
  const state = readServerState(options.stateFile);
  if (!state) throw browserError('auth-unavailable');
  const response = await requestJson('/admin/stop', { port: options.port ?? PORT, method: 'POST', headers: { Authorization: `Bearer ${state.token}` }, timeout: 10_000 });
  if (!response.body?.ok) throw browserError(response.body?.code || 'auth-unavailable');
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(100);
    const running = await requestJson('/health', { port: options.port ?? PORT, timeout: 300 }).catch(() => null);
    if (!running) return { stopped: true, state: 'stopped' };
  }
  throw browserError('bridge-busy');
}
