import crypto from 'node:crypto';
import { Store } from './storage.mjs';

export const LEVELS = ['Public', 'Internal', 'Highly Confidential'];
export const ENVIRONMENTS = ['Public cloud', 'EU-only', 'On-premises'];
export const TOOLS = [
  {
    id: 'weather',
    name: 'Weather lookup',
    minimumLevel: 'Public',
    sovereignty: 'Public cloud',
    endpoint: 'demo://weather',
    description: 'Fictional public weather lookup used for the demo.',
  },
  {
    id: 'sales',
    name: 'Confidential sales lookup',
    minimumLevel: 'Highly Confidential',
    sovereignty: 'On-premises',
    endpoint: 'demo://sales',
    description: 'Fictional confidential sales record lookup used for the demo.',
  },
  {
    id: 'public_send',
    name: 'Public send',
    minimumLevel: 'Public',
    sovereignty: 'Public cloud',
    endpoint: 'demo://public-send',
    description: 'Dry-run public message relay used for the demo.',
  },
];

const MAX_DEFINITIONS = 8;
const LEVEL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,79}$/;
const BASE_LEVEL_RANK = new Map(LEVELS.map((level, index) => [level, index]));
const BASE_ENVIRONMENT_RANK = new Map(ENVIRONMENTS.map((environment, index) => [environment, index]));
// The three governed model routes are all Azure OpenAI / AI Foundry deployments on one account,
// authenticated with the app's managed identity (no API keys). They differ only by deployment name
// (model) and the sovereignty they represent: global (Public cloud), eu (EU-only, genuinely in-EU
// because the account runs in an EU region) and onprem (On-premises, simulated in the cloud).
const EU_POOL_ROUTE_IDS = [];
const REMOTE_ROUTE_IDS = [];
const ROUTE_IDS = new Set(['global', 'eu', 'onprem']);
// Azure OpenAI / AI Foundry OpenAI-compatible v1 endpoint. Empty locally, set by the container.
const DEFAULT_AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || '';
const CLOUD_HOST = process.env.PDA_ALLOW_REMOTE === '1';
// When set, the cloud host serves every governed geography (including the simulated On-premises
// route) instead of refusing residencies a real cloud host could not honestly satisfy.
const SIMULATE_SOVEREIGNTY = process.env.PDA_SIMULATE_SOVEREIGNTY === '1';
const HOST_GEOGRAPHY = CLOUD_HOST ? (process.env.PDA_HOST_GEOGRAPHY || 'Public cloud') : 'On-premises';
const CREDENTIAL_ISSUER = 'CG Demo Credential Authority';
const CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PARTICIPANTS = [
  { id: 'global', label: 'Global model (Public cloud)', kind: 'model' },
  { id: 'eu', label: 'EU model (EU-only)', kind: 'model' },
  { id: 'onprem', label: 'On-premises model (simulated)', kind: 'model' },
  { id: 'weather', label: 'Weather tool', kind: 'tool' },
  { id: 'sales', label: 'Sales tool', kind: 'tool' },
  { id: 'public_send', label: 'Public send tool', kind: 'tool' },
];
const PARTICIPANT_IDS = new Set(PARTICIPANTS.map(participant => participant.id));
const LEGACY_LEVEL_IDS = new Set(LEVELS);
const LEGACY_ENVIRONMENT_IDS = new Set(ENVIRONMENTS);

export class Governance {
  constructor(store) {
    this.store = store instanceof Store ? store : new Store(store);
    this._policyBundles = this._loadPolicyBundles();
    this._draft = this._loadDraft();
    this._settings = this._loadSettings();
    this._credentialBook = this._loadCredentialBook();
    this._chatBook = this._loadChatBook();
    this.currentChat = this._chatBook.at(-1) ?? null;
  }

  policies() {
    return this._policyBundles.map((bundle) => this._clone(bundle));
  }

  active() {
    return this._clone(this._policyBundles.at(-1));
  }

  draft() {
    return this._clone(this._draft);
  }

  levels() {
    return this.vocabulary().levels.map(definition => definition.id);
  }

  environments() {
    return this.vocabulary().environments.map(definition => definition.id);
  }

  vocabulary() {
    const view = this._policyView(this.active());
    return {
      levels: this._clone(view.levelDefinitions),
      environments: this._clone(view.environmentDefinitions),
      levelDefinitions: this._clone(view.levelDefinitions),
      environmentDefinitions: this._clone(view.environmentDefinitions),
      envDefinitions: this._clone(view.environmentDefinitions),
    };
  }

  saveDraft(value) {
    const active = this.active();
    const basePolicy = active?.payload ?? this._createDefaultPolicy(1);
    const next = this._normalizePolicyDraft(value, basePolicy);
    this._draft = next;
    this.store.save('policy-draft', next);
    this.store.append('policy-draft-saved', { policyVersion: next.version, policyDigest: this._policyDigest(next) });
    return this._clone(next);
  }

  previewDraft(value) {
    const active = this.active();
    const basePolicy = active?.payload ?? this._createDefaultPolicy(1);
    return this._clone(this._normalizePolicyDraft(value, basePolicy));
  }

  saveOdrlDraft(raw) {
    const active = this.active();
    const basePolicy = active?.payload ?? this._createDefaultPolicy(1);
    const document = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const parsed = this._policyDraftFromOdrl(document, basePolicy);
    delete parsed.odrl;
    const next = this._normalizePolicyDraft(parsed, basePolicy);
    this._draft = next;
    this.store.save('policy-draft', next);
    this.store.append('policy-draft-saved', { policyVersion: next.version, policyDigest: this._policyDigest(next) });
    return this._clone(next);
  }

  publish() {
    const active = this.active();
    const basePolicy = active?.payload ?? this._createDefaultPolicy(1);
    const draft = this._normalizePolicyDraft(this._draft ?? this._createDraftFromActive(), basePolicy);
    const version = basePolicy.version + 1;
    const nextPolicy = this._clone({ ...draft, version });
    delete nextPolicy.odrl;
    nextPolicy.odrl = this._buildOdrl(version, nextPolicy.levelDefinitions, nextPolicy.environmentDefinitions, nextPolicy.allowedModels, nextPolicy.allowedTools, nextPolicy.allowedEnvironments);
    const sealed = this.store.seal(nextPolicy);

    this._policyBundles.push(sealed);
    this.store.save('policies', this._policyBundles);
    this._draft = this._createDraftFromActive();
    this.store.save('policy-draft', this._draft);
    this._issueCredentialsForPolicy(nextPolicy);
    this.store.append('policy-published', { policyVersion: version, policyDigest: sealed.digest });
    return this._clone(sealed);
  }

  settings() {
    return this._sanitizeSettings(this._settings);
  }

  updateSettings(body = {}) {
    const next = this._clone(this._settings);
    if (body.routes) {
      this._applyRouteSettings(next, body.routes);
    }
    if (body.publicRoute) {
      next.preferences.public = this._assertRouteId(body.publicRoute, 'public route');
    }
    if (body.internalRoute) {
      next.preferences.internal = this._assertRouteId(body.internalRoute, 'internal route');
    }
    if (body.highRoute) {
      next.preferences.high = this._assertRouteId(body.highRoute, 'high route');
    }
    this._validateSettings(next);
    this._settings = next;
    this.store.save('settings', next);
    this.store.append('settings-updated', { settings: this._sanitizeSettings(next) });
    return this.settings();
  }

  credentials(policyVersion = this.active()?.payload?.version) {
    const version = Number(policyVersion ?? this.active()?.payload?.version);
    const items = this._credentialBook.get(version) ?? [];
    return items
      .filter(entry => PARTICIPANT_IDS.has(entry.payload.participantId))
      .map((entry) => this._decorateCredential(entry));
  }

  revokeCredential(participantId, policyVersion, revoked) {
    const key = this._credentialKey(participantId, policyVersion);
    this._credentialStatus.set(key, Boolean(revoked));
    this._persistCredentialStatus();
    const credential = this.credential(participantId, policyVersion);
    this.store.append('credential-status-updated', {
      participantId,
      policyVersion: Number(policyVersion),
      revoked: Boolean(revoked),
    });
    return credential;
  }

  credential(participantId, policyVersion) {
    const version = Number(policyVersion);
    const policy = this._policyBundles.find((entry) => entry.payload.version === version);
    const versionSet = this._credentialBook.get(version) ?? [];
    const record = versionSet.find((entry) => entry.payload.participantId === participantId);
    if (!record) {
      return { ok: false, reason: 'credential-missing' };
    }
    const decorated = this._decorateCredential(record);
    if (decorated.revoked) {
      return { ok: false, reason: 'credential-revoked', record: decorated };
    }
    if (!this.store.verify(record)) {
      return { ok: false, reason: 'credential-invalid-signature', record: decorated };
    }
    if (record.payload.issuer !== CREDENTIAL_ISSUER || record.payload.status !== 'active' || record.payload.demo !== true) {
      return { ok: false, reason: 'credential-untrusted', record: decorated };
    }
    if (!record.payload.validUntil || Number.isNaN(Date.parse(record.payload.validUntil)) || Date.parse(record.payload.validUntil) <= Date.now()) {
      return { ok: false, reason: 'credential-expired', record: decorated };
    }
    if (!policy || record.payload.policyDigest !== policy.digest) {
      return { ok: false, reason: 'credential-digest-mismatch', record: decorated };
    }
    return { ok: true, record: decorated };
  }

  newChat(level = 'Public') {
    if (this._chatBook.length >= 200) throw new Error('Demo chat capacity reached');
    const policy = this.active();
    if (!policy) {
      throw new Error('No active policy');
    }
    const normalizedLevel = this._assertLevel(level, policy.payload);
    const sovereignty = this._initialSovereignty(normalizedLevel, policy.payload);
    const chat = {
      id: `chat-${crypto.randomUUID()}`,
      agentId: 'cg-agent-01',
      initialLevel: normalizedLevel,
      level: normalizedLevel,
      sovereignty,
      policyVersion: policy.payload.version,
      policyDigest: policy.digest,
      createdAt: new Date().toISOString(),
      messages: [],
      busy: false,
      routeId: null,
      restrictions: this._initialRestrictions(sovereignty),
    };
    this._syncChatLabels(chat, policy.payload);

    this._chatBook.push(chat);
    this.currentChat = chat;
    this.store.save('chats', this._chatBook);
    this.store.append('chat-created', {
      chatId: chat.id,
      agentId: chat.agentId,
      level: chat.level,
      policyDigest: chat.policyDigest,
      policyVersion: chat.policyVersion,
      initialLevel: chat.initialLevel,
      sovereignty: chat.sovereignty,
    });
    return chat;
  }

  getChat(id) {
    const chat = this._chatBook.find((entry) => entry.id === id);
    if (!chat) {
      return null;
    }
    this.currentChat = chat;
    return chat;
  }

  updateChat(chat) {
    const current = this._stateForChat(chat);
    Object.assign(current, this._clone(chat));
    this._syncChatLabels(current);
    this.currentChat = current;
    this._persistChats();
    return current;
  }

  classify(chat, prompt) {
    const current = this._stateForChat(chat);
    const text = String(prompt ?? '');
    if (/\b(italy|italian)\b/i.test(text) && !current.restrictions.includes('IT')) current.restrictions.push('IT');
    if (/\b(germany|german)\b/i.test(text) && !current.restrictions.includes('DE')) current.restrictions.push('DE');
    const target = this._classifyPrompt(current, prompt);
    if (target.conflict) {
      current.blocked = true;
      current.conflictReason = target.trigger;
      this.updateChat(current);
      this.store.append('chat-conflict', {
        chatId: current.id,
        agentId: current.agentId, level: current.level, sovereignty: current.sovereignty,
        policyVersion: current.policyVersion, policyDigest: current.policyDigest,
        prompt,
        reason: target.trigger,
        currentLevel: current.level,
        currentSovereignty: current.sovereignty,
      });
      return target;
    }

    const before = { level: current.level, sovereignty: current.sovereignty };
    const nextLevel = this._maxLevel(current.level, target.level, current);
    const nextSovereignty = this._maxSovereignty(current.sovereignty, target.sovereignty, current);
    const changed = before.level !== nextLevel || before.sovereignty !== nextSovereignty;

    current.level = nextLevel;
    current.sovereignty = nextSovereignty;
    if (nextSovereignty === 'On-premises' && !current.restrictions.includes('DE')) {
      current.restrictions = [...current.restrictions, 'DE'];
    }
    if (nextSovereignty === 'EU-only' && !current.restrictions.includes('EU')) {
      current.restrictions = [...current.restrictions, 'EU'];
    }
    if (nextSovereignty === 'EU-only' && target.trigger === 'Italy request' && !current.restrictions.includes('IT')) {
      current.restrictions = [...current.restrictions, 'IT'];
    }
    this.updateChat(current);

    if (changed) {
      this.store.append('chat-elevated', {
        chatId: current.id,
        agentId: current.agentId, level: nextLevel, sovereignty: nextSovereignty,
        policyVersion: current.policyVersion, policyDigest: current.policyDigest,
        prompt,
        from: before,
        to: { level: nextLevel, sovereignty: nextSovereignty },
        trigger: target.trigger,
      });
    } else {
      this.store.append('chat-classified', {
        chatId: current.id,
        agentId: current.agentId, policyVersion: current.policyVersion, policyDigest: current.policyDigest,
        prompt,
        level: nextLevel,
        sovereignty: nextSovereignty,
        trigger: target.trigger,
      });
    }

    return {
      level: nextLevel,
      sovereignty: nextSovereignty,
      changed,
      trigger: target.trigger,
      analysis: 'deterministic demo rules, not enterprise DLP',
      conflict: false,
    };
  }

  routePlan(chat, excludedRouteIds = []) {
    const state = this._stateForChat(chat);
    if (state.blocked) throw this._routeError('SOVEREIGNTY_CONFLICT', state.conflictReason || 'Conflicting sovereignty restrictions remain in this chat.');
    const policy = this._policyForChat(state).payload;
    // In simulation the host serves every governed geography (the On-premises route is simulated);
    // otherwise a real cloud host honestly refuses residencies it cannot satisfy.
    if (!SIMULATE_SOVEREIGNTY && CLOUD_HOST && (this._rankSovereignty(state.sovereignty, policy) > this._baseEnvironmentRank(HOST_GEOGRAPHY)
      || state.restrictions?.some(restriction => ['IT', 'DE'].includes(restriction)))) {
      throw this._routeError('HOST_NOT_PERMITTED', 'This cloud host cannot satisfy the requested residency. Use an approved local deployment; no model was called.');
    }
    const level = this._baseLevelId(state.level, policy);
    const preference = this._routePreference(level, policy);
    const settings = this._settings;
    const allowedModels = policy.allowedModels[state.level] ?? [];
    const allowedEnvironments = (policy.allowedEnvironments[state.level] ?? []).map(id => this._baseEnvironmentId(id, policy));
    const useEuPool = EU_POOL_ROUTE_IDS.includes(preference);
    const configuredOrder = useEuPool ? [...settings.euRouting.order] : [preference];
    const orderIndex = new Map(configuredOrder.map((routeId, index) => [routeId, index]));
    const routeIds = useEuPool && settings.euRouting.strategy === 'cost'
      ? configuredOrder.sort((left, right) => settings.routes[left].costScore - settings.routes[right].costScore
        || orderIndex.get(left) - orderIndex.get(right))
      : configuredOrder;
    const excluded = new Set(excludedRouteIds);
    const routes = [];
    const skipped = [];

    for (const routeId of routeIds) {
      const route = settings.routes[routeId];
      let code;
      let message;
      if (excluded.has(routeId)) {
        code = 'ROUTE_ALREADY_ATTEMPTED';
        message = `${routeId} was already attempted for this turn`;
      } else if (!route) {
        code = 'ROUTE_UNKNOWN';
        message = `Unknown route preference: ${routeId}`;
      } else if (!route.enabled) {
        code = 'ROUTE_DISABLED';
        message = `${route.name} is disabled`;
      } else if (!allowedModels.includes(routeId)) {
        code = 'MODEL_NOT_PERMITTED';
        message = `${routeId} is not permitted for ${level}`;
      } else if (!allowedEnvironments.includes(route.geography)) {
        code = 'ENVIRONMENT_NOT_PERMITTED';
        message = `${route.geography} is not permitted for ${level}`;
      } else if (!this._routeMatchesSovereignty(state, route, policy)) {
        code = 'ROUTE_NOT_PERMITTED';
        message = `No route satisfies ${state.sovereignty}`;
      } else {
        const credential = this.credential(routeId, policy.version);
        if (!credential.ok) {
          code = credential.reason.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
          message = credential.reason;
        } else if (REMOTE_ROUTE_IDS.includes(routeId) && !settings.secrets.routeApiKeyPresent[routeId]) {
          code = 'PROVIDER_KEY_REQUIRED';
          message = `${route.name} requires an API key`;
        }
      }
      if (code) {
        skipped.push({ routeId, code, message });
      } else {
        routes.push(this._decorateRoute(routeId, route, route.geography));
      }
    }

    if (!routes.length) {
      const first = skipped.find(item => item.code !== 'ROUTE_ALREADY_ATTEMPTED') ?? skipped[0];
      throw this._routeError(first?.code ?? 'NO_AUTHORIZED_ROUTE', first?.message ?? `No route satisfies ${state.sovereignty}`);
    }
    return {
      strategy: useEuPool ? settings.euRouting.strategy : 'preference',
      fallbackEnabled: useEuPool && settings.euRouting.fallbackEnabled,
      routes,
      skipped,
    };
  }

  recommendRoute(chat, excludedRouteIds = []) {
    return this.routePlan(chat, excludedRouteIds).routes[0];
  }

  toolDecision(chat, toolId, args = {}, excludedRouteIds = []) {
    const state = this._stateForChat(chat);
    const tool = TOOLS.find((entry) => entry.id === toolId);
    if (!tool) {
      return { allowed: false, reason: 'UNKNOWN_TOOL', tool: toolId, raised: null };
    }

    const classification = this.classify(state, typeof args === 'string' ? args : JSON.stringify(args ?? {}));
    if (classification.conflict || state.blocked) return { allowed: false, reason: 'SOVEREIGNTY_CONFLICT', tool, raised: null };
    const policy = this._policyForChat(state).payload;
    const requiredLevel = tool.minimumLevel;
    const requiredSovereignty = tool.sovereignty;
    const raised = this._elevateChat(state, requiredLevel, requiredSovereignty, toolId, args);
    const participant = this.credential(toolId, policy.version);

    if (raised.changed) {
      this.store.append('tool-elevation', {
        chatId: state.id,
        toolId,
        from: raised.from,
        to: raised.to,
        args: toolId === 'public_send' ? '[redacted]' : args,
      });
    }

    if (!participant.ok) {
      return {
        allowed: false,
        reason: participant.reason,
        tool,
        raised,
        credential: participant.record ?? null,
      };
    }

    if (!policy.allowedTools[state.level].includes(toolId)) {
      return {
        allowed: false,
        reason: 'TOOL_FORBIDDEN_AT_CURRENT_LEVEL',
        tool,
        credential: participant.record,
        raised,
      };
    }

    if (tool.sovereignty === 'Public cloud' && this._baseLevelId(state.level, policy) !== 'Public') {
      return {
        allowed: false,
        reason: 'PUBLIC_TOOL_BLOCKED_FOR_PROTECTED_CHAT',
        tool,
        credential: participant.record,
        raised,
      };
    }

    const permittedRoute = this._routeForTool(tool, state, excludedRouteIds);
    if (!permittedRoute.allowed) {
      return {
        allowed: false,
        reason: permittedRoute.reason,
        tool,
        credential: participant.record,
        raised,
      };
    }

    this.store.append('tool-approved', {
      chatId: state.id,
      agentId: state.agentId, level: state.level, sovereignty: state.sovereignty, policyDigest: state.policyDigest,
      toolId,
      routeId: permittedRoute.route.id,
      args: toolId === 'public_send' ? '[redacted]' : args,
      policyVersion: policy.version,
    });

    return {
      allowed: true,
      reason: 'ALLOWED',
      tool,
      credential: participant.record,
      raised,
      route: permittedRoute.route,
    };
  }

  _loadPolicyBundles() {
    const saved = this.store.load('policies', null);
    if (Array.isArray(saved) && saved.length > 0) {
      for (const bundle of saved) {
        if (!this.store.verify(bundle)) {
          throw new Error('Invalid sealed policy bundle');
        }
        const historicalModelIds = new Set(ROUTE_IDS);
        for (const models of Object.values(bundle.payload.allowedModels ?? {})) {
          if (Array.isArray(models)) {
            for (const modelId of models) historicalModelIds.add(modelId);
          }
        }
        this._validatePolicy(bundle.payload, historicalModelIds);
      }
      return saved;
    }

    const seed = this.store.seal(this._createDefaultPolicy(1));
    this._validatePolicy(seed.payload);
    this.store.save('policies', [seed]);
    return [seed];
  }

  _loadDraft() {
    const saved = this.store.load('policy-draft', null);
    const draft = saved ? this._clone(saved) : this._createDraftFromActive();
    let changed = !saved;
    for (const [levelId, models] of Object.entries(draft.allowedModels ?? {})) {
      if (!Array.isArray(models)) continue;
      const activeModels = models.filter(routeId => ROUTE_IDS.has(routeId));
      if (activeModels.length !== models.length) {
        draft.allowedModels[levelId] = activeModels;
        changed = true;
      }
    }
    if (changed) {
      draft.odrl = this._buildOdrl(draft.version, draft.levelDefinitions, draft.environmentDefinitions, draft.allowedModels, draft.allowedTools, draft.allowedEnvironments);
      this._validatePolicy(draft);
      this.store.save('policy-draft', draft);
    }
    return draft;
  }

  _loadSettings() {
    const saved = this.store.load('settings', null);
    const defaults = this._defaultSettings();
    const next = this._clone(defaults);
    if (saved?.routes) {
      const activeRoutes = Array.isArray(saved.routes)
        ? saved.routes.filter(config => ROUTE_IDS.has(config?.id ?? config?.routeId))
        : Object.fromEntries(Object.entries(saved.routes).filter(([routeId]) => ROUTE_IDS.has(routeId)));
      const entries = Array.isArray(activeRoutes) ? activeRoutes : Object.entries(activeRoutes).map(([id, config]) => ({ ...config, id }));
      // Endpoint, geography and the simulation flag are fixed by deployment; only name/model/enabled persist.
      this._applyRouteSettings(next, entries.map(config => {
        const { baseUrl, geography, simulated, kind, ...retained } = config;
        return retained;
      }));
    }
    if (saved?.preferences) {
      for (const preference of Object.keys(next.preferences)) {
        if (ROUTE_IDS.has(saved.preferences[preference])) {
          next.preferences[preference] = saved.preferences[preference];
        }
      }
    }
    this._validateSettings(next);
    this.store.save('settings', next);
    return next;
  }

  _loadCredentialBook() {
    const saved = this.store.load('credentials', null);
    const book = new Map();
    if (saved && Array.isArray(saved.items)) {
      for (const entry of saved.items) {
        if (!this.store.verify(entry) || !entry?.payload || entry.payload.issuer !== CREDENTIAL_ISSUER) {
          throw new Error('Invalid credential record');
        }
        const version = Number(entry.payload.policyVersion);
        if (!book.has(version)) {
          book.set(version, []);
        }
        book.get(version).push(entry);
      }
    }
    if (saved?.status) {
      if (!this.store.verify(saved.status) || !saved.status.payload || !Array.isArray(saved.status.payload.entries)) {
        throw new Error('Invalid credential status book');
      }
      this._credentialStatus = new Map(saved.status.payload.entries);
    } else {
      this._credentialStatus = new Map();
    }
    this._credentialBook = book;
    if (!saved) {
      const policy = this.active();
      if (policy) {
        this._issueCredentialsForPolicy(policy.payload);
      }
    }
    this._persistCredentials();
    return book;
  }

  _loadChatBook() {
    const saved = this.store.load('chats', []);
    return Array.isArray(saved) ? saved.map(chat => ({ ...chat, busy: false })) : [];
  }

  _persistChats() {
    this.store.save('chats', this._chatBook);
  }

  _persistCredentials() {
    const items = [];
    for (const entries of this._credentialBook.values()) {
      for (const entry of entries) {
        items.push(entry);
      }
    }
    this.store.save('credentials', {
      items,
      status: this.store.seal({ entries: [...this._credentialStatus.entries()] }),
    });
  }

  _persistCredentialStatus() {
    this._persistCredentials();
  }

  _issueCredentialsForPolicy(policy) {
    const issued = PARTICIPANTS.map((participant) => this._sealCredential({
      credentialId: `cred-${policy.version}-${participant.id}`,
      participantId: participant.id,
      participantLabel: participant.label,
      participantKind: participant.kind,
      policyVersion: policy.version,
      policyDigest: this._policyDigest(policy),
      claims: ['saw-policy', 'accepted-policy', 'commitment-to-behave'],
      issuer: CREDENTIAL_ISSUER,
      issuedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + CREDENTIAL_TTL_MS).toISOString(),
      status: 'active',
      revoked: false,
      demo: true,
    }));
    this._credentialBook.set(policy.version, issued);
    this._persistCredentials();
    return issued;
  }

  _sealCredential(payload) {
    const sealed = this.store.seal(payload);
    return sealed;
  }

  _decorateCredential(entry) {
    const revoked = this._credentialStatus.get(this._credentialKey(entry.payload.participantId, entry.payload.policyVersion)) ?? false;
    return { ...this._clone(entry), revoked };
  }

  policyFor(chat) {
    return this._policyForChat(this._stateForChat(chat));
  }

  _policyView(policyOrChat = this.active()) {
    const policy = this._policyPayload(policyOrChat);
    const levelDefinitions = this._levelDefinitions(policy);
    const environmentDefinitions = this._environmentDefinitions(policy);
    return {
      policy,
      levelDefinitions,
      environmentDefinitions,
      levelById: new Map(levelDefinitions.map((definition) => [definition.id, definition])),
      levelByName: new Map(levelDefinitions.map((definition) => [definition.name, definition])),
      environmentById: new Map(environmentDefinitions.map((definition) => [definition.id, definition])),
      environmentByName: new Map(environmentDefinitions.map((definition) => [definition.name, definition])),
    };
  }

  _policyPayload(policyOrChat) {
    if (!policyOrChat) {
      return this.active()?.payload ?? this._createDefaultPolicy(1);
    }
    if (policyOrChat.payload && policyOrChat.digest) {
      return policyOrChat.payload;
    }
    if (Object.prototype.hasOwnProperty.call(policyOrChat, 'policyVersion') && Object.prototype.hasOwnProperty.call(policyOrChat, 'policyDigest')) {
      return this._policyForChat(policyOrChat).payload;
    }
    return policyOrChat;
  }

  _createDefaultLevelDefinitions() {
    return LEVELS.map((level) => ({ id: level, name: level, baseLevel: level }));
  }

  _createDefaultEnvironmentDefinitions() {
    return ENVIRONMENTS.map((environment) => ({ id: environment, name: environment, baseEnvironment: environment }));
  }

  _levelDefinitions(policy) {
    const source = Array.isArray(policy?.levelDefinitions)
      ? policy.levelDefinitions
      : Array.isArray(policy?.levels)
        ? policy.levels
        : this._createDefaultLevelDefinitions();
    return this._normalizeDefinitions(source, this._createDefaultLevelDefinitions(), 'level', 'baseLevel');
  }

  _environmentDefinitions(policy) {
    const source = Array.isArray(policy?.environmentDefinitions)
      ? policy.environmentDefinitions
      : Array.isArray(policy?.environments)
        ? policy.environments
        : Array.isArray(policy?.envDefinitions)
          ? policy.envDefinitions
          : this._createDefaultEnvironmentDefinitions();
    return this._normalizeDefinitions(source, this._createDefaultEnvironmentDefinitions(), 'environment', 'baseEnvironment');
  }

  _normalizeDefinitions(sourceDefinitions, fallbackDefinitions, kind, baseField) {
    const definitions = [];
    const seenIds = new Set();
    const seenAliases = new Set();
    const source = Array.isArray(sourceDefinitions) ? sourceDefinitions : [];
    const fallbackById = new Map(fallbackDefinitions.map((definition) => [definition.id, definition]));

    if (source.length === 0) {
      return fallbackDefinitions.map((definition) => this._clone(definition));
    }
    if (source.length > MAX_DEFINITIONS) {
      throw new Error(`Too many ${kind} definitions`);
    }

    for (const item of source) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`Invalid ${kind} definition`);
      }
      const id = this._assertDefinitionId(item.id, kind);
      const name = this._assertBoundedText(item.name ?? item.id, `${kind} name`, 80);
      const baseValue = this._assertBaseValue(item[baseField], baseField);
      if (seenIds.has(id) || seenAliases.has(id) || seenAliases.has(name)) {
        throw new Error(`Duplicate ${kind} id: ${id}`);
      }
      if (seenAliases.has(name)) {
        throw new Error(`Duplicate ${kind} name: ${name}`);
      }
      if (kind === 'level' && LEGACY_LEVEL_IDS.has(id) && id !== baseValue) {
        throw new Error(`Mandatory level base mismatch: ${id}`);
      }
      if (kind === 'environment' && LEGACY_ENVIRONMENT_IDS.has(id) && id !== baseValue) {
        throw new Error(`Mandatory environment base mismatch: ${id}`);
      }
      if (!fallbackById.has(baseValue) && !LEGACY_LEVEL_IDS.has(baseValue) && !LEGACY_ENVIRONMENT_IDS.has(baseValue)) {
        throw new Error(`Unknown ${baseField}: ${baseValue}`);
      }
      definitions.push(kind === 'level' ? { id, name, baseLevel: baseValue } : { id, name, baseEnvironment: baseValue });
      seenIds.add(id);
      seenAliases.add(id);
      seenAliases.add(name);
    }

    for (const definition of fallbackDefinitions) {
      if (!seenIds.has(definition.id)) {
        if (seenAliases.has(definition.id) || seenAliases.has(definition.name)) {
          throw new Error(`Duplicate ${kind} name: ${definition.name}`);
        }
        definitions.push(this._clone(definition));
        seenIds.add(definition.id);
        seenAliases.add(definition.id);
        seenAliases.add(definition.name);
      }
    }

    if (definitions.length > MAX_DEFINITIONS) {
      throw new Error(`Too many ${kind} definitions`);
    }
    return definitions;
  }

  _assertDefinitionId(id, kind) {
    const text = String(id ?? '').trim();
    if (!text) {
      throw new Error(`Missing ${kind} id`);
    }
    if (LEGACY_LEVEL_IDS.has(text) || LEGACY_ENVIRONMENT_IDS.has(text)) {
      return text;
    }
    if (!LEVEL_ID_PATTERN.test(text)) {
      throw new Error(`Invalid ${kind} id: ${text}`);
    }
    return text;
  }

  _assertBaseValue(value, field) {
    const text = String(value ?? '').trim();
    if (!text) {
      throw new Error(`Missing ${field}`);
    }
    if (!BASE_LEVEL_RANK.has(text) && !BASE_ENVIRONMENT_RANK.has(text)) {
      throw new Error(`Unknown ${field}: ${text}`);
    }
    return text;
  }

  _levelDefinition(policy, levelId) {
    const view = this._policyView(policy);
    return view.levelById.get(this._resolveLevelId(levelId, view)) ?? view.levelDefinitions[0];
  }

  _environmentDefinition(policy, environmentId) {
    const view = this._policyView(policy);
    return view.environmentById.get(this._resolveEnvironmentId(environmentId, view)) ?? view.environmentDefinitions[0];
  }

  _resolveLevelId(level, viewOrPolicy) {
    const view = viewOrPolicy?.levelById instanceof Map ? viewOrPolicy : this._policyView(viewOrPolicy);
    const text = String(level ?? '').trim();
    if (view.levelById.has(text)) {
      return text;
    }
    const byName = view.levelByName.get(text);
    if (byName) {
      return byName.id;
    }
    if (LEGACY_LEVEL_IDS.has(text)) {
      return text;
    }
    throw new Error(`Unknown confidentiality level: ${text}`);
  }

  _resolveEnvironmentId(environment, viewOrPolicy) {
    const view = viewOrPolicy?.environmentById instanceof Map ? viewOrPolicy : this._policyView(viewOrPolicy);
    const text = String(environment ?? '').trim();
    if (view.environmentById.has(text)) {
      return text;
    }
    const byName = view.environmentByName.get(text);
    if (byName) {
      return byName.id;
    }
    if (LEGACY_ENVIRONMENT_IDS.has(text)) {
      return text;
    }
    throw new Error(`Unknown sovereignty: ${text}`);
  }

  _baseLevelId(level, policyOrChat) {
    const view = this._policyView(policyOrChat);
    const definition = view.levelById.get(this._resolveLevelId(level, view));
    return definition?.baseLevel ?? 'Public';
  }

  _baseEnvironmentId(environment, policyOrChat) {
    const view = this._policyView(policyOrChat);
    const definition = view.environmentById.get(this._resolveEnvironmentId(environment, view));
    return definition?.baseEnvironment ?? 'Public cloud';
  }

  _baseLevelRank(level) {
    return BASE_LEVEL_RANK.get(level) ?? 0;
  }

  _baseEnvironmentRank(environment) {
    return BASE_ENVIRONMENT_RANK.get(environment) ?? 0;
  }

  _rankLevel(level, policyOrChat) {
    return this._baseLevelRank(this._baseLevelId(level, policyOrChat));
  }

  _rankSovereignty(environment, policyOrChat) {
    return this._baseEnvironmentRank(this._baseEnvironmentId(environment, policyOrChat));
  }

  _canonicalLevelIdForRank(rank) {
    return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, rank))];
  }

  _canonicalEnvironmentIdForRank(rank) {
    return ENVIRONMENTS[Math.max(0, Math.min(ENVIRONMENTS.length - 1, rank))];
  }

  _matrixForPolicy(policy, field, view) {
    const source = policy && typeof policy === 'object' && policy[field] && typeof policy[field] === 'object' ? policy[field] : {};
    const result = {};
    const alias = new Map();
    for (const definition of view.levelDefinitions) {
      alias.set(definition.id, definition.id);
      alias.set(definition.name, definition.id);
      if (definition.baseLevel) {
        alias.set(definition.baseLevel, definition.id);
      }
    }
    for (const definition of view.environmentDefinitions) {
      alias.set(definition.id, definition.id);
      alias.set(definition.name, definition.id);
      if (definition.baseEnvironment) {
        alias.set(definition.baseEnvironment, definition.id);
      }
    }
    for (const definition of view.levelDefinitions) {
      const keys = [definition.id, definition.name, definition.baseLevel];
      let entries = [];
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          entries = source[key];
          break;
        }
      }
      if (entries === undefined) {
        entries = [];
      }
      if (!Array.isArray(entries)) {
        throw new Error(`Invalid ${field} matrix for ${definition.id}`);
      }
      result[definition.id] = entries.map((entry) => String(entry));
    }
    if (field === 'allowedModels' || field === 'allowedTools' || field === 'allowedEnvironments') {
      for (const key of Object.keys(source)) {
        if (!alias.has(key)) {
          throw new Error(`Unknown ${field} level: ${key}`);
        }
      }
    }
    return result;
  }

  _allowedEntries(policy, field, level) {
    const view = this._policyView(policy);
    const resolved = this._resolveLevelId(level, view);
    const matrix = policy?.[field] && typeof policy[field] === 'object' ? policy[field] : {};
    const entries = matrix[resolved];
    if (Array.isArray(entries)) {
      return entries;
    }
    return [];
  }

  _policyDraftFromOdrl(document, basePolicy) {
    const wrapper = document && typeof document === 'object' && !Array.isArray(document) && Object.prototype.hasOwnProperty.call(document, 'odrl')
      ? document
      : { odrl: document };
    const odrl = wrapper.odrl && typeof wrapper.odrl === 'object' ? wrapper.odrl : wrapper;
    const base = this._policyView(basePolicy);
    const parsed = this._parseOdrlPolicy(odrl, base);
    const name = this._assertBoundedText(wrapper.name ?? base.policy.name ?? 'Cumulus Granitus enterprise governance', 'policy name', 120);
    return {
      ...base.policy,
      ...parsed,
      name,
    };
  }

  _parseOdrlPolicy(odrl, baseView) {
    if (!odrl || typeof odrl !== 'object' || Array.isArray(odrl)) {
      throw new Error('Invalid ODRL document');
    }
    const allowedRootKeys = new Set(['@context', '@type', 'uid', 'profile', 'policyVersion', 'permission', 'prohibition', 'obligation', 'cg:levelDefinitions', 'cg:environmentDefinitions', 'cg']);
    for (const key of Object.keys(odrl)) {
      if (!allowedRootKeys.has(key)) {
        throw new Error(`Unsupported ODRL field: ${key}`);
      }
    }
    if (odrl.cg !== undefined) {
      if (!odrl.cg || typeof odrl.cg !== 'object' || Array.isArray(odrl.cg)) {
        throw new Error('Unsupported ODRL metadata');
      }
      for (const key of Object.keys(odrl.cg)) {
        if (key !== 'levelDefinitions' && key !== 'environmentDefinitions') {
          throw new Error(`Unsupported ODRL metadata field: ${key}`);
        }
      }
    }
    if (!this._sameObject(odrl['@context'], ['http://www.w3.org/ns/odrl.jsonld', { cg: 'urn:cg-demo:' }])) {
      throw new Error('Unsupported ODRL context');
    }
    if (odrl['@type'] !== 'Set' || typeof odrl.uid !== 'string' || !odrl.uid.startsWith('urn:cg-demo:policy:')) {
      throw new Error('Unsupported ODRL profile');
    }
    if (odrl.profile !== 'urn:cg-demo:odrl-profile:enterprise-agent-governance') {
      throw new Error('Unsupported ODRL profile');
    }
    if (!Array.isArray(odrl.permission) || !Array.isArray(odrl.prohibition) || !Array.isArray(odrl.obligation)) {
      throw new Error('Unsupported ODRL shape');
    }
    const levelDefinitions = this._parseOdrlDefinitions(odrl['cg:levelDefinitions'] ?? odrl?.cg?.levelDefinitions, baseView.levelDefinitions, 'level', 'baseLevel');
    const environmentDefinitions = this._parseOdrlDefinitions(odrl['cg:environmentDefinitions'] ?? odrl?.cg?.environmentDefinitions, baseView.environmentDefinitions, 'environment', 'baseEnvironment');
    const allowedModels = this._blankMatrix(levelDefinitions);
    const allowedTools = this._blankMatrix(levelDefinitions);
    const allowedEnvironments = this._blankMatrix(levelDefinitions);

    for (const permission of odrl.permission) {
      const parsed = this._parseOdrlPermission(permission, levelDefinitions, environmentDefinitions);
      if (parsed.kind === 'model') {
        allowedModels[parsed.levelId].push(parsed.entryId);
      } else if (parsed.kind === 'tool') {
        allowedTools[parsed.levelId].push(parsed.entryId);
      } else {
        allowedEnvironments[parsed.levelId].push(parsed.entryId);
      }
    }

    const hasPublicSendDeny = this._parseOdrlProhibitions(odrl.prohibition);
    if (hasPublicSendDeny) {
      allowedTools.Public = allowedTools.Public.filter((entry) => entry !== 'public_send');
    }

    const nextVersion = (baseView.policy.version ?? 0) + 1;
    if (odrl.policyVersion !== undefined && Number(odrl.policyVersion) !== nextVersion) {
      throw new Error('Unsupported ODRL version');
    }
    if (odrl.uid !== `urn:cg-demo:policy:${nextVersion}`) {
      throw new Error('Unsupported ODRL profile');
    }

    return {
      version: nextVersion,
      levelDefinitions,
      environmentDefinitions,
      allowedModels,
      allowedTools,
      allowedEnvironments,
      obligations: this._parseOdrlObligations(odrl.obligation),
      odrl: this._buildOdrl(nextVersion, levelDefinitions, environmentDefinitions, allowedModels, allowedTools, allowedEnvironments),
    };
  }

  _parseOdrlDefinitions(definitions, fallbackDefinitions, kind, baseField) {
    if (definitions === undefined) {
      return fallbackDefinitions.map((definition) => this._clone(definition));
    }
    if (!Array.isArray(definitions) || definitions.length > MAX_DEFINITIONS) {
      throw new Error(`Unsupported ${kind} definitions`);
    }
    return this._normalizeDefinitions(definitions, fallbackDefinitions, kind, baseField);
  }

  _parseOdrlPermission(permission, levelDefinitions, environmentDefinitions) {
    if (!permission || typeof permission !== 'object' || Array.isArray(permission)) {
      throw new Error('Unsupported ODRL permission');
    }
    for (const key of Object.keys(permission)) {
      if (!['target', 'action', 'constraint', 'duty'].includes(key)) {
        throw new Error(`Unsupported ODRL permission field: ${key}`);
      }
    }
    if (permission.action !== 'use') {
      throw new Error('Unsupported ODRL permission action');
    }
    if (!Array.isArray(permission.constraint) || permission.constraint.length !== 2) {
      throw new Error('Unsupported ODRL permission constraints');
    }
    if (!Array.isArray(permission.duty) || permission.duty.length !== 1 || permission.duty[0]?.action !== 'cg:sign') {
      throw new Error('Unsupported ODRL permission duty');
    }
    for (const constraint of permission.constraint) {
      if (!constraint || typeof constraint !== 'object' || Array.isArray(constraint)) {
        throw new Error('Unsupported ODRL constraint');
      }
      for (const key of Object.keys(constraint)) {
        if (!['leftOperand', 'operator', 'rightOperand'].includes(key)) {
          throw new Error(`Unsupported ODRL constraint field: ${key}`);
        }
      }
    }
    for (const duty of permission.duty) {
      if (!duty || typeof duty !== 'object' || Array.isArray(duty)) {
        throw new Error('Unsupported ODRL duty');
      }
      for (const key of Object.keys(duty)) {
        if (key !== 'action') {
          throw new Error(`Unsupported ODRL duty field: ${key}`);
        }
      }
    }
    const target = String(permission.target ?? '');
    const pair = new Map(permission.constraint.map((constraint) => [constraint.leftOperand, constraint]));
    const confidentiality = pair.get('cg:confidentiality');
    if (!confidentiality || confidentiality.operator !== 'eq') {
      throw new Error('Unsupported ODRL confidentiality constraint');
    }
    if (target === 'cg:model/id') {
      const match = pair.get('cg:model');
      if (!match || match.operator !== 'eq') {
        throw new Error('Unsupported ODRL model constraint');
      }
      return { kind: 'model', levelId: this._resolveDefinitionByName(confidentiality.rightOperand, levelDefinitions, 'level'), entryId: String(match.rightOperand) };
    }
    if (target === 'cg:tool/id') {
      const match = pair.get('cg:tool');
      if (!match || match.operator !== 'eq') {
        throw new Error('Unsupported ODRL tool constraint');
      }
      return { kind: 'tool', levelId: this._resolveDefinitionByName(confidentiality.rightOperand, levelDefinitions, 'level'), entryId: String(match.rightOperand) };
    }
    if (target === 'cg:environment/name') {
      const match = pair.get('cg:environment');
      if (!match || match.operator !== 'eq') {
        throw new Error('Unsupported ODRL environment constraint');
      }
      return { kind: 'environment', levelId: this._resolveDefinitionByName(confidentiality.rightOperand, levelDefinitions, 'level'), entryId: this._resolveDefinitionByName(match.rightOperand, environmentDefinitions, 'environment') };
    }
    throw new Error('Unsupported ODRL target');
  }

  _parseOdrlProhibitions(prohibitions) {
    let denyPublicSend = false;
    for (const prohibition of prohibitions) {
      if (!prohibition || typeof prohibition !== 'object' || Array.isArray(prohibition)) {
        throw new Error('Unsupported ODRL prohibition');
      }
      for (const key of Object.keys(prohibition)) {
        if (!['target', 'action', 'constraint'].includes(key)) {
          throw new Error(`Unsupported ODRL prohibition field: ${key}`);
        }
      }
      if (prohibition.target === 'cg:tool/public_send' && prohibition.action === 'use') {
        const constraints = Array.isArray(prohibition.constraint) ? prohibition.constraint : [];
        if (constraints.length !== 1) {
          throw new Error('Unsupported ODRL prohibition constraints');
        }
        const constraint = constraints[0];
        if (!constraint || typeof constraint !== 'object' || Array.isArray(constraint)) {
          throw new Error('Unsupported ODRL prohibition constraint');
        }
        for (const key of Object.keys(constraint)) {
          if (!['leftOperand', 'operator', 'rightOperand'].includes(key)) {
            throw new Error(`Unsupported ODRL prohibition constraint field: ${key}`);
          }
        }
        if (constraint.leftOperand !== 'cg:confidentiality' || constraint.operator !== 'eq' || constraint.rightOperand !== 'Public') {
          throw new Error('Unsupported ODRL prohibition constraint');
        }
        denyPublicSend = true;
        continue;
      }
      throw new Error('Unsupported ODRL prohibition');
    }
    return denyPublicSend;
  }

  _parseOdrlObligations(obligations) {
    for (const obligation of obligations) {
      if (!obligation || typeof obligation !== 'object' || Array.isArray(obligation)) {
        throw new Error('Unsupported ODRL obligation');
      }
      for (const key of Object.keys(obligation)) {
        if (key !== 'action') {
          throw new Error(`Unsupported ODRL obligation field: ${key}`);
        }
      }
    }
    const actions = obligations.map((item) => item?.action);
    const allowed = new Set(['cg:sign', 'cg:log', 'cg:acceptPolicy']);
    if (actions.length !== 3 || !actions.every((action) => allowed.has(action)) || actions[0] !== 'cg:sign' || actions[1] !== 'cg:log' || actions[2] !== 'cg:acceptPolicy') {
      throw new Error('Unsupported ODRL obligations');
    }
    return ['sign', 'log', 'acceptPolicy'];
  }

  _resolveDefinitionByName(value, definitions, kind) {
    const text = String(value ?? '').trim();
    const match = definitions.find((definition) => definition.id === text || definition.name === text);
    if (!match) {
      throw new Error(`Unknown ${kind} reference: ${text}`);
    }
    return match.id;
  }

  _blankMatrix(definitions) {
    return Object.fromEntries(definitions.map((definition) => [definition.id, []]));
  }

  _createDefaultPolicy(version) {
    const levelDefinitions = this._createDefaultLevelDefinitions();
    const environmentDefinitions = this._createDefaultEnvironmentDefinitions();
    const allowedModels = {
      Public: ['global'],
      Internal: ['eu'],
      'Highly Confidential': ['onprem'],
    };
    const allowedTools = {
      Public: ['weather', 'public_send'],
      Internal: [],
      'Highly Confidential': ['sales'],
    };
    const allowedEnvironments = {
      Public: ['Public cloud'],
      Internal: ['EU-only'],
      'Highly Confidential': ['On-premises'],
    };
    return {
      version,
      name: 'Cumulus Granitus enterprise governance',
      levelDefinitions,
      levels: this._clone(levelDefinitions),
      environmentDefinitions,
      environments: this._clone(environmentDefinitions),
      envDefinitions: this._clone(environmentDefinitions),
      allowedModels,
      allowedTools,
      allowedEnvironments,
      obligations: ['sign', 'log', 'acceptPolicy'],
      odrl: this._buildOdrl(version, levelDefinitions, environmentDefinitions, allowedModels, allowedTools, allowedEnvironments),
    };
  }

  _createDraftFromActive() {
    const active = this.active() ?? this.store.seal(this._createDefaultPolicy(1));
    const baseView = this._policyView(active.payload);
    const nextVersion = baseView.policy.version + 1;
    const allowedModels = this._mergeMatrix(baseView.levelDefinitions, baseView.policy.allowedModels ?? {}, null, 'allowedModels');
    const allowedTools = this._mergeMatrix(baseView.levelDefinitions, baseView.policy.allowedTools ?? {}, null, 'allowedTools');
    const allowedEnvironments = this._mergeMatrix(baseView.levelDefinitions, baseView.policy.allowedEnvironments ?? {}, null, 'allowedEnvironments');
    const nextPolicy = {
      ...this._clone(baseView.policy),
      version: nextVersion,
      levelDefinitions: baseView.levelDefinitions,
      levels: this._clone(baseView.levelDefinitions),
      environmentDefinitions: baseView.environmentDefinitions,
      environments: this._clone(baseView.environmentDefinitions),
      envDefinitions: this._clone(baseView.environmentDefinitions),
      allowedModels,
      allowedTools: {
        ...allowedTools,
        Public: (allowedTools.Public ?? []).filter((toolId) => toolId !== 'public_send'),
      },
      allowedEnvironments,
    };
    nextPolicy.odrl = this._buildOdrl(nextVersion, nextPolicy.levelDefinitions, nextPolicy.environmentDefinitions, nextPolicy.allowedModels, nextPolicy.allowedTools, nextPolicy.allowedEnvironments);
    return nextPolicy;
  }

  _normalizePolicyDraft(value, basePolicy) {
    const source = value && typeof value === 'object' ? value : {};
    const allowedKeys = new Set(['version', 'name', 'levelDefinitions', 'levels', 'environmentDefinitions', 'environments', 'envDefinitions', 'allowedModels', 'allowedTools', 'allowedEnvironments', 'obligations', 'odrl']);
    for (const key of Object.keys(source)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`Unknown policy field: ${key}`);
      }
    }
    const baseView = this._policyView(basePolicy);
    const levelDefinitions = this._normalizeDefinitions(source.levelDefinitions ?? source.levels ?? baseView.levelDefinitions, baseView.levelDefinitions, 'level', 'baseLevel');
    const environmentDefinitions = this._normalizeDefinitions(source.environmentDefinitions ?? source.environments ?? source.envDefinitions ?? baseView.environmentDefinitions, baseView.environmentDefinitions, 'environment', 'baseEnvironment');
    const allowedModels = this._mergeMatrix(levelDefinitions, baseView.policy.allowedModels ?? {}, source.allowedModels, 'allowedModels');
    const allowedTools = this._mergeMatrix(levelDefinitions, baseView.policy.allowedTools ?? {}, source.allowedTools, 'allowedTools');
    const allowedEnvironments = this._mergeMatrix(levelDefinitions, baseView.policy.allowedEnvironments ?? {}, source.allowedEnvironments, 'allowedEnvironments');
    const merged = {
      ...this._clone(baseView.policy),
      ...this._clone(source),
      levelDefinitions,
      levels: this._clone(levelDefinitions),
      environmentDefinitions,
      environments: this._clone(environmentDefinitions),
      envDefinitions: this._clone(environmentDefinitions),
      allowedModels,
      allowedTools,
      allowedEnvironments,
    };
    const activeVersion = this.active()?.payload?.version ?? baseView.policy.version ?? 0;
    const expectedVersion = activeVersion + 1;
    if (source.version !== undefined && Number(source.version) !== expectedVersion) {
      throw new Error('Draft version must be active version + 1');
    }
    merged.version = expectedVersion;
    merged.name = this._assertBoundedText(source.name ?? baseView.policy.name ?? 'Cumulus Granitus enterprise governance', 'policy name', 120);
    merged.odrl = this._buildOdrl(merged.version, merged.levelDefinitions, merged.environmentDefinitions, merged.allowedModels, merged.allowedTools, merged.allowedEnvironments);
    if (source.odrl && !this._sameObject(source.odrl, merged.odrl)) {
      throw new Error('Draft ODRL must match the generated constrained profile');
    }
    this._validatePolicy(merged);
    return merged;
  }

  _buildOdrl(version, levelDefinitions, environmentDefinitions, allowedModels, allowedTools, allowedEnvironments) {
    const permission = [
      ...this._odrlPermissions('cg:model/id', levelDefinitions, allowedModels, 'cg:model'),
      ...this._odrlPermissions('cg:tool/id', levelDefinitions, allowedTools, 'cg:tool'),
      ...this._odrlPermissions('cg:environment/name', levelDefinitions, allowedEnvironments, 'cg:environment'),
    ];
    const prohibition = [];
    if (!(allowedTools.Public ?? []).includes('public_send')) {
      prohibition.push({
        target: 'cg:tool/public_send',
        action: 'use',
        constraint: [{ leftOperand: 'cg:confidentiality', operator: 'eq', rightOperand: 'Public' }],
      });
    }
    return {
      '@context': ['http://www.w3.org/ns/odrl.jsonld', { cg: 'urn:cg-demo:' }],
      '@type': 'Set',
      uid: `urn:cg-demo:policy:${version}`,
      profile: 'urn:cg-demo:odrl-profile:enterprise-agent-governance',
      policyVersion: version,
      'cg:levelDefinitions': levelDefinitions.map((definition) => this._clone(definition)),
      'cg:environmentDefinitions': environmentDefinitions.map((definition) => this._clone(definition)),
      cg: {
        levelDefinitions: levelDefinitions.map((definition) => this._clone(definition)),
        environmentDefinitions: environmentDefinitions.map((definition) => this._clone(definition)),
      },
      permission,
      prohibition,
      obligation: [
        { action: 'cg:sign' },
        { action: 'cg:log' },
        { action: 'cg:acceptPolicy' },
      ],
    };
  }

  _odrlPermissions(target, levelDefinitions, matrix, operand) {
    return levelDefinitions.flatMap((definition) => (matrix[definition.id] ?? []).map((entry) => ({
      target,
      action: 'use',
      constraint: [
        { leftOperand: 'cg:confidentiality', operator: 'eq', rightOperand: definition.id },
        { leftOperand: operand, operator: 'eq', rightOperand: String(entry) },
      ],
      duty: [{ action: 'cg:sign' }],
    })));
  }

  _mergeMatrix(definitions, base, override, label) {
    const result = {};
    const source = override && typeof override === 'object' ? override : {};
    const baseSource = base && typeof base === 'object' ? base : {};
    const aliases = new Set();
    for (const definition of definitions) {
      aliases.add(definition.id);
      aliases.add(definition.name);
      if (definition.baseLevel) {
        aliases.add(definition.baseLevel);
      }
      if (definition.baseEnvironment) {
        aliases.add(definition.baseEnvironment);
      }
    }
    for (const definition of definitions) {
      let entries;
      if (Object.prototype.hasOwnProperty.call(source, definition.id)) {
        entries = source[definition.id];
      } else if (Object.prototype.hasOwnProperty.call(source, definition.name)) {
        entries = source[definition.name];
      } else if (Object.prototype.hasOwnProperty.call(source, definition.baseLevel ?? definition.baseEnvironment)) {
        entries = source[definition.baseLevel ?? definition.baseEnvironment];
      } else if (Object.prototype.hasOwnProperty.call(baseSource, definition.id)) {
        entries = baseSource[definition.id];
      } else if (Object.prototype.hasOwnProperty.call(baseSource, definition.name)) {
        entries = baseSource[definition.name];
      } else if (Object.prototype.hasOwnProperty.call(baseSource, definition.baseLevel ?? definition.baseEnvironment)) {
        entries = baseSource[definition.baseLevel ?? definition.baseEnvironment];
      } else {
        entries = [];
      }
      if (!Array.isArray(entries)) {
        throw new Error(`Invalid ${label} matrix for ${definition.id}`);
      }
      result[definition.id] = entries.map((item) => String(item));
    }
    for (const key of Object.keys(source)) {
      if (!aliases.has(key)) {
        throw new Error(`Unknown ${label} level: ${key}`);
      }
    }
    return result;
  }

  _validatePolicy(policy, modelIds = ROUTE_IDS) {
    const view = this._policyView(policy);
    if (view.levelDefinitions.length > MAX_DEFINITIONS || view.environmentDefinitions.length > MAX_DEFINITIONS) {
      throw new Error('Policy definitions are out of bounds');
    }
    if (!Array.isArray(policy.obligations)) {
      throw new Error('Policy obligations are incomplete');
    }
    const allowedObligations = new Set(['sign', 'log', 'acceptPolicy']);
    for (const obligation of policy.obligations) {
      if (!allowedObligations.has(obligation)) {
        throw new Error(`Unknown obligation: ${obligation}`);
      }
    }
    for (const required of allowedObligations) {
      if (!policy.obligations.includes(required)) {
        throw new Error('Policy obligations are incomplete');
      }
    }
    const toolIds = new Set(['weather', 'sales', 'public_send']);
    const environmentIds = new Set(ENVIRONMENTS);
    for (const definition of view.levelDefinitions) {
      if (!BASE_LEVEL_RANK.has(definition.baseLevel)) {
        throw new Error(`Unknown level baseline: ${definition.baseLevel}`);
      }
      if (LEGACY_LEVEL_IDS.has(definition.id) && definition.baseLevel !== definition.id) {
        throw new Error(`Mandatory level base mismatch: ${definition.id}`);
      }
      if (definition.id !== definition.baseLevel) {
        const baselineModels = this._allowedEntries(policy, 'allowedModels', definition.baseLevel);
        const baselineTools = this._allowedEntries(policy, 'allowedTools', definition.baseLevel);
        const baselineEnvironments = this._allowedEntries(policy, 'allowedEnvironments', definition.baseLevel);
        for (const modelId of this._allowedEntries(policy, 'allowedModels', definition.id)) {
          if (!baselineModels.includes(modelId)) {
            throw new Error(`Custom level cannot weaken model restrictions: ${definition.id}`);
          }
        }
        for (const toolId of this._allowedEntries(policy, 'allowedTools', definition.id)) {
          if (!baselineTools.includes(toolId)) {
            throw new Error(`Custom level cannot weaken tool restrictions: ${definition.id}`);
          }
        }
        for (const environment of this._allowedEntries(policy, 'allowedEnvironments', definition.id)) {
          if (!baselineEnvironments.includes(environment)) {
            throw new Error(`Custom level cannot weaken environment restrictions: ${definition.id}`);
          }
        }
      }
    }
    for (const definition of view.environmentDefinitions) {
      if (!BASE_ENVIRONMENT_RANK.has(definition.baseEnvironment)) {
        throw new Error(`Unknown environment baseline: ${definition.baseEnvironment}`);
      }
      if (LEGACY_ENVIRONMENT_IDS.has(definition.id) && definition.baseEnvironment !== definition.id) {
        throw new Error(`Mandatory environment base mismatch: ${definition.id}`);
      }
    }
    for (const level of view.levelDefinitions) {
      for (const modelId of this._allowedEntries(policy, 'allowedModels', level.id)) {
        if (!modelIds.has(modelId)) {
          throw new Error(`Unknown model allowance: ${modelId}`);
        }
      }
      for (const toolId of this._allowedEntries(policy, 'allowedTools', level.id)) {
        if (!toolIds.has(toolId)) {
          throw new Error(`Unknown tool allowance: ${toolId}`);
        }
      }
      for (const environment of this._allowedEntries(policy, 'allowedEnvironments', level.id)) {
        if (!environmentIds.has(environment) && !view.environmentById.has(environment) && !view.environmentByName.has(environment)) {
          throw new Error(`Unknown environment allowance: ${environment}`);
        }
      }
    }
    return true;
  }


  _sanitizeSettings(settings) {
    return {
      routes: this._clone(settings.routes),
      preferences: { ...this._clone(settings.preferences) },
      euRouting: this._clone(settings.euRouting),
      secrets: {
        mistralApiKeyPresent: Boolean(settings.secrets.routeApiKeyPresent.mistral),
        routeApiKeyPresent: this._clone(settings.secrets.routeApiKeyPresent),
      },
    };
  }

  _defaultSettings() {
    const azureBase = DEFAULT_AZURE_ENDPOINT || 'https://azure-openai.invalid/openai/v1';
    const enabled = Boolean(DEFAULT_AZURE_ENDPOINT);
    // One Azure OpenAI account, three deployments. `model` is the deployment name; `geography` is
    // the governed residency; `simulated` marks a residency the cloud host cannot truly satisfy.
    const route = (id, name, model, geography, simulated) => ({
      id, kind: 'azure', name, enabled, model, baseUrl: azureBase, geography, simulated, costScore: 0,
    });
    return {
      routes: {
        global: route('global', 'Global model', 'global', 'Public cloud', false),
        eu: route('eu', 'EU model', 'eu', 'EU-only', false),
        onprem: route('onprem', 'On-premises model', 'onprem', 'On-premises', true),
      },
      preferences: {
        public: 'global',
        internal: 'eu',
        high: 'onprem',
      },
      euRouting: {
        strategy: 'cost',
        fallbackEnabled: false,
        order: [],
      },
      secrets: {
        mistralApiKeyPresent: false,
        routeApiKeyPresent: {},
      },
    };
  }

  _applyRouteSettings(target, routes) {
    const entries = Array.isArray(routes)
      ? routes.map((config) => [config?.id ?? config?.routeId, config])
      : Object.entries(routes);

    for (const [routeId, config] of entries) {
      if (!ROUTE_IDS.has(routeId)) {
        throw new Error(`Unknown route: ${routeId}`);
      }
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error(`Invalid route configuration for ${routeId}`);
      }
      const current = target.routes[routeId];
      if (config.enabled !== undefined) {
        current.enabled = Boolean(config.enabled);
      }
      if (config.model !== undefined) {
        current.model = this._assertBoundedText(config.model, `${routeId} route model`, 128);
      }
      if (config.baseUrl !== undefined) {
        this._validateRouteEndpoint(routeId, String(config.baseUrl));
        current.baseUrl = String(config.baseUrl);
      }
      if (config.name !== undefined) {
        current.name = this._assertBoundedText(config.name, `${routeId} route name`, 80);
      }
      if (config.costScore !== undefined) {
        current.costScore = this._assertCostScore(config.costScore, routeId);
      }
    }
  }

  _applyEuRoutingSettings(target, config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Invalid EU routing configuration');
    }
    if (config.strategy !== undefined) {
      target.euRouting.strategy = String(config.strategy);
    }
    if (config.fallbackEnabled !== undefined) {
      target.euRouting.fallbackEnabled = Boolean(config.fallbackEnabled);
    }
    if (config.order !== undefined) {
      if (!Array.isArray(config.order)) throw new Error('Invalid EU routing order');
      target.euRouting.order = config.order.map(routeId => String(routeId));
    }
  }

  _validateSettings(settings) {
    for (const routeId of ROUTE_IDS) {
      if (!settings.routes[routeId]) throw new Error(`Missing route configuration: ${routeId}`);
      this._validateRouteEndpoint(routeId, settings.routes[routeId].baseUrl);
    }
    for (const preference of Object.values(settings.preferences)) {
      this._assertRouteId(preference, 'route preference');
    }
    for (const route of Object.values(settings.routes)) {
      this._assertBoundedText(route.name, `${route.id} route name`, 80);
      this._assertBoundedText(route.model, `${route.id} route model`, 128);
      this._assertCostScore(route.costScore, route.id);
    }
    if (!['cost', 'priority'].includes(settings.euRouting.strategy)) {
      throw new Error(`Unknown EU routing strategy: ${settings.euRouting.strategy}`);
    }
    if (!Array.isArray(settings.euRouting.order)
      || settings.euRouting.order.length !== EU_POOL_ROUTE_IDS.length
      || new Set(settings.euRouting.order).size !== EU_POOL_ROUTE_IDS.length
      || EU_POOL_ROUTE_IDS.some(routeId => !settings.euRouting.order.includes(routeId))) {
      throw new Error('EU routing order must contain every approved EU provider exactly once');
    }
  }

  _policyForChat(chat) {
    const state = this._stateForChat(chat);
    const bundle = this._policyBundles.find((entry) => entry.payload.version === state.policyVersion);
    if (!bundle) {
      throw new Error('Pinned policy not found');
    }
    if (bundle.digest !== state.policyDigest) {
      throw new Error('Pinned policy digest mismatch');
    }
    if (!this.store.verify(bundle)) {
      throw new Error('Pinned policy signature mismatch');
    }
    return bundle;
  }

  _routeMatchesSovereignty(state, route, policyOrChat = state) {
    const policy = this._policyPayload(policyOrChat);
    // An Italy-only restriction cannot be met by any route in this demo topology.
    if (Array.isArray(state.restrictions) && state.restrictions.includes('IT')) {
      return false;
    }
    // A Germany/on-prem restriction is satisfied only by the On-premises route.
    if (state.restrictions?.includes('DE') && route.geography !== 'On-premises') return false;
    const sovereignty = this._baseEnvironmentId(state.sovereignty, policy);
    if (sovereignty === 'On-premises') {
      return route.geography === 'On-premises';
    }
    if (sovereignty === 'EU-only') {
      return route.geography === 'EU-only' || route.geography === 'On-premises';
    }
    return true;
  }

  _assertBoundedText(value, label, maxLength) {
    const text = String(value ?? '').trim();
    if (text.length === 0 || text.length > maxLength) {
      throw new Error(`${label} is out of bounds`);
    }
    return text;
  }

  _routePreference(level, policyOrChat = this.active()) {
    const baseLevel = this._baseLevelId(level, policyOrChat);
    if (baseLevel === 'Public') {
      return this._settings.preferences.public;
    }
    if (baseLevel === 'Internal') {
      return this._settings.preferences.internal;
    }
    return this._settings.preferences.high;
  }

  _decorateRoute(routeId, routeConfig, geography) {
    return {
      id: routeId,
      name: routeConfig.name,
      kind: routeConfig.kind,
      model: routeConfig.model,
      baseUrl: routeConfig.baseUrl,
      geography,
      simulated: Boolean(routeConfig.simulated),
      enabled: Boolean(routeConfig.enabled),
      costScore: routeConfig.costScore,
    };
  }

  _routeForTool(tool, chat, excludedRouteIds = []) {
    const route = this.recommendRoute(chat, excludedRouteIds);
    if (tool.sovereignty === 'On-premises' && route.geography !== 'On-premises') {
      return { allowed: false, reason: 'ON_PREM_TOOL_REQUIRES_ON_PREM_ROUTE' };
    }
    if (tool.sovereignty === 'Public cloud' && this._baseEnvironmentId(chat.sovereignty, chat) !== 'Public cloud') {
      return { allowed: false, reason: 'PUBLIC_TOOL_REQUIRES_PUBLIC_ROUTE' };
    }
    return { allowed: true, route };
  }

  _elevateChat(chat, requiredLevel, requiredSovereignty, trigger, args) {
    const policy = this._policyForChat(chat).payload;
    const before = { level: chat.level, sovereignty: chat.sovereignty };
    const nextLevel = this._maxLevel(chat.level, requiredLevel, policy);
    const nextSovereignty = this._maxSovereignty(chat.sovereignty, requiredSovereignty, policy);
    const changed = before.level !== nextLevel || before.sovereignty !== nextSovereignty;

    if (changed) {
      chat.level = nextLevel;
      chat.sovereignty = nextSovereignty;
      this._syncChatLabels(chat, policy);
      const nextBaseSovereignty = this._baseEnvironmentId(nextSovereignty, policy);
      if (nextBaseSovereignty === 'On-premises' && !chat.restrictions.includes('DE')) {
        chat.restrictions = [...chat.restrictions, 'DE'];
      }
      if (nextBaseSovereignty === 'EU-only' && !chat.restrictions.includes('EU')) {
        chat.restrictions = [...chat.restrictions, 'EU'];
      }
      this._persistChats();
    }

    return {
      changed,
      from: before,
      to: { level: nextLevel, sovereignty: nextSovereignty },
      trigger,
      args,
    };
  }

  _classifyPrompt(chat, prompt) {
    const policy = this._policyForChat(chat).payload;
    const text = String(prompt ?? '');
    const isSales = /\b(sales|contract|private|confidential)\b/i.test(text);
    const isInternal = !isSales && /\b(eu|internal)\b/i.test(text);
    const isItaly = /\bitaly\b|\bin italy\b|\bitalian\b|\bitaly-only\b/i.test(text);
    const hasGermanyConflict = /\b(germany|de)\b/i.test(text) || (Array.isArray(chat.restrictions) && chat.restrictions.some((restriction) => /de|germany/i.test(restriction)));

    if (chat.blocked || (isItaly && (hasGermanyConflict || isSales)) || (chat.restrictions?.includes('IT') && hasGermanyConflict)) {
      return {
        level: chat.level,
        sovereignty: chat.sovereignty,
        changed: false,
        trigger: 'Italy-only request conflicts with existing DE fixture',
        analysis: 'deterministic demo rules, not enterprise DLP',
        conflict: true,
        blocked: true,
      };
    }

    if (isSales) {
      return {
        level: this._maxLevel(chat.level, 'Highly Confidential', policy),
        sovereignty: this._maxSovereignty(chat.sovereignty, 'On-premises', policy),
        changed: this._rankLevel(chat.level, policy) < this._rankLevel('Highly Confidential', policy) || this._rankSovereignty(chat.sovereignty, policy) < this._rankSovereignty('On-premises', policy),
        trigger: 'sales/contract/private/confidential',
        analysis: 'deterministic demo rules, not enterprise DLP',
        conflict: false,
      };
    }

    if (isItaly) {
      const nextLevel = this._maxLevel(chat.level, 'Internal', policy);
      const nextSovereignty = this._maxSovereignty(chat.sovereignty, 'EU-only', policy);
      return {
        level: nextLevel,
        sovereignty: nextSovereignty,
        changed: this._rankLevel(chat.level, policy) < this._rankLevel('Internal', policy) || this._rankSovereignty(chat.sovereignty, policy) < this._rankSovereignty('EU-only', policy),
        trigger: 'Italy request',
        analysis: 'deterministic demo rules, not enterprise DLP',
        conflict: false,
        blocked: false,
      };
    }

    if (isInternal) {
      const nextLevel = this._maxLevel(chat.level, 'Internal', policy);
      const nextSovereignty = this._maxSovereignty(chat.sovereignty, 'EU-only', policy);
      return {
        level: nextLevel,
        sovereignty: nextSovereignty,
        changed: this._rankLevel(chat.level, policy) < this._rankLevel('Internal', policy) || this._rankSovereignty(chat.sovereignty, policy) < this._rankSovereignty('EU-only', policy),
        trigger: 'EU/internal',
        analysis: 'deterministic demo rules, not enterprise DLP',
        conflict: false,
        blocked: false,
      };
    }

    return {
      level: chat.level,
      sovereignty: chat.sovereignty,
      changed: false,
      trigger: 'inherited initial level',
      analysis: 'deterministic demo rules, not enterprise DLP',
      conflict: false,
      blocked: false,
    };
  }

  _initialSovereignty(level, policyOrChat = this.active()) {
    const baseLevel = this._baseLevelId(level, policyOrChat);
    if (baseLevel === 'Highly Confidential') {
      return 'On-premises';
    }
    if (baseLevel === 'Internal') {
      return 'EU-only';
    }
    return 'Public cloud';
  }

  _initialRestrictions(sovereignty) {
    if (sovereignty === 'On-premises') {
      return ['DE'];
    }
    if (sovereignty === 'EU-only') {
      return ['EU'];
    }
    return ['public'];
  }

  _maxLevel(left, right, policyOrChat = this.active()) {
    const policy = this._policyPayload(policyOrChat);
    const leftRank = this._rankLevel(left, policy);
    const rightRank = this._rankLevel(right, policy);
    if (leftRank >= rightRank) {
      return left;
    }
    return this._canonicalLevelIdForRank(rightRank);
  }

  _maxSovereignty(left, right, policyOrChat = this.active()) {
    const policy = this._policyPayload(policyOrChat);
    const leftRank = this._rankSovereignty(left, policy);
    const rightRank = this._rankSovereignty(right, policy);
    if (leftRank >= rightRank) {
      return left;
    }
    return this._canonicalEnvironmentIdForRank(rightRank);
  }

  _assertLevel(level, policyOrChat = this.active()) {
    return this._resolveLevelId(level, policyOrChat);
  }

  _syncChatLabels(chat, policyOrChat = this._policyForChat(chat).payload) {
    const policy = this._policyPayload(policyOrChat);
    const levelDefinition = this._levelDefinition(policy, chat.level);
    const sovereigntyDefinition = this._environmentDefinition(policy, chat.sovereignty);
    chat.levelName = levelDefinition.name;
    chat.sovereigntyName = sovereigntyDefinition.name;
    return chat;
  }

  _assertRouteId(routeId, label) {
    if (!ROUTE_IDS.has(routeId)) {
      throw new Error(`Unknown ${label}: ${routeId}`);
    }
    return routeId;
  }

  _assertRemoteRouteId(routeId) {
    if (!REMOTE_ROUTE_IDS.includes(routeId)) {
      throw new Error(`Unknown remote route: ${routeId}`);
    }
    return routeId;
  }

  _assertCostScore(value, routeId) {
    const score = Number(value);
    if (!Number.isFinite(score) || score < 0 || score > 1000000) {
      throw new Error(`Invalid cost score for ${routeId}`);
    }
    return score;
  }

  _routeSecretName(routeId) {
    this._assertRemoteRouteId(routeId);
    return `${routeId}-api-key`;
  }

  _validateRouteEndpoint(routeId, baseUrl) {
    const value = String(baseUrl);
    // Every route is an Azure OpenAI / AI Foundry deployment on the one approved account endpoint.
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Model endpoint must be a valid URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port
      || url.pathname !== '/openai/v1' || (!url.hostname.endsWith('.openai.azure.com') && url.hostname !== 'azure-openai.invalid')) {
      throw new Error('Model route requires an approved openai.azure.com HTTPS /openai/v1 endpoint.');
    }
    if (value !== (DEFAULT_AZURE_ENDPOINT || 'https://azure-openai.invalid/openai/v1')) {
      throw new Error('Model endpoint must match the configured Azure OpenAI endpoint');
    }
  }

  _sameObject(left, right) {
    const normalize = (value) => {
      if (Array.isArray(value)) {
        return value.map((item) => normalize(item));
      }
      if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((accumulator, key) => {
          accumulator[key] = normalize(value[key]);
          return accumulator;
        }, {});
      }
      return value;
    };
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
  }

  _clone(value) {
    if (typeof globalThis.structuredClone === 'function') {
      return globalThis.structuredClone(value);
    }
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  _policyDigest(policy) {
    return this.store.seal(policy).digest;
  }

  _credentialKey(participantId, policyVersion) {
    return `${participantId}:${Number(policyVersion)}`;
  }

  _stateForChat(chat) {
    const current = this._chatBook.find((entry) => entry.id === chat?.id);
    if (!current) {
      throw new Error('Chat is required');
    }
    this.currentChat = current;
    return current;
  }

  _routeError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  _decorateCredentialPayload(entry) {
    const revoked = this._credentialStatus.get(this._credentialKey(entry.payload.participantId, entry.payload.policyVersion)) ?? false;
    return { ...this._clone(entry), revoked };
  }

  _cloneCredentialBook() {
    return [...this._credentialBook.values()].flat().map((entry) => this._decorateCredentialPayload(entry));
  }
}
