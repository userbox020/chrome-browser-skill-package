---
name: chrome-browser
description: Use ONLY when the user asks to inspect or control a live page already open in Chrome, capture main-frame/iframe/worker network traffic, perform authorized request or response interception, take a screenshot, or discover and invoke WebMCP tools. Do not use for ordinary web fetching, application code, or browser work the user did not explicitly request.
license: MIT
compatibility: opencode
metadata:
  runtime: node
  min-version: "22"
---

# Chrome Browser

Control the user's existing Chrome tabs through one local extension bridge. Basic page commands use extension APIs. Native input, load-bound navigation, accessibility refs, recursive protocol network capture, request/response interception, dialogs, and emulation attach `chrome.debugger` lazily to the selected tab and may show Chrome's debugging notification while active. Chrome 125 or newer is required.

## Entry Point

Run every command from the project root with:

```powershell
node .opencode/skills/chrome-browser/scripts/browser.mjs <command>
```

Use `help` for the complete generated command list.

## Required Workflow

1. Load `.opencode/skills/chrome-browser/extension` as an unpacked extension at `chrome://extensions`.
2. Start the bridge if it is not already running: `node .opencode/skills/chrome-browser/scripts/browser.mjs server`.
3. Pair once from the extension toolbar: it retrieves and displays the pairing URL directly from the running bridge; click `Pair now`. The CLI fallback is `node .opencode/skills/chrome-browser/scripts/browser.mjs pair` followed by opening the printed `chrome-extension://.../pair.html#...` URL. Treat that URL as a local secret. The toolbar badge reads `ON` when connected.
4. Run `tabs list`.
5. Select an exact numeric tab with `tabs use <tabId>`.
6. Run `page elements [query]` and interact through its `@e...` refs. Use `page accessibility [query]` when a target is only exposed through Chrome's accessibility tree, including closed shadow roots.
7. Run page, interaction, network, request, extraction, or WebMCP commands.
8. Run `intercept stop`, `request clear`, and `network stop` after protocol testing.

## Command Groups

| Group | Examples |
|---|---|
| Tabs and navigation | `tabs list`, `tabs use`, `tabs info`, `navigate`, `open`, `reload` |
| Page inspection | `page snap`, `page elements`, `page accessibility`, `page html`, `page eval`, `page inspect`, `page storage` |
| Interaction | `click`, `click-text`, `focus`, `fill`, `type-into`, `clear`, `select`, `check`, `upload`, `hover`, `drag`, `scroll-to` |
| Waits and capture | `wait element`, `wait url`, `wait load`, `screenshot`, `screenshot full`, `screenshot element` |
| Browser state | `cookies`, `console`, `dialog`, `performance`, `emulate`, `geo` |
| Network | `network start`, `network list`, `network summary`, `network detail`, `network body`, `network stop` |
| Named interception | `intercept rule set/list/remove`, `intercept start/status/stop` |
| Authorized request testing | `request modify`, `request clear`, `request send` |
| Extraction | `extract table`, `extract links`, `extract forms` |
| WebMCP | `webmcp tools`, `webmcp schema`, `webmcp call`, `webmcp forms`, `webmcp form` |

## Reliable Interaction

- Prefer `@e...` refs returned by `page snap` or `page elements`; they cross same-origin and cross-origin frames and traverse open shadow roots.
- Use `@a...` refs from `page accessibility` for controls hidden behind closed shadow roots or otherwise absent from DOM discovery. These refs use Chrome's accessibility and DOM protocol domains and require the debugger attachment.
- Refs contain a random document epoch, such as `@e12ab34cd-1` or `@a12ab34cd-1`, and are scoped to the selected tab and current document. Discover them again after navigation, reload, tab reselection, extension restart, or a stale-ref error.
- Use `page elements submit`, `page elements email`, or a similar query to narrow large pages before acting. Ambiguous selector and text targets fail with candidate details instead of choosing silently.
- Prefer `fill`, `select`, `check`, and `upload` over low-level typing. Use `focus` followed by `type`, or `type-into`, when real key events are required.
- Use `wait element <target> <state>`, `wait url <pattern>`, or `wait load` instead of fixed sleeps. Element states include `attached`, `detached`, `visible`, `hidden`, `enabled`, `disabled`, `editable`, `checked`, and `unchecked`.
- Use `screenshot element <ref> <path>` for a bounded target, `screenshot full <path>` for the full document, or `screenshot <path>` for the viewport. Very large PNGs fail explicitly before exceeding the local bridge's transfer limit; use an element or viewport capture instead.
- `drag` uses trusted pointer input and requires separate confirmation bound to both resolved targets. Both targets must currently be visible together in the top frame. Other ref-backed actions route into their owning frame.
- `upload` resolves the exact isolated-world file-input object and requires confirmation bound to that input and the exact local file arguments. Local paths are not written into the page DOM.
- Existing CSS selector arguments remain supported where a target argument accepts a ref.

## Safety

- Never use this skill on a page the user did not explicitly ask you to control.
- Never confirm a purchase, payment, transfer, account deletion, or other consequential action without separate explicit approval from the user.
- Request modification, unsafe HTTP replay, cookie mutation, arbitrary page evaluation, every WebMCP invocation, dialog acceptance, uploads, drags, submission keys, and detected form/checkout actions return a context-bound confirmation challenge. Do not rerun with `--confirm <challenge>` until the user explicitly approves that exact action and target.
- Approvals are bound to Chrome's opaque document ID. Dialog approvals additionally bind the exact dialog sequence/type/message; click, upload, and drag approvals revalidate their exact targets immediately before execution.
- Sensitive values are masked by default. Captured header values, body contents and JSON key names, rule digests, and credential-like URL components are hidden unless `--include-sensitive` is explicitly requested.
- `page html`, all `page eval` results, console text, and browser error strings are hidden by default because arbitrary page output can contain credentials. Use `--include-sensitive` only after explicit user need. Adding it to the initial command also exposes the exact unredacted confirmation details for user review.
- Prefer `network summary` before `network detail` or `network body`.
- Named interception definitions are stored in the Chrome profile. Their values are masked in CLI output unless `--include-sensitive` is explicitly requested.

## Recursive Network Scope

`network start` captures the selected tab's root target and recursively related cross-origin iframe and worker targets. Request IDs include a target/session prefix so identical CDP request IDs from different frames cannot collide. Captured metadata includes HTTP traffic, WebSocket handshakes and bounded frame history, EventSource messages, and WebTransport lifecycle events.

This is DevTools-protocol traffic, not raw packet capture. It does not include Chrome internals, extension traffic, DNS/TLS packets, traffic completed before capture starts, or unrelated tabs. Opening DevTools on the selected tab can detach this extension.

## Named Interception Rules

Store a reusable rule:

```powershell
node .opencode/skills/chrome-browser/scripts/browser.mjs intercept rule set checkout '{"match":{"urlPattern":"*://api.example.com/checkout*","methods":["POST"],"resourceTypes":["XHR","Fetch"]},"request":{"headers":{"set":[{"name":"X-Test","value":"enabled"}],"remove":["Authorization"]},"body":{"jsonSet":[{"path":"purchase.total","value":1}]}},"response":{"statusCode":201,"headers":{"set":[{"name":"X-Modified","value":"true"}]},"body":{"jsonSet":[{"path":"debug.modified","value":true}]}}}'
```

Review and activate it:

```powershell
node .opencode/skills/chrome-browser/scripts/browser.mjs intercept rule list checkout
node .opencode/skills/chrome-browser/scripts/browser.mjs intercept start checkout
node .opencode/skills/chrome-browser/scripts/browser.mjs intercept status
node .opencode/skills/chrome-browser/scripts/browser.mjs intercept stop
```

Rule fields:

| Field | Purpose |
|---|---|
| `match.urlPattern` | CDP wildcard pattern; defaults to `*` |
| `match.methods` | Optional uppercase-insensitive HTTP method list |
| `match.resourceTypes` | Optional CDP resource types such as `XHR`, `Fetch`, `Document` |
| `match.statusCodes` | Optional response-stage status list |
| `request.url`, `request.method` | Replace outbound URL or method |
| `request.headers`, `response.headers` | `{set:[{name,value}], remove:[name]}` |
| `request.body`, `response.body` | Exactly one of `text`, `base64`, or `jsonSet` |
| `request.block` | CDP failure reason such as `Aborted` or `BlockedByClient` |
| `request.fulfill` | Synthetic `{statusCode,statusText,headers,body}` response |
| `response.statusCode`, `response.statusText` | Replace response status |

Multiple rules are activated in the listed order; later rules win scalar and header conflicts. Activation requires a one-time confirmation bound to the selected tab, document, ordered names, and exact rule digest. Rules are loaded before `Fetch.enable`; paused traffic never waits for user input or extension storage.

Response body rewriting skips redirects, recognized streaming responses, HEAD, 204, 205, and 304 responses. Transformed bodies are limited to 5 MiB. WebSocket frames can be observed, but established frame payloads cannot be transparently rewritten through CDP Fetch interception.

## Useful Examples

```powershell
node .opencode/skills/chrome-browser/scripts/browser.mjs tabs list
node .opencode/skills/chrome-browser/scripts/browser.mjs tabs use 123
$elements = node .opencode/skills/chrome-browser/scripts/browser.mjs page elements search --json | ConvertFrom-Json
$ref = $elements.elements[0].ref
node .opencode/skills/chrome-browser/scripts/browser.mjs fill $ref "browser automation"
node .opencode/skills/chrome-browser/scripts/browser.mjs wait element $ref enabled
node .opencode/skills/chrome-browser/scripts/browser.mjs screenshot element $ref result.png
node .opencode/skills/chrome-browser/scripts/browser.mjs network start
node .opencode/skills/chrome-browser/scripts/browser.mjs network summary api
node .opencode/skills/chrome-browser/scripts/browser.mjs webmcp tools
```

After changing this skill or its extension, restart OpenCode and reload the unpacked extension.
