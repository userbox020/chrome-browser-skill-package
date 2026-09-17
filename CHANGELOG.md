# Changelog

## v2.4.0 — CLI-first OpenCode workflow

### Added
- Read-only `status` and `doctor` with bridge/extension versions, capabilities, installation paths, and recovery steps.
- Authenticated `server start`, `server stop`, and `server restart`, including Windows background startup.
- Opt-in `--agent` output: one bounded JSON envelope for success, error, or confirmation; explicit truncation and recovery hints.
- Tab search and element discovery filters for role, exact name, visibility, frame, and overall result limit.
- `element inspect` and reusable public refs in ambiguity diagnostics.
- Focused generated command help and setup, interaction, network, and troubleshooting references.
- Windows/Linux CI on Node 22/24, version/syntax checks, and clean Git-tree release archives with SHA-256 checksums.

### Fixed
- Shared popup/full-page connection state; Connected now requires bridge acknowledgement.
- Document-bound ref injection before execution and hidden/attached/detached CSS waits.
- Serialized WebMCP callbacks no longer depend on unavailable module closures.
- Product errors remain readable while page-supplied exception details remain redacted.
- Transport disconnects/timeouts report an unknown action outcome instead of encouraging blind retries.

### Verification
- 131 automated tests passed locally before release preparation.
- A fixed 20-element fixture reduced output from 8,732 to 2,483 bytes (72% smaller), preserving refs and states.
- Live checks in the existing Chrome session passed filtered DOM/AX discovery, filling, trusted clicks, waits, ambiguity handling, element inspection, stale-ref recovery, and Windows cold start/restart.

### Upgrade
1. Install dependencies with `npm ci --prefix .opencode/skills/chrome-browser` (`npm.cmd` on Windows PowerShell).
2. Stop a v2.3 bridge from its original terminal; it does not support the new managed shutdown endpoint. Then run `node .opencode/skills/chrome-browser/scripts/browser.mjs server start --agent`.
3. Reload the unpacked extension and restart OpenCode. Normal extension reloads preserve pairing; selected-tab state and refs may reset.
4. Run `doctor --agent`, select the intended tab, and discover fresh refs.

Existing CSS selector commands and `--json` output remain available. See the interaction reference for current frame/AX/upload/drag limitations.
