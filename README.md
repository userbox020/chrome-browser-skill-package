# Chrome Browser Skill for OpenCode

This folder is a portable OpenCode project containing the `chrome-browser` skill.

It controls a user-selected tab in an existing Chrome session. Version 2.3 adds document-epoch element refs across frames and open shadow roots, accessibility refs for closed-shadow controls, trusted input, exact-target uploads and drags, explicit waits, viewport/full-page/element screenshots, and extension-toolbar pairing. Existing CSS-selector commands remain supported.

## Setup

1. Install runtime dependencies:

   ```powershell
   npm install --prefix .opencode/skills/chrome-browser
   ```

2. Load `.opencode/skills/chrome-browser/extension` as an unpacked extension at `chrome://extensions`.
3. Restart OpenCode from this folder so it loads `opencode.json` and the skill.
4. Start the local bridge in a separate terminal:

   ```powershell
   node .opencode/skills/chrome-browser/scripts/browser.mjs server
   ```

5. Click the extension toolbar icon. It retrieves and displays the pairing URL directly from the running bridge; click `Pair now`. The toolbar badge changes to `ON` when connected.

The CLI fallback is `node .opencode/skills/chrome-browser/scripts/browser.mjs pair`, followed by opening the printed URL in Chrome.

Pairing URLs and files under the operating system's `chrome-browser` runtime directory are local secrets and are not included in this package.

## Interaction

Start with `page elements [query]` and use the returned `@e<epoch>-<number>` refs for interaction. If a control is only present in Chrome's accessibility tree, use `page accessibility [query]` and its `@a<epoch>-<number>` refs. Re-discover refs after navigation, reload, tab reselection, or extension restart.

Run `node .opencode/skills/chrome-browser/scripts/browser.mjs help` for the generated command list. See `.opencode/skills/chrome-browser/SKILL.md` for interaction, confirmation, redaction, and network-capture guidance.
