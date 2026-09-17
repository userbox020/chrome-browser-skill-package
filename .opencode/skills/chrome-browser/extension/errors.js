// Only controlled catalogue messages are public. Never interpolate page data here.
const ERRORS = {
  'no-tab-selected': ['Select a tab before interacting.', 'tabs list', 'Select the exact intended tab with tabs use <tabId>.'],
  'tab-closed': ['The selected tab has closed.', 'tabs list', 'Select an existing tab and discover fresh refs.'],
  'unsupported-page': ['This tab is not an inspectable HTTP(S) page.', 'tabs list', 'Select an HTTP(S) tab.'],
  'extension-disconnected': ['The Chrome extension is not connected.', 'doctor', 'Open the extension popup and check its connection state.'],
  'extension-outdated': ['The loaded extension lacks this command or capability.', 'doctor', 'Reload the unpacked extension at chrome://extensions.'],
  'bridge-outdated': ['The running bridge needs an update.', 'doctor', 'Restart the bridge from this installation.'],
  'bridge-unavailable': ['The local bridge is unavailable.', 'server start', 'Start the bridge before pairing.'],
  'port-in-use': ['The local port is occupied by another or incompatible service.', 'doctor', 'Check the process using the bridge port.'],
  'auth-unavailable': ['The local bridge authentication state is unavailable or mismatched.', 'doctor', 'Use the bridge started from this installation.'],
  'dependencies-missing': ['Runtime dependencies are not installed.', 'doctor', 'Run npm ci --prefix <skill-directory>.'],
  'lifecycle-unsupported': ['This older bridge does not support managed shutdown.', 'doctor', 'Stop its server terminal, then run server start.'],
  'bridge-busy': ['A browser command is still running.', 'status', 'Wait for its outcome before restarting.'],
  'stale': ['The element ref is stale or detached.', 'page elements', 'Discover a fresh ref before acting.'],
  'wrong-document': ['The target belongs to a different document.', 'page elements', 'Inspect the current page and use fresh refs.'],
  'ambiguous': ['More than one element matches.', 'page elements', 'Narrow the role, name, or frame; use an exact returned ref.'],
  'not-found': ['No matching target was found.', 'page elements', 'Inspect the page or wait for the target to appear.'],
  'hidden': ['The target is hidden.', 'page elements', 'Reveal the control before interacting.'],
  'obscured': ['Another element covers the target.', 'page snap', 'Inspect and dismiss the covering UI if appropriate.'],
  'moving': ['The target is still moving.', 'wait element', 'Wait for the page to settle, then inspect again.'],
  'disabled': ['The control is disabled.', 'element inspect', 'Check its required preconditions.'],
  'readonly': ['The control is read-only.', 'element inspect', 'Choose an editable control.'],
  'wrong-control': ['The target does not support this operation.', 'element inspect', 'Choose the command appropriate to its control type.'],
  'not-focused': ['No actionable element owns focus.', 'focus', 'Focus the intended ref before typing.'],
  'ambiguous-focus': ['Focus could not be identified uniquely.', 'focus', 'Focus the intended ref explicitly.'],
  'invalid-state': ['The requested wait state is unsupported.', 'help wait', 'Use a documented wait state.'],
  'invalid-selector': ['The CSS selector is invalid.', 'page elements', 'Prefer an exact discovered ref.'],
  'invalid-target': ['The target is invalid.', 'page elements', 'Use a discovered ref or supported locator.'],
  'timeout': ['The requested condition was not reached before the timeout.', 'page snap', 'Inspect the current state before deciding what to do next.'],
  'outcome-unknown': ['The connection ended or timed out after dispatch; the action outcome is unknown.', 'page snap', 'Verify the page state. Do not blindly repeat the action.'],
  'confirmation-invalid': ['The confirmation is invalid, expired, already used, or belongs to different arguments.', 'page snap', 'Reinspect the target and obtain a fresh confirmation.'],
  'verification-failed': ['The operation did not reach its expected state.', 'element inspect', 'Inspect the target before another action.'],
  'unsupported-frame-upload': ['File uploads currently require a top-frame target.', 'page elements --frame 0', 'Choose a supported top-frame file input.'],
  'unsupported-frame-capture': ['Element screenshots currently require a top-frame target.', 'screenshot', 'Use a viewport screenshot for iframe content.'],
  'unsupported-frame-drag': ['Trusted drag currently requires co-visible top-frame targets.', 'page elements --frame 0', 'Choose targets in the top frame.'],
  'screenshot-too-large': ['The screenshot exceeds the transfer limit.', 'screenshot', 'Capture the viewport or a smaller element.'],
  'injection-failed': ['Chrome could not inspect the requested frame.', 'page snap', 'Check page access and discover the current frames.'],
  'navigation-failed': ['Chrome could not navigate to the requested destination.', 'tabs info', 'Check the URL and current tab.'],
  'invalid-url': ['The destination must be a valid HTTP(S) URL.', 'help navigate', 'Supply a complete HTTP(S) URL.'],
  'usage-error': ['Invalid command arguments.', 'help', 'Consult focused command help.'],
};

export function browserError(code, details = null) {
  return Object.assign(new Error(errorInfo(code).message), { code, details });
}

export function errorInfo(code) {
  const entry = Object.hasOwn(ERRORS, code) ? ERRORS[code] : null;
  return {
    code: entry ? code : 'browser-command-failed',
    message: entry?.[0] || 'The browser command failed. Inspect diagnostics before continuing.',
    retryable: false,
    next: { command: entry?.[1] || 'doctor', instruction: entry?.[2] || 'Use status and inspect the current page.' },
  };
}
