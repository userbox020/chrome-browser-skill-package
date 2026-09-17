import { mountPairingView } from './pairing-view.js';

const linkedSecret = location.hash.slice(1).trim();
history.replaceState(null, '', location.pathname);
await mountPairingView({
  input: document.querySelector('#pairing-value'),
  button: document.querySelector('#pair-button'),
  status: document.querySelector('#state'),
  message: document.querySelector('#status'),
  controls: document.querySelector('#pairing-controls'),
  retry: document.querySelector('#retry'),
  linkedSecret,
});
