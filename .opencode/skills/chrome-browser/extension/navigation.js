const DEFAULT_TIMEOUT = 15_000;
const MAX_TIMEOUT = 20_000;

export async function readPageState(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: () => ({ url: location.href, readyState: document.readyState }),
  });
  const entry = results?.[0];
  return entry?.result ? { ...entry.result, documentKey: entry.documentId } : null;
}

export async function navigateAndWait(tabId, url, timeout, manager = null) {
  const parsed = httpUrl(url);
  const previous = await readPageState(tabId).catch(() => null);
  let loaderId = null;
  if (manager) {
    await manager.send(tabId, 'Page.enable');
    const navigation = await manager.send(tabId, 'Page.navigate', { url: parsed.href });
    if (navigation.errorText) throw error('navigation-failed', navigation.errorText);
    loaderId = navigation.loaderId || null;
  } else await chrome.tabs.update(tabId, { url: parsed.href });
  const sameDocument = previous && withoutHash(previous.url) === withoutHash(parsed.href) && previous.url !== parsed.href;
  return waitForLoad(tabId, 'domcontentloaded', timeout, { previousDocumentKey: previous?.documentKey, expectedUrl: parsed.href, expectedLoaderId: loaderId, manager, requireNewDocument: !sameDocument });
}

export async function reloadAndWait(tabId, timeout) {
  const previous = await readPageState(tabId).catch(() => null);
  await chrome.tabs.reload(tabId);
  const result = await waitForLoad(tabId, 'domcontentloaded', timeout, { previousDocumentKey: previous?.documentKey, requireNewDocument: true });
  return { ...result, reloaded: true };
}

export async function waitForLoad(tabId, state = 'domcontentloaded', timeout, options = {}) {
  const normalizedState = String(state || 'domcontentloaded').toLowerCase();
  if (!['domcontentloaded', 'complete'].includes(normalizedState)) throw error('invalid-state', `Unsupported load state: ${state}`);
  const duration = boundedTimeout(timeout);
  const deadline = Date.now() + duration;
  let last = null;
  while (Date.now() <= deadline) {
    try {
      let loaderMatches = false;
      if (options.expectedLoaderId && options.manager) {
        const before = await options.manager.send(tabId, 'Page.getFrameTree');
        if (before.frameTree?.frame?.loaderId !== options.expectedLoaderId) { await delay(100); continue; }
        last = await readPageState(tabId);
        const after = await options.manager.send(tabId, 'Page.getFrameTree');
        loaderMatches = after.frameTree?.frame?.loaderId === options.expectedLoaderId;
      } else last = await readPageState(tabId);
      const ready = normalizedState === 'complete' ? last.readyState === 'complete' : ['interactive', 'complete'].includes(last.readyState);
      const documentChanged = loaderMatches || !options.requireNewDocument || !options.previousDocumentKey || last.documentKey !== options.previousDocumentKey;
      const urlReached = loaderMatches || !options.expectedUrl || normalizeUrl(last.url) === normalizeUrl(options.expectedUrl);
      if (ready && documentChanged && urlReached) return { loaded: true, state: normalizedState, timeout: duration, ...last };
    } catch {}
    await delay(100);
  }
  throw error('timeout', `Timed out waiting for page load state: ${normalizedState}`, { timeout: duration, last });
}

export async function waitForUrl(tabId, pattern, timeout) {
  const duration = boundedTimeout(timeout);
  const deadline = Date.now() + duration;
  let last = null;
  while (Date.now() <= deadline) {
    try {
      last = await readPageState(tabId);
      if (wildcard(pattern, last.url)) return { matched: true, pattern, timeout: duration, ...last };
    } catch {}
    await delay(100);
  }
  throw error('timeout', `Timed out waiting for URL: ${pattern}`, { timeout: duration, lastUrl: last?.url || null });
}

export function httpUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw error('invalid-url', 'Only HTTP and HTTPS URLs are allowed');
  return parsed;
}

function boundedTimeout(value) {
  return Math.max(100, Math.min(Number(value) || DEFAULT_TIMEOUT, MAX_TIMEOUT));
}

function normalizeUrl(value) {
  try { return new URL(value).href; } catch { return String(value || ''); }
}

function withoutHash(value) {
  try { const url = new URL(value); url.hash = ''; return url.href; } catch { return String(value || '').split('#')[0]; }
}

function wildcard(pattern, value) {
  let source = '^';
  for (const character of String(pattern || '')) source += character === '*' ? '.*' : character === '?' ? '.' : character.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
  return new RegExp(`${source}$`, 'i').test(String(value || ''));
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function error(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}
