import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { canAccess, createAuthenticator } from '../app/auth.mjs';
import { Store, acquireStateLock } from '../app/storage.mjs';

test('telemetry uses bounded explicit logs without exporting record payloads', async () => {
  const source = fs.readFileSync(new URL('../app/telemetry.mjs', import.meta.url), 'utf8')
    .replace('export async function', 'async function')
    .replace("await import('@azure/monitor-opentelemetry-exporter')", 'exporterModule')
    .replace("await import('@opentelemetry/sdk-logs')", 'logsModule');
  const exported = [];
  const context = {
    process: { env: { PDA_OTEL_ENABLED: '1', APPLICATIONINSIGHTS_CONNECTION_STRING: 'fixture' } },
    logsModule: await import('@opentelemetry/sdk-logs'),
    exporterModule: { AzureMonitorLogExporter: class {
      constructor(options) { assert.equal(options.disableOfflineStorage, true); }
      export(records, callback) { exported.push(...records); callback({ code: 0 }); }
      async shutdown() {}
    } },
  };
  const init = vm.runInNewContext(`${source}; initTelemetry`, context);
  const telemetry = await init();
  assert.equal(typeof telemetry.onLedgerAppend, 'function');
  telemetry.onLedgerAppend({ seq: 1, kind: 'tool-denied', chatId: 'fixture-chat',
    prompt: 'private-prompt', reason: 'private-reason', signature: 'private-signature', args: { token: 'private-token' } });
  await telemetry.shutdown();
  assert.equal(exported.length, 1);
  assert.equal(exported[0].attributes['pda.chat_id'], 'fixture-chat');
  assert.ok(!JSON.stringify({ body: exported[0].body, attributes: exported[0].attributes }).includes('private-'));
});

test('credential-bearing SDK output is withheld before browser emission', async () => {
  const { AgentRunner } = await import('../app/agent.mjs');
  const runner = Object.create(AgentRunner.prototype);
  const route = { id: 'fixture', kind: 'fixture', model: 'fixture' };
  const chat = { messages: [], level: 'Public', sovereignty: 'Public cloud' };
  const events = [];
  let deltaHandler;
  runner.governance = {
    classify: () => ({}), updateChat: () => {}, routePlan: () => ({ routes: [route] }),
    credential: () => ({ ok: true }), settings: () => ({ routes: { fixture: route } }),
  };
  runner.providerKey = () => 'fixture-secret-value';
  runner.event = () => {};
  runner.stopRunClient = async () => {};
  runner.clientFor = async () => ({ createSession: async () => ({
    sessionId: 'fixture',
    on: (name, callback) => { deltaHandler = callback; },
    sendAndWait: async () => {
      deltaHandler?.({ data: { deltaContent: 'fixture-secret-value' } });
      return { data: { content: 'fixture-secret-value' } };
    },
  }) });
  runner.loadSdk = async () => ({ defineTool: () => ({}), ToolSet: class {
    addCustom() { return this; } addBuiltIn() { return this; } addMcp() { return this; }
  } });
  await runner.run(chat, 'hello', event => events.push(event));
  assert.ok(events.some(event => event.type === 'message' && /withheld/.test(event.text)));
  assert.ok(events.every(event => !event.text?.includes('fixture-secret-value')));
  assert.ok(chat.messages.every(message => !message.content.includes('fixture-secret-value')));
});

test('HTTP dispatch rejects unauthorized roles and binds ownership to identity', async () => {
  const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const handlerSource = source.slice(source.indexOf('const server = http.createServer('), source.indexOf('async function closeServer()'));
  let handler;
  const replies = [];
  const sendJson = (res, status, body) => replies.push({ status, body });
  const context = {
    http: { createServer: callback => { handler = callback; } }, URL, crypto, HOST: '127.0.0.1', PORT: 8110,
    assertAllowedHost: () => {}, hostHeader: () => 'localhost:8110', canAccess, sendJson,
    authenticate: async req => req.fixturePrincipal || null,
    unauthorized: res => sendJson(res, 401, {}),
    parseCapability: () => ({ ownerHash: 'same-browser' }),
    handleApi: async (req, res, capability) => sendJson(res, 200, { owner: capability.ownerHash }),
    handleStatic: () => { throw new Error('Static path unexpectedly reached'); },
    runner: { proxyRequest: () => { throw new Error('Remote proxy unexpectedly reached'); } },
  };
  vm.runInNewContext(handlerSource, context);
  const invoke = async (url, principal) => {
    await handler({ url, method: 'GET', headers: {}, socket: { remoteAddress: '192.0.2.1' }, fixturePrincipal: principal }, { headersSent: false });
    return replies.at(-1);
  };
  assert.equal((await invoke('/api/state')).status, 401);
  assert.equal((await invoke('/api/ledger', { roles: ['User'] })).status, 403);
  assert.equal((await invoke('/admin', { roles: ['Compliance'] })).status, 403);
  assert.equal((await invoke('/internal/model/forged')).status, 401);
  const first = await invoke('/api/chats/example', { id: 'tenant:first', roles: ['User'], local: false });
  const second = await invoke('/api/chats/example', { id: 'tenant:second', roles: ['User'], local: false });
  assert.equal(first.status, 200);
  assert.notEqual(first.body.owner, second.body.owner);
});

test('Key Vault envelope reuses its original key version and rejects legacy ambiguity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-key-test-'));
  const keyId = 'https://fixture.vault.azure.net/keys/pda-kek/original-version';
  const source = fs.readFileSync(new URL('../app/protector.mjs', import.meta.url), 'utf8');
  const functionSource = source.slice(source.indexOf('export async function createKeyVaultProtector'), source.indexOf('// Selects the at-rest protector'))
    .replace('export async function', 'async function')
    .replace("await import('@azure/identity')", 'identityModule')
    .replace("await import('@azure/keyvault-keys')", 'keyModule');
  const clients = [];
  let lookups = 0;
  const context = {
    crypto, fs, path, Buffer, URL, DEK_FILE: 'vault/dek.wrapped', KEK_ALGORITHM: 'RSA-OAEP-256', KV_PREFIX: 'kv1:',
    process: { pid: process.pid, env: { AZURE_KEY_VAULT_URI: 'https://fixture.vault.azure.net' } },
    base64: value => Buffer.from(value).toString('base64'),
    toBuffer: value => typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(value),
    identityModule: { DefaultAzureCredential: class {} },
    keyModule: {
      KeyClient: class { async getKey() { lookups++; return { id: keyId }; } },
      CryptographyClient: class {
        constructor(id) { clients.push(id); }
        async wrapKey(algorithm, value) { return { result: value }; }
        async unwrapKey(algorithm, value) { return { result: value }; }
      },
    },
  };
  try {
    const create = vm.runInNewContext(`${functionSource}; createKeyVaultProtector`, context);
    const first = await create(root);
    const sealed = first.protect('fixture value');
    const second = await create(root);
    assert.equal(second.unprotect(sealed), 'fixture value');
    assert.equal(lookups, 1);
    assert.deepEqual(clients, [keyId, keyId]);
    fs.writeFileSync(path.join(root, 'vault/dek.wrapped'), 'legacy-base64');
    await assert.rejects(create(root), /no key version/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('roles isolate chat, administration and compliance', async () => {
  const user = { roles: ['User'] };
  assert.equal(canAccess(user, '/api/chats'), true);
  for (const target of ['/api/settings', '/api/policy/publish', '/api/credentials', '/api/routes/global/probe', '/api/ledger/export', '/admin', '/compliance']) {
    assert.equal(canAccess(user, target), false, target);
  }
  assert.equal(canAccess({ roles: ['Administrator'] }, '/api/ledger'), false);
  assert.equal(canAccess({ roles: ['Compliance'] }, '/api/settings'), false);
  assert.equal(canAccess(null, '/api/state'), false);
  await assert.rejects(createAuthenticator({ PDA_ALLOW_REMOTE: '1' }), /requires PDA_AUTH/);
  const local = await createAuthenticator({});
  assert.equal(canAccess(await local({}), '/api/settings'), true);
});

test('cloud authentication verifies signature, issuer, audience, expiry and tenant', async () => {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const tenant = '11111111-1111-1111-1111-111111111111';
  const audience = '22222222-2222-2222-2222-222222222222';
  const oid = '33333333-3333-3333-3333-333333333333';
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
  const keys = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'fixture', use: 'sig', alg: 'RS256' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  try {
    const authenticate = await createAuthenticator({ PDA_ALLOW_REMOTE: '1', PDA_AUTH_TENANT_ID: tenant, PDA_AUTH_CLIENT_ID: audience });
    const sign = (changes = {}, key = keys.privateKey) => new SignJWT({ oid, tid: tenant, roles: ['User'], iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 60, ...changes })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuedAt().sign(key);
    const request = token => ({ headers: { 'x-ms-token-aad-id-token': token } });
    assert.equal(await authenticate({ headers: { 'x-ms-client-principal': 'spoofed' } }), null);
    assert.equal((await authenticate(request(await sign()))).id, `${tenant}:${oid}`);
    for (const changes of [{ aud: tenant }, { iss: 'https://wrong.example' }, { tid: audience }, { exp: 1 }]) {
      assert.equal(await authenticate(request(await sign(changes))), null);
    }
    const wrongKeys = await generateKeyPair('RS256');
    assert.equal(await authenticate(request(await sign({}, wrongKeys.privateKey))), null);
  } finally { globalThis.fetch = originalFetch; }
});

test('state lock prevents a second writer and rejects repository state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-lock-test-'));
  try {
    const release = acquireStateLock(root);
    assert.throws(() => acquireStateLock(root), /State is locked/);
    release();
    acquireStateLock(root)();
    assert.throws(() => acquireStateLock(path.resolve(import.meta.dirname, '..')), /outside the repository/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cloud settings, monotonic residency and restart recovery', async () => {
  const overrides = {
    PDA_ALLOW_REMOTE: '1', PDA_SIMULATE_SOVEREIGNTY: '1',
    AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com/openai/v1',
  };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const { Governance } = await import('../app/governance.mjs');
    const state = new Map();
    const store = Object.create(Store.prototype);
    const keys = crypto.generateKeyPairSync('ed25519');
    store._privateKey = keys.privateKey;
    store._publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).trim();
    store.load = (name, fallback) => structuredClone(state.has(name) ? state.get(name) : fallback);
    store.save = (name, value) => { state.set(name, structuredClone(value)); return value; };
    store.secretPresent = () => false;
    store.append = () => {};
    let governance = new Governance(store);
    assert.equal(governance.settings().routes.eu.geography, 'EU-only');
    assert.equal(governance.settings().routes.onprem.geography, 'On-premises');
    assert.equal(governance.settings().routes.onprem.simulated, true);
    assert.equal(governance.settings().routes.eu.simulated, false);
    assert.equal(governance.recommendRoute(governance.newChat('Public')).id, 'global');
    assert.equal(governance.recommendRoute(governance.newChat('Highly Confidential')).id, 'onprem');
    assert.throws(() => governance.updateSettings({ routes: [{ id: 'global', baseUrl: 'https://evil.example/openai/v1' }] }), /approved/);
    const chat = governance.newChat('Public');
    chat.busy = true;
    governance.updateChat(chat);
    const saved = state.get('settings');
    saved.preferences.public = 'copilot';
    saved.routes.global.baseUrl = 'https://azure-openai.invalid/openai/v1';
    governance = new Governance(store);
    assert.equal(governance.getChat(chat.id).busy, false);
    assert.equal(governance.settings().preferences.public, 'global');
    assert.equal(governance.settings().routes.global.baseUrl, 'https://example.openai.azure.com/openai/v1');
    const draft = governance.draft();
    draft.levelDefinitions.push({ id: 'Review', name: 'Review', baseLevel: 'Public' });
    for (const key of ['allowedModels', 'allowedTools', 'allowedEnvironments']) draft[key].Review = [...draft[key].Public];
    delete draft.odrl;
    governance.saveDraft(draft);
    governance.publish();
    const pinned = governance.newChat('Review');
    const nextDraft = governance.draft();
    nextDraft.levelDefinitions = nextDraft.levelDefinitions.filter(definition => definition.id !== 'Review');
    for (const key of ['allowedModels', 'allowedTools', 'allowedEnvironments']) delete nextDraft[key].Review;
    delete nextDraft.odrl;
    governance.saveDraft(nextDraft);
    governance.publish();
    assert.doesNotThrow(() => governance.classify(pinned, 'Hello'));
    assert.equal(pinned.level, 'Review');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});