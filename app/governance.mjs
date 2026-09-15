import crypto from 'node:crypto';
import { Store } from './storage.mjs';
import { SCOPE_DEFINITIONS, SCOPE_TYPES, TOOL_BY_ID, TOOLS } from './catalog.mjs';
import { DEPLOYMENT_SETTINGS } from './deployment-settings.mjs';

export { SCOPE_DEFINITIONS, SCOPE_TYPES, TOOLS } from './catalog.mjs';

export const LEVELS = [...DEPLOYMENT_SETTINGS.policy.baselineLevelIds];
export const ENVIRONMENTS = [...DEPLOYMENT_SETTINGS.policy.baselineEnvironmentIds];

const MAX_DEFINITIONS = 16;
const MAX_SCOPE_TYPES = 8;
const MAX_SCOPE_DEFINITIONS = 64;
const MAX_SCOPE_DEFINITIONS_PER_TYPE = 32;
const LEVEL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,79}$/;
const BASE_LEVEL_RANK = new Map(LEVELS.map((level, index) => [level, index]));
const BASE_ENVIRONMENT_RANK = new Map(ENVIRONMENTS.map((environment, index) => [environment, index]));
BASE_ENVIRONMENT_RANK.set('EU-only', BASE_ENVIRONMENT_RANK.get('Restricted Region'));
const ROUTE_DEFINITIONS = new Map(DEPLOYMENT_SETTINGS.models.routes.map(route => [route.id, route]));
const PRIMARY_ROUTING_POOL = DEPLOYMENT_SETTINGS.models.routingPools[0];
const EU_POOL_ROUTE_IDS = [...PRIMARY_ROUTING_POOL.routeIds];
const REMOTE_ROUTE_IDS = DEPLOYMENT_SETTINGS.models.routes.filter(route => route.apiKeySecretName).map(route => route.id);
const ROUTE_IDS = new Set(DEPLOYMENT_SETTINGS.models.routes.map(route => route.id));
const CREDENTIAL_ISSUER = DEPLOYMENT_SETTINGS.credentials.issuer;
const CREDENTIAL_TTL_MS = DEPLOYMENT_SETTINGS.credentials.validityHours * 60 * 60 * 1000;
const PARTICIPANTS = structuredClone(DEPLOYMENT_SETTINGS.credentials.participants);
const LEGACY_LEVEL_IDS = new Set(LEVELS);
const LEGACY_ENVIRONMENT_IDS = new Set([...ENVIRONMENTS, 'EU-only']);
const DEFAULT_TOOL_SCOPE_REQUIREMENTS = structuredClone(DEPLOYMENT_SETTINGS.policy.toolScopeRequirements);
const DEFAULT_ROUTE_ENVIRONMENT_DECLARATIONS = structuredClone(DEPLOYMENT_SETTINGS.policy.routeEnvironmentDeclarations);
const DEFAULT_AGENT_ID = DEPLOYMENT_SETTINGS.agents.defaultAgentId;

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

  capacity() {
    return {
      used: this._chatBook.length,
      limit: 200,
      remaining: Math.max(0, 200 - this._chatBook.length),
    };
  }

  vocabulary() {
    const view = this._policyView(this.active());
    return {
      levels: this._clone(view.levelDefinitions),
      environments: this._clone(view.environmentDefinitions),
      levelDefinitions: this._clone(view.levelDefinitions),
      environmentDefinitions: this._clone(view.environmentDefinitions),
      envDefinitions: this._clone(view.environmentDefinitions),
      scopeTypes: this._clone(view.policy.scopeTypes ?? []),
      scopeDefinitions: this._clone(view.policy.scopeDefinitions ?? []),
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
    nextPolicy.odrl = this._buildOdrl({ ...nextPolicy, version });
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid settings update');
    const allowedFields = new Set(['routes', 'preferences', 'euRouting', 'routeApiKeys', 'clearRouteApiKeys']);
    for (const field of Object.keys(body)) if (!allowedFields.has(field)) throw new Error(`Unknown settings field: ${field}`);
    const next = this._clone(this._settings);
    const pendingKeys = new Map();
    const clearedKeys = new Set();
    if (body.routes) {
      this._applyRouteSettings(next, body.routes);
    }
    if (body.preferences !== undefined) {
      if (!body.preferences || typeof body.preferences !== 'object' || Array.isArray(body.preferences)) {
        throw new Error('Invalid route preferences');
      }
      const definitions = new Map(next.preferenceDefinitions.map(preference => [preference.id, preference]));
      for (const [preferenceId, routeId] of Object.entries(body.preferences)) {
        const definition = definitions.get(preferenceId);
        if (!definition) throw new Error(`Unknown route preference: ${preferenceId}`);
        this._assertRouteId(routeId, `${preferenceId} route preference`);
        if (!definition.allowedRouteIds.includes(routeId)) throw new Error(`${routeId} is not allowed for ${preferenceId}`);
        next.preferences[preferenceId] = routeId;
      }
    }
    if (body.euRouting) {
      this._applyEuRoutingSettings(next, body.euRouting);
    }
    if (body.routeApiKeys && typeof body.routeApiKeys === 'object' && !Array.isArray(body.routeApiKeys)) {
      for (const [routeId, value] of Object.entries(body.routeApiKeys)) {
        this._assertRemoteRouteId(routeId);
        if (value !== '') {
          pendingKeys.set(routeId, value);
          clearedKeys.delete(routeId);
          next.secrets.routeApiKeyPresent[routeId] = true;
        }
      }
    }
    if (Array.isArray(body.clearRouteApiKeys)) {
      for (const routeId of body.clearRouteApiKeys) {
        this._assertRemoteRouteId(routeId);
        pendingKeys.delete(routeId);
        clearedKeys.add(routeId);
        next.secrets.routeApiKeyPresent[routeId] = false;
      }
    }
    this._validateSettings(next);
    for (const routeId of clearedKeys) {
      this.store.setSecret(this._routeSecretName(routeId), undefined);
    }
    for (const [routeId, value] of pendingKeys) {
      this.store.setSecret(this._routeSecretName(routeId), value);
    }
    this._settings = next;
    this.store.save('settings', next);
    this.store.append('settings-updated', { settings: this._sanitizeSettings(next) });
    return this.settings();
  }

  credentials(policyVersion = this.active()?.payload?.version) {
    const version = Number(policyVersion ?? this.active()?.payload?.version);
    const items = this._credentialBook.get(version) ?? [];
    return items.map((entry) => this._decorateCredential(entry));
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
    const authority = policy?.payload?.credentialAuthority;
    const claimsMatch = !authority || this._sameObject(record.payload.claims, authority.claims);
    const participantMatch = !authority || authority.participants.some(participant => participant.id === participantId && participant.kind === record.payload.participantKind);
    if (record.payload.status !== 'active' || typeof record.payload.issuer !== 'string' || !record.payload.issuer
      || (authority && (record.payload.issuer !== authority.issuer || record.payload.demo !== authority.demo || !claimsMatch || !participantMatch))) {
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

  newChat(level = DEPLOYMENT_SETTINGS.policy.initialLevelId) {
    if (this._chatBook.length >= 200) throw new Error('Demo chat capacity reached');
    this.store.assertLedgerCapacity(1);
    const policy = this.active();
    if (!policy) {
      throw new Error('No active policy');
    }
    const normalizedLevel = this._assertLevel(level, policy.payload);
    const sovereignty = this._initialSovereignty(normalizedLevel, policy.payload);
    const scoped = this._hasScopeModel(policy.payload);
    const chat = {
      id: `chat-${crypto.randomUUID()}`,
      agentId: DEFAULT_AGENT_ID,
      initialLevel: normalizedLevel,
      level: normalizedLevel,
      sovereignty,
      policyVersion: policy.payload.version,
      policyDigest: policy.digest,
      createdAt: new Date().toISOString(),
      messages: [],
      busy: false,
      routeId: null,
      restrictions: scoped ? [] : this._initialRestrictions(sovereignty),
      ...(scoped ? { scope: { partnerNetworkIds: [], enterpriseOrganizationIds: [] } } : {}),
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
      ...(scoped ? { scope: this._clone(chat.scope) } : {}),
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

  latestOwnedChat(ownerHash, policyVersion = this.active()?.payload?.version) {
    const version = Number(policyVersion);
    for (let index = this._chatBook.length - 1; index >= 0; index -= 1) {
      const chat = this._chatBook[index];
      if (chat.ownerHash === ownerHash && chat.policyVersion === version) {
        this.currentChat = chat;
        return chat;
      }
    }
    return null;
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
    this.store.assertLedgerCapacity(1);
    const policy = this._policyForChat(current).payload;
    if (this._hasScopeModel(policy)) {
      const proposal = this.planInputTransition(current, prompt);
      if (!proposal.allowed) {
        this.store.append('environment-transition-refused', {
          chatId: current.id,
          agentId: current.agentId,
          level: current.level,
          sovereignty: current.sovereignty,
          scope: this._clone(current.scope),
          policyVersion: current.policyVersion,
          policyDigest: current.policyDigest,
          prompt,
          outcome: 'denied',
          code: proposal.code,
          reason: proposal.reason,
        });
        return {
          level: current.level,
          sovereignty: current.sovereignty,
          scope: this._clone(current.scope),
          changed: false,
          trigger: proposal.reason,
          triggerSource: proposal.triggerSource,
          analysis: 'deterministic demo rules, not enterprise DLP',
          conflict: true,
          code: proposal.code,
          blocked: false,
        };
      }
      const committed = this.commitTransition(current, proposal, { kind: 'input', prompt });
      if (proposal.postCommitRefusal) {
        return {
          ...committed,
          conflict: true,
          blocked: false,
          code: proposal.postCommitRefusal.code,
          trigger: proposal.postCommitRefusal.reason,
        };
      }
      return committed;
    }
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
    const nextLevel = this._maxLevel(current.level, target.level);
    const nextSovereignty = this._maxSovereignty(current.sovereignty, target.sovereignty);
    const changed = before.level !== nextLevel || before.sovereignty !== nextSovereignty;

    current.level = nextLevel;
    current.sovereignty = nextSovereignty;
    if (nextSovereignty === ENVIRONMENTS[2] && !current.restrictions.includes('DE')) {
      current.restrictions = [...current.restrictions, 'DE'];
    }
    if (nextSovereignty === ENVIRONMENTS[1] && !current.restrictions.includes('EU')) {
      current.restrictions = [...current.restrictions, 'EU'];
    }
    if (nextSovereignty === ENVIRONMENTS[1] && target.trigger === 'Italy request' && !current.restrictions.includes('IT')) {
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

  planInputTransition(chat, prompt) {
    const state = this._stateForChat(chat);
    const policy = this._policyForChat(state).payload;
    const text = String(prompt ?? '');
    if (!this._hasScopeModel(policy)) {
      const legacy = this._classifyPrompt(state, text);
      return this._transitionProposal(state, {
        requiredLevel: legacy.level,
        requiredSovereignty: legacy.sovereignty,
        triggers: [legacy.trigger],
        triggerSource: 'legacy-classifier',
      });
    }

    let requiredLevel = state.level;
    const requiredEnvironments = [];
    const triggers = [];
    const classification = policy.classification ?? DEPLOYMENT_SETTINGS.policy.classification;
    if (this._mentionsAny(text, classification.protectedTerms)) {
      requiredLevel = this._maxLevel(requiredLevel, classification.protectedLevelId, policy);
      requiredEnvironments.push(classification.protectedEnvironmentId);
      triggers.push('confidential content');
    } else if (this._mentionsAny(text, classification.internalTerms)) {
      requiredLevel = this._maxLevel(requiredLevel, classification.internalLevelId, policy);
      requiredEnvironments.push(classification.internalEnvironmentId);
      triggers.push('internal content');
    }

    const definitions = policy.scopeDefinitions ?? [];
    const matchedDefinitions = definitions.filter((definition) => this._definitionMentioned(text, definition));
    const matchedEnvironments = this._environmentDefinitions(policy).filter((definition) => this._environmentMentioned(text, definition));
    const matchedTools = TOOLS.filter((tool) => this._toolMentioned(text, tool));
    const partnerNetworkIds = matchedDefinitions.filter((definition) => definition.type === 'partner-network').map((definition) => definition.id);
    const enterpriseOrganizationIds = matchedDefinitions.filter((definition) => definition.type === 'enterprise-organization').map((definition) => definition.id);
    requiredEnvironments.push(...matchedEnvironments.map((definition) => definition.id));

    for (const tool of matchedTools) {
      requiredLevel = this._maxLevel(requiredLevel, tool.minimumLevel, policy);
      requiredEnvironments.push(tool.sovereignty);
      const requirement = policy.toolScopeRequirements?.[tool.id] ?? tool.requiredScope;
      if (requirement?.partnerNetworkId) partnerNetworkIds.push(requirement.partnerNetworkId);
      if (requirement?.enterpriseOrganizationId) enterpriseOrganizationIds.push(requirement.enterpriseOrganizationId);
      triggers.push(tool.name);
    }

    if (partnerNetworkIds.length || enterpriseOrganizationIds.length) {
      requiredLevel = this._maxLevel(requiredLevel, classification.scopedLevelId, policy);
      triggers.push(...matchedDefinitions.map((definition) => definition.name));
    }

    const proposal = this._transitionProposal(state, {
      requiredLevel,
      environmentIds: requiredEnvironments,
      partnerNetworkIds,
      enterpriseOrganizationIds,
      triggers,
      triggerSource: matchedDefinitions.some((definition) => definition.requiredEnvironmentId && !matchedEnvironments.some((environment) => environment.id === definition.requiredEnvironmentId))
        ? 'boundary-environment'
        : 'prompt',
    });
    if (proposal.allowed) {
      const forbiddenTool = matchedTools.find((tool) => !this._allowedEntries(policy, 'allowedTools', proposal.to.level).includes(tool.id));
      if (forbiddenTool) {
        proposal.postCommitRefusal = {
          code: 'TOOL_FORBIDDEN_AT_CURRENT_LEVEL',
          reason: `${forbiddenTool.name} is not permitted at ${this._levelDefinition(policy, proposal.to.level).name}.`,
          toolId: forbiddenTool.id,
        };
      }
    }
    return proposal;
  }

  planToolTransition(chat, toolId) {
    const state = this._stateForChat(chat);
    const policy = this._policyForChat(state).payload;
    const tool = TOOL_BY_ID.get(toolId);
    if (!tool) return { allowed: false, code: 'UNKNOWN_TOOL', reason: `Unknown tool: ${toolId}` };
    const requirement = policy.toolScopeRequirements?.[toolId] ?? tool.requiredScope ?? {};
    return this._transitionProposal(state, {
      requiredLevel: tool.minimumLevel,
      environmentIds: [tool.sovereignty],
      partnerNetworkIds: requirement.partnerNetworkId ? [requirement.partnerNetworkId] : [],
      enterpriseOrganizationIds: requirement.enterpriseOrganizationId ? [requirement.enterpriseOrganizationId] : [],
      triggers: [toolId],
      triggerSource: 'tool-requirement',
    });
  }

  planResultTransition(chat, toolId, result) {
    const state = this._stateForChat(chat);
    const metadata = result?._meta?.governance;
    if (!metadata) {
      return this._transitionProposal(state, { triggers: [toolId], triggerSource: 'result-metadata' });
    }
    const requirement = metadata.requiredScope ?? {};
    return this._transitionProposal(state, {
      requiredLevel: metadata.classification ?? state.level,
      environmentIds: [metadata.executionPosture ?? state.sovereignty],
      partnerNetworkIds: requirement.partnerNetworkId ? [requirement.partnerNetworkId] : [],
      enterpriseOrganizationIds: requirement.enterpriseOrganizationId ? [requirement.enterpriseOrganizationId] : [],
      triggers: [toolId],
      triggerSource: 'result-metadata',
    });
  }

  commitTransition(chat, proposal, context = {}) {
    const state = this._stateForChat(chat);
    if (!proposal?.allowed) throw this._routeError(proposal?.code ?? 'TRANSITION_REFUSED', proposal?.reason ?? 'Transition refused');
    const currentSnapshot = this._transitionSnapshot(state);
    if (!this._sameObject(currentSnapshot, proposal.from)) {
      throw this._routeError('STALE_TRANSITION', 'Conversation protection changed before the proposal could be committed.');
    }
    this.store.assertLedgerCapacity(1);
    state.level = proposal.to.level;
    state.sovereignty = proposal.to.sovereignty;
    if (proposal.to.scope) state.scope = this._clone(proposal.to.scope);
    this._syncChatLabels(state);
    this._persistChats();
    const eventKind = proposal.changed ? (context.kind === 'tool' ? 'tool-elevation' : 'chat-elevated') : 'chat-classified';
    this.store.append(eventKind, {
      chatId: state.id,
      agentId: state.agentId,
      level: state.level,
      sovereignty: state.sovereignty,
      scope: this._clone(state.scope),
      policyVersion: state.policyVersion,
      policyDigest: state.policyDigest,
      ...(context.prompt ? { prompt: context.prompt } : {}),
      ...(context.toolId ? { toolId: context.toolId } : {}),
      from: proposal.from,
      to: proposal.to,
      trigger: proposal.triggers.join(', ') || 'inherited protection',
      triggerSource: proposal.triggerSource,
      outcome: 'committed',
    });
    return {
      level: state.level,
      sovereignty: state.sovereignty,
      scope: this._clone(state.scope),
      changed: proposal.changed,
      trigger: proposal.triggers.join(', ') || 'inherited protection',
      triggerSource: proposal.triggerSource,
      analysis: 'deterministic demo rules, not enterprise DLP',
      conflict: false,
      blocked: false,
      from: proposal.from,
      to: proposal.to,
    };
  }

  _transitionProposal(chat, options = {}) {
    const state = this._stateForChat(chat);
    const policy = this._policyForChat(state).payload;
    const from = this._transitionSnapshot(state);
    const to = this._clone(from);
    to.level = this._maxLevel(state.level, options.requiredLevel ?? state.level, policy);
    const triggers = [...new Set((options.triggers ?? []).filter(Boolean))];
    if (!this._hasScopeModel(policy)) {
      return { allowed: true, from, to, changed: !this._sameObject(from, to), triggers, triggerSource: options.triggerSource ?? 'legacy' };
    }

    to.scope ??= { partnerNetworkIds: [], enterpriseOrganizationIds: [] };
    delete to.scope.regionId;
    const definitions = policy.scopeDefinitions ?? [];
    const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
    const partnerNetworkIds = [...new Set((options.partnerNetworkIds ?? []).filter(Boolean))];
    const enterpriseOrganizationIds = [...new Set((options.enterpriseOrganizationIds ?? []).filter(Boolean))];
    const requestedDefinitions = [...partnerNetworkIds, ...enterpriseOrganizationIds].map((scopeId) => definitionsById.get(scopeId)).filter(Boolean);
    const environmentIds = [...new Set([
      ...(options.environmentIds ?? []),
      ...requestedDefinitions.map((definition) => definition.requiredEnvironmentId),
    ].filter(Boolean))];
    const requestedNamedEnvironments = environmentIds
      .map((environmentId) => this._resolveEnvironmentId(environmentId, policy))
      .filter((environmentId) => this._isNamedRestrictedEnvironment(environmentId, policy));
    if (new Set(requestedNamedEnvironments).size > 1) {
      return { allowed: false, code: 'ENVIRONMENT_CONFLICT', reason: 'The request names more than one restricted execution environment.', from, triggerSource: options.triggerSource ?? 'prompt' };
    }
    const currentEnvironment = this._resolveEnvironmentId(state.sovereignty, policy);
    const currentNamedEnvironment = this._isNamedRestrictedEnvironment(currentEnvironment, policy) ? currentEnvironment : null;
    const requestedNamedEnvironment = requestedNamedEnvironments[0] ?? null;
    if (currentNamedEnvironment && requestedNamedEnvironment && currentNamedEnvironment !== requestedNamedEnvironment) {
      return {
        allowed: false,
        code: 'ENVIRONMENT_CONFLICT',
        reason: `This chat already uses ${this._environmentDefinition(policy, currentNamedEnvironment).name} and cannot switch to ${this._environmentDefinition(policy, requestedNamedEnvironment).name}.`,
        from,
        triggerSource: options.triggerSource ?? 'prompt',
      };
    }
    to.sovereignty = environmentIds.reduce((environment, required) => this._maxSovereignty(environment, required, policy), state.sovereignty);
    to.scope.partnerNetworkIds = [...new Set([...(to.scope.partnerNetworkIds ?? []), ...partnerNetworkIds])];
    to.scope.enterpriseOrganizationIds = [...new Set([...(to.scope.enterpriseOrganizationIds ?? []), ...enterpriseOrganizationIds])];
    return {
      allowed: true,
      from,
      to,
      changed: !this._sameObject(from, to),
      triggers,
      triggerSource: options.triggerSource ?? 'prompt',
    };
  }

  _transitionSnapshot(chat) {
    return {
      level: chat.level,
      sovereignty: chat.sovereignty,
      ...(chat.scope ? { scope: this._clone(chat.scope) } : {}),
    };
  }

  _definitionMentioned(text, definition) {
    const aliases = definition.aliases?.length ? definition.aliases : [definition.id.replaceAll('-', ' '), definition.name];
    return this._mentionsAny(text, aliases);
  }

  _environmentMentioned(text, definition) {
    const aliases = definition.aliases?.length ? definition.aliases : [definition.id, definition.name];
    return this._mentionsAny(text, aliases);
  }

  _toolMentioned(text, tool) {
    const aliases = tool.aliases?.length ? tool.aliases : [tool.id.replaceAll('_', ' '), tool.name];
    return this._mentionsAny(text, aliases);
  }

  _mentionsAny(text, terms) {
    const source = String(text ?? '');
    return (terms ?? []).some((term) => {
      const escaped = String(term).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return escaped.length > 0 && new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, 'i').test(source);
    });
  }

  _scopeName(policy, scopeId) {
    return policy.scopeDefinitions?.find((definition) => definition.id === scopeId)?.name ?? scopeId;
  }

  routePlan(chat, excludedRouteIds = []) {
    const state = this._stateForChat(chat);
    const policy = this._policyForChat(state).payload;
    if (!this._hasScopeModel(policy) && state.blocked) throw this._routeError('SOVEREIGNTY_CONFLICT', state.conflictReason || 'Conflicting sovereignty restrictions remain in this chat.');
    const level = this._baseLevelId(state.level, policy);
    const preference = this._routePreference(level, policy);
    const settings = this._settings;
    const allowedModels = this._allowedEntries(policy, 'allowedModels', state.level);
    const allowedEnvironments = this._allowedEntries(policy, 'allowedEnvironments', state.level).map(id => this._baseEnvironmentId(id, policy));
    const environmentId = this._resolveEnvironmentId(state.sovereignty, policy);
    const namedRestrictedEnvironment = this._isNamedRestrictedEnvironment(environmentId, policy);
    const useEuPool = !namedRestrictedEnvironment && EU_POOL_ROUTE_IDS.includes(preference);
    const configuredPool = [...settings.euRouting.order];
    const poolIndex = new Map(configuredPool.map((routeId, index) => [routeId, index]));
    const orderedPool = settings.euRouting.strategy === 'cost'
      ? configuredPool.sort((left, right) => settings.routes[left].costScore - settings.routes[right].costScore
        || poolIndex.get(left) - poolIndex.get(right))
      : configuredPool;
    const compatibleEnvironmentRoutes = namedRestrictedEnvironment
      ? [...ROUTE_IDS].filter(routeId => this._environmentSatisfies(settings.routes[routeId]?.geography, environmentId, policy))
      : [];
    const routeIds = namedRestrictedEnvironment
      ? [...new Set([preference, ...orderedPool, ...compatibleEnvironmentRoutes])]
      : useEuPool
        ? orderedPool
        : [preference];
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
      } else if (!allowedEnvironments.includes(this._baseEnvironmentId(route.geography, policy))) {
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
        routes.push(this._decorateRoute(routeId, route, route.geography, policy.routeEnvironmentDeclarations?.[routeId]));
      }
    }

    if (!routes.length) {
      const first = skipped.find(item => item.code !== 'ROUTE_ALREADY_ATTEMPTED') ?? skipped[0];
      throw this._routeError(first?.code ?? 'NO_AUTHORIZED_ROUTE', first?.message ?? `No route satisfies ${state.sovereignty}`);
    }
    return {
      strategy: namedRestrictedEnvironment ? `environment-aware-${settings.euRouting.strategy}` : useEuPool ? settings.euRouting.strategy : 'preference',
      fallbackEnabled: (useEuPool || compatibleEnvironmentRoutes.length > 1) && settings.euRouting.fallbackEnabled,
      routes,
      skipped,
      environmentId,
    };
  }

  recommendRoute(chat, excludedRouteIds = []) {
    return this.routePlan(chat, excludedRouteIds).routes[0];
  }

  exposedTools(chat, implementedToolIds = TOOLS.map((tool) => tool.id), prompt) {
    const state = this._stateForChat(chat);
    const policy = this._policyForChat(state).payload;
    const implemented = new Set(implementedToolIds);
    const compatible = TOOLS.filter((tool) => {
      if (!implemented.has(tool.id)) return false;
      if (!this._hasScopeModel(policy)) return true;
      if (!this._environmentRequirementsCompatible(state.sovereignty, tool.sovereignty, policy)) return false;
      const requirement = policy.toolScopeRequirements?.[tool.id] ?? tool.requiredScope;
      if (!requirement) return true;
      for (const scopeId of [requirement.partnerNetworkId, requirement.enterpriseOrganizationId].filter(Boolean)) {
        const definition = policy.scopeDefinitions?.find((entry) => entry.id === scopeId);
        if (definition?.requiredEnvironmentId && !this._environmentRequirementsCompatible(state.sovereignty, definition.requiredEnvironmentId, policy)) return false;
      }
      return true;
    });
    const relevant = prompt === undefined ? compatible : compatible.filter((tool) => this._toolMentioned(prompt, tool));
    return relevant.map((tool) => this._clone(tool));
  }

  toolDecision(chat, toolId, args = {}, excludedRouteIds = []) {
    const state = this._stateForChat(chat);
    const tool = TOOL_BY_ID.get(toolId);
    if (!tool) {
      return { allowed: false, reason: 'UNKNOWN_TOOL', tool: toolId, raised: null };
    }

    const policy = this._policyForChat(state).payload;
    const modern = this._hasScopeModel(policy);
    if (!modern && state.blocked) return { allowed: false, reason: 'SOVEREIGNTY_CONFLICT', tool, raised: null };
    let raised;
    if (modern) {
      const proposal = this.planToolTransition(state, toolId);
      if (!proposal.allowed) return { allowed: false, reason: proposal.code, message: proposal.reason, tool, raised: null };
      raised = this.commitTransition(state, proposal, { kind: 'tool', toolId });
    } else {
      raised = this._elevateChat(state, tool.minimumLevel, tool.sovereignty, toolId, args);
    }
    const participant = this.credential(toolId, policy.version);

    if (!modern && raised.changed) {
      this.store.append('tool-elevation', {
        chatId: state.id,
        toolId,
        from: raised.from,
        to: raised.to,
        args: tool.redactArgs ? '[redacted]' : args,
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

    if (!this._allowedEntries(policy, 'allowedTools', state.level).includes(toolId)) {
      return {
        allowed: false,
        reason: 'TOOL_FORBIDDEN_AT_CURRENT_LEVEL',
        tool,
        credential: participant.record,
        raised,
      };
    }

    if (this._rankSovereignty(tool.sovereignty, policy) === 0 && this._rankLevel(state.level, policy) !== 0) {
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
      args: tool.redactArgs ? '[redacted]' : args,
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
    if (!Array.isArray(draft.scopeDefinitions)) {
      this._applyScopeDraftMigration(draft);
      changed = true;
    }
    if (this._needsEnvironmentScopeMigration(draft)) {
      this._applyEnvironmentScopeMigration(draft);
      changed = true;
    }
    if (changed) {
      draft.odrl = this._buildOdrl(draft);
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
      this._applyRouteSettings(next, activeRoutes);
    }
    if (saved?.preferences) {
      for (const preference of Object.keys(next.preferences)) {
        if (ROUTE_IDS.has(saved.preferences[preference])) {
          next.preferences[preference] = saved.preferences[preference];
        }
      }
    }
    if (saved?.euRouting) {
      const euRouting = this._clone(saved.euRouting);
      if (Array.isArray(euRouting.order)) {
        const retained = [...new Set(euRouting.order.filter(routeId => EU_POOL_ROUTE_IDS.includes(routeId)))];
        euRouting.order = [...retained, ...EU_POOL_ROUTE_IDS.filter(routeId => !retained.includes(routeId))];
      }
      this._applyEuRoutingSettings(next, euRouting);
    }
    for (const routeId of REMOTE_ROUTE_IDS) {
      next.secrets.routeApiKeyPresent[routeId] = Boolean(this.store.secretPresent(this._routeSecretName(routeId)));
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
        if (!this.store.verify(entry) || !entry?.payload || typeof entry.payload.issuer !== 'string' || !entry.payload.issuer) {
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
    return Array.isArray(saved) ? saved : [];
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
    const authority = policy.credentialAuthority ?? {
      issuer: CREDENTIAL_ISSUER,
      claims: DEPLOYMENT_SETTINGS.credentials.claims,
      demo: DEPLOYMENT_SETTINGS.credentials.demo,
      participants: PARTICIPANTS,
    };
    const issued = authority.participants.map((participant) => this._sealCredential({
      credentialId: `cred-${policy.version}-${participant.id}`,
      participantId: participant.id,
      participantLabel: participant.label,
      participantKind: participant.kind,
      policyVersion: policy.version,
      policyDigest: this._policyDigest(policy),
      claims: this._clone(authority.claims),
      issuer: authority.issuer,
      issuedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + CREDENTIAL_TTL_MS).toISOString(),
      status: 'active',
      revoked: false,
      demo: authority.demo,
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
      const aliases = kind === 'environment'
        ? [...new Set((item.aliases ?? []).map((alias) => this._assertBoundedText(alias, 'environment alias', 80)))]
        : [];
      definitions.push(kind === 'level'
        ? { id, name, baseLevel: baseValue }
        : { id, name, baseEnvironment: baseValue, ...(aliases.length ? { aliases } : {}) });
      seenIds.add(id);
      seenAliases.add(id);
      seenAliases.add(name);
    }

    for (const definition of fallbackDefinitions) {
      if (kind === 'environment' && definition.id === 'EU-only' && seenIds.has('Restricted Region')) continue;
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
    const resolved = this._resolveEnvironmentId(environmentId, view);
    return view.environmentById.get(resolved)
      ?? DEPLOYMENT_SETTINGS.policy.environmentDefinitions.find((definition) => definition.id === resolved)
      ?? view.environmentDefinitions[0];
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
    if (DEPLOYMENT_SETTINGS.policy.environmentDefinitions.some((definition) => definition.id === text || definition.name === text)) {
      return DEPLOYMENT_SETTINGS.policy.environmentDefinitions.find((definition) => definition.id === text || definition.name === text).id;
    }
    throw new Error(`Unknown sovereignty: ${text}`);
  }

  _baseLevelId(level, policyOrChat) {
    const view = this._policyView(policyOrChat);
    const definition = view.levelById.get(this._resolveLevelId(level, view));
    return definition?.baseLevel ?? LEVELS[0];
  }

  _baseEnvironmentId(environment, policyOrChat) {
    const view = this._policyView(policyOrChat);
    const resolved = this._resolveEnvironmentId(environment, view);
    const definition = view.environmentById.get(resolved)
      ?? DEPLOYMENT_SETTINGS.policy.environmentDefinitions.find((entry) => entry.id === resolved);
    return definition?.baseEnvironment === 'EU-only' ? 'Restricted Region' : definition?.baseEnvironment ?? ENVIRONMENTS[0];
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

  _isNamedRestrictedEnvironment(environment, policyOrChat = this.active()) {
    const resolved = this._resolveEnvironmentId(environment, policyOrChat);
    return resolved !== 'Restricted Region'
      && resolved !== 'EU-only'
      && this._baseEnvironmentId(resolved, policyOrChat) === 'Restricted Region';
  }

  _environmentSatisfies(actualEnvironment, requiredEnvironment, policyOrChat = this.active()) {
    if (!actualEnvironment || !requiredEnvironment) return false;
    const actual = this._resolveEnvironmentId(actualEnvironment, policyOrChat);
    const required = this._resolveEnvironmentId(requiredEnvironment, policyOrChat);
    const actualRank = this._rankSovereignty(actual, policyOrChat);
    const requiredRank = this._rankSovereignty(required, policyOrChat);
    if (actualRank !== requiredRank) return actualRank > requiredRank;
    if (!this._isNamedRestrictedEnvironment(required, policyOrChat)) return true;
    if ((actual === 'EU-only' && required === 'region-eu') || (actual === 'region-eu' && required === 'EU-only')) return true;
    return actual === required;
  }

  _environmentRequirementsCompatible(leftEnvironment, rightEnvironment, policyOrChat = this.active()) {
    const left = this._resolveEnvironmentId(leftEnvironment, policyOrChat);
    const right = this._resolveEnvironmentId(rightEnvironment, policyOrChat);
    if (this._rankSovereignty(left, policyOrChat) !== this._rankSovereignty(right, policyOrChat)) return true;
    if (!this._isNamedRestrictedEnvironment(left, policyOrChat) || !this._isNamedRestrictedEnvironment(right, policyOrChat)) return true;
    return left === right;
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
    const allowedRootKeys = new Set([
      '@context', '@type', 'uid', 'profile', 'policyVersion', 'permission', 'prohibition', 'obligation',
      'cg:levelDefinitions', 'cg:environmentDefinitions', 'cg:scopeTypes', 'cg:scopeDefinitions',
      'cg:toolScopeRequirements', 'cg:routeEnvironmentDeclarations', 'cg:routeScopeDeclarations', 'cg',
    ]);
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
        if (!['levelDefinitions', 'environmentDefinitions', 'scopeTypes', 'scopeDefinitions', 'toolScopeRequirements', 'routeEnvironmentDeclarations', 'routeScopeDeclarations'].includes(key)) {
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
    const scopeTypesValue = odrl['cg:scopeTypes'] ?? odrl?.cg?.scopeTypes ?? baseView.policy.scopeTypes;
    const scopeDefinitionsValue = odrl['cg:scopeDefinitions'] ?? odrl?.cg?.scopeDefinitions ?? baseView.policy.scopeDefinitions;
    const toolScopeRequirementsValue = odrl['cg:toolScopeRequirements'] ?? odrl?.cg?.toolScopeRequirements ?? baseView.policy.toolScopeRequirements;
    const routeEnvironmentDeclarationsValue = odrl['cg:routeEnvironmentDeclarations'] ?? odrl?.cg?.routeEnvironmentDeclarations ?? baseView.policy.routeEnvironmentDeclarations;
    const hasScopeSchema = scopeTypesValue !== undefined || scopeDefinitionsValue !== undefined
      || toolScopeRequirementsValue !== undefined || routeEnvironmentDeclarationsValue !== undefined;
    const normalizedScopeTypes = hasScopeSchema ? this._normalizeScopeTypes(scopeTypesValue ?? SCOPE_TYPES) : null;
    const scopeFields = hasScopeSchema ? {
      scopeTypes: normalizedScopeTypes,
      scopeDefinitions: this._normalizeScopeDefinitions(scopeDefinitionsValue ?? SCOPE_DEFINITIONS, normalizedScopeTypes, environmentDefinitions),
      toolScopeRequirements: this._normalizeToolScopeRequirements(toolScopeRequirementsValue ?? DEFAULT_TOOL_SCOPE_REQUIREMENTS),
      routeEnvironmentDeclarations: this._normalizeRouteEnvironmentDeclarations(routeEnvironmentDeclarationsValue ?? DEFAULT_ROUTE_ENVIRONMENT_DECLARATIONS),
    } : {};

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

    const initialLevelId = baseView.policy.initialLevelId ?? DEPLOYMENT_SETTINGS.policy.initialLevelId;
    const prohibitedTools = this._parseOdrlProhibitions(odrl.prohibition, levelDefinitions, initialLevelId);
    if (prohibitedTools.length) {
      allowedTools[initialLevelId] = allowedTools[initialLevelId].filter(entry => !prohibitedTools.includes(entry));
    }

    const nextVersion = (baseView.policy.version ?? 0) + 1;
    if (odrl.policyVersion !== undefined && Number(odrl.policyVersion) !== nextVersion) {
      throw new Error('Unsupported ODRL version');
    }
    if (odrl.uid !== `urn:cg-demo:policy:${nextVersion}`) {
      throw new Error('Unsupported ODRL profile');
    }

    const parsed = {
      version: nextVersion,
      levelDefinitions,
      environmentDefinitions,
      allowedModels,
      allowedTools,
      allowedEnvironments,
      obligations: this._parseOdrlObligations(odrl.obligation),
      ...scopeFields,
    };
    parsed.odrl = this._buildOdrl(parsed);
    return parsed;
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

  _parseOdrlProhibitions(prohibitions, levelDefinitions, initialLevelId) {
    const prohibitedTools = [];
    const initialLevelName = levelDefinitions.find(definition => definition.id === initialLevelId)?.name ?? initialLevelId;
    for (const prohibition of prohibitions) {
      if (!prohibition || typeof prohibition !== 'object' || Array.isArray(prohibition)) {
        throw new Error('Unsupported ODRL prohibition');
      }
      for (const key of Object.keys(prohibition)) {
        if (!['target', 'action', 'constraint'].includes(key)) {
          throw new Error(`Unsupported ODRL prohibition field: ${key}`);
        }
      }
      if (String(prohibition.target ?? '').startsWith('cg:tool/') && prohibition.action === 'use') {
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
        if (constraint.leftOperand !== 'cg:confidentiality' || constraint.operator !== 'eq' || constraint.rightOperand !== initialLevelName) {
          throw new Error('Unsupported ODRL prohibition constraint');
        }
        prohibitedTools.push(String(prohibition.target).slice('cg:tool/'.length));
        continue;
      }
      throw new Error('Unsupported ODRL prohibition');
    }
    return [...new Set(prohibitedTools)];
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
    const configured = DEPLOYMENT_SETTINGS.policy;
    const levelDefinitions = this._clone(configured.levelDefinitions);
    const environmentDefinitions = this._clone(configured.environmentDefinitions);
    const policy = {
      version,
      name: configured.name,
      levelDefinitions,
      levels: this._clone(levelDefinitions),
      environmentDefinitions,
      environments: this._clone(environmentDefinitions),
      envDefinitions: this._clone(environmentDefinitions),
      credentialAuthority: {
        issuer: DEPLOYMENT_SETTINGS.credentials.issuer,
        claims: this._clone(DEPLOYMENT_SETTINGS.credentials.claims),
        demo: DEPLOYMENT_SETTINGS.credentials.demo,
        participants: this._clone(DEPLOYMENT_SETTINGS.credentials.participants),
      },
      initialLevelId: configured.initialLevelId,
      initialEnvironmentByBaseLevel: this._clone(configured.initialEnvironmentByBaseLevel),
      classification: this._clone(configured.classification),
      allowedModels: this._clone(configured.allowedModels),
      allowedTools: this._clone(configured.allowedTools),
      allowedEnvironments: this._clone(configured.allowedEnvironments),
      scopeTypes: this._clone(configured.scopeTypes),
      scopeDefinitions: this._clone(configured.scopeDefinitions),
      toolScopeRequirements: this._clone(configured.toolScopeRequirements),
      routeEnvironmentDeclarations: this._clone(configured.routeEnvironmentDeclarations),
      publicEgressToolIds: this._clone(configured.publicEgressToolIds),
      obligations: this._clone(configured.obligations),
    };
    policy.odrl = this._buildOdrl(policy);
    return policy;
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
      },
      allowedEnvironments,
    };
    if (!Array.isArray(nextPolicy.scopeDefinitions)) {
      this._applyScopeDraftMigration(nextPolicy);
    }
    nextPolicy.odrl = this._buildOdrl(nextPolicy);
    return nextPolicy;
  }

  _normalizePolicyDraft(value, basePolicy) {
    const source = value && typeof value === 'object' ? value : {};
    const allowedKeys = new Set([
      'version', 'name', 'levelDefinitions', 'levels', 'environmentDefinitions', 'environments', 'envDefinitions',
      'credentialAuthority', 'initialLevelId', 'initialEnvironmentByBaseLevel', 'classification',
      'allowedModels', 'allowedTools', 'allowedEnvironments', 'scopeTypes', 'scopeDefinitions',
      'toolScopeRequirements', 'routeEnvironmentDeclarations', 'publicEgressToolIds', 'obligations', 'odrl',
    ]);
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
    const scopeTypes = this._normalizeScopeTypes(source.scopeTypes ?? baseView.policy.scopeTypes ?? SCOPE_TYPES);
    const scopeDefinitions = this._normalizeScopeDefinitions(source.scopeDefinitions ?? baseView.policy.scopeDefinitions ?? SCOPE_DEFINITIONS, scopeTypes, environmentDefinitions);
    const toolScopeRequirements = this._normalizeToolScopeRequirements(source.toolScopeRequirements ?? baseView.policy.toolScopeRequirements ?? DEFAULT_TOOL_SCOPE_REQUIREMENTS);
    const routeEnvironmentDeclarations = this._normalizeRouteEnvironmentDeclarations(source.routeEnvironmentDeclarations ?? baseView.policy.routeEnvironmentDeclarations ?? DEFAULT_ROUTE_ENVIRONMENT_DECLARATIONS);
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
      scopeTypes,
      scopeDefinitions,
      toolScopeRequirements,
      routeEnvironmentDeclarations,
    };
    const activeVersion = this.active()?.payload?.version ?? baseView.policy.version ?? 0;
    const expectedVersion = activeVersion + 1;
    if (source.version !== undefined && Number(source.version) !== expectedVersion) {
      throw new Error('Draft version must be active version + 1');
    }
    merged.version = expectedVersion;
    merged.name = this._assertBoundedText(source.name ?? baseView.policy.name ?? DEPLOYMENT_SETTINGS.policy.name, 'policy name', 120);
    merged.odrl = this._buildOdrl(merged);
    if (source.odrl && !this._sameObject(source.odrl, merged.odrl)) {
      throw new Error('Draft ODRL must match the generated constrained profile');
    }
    this._validatePolicy(merged);
    return merged;
  }

  _buildOdrl({ version, levelDefinitions, environmentDefinitions, allowedModels, allowedTools, allowedEnvironments,
    scopeTypes, scopeDefinitions, toolScopeRequirements, routeEnvironmentDeclarations, initialLevelId, publicEgressToolIds }) {
    const permission = [
      ...this._odrlPermissions('cg:model/id', levelDefinitions, allowedModels, 'cg:model'),
      ...this._odrlPermissions('cg:tool/id', levelDefinitions, allowedTools, 'cg:tool'),
      ...this._odrlPermissions('cg:environment/name', levelDefinitions, allowedEnvironments, 'cg:environment'),
    ];
    const prohibition = [];
    const leastProtectedLevelId = initialLevelId ?? DEPLOYMENT_SETTINGS.policy.initialLevelId;
    const leastProtectedLevelName = levelDefinitions.find(definition => definition.id === leastProtectedLevelId)?.name ?? leastProtectedLevelId;
    for (const toolId of publicEgressToolIds ?? DEPLOYMENT_SETTINGS.policy.publicEgressToolIds) {
      if ((allowedTools[leastProtectedLevelId] ?? []).includes(toolId)) continue;
      prohibition.push({
        target: `cg:tool/${toolId}`,
        action: 'use',
        constraint: [{ leftOperand: 'cg:confidentiality', operator: 'eq', rightOperand: leastProtectedLevelName }],
      });
    }
    const scopeMetadata = scopeDefinitions ? {
      scopeTypes: this._clone(scopeTypes),
      scopeDefinitions: this._clone(scopeDefinitions),
      toolScopeRequirements: this._clone(toolScopeRequirements),
      routeEnvironmentDeclarations: this._clone(routeEnvironmentDeclarations),
    } : {};
    return {
      '@context': ['http://www.w3.org/ns/odrl.jsonld', { cg: 'urn:cg-demo:' }],
      '@type': 'Set',
      uid: `urn:cg-demo:policy:${version}`,
      profile: 'urn:cg-demo:odrl-profile:enterprise-agent-governance',
      policyVersion: version,
      'cg:levelDefinitions': levelDefinitions.map((definition) => this._clone(definition)),
      'cg:environmentDefinitions': environmentDefinitions.map((definition) => this._clone(definition)),
      ...(scopeDefinitions ? {
        'cg:scopeTypes': this._clone(scopeTypes),
        'cg:scopeDefinitions': this._clone(scopeDefinitions),
        'cg:toolScopeRequirements': this._clone(toolScopeRequirements),
        'cg:routeEnvironmentDeclarations': this._clone(routeEnvironmentDeclarations),
      } : {}),
      cg: {
        levelDefinitions: levelDefinitions.map((definition) => this._clone(definition)),
        environmentDefinitions: environmentDefinitions.map((definition) => this._clone(definition)),
        ...scopeMetadata,
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

  _applyScopeDraftMigration(policy) {
    policy.scopeTypes = this._clone(SCOPE_TYPES);
    policy.scopeDefinitions = this._clone(SCOPE_DEFINITIONS);
    policy.toolScopeRequirements = this._clone(DEFAULT_TOOL_SCOPE_REQUIREMENTS);
    policy.routeEnvironmentDeclarations = this._clone(DEFAULT_ROUTE_ENVIRONMENT_DECLARATIONS);
    policy.allowedTools ??= {};
    policy.allowedEnvironments ??= {};
    for (const level of DEPLOYMENT_SETTINGS.policy.levelDefinitions) {
      policy.allowedTools[level.id] = [...new Set([...(policy.allowedTools[level.id] ?? []), ...DEPLOYMENT_SETTINGS.policy.allowedTools[level.id]])];
      policy.allowedEnvironments[level.id] = [...new Set([...(policy.allowedEnvironments[level.id] ?? []), ...DEPLOYMENT_SETTINGS.policy.allowedEnvironments[level.id]])];
    }
    policy.publicEgressToolIds ??= this._clone(DEPLOYMENT_SETTINGS.policy.publicEgressToolIds);
    return policy;
  }

  _needsEnvironmentScopeMigration(policy) {
    return policy.environmentDefinitions?.some((definition) => definition.id === 'EU-only')
      || policy.scopeTypes?.some((type) => type.id === 'restricted-region')
      || policy.scopeDefinitions?.some((definition) => definition.type === 'restricted-region' || definition.allowedRegionIds || definition.defaultRegionId)
      || policy.toolScopeRequirements && Object.values(policy.toolScopeRequirements).some((requirement) => requirement.regionId || requirement.requiresRegion)
      || policy.routeScopeDeclarations !== undefined
      || policy.routeEnvironmentDeclarations === undefined;
  }

  _applyEnvironmentScopeMigration(policy) {
    const configured = DEPLOYMENT_SETTINGS.policy;
    policy.environmentDefinitions = this._clone(configured.environmentDefinitions);
    policy.environments = this._clone(policy.environmentDefinitions);
    policy.envDefinitions = this._clone(policy.environmentDefinitions);
    policy.scopeTypes = this._clone(configured.scopeTypes);
    policy.scopeDefinitions = this._clone(configured.scopeDefinitions);
    policy.toolScopeRequirements = this._clone(configured.toolScopeRequirements);
    policy.routeEnvironmentDeclarations = this._clone(configured.routeEnvironmentDeclarations);
    delete policy.routeScopeDeclarations;
    policy.classification = this._clone(configured.classification);
    policy.allowedEnvironments ??= {};
    policy.allowedTools ??= {};
    for (const level of configured.levelDefinitions) {
      policy.allowedEnvironments[level.id] = this._clone(configured.allowedEnvironments[level.id]);
      policy.allowedTools[level.id] = [...new Set([...(policy.allowedTools[level.id] ?? []), ...configured.allowedTools[level.id]])];
    }
    return policy;
  }

  _normalizeScopeTypes(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_TYPES) {
      throw new Error('Unsupported scope types');
    }
    const normalized = value.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid scope type');
      const id = this._assertDefinitionId(item.id, 'scope type');
      const name = this._assertBoundedText(item.displayName ?? item.name ?? id, 'scope type name', 80);
      return { id, name, displayName: name, description: this._assertBoundedText(item.description ?? name, 'scope type description', 240) };
    });
    if (new Set(normalized.map((item) => item.id)).size !== normalized.length) throw new Error('Duplicate scope type id');
    for (const required of SCOPE_TYPES) {
      if (!normalized.some((item) => item.id === required.id)) throw new Error(`Missing scope type: ${required.id}`);
    }
    return normalized;
  }

  _normalizeScopeDefinitions(value, scopeTypes = SCOPE_TYPES, environmentDefinitions = DEPLOYMENT_SETTINGS.policy.environmentDefinitions) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_DEFINITIONS) {
      throw new Error('Unsupported scope definitions');
    }
    const typeIds = new Set(scopeTypes.map((item) => item.id));
    const environmentIds = new Set(environmentDefinitions.map((definition) => definition.id));
    const normalized = value.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid scope definition');
      const id = this._assertDefinitionId(item.id, 'scope');
      const type = String(item.type ?? '');
      if (!typeIds.has(type)) throw new Error(`Unknown scope type: ${type}`);
      const requiredEnvironmentId = String(item.requiredEnvironmentId ?? 'Restricted Region');
      if (!environmentIds.has(requiredEnvironmentId)) throw new Error(`Unknown required environment: ${requiredEnvironmentId}`);
      return {
        id,
        name: this._assertBoundedText(item.name ?? id, 'scope name', 80),
        type,
        aliases: [...new Set((item.aliases ?? []).map(entry => this._assertBoundedText(entry, 'scope alias', 80)))],
        requiredEnvironmentId,
        builtIn: Boolean(item.builtIn),
      };
    });
    if (new Set(normalized.map((item) => item.id)).size !== normalized.length) throw new Error('Duplicate scope definition id');
    const typeCounts = new Map();
    for (const definition of normalized) {
      typeCounts.set(definition.type, (typeCounts.get(definition.type) ?? 0) + 1);
    }
    for (const [type, count] of typeCounts) {
      if (count > MAX_SCOPE_DEFINITIONS_PER_TYPE) throw new Error(`Too many ${type} definitions`);
    }
    return normalized;
  }

  _normalizeLegacyScopeDefinitions(value, scopeTypes) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_DEFINITIONS) throw new Error('Unsupported scope definitions');
    const typeIds = new Set(scopeTypes.map((item) => item.id));
    const normalized = value.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid scope definition');
      const type = String(item.type ?? '');
      if (!typeIds.has(type)) throw new Error(`Unknown scope type: ${type}`);
      return {
        id: this._assertDefinitionId(item.id, 'scope'),
        name: this._assertBoundedText(item.name ?? item.id, 'scope name', 80),
        type,
        aliases: [...new Set((item.aliases ?? []).map(entry => this._assertBoundedText(entry, 'scope alias', 80)))],
        allowedRegionIds: [...new Set((item.allowedRegionIds ?? []).map((entry) => String(entry)))],
        ...(item.defaultRegionId ? { defaultRegionId: String(item.defaultRegionId) } : {}),
        builtIn: Boolean(item.builtIn),
      };
    });
    const regionIds = new Set(normalized.filter((definition) => definition.type === 'restricted-region').map((definition) => definition.id));
    for (const definition of normalized) {
      for (const regionId of definition.allowedRegionIds) if (!regionIds.has(regionId)) throw new Error(`Unknown allowed region: ${regionId}`);
      if (definition.defaultRegionId && !definition.allowedRegionIds.includes(definition.defaultRegionId)) throw new Error(`Default region is not allowed for ${definition.id}`);
    }
    return normalized;
  }

  _normalizeToolScopeRequirements(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid tool scope requirements');
    const result = {};
    for (const [toolId, requirement] of Object.entries(value)) {
      if (!TOOL_BY_ID.has(toolId) || !requirement || typeof requirement !== 'object' || Array.isArray(requirement)) {
        throw new Error(`Invalid tool scope requirement: ${toolId}`);
      }
      const allowedKeys = new Set(['partnerNetworkId', 'enterpriseOrganizationId']);
      for (const key of Object.keys(requirement)) if (!allowedKeys.has(key)) throw new Error(`Unknown tool scope requirement field: ${key}`);
      result[toolId] = {
        ...(requirement.partnerNetworkId ? { partnerNetworkId: String(requirement.partnerNetworkId) } : {}),
        ...(requirement.enterpriseOrganizationId ? { enterpriseOrganizationId: String(requirement.enterpriseOrganizationId) } : {}),
      };
    }
    return result;
  }

  _normalizeLegacyToolScopeRequirements(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid tool scope requirements');
    const result = {};
    for (const [toolId, requirement] of Object.entries(value)) {
      if (!TOOL_BY_ID.has(toolId) || !requirement || typeof requirement !== 'object' || Array.isArray(requirement)) throw new Error(`Invalid tool scope requirement: ${toolId}`);
      result[toolId] = {
        ...(requirement.regionId ? { regionId: String(requirement.regionId) } : {}),
        ...(requirement.partnerNetworkId ? { partnerNetworkId: String(requirement.partnerNetworkId) } : {}),
        ...(requirement.enterpriseOrganizationId ? { enterpriseOrganizationId: String(requirement.enterpriseOrganizationId) } : {}),
        ...(requirement.requiresRegion ? { requiresRegion: true } : {}),
      };
    }
    return result;
  }

  _normalizeRouteEnvironmentDeclarations(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid route environment declarations');
    const result = {};
    for (const [routeId, declaration] of Object.entries(value)) {
      if (!ROUTE_IDS.has(routeId) || !declaration || typeof declaration !== 'object' || Array.isArray(declaration)) throw new Error(`Invalid route environment declaration: ${routeId}`);
      const basis = String(declaration.basis ?? 'none');
      if (!['none', 'provider-declared', 'demo-local-simulation'].includes(basis)) throw new Error(`Unknown route declaration basis: ${basis}`);
      result[routeId] = {
        basis,
        attested: declaration.attested === true,
        statement: this._assertBoundedText(declaration.statement ?? 'No execution-environment declaration.', 'route environment statement', 240),
      };
    }
    return result;
  }

  _normalizeRouteScopeDeclarations(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid route scope declarations');
    const result = {};
    for (const [routeId, declaration] of Object.entries(value)) {
      if (!ROUTE_IDS.has(routeId) || !declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
        throw new Error(`Invalid route scope declaration: ${routeId}`);
      }
      const basis = String(declaration.basis ?? 'none');
      if (!['none', 'provider-declared', 'demo-local-simulation'].includes(basis)) throw new Error(`Unknown route declaration basis: ${basis}`);
      result[routeId] = {
        regionIds: [...new Set((declaration.regionIds ?? []).map((item) => String(item)))],
        basis,
        attested: declaration.attested === true,
        statement: this._assertBoundedText(declaration.statement ?? 'No restricted-region declaration.', 'route scope statement', 240),
      };
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
    const toolIds = new Set(TOOLS.map((tool) => tool.id));
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
        if (!environmentIds.has(environment) && !LEGACY_ENVIRONMENT_IDS.has(environment) && !view.environmentById.has(environment) && !view.environmentByName.has(environment)) {
          throw new Error(`Unknown environment allowance: ${environment}`);
        }
      }
    }
    const hasScopeSchema = ['scopeTypes', 'scopeDefinitions', 'toolScopeRequirements', 'routeEnvironmentDeclarations', 'routeScopeDeclarations']
      .some((field) => policy[field] !== undefined);
    if (hasScopeSchema) {
      const scopeTypes = this._normalizeScopeTypes(policy.scopeTypes);
      const legacyRegionalScope = scopeTypes.some((type) => type.id === 'restricted-region') || policy.routeScopeDeclarations !== undefined;
      const scopeDefinitions = legacyRegionalScope
        ? this._normalizeLegacyScopeDefinitions(policy.scopeDefinitions, scopeTypes)
        : this._normalizeScopeDefinitions(policy.scopeDefinitions, scopeTypes, view.environmentDefinitions);
      const requirements = legacyRegionalScope
        ? this._normalizeLegacyToolScopeRequirements(policy.toolScopeRequirements)
        : this._normalizeToolScopeRequirements(policy.toolScopeRequirements);
      const scopeIds = new Set(scopeDefinitions.map((definition) => definition.id));
      for (const [toolId, requirement] of Object.entries(requirements)) {
        for (const scopeId of [requirement.regionId, requirement.partnerNetworkId, requirement.enterpriseOrganizationId].filter(Boolean)) {
          if (!scopeIds.has(scopeId)) throw new Error(`Unknown scope requirement for ${toolId}: ${scopeId}`);
        }
      }
      if (legacyRegionalScope) {
        const declarations = this._normalizeRouteScopeDeclarations(policy.routeScopeDeclarations);
        for (const [routeId, declaration] of Object.entries(declarations)) {
          for (const regionId of declaration.regionIds) if (!scopeIds.has(regionId)) throw new Error(`Unknown route region for ${routeId}: ${regionId}`);
        }
      } else {
        this._normalizeRouteEnvironmentDeclarations(policy.routeEnvironmentDeclarations);
      }
      if (scopeTypes.length < SCOPE_TYPES.length) throw new Error('Policy scope types are incomplete');
    }
    return true;
  }


  _sanitizeSettings(settings) {
    const routes = Object.fromEntries(Object.entries(settings.routes).map(([routeId, route]) => [routeId, {
      id: route.id,
      kind: route.kind,
      name: route.name,
      enabled: Boolean(route.enabled),
      model: route.model,
      baseUrl: route.baseUrl,
      approvedBaseUrls: [...route.approvedBaseUrls],
      geography: route.geography,
      costScore: route.costScore,
      requiredForDemo: Boolean(route.requiredForDemo),
      requiresApiKey: REMOTE_ROUTE_IDS.includes(routeId),
    }]));
    return {
      routes,
      preferences: { ...this._clone(settings.preferences) },
      preferenceDefinitions: this._clone(settings.preferenceDefinitions),
      euRouting: this._clone(settings.euRouting),
      routingPoolDefinition: this._clone(settings.routingPoolDefinition),
      secrets: {
        routeApiKeyPresent: this._clone(settings.secrets.routeApiKeyPresent),
      },
    };
  }

  _defaultSettings() {
    const routes = Object.fromEntries(DEPLOYMENT_SETTINGS.models.routes.map(route => [route.id, this._clone(route)]));
    const preferenceDefinitions = this._clone(DEPLOYMENT_SETTINGS.models.preferences);
    return {
      routes,
      preferenceDefinitions,
      preferences: Object.fromEntries(preferenceDefinitions.map(preference => [preference.id, preference.defaultRouteId])),
      routingPoolDefinition: this._clone(PRIMARY_ROUTING_POOL),
      euRouting: {
        strategy: PRIMARY_ROUTING_POOL.strategy,
        fallbackEnabled: PRIMARY_ROUTING_POOL.fallbackEnabled,
        order: [...PRIMARY_ROUTING_POOL.order],
      },
      secrets: {
        routeApiKeyPresent: Object.fromEntries(REMOTE_ROUTE_IDS.map(routeId => [routeId, false])),
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
    for (const definition of settings.preferenceDefinitions) {
      const routeId = settings.preferences[definition.id];
      this._assertRouteId(routeId, `${definition.id} route preference`);
      if (!definition.allowedRouteIds.includes(routeId)) throw new Error(`${routeId} is not allowed for ${definition.id}`);
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
    if (this._rankLevel(state.level, policy) > 0 && route.kind === 'copilot') return false;
    if (!this._hasScopeModel(policy) && Array.isArray(state.restrictions) && state.restrictions.includes('IT')) {
      return false;
    }
    if (!this._hasScopeModel(policy) && state.restrictions?.includes('DE') && route.kind !== 'ollama') return false;
    return this._environmentSatisfies(route.geography, state.sovereignty, policy);
  }

  _hasScopeModel(policyOrChat) {
    const policy = this._policyPayload(policyOrChat);
    return Array.isArray(policy?.scopeDefinitions) && policy.scopeDefinitions.length > 0;
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
    const definition = this._settings.preferenceDefinitions.find(preference => preference.baseLevel === baseLevel);
    if (!definition) throw new Error(`No route preference is configured for ${baseLevel}`);
    return this._settings.preferences[definition.id];
  }

  _decorateRoute(routeId, routeConfig, geography, environmentDeclaration) {
    return {
      id: routeId,
      name: routeConfig.name,
      kind: routeConfig.kind,
      model: routeConfig.model,
      baseUrl: routeConfig.baseUrl,
      geography,
      enabled: Boolean(routeConfig.enabled),
      costScore: routeConfig.costScore,
      ...(environmentDeclaration ? { environmentDeclaration: this._clone(environmentDeclaration) } : {}),
    };
  }

  _routeForTool(tool, chat, excludedRouteIds = []) {
    const route = this.recommendRoute(chat, excludedRouteIds);
    if (!this._environmentSatisfies(route.geography, tool.sovereignty, chat)) {
      return { allowed: false, reason: 'ON_PREM_TOOL_REQUIRES_ON_PREM_ROUTE' };
    }
    if (this._rankSovereignty(tool.sovereignty, chat) === 0 && this._rankSovereignty(chat.sovereignty, chat) !== 0) {
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
      if (nextBaseSovereignty === ENVIRONMENTS[2] && !chat.restrictions.includes('DE')) {
        chat.restrictions = [...chat.restrictions, 'DE'];
      }
      if (nextBaseSovereignty === ENVIRONMENTS[1] && !chat.restrictions.includes('EU')) {
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
    const classification = policy.classification ?? DEPLOYMENT_SETTINGS.policy.classification;
    const isSales = this._mentionsAny(text, classification.protectedTerms);
    const isInternal = !isSales && this._mentionsAny(text, classification.internalTerms);
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
        level: this._maxLevel(chat.level, classification.protectedLevelId, policy),
        sovereignty: this._maxSovereignty(chat.sovereignty, classification.protectedEnvironmentId, policy),
        changed: this._rankLevel(chat.level, policy) < this._rankLevel(classification.protectedLevelId, policy) || this._rankSovereignty(chat.sovereignty, policy) < this._rankSovereignty(classification.protectedEnvironmentId, policy),
        trigger: classification.protectedTerms.join('/'),
        analysis: 'deterministic demo rules, not enterprise DLP',
        conflict: false,
      };
    }

    if (isItaly) {
      const nextLevel = this._maxLevel(chat.level, classification.internalLevelId, policy);
      const nextSovereignty = this._maxSovereignty(chat.sovereignty, classification.internalEnvironmentId, policy);
      return {
        level: nextLevel,
        sovereignty: nextSovereignty,
        changed: this._rankLevel(chat.level, policy) < this._rankLevel(classification.internalLevelId, policy) || this._rankSovereignty(chat.sovereignty, policy) < this._rankSovereignty(classification.internalEnvironmentId, policy),
        trigger: 'Italy request',
        analysis: 'deterministic demo rules, not enterprise DLP',
        conflict: false,
        blocked: false,
      };
    }

    if (isInternal) {
      const nextLevel = this._maxLevel(chat.level, classification.internalLevelId, policy);
      const nextSovereignty = this._maxSovereignty(chat.sovereignty, classification.internalEnvironmentId, policy);
      return {
        level: nextLevel,
        sovereignty: nextSovereignty,
        changed: this._rankLevel(chat.level, policy) < this._rankLevel(classification.internalLevelId, policy) || this._rankSovereignty(chat.sovereignty, policy) < this._rankSovereignty(classification.internalEnvironmentId, policy),
        trigger: classification.internalTerms.join('/'),
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
    const policy = this._policyPayload(policyOrChat);
    return policy.initialEnvironmentByBaseLevel?.[baseLevel]
      ?? DEPLOYMENT_SETTINGS.policy.initialEnvironmentByBaseLevel[baseLevel]
      ?? ENVIRONMENTS[0];
  }

  _initialRestrictions(sovereignty) {
    if (sovereignty === ENVIRONMENTS[2]) {
      return ['DE'];
    }
    if (sovereignty === ENVIRONMENTS[1]) {
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
    const leftId = this._resolveEnvironmentId(left, policy);
    const rightId = this._resolveEnvironmentId(right, policy);
    const leftRank = this._rankSovereignty(leftId, policy);
    const rightRank = this._rankSovereignty(rightId, policy);
    if (leftRank > rightRank) return leftId;
    if (rightRank > leftRank) return rightId;
    if (leftId === rightId) return leftId;
    if (this._isNamedRestrictedEnvironment(rightId, policy) && !this._isNamedRestrictedEnvironment(leftId, policy)) return rightId;
    return leftId;
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
    return ROUTE_DEFINITIONS.get(routeId).apiKeySecretName;
  }

  _validateRouteEndpoint(routeId, baseUrl) {
    const definition = ROUTE_DEFINITIONS.get(routeId);
    if (!definition?.approvedBaseUrls.includes(String(baseUrl))) throw new Error(`${routeId} endpoint is not approved by deployment settings`);
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
