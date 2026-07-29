import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { ensureRuntimeDir, RUNTIME_DIR } from './protocol.mjs';

export const PAIRING_FILE = resolve(RUNTIME_DIR, 'pairing.key');

export function getOrCreatePairingSecret(file = PAIRING_FILE) {
  ensureRuntimeDir();
  if (existsSync(file)) {
    const value = readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  }
  const value = randomBytes(32).toString('hex');
  writeFileSync(file, value, { mode: 0o600 });
  return value;
}
