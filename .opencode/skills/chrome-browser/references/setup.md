# Setup and lifecycle

Requirements: Node.js 22+, Chrome 125+, and the user's existing Chrome profile.

From the cloned repository root:

```powershell
npm.cmd ci --prefix .opencode/skills/chrome-browser
node .opencode/skills/chrome-browser/scripts/browser.mjs server start --agent
```

On macOS/Linux use `npm ci` instead of `npm.cmd ci`. Paths containing spaces must be quoted.

Load `.opencode/skills/chrome-browser/extension` using **Load unpacked** at `chrome://extensions` (Developer mode enabled). Pin the extension, open its popup, and click **Pair now** when prompted. The pairing URL arrives from the running local bridge over the extension WebSocket. The popup and full page share status and a Retry button. `ON` means the server has acknowledged authentication.

Pairing is stored in `chrome.storage.local`; normal extension reloads preserve it. Removing/reinstalling the extension or using a different Chrome profile may require pairing again. Never claim a reload necessarily erased pairing based on a disconnected state alone.

The CLI fallback `pair` prints a secret extension URL. Open it locally; never put it in source code, logs, commits, or screenshots you intend to share. Runtime authentication files stay in the operating system's `chrome-browser` runtime directory.

## Management commands

| Command | Effect |
|---|---|
| `status --agent` | Read-only bridge/version/selection overview; never starts a server. |
| `doctor --agent` | Read-only Node/dependency/path/connection checks and next steps. |
| `server start --agent` | Start detached or report the existing bridge. |
| `server` | Run foreground for terminal-managed sessions. |
| `server stop --agent` | Authenticated cleanup and shutdown; refuses while browser commands are active. |
| `server restart --agent` | Cleanly stop and start the installed version. |

Management never kills a process based only on its PID or port. Older bridges without the management capability must be stopped in their original terminal. Missing dependencies are reported rather than installed automatically.

After updating: finish active browser work, restart the bridge, reload the extension, then run `doctor`. Bridge and extension should report the installed version. Rediscover refs and reselect the intended tab. Restart OpenCode after changing the skill instructions.

## Installation in another OpenCode project

Copy the complete `chrome-browser` folder into that project's `.opencode/skills/`, install its dependencies, and load its extension directory. Alternatively register the containing skills directory with OpenCode's `skills.paths`. Use the loaded skill location to find the CLI; do not assume the shell's current project is the installation directory. The bridge uses one loopback port, so avoid running competing installations simultaneously.
