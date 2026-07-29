import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { getCommand } from '../extension/commands.js';
import { EXTENSION_ORIGIN } from '../extension/identity.js';
import { getOrCreatePairingSecret } from './pairing.mjs';
import {
  HOST,
  PORT,
  PROTOCOL_VERSION,
  SERVICE,
  commandFingerprint,
  removeServerState,
  writeServerState,
} from './protocol.mjs';
import { redactResult } from './redact.mjs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const COMMAND_TIMEOUT = 30_000;
const CHALLENGE_TTL = 5 * 60_000;
const HEARTBEAT_INTERVAL = 15_000;
const HANDSHAKE_TIMEOUT = 5_000;
const QUEUED_COMMAND_DEADLINE = 25_000;

export async function startServer(options = {}) {
  const host = options.host || HOST;
  const port = options.port ?? PORT;
  const token = options.token || randomBytes(32).toString('hex');
  const pairingSecret = options.pairingSecret || getOrCreatePairingSecret(options.pairingFile);
  const handshakeTimeout = options.handshakeTimeout ?? HANDSHAKE_TIMEOUT;
  const challenges = new Map();
  const pending = new Map();
  let extension = null;
  let extensionReady = false;
  let requestId = 0;
  let closing = false;
  let commandQueue = Promise.resolve();

  const enqueueCommand = operation => {
    const queued = commandQueue.then(operation, operation);
    commandQueue = queued.catch(() => {});
    return queued;
  };

  const httpServer = createServer(async (request, response) => {
    const receivedAt = Date.now();
    let includeSensitive = false;
    let clientDisconnected = false;
    request.on('aborted', () => { clientDisconnected = true; });
    response.on('close', () => { if (!response.writableEnded) clientDisconnected = true; });
    const clientActive = () => !clientDisconnected && !response.destroyed;
    try {
      if (request.method === 'GET' && request.url === '/health') {
        return sendJson(response, 200, {
          service: SERVICE,
          protocol: PROTOCOL_VERSION,
          extensionConnected: extension?.readyState === WebSocket.OPEN && extensionReady,
        });
      }

      if (request.method === 'OPTIONS' && request.url === '/pair') {
        if (request.headers.origin !== EXTENSION_ORIGIN) return sendJson(response, 403, { ok: false, error: 'Pairing is available only to the Chrome Browser Bridge extension' });
        setPairingCors(response);
        response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' });
        return response.end();
      }

      if (request.method === 'GET' && request.url === '/pair') {
        if (request.headers.origin !== EXTENSION_ORIGIN) return sendJson(response, 403, { ok: false, error: 'Pairing is available only to the Chrome Browser Bridge extension' });
        setPairingCors(response);
        return sendJson(response, 200, { url: `${EXTENSION_ORIGIN}/pair.html#${pairingSecret}` });
      }

      if (request.method !== 'POST' || request.url !== '/cmd') {
        return sendJson(response, 404, { ok: false, error: 'Not found' });
      }
      if (request.headers.origin) {
        return sendJson(response, 403, { ok: false, error: 'Browser-origin HTTP requests are not allowed' });
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        return sendJson(response, 401, { ok: false, error: 'Unauthorized' });
      }

      const body = await readJsonBody(request);
      includeSensitive = body?.includeSensitive === true;
      return await enqueueCommand(async () => {
        if (!clientActive()) return;
        if (Date.now() - receivedAt > QUEUED_COMMAND_DEADLINE) {
          return sendJson(response, 503, { ok: false, error: 'Command expired while waiting for an earlier browser operation' });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(response, 400, { ok: false, error: 'Command body must be a JSON object' });
        const definition = getCommand(body.cmd);
        if (!definition) return sendJson(response, 400, { ok: false, error: `Unknown command: ${body.cmd}` });
        if (!extension || extension.readyState !== WebSocket.OPEN || !extensionReady) {
          return sendJson(response, 503, { ok: false, error: 'Chrome Browser Bridge extension is not connected or has an incompatible protocol' });
        }

        if (body.args != null && (typeof body.args !== 'object' || Array.isArray(body.args))) {
          return sendJson(response, 400, { ok: false, error: 'Command args must be a JSON object' });
        }
        const args = body.args || {};
        const browserContext = definition.risk !== 'none' || body.confirm
          ? await forward(extension, pending, ++requestId, 'system.context', { shallow: body.cmd.startsWith('dialog.') })
          : null;
        if (!clientActive()) return;
        if (Date.now() - receivedAt > QUEUED_COMMAND_DEADLINE) {
          return sendJson(response, 503, { ok: false, error: 'Command expired during browser context validation' });
        }
        const fingerprint = commandFingerprint(body.cmd, { args, browserContext });
        const staticSummary = confirmationSummary(definition, args, browserContext);
        const approval = body.confirm ? consumeChallenge(challenges, body.confirm, fingerprint) : null;
        if (body.confirm && !approval) {
          return sendJson(response, 409, { ok: false, error: 'The confirmation challenge is invalid, expired, already used, or belongs to different arguments' });
        }
        if (staticSummary && !approval) {
          return sendJson(response, 409, createChallenge(challenges, fingerprint, staticSummary, null, browserContext, includeSensitive));
        }

        if (!clientActive() || Date.now() - receivedAt > QUEUED_COMMAND_DEADLINE) {
          return clientActive() ? sendJson(response, 503, { ok: false, error: 'Command expired before browser execution' }) : undefined;
        }
        const forwardedArgs = { ...args };
        if (body.cmd === 'request.send') {
          try { forwardedArgs.url = canonicalRequestUrl(args.url, browserContext?.url); } catch {}
        }
        if (definition.risk !== 'none') forwardedArgs.confirmed = Boolean(approval);
        if (approval?.approvalContext) forwardedArgs.approvalContext = approval.approvalContext;
        if (approval) forwardedArgs.expectedBrowserContext = browserContext;
        const result = await forward(extension, pending, ++requestId, body.cmd, forwardedArgs);
        if (result?.confirmationRequired) {
          return sendJson(response, 409, createChallenge(challenges, fingerprint, dynamicConfirmationSummary(definition, result.approvalContext), result.approvalContext || null, browserContext, includeSensitive, result.diagnostics));
        }
        return sendJson(response, 200, {
          ok: true,
          result: redactResult(body.cmd, result, body.includeSensitive === true),
        });
      });
    } catch (error) {
      const status = error.statusCode || 500;
      const rawDetails = error.details || null;
      const safe = includeSensitive ? { message: error.message || String(error), details: rawDetails } : redactResult('error', { message: error.message || String(error), details: rawDetails }, false);
      return sendJson(response, status, {
        ok: false,
        error: safe.message,
        code: error.code || 'bridge-error',
        details: safe.details || undefined,
      });
    }
  });

  const sockets = new WebSocketServer({
    server: httpServer,
    path: '/extension',
    maxPayload: 20 * 1024 * 1024,
    verifyClient(info, done) {
      done(info.origin === EXTENSION_ORIGIN, 403, 'Expected Chrome Browser Bridge extension origin');
    },
  });

  sockets.on('connection', socket => {
    if (extension?.readyState === WebSocket.OPEN) {
      socket.close(4002, 'An extension is already connected');
      return;
    }
    socket.isAlive = true;
    socket.handshake = null;
    socket.handshakeTimer = setTimeout(() => socket.close(4004, 'Authentication handshake timed out'), handshakeTimeout);
    socket.on('pong', () => { socket.isAlive = true; });

    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === 'hello') {
        if (!/^[a-f0-9]{64}$/i.test(message.clientNonce || '')) {
          socket.close(4004, 'Invalid authentication hello');
          return;
        }
        const serverNonce = randomBytes(32).toString('hex');
        socket.handshake = { clientNonce: message.clientNonce.toLowerCase(), serverNonce };
        socket.send(JSON.stringify({
          type: 'challenge',
          protocol: PROTOCOL_VERSION,
          clientNonce: socket.handshake.clientNonce,
          serverNonce,
          pairingUrl: `${EXTENSION_ORIGIN}/pair.html#${pairingSecret}`,
          proof: hmac(pairingSecret, `server:${socket.handshake.clientNonce}:${serverNonce}`),
        }));
        return;
      }
      if (message.type === 'ready') {
        const handshake = socket.handshake;
        const expected = handshake ? hmac(pairingSecret, `extension:${handshake.clientNonce}:${handshake.serverNonce}`) : '';
        if (message.protocol !== PROTOCOL_VERSION || !handshake || !safeHexEqual(message.proof, expected)) {
          socket.close(4003, `Protocol ${PROTOCOL_VERSION} required`);
          return;
        }
        if (extension?.readyState === WebSocket.OPEN && extension !== socket) {
          socket.close(4002, 'An extension is already connected');
          return;
        }
        clearTimeout(socket.handshakeTimer);
        extension = socket;
        extensionReady = true;
        return;
      }
      if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', time: Date.now() }));
        return;
      }
      if (!extensionReady || message.type !== 'result' || message.id == null) return;
      const operation = pending.get(message.id);
      if (!operation || operation.socket !== socket) return;
      pending.delete(message.id);
      clearTimeout(operation.timer);
      if (message.ok === false) operation.reject(Object.assign(new Error(message.error || 'Extension command failed'), {
        code: message.code || 'browser-command-failed',
        details: message.details || null,
      }));
      else operation.resolve(message.result);
    });

    socket.on('close', () => {
      clearTimeout(socket.handshakeTimer);
      rejectSocketOperations(pending, socket, 'Extension disconnected before responding');
      if (extension === socket) {
        extension = null;
        extensionReady = false;
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL);

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });

  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  writeServerState({ service: SERVICE, protocol: PROTOCOL_VERSION, host, port: actualPort, token, pid: process.pid, startedAt: new Date().toISOString() }, options.stateFile);

  const close = async () => {
    if (closing) return;
    closing = true;
    for (const operation of pending.values()) {
      clearTimeout(operation.timer);
      operation.reject(new Error('Bridge server stopped'));
    }
    pending.clear();
    clearInterval(heartbeat);
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => httpServer.close(resolve));
    removeServerState(token, options.stateFile);
  };

  return { host, port: actualPort, token, close, httpServer, sockets };
}

function forward(extension, pending, id, cmd, args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout after ${COMMAND_TIMEOUT / 1000}s: ${cmd}`));
    }, COMMAND_TIMEOUT);
    pending.set(id, { resolve, reject, timer, socket: extension });
    extension.send(JSON.stringify({ type: 'command', id, cmd, args }));
  });
}

function confirmationSummary(definition, args, browserContext) {
  if (definition.risk === 'always') return `Confirm ${definition.name} on tab ${browserContext?.tabId}: ${JSON.stringify(publicConfirmationArgs(definition.name, args))}`;
  if (definition.risk === 'unsafe-method' && !['GET', 'HEAD', 'OPTIONS'].includes(String(args.method || '').toUpperCase())) {
    let url = args.url;
    try { url = canonicalRequestUrl(args.url, browserContext?.url); } catch {}
    url = redactResult('challenge', { url }, false).url;
    return `Confirm ${String(args.method || '').toUpperCase()} request to ${url}`;
  }
  return null;
}

function dynamicConfirmationSummary(definition, context) {
  if (context?.kind === 'drag') return 'Confirm dragging between the resolved source and destination controls';
  if (context?.kind === 'upload') return 'Confirm uploading the selected local files to the resolved file input';
  if (context?.kind === 'dialog') {
    const type = ['alert', 'confirm', 'prompt', 'beforeunload'].includes(context.type) ? context.type : 'JavaScript';
    return `Confirm accepting the current ${type} dialog`;
  }
  if (context?.kind === 'webmcp') return 'Confirm invoking the resolved WebMCP tool';
  if (context?.version === 4) {
    if (context.input?.kind === 'press') return 'Confirm dispatching a submission key to the resolved focused control';
    if (context.form) return 'Confirm activating the resolved form submission control';
    if (context.anchor) return 'Confirm activating the resolved navigation control';
    return 'Confirm activating the resolved page control';
  }
  if (definition.name === 'intercept.start') return 'Confirm activating the resolved interception rule set';
  return `Confirm ${definition.name} on the selected tab`;
}

function publicConfirmationArgs(command, args) {
  const copy = structuredClone(args);
  const hide = key => {
    if (!(key in copy)) return;
    const value = typeof copy[key] === 'string' ? copy[key] : JSON.stringify(copy[key]);
    copy[key] = `[redacted:${value?.length || 0}]`;
  };
  if (command === 'cookies.set' || command === 'request.modify') hide('value');
  if (command === 'request.modify') hide('jsonKey');
  if (command === 'request.modify' && typeof copy.urlFilter === 'string') {
    copy.urlFilter = copy.urlFilter
      .replace(/([?&][^=&#?]+)=([^&#]*)/g, '$1=[redacted]')
      .replace(/([?&])([^=&#]+)(?=(&|#|$))/g, '$1[redacted]')
      .replace(/\/\/[^/@]+@/g, '//[redacted]@')
      .replace(/\/([A-Za-z0-9_+%=.-]{20,})(?=\/|[?#]|$)/g, (_, segment) => `/${segment.slice(0, 6)}..`)
      .replace(/#.*$/, '');
  }
  if (command === 'page.eval') hide('expression');
  if (command === 'dialog.accept') hide('text');
  if (command === 'upload') hide('files');
  return redactResult(command, copy, false);
}

function canonicalRequestUrl(value, baseValue) {
  const base = new URL(baseValue);
  base.username = '';
  base.password = '';
  return new URL(value, base).href;
}

function createChallenge(challenges, fingerprint, summary, approvalContext, browserContext, includeSensitive = false, diagnostics = null) {
  const challenge = randomBytes(12).toString('hex');
  challenges.set(challenge, { fingerprint: hash(fingerprint), expires: Date.now() + CHALLENGE_TTL, approvalContext });
  pruneChallenges(challenges);
  return {
    ok: false,
    confirmationRequired: true,
    challenge,
    summary,
    target: publicTarget(browserContext, includeSensitive),
    details: approvalContext ? redactResult('challenge', approvalContext, includeSensitive) : undefined,
    diagnostics: publicDiagnostics(diagnostics),
  };
}

function publicDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return undefined;
  const changedFields = Array.isArray(diagnostics.changedFields)
    ? diagnostics.changedFields.filter(value => typeof value === 'string' && /^[a-z][a-z0-9.[\]-]*$/i.test(value)).slice(0, 20)
    : undefined;
  return changedFields?.length ? { changedFields } : undefined;
}

function publicTarget(context, includeSensitive = false) {
  if (!context) return null;
  return redactResult('challenge-target', {
    tabId: context.tabId,
    title: context.title || '',
    url: context.url,
  }, includeSensitive);
}

function consumeChallenge(challenges, challenge, fingerprint) {
  if (!challenge) return null;
  const item = challenges.get(challenge);
  challenges.delete(challenge);
  return item && item.expires >= Date.now() && item.fingerprint === hash(fingerprint) ? item : null;
}

function rejectSocketOperations(pending, socket, message) {
  for (const [id, operation] of pending) {
    if (operation.socket !== socket) continue;
    pending.delete(id);
    clearTimeout(operation.timer);
    operation.reject(new Error(message));
  }
}

function pruneChallenges(challenges) {
  const now = Date.now();
  for (const [key, value] of challenges) if (value.expires < now) challenges.delete(key);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(secret, value) {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(value).digest('hex');
}

function safeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left || '') || !/^[a-f0-9]{64}$/i.test(right || '')) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function sendJson(response, status, value) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function setPairingCors(response) {
  response.setHeader('Access-Control-Allow-Origin', EXTENSION_ORIGIN);
  response.setHeader('Access-Control-Allow-Private-Network', 'true');
  response.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) body += chunk;
    });
    request.on('end', () => {
      if (tooLarge) {
        const error = new Error('Command body is too large');
        error.statusCode = 413;
        reject(error);
        return;
      }
      try { resolve(JSON.parse(body || '{}')); }
      catch {
        const error = new Error('Invalid JSON command body');
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on('error', reject);
  });
}
