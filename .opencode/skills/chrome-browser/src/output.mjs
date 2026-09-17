import { errorInfo } from '../extension/errors.js';

export function agentEnvelope(command, payload) {
  const confirmation = payload.confirmationRequired === true;
  if (!payload.ok && !confirmation) {
    const info = errorInfo(payload.code || payload.error?.code);
    const details = bound(payload.details || null);
    return { schemaVersion: 1, command, ok: false, status: 'error', error: { code: info.code, message: typeof payload.error === 'string' ? payload.error : info.message, retryable: false, details: details.value }, truncated: details.truncated, next: payload.next || info.next };
  }
  const { value, truncated } = bound(confirmation ? payload.details : compact(command, payload.result));
  if (confirmation) return {
    schemaVersion: 1, command, ok: false, status: 'confirmation-required',
    confirmation: { challenge: payload.challenge, summary: payload.summary, target: payload.target, details: value, diagnostics: payload.diagnostics },
    truncated,
    next: { instruction: 'Ask the user to approve this exact action. Replay identical arguments with --confirm only after approval.' },
  };
  return { schemaVersion: 1, command, ok: true, status: 'success', data: value, truncated: truncated || Boolean(payload.result?.truncated), ...(truncated ? { next: { instruction: 'Narrow the query or use a smaller limit to inspect omitted results.' } } : {}) };
}

function compact(command, result) {
  if (!result || typeof result !== 'object') return result;
  if (['page.snap', 'page.elements', 'page.accessibility'].includes(command)) {
    const { elements = [], frames = [], ...rest } = result;
    return { ...rest, elements: elements.map(compactElement), ...(frames.length ? { frames: frames.filter(frame => frame.elementCount > 0).map(({ frameId, documentId, url, elementCount }) => ({ frameId, documentId, url, elementCount })), emptyFrameCount: frames.filter(frame => !frame.elementCount).length } : {}) };
  }
  if (result.element && command !== 'element.inspect') return { ...result, element: compactElement(result.element) };
  return result;
}

function compactElement(element) {
  return { ref: element.ref, role: element.role || element.tag, name: element.name, ...(element.frameId != null ? { frameId: element.frameId } : {}), state: element.state };
}

// Bound arbitrary inspection output as well as discovery; indicate all omissions.
function bound(input) {
  let budget = 12_000;
  let truncated = false;
  const walk = (value, depth = 0) => {
    if (budget <= 0 || depth > 12) { truncated = true; return '[omitted]'; }
    if (typeof value === 'string') {
      const limit = Math.max(0, Math.min(2_000, budget));
      if (value.length > limit) truncated = true;
      budget -= Math.min(value.length, limit);
      return value.length > limit ? `${value.slice(0, limit)}…` : value;
    }
    if (Array.isArray(value)) {
      const output = [];
      for (const item of value) {
        if (output.length >= 50 || budget <= 0) { truncated = true; break; }
        budget -= 2;
        output.push(walk(item, depth + 1));
      }
      return output;
    }
    if (value && typeof value === 'object') {
      const output = {};
      for (const [key, child] of Object.entries(value)) {
        if (budget <= 0 || Object.keys(output).length >= 80) { truncated = true; break; }
        budget -= key.length + 4;
        Object.defineProperty(output, key, { value: walk(child, depth + 1), enumerable: true });
      }
      return output;
    }
    budget -= 8;
    return value;
  };
  return { value: walk(input), truncated };
}
