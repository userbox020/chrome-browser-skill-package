import { pairFromValue, pairingStatus } from './pairing.js';
import { connectionView } from './connection-state.js';

// Both extension pages use the same authoritative worker state. No localhost HTTP fallback.
export async function mountPairingView({ input, button, status, message, controls, retry, linkedSecret = '' }) {
  let disposed = false;
  let refreshing = false;
  let pairingUrl = null;
  async function refresh() {
    if (refreshing || disposed) return;
    refreshing = true;
    try {
      const current = await pairingStatus();
      if (disposed) return;
      const view = connectionView(current);
      pairingUrl = view.canPair ? current.pairingUrl : null;
      input.value = pairingUrl || '';
      controls.hidden = !view.showPairing;
      button.disabled = !view.canPair;
      status.textContent = view.label;
      status.dataset.connected = String(view.connected);
      message.textContent = view.message;
      message.dataset.error = String(view.error);
      message.dataset.ok = String(view.connected);
    } finally { refreshing = false; }
  }
  async function pair(value) {
    button.disabled = true;
    try { await pairFromValue(value); await refresh(); }
    catch (error) { message.dataset.error = 'true'; message.textContent = error.message; }
  }
  button.addEventListener('click', () => pair(pairingUrl));
  retry.addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'pairing.retry' }).catch(() => {}); await refresh(); });
  if (linkedSecret) await pair(linkedSecret);
  await refresh();
  const timer = setInterval(refresh, 1_000);
  const stop = () => { disposed = true; clearInterval(timer); input.value = ''; pairingUrl = null; };
  window.addEventListener('pagehide', stop, { once: true });
  return stop;
}
