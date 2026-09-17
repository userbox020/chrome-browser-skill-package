# Chrome Browser Skill for OpenCode

[![CI](https://github.com/userbox020/chrome-browser-skill-package/actions/workflows/ci.yml/badge.svg)](https://github.com/userbox020/chrome-browser-skill-package/actions/workflows/ci.yml)

This folder is a portable OpenCode project containing the `chrome-browser` skill.

Control a selected tab in your existing Chrome session through a local extension bridge. Version 2.4 adds a CLI workflow designed for OpenCode: status/doctor diagnostics, background lifecycle commands, bounded agent output, filtered discovery, and shared live pairing status. Existing CSS selectors and `--json` commands remain supported.

Requires **Node.js 22+** and **Chrome 125+**.

## Setup

Clone this repository or download the ZIP and checksum from [Releases](https://github.com/userbox020/chrome-browser-skill-package/releases). Extract the ZIP including its `.opencode` directory, then open a terminal in `chrome-browser-skill-package`.

1. Install runtime dependencies:

   ```powershell
   npm.cmd ci --prefix .opencode/skills/chrome-browser
   ```

2. Load `.opencode/skills/chrome-browser/extension` as an unpacked extension at `chrome://extensions`.
3. Restart OpenCode from this folder so it loads `opencode.json` and the skill.
4. Start the local bridge in the background:

   ```powershell
   node .opencode/skills/chrome-browser/scripts/browser.mjs server start --agent
   ```

5. Click the extension toolbar icon. It retrieves and displays the pairing URL directly from the running bridge; click `Pair now`. The toolbar badge changes to `ON` when connected.

The CLI fallback is `node .opencode/skills/chrome-browser/scripts/browser.mjs pair`, followed by opening the printed URL in Chrome.

On macOS/Linux use `npm ci` instead of `npm.cmd ci`. `server` without a subcommand remains available for foreground operation.

Pairing URLs and files under the operating system's `chrome-browser` runtime directory are local secrets and are not included in this package.

## Interaction

Start with `page elements [query]` and use the returned `@e<epoch>-<number>` refs for interaction. If a control is only present in Chrome's accessibility tree, use `page accessibility [query]` and its `@a<epoch>-<number>` refs. Re-discover refs after navigation, reload, tab reselection, or extension restart.

Run `node .opencode/skills/chrome-browser/scripts/browser.mjs help` for the generated command list. See `.opencode/skills/chrome-browser/SKILL.md` for interaction, confirmation, redaction, and network-capture guidance.

```powershell
node .opencode/skills/chrome-browser/scripts/browser.mjs doctor --agent
node .opencode/skills/chrome-browser/scripts/browser.mjs tabs list --query "Fiverr" --agent
node .opencode/skills/chrome-browser/scripts/browser.mjs help page elements --json
```

Select the intended numeric tab ID with `tabs use`, discover the target with `page elements --role ... --name ... --agent`, act using its exact returned ref, then verify the outcome. Agent mode preserves refs and states with bounded output and explicit truncation; it never auto-selects ambiguous tabs or confirms consequential actions.

## Development and updates

```powershell
npm.cmd run check --prefix .opencode/skills/chrome-browser
npm.cmd test --prefix .opencode/skills/chrome-browser
node .opencode/skills/chrome-browser/scripts/browser.mjs server restart --agent
```

After updating, reload the unpacked extension and restart OpenCode. `doctor` reports bridge/extension versions and installation paths. For detailed setup, frame/action limitations, and recovery, see the skill's [references](.opencode/skills/chrome-browser/references/).

CI checks Node 22/24 on Windows/Linux, then validates a clean install from a generated ZIP. See [CHANGELOG.md](CHANGELOG.md) for upgrade notes and [test/README.md](.opencode/skills/chrome-browser/test/README.md) for automated and live verification.

To package a committed release, run `npm run package:release --prefix .opencode/skills/chrome-browser -- --ref v2.4.0 --output dist/chrome-browser-skill-package-v2.4.0.zip`. The archive uses the exact Git tree and produces an adjacent `.sha256` checksum; installed dependencies and local runtime files are excluded.
