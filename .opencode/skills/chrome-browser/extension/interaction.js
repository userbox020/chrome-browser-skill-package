import { debuggerManager } from './debugger.js';
import { domController } from './dom-controller.js';
import { accessibilityController } from './accessibility.js';
import { sameContext } from './context.js';

export async function clickTarget(tabId, target, kind = 'css', confirmed = false, approvalContext = null) {
  if (accessibilityController.isRef(target)) return clickAccessibilityTarget(tabId, target, confirmed, approvalContext);
  const prepared = await domController.run(tabId, 'prepare-click', target, {
    approved: Boolean(confirmed),
    expectedContext: approvalContext,
  }, kind);
  if (prepared.confirmationRequired) return prepared;

  const baseline = confirmed ? approvalContext : prepared.approvalContext;
  const final = await domController.run(tabId, 'prepare-click', target, {
    approved: true,
    expectedContext: baseline,
  }, kind);
  if (final.confirmationRequired) return final;

  if (final.element.frameId !== 0) {
    const clicked = await domController.run(tabId, 'commit-click', target, { expectedContext: baseline }, kind);
    if (clicked.confirmationRequired) return clicked;
    return { ...clicked, consequential: final.consequential, approvalContext: undefined };
  }

  await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...final.point, button: 'none', buttons: 0 });
  const hovered = await domController.run(tabId, 'prepare-click', target, { approved: true, expectedContext: baseline }, kind);
  if (hovered.confirmationRequired) return hovered;
  let pressed = false;
  try {
    await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...hovered.point, button: 'left', buttons: 1, clickCount: 1 });
    pressed = true;
    await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...hovered.point, button: 'left', buttons: 0, clickCount: 1 });
    pressed = false;
  } finally {
    if (pressed) await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...hovered.point, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
  }
  return { clicked: true, trusted: true, consequential: hovered.consequential, element: hovered.element };
}

async function clickAccessibilityTarget(tabId, target, confirmed, approvalContext) {
  const prepared = await accessibilityController.prepareClick(tabId, target, Boolean(confirmed), approvalContext);
  if (prepared.confirmationRequired) return prepared;
  const baseline = confirmed ? approvalContext : prepared.approvalContext;
  const final = await accessibilityController.prepareClick(tabId, target, true, baseline);
  if (final.confirmationRequired) return final;
  await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...final.point, button: 'none', buttons: 0 });
  const hovered = await accessibilityController.prepareClick(tabId, target, true, baseline);
  if (hovered.confirmationRequired) return hovered;
  let pressed = false;
  try {
    await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...hovered.point, button: 'left', buttons: 1, clickCount: 1 });
    pressed = true;
    await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...hovered.point, button: 'left', buttons: 0, clickCount: 1 });
    pressed = false;
  } finally {
    if (pressed) await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...hovered.point, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
  }
  return { clicked: true, trusted: true, consequential: hovered.consequential, element: hovered.element };
}

export function fillTarget(tabId, target, value) {
  if (accessibilityController.isRef(target)) return accessibilityController.fill(tabId, target, value);
  return domController.run(tabId, 'fill', target, { value }, 'css');
}

export function clearTarget(tabId, target) {
  if (accessibilityController.isRef(target)) return accessibilityController.clearValue(tabId, target);
  return domController.run(tabId, 'clear', target, {}, 'css');
}

export function focusTarget(tabId, target) {
  if (accessibilityController.isRef(target)) return accessibilityController.focus(tabId, target);
  return domController.run(tabId, 'focus', target, {}, 'css');
}

export async function typeIntoTarget(tabId, target, text) {
  const focused = await focusTarget(tabId, target);
  await debuggerManager.send(tabId, 'Input.insertText', { text: String(text) });
  return { typed: true, length: String(text).length, element: focused.element };
}

export async function typeFocused(tabId, text) {
  const active = await accessibilityController.focused(tabId) || await domController.active(tabId);
  if (!active.element.state.editable) throw Object.assign(new Error('Focused element is not editable'), { code: 'wrong-control', details: { element: active.element } });
  await debuggerManager.send(tabId, 'Input.insertText', { text: String(text) });
  return { typed: true, length: String(text).length, element: active.element };
}

export async function preparePress(tabId, key, modifiers, confirmed, expectedContext) {
  const active = await accessibilityController.focused(tabId) || await domController.active(tabId);
  const approvalContext = { ...active.approvalContext, input: { kind: 'press', key, modifiers: modifiers || '' } };
  if (!confirmed || !sameContext(expectedContext, approvalContext)) {
    return {
      confirmationRequired: true,
      summary: confirmed ? 'The focused element changed and requires new approval' : `Press ${key} on focused ${active.element.role || active.element.tag}`,
      approvalContext,
    };
  }
  const final = await accessibilityController.focused(tabId) || await domController.active(tabId);
  const finalContext = { ...final.approvalContext, input: { kind: 'press', key, modifiers: modifiers || '' } };
  if (!sameContext(approvalContext, finalContext)) {
    return { confirmationRequired: true, summary: 'The focused element changed and requires new approval', approvalContext: finalContext };
  }
  return { prepared: true, element: final.element };
}

export function selectTarget(tabId, target, value) {
  if (accessibilityController.isRef(target)) return accessibilityController.select(tabId, target, value);
  return domController.run(tabId, 'select', target, { value }, 'css');
}

export function setCheckedTarget(tabId, target, checked) {
  if (accessibilityController.isRef(target)) return accessibilityController.setChecked(tabId, target, checked);
  return domController.run(tabId, 'check', target, { checked }, 'css');
}

export async function checkTarget(tabId, target, checked, confirmed = false, approvalContext = null) {
  if (accessibilityController.isRef(target)) {
    const before = await accessibilityController.describe(tabId, target);
    if (!checked && before.element.type === 'radio') throw Object.assign(new Error('Radio controls cannot be unchecked directly'), { code: 'wrong-control' });
    if (Boolean(before.element.state.checked) === checked) return { checked, changed: false, element: before.element };
    const clicked = await clickTarget(tabId, target, 'css', confirmed, approvalContext);
    if (clicked.confirmationRequired) return clicked;
    const after = await accessibilityController.describe(tabId, target);
    if (Boolean(after.element.state.checked) !== checked) throw Object.assign(new Error('Control did not reach the requested checked state'), { code: 'verification-failed' });
    return { checked, changed: true, element: after.element };
  }
  const before = await domController.run(tabId, 'describe', target, {}, 'css');
  if (!checked && before.element.type === 'radio') throw Object.assign(new Error('Radio controls cannot be unchecked directly'), { code: 'wrong-control' });
  if (Boolean(before.element.state.checked) === checked) return { checked, changed: false, element: before.element };
  const clicked = await clickTarget(tabId, target, 'css', confirmed, approvalContext);
  if (clicked.confirmationRequired) return clicked;
  const after = await domController.run(tabId, 'wait', target, { state: checked ? 'checked' : 'unchecked', timeout: 1_000 }, 'css');
  return { checked, changed: true, element: after.element };
}

export async function uploadTarget(tabId, target, files, confirmed = false, expectedContext = null) {
  let element;
  let targetContext;
  if (accessibilityController.isRef(target)) {
    const described = await accessibilityController.describe(tabId, target);
    if (described.element.type !== 'file') throw Object.assign(new Error('Element is not a file input'), { code: 'wrong-control' });
    element = described.element;
    targetContext = (await accessibilityController.context(tabId, target)).approvalContext;
  } else {
    const prepared = await domController.run(tabId, 'prepare-upload', target, {}, 'css');
    element = prepared.element;
    targetContext = (await domController.run(tabId, 'context', element.ref, {}, 'css')).approvalContext;
  }
  const approvalContext = { kind: 'upload', target: targetContext, fileCount: files.length };
  if (!confirmed || !sameContext(approvalContext, expectedContext)) {
    return { confirmationRequired: true, summary: confirmed ? 'The file input changed and requires new approval' : 'Upload local files to the resolved file input', approvalContext };
  }
  if (accessibilityController.isRef(target)) return accessibilityController.markUpload(tabId, target, files);
  await debuggerManager.send(tabId, 'Runtime.enable');
  if (element.frameId !== 0) throw Object.assign(new Error('File upload currently requires a top-frame input'), { code: 'unsupported-frame-upload' });
  const localRef = domController.target(tabId, element.ref).target.value;
  const expression = `globalThis.__opencodeChromeDomAgentV1?.nodes?.get(${JSON.stringify(localRef)})`;
  let contextId = null;
  for (const context of debuggerManager.contexts(tabId)) {
    const probe = await debuggerManager.send(tabId, 'Runtime.evaluate', {
      contextId: context.id,
      expression: `Boolean(${expression})`,
      returnByValue: true,
      silent: true,
    }).catch(() => null);
    if (probe?.result?.value === true) { contextId = context.id; break; }
  }
  if (contextId == null) throw Object.assign(new Error('Could not resolve the isolated element registry through CDP'), { code: 'injection-failed' });
  const objectGroup = 'opencode-upload';
  try {
    const finalContext = (await domController.run(tabId, 'context', element.ref, {}, 'css')).approvalContext;
    if (!sameContext(finalContext, expectedContext.target)) {
      return { confirmationRequired: true, summary: 'The file input changed and requires new approval', approvalContext: { kind: 'upload', target: finalContext, fileCount: files.length } };
    }
    const resolved = await debuggerManager.send(tabId, 'Runtime.evaluate', { contextId, expression, objectGroup, returnByValue: false });
    if (!resolved.result?.objectId) throw Object.assign(new Error('The file input ref became stale'), { code: 'stale' });
    await debuggerManager.send(tabId, 'DOM.setFileInputFiles', { objectId: resolved.result.objectId, files });
  } finally {
    await debuggerManager.send(tabId, 'Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
  }
  return { uploaded: true, fileCount: files.length, element };
}

export function scrollToTarget(tabId, target) {
  if (accessibilityController.isRef(target)) return accessibilityController.scroll(tabId, target);
  return domController.run(tabId, 'scroll', target, {}, 'css');
}

export async function hoverTarget(tabId, target) {
  if (accessibilityController.isRef(target)) {
    const prepared = await accessibilityController.actionableBox(tabId, target);
    await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...prepared.point, button: 'none' });
    return { hovered: true, trusted: true, ref: target, ...prepared.point };
  }
  const prepared = await domController.run(tabId, 'center', target, {}, 'css');
  if (prepared.element.frameId !== 0) return domController.run(tabId, 'hover-dom', target, {}, 'css');
  await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...prepared.point, button: 'none' });
  return { hovered: true, trusted: true, element: prepared.element, ...prepared.point };
}

export async function dragTargets(tabId, fromTarget, toTarget, confirmed = false, expectedContext = null) {
  const initialContext = {
    kind: 'drag',
    source: (await prepareDragTarget(tabId, fromTarget)).approvalContext,
    destination: (await prepareDragTarget(tabId, toTarget)).approvalContext,
  };
  if (!confirmed || !sameContext(initialContext, expectedContext)) {
    return { confirmationRequired: true, summary: confirmed ? 'The drag targets changed and require new approval' : 'Drag between two controls', approvalContext: initialContext };
  }
  await centerTarget(tabId, fromTarget, true);
  const to = await centerTarget(tabId, toTarget, true);
  const from = await centerTarget(tabId, fromTarget, false);
  if (from.element.frameId !== 0 || to.element.frameId !== 0) {
    throw Object.assign(new Error('Trusted drag currently requires both refs in the top frame'), { code: 'unsupported-frame-drag' });
  }
  const finalContext = {
    kind: 'drag',
    source: (await readTargetContext(tabId, fromTarget)).approvalContext,
    destination: (await readTargetContext(tabId, toTarget)).approvalContext,
  };
  if (!sameContext(finalContext, expectedContext)) {
    return { confirmationRequired: true, summary: 'The drag targets changed and require new approval', approvalContext: finalContext };
  }
  await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...from.point, button: 'none', buttons: 0 });
  const hoveredSource = await centerTarget(tabId, fromTarget, false);
  const hoveredSourceContext = (await readTargetContext(tabId, fromTarget)).approvalContext;
  if (!sameContext(hoveredSourceContext, expectedContext.source)) {
    return { confirmationRequired: true, summary: 'The drag source changed and requires new approval', approvalContext: { ...finalContext, source: hoveredSourceContext } };
  }
  let pressed = false;
  try {
    await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...hoveredSource.point, button: 'left', buttons: 1, clickCount: 1 });
    pressed = true;
    for (let step = 1; step <= 8; step++) {
      const ratio = step / 8;
      await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.point.x + (to.point.x - from.point.x) * ratio,
        y: from.point.y + (to.point.y - from.point.y) * ratio,
        button: 'left',
        buttons: 1,
      });
    }
    const hoveredDestination = await centerTarget(tabId, toTarget, false);
    const hoveredDestinationContext = (await readTargetContext(tabId, toTarget)).approvalContext;
    if (!sameContext(hoveredDestinationContext, expectedContext.destination)) {
      await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...hoveredSource.point, button: 'left', buttons: 0, clickCount: 1 });
      pressed = false;
      return { confirmationRequired: true, summary: 'The drag destination changed and requires new approval', approvalContext: { ...finalContext, destination: hoveredDestinationContext } };
    }
    await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...hoveredDestination.point, button: 'left', buttons: 0, clickCount: 1 });
    pressed = false;
  } finally {
    if (pressed) await debuggerManager.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...hoveredSource.point, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
  }
  return { dragged: true, trusted: true, from: from.element, to: to.element };
}

async function prepareDragTarget(tabId, target) {
  if (accessibilityController.isRef(target)) return accessibilityController.prepareClick(tabId, target, false, null);
  return domController.run(tabId, 'prepare-click', target, { approved: false }, 'css');
}

async function readTargetContext(tabId, target) {
  if (accessibilityController.isRef(target)) return accessibilityController.context(tabId, target);
  return domController.run(tabId, 'context', target, {}, 'css');
}

async function centerTarget(tabId, target, scroll = true) {
  if (!accessibilityController.isRef(target)) return domController.run(tabId, scroll ? 'center' : 'point', target, {}, 'css');
  return accessibilityController.actionableBox(tabId, target, scroll);
}

export function waitForElement(tabId, target, state, timeout) {
  if (accessibilityController.isRef(target)) return accessibilityController.wait(tabId, target, state, timeout);
  return domController.run(tabId, 'wait', target, { state, timeout }, 'css');
}
