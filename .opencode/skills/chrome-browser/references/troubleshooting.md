# Troubleshooting and result contract

Start with `status --agent`, then `doctor --agent` for installation paths and recovery steps. These commands are read-only. A successful diagnostic command (`ok: true`) can still report `data.ready: false` or a bridge state other than `ready`.

| State/code | Recovery |
|---|---|
| `stopped` / `bridge-unavailable` | `server start --agent` |
| `dependencies-missing` | Run the exact `npm ci --prefix` command returned by doctor. |
| `port-in-use` | Identify the service; never terminate an unknown PID. |
| `bridge-outdated` | Stop its original terminal, then start the installed bridge. |
| `version-mismatch` / `extension-outdated` | Update/restart the bridge and reload the unpacked extension; pairing normally persists. |
| `extension-disconnected` | Check the popup: offline, pairing required, authentication mismatch, and version mismatch are distinct states. |
| `no-tab-selected` / `tab-closed` | List matching tabs and select the intended exact numeric ID. |
| `stale` / `wrong-document` | Discover fresh refs. |
| `ambiguous` | Inspect candidate refs, then narrow role/name/frame. |
| `hidden` / `obscured` / `disabled` | Inspect page state and resolve the prerequisite. |
| `timeout` | The requested condition was not reached; inspect current state. |
| `outcome-unknown` | A command was dispatched but no definitive reply arrived. Verify its effect before another action. |
| `confirmation-invalid` | Reinspect and request a fresh context-bound approval. |

## Output

- Default output and `--json` retain the existing CLI result shape.
- `--agent` emits one bounded JSON object on stdout for success, argument errors, browser errors, or confirmation requests.
- `schemaVersion: 1`; `command`; `ok`; `status`; and one of `data`, `error`, or `confirmation`.
- Errors include a controlled `code`, readable `message`, `retryable: false`, and a `next` hint. Arbitrary browser exception text is masked unless explicitly requested with `--include-sensitive`.
- `truncated: true` means the discovery or presentation budget omitted content. Narrow the query rather than interpreting omission as absence.
- Exit 0: command succeeded. Exit 1: error. Exit 2: user confirmation required.
- `help <group-or-command> --json` gives complete metadata without connecting to Chrome. Use it for large schemas instead of bounded agent output.

Normal commands can start a missing bridge automatically if dependencies are installed. They cannot install an extension or start the user's Chrome session. A temporary disconnect must not cause the agent to open another browser or silently select another tab.

For an update, make all related changes and run checks before requesting a single extension reload. Use the version/capability diagnostics to verify what is actually running.
