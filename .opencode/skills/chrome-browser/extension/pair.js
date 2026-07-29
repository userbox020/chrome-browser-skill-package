import { localPairingUrl, pairFromValue, pairingStatus } from './pairing.js';

const input = document.querySelector('#pairing-value');
const button = document.querySelector('#pair-button');
const status = document.querySelector('#status');
const linkedUrl = location.href;
const linkedSecret = location.hash.slice(1).trim();
history.replaceState(null, '', location.pathname);

button.addEventListener('click', () => pair(input.value));

if (linkedSecret) {
  input.value = linkedUrl;
  button.disabled = false;
  await pair(linkedSecret);
} else {
  try {
    const current = await pairingStatus();
    input.value = current.pairingUrl || await localPairingUrl();
    button.disabled = false;
    if (current.connected) renderStatus(current);
    else status.textContent = 'Pairing URL ready. Click Pair and connect.';
  } catch (error) {
    status.dataset.ok = 'false';
    status.textContent = error.message;
  }
}

async function pair(value) {
  try {
    await pairFromValue(value);
    status.dataset.ok = 'true';
    status.textContent = 'Pairing saved. Reconnecting to the local bridge...';
    setTimeout(async () => renderStatus(await pairingStatus()), 800);
  } catch (error) {
    status.dataset.ok = 'false';
    status.textContent = error.message;
  }
}

function renderStatus(current) {
  status.dataset.ok = String(current.connected);
  status.textContent = current.connected ? 'Paired and connected to the local bridge.' : current.paired ? 'Paired. Waiting for the local bridge to connect.' : 'Not paired yet.';
}
