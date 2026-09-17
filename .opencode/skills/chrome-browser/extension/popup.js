import { mountPairingView } from './pairing-view.js';

document.querySelector('#open').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('pair.html') }));
await mountPairingView({
  input: document.querySelector('#pairing-value'),
  button: document.querySelector('#pair'),
  status: document.querySelector('#state'),
  message: document.querySelector('#message'),
  controls: document.querySelector('#pairing-controls'),
  retry: document.querySelector('#retry'),
});
