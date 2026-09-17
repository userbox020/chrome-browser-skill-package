const STATES = Object.freeze({
  connecting: ['Connecting', 'Connecting to the local bridge…', '...'],
  'bridge-offline': ['Bridge offline', 'Start the bridge with browser server start, then click Retry.', 'OFF'],
  'pairing-required': ['Pairing required', 'Your local pairing URL is ready. Click Pair now.', 'PAIR'],
  authenticating: ['Authenticating', 'Waiting for the bridge to acknowledge authentication…', '...'],
  'auth-failed': ['Pairing mismatch', 'The stored pairing no longer matches this bridge. Click Pair now to pair again.', 'PAIR'],
  'version-mismatch': ['Update required', 'Bridge and extension versions differ. Update both, restart the bridge, and reload the extension.', 'UPD'],
  disconnected: ['Disconnected', 'Reconnecting to the local bridge…', '...'],
  connected: ['Connected', 'Connected to the local bridge and ready for selected-tab commands.', 'ON'],
});

export function connectionView(status) {
  const state = Object.hasOwn(STATES, status?.state) ? status.state : status?.connected ? 'connected' : 'disconnected';
  const [label, message, badge] = STATES[state];
  return { state, label, message, badge, connected: state === 'connected', showPairing: ['pairing-required', 'auth-failed'].includes(state), canPair: ['pairing-required', 'auth-failed'].includes(state) && Boolean(status?.pairingUrl), error: ['bridge-offline', 'auth-failed', 'version-mismatch'].includes(state) };
}
