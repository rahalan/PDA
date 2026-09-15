import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.PDA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-test-bootstrap-'));
process.env.PDA_DEPENDENCIES ||= path.join(process.env.LOCALAPPDATA || os.homedir(), 'PDA', 'sdk-demo', 'dependencies');

const [{ Governance }, { Store }, catalog, agent, { DEMO_STORIES, DEMO_STORY_STEP_COUNT }, storyUi] = await Promise.all([
  import('../app/governance.mjs'),
  import('../app/storage.mjs'),
  import('../app/catalog.mjs'),
  import('../app/agent.mjs'),
  import('../public/demo-stories.js'),
  import('../public/common.js'),
]);

const bootstrapState = process.env.PDA_STATE_DIR;

function withGovernance(run) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-governance-test-'));
  const store = new Store(stateDir);
  const governance = new Governance(store);
  try {
    return run({ governance, store, stateDir });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

test.after(() => {
  fs.rmSync(bootstrapState, { recursive: true, force: true });
});

test('catalog has unique scope and tool coverage', () => {
  assert.equal(catalog.SCOPE_TYPES.length, 2);
  assert.equal(catalog.SCOPE_DEFINITIONS.length, 12);
  assert.equal(catalog.TOOLS.length, 21);
  assert.equal(catalog.GLOBAL_TOOL_IDS.length, 12);
  assert.equal(new Set(catalog.SCOPE_DEFINITIONS.map((item) => item.id)).size, 12);
  assert.equal(new Set(catalog.TOOLS.map((item) => item.id)).size, 21);
  assert.deepEqual(
    Object.fromEntries(catalog.SCOPE_TYPES.map((type) => [type.id, catalog.SCOPE_DEFINITIONS.filter((item) => item.type === type.id).length])),
    { 'partner-network': 3, 'enterprise-organization': 9 },
  );
  const environmentBase = new Map(catalog.TOOLS.map(tool => tool.sovereignty)
    .map(environmentId => [environmentId, environmentId]));
  for (const definition of governanceEnvironmentDefinitions()) environmentBase.set(definition.id, definition.baseEnvironment);
  assert.deepEqual(
    Object.fromEntries([...new Set(catalog.TOOLS.map(tool => `${tool.minimumLevel} / ${environmentBase.get(tool.sovereignty)}`))]
      .map(cell => [cell, catalog.TOOLS.filter(tool => `${tool.minimumLevel} / ${environmentBase.get(tool.sovereignty)}` === cell).length])),
    {
      'Public / Public cloud': 3,
      'Highly Confidential / On-premises': 4,
      'Internal / Restricted Region': 4,
      'Public / Restricted Region': 4,
      'Public / On-premises': 2,
      'Internal / On-premises': 4,
    },
  );
  assert.equal(catalog.TOOLS.some(tool => tool.minimumLevel === 'Highly Confidential' && environmentBase.get(tool.sovereignty) !== 'On-premises'), false);
});

function governanceEnvironmentDefinitions() {
  const governance = Object.create(Governance.prototype);
  return governance._createDefaultPolicy(1).environmentDefinitions;
}

test('default policy seeds cumulative scoped tool matrices without weakening high execution posture', () => {
  const governance = Object.create(Governance.prototype);
  const policy = governance._createDefaultPolicy(1);
  const publicTools = catalog.TOOLS.filter((tool) => tool.minimumLevel === 'Public').map((tool) => tool.id);
  const internalTools = catalog.TOOLS.filter((tool) => !['weather', 'public_send'].includes(tool.id) && tool.minimumLevel !== 'Highly Confidential').map((tool) => tool.id);
  const protectedTools = catalog.TOOLS.filter((tool) => !['weather', 'public_send'].includes(tool.id)).map((tool) => tool.id);
  assert.deepEqual(policy.allowedTools.Public, publicTools);
  assert.deepEqual(policy.allowedTools.Internal, internalTools);
  assert.deepEqual(policy.allowedTools['Highly Confidential'], protectedTools);
  assert.deepEqual(policy.allowedEnvironments['Highly Confidential'], ['On-premises']);
  assert.equal(governance._validatePolicy(policy), true);
});

test('scope migration preserves custom level allowances', () => {
  const governance = Object.create(Governance.prototype);
  const legacy = governance._createDefaultPolicy(1);
  for (const field of ['scopeTypes', 'scopeDefinitions', 'toolScopeRequirements', 'routeScopeDeclarations']) delete legacy[field];
  legacy.levelDefinitions.push({ id: 'ProjectSecret', name: 'Project Secret', baseLevel: 'Highly Confidential' });
  legacy.allowedModels.ProjectSecret = ['ollama'];
  legacy.allowedTools.ProjectSecret = ['sales'];
  legacy.allowedEnvironments.ProjectSecret = ['On-premises'];
  const before = structuredClone(legacy.allowedTools.ProjectSecret);
  governance._applyScopeDraftMigration(legacy);
  assert.deepEqual(legacy.allowedTools.ProjectSecret, before);
  assert.equal(legacy.allowedTools.Internal.includes('sakura_exchange'), true);
  assert.equal(legacy.allowedTools['Highly Confidential'].includes('pearl_plant_console'), true);
});

test('scoped and historical ODRL documents round trip canonically', () => {
  const governance = Object.create(Governance.prototype);
  const scopedV1 = governance._createDefaultPolicy(1);
  const scopedV2 = structuredClone(scopedV1);
  scopedV2.version = 2;
  scopedV2.odrl = governance._buildOdrl(scopedV2);
  const parsedScoped = governance._parseOdrlPolicy(scopedV2.odrl, governance._policyView(scopedV1));
  assert.deepEqual(parsedScoped.odrl, scopedV2.odrl);

  const legacyV1 = structuredClone(scopedV1);
  for (const field of ['scopeTypes', 'scopeDefinitions', 'toolScopeRequirements', 'routeEnvironmentDeclarations']) delete legacyV1[field];
  legacyV1.odrl = governance._buildOdrl(legacyV1);
  const legacyV2 = structuredClone(legacyV1);
  legacyV2.version = 2;
  legacyV2.odrl = governance._buildOdrl(legacyV2);
  const parsedLegacy = governance._parseOdrlPolicy(legacyV2.odrl, governance._policyView(legacyV1));
  assert.deepEqual(parsedLegacy.odrl, legacyV2.odrl);
  assert.equal(parsedLegacy.scopeDefinitions, undefined);
});

test('named environment proposals are pure and conflicts never poison a chat', () => withGovernance(({ governance, store }) => {
  const chat = governance.newChat('Public');
  const proposal = governance.planInputTransition(chat, 'Use Japan data from the Industrial Community.');
  assert.equal(proposal.allowed, true);
  assert.equal(chat.level, 'Public');
  assert.equal(chat.sovereignty, 'Public cloud');
  assert.equal(Object.hasOwn(chat.scope, 'regionId'), false);

  const committed = governance.classify(chat, 'Use Japan data from the Industrial Community.');
  assert.equal(committed.level, 'Public');
  assert.equal(committed.sovereignty, 'region-japan');
  assert.deepEqual(committed.scope.partnerNetworkIds, ['partner-industrial-community']);

  const beforeConflict = structuredClone(chat);
  const conflict = governance.classify(chat, 'Switch this chat to Korea and HR.');
  assert.equal(conflict.code, 'ENVIRONMENT_CONFLICT');
  assert.equal(conflict.blocked, false);
  assert.deepEqual(chat, beforeConflict);
  assert.equal(chat.blocked, undefined);
  assert.equal(store.records().at(-1).kind, 'environment-transition-refused');
}));

test('business boundaries select their required execution environment', () => withGovernance(({ governance }) => {
  const cispeChat = governance.newChat('Public');
  const cispe = governance.classify(cispeChat, 'Use the CISPE Cloud Registry.');
  assert.equal(cispe.sovereignty, 'region-eu');
  assert.deepEqual(cispe.scope.partnerNetworkIds, ['partner-cispe']);
  assert.equal(cispe.triggerSource, 'boundary-environment');

  const ngoChat = governance.newChat('Public');
  const ngo = governance.classify(ngoChat, 'Use the NGO Community.');
  assert.equal(ngo.conflict, false);
  assert.equal(ngo.sovereignty, 'Restricted Region');
  assert.deepEqual(ngo.scope.partnerNetworkIds, ['partner-ngo-community']);
}));

test('tool arguments cannot classify scope and result conflicts are withheld before commit', () => withGovernance(({ governance }) => {
  const chat = governance.newChat('Public');
  governance.classify(chat, 'Use Japan data from the Industrial Community.');
  const decision = governance.toolDecision(chat, 'forgelink_exchange', { query: 'Compare with China.' });
  assert.equal(decision.allowed, true);
  assert.equal(chat.sovereignty, 'region-japan');
  assert.equal(decision.route.id, 'ollama');
  assert.equal(decision.route.environmentDeclaration.basis, 'demo-local-simulation');
  assert.equal(decision.route.environmentDeclaration.attested, false);

  const conflict = governance.planResultTransition(chat, 'forgelink_exchange', {
    _meta: { governance: { classification: 'Internal', executionPosture: 'region-china', requiredScope: {} } },
  });
  assert.equal(conflict.allowed, false);
  assert.equal(conflict.code, 'ENVIRONMENT_CONFLICT');
  assert.equal(chat.sovereignty, 'region-japan');
}));

test('tool exposure is catalog, implementation, and scope relevant', () => withGovernance(({ governance }) => {
  const chat = governance.newChat('Public');
  const before = governance.exposedTools(chat).map((tool) => tool.id);
  for (const toolId of ['weather', 'sales', 'public_send', 'sakura_exchange']) assert.equal(before.includes(toolId), true);
  assert.equal(before.includes('forgelink_exchange'), true);
  governance.classify(chat, 'Use Japan data.');
  const after = governance.exposedTools(chat).map((tool) => tool.id);
  assert.equal(after.includes('forgelink_exchange'), true);
  assert.equal(after.includes('sakura_exchange'), true);
  assert.equal(after.includes('han_river_index'), false);
  assert.equal(governance.exposedTools(chat, ['weather']).length, 1);
  assert.deepEqual(governance.exposedTools(chat, undefined, 'Use the Kaizen Plant Console.').map((tool) => tool.id), ['kaizen_plant_console']);
  assert.deepEqual(governance.exposedTools(chat, undefined, 'Add the Industrial Community boundary.').map((tool) => tool.id), []);
}));

test('route candidates respect region declarations and configured EU order', () => withGovernance(({ governance }) => {
  governance.updateSettings({
    preferences: { internal: 'simplellm' },
    routes: { simplellm: { enabled: true } },
    routeApiKeys: { simplellm: 'test-only-placeholder' },
  });
  const euChat = governance.newChat('Public');
  governance.classify(euChat, 'Use CISPE data.');
  assert.deepEqual(governance.routePlan(euChat).routes.map((route) => route.id), ['simplellm', 'ollama']);
  const japanChat = governance.newChat('Public');
  governance.classify(japanChat, 'Use Japan data.');
  assert.deepEqual(governance.routePlan(japanChat).routes.map((route) => route.id), ['ollama']);
}));

test('historical EU-only policy remains signed while its draft is environment-migrated', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-legacy-test-'));
  try {
    const store = new Store(stateDir);
    const scaffold = Object.create(Governance.prototype);
    const legacy = scaffold._createDefaultPolicy(1);
    for (const field of ['scopeTypes', 'scopeDefinitions', 'toolScopeRequirements', 'routeEnvironmentDeclarations']) delete legacy[field];
    legacy.environmentDefinitions = [
      { id: 'Public cloud', name: 'Public cloud', baseEnvironment: 'Public cloud' },
      { id: 'EU-only', name: 'EU-only', baseEnvironment: 'EU-only' },
      { id: 'On-premises', name: 'On-premises', baseEnvironment: 'On-premises' },
    ];
    legacy.environments = structuredClone(legacy.environmentDefinitions);
    legacy.envDefinitions = structuredClone(legacy.environmentDefinitions);
    legacy.initialEnvironmentByBaseLevel.Internal = 'EU-only';
    legacy.classification.internalEnvironmentId = 'EU-only';
    legacy.allowedEnvironments.Public = ['Public cloud', 'EU-only', 'On-premises'];
    legacy.allowedEnvironments.Internal = ['EU-only'];
    legacy.allowedEnvironments['Highly Confidential'] = ['On-premises'];
    legacy.odrl = scaffold._buildOdrl(legacy);
    store.save('policies', [store.seal(legacy)]);
    const governance = new Governance(store);
    assert.equal(governance.active().payload.scopeDefinitions, undefined);
    assert.equal(governance.draft().scopeDefinitions.length, 12);
    assert.deepEqual(governance.active().payload.allowedEnvironments.Internal, ['EU-only']);
    assert.equal(governance.draft().environmentDefinitions.some(definition => definition.id === 'EU-only'), false);
    assert.equal(governance.draft().environmentDefinitions.some(definition => definition.id === 'region-japan' && definition.baseEnvironment === 'Restricted Region'), true);
    const chat = governance.newChat('Public');
    assert.equal(chat.scope, undefined);
    governance.classify(chat, 'Use Italy-only internal information.');
    const conflict = governance.classify(chat, 'Switch this request to Germany.');
    assert.equal(conflict.conflict, true);
    assert.equal(chat.blocked, true);
    governance.publish();
    const scopedChat = governance.newChat('Public');
    governance.classify(scopedChat, 'Use Japan data.');
    assert.deepEqual(governance.routePlan(scopedChat).routes.map((route) => route.id), ['ollama']);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('capacity APIs report bounded remaining work', () => withGovernance(({ governance, store }) => {
  assert.deepEqual(governance.capacity(), { used: 0, limit: 200, remaining: 200 });
  const before = store.capacity();
  store.assertLedgerCapacity(1);
  governance.newChat('Public');
  assert.deepEqual(governance.capacity(), { used: 1, limit: 200, remaining: 199 });
  assert.equal(store.capacity().used, before.used + 1);
}));

test('latest chat recovery stays within owner and active policy', () => withGovernance(({ governance }) => {
  const first = governance.newChat('Public');
  first.ownerHash = 'owner-a';
  governance.updateChat(first);
  const otherOwner = governance.newChat('Public');
  otherOwner.ownerHash = 'owner-b';
  governance.updateChat(otherOwner);
  const latest = governance.newChat('Internal');
  latest.ownerHash = 'owner-a';
  governance.updateChat(latest);

  assert.equal(governance.latestOwnedChat('owner-a')?.id, latest.id);
  assert.equal(governance.latestOwnedChat('owner-b')?.id, otherOwner.id);
  assert.equal(governance.latestOwnedChat('owner-a', latest.policyVersion + 1), null);
  assert.equal(governance.latestOwnedChat('owner-c'), null);
}));

test('protection-driven execution remains bounded to two attempts', () => {
  assert.equal(agent.MAX_PROTECTION_ATTEMPTS, 2);
  assert.equal(DEMO_STORIES.reduce((total, story) => total + story.steps.length, 0), DEMO_STORY_STEP_COUNT);
  assert.equal(agent.DEMO_PREFLIGHT_LEDGER_RESERVE, DEMO_STORY_STEP_COUNT * agent.LEDGER_RECORDS_PER_TURN);
});

test('activity traces isolate an environment-only protection transition', () => withGovernance(({ governance, store }) => {
  const runner = new agent.AgentRunner(governance, store);
  const chat = governance.newChat('Public');
  const streamed = [];
  const run = { chat, activity: [], activitySequence: 0, emit: event => streamed.push(event) };

  runner.recordActivity(run, { kind: 'request', title: 'Prompt received' });
  const before = { level: chat.level, environment: chat.sovereignty, scope: structuredClone(chat.scope) };
  governance.classify(chat, 'Use Japan data.');
  const transition = runner.recordProtectionActivity(run, before, 'Prompt classification');

  assert.equal(run.activity[0].transition, undefined);
  assert.equal(transition.title, 'Execution environment changed');
  assert.deepEqual(transition.transition, {
    from: { level: 'Public', environment: 'Public cloud' },
    to: { level: 'Public', environment: 'region-japan' },
    confidentialityChanged: false,
    environmentChanged: true,
  });
  assert.equal(streamed.every(event => event.type === 'activity'), true);
  assert.equal(streamed.at(-1).activity.id, transition.id);
}));

test('tool activity highlights elevation before protected data release', () => withGovernance(({ governance, store }) => {
  const runner = new agent.AgentRunner(governance, store);
  const chat = governance.newChat('Public');
  const streamed = [];
  const run = {
    chat,
    route: governance.recommendRoute(chat),
    failedRouteIds: [],
    live: true,
    elevated: false,
    calls: 0,
    activity: [],
    activitySequence: 0,
    emit: event => streamed.push(event),
    session: { abort: async () => {} },
  };
  runner.activeRun = run;

  const result = runner.tool(run, 'sakura_exchange', { query: 'Japan inventory' }, { signal: { aborted: false } });
  const transitions = run.activity.filter(entry => entry.transition);
  const toolStep = run.activity.find(entry => entry.kind === 'tool');

  assert.equal(result.error, 'Protection elevated. No protected data released to this model.');
  assert.equal(run.elevated, true);
  assert.equal(chat.level, 'Internal');
  assert.equal(chat.sovereignty, 'region-japan');
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].title, 'Confidentiality and environment elevated');
  assert.deepEqual(transitions[0].transition.to, { level: 'Internal', environment: 'region-japan' });
  assert.equal(toolStep.status, 'stopped');
  assert.equal(streamed.some(event => event.type === 'state'), true);
  runner.activeRun = null;
}));

test('story checks accept stronger monotonic protection but not weaker protection', () => {
  assert.equal(storyUi.protectionAtLeast('Highly Confidential', 'Internal', ['Public', 'Internal', 'Highly Confidential']), true);
  assert.equal(storyUi.protectionAtLeast('Public', 'Internal', ['Public', 'Internal', 'Highly Confidential']), false);
  assert.equal(storyUi.protectionAtLeast('On-premises', 'Restricted Region', ['Public cloud', 'Restricted Region', 'On-premises']), true);
  assert.equal(storyUi.protectionAtLeast('Restricted Region', 'On-premises', ['Public cloud', 'Restricted Region', 'On-premises']), false);
});

test('chat protection tones follow governed restriction baselines', () => {
  assert.deepEqual(
    ['Public', 'Internal', 'Highly Confidential'].map(level => storyUi.protectionTone('level', level, ['Public', 'Internal', 'Highly Confidential'])),
    ['open', 'guarded', 'sealed'],
  );
  assert.deepEqual(
    ['Public cloud', 'Restricted Region', 'On-premises'].map(environment => storyUi.protectionTone('environment', environment, ['Public cloud', 'Restricted Region', 'On-premises'])),
    ['open', 'restricted', 'sealed'],
  );
  assert.equal(storyUi.protectionTone('level', 'Unknown', ['Public', 'Internal', 'Highly Confidential']), 'muted');
});

test('activity summaries collapse with duration and protection severity', () => {
  const activities = [
    { id: 'activity-1', kind: 'request', title: 'Prompt received', status: 'complete', at: '2026-09-15T10:00:00.000Z', completedAt: '2026-09-15T10:00:00.010Z' },
    { id: 'activity-2', kind: 'protection', title: 'Confidentiality elevated', status: 'complete', at: '2026-09-15T10:00:00.020Z', completedAt: '2026-09-15T10:00:00.030Z', transition: { to: { level: 'Internal', environment: 'On-premises' } } },
    { id: 'activity-3', kind: 'model', title: 'Calling Ollama', status: 'complete', at: '2026-09-15T10:00:00.040Z', completedAt: '2026-09-15T10:00:02.500Z' },
  ];
  assert.equal(storyUi.activityTraceSummary(activities, true), 'Working…');
  assert.equal(storyUi.activityTraceSummary(activities, false), 'Completed 3 actions in 2.5s · 1 protection change');
  assert.equal(storyUi.activityTraceLevel(activities), 'Internal');
});

test('chat refresh restores only conversations on the active policy', () => {
  assert.equal(storyUi.shouldRestoreChat({ policyVersion: 7 }, 7), true);
  assert.equal(storyUi.shouldRestoreChat({ policyVersion: 5 }, 7), false);
  assert.equal(storyUi.shouldRestoreChat(null, 7), false);
});

test('all six demo stories reach their declared governance states', () => withGovernance(({ governance }) => {
  assert.equal(DEMO_STORIES.length, 6);
  assert.equal(new Set(DEMO_STORIES.map((story) => story.id)).size, 6);
  const refusalCodes = [];
  for (const story of DEMO_STORIES) {
    assert.ok(story.persona && story.scenario);
    assert.ok(story.steps.length >= 3 && story.steps.length <= 12);
    const chat = governance.newChat('Public');
    for (const step of story.steps) {
      assert.doesNotMatch(step.prompt, /for this conversation|add the .* boundary|switch this chat|lock (japan|korea|eu|brazil|us|china)/i);
      const result = governance.classify(chat, step.prompt);
      if (step.expect.code) {
        refusalCodes.push(step.expect.code);
        assert.equal(result.code, step.expect.code, `${story.id}: ${step.label}`);
        assert.equal(result.blocked, false, `${story.id}: ${step.label}`);
      } else {
        assert.equal(result.conflict, false, `${story.id}: ${step.label}`);
      }
      if (step.expect.level) assert.equal(chat.level, step.expect.level, `${story.id}: ${step.label}`);
      if (step.expect.sovereignty) assert.equal(chat.sovereignty, step.expect.sovereignty, `${story.id}: ${step.label}`);
      for (const scopeId of step.expect.partnerNetworkIds || []) assert.equal(chat.scope.partnerNetworkIds.includes(scopeId), true, `${story.id}: ${step.label}`);
      for (const scopeId of step.expect.enterpriseOrganizationIds || []) assert.equal(chat.scope.enterpriseOrganizationIds.includes(scopeId), true, `${story.id}: ${step.label}`);
    }
  }
  assert.deepEqual(refusalCodes, ['ENVIRONMENT_CONFLICT', 'TOOL_FORBIDDEN_AT_CURRENT_LEVEL', 'ENVIRONMENT_CONFLICT', 'TOOL_FORBIDDEN_AT_CURRENT_LEVEL']);
}));