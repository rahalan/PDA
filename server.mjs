import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { AgentRunner, LEDGER_RECORDS_PER_TURN } from './app/agent.mjs';
import { TOOLS, Governance } from './app/governance.mjs';
import { DEPLOYMENT_SETTINGS } from './app/deployment-settings.mjs';
import { Store } from './app/storage.mjs';

const HOST = '127.0.0.1';
const PORT = 8110;
const CAPABILITY_COOKIE = 'cg_operator_capability';
const MAX_JSON_BYTES = 64 * 1024;
const PROJECT_ROOT = process.cwd();
const STATE_DIR = resolveStateDir();

const STATIC_FILES = new Map([
  ['/styles.css', path.join(PROJECT_ROOT, 'public', 'styles.css')],
  ['/common.js', path.join(PROJECT_ROOT, 'public', 'common.js')],
  ['/demo-stories.js', path.join(PROJECT_ROOT, 'public', 'demo-stories.js')],
  ['/chat.js', path.join(PROJECT_ROOT, 'public', 'chat.js')],
  ['/admin.js', path.join(PROJECT_ROOT, 'public', 'admin.js')],
  ['/compliance.js', path.join(PROJECT_ROOT, 'public', 'compliance.js')],
]);

const HTML_FILES = new Map([
  ['/', path.join(PROJECT_ROOT, 'public', 'index.html')],
  ['/chat', path.join(PROJECT_ROOT, 'public', 'index.html')],
  ['/chat.html', path.join(PROJECT_ROOT, 'public', 'index.html')],
  ['/index.html', path.join(PROJECT_ROOT, 'public', 'index.html')],
  ['/admin', path.join(PROJECT_ROOT, 'public', 'admin.html')],
  ['/admin.html', path.join(PROJECT_ROOT, 'public', 'admin.html')],
  ['/compliance', path.join(PROJECT_ROOT, 'public', 'compliance.html')],
  ['/compliance.html', path.join(PROJECT_ROOT, 'public', 'compliance.html')],
]);

const store = new Store(STATE_DIR);
const cookieSigningKey = store.getSecret('operator-cookie-secret') || crypto.randomBytes(32).toString('hex');
if (!store.secretPresent('operator-cookie-secret')) store.setSecret('operator-cookie-secret', cookieSigningKey);
const CAPABILITY_SECRET = Buffer.from(cookieSigningKey, 'hex');
const governance = new Governance(store);
const runner = new AgentRunner(governance, store);

let activeTurn = null;

function resolveStateDir() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error('LOCALAPPDATA is required to locate the demo state directory');
  }
  return path.join(localAppData, 'PDA', 'sdk-demo', 'state');
}

function ensureLoopbackPort() {
  for (const envName of ['PORT', 'PDA_PORT']) {
    const value = process.env[envName];
    if (value && Number(value) !== PORT) {
      throw new Error(`This demo only listens on ${HOST}:${PORT}`);
    }
  }
}

function readCookieValue(header, name) {
  if (!header) {
    return null;
  }
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index <= 0) {
      continue;
    }
    const key = part.slice(0, index).trim();
    if (key !== name) {
      continue;
    }
    return decodeURIComponent(part.slice(index + 1));
  }
  return null;
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hmacText(text) {
  return crypto.createHmac('sha256', CAPABILITY_SECRET).update(String(text), 'utf8').digest('hex');
}

function mintCapability() {
  const token = crypto.randomBytes(24).toString('base64url');
  const signature = hmacText(token);
  const cookieValue = `${token}.${signature}`;
  return {
    cookieValue,
    ownerHash: crypto.createHash('sha256').update(cookieValue, 'utf8').digest('hex'),
  };
}

function parseCapability(req) {
  const cookieValue = readCookieValue(req.headers.cookie || '', CAPABILITY_COOKIE);
  if (!cookieValue) {
    return null;
  }
  const separator = cookieValue.lastIndexOf('.');
  if (separator <= 0) {
    return null;
  }
  const token = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);
  if (!token || !signature || !timingSafeEqualText(signature, hmacText(token))) {
    return null;
  }
  return {
    cookieValue,
    ownerHash: crypto.createHash('sha256').update(cookieValue, 'utf8').digest('hex'),
  };
}

function hostHeader(req) {
  return String(req.headers.host || '').toLowerCase();
}

function assertAllowedHost(req) {
  const host = hostHeader(req);
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) {
    throw new Error(`Unexpected Host header: ${host || '<missing>'}`);
  }
}

function assertSameOrigin(req) {
  const host = hostHeader(req);
  const origin = String(req.headers.origin || '');
  if (!origin || origin !== `http://${host}`) {
    throw new Error('Origin mismatch');
  }
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && fetchSite === 'cross-site') {
    throw new Error('Cross-site requests are not allowed');
  }
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  const finalHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  };
  finalHeaders['content-length'] = Buffer.byteLength(body);
  res.writeHead(status, finalHeaders);
  res.end(body);
}

function badRequest(res, message) {
  sendJson(res, 400, { error: message });
}

function unauthorized(res, message = 'unauthorized') {
  sendJson(res, 401, { error: message });
}

function methodNotAllowed(res) {
  sendJson(res, 405, { error: 'method_not_allowed' });
}

function conflict(res, message = 'busy') {
  sendJson(res, 409, { error: message });
}

function notFound(res) {
  sendJson(res, 404, { error: 'not_found' });
}

function extractJsonBody(req, limitBytes = MAX_JSON_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let done = false;

    req.on('data', (chunk) => {
      if (done) {
        return;
      }
      total += chunk.length;
      if (total > limitBytes) {
        done = true;
        resolve({ ok: false, status: 413, error: 'request_too_large' });
        try {
          req.destroy();
        } catch {
          // ignore
        }
        return;
      }
      chunks.push(Buffer.from(chunk));
    });

    req.on('end', () => {
      if (done) {
        return;
      }
      done = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(text) });
      } catch {
        resolve({ ok: false, status: 400, error: 'invalid_json' });
      }
    });

    req.on('aborted', () => {
      if (!done) {
        done = true;
        resolve({ ok: false, status: 400, error: 'request_aborted' });
      }
    });

    req.on('error', () => {
      if (!done) {
        done = true;
        resolve({ ok: false, status: 400, error: 'request_error' });
      }
    });
  });
}

function clone(value) {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sanitizedText(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, limit);
}

function sanitizeActivity(activity) {
  if (!activity || typeof activity !== 'object') return null;
  const statuses = new Set(['running', 'complete', 'failed', 'stopped']);
  const state = value => ({ level: sanitizedText(value?.level, 80), environment: sanitizedText(value?.environment, 80) });
  const transition = activity.transition && typeof activity.transition === 'object' ? {
    from: state(activity.transition.from),
    to: state(activity.transition.to),
    confidentialityChanged: activity.transition.confidentialityChanged === true,
    environmentChanged: activity.transition.environmentChanged === true,
  } : null;
  return {
    id: sanitizedText(activity.id, 80),
    kind: sanitizedText(activity.kind, 40),
    title: sanitizedText(activity.title, 120),
    ...(activity.detail ? { detail: sanitizedText(activity.detail, 320) } : {}),
    status: statuses.has(activity.status) ? activity.status : 'complete',
    at: sanitizedText(activity.at, 40),
    ...(activity.completedAt ? { completedAt: sanitizedText(activity.completedAt, 40) } : {}),
    ...(Number.isFinite(activity.durationMs) ? { durationMs: Math.max(0, Math.min(activity.durationMs, 300_000)) } : {}),
    level: sanitizedText(activity.level, 80),
    environment: sanitizedText(activity.environment, 80),
    ...(transition ? { transition } : {}),
  };
}

function sanitizeChat(chat) {
  if (!chat) {
    return null;
  }
  const { ownerHash, ...rest } = clone(chat);
  if (Array.isArray(rest.messages)) {
    rest.messages = rest.messages.map(message => ({
      ...message,
      ...(Array.isArray(message.activity) ? { activity: message.activity.map(sanitizeActivity).filter(Boolean) } : {}),
    }));
  }
  return rest;
}

function sanitizeStreamEvent(event) {
  const next = clone(event);
  if (next && typeof next === 'object' && next.chat) {
    next.chat = sanitizeChat(next.chat);
  }
  if (next?.type === 'activity') next.activity = sanitizeActivity(next.activity);
  return next;
}

function sanitizeStatus() {
  const status = runner.status();
  return {
    readiness: status.readiness,
    activeRun: status.activeRun,
    activeChats: Array.isArray(status.activeChats) ? [...status.activeChats] : [],
  };
}

function apiState() {
  return {
    sdkVersion: runner.status().sdkVersion,
    policies: governance.policies(),
    active: governance.active(),
    draft: governance.draft(),
    settings: governance.settings(),
    credentials: governance.credentials(),
    tools: clone(TOOLS),
    levels: governance.levels(),
    environments: governance.environments(),
    vocabulary: governance.vocabulary(),
    deployment: {
      policy: {
        initialLevelId: DEPLOYMENT_SETTINGS.policy.initialLevelId,
        initialEnvironmentByBaseLevel: clone(DEPLOYMENT_SETTINGS.policy.initialEnvironmentByBaseLevel),
        baselineLevelIds: [...DEPLOYMENT_SETTINGS.policy.baselineLevelIds],
        baselineEnvironmentIds: [...DEPLOYMENT_SETTINGS.policy.baselineEnvironmentIds],
      },
      agents: DEPLOYMENT_SETTINGS.agents.agents.map(agent => ({ id: agent.id, name: agent.name })),
      defaultAgentId: DEPLOYMENT_SETTINGS.agents.defaultAgentId,
    },
    status: sanitizeStatus(),
    capacity: {
      chats: governance.capacity(),
      ledger: store.capacity(),
    },
  };
}

function currentChatOr404(id, ownerHash) {
  const chat = governance.getChat(id);
  if (!chat || chat.ownerHash !== ownerHash) {
    return null;
  }
  return chat;
}

function loadChatExportRecords(chatId) {
  return store.records().filter((record) => String(record.chatId || '') === String(chatId || ''));
}

function ledgerProof(records) {
  return records.map(({ seq, id, timestamp, kind, chatId, agentId, level, confidentiality, toolId, outcome, status, policyVersion, policyDigest, trigger, reason, hash, signature, previousHash }) => ({
    seq,
    id,
    timestamp,
    kind,
    chatId,
    agentId,
    level,
    confidentiality,
    toolId,
    outcome,
    status,
    policyVersion,
    policyDigest,
    trigger,
    reason,
    hash,
    signature,
    previousHash,
  }));
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) {
    return 'text/html; charset=utf-8';
  }
  if (filePath.endsWith('.css')) {
    return 'text/css; charset=utf-8';
  }
  if (filePath.endsWith('.js')) {
    return 'application/javascript; charset=utf-8';
  }
  return 'application/octet-stream';
}

function extractInlineScriptHashes(html) {
  const hashes = [];
  const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(html))) {
    const script = match[1].replace(/\r\n?/g, '\n');
    if (!script) {
      continue;
    }
    hashes.push(`'sha256-${crypto.createHash('sha256').update(script, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

function buildContentSecurityPolicy(html) {
  const scriptHashes = extractInlineScriptHashes(html);
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self'${scriptHashes.length ? ` ${scriptHashes.join(' ')}` : ''}`,
  ].join('; ');
}

function setSecurityHeaders(res, filePath, html) {
  res.setHeader('content-security-policy', buildContentSecurityPolicy(html));
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
}

function serveFile(res, filePath, { setCookieValue = null, html = false } = {}) {
  const body = fs.readFileSync(filePath);
  if (html) {
    setSecurityHeaders(res, filePath, body.toString('utf8'));
  } else {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
  }
  if (setCookieValue) {
    res.setHeader('set-cookie', `${CAPABILITY_COOKIE}=${encodeURIComponent(setCookieValue)}; HttpOnly; SameSite=Strict; Path=/`);
  }
  res.writeHead(200, { 'content-type': contentTypeFor(filePath) });
  res.end(body);
}

function setPageCookieIfNeeded(req, res) {
  const capability = parseCapability(req);
  if (capability) {
    return capability;
  }
  const minted = mintCapability();
  res.setHeader('set-cookie', `${CAPABILITY_COOKIE}=${encodeURIComponent(minted.cookieValue)}; HttpOnly; SameSite=Strict; Path=/`);
  return minted;
}

function writeSseEvent(res, event) {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  const payload = JSON.stringify(event);
  res.write(`event: ${event?.type || 'message'}\n`);
  for (const line of payload.split(/\r?\n/)) {
    res.write(`data: ${line}\n`);
  }
  res.write('\n');
}

async function handleChatCreate(req, res, capability) {
  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }
  assertSameOrigin(req);

  const parsed = await extractJsonBody(req);
  if (!parsed.ok) {
    sendJson(res, parsed.status, { error: parsed.error });
    return;
  }
  const chat = governance.newChat();
  chat.ownerHash = capability.ownerHash;
  chat.busy = false;
  governance.updateChat(chat);
  sendJson(res, 200, sanitizeChat(chat));
}

async function handleChatMessage(req, res, capability, chatId) {
  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }
  assertSameOrigin(req);

  if (activeTurn) {
    conflict(res, 'busy');
    return;
  }

  const chat = currentChatOr404(chatId, capability.ownerHash);
  if (!chat) {
    notFound(res);
    return;
  }
  if (chat.busy) {
    conflict(res, 'busy');
    return;
  }

  const parsed = await extractJsonBody(req);
  if (!parsed.ok) {
    sendJson(res, parsed.status, { error: parsed.error });
    return;
  }

  const prompt = String(parsed.value?.prompt ?? parsed.value?.text ?? '').trim();
  if (!prompt) {
    badRequest(res, 'prompt_required');
    return;
  }
  if (prompt.length > 8000) {
    sendJson(res, 413, { error: 'prompt_too_large' });
    return;
  }

  try {
    store.assertLedgerCapacity(LEDGER_RECORDS_PER_TURN);
  } catch (error) {
    sendJson(res, 409, { error: error.code || 'ledger_capacity', message: error.message });
    return;
  }

  if (activeTurn || chat.busy) { conflict(res, 'busy'); return; }
  chat.busy = true;
  governance.updateChat(chat);
  activeTurn = { chatId: chat.id };

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
  });

  try {
    const result = await runner.run(chat, prompt, (event) => {
      if (!clientClosed) {
        writeSseEvent(res, sanitizeStreamEvent(event));
      }
    });
    const latest = sanitizeChat(governance.getChat(chat.id));
    if (!clientClosed) {
      writeSseEvent(res, { type: 'done', chat: latest, result: clone(result) });
      res.end();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!clientClosed) {
      writeSseEvent(res, { type: 'error', code: 'runner_error', message });
      res.end();
    }
  } finally {
    activeTurn = null;
    try {
      const current = governance.getChat(chat.id);
      current.busy = false;
      governance.updateChat(current);
    } catch {
      // best effort cleanup
    }
  }
}

async function handleApi(req, res, capability, parsedUrl) {
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/policy/preview' && req.method === 'POST') {
    assertSameOrigin(req);
    const parsed = await extractJsonBody(req);
    if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });
    return sendJson(res, 200, governance.previewDraft(parsed.value));
  }
  if (pathname === '/api/policy/odrl' && req.method === 'PUT') {
    assertSameOrigin(req);
    const parsed = await extractJsonBody(req);
    if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });
    return sendJson(res, 200, governance.saveOdrlDraft(parsed.value));
  }

  if (req.method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, apiState());
    return;
  }

  if (req.method === 'POST' && pathname === '/api/demo/preflight') {
    assertSameOrigin(req);
    const parsed = await extractJsonBody(req);
    if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });
    sendJson(res, 200, await runner.demoPreflight());
    return;
  }

  if (req.method === 'POST' && pathname === '/api/chats') {
    await handleChatCreate(req, res, capability);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/chats/latest') {
    const policyVersion = governance.active()?.payload?.version;
    const chat = governance.latestOwnedChat(capability.ownerHash, policyVersion);
    sendJson(res, 200, sanitizeChat(chat));
    return;
  }

  const chatMessageMatch = pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (chatMessageMatch) {
    await handleChatMessage(req, res, capability, decodeURIComponent(chatMessageMatch[1]));
    return;
  }

  const chatMatch = pathname.match(/^\/api\/chats\/([^/]+)$/);
  if (chatMatch && req.method === 'GET') {
    const chat = currentChatOr404(decodeURIComponent(chatMatch[1]), capability.ownerHash);
    if (!chat) {
      notFound(res);
      return;
    }
    sendJson(res, 200, sanitizeChat(chat));
    return;
  }

  if (req.method === 'PUT' && pathname === '/api/policy/draft') {
    assertSameOrigin(req);
    const parsed = await extractJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, parsed.status, { error: parsed.error });
      return;
    }
    const body = parsed.value;
    const draft = Object.prototype.hasOwnProperty.call(body || {}, 'draft') ? body.draft : body;
    sendJson(res, 200, governance.saveDraft(draft));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/policy/publish') {
    assertSameOrigin(req);
    sendJson(res, 200, governance.publish());
    return;
  }

  if (req.method === 'PUT' && pathname === '/api/settings') {
    assertSameOrigin(req);
    const parsed = await extractJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, parsed.status, { error: parsed.error });
      return;
    }
    sendJson(res, 200, governance.updateSettings(parsed.value || {}));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/credentials') {
    assertSameOrigin(req);
    const parsed = await extractJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, parsed.status, { error: parsed.error });
      return;
    }
    const body = parsed.value || {};
    sendJson(res, 200, governance.revokeCredential(body.participantId, body.policyVersion, body.revoked));
    return;
  }

  const probeMatch = pathname.match(/^\/api\/routes\/([^/]+)\/probe$/);
  if (probeMatch && req.method === 'POST') {
    assertSameOrigin(req);
    const parsed = await extractJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, parsed.status, { error: parsed.error });
      return;
    }
    sendJson(res, 200, await runner.probe(decodeURIComponent(probeMatch[1])));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/ledger') {
    sendJson(res, 200, {
      records: store.records(),
      verification: store.verifyLedger(),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/ledger/verify') {
    assertSameOrigin(req);
    sendJson(res, 200, store.verifyLedger());
    return;
  }

  if (req.method === 'GET' && pathname === '/api/ledger/export') {
    const chatId = String(parsedUrl.searchParams.get('chatId') || '').trim();
    if (!chatId) {
      badRequest(res, 'chatId_required');
      return;
    }
    const chat = governance.getChat(chatId);
    if (!chat) {
      notFound(res);
      return;
    }
    const verification = store.verifyLedger();
    if (!verification.ok) return sendJson(res, 409, { error: 'Ledger verification failed; export withheld.' });
    const records = loadChatExportRecords(chatId);
    sendJson(res, 200, {
      format: 'cg-chat-evidence/1',
      chatId,
      chat: sanitizeChat(chat),
      records,
      policyBundles: governance.policies().filter(bundle => bundle.payload.version === chat.policyVersion),
      credentials: governance.credentials(chat.policyVersion),
      exportManifest: store.seal({ chatId, eventHashes: records.map(record => record.hash), policyDigest: chat.policyDigest, eventCount: records.length }),
      verification: {
        ...verification,
        note: 'Selected events and manifest have independently checkable signatures. No claim of full-ledger completeness or immutable storage. Trust the public key through an independent channel.',
      },
      exportedAt: new Date().toISOString(),
    });
    return;
  }

  notFound(res);
}

function handleStatic(req, res, parsedUrl) {
  const pathname = parsedUrl.pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    methodNotAllowed(res);
    return;
  }

  if (HTML_FILES.has(pathname)) {
    if (req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] !== 'navigate') {
      unauthorized(res); return;
    }
    const filePath = HTML_FILES.get(pathname);
    if (!fs.existsSync(filePath)) {
      notFound(res);
      return;
    }
    const minted = setPageCookieIfNeeded(req, res);
    serveFile(res, filePath, { setCookieValue: minted.cookieValue, html: true });
    return;
  }

  if (STATIC_FILES.has(pathname)) {
    const filePath = STATIC_FILES.get(pathname);
    if (!fs.existsSync(filePath)) {
      notFound(res);
      return;
    }
    serveFile(res, filePath, { html: false });
    return;
  }

  notFound(res);
}

const server = http.createServer(async (req, res) => {
  try {
    assertAllowedHost(req);
    const parsedUrl = new URL(req.url || '/', `http://${hostHeader(req) || `${HOST}:${PORT}`}`);
    const capability = parseCapability(req);

    // SDK model calls use a per-turn unguessable capability, not browser cookies.
    if (parsedUrl.pathname.startsWith('/internal/model/')) {
      await runner.proxyRequest(req, res);
      return;
    }

    if (parsedUrl.pathname.startsWith('/api/')) {
      if (!capability) {
        unauthorized(res);
        return;
      }
      if (['POST', 'PUT'].includes(req.method) && !String(req.headers['content-type'] || '').startsWith('application/json')) {
        sendJson(res, 415, { error: 'application_json_required' }); return;
      }
      await handleApi(req, res, capability, parsedUrl);
      return;
    }

    handleStatic(req, res, parsedUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      sendJson(res, 400, { error: message });
      return;
    }
    try {
      res.end();
    } catch {
      // ignore
    }
  }
});

async function closeServer() {
  await runner.close().catch(() => {});
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function main() {
  ensureLoopbackPort();
  server.listen(PORT, HOST, () => {
    console.log(`Cumulus Granitus demo listening on http://${HOST}:${PORT}`);
  });

  const shutdown = async () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await closeServer();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
