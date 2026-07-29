import { localPairingUrl, pairFromValue, pairingStatus } from './pairing.js';

const input = document.querySelector('#pairing-value');
const pairButton = document.querySelector('#pair');
const state = document.querySelector('#state');
const message = document.querySelector('#message');
let pairingUrl = null;

pairButton.addEventListener('click', async () => {
  try {
    await pairFromValue(pairingUrl);
    message.dataset.error = 'false';
    message.textContent = 'Pairing saved. Reconnecting...';
    setTimeout(refresh, 800);
  } catch (error) {
    message.dataset.error = 'true';
    message.textContent = error.message;
  }
});

document.querySelector('#open').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('pair.html') }));
await initialize();

async function initialize() {
  const current = await refresh();
  if (current.connected) return;
  try {
    pairingUrl = current.pairingUrl || await localPairingUrl();
    input.value = pairingUrl;
    pairButton.disabled = false;
    if (state.textContent !== 'Connected') message.textContent = 'Pairing URL ready. Click Pair now.';
  } catch (error) {
    message.dataset.error = 'true';
    message.textContent = error.message;
  }
}

async function refresh() {
  const current = await pairingStatus();
  state.dataset.connected = String(current.connected);
  state.textContent = current.connected ? 'Connected' : current.paired ? 'Paired' : 'Not paired';
  document.querySelector('#pairing-controls').hidden = current.connected;
  if (current.connected) {
    message.dataset.error = 'false';
    message.textContent = 'Connected to the local bridge and ready for selected-tab commands.';
  }
  return current;
}
