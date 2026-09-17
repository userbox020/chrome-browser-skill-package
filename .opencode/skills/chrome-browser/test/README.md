# Verification

Install the locked `ws` dependency with `npm ci` in the skill directory, then run `npm run check` and `npm test`. The check command validates package/lockfile/extension versions and JavaScript syntax. Tests use Node's test runner, fake Chrome protocol boundaries, and a separate VM for serialized callbacks. They do not launch another browser or operate on real accounts.

GitHub CI runs these checks on Windows/Linux with Node 22/24. A packaging job builds a ZIP from the tested Git tree and repeats installation/checks/tests from that archive. Release packaging reads committed Git content, not untracked workspace files.

The suite covers existing confirmation/redaction/network behavior as well as:

- CLI subprocess output and exit codes, focused help, literal option values.
- Authenticated status/shutdown, queued-work shutdown refusal, HTTP deadlines and disconnects.
- Version/capability reporting and extension acknowledgement before Connected.
- Shared popup/full-page state rendering, one-click pairing, mismatch recovery states.
- Discovery filters, overall result limits, reusable ambiguity refs, hidden/attached/detached waits.
- Document-bound injection and stale refs.
- Serialized WebMCP invocation without module closures.
- A 20-element output-size fixture (bytes, not a model-specific token count).

## Opt-in live Chrome fixture

With the bridge and unpacked extension running, start this in another terminal:

```powershell
node test/fixtures/server.mjs
```

Ask permission to open `http://127.0.0.1:18089/` in the user's existing Chrome session before testing. The page has no account data or external requests. Stop the fixture server after testing; close the fixture tab manually.

Using `node scripts/browser.mjs` as the entry point:

1. `open http://127.0.0.1:18089/ --agent`
2. `page elements --role textbox --name Search --agent` → one exact ref.
3. `fill <returned-ref> "OpenCode fixture check" --agent` → verified replacement.
4. Discover `Reveal details`, click its ref, then `wait element #details visible 1000 --agent` → trusted click plus visible result.
5. `wait element #hidden-control hidden 1000 --agent` → succeeds.
6. `click-text "Duplicate action" --agent` → ambiguous, no activation, reusable public candidate refs.
7. Inspect a candidate with `element inspect <ref> --agent`.
8. `page accessibility --role textbox --name Search --agent` → AX ref.
9. Reload; inspect an old DOM ref → stale error with fresh-discovery guidance.
10. `server restart --agent`, then `status --agent` after reconnection → matching versions and ready. Cold start should also return promptly on Windows.

Syntax checks and Node mocks cannot establish Chrome layout or actual extension installation. Record live results separately; request one consolidated extension reload after code changes are complete.
