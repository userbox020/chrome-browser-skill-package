import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { request } from 'http';
import { resolve } from 'path';

export const HOST = '127.0.0.1';
export const PORT = 9998;
export const SERVICE = 'chrome-browser';
export const PROTOCOL_VERSION = 1;
export const RUNTIME_DIR = process.platform === 'win32'
  ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), SERVICE)
  : resolve(process.env.XDG_RUNTIME_DIR || resolve(homedir(), '.cache'), SERVICE);
export const STATE_FILE = resolve(RUNTIME_DIR, 'server.json');

export function ensureRuntimeDir() {
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
}

export function writeServerState(state, file = STATE_FILE) {
  ensureRuntimeDir();
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
}

export function readServerState(file = STATE_FILE) {
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (state.service !== SERVICE || !state.token || !state.port) return null;
    return state;
  } catch {
    return null;
  }
}

export function removeServerState(token, file = STATE_FILE) {
  const current = readServerState(file);
  if (current?.token !== token) return;
  try { unlinkSync(file); } catch {}
}

export async function getHealth(port = PORT, timeout = 1000) {
  try {
    const response = await requestJson('/health', { port, timeout });
    if (response.statusCode !== 200) return null;
    const value = response.body;
    return value?.service === SERVICE && value?.protocol === PROTOCOL_VERSION ? value : null;
  } catch {
    return null;
  }
}

export function requestJson(path, options = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    let deadline;
    const resolveOnce = value => { clearTimeout(deadline); resolveRequest(value); };
    const rejectOnce = error => { clearTimeout(deadline); rejectRequest(error); };
    const body = options.body == null ? null : JSON.stringify(options.body);
    const operation = request({
      hostname: HOST,
      port: options.port ?? PORT,
      path,
      method: options.method || 'GET',
      headers: { ...(options.headers || {}), ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
    }, response => {
      let text = '';
      let bytes = 0;
      response.setEncoding('utf8');
      response.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 20 * 1024 * 1024) { operation.destroy(new Error('Local bridge response exceeds the transfer limit')); return; }
        text += chunk;
      });
      response.on('error', rejectOnce);
      response.on('aborted', () => rejectOnce(new Error('Local bridge response was interrupted')));
      response.on('end', () => {
        try { resolveOnce({ statusCode: response.statusCode || 0, body: text ? JSON.parse(text) : null }); }
        catch (error) { rejectOnce(error); }
      });
    });
    deadline = setTimeout(() => operation.destroy(new Error('Local bridge request timed out')), options.timeout ?? 35_000);
    operation.on('error', rejectOnce);
    if (body) operation.write(body);
    operation.end();
  });
}

export function commandFingerprint(cmd, args) {
  return JSON.stringify({ cmd, args: sortValue(args) });
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
}
