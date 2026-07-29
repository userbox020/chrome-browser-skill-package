export function parsePairingValue(value, extensionId = chrome.runtime.id) {
  const input = String(value || '').trim();
  if (/^[a-f0-9]{64}$/i.test(input)) return input.toLowerCase();
  let url;
  try { url = new URL(input); } catch { throw new Error('Paste a complete pairing URL or 64-character secret.'); }
  if (url.protocol !== 'chrome-extension:' || url.hostname !== extensionId || url.pathname !== '/pair.html') throw new Error('This pairing URL belongs to a different extension or page.');
  const secret = url.hash.slice(1);
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error('The pairing URL has an invalid or missing secret.');
  return secret.toLowerCase();
}

export async function pairFromValue(value) {
  const bridgeSecret = parsePairingValue(value);
  await chrome.storage.local.set({ bridgeSecret });
  await chrome.runtime.sendMessage({ type: 'pairing.updated' }).catch(() => {});
}

export async function localPairingUrl(fetcher = fetch, extensionId = chrome.runtime.id) {
  const response = await fetcher('http://127.0.0.1:9998/pair', { cache: 'no-store' });
  if (!response.ok) throw new Error('The local bridge could not provide a pairing link. Start the bridge and try again.');
  const payload = await response.json();
  parsePairingValue(payload.url, extensionId);
  return payload.url;
}

export async function pairingStatus() {
  return chrome.runtime.sendMessage({ type: 'pairing.status' }).catch(async () => {
    const { bridgeSecret } = await chrome.storage.local.get('bridgeSecret');
    return { paired: /^[a-f0-9]{64}$/i.test(bridgeSecret || ''), connected: false };
  });
}
