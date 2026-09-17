export const COMMANDS = Object.freeze([
  command('tabs.list', ['tabs', 'list'], 'tabs list', 'List inspectable Chrome tabs.'),
  command('tabs.use', ['tabs', 'use'], 'tabs use <tabId>', 'Select the tab used by later commands.', [arg('tabId', 'number')]),
  command('tabs.info', ['tabs', 'info'], 'tabs info', 'Show the selected tab.'),

  command('page.snap', ['page', 'snap'], 'page snap', 'Show page title, URL, and visible text.'),
  command('page.elements', ['page', 'elements'], 'page elements [query]', 'List interactive elements with reusable refs across frames and open shadow roots.', [arg('query', 'string', true, true)]),
  command('page.accessibility', ['page', 'accessibility'], 'page accessibility [query]', 'List CDP accessibility nodes, including closed-shadow targets, with @a refs.', [arg('query', 'string', true, true)]),
  command('page.html', ['page', 'html'], 'page html [selector]', 'Get page or element HTML.', [arg('selector', 'string', true)]),
  command('page.eval', ['page', 'eval'], 'page eval <expression>', 'Evaluate JavaScript in the page main world.', [arg('expression', 'string', false, true)], 'always'),
  command('page.inspect', ['page', 'inspect'], 'page inspect', 'Inspect forms, hidden inputs, prices, and CSRF metadata.'),
  command('page.storage', ['page', 'storage'], 'page storage', 'Read local storage, session storage, and page-visible cookies.'),
  command('element.inspect', ['element', 'inspect'], 'element inspect <target>', 'Inspect one DOM/AX ref or CSS target without acting.', [arg('target')]),

  command('navigate', ['navigate'], 'navigate <url>', 'Navigate the selected tab.', [arg('url')]),
  command('open', ['open'], 'open <url>', 'Open and select a new tab.', [arg('url')]),
  command('reload', ['reload'], 'reload', 'Reload the selected tab.'),

  command('click', ['click'], 'click <target>', 'Click an element by ref or CSS selector.', [arg('selector')], 'dynamic'),
  command('click-text', ['click-text'], 'click-text <text>', 'Click one visible element by exact text.', [arg('text', 'string', false, true)], 'dynamic'),
  command('fill', ['fill'], 'fill <target> <value>', 'Fill an input or editable element by ref or CSS selector.', [arg('selector'), arg('value', 'string', false, true)]),
  command('focus', ['focus'], 'focus <target>', 'Focus an element by ref or CSS selector.', [arg('target')]),
  command('type-into', ['type-into'], 'type-into <target> <text>', 'Focus an element and insert native text.', [arg('target'), arg('text', 'string', false, true)]),
  command('clear', ['clear'], 'clear <target>', 'Clear an editable element and verify its value.', [arg('target')]),
  command('select', ['select'], 'select <target> <value-or-label>', 'Select one option by exact value or label.', [arg('target'), arg('value', 'string', false, true)]),
  command('check', ['check'], 'check <target>', 'Ensure a checkbox or radio is checked.', [arg('target')], 'dynamic'),
  command('uncheck', ['uncheck'], 'uncheck <target>', 'Ensure a checkbox is unchecked.', [arg('target')], 'dynamic'),
  command('upload', ['upload'], 'upload <target> <filesJson>', 'Set local files on a top-frame file input.', [arg('target'), arg('files', 'files')], 'dynamic'),
  command('type', ['type'], 'type <text>', 'Insert native text at the focused element.', [arg('text', 'string', false, true)]),
  command('press', ['press'], 'press <key> [modifiers]', 'Dispatch a native key press.', [arg('key'), arg('modifiers', 'string', true)], 'dynamic'),
  command('hover', ['hover'], 'hover <target>', 'Move the pointer over an element by ref or CSS selector.', [arg('selector')]),
  command('drag', ['drag'], 'drag <fromTarget> <toTarget>', 'Drag one top-frame element to another by ref or CSS selector.', [arg('fromSelector'), arg('toSelector')], 'dynamic'),
  command('scroll', ['scroll'], 'scroll [x] [y]', 'Scroll by CSS pixels.', [arg('x', 'number', true), arg('y', 'number', true)]),
  command('scroll-to', ['scroll-to'], 'scroll-to <target>', 'Scroll an element ref or CSS selector into view.', [arg('target')]),
  command('screenshot.full', ['screenshot', 'full'], 'screenshot full [file]', 'Capture the selected tab full page.', [arg('file', 'string', true, false, true)]),
  command('screenshot.element', ['screenshot', 'element'], 'screenshot element <target> [file]', 'Capture one top-frame element by ref or CSS selector.', [arg('target'), arg('file', 'string', true, false, true)]),
  command('screenshot', ['screenshot'], 'screenshot [file]', 'Capture the selected tab viewport.', [arg('file', 'string', true, false, true)]),

  command('wait.element', ['wait', 'element'], 'wait element <target> [state] [timeoutMs]', 'Wait for an element state: attached, detached, visible, hidden, enabled, disabled, editable, checked, or unchecked.', [arg('target'), arg('state', 'string', true), arg('timeout', 'number', true)]),
  command('wait.url', ['wait', 'url'], 'wait url <pattern> [timeoutMs]', 'Wait for the selected tab URL to match a wildcard pattern.', [arg('pattern'), arg('timeout', 'number', true)]),
  command('wait.load', ['wait', 'load'], 'wait load [domcontentloaded|complete] [timeoutMs]', 'Wait for the current document load state.', [arg('state', 'string', true), arg('timeout', 'number', true)]),

  command('network.start', ['network', 'start'], 'network start', 'Start selected-tab network capture.'),
  command('network.list', ['network', 'list'], 'network list [filter]', 'List captured requests.', [arg('filter', 'string', true, true)]),
  command('network.summary', ['network', 'summary'], 'network summary [filter]', 'Show a redacted request summary.', [arg('filter', 'string', true, true)]),
  command('network.detail', ['network', 'detail'], 'network detail <requestId>', 'Show request and response metadata.', [arg('requestId')]),
  command('network.body', ['network', 'body'], 'network body <requestId>', 'Read a captured response body.', [arg('requestId')]),
  command('network.clear', ['network', 'clear'], 'network clear', 'Clear captured requests.'),
  command('network.stop', ['network', 'stop'], 'network stop', 'Stop selected-tab network capture.'),

  command('intercept.rule.set', ['intercept', 'rule', 'set'], 'intercept rule set <name> <ruleJson>', 'Create or replace a persistent named interception rule.', [arg('name'), arg('rule', 'json', false, true)]),
  command('intercept.rule.list', ['intercept', 'rule', 'list'], 'intercept rule list [name]', 'List persistent named interception rules.', [arg('name', 'string', true)]),
  command('intercept.rule.remove', ['intercept', 'rule', 'remove'], 'intercept rule remove <name>', 'Remove an inactive named interception rule.', [arg('name')]),
  command('intercept.start', ['intercept', 'start'], 'intercept start <names>', 'Activate named request/response rules for the selected tab and child targets.', [arg('names', 'string', false, true)], 'dynamic'),
  command('intercept.status', ['intercept', 'status'], 'intercept status', 'Show active interception rules, targets, and diagnostics.'),
  command('intercept.stop', ['intercept', 'stop'], 'intercept stop', 'Stop named interception and release paused requests.'),

  command('request.modify', ['request', 'modify'], 'request modify <urlFilter> <jsonKey> <value>', 'Modify matching JSON request bodies.', [arg('urlFilter'), arg('jsonKey'), arg('value', 'auto', false, true)], 'always'),
  command('request.clear', ['request', 'clear'], 'request clear', 'Clear request modifiers.'),
  command('request.send', ['request', 'send'], 'request send <method> <url> [body] [headersJson]', 'Send a request from the selected page.', [arg('method'), arg('url'), arg('body', 'auto', true), arg('headers', 'json', true)], 'unsafe-method'),

  command('extract.table', ['extract', 'table'], 'extract table <selector>', 'Extract a table as structured JSON.', [arg('selector')]),
  command('extract.links', ['extract', 'links'], 'extract links [scope]', 'Extract links as structured JSON.', [arg('scope', 'string', true)]),
  command('extract.forms', ['extract', 'forms'], 'extract forms [scope]', 'Extract ordinary forms as structured JSON.', [arg('scope', 'string', true)]),

  command('cookies.list', ['cookies', 'list'], 'cookies list', 'List cookies for the selected page.'),
  command('cookies.set', ['cookies', 'set'], 'cookies set <name> <value> [domain]', 'Set a cookie for the selected page.', [arg('name'), arg('value'), arg('domain', 'string', true)], 'always'),
  command('cookies.clear', ['cookies', 'clear'], 'cookies clear [name]', 'Clear matching selected-page cookies.', [arg('name', 'string', true)], 'always'),
  command('console', ['console'], 'console [milliseconds]', 'Capture console messages for a short interval.', [arg('milliseconds', 'number', true)]),
  command('dialog.accept', ['dialog', 'accept'], 'dialog accept [text]', 'Accept the current JavaScript dialog.', [arg('text', 'string', true, true)], 'dynamic'),
  command('dialog.dismiss', ['dialog', 'dismiss'], 'dialog dismiss', 'Dismiss the current JavaScript dialog.'),
  command('performance', ['performance'], 'performance', 'Read navigation and paint timing.'),
  command('emulate', ['emulate'], 'emulate <device|reset>', 'Apply or reset device emulation.', [arg('device')]),
  command('geo', ['geo'], 'geo <latitude> <longitude> | geo reset', 'Set or clear geolocation override.', [arg('latitude'), arg('longitude', 'string', true)]),

  command('webmcp.tools', ['webmcp', 'tools'], 'webmcp tools', 'List WebMCP tools exposed by the page.'),
  command('webmcp.schema', ['webmcp', 'schema'], 'webmcp schema <toolName>', 'Show one WebMCP tool schema.', [arg('toolName')]),
  command('webmcp.call', ['webmcp', 'call'], 'webmcp call <toolName> [inputJson]', 'Invoke a WebMCP tool.', [arg('toolName'), arg('input', 'json', true, true)], 'dynamic'),
  command('webmcp.forms', ['webmcp', 'forms'], 'webmcp forms', 'List declarative WebMCP forms.'),
  command('webmcp.form', ['webmcp', 'form'], 'webmcp form <toolName>', 'Inspect one declarative WebMCP form.', [arg('toolName')]),
]);

const discoveryOptions = Object.freeze({ role: 'string', name: 'string', visible: 'boolean', 'include-hidden': 'boolean', frame: 'integer', limit: 'integer' });
export const COMMAND_OPTIONS = Object.freeze({
  'tabs.list': Object.freeze({ query: 'string', limit: 'integer' }),
  'page.elements': discoveryOptions,
  'page.snap': discoveryOptions,
  'page.accessibility': Object.freeze({ role: 'string', name: 'string', limit: 'integer' }),
});

export const LOCAL_COMMANDS = Object.freeze([
  command('status', ['status'], 'status', 'Read bridge, extension, versions, and selected-tab status without starting anything.'),
  command('doctor', ['doctor'], 'doctor', 'Diagnose installation and connection problems with exact next steps.'),
  command('server', ['server'], 'server', 'Run the bridge in the foreground.'),
  command('server.start', ['server', 'start'], 'server start', 'Start the bridge in the background, or report the existing instance.'),
  command('server.stop', ['server', 'stop'], 'server stop', 'Authenticate, clean up browser sessions, and stop the bridge.'),
  command('server.restart', ['server', 'restart'], 'server restart', 'Gracefully stop this bridge and start the installed version.'),
  command('pair', ['pair'], 'pair', 'Print a secret pairing URL as a fallback to the extension popup.'),
]);

function command(name, path, usage, description, args = [], risk = 'none') {
  return Object.freeze({ name, path: Object.freeze(path), usage, description, args: Object.freeze(args), risk });
}

function arg(name, type = 'string', optional = false, rest = false, local = false) {
  return Object.freeze({ name, type, optional, rest, local });
}

export function getCommand(name) {
  return COMMANDS.find(item => item.name === name);
}

export function matchCommand(tokens) {
  return [...COMMANDS]
    .sort((a, b) => b.path.length - a.path.length)
    .find(item => item.path.every((part, index) => tokens[index] === part));
}
