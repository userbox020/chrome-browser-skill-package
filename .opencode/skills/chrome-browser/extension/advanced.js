import { debuggerManager } from './debugger.js';
import { dragCenters, elementCenter } from './page.js';
import { sameContext } from './context.js';

const MODIFIERS = { alt: 1, ctrl: 2, control: 2, meta: 4, command: 4, cmd: 4, shift: 8 };
const DEVICES = {
  pixel7: { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true },
  iphone14: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  ipad: { width: 810, height: 1080, deviceScaleFactor: 2, mobile: false },
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
};
const dialogs = new Map();
let dialogSequence = 0;

debuggerManager.onEvent((source, method, params) => {
  if (!Number.isInteger(source.tabId)) return;
  if (method === 'Page.javascriptDialogOpening') {
    dialogs.set(source.tabId, {
      kind: 'dialog',
      sequence: ++dialogSequence,
      type: String(params.type || ''),
      message: String(params.message || ''),
      url: String(params.url || ''),
      frameId: String(params.frameId || ''),
    });
  } else if (method === 'Page.javascriptDialogClosed') dialogs.delete(source.tabId);
});

export async function insertText(tabId, text) {
  await debuggerManager.send(tabId, 'Input.insertText', { text: String(text) });
  return { typed: true, length: String(text).length };
}

export async function evaluate(tabId, expression, expectedContext = null) {
  await debuggerManager.send(tabId, 'Runtime.enable');
  let context = null;
  let markerKey = null;
  if (expectedContext?.documentId) {
    markerKey = `__opencodeEval_${crypto.randomUUID().replaceAll('-', '')}`;
    const markerValue = crypto.randomUUID();
    await chrome.scripting.executeScript({
      target: { tabId, documentIds: [expectedContext.documentId] },
      world: 'MAIN',
      func: (key, value) => { window[key] = value; },
      args: [markerKey, markerValue],
    });
    for (const candidate of debuggerManager.contexts(tabId).filter(item => item.auxData?.isDefault === true)) {
      const probe = await debuggerManager.send(tabId, 'Runtime.evaluate', {
        ...(candidate.uniqueId ? { uniqueContextId: candidate.uniqueId } : { contextId: candidate.id }),
        expression: `window[${JSON.stringify(markerKey)}] === ${JSON.stringify(markerValue)}`,
        returnByValue: true,
        silent: true,
      }).catch(() => null);
      if (probe?.result?.value === true) { context = candidate; break; }
    }
    if (!context) throw Object.assign(new Error('Approved document execution context is no longer available'), { code: 'wrong-document' });
  }
  const contextSelector = context ? (context.uniqueId ? { uniqueContextId: context.uniqueId } : { contextId: context.id }) : {};
  let response;
  try {
    response = await debuggerManager.send(tabId, 'Runtime.evaluate', { ...contextSelector, expression, awaitPromise: true, returnByValue: true, userGesture: true });
  } finally {
    if (context && markerKey) await debuggerManager.send(tabId, 'Runtime.evaluate', { ...contextSelector, expression: `delete window[${JSON.stringify(markerKey)}]`, silent: true }).catch(() => {});
  }
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Page evaluation failed');
  }
  const result = response.result || {};
  if ('value' in result) return result.value;
  if (result.unserializableValue) return result.unserializableValue;
  return result.description ?? null;
}

export async function pressKey(tabId, key, modifiersText) {
  const modifiers = parseModifiers(modifiersText);
  const code = keyCode(key);
  const virtualKeyCode = virtualKey(key);
  const unmodifiedKey = key === 'Space' ? ' ' : key === 'NumpadEnter' ? 'Enter' : key;
  const normalizedKey = modifiers & 8 ? shiftedCharacter(unmodifiedKey) : unmodifiedKey;
  const text = (normalizedKey.length === 1 && !(modifiers & 7)) ? normalizedKey : undefined;
  const common = {
    key: normalizedKey,
    code,
    modifiers,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    ...(key === 'NumpadEnter' ? { location: 3, isKeypad: true } : {}),
  };
  let down = false;
  try {
    await debuggerManager.send(tabId, 'Input.dispatchKeyEvent', { ...common, type: 'rawKeyDown' });
    down = true;
    if (text) await debuggerManager.send(tabId, 'Input.dispatchKeyEvent', { ...common, type: 'char', text, unmodifiedText: unmodifiedKey });
  } finally {
    if (down) await debuggerManager.send(tabId, 'Input.dispatchKeyEvent', { ...common, type: 'keyUp' }).catch(() => {});
  }
  return { pressed: key, modifiers: modifiersText || '' };
}

export async function hover(tabId, selector) {
  const point = await elementCenter(tabId, selector);
  await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
  return { hovered: true, selector, x: point.x, y: point.y };
}

export async function drag(tabId, fromSelector, toSelector) {
  const points = await dragCenters(tabId, fromSelector, toSelector);
  await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...points.from, button: 'none' });
  await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...points.from, button: 'left', clickCount: 1 });
  for (let step = 1; step <= 8; step++) {
    const ratio = step / 8;
    await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: points.from.x + (points.to.x - points.from.x) * ratio,
      y: points.from.y + (points.to.y - points.from.y) * ratio,
      button: 'left',
    });
  }
  await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...points.to, button: 'left', clickCount: 1 });
  return { dragged: true, from: fromSelector, to: toSelector };
}

export async function captureConsole(tabId, milliseconds = 800) {
  const duration = Math.max(100, Math.min(Number(milliseconds) || 800, 5_000));
  const entries = [];
  const off = debuggerManager.onEvent((source, method, params) => {
    if (source.tabId !== tabId || method !== 'Runtime.consoleAPICalled') return;
    entries.push({
      level: params.type,
      timestamp: params.timestamp,
      text: (params.args || []).map(item => item.value !== undefined ? stringify(item.value) : item.description || '').join(' ').slice(0, 2_000),
    });
  });
  try {
    await debuggerManager.send(tabId, 'Runtime.enable');
    await new Promise(resolve => setTimeout(resolve, duration));
  } finally {
    off();
  }
  return { duration, entries };
}

export async function acceptDialog(tabId, promptText, confirmed = false, expectedContext = null) {
  await debuggerManager.send(tabId, 'Page.enable');
  await new Promise(resolve => setTimeout(resolve, 0));
  const context = dialogs.get(tabId);
  if (!context) throw Object.assign(new Error('No JavaScript dialog is currently open'), { code: 'not-found' });
  if (!confirmed) return { confirmationRequired: true, summary: `Accept ${context.type || 'JavaScript'} dialog`, approvalContext: context };
  if (!sameContext(context, expectedContext)) {
    return { confirmationRequired: true, summary: 'The JavaScript dialog changed and requires new approval', approvalContext: context };
  }
  await debuggerManager.send(tabId, 'Page.handleJavaScriptDialog', { accept: true, promptText: promptText || '' });
  dialogs.delete(tabId);
  return { accepted: true };
}

export async function dismissDialog(tabId) {
  await debuggerManager.send(tabId, 'Page.enable');
  await debuggerManager.send(tabId, 'Page.handleJavaScriptDialog', { accept: false });
  dialogs.delete(tabId);
  return { dismissed: true };
}

export async function emulate(tabId, device) {
  if (device === 'reset') {
    await debuggerManager.send(tabId, 'Emulation.clearDeviceMetricsOverride');
    return { reset: true };
  }
  const settings = DEVICES[device];
  if (!settings) throw new Error(`Unknown device: ${device}. Available: ${Object.keys(DEVICES).join(', ')}, reset`);
  await debuggerManager.send(tabId, 'Emulation.setDeviceMetricsOverride', {
    ...settings,
    screenWidth: settings.width,
    screenHeight: settings.height,
  });
  return { device, ...settings };
}

export async function setGeolocation(tabId, latitude, longitude) {
  if (String(latitude).toLowerCase() === 'reset') {
    await debuggerManager.send(tabId, 'Emulation.clearGeolocationOverride');
    return { reset: true };
  }
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Latitude and longitude must be numbers, or use "geo reset"');
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error('Geolocation is outside valid latitude/longitude bounds');
  await debuggerManager.send(tabId, 'Emulation.setGeolocationOverride', { latitude: lat, longitude: lng, accuracy: 10 });
  return { latitude: lat, longitude: lng, accuracy: 10 };
}

function parseModifiers(value) {
  if (!value) return 0;
  return String(value).split(',').reduce((mask, name) => {
    const modifier = MODIFIERS[name.trim().toLowerCase()];
    if (modifier == null) throw new Error(`Unknown modifier: ${name}`);
    return mask | modifier;
  }, 0);
}

function keyCode(key) {
  const map = {
    Enter: 'Enter', NumpadEnter: 'NumpadEnter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space', Space: 'Space',
  };
  if (map[key]) return map[key];
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  return ({ ';': 'Semicolon', '=': 'Equal', ',': 'Comma', '-': 'Minus', '.': 'Period', '/': 'Slash', '`': 'Backquote', '[': 'BracketLeft', '\\': 'Backslash', ']': 'BracketRight', "'": 'Quote' })[key] || key;
}

function virtualKey(key) {
  const map = {
    Enter: 13, NumpadEnter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32, Space: 32,
  };
  if (map[key]) return map[key];
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  return ({ ';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191, '`': 192, '[': 219, '\\': 220, ']': 221, "'": 222 })[key] || 0;
}

function shiftedCharacter(key) {
  if (/^[a-z]$/.test(key)) return key.toUpperCase();
  return ({ '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~' })[key] || key;
}

function stringify(value) {
  try { return typeof value === 'string' ? value : JSON.stringify(value); }
  catch { return String(value); }
}
