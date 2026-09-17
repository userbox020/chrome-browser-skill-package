# Interaction reference

All commands operate on the explicitly selected existing tab. `tabs use` also activates the tab/window. Do not infer that a browser's active tab is already selected by the bridge.

## Discovery

- `page snap`: page text, refs, and frame summary.
- `page elements [query]`: interactive DOM elements across accessible frames and open shadow roots. Query is a case-insensitive substring of role/name/text.
- `--role <role>`: exact case-insensitive role; `--name <name>`: exact accessible name.
- `--visible` filters out hidden elements; `--include-hidden` overrides agent-mode visibility filtering. Visibility does not imply enabled, uncovered, or in-viewport.
- `--frame <id>` limits injection to one frame; `--limit <1..300>` caps the overall returned list, not a separate full quota for every frame.
- `page accessibility [query]`: root-target CDP AX discovery, including some closed-shadow controls. Supports `--role`, `--name`, and `--limit`.
- `element inspect <target>`: inspect a DOM/AX ref or CSS target; DOM selects include bounded option labels/states. Input values are not returned.

Always inspect `total`, `returned`, and `truncated`. A limited list does not establish uniqueness among all matches. Ref identity is tab/document scoped; DOM ref-backed actions target Chrome's opaque document ID before executing. Ambiguity errors provide public candidate refs you can inspect.

## Actions

| Command | Use |
|---|---|
| `click <target>` / `click-text <exact-text>` | Resolve uniquely, check actionability and confirmation context, then activate. |
| `fill <target> <value>` / `clear <target>` | Replace editable content; use for normal form fields. |
| `focus <target>` | Focus a specific control. |
| `type-into <target> <text>` / `type <text>` | CDP text insertion into a target or the focused control. Text insertion is not a sequence of individual key presses. |
| `press <key> [modifiers]` | Native key input; modifiers are comma-separated (`ctrl,shift`). Enter/Space are confirmation-gated. |
| `select <target> <value-or-label>` | Select one exact option. |
| `check <target>` / `uncheck <target>` | Reach the requested checkbox/radio state. Radios cannot be directly unchecked. |
| `hover <target>` / `scroll-to <target>` | Pointer movement or scroll into view. |
| `upload <target> <filesJson>` | Confirmation-bound local files; supported top-frame file input only. |
| `drag <source> <destination>` | Confirmation-bound trusted drag between co-visible top-frame targets. |

Top-frame clicks use trusted input with post-hover validation. Subframe clicks and hovers use frame-local DOM fallback and return `trusted: false`. AX actions are root-target scoped. File input object resolution and AX availability can vary by page; report unsupported cases rather than claiming universal frame/shadow support.

## Waits and captures

`wait element <target> [state] [timeoutMs]` supports `attached`, `detached`, `visible`, `hidden`, `enabled`, `disabled`, `editable`, `checked`, and `unchecked`. Hidden includes absent/detached targets; attached can include hidden controls. A stale ref can establish disappearance but cannot follow a replacement node—use fresh discovery for the replacement.

`wait url <pattern>` accepts `*`/`?` wildcards. `wait load [domcontentloaded|complete]` observes readiness; it does not guarantee an application finished fetching data. Choose a page-specific condition to establish completion. `navigate` tracks its initiated loader for redirects.

`screenshot [file]`, `screenshot full [file]`, and `screenshot element <target> [file]` save local PNG files. Element screenshots currently require a top-frame target. Very large captures fail before exceeding the transfer limit; narrow the region. Screenshots are images of the page and may contain sensitive information.

Use `--` before literal values that look like options. Preserve quoted strings and JSON arrays according to the current shell. `help <command> --json` returns generated syntax, argument types, options, and risk classification.
