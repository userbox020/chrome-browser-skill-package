import { debuggerManager } from './debugger.js';
import { domController } from './dom-controller.js';
import { accessibilityController } from './accessibility.js';

const MAX_SCREENSHOT_BASE64 = 14 * 1024 * 1024;

export async function captureScreenshot(tabId, mode = 'viewport', target = null) {
  await debuggerManager.send(tabId, 'Page.enable');
  const metrics = await debuggerManager.send(tabId, 'Page.getLayoutMetrics');
  let viewport = metrics.cssVisualViewport || metrics.visualViewport || {};
  const content = metrics.cssContentSize || metrics.contentSize || {};
  let clip;
  if (mode === 'full') {
    clip = { x: Number(content.x || 0), y: Number(content.y || 0), width: Number(content.width || 0), height: Number(content.height || 0), scale: 1 };
  } else if (mode === 'element') {
    let element;
    if (accessibilityController.isRef(target)) {
      await accessibilityController.scroll(tabId, target);
      element = { ...(await accessibilityController.box(tabId, target)), element: { frameId: 0 } };
    } else element = await domController.run(tabId, 'capture-geometry', target, {}, 'css');
    if (element.element.frameId !== 0) throw Object.assign(new Error('Element screenshots currently require a top-frame ref'), { code: 'unsupported-frame-capture' });
    const currentMetrics = await debuggerManager.send(tabId, 'Page.getLayoutMetrics');
    viewport = currentMetrics.cssVisualViewport || currentMetrics.visualViewport || viewport;
    clip = {
      x: element.bounds.x + Number(viewport.pageX || 0),
      y: element.bounds.y + Number(viewport.pageY || 0),
      width: element.bounds.width,
      height: element.bounds.height,
      scale: 1,
    };
  }
  if (clip && (!(clip.width > 0) || !(clip.height > 0))) throw Object.assign(new Error('Screenshot clip has no visible area'), { code: 'hidden' });
  const captured = await debuggerManager.send(tabId, 'Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: mode !== 'viewport',
    ...(clip ? { clip } : {}),
  });
  if (!captured.data) throw new Error('Chrome returned an empty screenshot');
  if (captured.data.length > MAX_SCREENSHOT_BASE64) throw Object.assign(new Error('Screenshot exceeds the bridge transfer limit; capture a smaller element or viewport'), { code: 'screenshot-too-large' });
  const ratio = await debuggerManager.send(tabId, 'Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true }).catch(() => null);
  return {
    dataUrl: `data:image/png;base64,${captured.data}`,
    mode,
    width: Math.round(clip?.width || viewport.clientWidth || 0),
    height: Math.round(clip?.height || viewport.clientHeight || 0),
    devicePixelRatio: Number(ratio?.result?.value || 1),
  };
}
