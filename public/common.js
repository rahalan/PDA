import { DEMO_STORIES } from './demo-stories.js';

const $ = id => document.getElementById(id);
const node = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
const badge = (text, tone = 'muted') => node('span', text, `badge badge--${tone}`);
const json = value => JSON.stringify(value, null, 2);
const copy = value => structuredClone(value);
export const protectionAtLeast = (actual, expected, order) => {
  const actualRank = order.indexOf(actual), expectedRank = order.indexOf(expected);
  return actualRank >= 0 && expectedRank >= 0 ? actualRank >= expectedRank : actual === expected;
};
export const protectionTone = (kind, baseline, order) => {
  const tones = kind === 'level' ? ['open', 'guarded', 'sealed'] : ['open', 'restricted', 'sealed'];
  return tones[(order || []).indexOf(baseline)] || 'muted';
};
export const shouldRestoreChat = (chat, activePolicyVersion) => chat?.policyVersion === activePolicyVersion;
export function activityTraceLevel(activities = []) {
  return [...activities].reverse().find(activity => activity?.transition?.to?.level)?.transition.to.level || null;
}
export function activityTraceSummary(activities = [], live = false) {
  const items = Array.isArray(activities) ? activities : [];
  const running = [...items].reverse().find(activity => activity.status === 'running');
  if (live) return running?.title ? `Working · ${running.title}` : 'Working…';
  const actionLabel = `${items.length} action${items.length === 1 ? '' : 's'}`;
  const changes = items.filter(activity => activity?.transition).length;
  const stopped = items.some(activity => activity.kind === 'refusal') && !items.some(activity => activity.kind === 'response');
  const times = items.flatMap(activity => [Date.parse(activity.at), Date.parse(activity.completedAt)]).filter(Number.isFinite);
  const duration = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
  const durationText = duration < 1000 ? '<1s' : duration < 10_000 ? `${(duration / 1000).toFixed(1)}s` : `${Math.round(duration / 1000)}s`;
  return `${stopped ? 'Stopped after' : 'Completed'} ${actionLabel} in ${durationText}${changes ? ` · ${changes} protection change${changes === 1 ? '' : 's'}` : ''}`;
}
const profile = value => { const p = copy(value); delete p.odrl; return p; };
const option = (id, name = id) => { const o = node('option', name); o.value = id; return o; };
const field = (label, input) => { const l = node('label', '', 'field-row'); l.append(node('span', label, 'field-label'), input); return l; };
const input = (id, value = '', type = 'text') => { const i = node('input'); i.id = id; i.type = type; if (type === 'checkbox') i.checked = !!value; else i.value = value; return i; };
const button = (label, action, cls = '') => { const b = node('button', label, cls); b.type = 'button'; b.onclick = action; return b; };
const details = (label, value) => { const d = node('details', '', 'details'); d.append(node('summary', label), node('pre', typeof value === 'string' ? value : json(value), 'json-block')); return d; };
const select = (id, choices, value) => { const s = node('select'); s.id = id; choices.forEach(c => s.append(option(c.id ?? c, c.name ?? c))); s.value = value; return s; };
const alert = (id, text, tone = 'error') => { $(id).replaceChildren(...(text ? [node('div', text, `alert alert--${tone}`)] : [])); };
async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, credentials: 'same-origin', ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: json(body) } : {}) });
  const data = await r.json();
  if (!r.ok) {
    const error = new Error(data.message || data.error || `Request failed (${r.status})`);
    error.status = r.status;
    throw error;
  }
  return data;
}
function routeText(route, source) {
  if (source === 'governance') return 'Governance refusal';
  if (!route) return '';
  const execution = `GitHub Copilot SDK · ${route.name} / ${route.model}`;
  return route.environmentDeclaration?.statement ? `${execution} · ${route.environmentDeclaration.statement}` : execution;
}
function activityTrace(initial = [], live = false, toneForLevel = () => 'muted') {
  const root = node('details', '', 'activity-trace');
  const summary = node('summary', '', 'activity-trace__summary');
  const marker = node('span', '', 'activity-trace__marker'); marker.setAttribute('aria-hidden', 'true');
  const label = node('span', '', 'activity-trace__label');
  const chevron = node('span', '', 'activity-trace__chevron'); chevron.setAttribute('aria-hidden', 'true');
  const list = node('div', '', 'activity-trace__list'); list.setAttribute('aria-label', 'Agent activity');
  summary.append(marker, label, chevron); root.append(summary, list);
  let wasLive = false;
  function update(activities = [], isLive = false) {
    const items = Array.isArray(activities) ? activities : [];
    const summaryTone = activityTraceLevel(items) ? toneForLevel(activityTraceLevel(items)) : 'muted';
    root.className = `activity-trace activity-trace--${summaryTone}${isLive ? ' is-live' : ''}`;
    label.textContent = activityTraceSummary(items, isLive);
    list.replaceChildren(...items.map(activity => {
      const tone = activity.transition ? toneForLevel(activity.transition.to.level) : activity.status === 'failed' ? 'danger' : 'muted';
      const step = node('div', '', `activity-step activity-step--${tone}${activity.status === 'running' ? ' is-running' : ''}`);
      const rail = node('span', '', 'activity-step__rail'); rail.setAttribute('aria-hidden', 'true');
      const content = node('div', '', 'activity-step__content');
      const head = node('div', '', 'activity-step__head');
      head.append(node('strong', activity.title || 'Activity'), node('span', ({ running: 'In progress', failed: 'Stopped', stopped: 'Restarted', complete: 'Done' })[activity.status] || activity.status || 'Done', 'activity-step__status'));
      content.append(head);
      if (activity.detail) content.append(node('div', activity.detail, 'activity-step__detail'));
      step.append(rail, content);
      return step;
    }));
    if (isLive) root.open = true;
    else if (wasLive) root.open = false;
    wasLive = isLive;
  }
  update(initial, live);
  return { root, update };
}
function message(parent, role, text, footer = '', activities = [], live = false, toneForLevel = () => 'muted', assistantName = 'Assistant') {
  const article = node('article', '', `message message--${role}`);
  const head = node('div', '', 'message__head'); head.append(node('span', role === 'user' ? 'You' : assistantName), node('span', footer));
  const body = node('div', text, 'message__body');
  const trace = role === 'assistant' && (live || activities.length) ? activityTrace(activities, live, toneForLevel) : null;
  article.append(head, ...(trace ? [trace.root] : []), body); parent.append(article); return { body, head, activity: trace };
}
async function stream(url, body, handle) {
  const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: json(body) });
  if (!r.ok) throw new Error((await r.json()).error || 'Chat request failed.');
  const reader = r.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  for (;;) {
    const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
    let split;
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, split); buffer = buffer.slice(split + 2);
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (data) handle(JSON.parse(data));
    }
    if (done) break;
  }
}

export function mountChatPage() {
  let chat = null, busy = false, loaded = false, server;
  const storyState = { stepIndex: 0, started: false, auto: false, running: false, timer: null };
  const prompt = $('promptInput'), transcript = $('chatTranscript');
  const storySelect = $('demoStorySelect');
  function controls() {
    prompt.disabled = busy || !loaded;
    $('sendButton').disabled = busy || !loaded || !prompt.value.trim();
    $('newChatButton').disabled = busy || !loaded;
    $('demoNextButton').disabled = busy || !loaded || storyState.running;
    $('demoAutoButton').disabled = busy || !loaded || storyState.running || storyState.auto;
    $('demoStopButton').disabled = !storyState.auto;
    storySelect.disabled = busy || storyState.running || storyState.auto;
  }
  function scopeName(scopeId) { return server?.vocabulary?.scopeDefinitions?.find(definition => definition.id === scopeId)?.name || scopeId; }
  function baseline(value, definitions, key) { return definitions?.find(definition => definition.id === value || definition.name === value)?.[key] || value; }
  function levelOrder() { return server?.deployment?.policy?.baselineLevelIds || []; }
  function environmentOrder() { return server?.deployment?.policy?.baselineEnvironmentIds || []; }
  function initialLevel() { return server?.deployment?.policy?.initialLevelId; }
  function initialEnvironment() { return server?.deployment?.policy?.initialEnvironmentByBaseLevel?.[initialLevel()] || environmentOrder()[0]; }
  function assistantName() { return server?.deployment?.agents?.find(agent => agent.id === (chat?.agentId || server?.deployment?.defaultAgentId))?.name || 'Assistant'; }
  function levelTone(value) { return protectionTone('level', baseline(value, server?.vocabulary?.levels, 'baseLevel'), levelOrder()); }
  function environmentTone(value) { return protectionTone('environment', baseline(value, server?.vocabulary?.environments, 'baseEnvironment'), environmentOrder()); }
  function scopeBadges() {
    if (!chat?.scope) return [];
    return [
      ...(chat.scope.partnerNetworkIds || []).map(scopeId => badge(scopeName(scopeId))),
      ...(chat.scope.enterpriseOrganizationIds || []).map(scopeId => badge(scopeName(scopeId))),
    ];
  }
  function status() {
    const currentLevel = chat?.level || initialLevel();
    const currentEnvironment = chat?.sovereignty || initialEnvironment();
    $('chatBadges').replaceChildren(
      badge(`Confidentiality: ${chat?.levelName || currentLevel}`, levelTone(currentLevel)),
      badge(`Environment: ${chat?.sovereigntyName || currentEnvironment}`, environmentTone(currentEnvironment)),
      ...scopeBadges(),
    );
    const policyVersion = chat?.policyVersion || server?.active?.payload?.version;
    $('chatMeta').textContent = `${chat ? `Chat ${chat.id.slice(-8)}` : 'New conversation'}${policyVersion ? ` · Policy v${policyVersion}` : ''}`;
    controls();
  }
  function render() {
    transcript.replaceChildren();
    if (!chat?.messages.length) transcript.append(node('div', `Ask ${assistantName()} a question to begin.`, 'empty-state'));
    else chat.messages.forEach(m => message(transcript, m.role, m.content ?? m.text ?? '', routeText(m.route, m.source), m.activity || [], false, levelTone, assistantName()));
    status();
  }
  function resetChatView() {
    chat = null;
    sessionStorage.removeItem('cg.chat.id');
    prompt.value = '';
    alert('chatAlerts', '');
    render();
  }
  async function createChat() {
    chat = await api('/api/chats', 'POST', {});
    sessionStorage.setItem('cg.chat.id', chat.id);
    render();
    return chat;
  }
  async function restoreActiveChat() {
    const activePolicyVersion = server.active.payload.version;
    const storedId = sessionStorage.getItem('cg.chat.id');
    if (storedId) {
      try {
        const restored = await api(`/api/chats/${storedId}`);
        if (shouldRestoreChat(restored, activePolicyVersion)) return restored;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      sessionStorage.removeItem('cg.chat.id');
    }
    const latest = await api('/api/chats/latest');
    if (!shouldRestoreChat(latest, activePolicyVersion)) return null;
    sessionStorage.setItem('cg.chat.id', latest.id);
    return latest;
  }
  async function startNewChat() {
    if (busy || !loaded) throw new Error('Wait for the current turn to finish.');
    busy = true;
    controls();
    try {
      resetChatView();
      return await createChat();
    } finally {
      busy = false;
      controls();
    }
  }
  async function submit(text = prompt.value.trim()) {
    const request = String(text ?? '').trim();
    if (busy || !loaded || !request) return { ok: false, error: 'Chat is not ready.' };
    busy = true; controls(); alert('chatAlerts', ''); prompt.value = '';
    let pending;
    const liveActivity = [];
    const outcome = { ok: true, code: null, error: null, events: [], chat: null };
    try {
      if (!chat) await createChat();
      const before = { level: chat.level, sovereignty: chat.sovereignty, scope: copy(chat.scope ?? null) };
      const textValue = request;
      chat.messages.push({ role: 'user', content: textValue }); render(); pending = message(transcript, 'assistant', 'Thinking…', '', [], true, levelTone, assistantName());
      await stream(`/api/chats/${chat.id}/messages`, { prompt: textValue }, event => {
        outcome.events.push(event);
        if (event.type === 'activity' && event.activity) {
          const index = liveActivity.findIndex(activity => activity.id === event.activity.id);
          if (index >= 0) liveActivity[index] = event.activity;
          else liveActivity.push(event.activity);
          pending.activity.update(liveActivity, true);
        } else if (event.type === 'state' && event.chat) {
          const changed = before.level !== event.chat.level || before.sovereignty !== event.chat.sovereignty || json(before.scope) !== json(event.chat.scope ?? null);
          chat = event.chat; status();
          if (changed) alert('chatAlerts', `Protection increased to ${chat.levelName || chat.level} · ${chat.sovereigntyName || chat.sovereignty}. This protection state now stays with the conversation.`, 'warning');
        } else if (event.type === 'delta') pending.body.textContent = (pending.body.textContent === 'Thinking…' ? '' : pending.body.textContent) + event.text;
        else if (event.type === 'route-fallback') alert('chatAlerts', `${event.fromRoute.name} was unavailable. Continuing with ${event.toRoute.name} under the same governed EU route policy.`, 'warning');
        else if (event.type === 'message') { pending.body.textContent = event.text; pending.head.lastChild.textContent = routeText(event.route, event.source); outcome.code = event.code || null; }
        else if (event.type === 'error') { pending.body.textContent = event.message; pending.activity?.update(liveActivity, false); alert('chatAlerts', event.message); outcome.ok = false; outcome.code = event.code || 'runner_error'; outcome.error = event.message; }
        else if (event.type === 'done' && event.chat) { chat = event.chat; pending.activity?.update(liveActivity, false); }
      });
      chat = await api(`/api/chats/${chat.id}`); render();
    } catch (error) {
      outcome.ok = false; outcome.error = error.message; outcome.code ||= 'request_failed';
      alert('chatAlerts', error.message); if (pending) { pending.body.textContent = error.message; pending.activity?.update(liveActivity, false); }
    } finally {
      busy = false; controls();
    }
    outcome.chat = copy(chat);
    return outcome;
  }
  function selectedStory() { return DEMO_STORIES.find(story => story.id === storySelect.value) || DEMO_STORIES[0]; }
  function renderStoryStatus(text) {
    const story = selectedStory();
    $('demoStoryPersona').textContent = story.persona;
    $('demoStoryScenario').textContent = story.scenario;
    $('demoStepTitle').textContent = text || story.steps[storyState.stepIndex]?.label || 'Complete';
    $('demoProgress').textContent = `${Math.min(storyState.stepIndex, story.steps.length)} of ${story.steps.length}`;
    controls();
  }
  function stopAuto(messageText = '') {
    storyState.auto = false;
    if (storyState.timer) clearTimeout(storyState.timer);
    storyState.timer = null;
    if (messageText) renderStoryStatus(messageText);
    controls();
  }
  function checkExpected(expect, outcome) {
    if (expect.code && outcome.code !== expect.code) return `Expected ${expect.code}; received ${outcome.code || 'no refusal code'}.`;
    if (!expect.code && outcome.code) return `Unexpected governance refusal: ${outcome.code}.`;
    if (!outcome.ok && !expect.code) return outcome.error || 'The turn failed.';
    const current = outcome.chat;
    if (!current) return 'No chat state was returned.';
    if (expect.level && !protectionAtLeast(current.level, expect.level, levelOrder())) return `Expected at least ${expect.level}; received ${current.level}.`;
    if (expect.sovereignty && !protectionAtLeast(current.sovereignty, expect.sovereignty, environmentOrder())) return `Expected at least ${expect.sovereignty}; received ${current.sovereignty}.`;
    for (const scopeId of expect.partnerNetworkIds || []) if (!current.scope?.partnerNetworkIds?.includes(scopeId)) return `Missing ${scopeId}.`;
    for (const scopeId of expect.enterpriseOrganizationIds || []) if (!current.scope?.enterpriseOrganizationIds?.includes(scopeId)) return `Missing ${scopeId}.`;
    return '';
  }
  async function runNextStoryStep() {
    if (storyState.running || busy || !loaded) return;
    storyState.running = true; controls();
    const story = selectedStory();
    try {
      if (!storyState.started || storyState.stepIndex >= story.steps.length) {
        await startNewChat();
        storyState.stepIndex = 0;
        storyState.started = true;
      }
      const step = story.steps[storyState.stepIndex];
      renderStoryStatus(step.label);
      const outcome = await submit(step.prompt);
      const mismatch = checkExpected(step.expect, outcome);
      if (mismatch) throw new Error(mismatch);
      storyState.stepIndex += 1;
      renderStoryStatus(storyState.stepIndex >= story.steps.length ? 'Story complete' : 'Step passed');
      if (storyState.auto && storyState.stepIndex < story.steps.length) {
        storyState.timer = setTimeout(() => { storyState.timer = null; void runNextStoryStep(); }, 1200);
      } else if (storyState.stepIndex >= story.steps.length) {
        stopAuto('Story complete');
      }
    } catch (error) {
      stopAuto('Story stopped');
      alert('chatAlerts', error.message);
    } finally {
      storyState.running = false; controls();
    }
  }
  async function startAuto() {
    if (storyState.auto || storyState.running || busy) return;
    try {
      const preflight = await api('/api/demo/preflight', 'POST', {});
      if (!preflight.ok) {
        const failed = Object.entries(preflight.checks).filter(([, passed]) => !passed).map(([name]) => name).join(', ');
        throw new Error(`Auto preflight failed: ${failed}.`);
      }
      storyState.auto = true; controls();
      await runNextStoryStep();
    } catch (error) {
      stopAuto('Auto unavailable');
      alert('chatAlerts', error.message);
    }
  }
  const controller = { startNewChat, submit, isBusy: () => busy };
  $('chatForm').onsubmit = event => { event.preventDefault(); void submit(); };
  prompt.oninput = controls;
  prompt.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } };
  $('newChatButton').onclick = () => { if (!busy) void startNewChat().then(() => prompt.focus()).catch(error => alert('chatAlerts', error.message)); };
  storySelect.replaceChildren(...DEMO_STORIES.map(story => option(story.id, story.title)));
  storySelect.onchange = () => { stopAuto(); storyState.stepIndex = 0; storyState.started = false; renderStoryStatus('Ready'); };
  $('demoNextButton').onclick = () => { void runNextStoryStep(); };
  $('demoAutoButton').onclick = () => { void startAuto(); };
  $('demoStopButton').onclick = () => { stopAuto(storyState.running ? 'Stopping after current step' : 'Stopped'); };
  renderStoryStatus('Ready');
  controls();
  (async () => {
    server = await api('/api/state');
    chat = await restoreActiveChat();
    loaded = true; render();
  })().catch(e => alert('chatAlerts', e.message));
  return controller;
}

export function mountAdminPage() {
  let state, draft, dirty = false, busy = false;
  let bases = [], envBases = [];
  let selectedAuthorizationLevel = null, toolFilterLevel = '', toolSearchTerm = '';
  const status = (text = '', tone = 'muted') => $('adminStatus').replaceChildren(badge(`Policy v${state?.active.payload.version ?? '…'}`, 'accent'), badge(dirty ? 'Unsaved draft' : 'Saved draft', dirty ? 'warning' : 'muted'), ...(text ? [badge(text, tone)] : []));
  function mark() {
    dirty = true; $('policyJson').value = json(profile(draft)); $('publishDraftButton').disabled = true; status();
    renderAuthorizationMap(); renderResourcePolicySummary(); renderAuthorizationLabels(); filterToolCatalog();
  }
  function tabs(name) {
    document.querySelectorAll('[data-tab-target]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tabTarget === name)));
    document.querySelectorAll('[data-tab-panel]').forEach(p => p.classList.toggle('is-active', p.dataset.tabPanel === name));
  }
  document.querySelectorAll('[data-tab-target]').forEach(b => { b.onclick = () => tabs(b.dataset.tabTarget); });
  function definitions() {
    draft.levelDefinitions ||= bases.map(id => ({ id, name: id, baseLevel: id }));
    draft.environmentDefinitions ||= envBases.map(id => ({ id, name: id, baseEnvironment: id }));
    draft.scopeTypes ||= copy(state.draft.scopeTypes || []);
    draft.scopeDefinitions ||= copy(state.draft.scopeDefinitions || []);
    draft.toolScopeRequirements ||= copy(state.draft.toolScopeRequirements || {});
    draft.routeEnvironmentDeclarations ||= copy(state.draft.routeEnvironmentDeclarations || {});
  }
  function syncEditor() { $('policyJson').value = json(profile(draft)); }
  function scopeName(scopeId) { return draft.scopeDefinitions.find(definition => definition.id === scopeId)?.name || scopeId; }
  function levelDefinition(levelId) { return draft.levelDefinitions.find(definition => definition.id === levelId); }
  function levelTone(levelId) { const definition = levelDefinition(levelId); return protectionTone('level', definition?.baseLevel || levelId, bases); }
  function environmentName(environmentId) { return draft.environmentDefinitions.find(definition => definition.id === environmentId)?.name || environmentId; }
  function environmentBase(environmentId) { return draft.environmentDefinitions.find(definition => definition.id === environmentId)?.baseEnvironment || environmentId; }
  function initialDraftLevel() { return draft.initialLevelId || state.deployment.policy.initialLevelId; }
  function resourceCount(count, singular, plural = `${singular}s`) { return `${count} ${count === 1 ? singular : plural}`; }
  function scopeRequirementText(requirement = {}) {
    const values = [];
    if (requirement.partnerNetworkId) values.push(scopeName(requirement.partnerNetworkId));
    if (requirement.enterpriseOrganizationId) values.push(scopeName(requirement.enterpriseOrganizationId));
    return values.join(' / ') || 'No scope restriction';
  }
  function grantSummary(levelId) {
    const environments = (draft.allowedEnvironments[levelId] || []).length;
    const routes = (draft.allowedModels[levelId] || []).length;
    const tools = (draft.allowedTools[levelId] || []).length;
    return `${resourceCount(environments, 'environment')} / ${resourceCount(routes, 'route')} / ${resourceCount(tools, 'tool')}`;
  }
  function ensureAuthorizationLevel() {
    if (!draft.levelDefinitions.some(definition => definition.id === selectedAuthorizationLevel)) selectedAuthorizationLevel = initialDraftLevel() || draft.levelDefinitions[0]?.id || null;
    return levelDefinition(selectedAuthorizationLevel);
  }
  function grantEntries(key) {
    let entries;
    if (key === 'allowedEnvironments') entries = draft.environmentDefinitions.map(definition => ({ id: definition.id, name: definition.name, meta: `Base: ${definition.baseEnvironment}` }));
    else if (key === 'allowedModels') entries = Object.values(state.settings.routes).map(route => ({ id: route.id, name: route.name, meta: `${route.model} / ${environmentName(route.geography)}` }));
    else entries = state.tools.map(tool => ({ id: tool.id, name: tool.name, meta: `${tool.serviceGroup} / ${environmentName(tool.sovereignty)}` }));
    const knownIds = new Set(entries.map(entry => entry.id));
    const unknownIds = draft.levelDefinitions.flatMap(definition => draft[key][definition.id] || []).filter(id => !knownIds.has(id));
    return [...entries, ...[...new Set(unknownIds)].map(id => ({ id, name: id, meta: 'Not in the configured catalog', unknown: true }))];
  }
  function renderGrantEditors() {
    const root = $('policyGrantEditors'); root.replaceChildren();
    for (const definition of draft.levelDefinitions) {
      const editor = node('details', '', 'grant-editor'); editor.open = definition.id === selectedAuthorizationLevel;
      const summary = node('summary', '', 'grant-editor__summary');
      const summaryTitle = node('span'); summaryTitle.append(node('strong', definition.name), node('span', ` ${definition.id}`, 'grant-editor__id'));
      const summaryMeta = node('span', grantSummary(definition.id), 'grant-editor__count');
      summary.append(summaryTitle, summaryMeta); editor.append(summary);
      const groups = node('div', '', 'grant-editor__groups');
      for (const [key, title] of [['allowedEnvironments', 'Execution environments'], ['allowedModels', 'Model routes'], ['allowedTools', 'Tools']]) {
        draft[key][definition.id] ||= [];
        const group = node('section', '', `grant-group grant-group--${key}`);
        const groupHead = node('div', '', 'grant-group__head');
        groupHead.append(node('h4', title), node('span', `${draft[key][definition.id].length} granted`, 'grant-group__count'));
        const options = node('div', '', 'grant-options');
        for (const entry of grantEntries(key)) {
          const optionLabel = node('label', '', `grant-option${entry.unknown ? ' grant-option--warning' : ''}`);
          const checkbox = input('', draft[key][definition.id].includes(entry.id), 'checkbox');
          checkbox.onchange = () => {
            const current = draft[key][definition.id] || [];
            draft[key][definition.id] = checkbox.checked ? [...new Set([...current, entry.id])] : current.filter(id => id !== entry.id);
            groupHead.lastChild.textContent = `${draft[key][definition.id].length} granted`;
            summaryMeta.textContent = grantSummary(definition.id);
            mark();
          };
          const copyRoot = node('span', '', 'grant-option__copy');
          copyRoot.append(node('strong', entry.name), node('span', entry.meta));
          optionLabel.append(checkbox, copyRoot); options.append(optionLabel);
        }
        group.append(groupHead, options); groups.append(group);
      }
      editor.append(groups); root.append(editor);
    }
  }
  function authorizationItem(title, meta, constraint = '', stateBadge = null) {
    const item = node('div', '', 'authorization-item');
    const head = node('div', '', 'authorization-item__head'); head.append(node('strong', title));
    if (stateBadge) head.append(badge(stateBadge[0], stateBadge[1]));
    item.append(head, node('div', meta, 'authorization-item__meta'));
    if (constraint) item.append(node('div', constraint, 'authorization-item__constraint'));
    return item;
  }
  function renderAuthorizationMap() {
    const root = $('authorizationMap');
    if (!root || !draft) return;
    const selectedDefinition = ensureAuthorizationLevel(); root.replaceChildren();
    if (!selectedDefinition) return;
    const selector = node('div', '', 'authorization-levels'); selector.setAttribute('aria-label', 'Protection level to inspect');
    for (const definition of draft.levelDefinitions) {
      const control = button('', () => { selectedAuthorizationLevel = definition.id; renderGrantEditors(); renderAuthorizationMap(); });
      control.className = `authorization-level authorization-level--${levelTone(definition.id)}`;
      control.setAttribute('aria-pressed', String(definition.id === selectedDefinition.id));
      control.append(node('span', definition.name), node('small', grantSummary(definition.id)));
      selector.append(control);
    }
    const flow = node('div', '', 'authorization-flow');
    const levelStage = node('section', '', `authorization-stage authorization-stage--level authorization-stage--${levelTone(selectedDefinition.id)}`);
    levelStage.append(node('div', '01 / Protection level', 'authorization-stage__eyebrow'), node('h3', selectedDefinition.name), node('p', `Stable ID ${selectedDefinition.id}`, 'authorization-stage__meta'));
    const levelFacts = node('dl', '', 'authorization-level-facts');
    const entryLevel = initialDraftLevel();
    for (const [label, value] of [['Baseline', selectedDefinition.baseLevel], ['Chat entry', entryLevel === selectedDefinition.id ? 'Initial level' : `Elevates from ${entryLevel}`]]) {
      const fact = node('div'); fact.append(node('dt', label), node('dd', value)); levelFacts.append(fact);
    }
    levelStage.append(levelFacts);
    const stage = (step, title, key, renderEntry) => {
      const allEntries = grantEntries(key), byId = new Map(allEntries.map(entry => [entry.id, entry]));
      const grantedIds = draft[key][selectedDefinition.id] || [];
      const granted = grantedIds.map(id => byId.get(id) || { id, name: id, meta: 'Not in the configured catalog', unknown: true });
      const denied = allEntries.filter(entry => !grantedIds.includes(entry.id));
      const section = node('section', '', 'authorization-stage');
      section.append(node('div', `${step} / ${title}`, 'authorization-stage__eyebrow'));
      const heading = node('div', '', 'authorization-stage__heading'); heading.append(node('h3', `${granted.length} granted`), node('span', `${denied.length} not granted`, 'authorization-stage__meta')); section.append(heading);
      const list = node('div', '', 'authorization-list');
      if (!granted.length) list.append(node('p', 'No resources granted by this draft.', 'authorization-empty'));
      else granted.forEach(entry => list.append(renderEntry(entry)));
      section.append(list);
      if (denied.length) {
        const deniedDetails = node('details', '', 'authorization-denied'); deniedDetails.append(node('summary', `Show ${denied.length} not granted`));
        const deniedList = node('div', '', 'authorization-denied__list'); denied.forEach(entry => deniedList.append(node('span', entry.name))); deniedDetails.append(deniedList); section.append(deniedDetails);
      }
      return section;
    };
    const environments = stage('02', 'Execution environments', 'allowedEnvironments', entry => {
      const definition = draft.environmentDefinitions.find(item => item.id === entry.id);
      const boundaries = draft.scopeDefinitions.filter(scope => scope.requiredEnvironmentId === entry.id).map(scope => scope.name);
      return authorizationItem(entry.name, `Base: ${definition?.baseEnvironment || entry.id}`, boundaries.length ? `Required by ${boundaries.join(', ')}` : 'No business boundary requires this environment');
    });
    const routes = stage('03', 'Model routes', 'allowedModels', entry => {
      const route = state.settings.routes[entry.id];
      if (!route) return authorizationItem(entry.name, entry.meta, 'Unknown route; publishing validation applies.', ['Unknown', 'warning']);
      const declaration = draft.routeEnvironmentDeclarations?.[route.id];
      const statement = declaration?.statement || 'No execution-environment declaration.';
      const allowedEnvironmentBases = (draft.allowedEnvironments[selectedDefinition.id] || []).map(environmentBase);
      const environmentGranted = allowedEnvironmentBases.includes(environmentBase(route.geography));
      const routeState = !route.enabled ? ['Disabled', 'warning'] : !environmentGranted ? ['Environment blocked', 'warning'] : ['Enabled', 'success'];
      return authorizationItem(route.name, `${route.model} / ${environmentName(route.geography)}`, statement, routeState);
    });
    const tools = stage('04', 'Tools', 'allowedTools', entry => {
      const tool = state.tools.find(item => item.id === entry.id);
      if (!tool) return authorizationItem(entry.name, entry.meta, 'Unknown tool; publishing validation applies.', ['Unknown', 'warning']);
      const requirement = draft.toolScopeRequirements?.[tool.id] || tool.requiredScope;
      const minimumMet = protectionAtLeast(selectedDefinition.baseLevel, tool.minimumLevel, bases);
      const environmentGranted = (draft.allowedEnvironments[selectedDefinition.id] || []).map(environmentBase).includes(environmentBase(tool.sovereignty));
      const mismatch = !minimumMet || !environmentGranted;
      return authorizationItem(tool.name, `${tool.serviceGroup} / ${environmentName(tool.sovereignty)}`, `Minimum ${tool.minimumLevel} / ${scopeRequirementText(requirement)}`, mismatch ? ['Runtime mismatch', 'warning'] : null);
    });
    flow.append(levelStage, environments, routes, tools);
    const decision = node('div', '', 'authorization-decision');
    decision.append(node('strong', 'Runtime decision'), node('span', 'A request proceeds only when the policy grants the resource and its enabled-state, minimum-level, execution-boundary, and scope checks also pass.'));
    root.append(selector, flow, decision);
    $('authorizationMapStatus').replaceChildren(badge(dirty ? 'Unsaved changes shown' : 'Saved draft', dirty ? 'warning' : 'muted'), badge(selectedDefinition.name, levelTone(selectedDefinition.id)));
  }
  function renderResourcePolicySummary() {
    const root = $('resourcePolicySummary');
    if (!root || !draft) return;
    root.replaceChildren(...draft.levelDefinitions.map(definition => {
      const card = node('article', '', `resource-policy-card resource-policy-card--${levelTone(definition.id)}`);
      const head = node('div', '', 'resource-policy-card__head'); head.append(node('h3', definition.name), badge(definition.baseLevel, levelTone(definition.id))); card.append(head);
      const counts = node('div', '', 'resource-policy-card__counts');
      for (const [value, label] of [[draft.allowedModels[definition.id]?.length || 0, 'model routes'], [draft.allowedTools[definition.id]?.length || 0, 'tools'], [draft.allowedEnvironments[definition.id]?.length || 0, 'environments']]) {
        const count = node('div'); count.append(node('strong', String(value)), node('span', label)); counts.append(count);
      }
      const environmentList = node('div', '', 'resource-policy-card__environments');
      for (const environmentId of draft.allowedEnvironments[definition.id] || []) environmentList.append(node('span', environmentName(environmentId)));
      const inspect = button('Inspect policy', () => { selectedAuthorizationLevel = definition.id; tabs('policies'); renderGrantEditors(); renderAuthorizationMap(); $('authorizationMap').scrollIntoView({ block: 'start' }); }, 'ghost');
      card.append(counts, environmentList, inspect); return card;
    }));
  }
  function renderAuthorizationLabels() {
    if (!draft) return;
    document.querySelectorAll('[data-policy-key][data-resource-id]').forEach(root => {
      const levels = draft.levelDefinitions.filter(definition => (draft[root.dataset.policyKey]?.[definition.id] || []).includes(root.dataset.resourceId));
      root.replaceChildren(node('span', 'Draft grants', 'resource-grants__label'), ...(levels.length ? levels.map(definition => badge(definition.name, levelTone(definition.id))) : [badge('Not granted', 'danger')]));
    });
  }
  function filterToolCatalog() {
    const catalog = $('toolCatalog');
    if (!catalog || !draft) return;
    const query = toolSearchTerm.trim().toLowerCase();
    const cards = [...catalog.querySelectorAll('[data-tool-id]')];
    let visible = 0;
    for (const card of cards) {
      const tool = state.tools.find(item => item.id === card.dataset.toolId);
      const searchable = `${tool?.name || ''} ${tool?.id || ''} ${tool?.description || ''} ${tool?.serviceGroup || ''}`.toLowerCase();
      const levelMatch = !toolFilterLevel || (draft.allowedTools[toolFilterLevel] || []).includes(card.dataset.toolId);
      card.hidden = !levelMatch || (query && !searchable.includes(query));
      if (!card.hidden) visible += 1;
    }
    catalog.querySelectorAll('.catalog-group').forEach(group => { group.hidden = ![...group.querySelectorAll('[data-tool-id]')].some(card => !card.hidden); });
    if ($('toolCatalogCount')) $('toolCatalogCount').textContent = `${visible} of ${cards.length} tools`;
  }
  function renderScopeDefinitions() {
    const root = $('scopeDefinitionGroups'); root.replaceChildren();
    for (const type of draft.scopeTypes) {
      const group = node('section', '', 'scope-group');
      const head = node('div', '', 'section-row section-row--space-between');
      head.append(node('h3', type.displayName || type.name), button('Add', () => addScopeDefinition(type.id)));
      group.append(head);
      const table = node('table', '', 'matrix scope-matrix');
      const tableHead = node('thead'), headingRow = node('tr');
      for (const heading of ['Stable id', 'Name', 'Required execution environment', 'Actions']) headingRow.append(node('th', heading));
      tableHead.append(headingRow);
      const body = node('tbody');
      for (const definition of draft.scopeDefinitions.filter(entry => entry.type === type.id)) {
        const row = node('tr');
        row.append(node('td', definition.id));
        const nameInput = input('', definition.name); nameInput.setAttribute('aria-label', `${definition.id} scope name`);
        nameInput.onchange = () => { definition.name = nameInput.value; mark(); renderScopeDefinitions(); };
        row.append(cell(nameInput));
        const environmentSelect = select('', draft.environmentDefinitions, definition.requiredEnvironmentId || 'Restricted Region');
        environmentSelect.setAttribute('aria-label', `${definition.name} required execution environment`);
        environmentSelect.onchange = () => { definition.requiredEnvironmentId = environmentSelect.value; mark(); renderScopeDefinitions(); };
        row.append(cell(environmentSelect));
        const remove = button('Remove', () => { draft.scopeDefinitions = draft.scopeDefinitions.filter(entry => entry.id !== definition.id); mark(); renderPolicy(); });
        remove.disabled = definition.builtIn === true;
        row.append(cell(remove)); body.append(row);
      }
      table.append(tableHead, body); group.append(table); root.append(group);
    }
    const preview = draft.scopeDefinitions.map(definition => `${definition.name}: ${environmentName(definition.requiredEnvironmentId)}`);
    $('scopePathPreview').replaceChildren(node('div', 'Boundary execution requirements', 'field-label'), ...preview.map(text => node('div', text, 'field-note')));
  }
  function renderPolicy() {
    definitions(); ensureAuthorizationLevel(); $('policyName').value = draft.name; $('policyName').oninput = e => { draft.name = e.target.value; mark(); };
    $('policyMatrixRows').replaceChildren();
    draft.levelDefinitions.forEach(def => {
      const row = node('tr'); row.append(node('td', def.id));
      const name = input('', def.name); name.setAttribute('aria-label', `${def.id} display name`); name.onchange = () => { def.name = name.value; mark(); }; row.append(cell(name));
      const base = select('', bases, def.baseLevel); base.disabled = bases.includes(def.id); base.setAttribute('aria-label', `${def.id} baseline`); base.onchange = () => { def.baseLevel = base.value; mark(); }; row.append(cell(base));
      row.append(cell(button('Remove', () => { draft.levelDefinitions = draft.levelDefinitions.filter(d => d.id !== def.id); for (const key of ['allowedModels', 'allowedTools', 'allowedEnvironments']) delete draft[key][def.id]; mark(); renderPolicy(); })));
      row.lastChild.firstChild.disabled = bases.includes(def.id); $('policyMatrixRows').append(row);
    });
    renderGrantEditors();
    $('policyEnvironmentRows').replaceChildren();
    draft.environmentDefinitions.forEach(def => {
      const row = node('tr'); row.append(node('td', def.id)); const name = input('', def.name); name.setAttribute('aria-label', `${def.id} environment name`); name.onchange = () => { def.name = name.value; mark(); }; row.append(cell(name));
      const base = select('', envBases, def.baseEnvironment); base.disabled = envBases.includes(def.id); base.onchange = () => { def.baseEnvironment = base.value; mark(); }; row.append(cell(base));
      const remove = button('Remove', () => { draft.environmentDefinitions = draft.environmentDefinitions.filter(d => d.id !== def.id); mark(); renderPolicy(); }); remove.disabled = envBases.includes(def.id); row.append(cell(remove)); $('policyEnvironmentRows').append(row);
    });
    renderScopeDefinitions();
    renderAuthorizationMap(); renderResourcePolicySummary(); renderAuthorizationLabels(); filterToolCatalog();
    syncEditor(); $('policyOdrl').value = json(draft.odrl || state.draft.odrl); $('policyOdrlPreview').textContent = json(draft.odrl || state.draft.odrl);
    $('publishDraftButton').disabled = dirty || busy;
  }
  function cell(child) { const td = node('td'); td.append(child); return td; }
  function addDefinition(kind) {
    const dialog = node('dialog', '', 'panel'); dialog.setAttribute('aria-label', `Add ${kind}`);
    const id = input('', ''), name = input('', ''), base = select('', kind === 'level' ? bases : envBases, kind === 'level' ? 'Highly Confidential' : 'On-premises');
    dialog.append(node('h2', `Add ${kind}`), field('Stable ID (letters, digits, underscore)', id), field('Display name', name), field('Inherit protection baseline', base));
    const note = node('p', '', 'note'); dialog.append(note);
    dialog.append(button('Cancel', () => { dialog.close(); dialog.remove(); }), button('Add to draft', () => {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(id.value) || !name.value.trim()) { note.textContent = 'Enter a valid unique ID and display name.'; return; }
      const list = kind === 'level' ? draft.levelDefinitions : draft.environmentDefinitions;
      if (list.some(d => d.id === id.value)) { note.textContent = 'ID already exists.'; return; }
      list.push({ id: id.value, name: name.value.trim(), [kind === 'level' ? 'baseLevel' : 'baseEnvironment']: base.value });
      if (kind === 'level') for (const key of ['allowedModels', 'allowedTools', 'allowedEnvironments']) draft[key][id.value] = [];
      mark(); renderPolicy(); dialog.close(); dialog.remove();
    }, 'primary')); document.body.append(dialog); dialog.showModal();
  }
  function addScopeDefinition(typeId) {
    const dialog = node('dialog', '', 'panel'); dialog.setAttribute('aria-label', `Add ${typeId}`);
    const idInput = input('', ''), nameInput = input('', '');
    dialog.append(node('h2', `Add ${draft.scopeTypes.find(type => type.id === typeId)?.displayName || typeId}`), field('Stable ID', idInput), field('Display name', nameInput));
    const environmentSelect = select('', draft.environmentDefinitions, 'Restricted Region');
    dialog.append(field('Required execution environment', environmentSelect));
    const note = node('p', '', 'note'); dialog.append(note);
    dialog.append(button('Cancel', () => { dialog.close(); dialog.remove(); }), button('Add to draft', () => {
      const id = idInput.value.trim();
      if (!/^[A-Za-z][A-Za-z0-9._:-]{0,79}$/.test(id) || !nameInput.value.trim()) { note.textContent = 'Enter a valid unique ID and display name.'; return; }
      if (draft.scopeDefinitions.some(definition => definition.id === id)) { note.textContent = 'ID already exists.'; return; }
      draft.scopeDefinitions.push({ id, name: nameInput.value.trim(), type: typeId, requiredEnvironmentId: environmentSelect.value, builtIn: false });
      mark(); renderPolicy(); dialog.close(); dialog.remove();
    }, 'primary')); document.body.append(dialog); dialog.showModal();
  }
  $('addLevelButton').onclick = () => addDefinition('level'); $('addEnvironmentButton').onclick = () => addDefinition('environment');
  $('policyJson').oninput = () => { dirty = true; $('publishDraftButton').disabled = true; status('Apply JSON before saving'); };
  $('policyOdrl').oninput = () => { dirty = true; $('publishDraftButton').disabled = true; status('Save ODRL before publishing'); };
  $('applyJsonButton').onclick = async () => { try { draft = await api('/api/policy/preview', 'POST', JSON.parse($('policyJson').value)); mark(); renderPolicy(); status('JSON validated'); } catch(e) { status(e.message, 'danger'); } };
  $('saveDraftButton').onclick = async () => {
    try { draft = await api('/api/policy/draft', 'PUT', JSON.parse($('policyJson').value)); dirty = false; state.draft = draft; renderPolicy(); status('Draft saved', 'success'); } catch(e) { status(e.message, 'danger'); }
  };
  $('saveOdrlButton').onclick = async () => { try { draft = await api('/api/policy/odrl', 'PUT', JSON.parse($('policyOdrl').value)); state.draft = draft; dirty = false; renderPolicy(); status('ODRL validated and saved', 'success'); } catch(e) { status(e.message, 'danger'); } };
  $('publishDraftButton').onclick = () => {
    if (dirty || busy) return;
    const dialog = node('dialog', '', 'panel'); dialog.setAttribute('aria-label', 'Confirm policy publication'); dialog.append(node('h2', `Publish policy v${state.active.payload.version + 1}?`), node('p', 'New chats use this version. Existing chats retain their signed policy and protection history.'));
    const changes = node('ul'); for (const k of ['allowedModels', 'allowedTools', 'allowedEnvironments']) for (const def of draft.levelDefinitions) {
      const before = state.active.payload[k][def.id] || [], after = draft[k][def.id] || []; if (json(before) !== json(after)) changes.append(node('li', `${def.name} · ${k}: ${before.join(', ') || 'none'} → ${after.join(', ') || 'none'}`));
    }
    if (json(state.active.payload.scopeDefinitions || []) !== json(draft.scopeDefinitions || [])) changes.append(node('li', 'Business boundary definitions or execution requirements changed.'));
    if (!changes.children.length) changes.append(node('li', 'Metadata or vocabulary revision; no model/tool/environment allowance changes.'));
    dialog.append(changes, button('Cancel', () => { dialog.close(); dialog.remove(); }), button('Publish signed policy', async e => {
      if (busy) return; busy = true; e.target.disabled = true;
      try { await api('/api/policy/publish', 'POST', {}); dialog.close(); dialog.remove(); await load(); status('Signed policy published', 'success'); } catch(error) { status(error.message, 'danger'); } finally { busy = false; $('publishDraftButton').disabled = dirty; }
    }, 'primary')); document.body.append(dialog); dialog.showModal();
  };
  function renderVersions() { $('policyVersions').replaceChildren(); [...state.policies].reverse().forEach(b => {
    const article = node('article', '', 'list-item'); article.append(node('h3', `Version ${b.payload.version} · ${b.payload.name}`), badge(b.payload.version === state.active.payload.version ? 'Active' : 'Historical'), details('Signed policy, digest and ODRL', b)); $('policyVersions').append(article);
  }); }
  function renderSettings() {
    const root = $('routeSettings'); root.replaceChildren(); const settings = state.settings;
    const euOrder = settings.euRouting.order;
    const poolDefinition = settings.routingPoolDefinition;
    const euChoices = poolDefinition.routeIds.map(id => ({ id, name: settings.routes[id].name }));
    const routingControls = node('div', '', 'routing-controls');
    const routing = node('article', '', 'list-item routing-control');
    routing.append(node('h3', poolDefinition.label), node('p', 'Cost scores are administrator-maintained relative estimates, not live quota data. Lower scores route first; priority order breaks ties and controls priority mode.', 'note'),
      field('Selection strategy', select('euRoutingStrategy', [{ id: 'cost', name: 'Lowest configured cost' }, { id: 'priority', name: 'Configured priority' }], settings.euRouting.strategy)),
      field('Automatic fallback', input('euFallbackEnabled', settings.euRouting.fallbackEnabled, 'checkbox')));
    euOrder.forEach((routeId, index) => routing.append(field(`Priority ${index + 1}`, select(`euRouteOrder_${index}`, euChoices, routeId))));
    const preferences = node('article', '', 'list-item routing-control'); preferences.append(node('h3', 'Protection-level preferences'), node('p', 'Preferred routes are selected only from the routes authorized for each baseline protection level.', 'note'));
    for (const preference of settings.preferenceDefinitions) {
      const choices = preference.allowedRouteIds.map(routeId => ({ id: routeId, name: settings.routes[routeId].name }));
      preferences.append(field(preference.label, select(`routePreference_${preference.id}`, choices, settings.preferences[preference.id])));
    }
    routingControls.append(routing, preferences); root.append(routingControls);
    const routeHeading = node('div', '', 'settings-subhead'); routeHeading.append(node('h3', 'Configured routes'), node('span', `${Object.keys(settings.routes).length} routes`, 'field-note')); root.append(routeHeading);
    const routeGrid = node('div', '', 'route-card-grid');
    for (const r of Object.values(settings.routes)) {
      const remote = r.requiresApiKey;
      const pooled = poolDefinition.routeIds.includes(r.id);
      const note = remote ? 'Provider location is declared, not independently attested. Key encrypted for your Windows account.' : r.kind === 'ollama' ? 'Local Ollama execution.' : r.kind === 'copilot' ? 'Existing Copilot sign-in · Public synthetic data only.' : 'Configured model execution.';
      const declaration = draft.routeEnvironmentDeclarations?.[r.id];
      const card = node('article', '', 'list-item route-card');
      const head = node('div', '', 'list-item__head');
      const identity = node('div'); identity.append(node('h3', r.name), node('div', `${r.kind} / ${r.id}`, 'list-item__meta'));
      const routeState = node('div', '', 'badge-row'); routeState.append(badge(r.enabled ? 'Enabled' : 'Disabled', r.enabled ? 'success' : 'warning'), badge(environmentName(r.geography))); head.append(identity, routeState);
      const grants = node('div', '', 'resource-grants'); grants.dataset.policyKey = 'allowedModels'; grants.dataset.resourceId = r.id;
      card.append(head, grants);
      if (declaration) {
        const constraint = node('div', '', 'resource-constraint'); constraint.append(badge(declaration.attested ? 'Attested' : declaration.basis, declaration.attested ? 'success' : 'warning'), node('span', declaration.statement)); card.append(constraint);
      }
      card.append(node('p', note, 'note'));
      const endpoint = select(`routeBaseUrl_${r.id}`, r.approvedBaseUrls, r.baseUrl); endpoint.disabled = r.approvedBaseUrls.length === 1;
      card.append(field('Name', input(`routeName_${r.id}`, r.name)), field('Model', input(`routeModel_${r.id}`, r.model)), field('Endpoint (approved host)', endpoint), field('Enabled', input(`routeEnabled_${r.id}`, r.enabled, 'checkbox')));
      if (pooled) { const cost = input(`routeCost_${r.id}`, r.costScore, 'number'); cost.min = '0'; cost.step = '0.001'; card.append(field('Relative cost score', cost)); }
      if (remote) { const key = input(`routeKey_${r.id}`, '', 'password'); key.autocomplete = 'new-password'; key.placeholder = settings.secrets.routeApiKeyPresent[r.id] ? 'Encrypted key stored · blank preserves it' : 'Enter API key'; card.append(field(`${r.name} API key`, key)); }
      const result = node('div', '', 'note'); card.append(button('Probe / check model', async e => { e.target.disabled = true; try { const x = await api(`/api/routes/${r.id}/probe`, 'POST', {}); result.replaceChildren(badge(x.ok ? 'Model discovered' : 'Unavailable', x.ok ? 'success' : 'danger'), node('p', x.message), ...(x.models ? [details(`${x.models.length} available models`, x.models.map(m => m.name || m.id).join('\n'))] : [])); } catch(error) { result.textContent = error.message; } finally { e.target.disabled = false; } }), result);
      if (remote) card.append(button('Clear key', async () => { if (!confirm(`Remove the encrypted ${r.name} key?`)) return; try { await api('/api/settings', 'PUT', { clearRouteApiKeys: [r.id] }); await load(); status('Encrypted key removed', 'success'); } catch(e) { status(e.message, 'danger'); } }));
      routeGrid.append(card);
    }
    root.append(routeGrid, button('Save settings', async e => { e.target.disabled = true; try {
      const order = euOrder.map((_, index) => $(`euRouteOrder_${index}`).value);
      if (new Set(order).size !== order.length) throw new Error('Choose each EU provider exactly once in priority order.');
      const payload = { preferences: Object.fromEntries(settings.preferenceDefinitions.map(preference => [preference.id, $(`routePreference_${preference.id}`).value])),
        euRouting: { strategy: $('euRoutingStrategy').value, fallbackEnabled: $('euFallbackEnabled').checked, order },
        routes: Object.values(settings.routes).map(r => ({ id: r.id, name: $(`routeName_${r.id}`).value, model: $(`routeModel_${r.id}`).value, baseUrl: $(`routeBaseUrl_${r.id}`).value, enabled: $(`routeEnabled_${r.id}`).checked, ...(euOrder.includes(r.id) ? { costScore: Number($(`routeCost_${r.id}`).value) } : {}) })),
        routeApiKeys: {} };
      Object.keys(settings.secrets.routeApiKeyPresent).forEach(id => { if ($(`routeKey_${id}`).value) payload.routeApiKeys[id] = $(`routeKey_${id}`).value; });
      await api('/api/settings', 'PUT', payload); await load(); status('Settings saved', 'success');
    } catch(error) { status(error.message, 'danger'); } finally { e.target.disabled = false; } }, 'primary'));
    const catalog = $('toolCatalog'); catalog.replaceChildren();
    if (toolFilterLevel && !draft.levelDefinitions.some(definition => definition.id === toolFilterLevel)) toolFilterLevel = '';
    const catalogToolbar = node('div', '', 'resource-toolbar');
    const search = input('toolCatalogSearch', toolSearchTerm, 'search'); search.placeholder = 'Name, ID, group, or purpose'; search.oninput = () => { toolSearchTerm = search.value; filterToolCatalog(); };
    const levelFilter = select('toolPolicyFilter', [{ id: '', name: 'All protection levels' }, ...draft.levelDefinitions], toolFilterLevel); levelFilter.onchange = () => { toolFilterLevel = levelFilter.value; filterToolCatalog(); };
    const catalogCount = node('span', '', 'resource-toolbar__count'); catalogCount.id = 'toolCatalogCount';
    catalogToolbar.append(field('Search tools', search), field('Draft grant', levelFilter), catalogCount); catalog.append(catalogToolbar);
    const groups = [...new Set(state.tools.map(tool => tool.serviceGroup))];
    for (const groupName of groups) {
      const group = node('section', '', 'catalog-group'); group.append(node('h3', groupName));
      const groupItems = node('div', '', 'catalog-group__items');
      for (const tool of state.tools.filter(entry => entry.serviceGroup === groupName)) {
        const item = node('article', '', 'list-item tool-card'); item.dataset.toolId = tool.id;
        const requirement = draft.toolScopeRequirements?.[tool.id] || tool.requiredScope;
        const head = node('div', '', 'list-item__head');
        const identity = node('div'); identity.append(node('div', tool.name, 'list-item__title'), node('div', tool.id, 'list-item__meta'));
        const runtime = node('div', '', 'badge-row'); runtime.append(badge(tool.minimumLevel, levelTone(tool.minimumLevel)), badge(environmentName(tool.sovereignty))); head.append(identity, runtime);
        const grants = node('div', '', 'resource-grants'); grants.dataset.policyKey = 'allowedTools'; grants.dataset.resourceId = tool.id;
        const facts = node('dl', '', 'resource-facts');
        for (const [label, value] of [['Execution', environmentName(tool.sovereignty)], ['Scope', scopeRequirementText(requirement)], ['Endpoint', tool.endpoint]]) {
          const fact = node('div'); fact.append(node('dt', label), node('dd', value)); facts.append(fact);
        }
        item.append(head, grants, facts, node('p', tool.description, 'note')); groupItems.append(item);
      }
      group.append(groupItems); catalog.append(group);
    }
    renderResourcePolicySummary(); renderAuthorizationLabels(); filterToolCatalog();
  }
  function renderCredentials() {
    const claimDisplay = {
      'saw-policy': ['Policy received', 'Received the published policy represented by this credential.'],
      'accepted-policy': ['Policy accepted', 'Accepted the exact policy version and digest recorded here.'],
      'commitment-to-behave': ['Behavior committed', 'Committed to operate under the accepted policy.'],
    };
    const participantKinds = { agent: 'Agent', model: 'Model', tool: 'Tool' };
    const date = value => {
      const parsed = new Date(value);
      return Number.isNaN(parsed.valueOf()) ? 'Not specified' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(parsed);
    };
    const words = value => String(value).split(/[-_]/).filter(Boolean).map(word => word[0]?.toUpperCase() + word.slice(1)).join(' ');
    $('credentialList').replaceChildren(...state.credentials.map(credential => {
      const payload = credential.payload;
      const expired = Number.isFinite(Date.parse(payload.validUntil)) && Date.parse(payload.validUntil) <= Date.now();
      const stateLabel = credential.revoked ? 'Revoked' : expired ? 'Expired' : payload.status === 'active' ? 'Active' : words(payload.status);
      const stateTone = credential.revoked ? 'danger' : expired ? 'warning' : payload.status === 'active' ? 'success' : 'muted';
      const kind = participantKinds[payload.participantKind] || words(payload.participantKind || 'Participant');
      const card = node('article', '', `credential-card${credential.revoked ? ' credential-card--revoked' : ''}`);
      const head = node('div', '', 'credential-card__head');
      const identity = node('div', '', 'credential-card__identity');
      const mark = node('span', kind.slice(0, 1), 'credential-card__mark'); mark.setAttribute('aria-hidden', 'true');
      const title = node('div');
      title.append(node('div', kind, 'credential-card__kind'), node('h3', payload.participantLabel || payload.participantId), node('div', `Policy acceptance · version ${payload.policyVersion}`, 'credential-card__subtitle'));
      identity.append(mark, title); head.append(identity, badge(stateLabel, stateTone));

      const attestations = node('section', '', 'credential-card__attestations');
      const attestationHead = node('div', '', 'credential-card__section-head');
      attestationHead.append(node('strong', 'Issuer attestations'), node('span', `${payload.claims?.length || 0} claims`, 'credential-card__count'));
      const claimList = node('div', '', 'credential-claims');
      for (const claim of payload.claims || []) {
        const [label, description] = claimDisplay[claim] || [words(claim), 'Included as an assertion by the credential issuer.'];
        const item = node('div', '', 'credential-claim');
        const check = node('span', '✓', 'credential-claim__check'); check.setAttribute('aria-hidden', 'true');
        const text = node('div'); text.append(node('strong', label), node('span', description));
        item.append(check, text); claimList.append(item);
      }
      attestations.append(attestationHead, claimList);

      const facts = node('dl', '', 'credential-facts');
      for (const [label, value] of [
        ['Issued by', payload.issuer],
        ['Policy', `Version ${payload.policyVersion}`],
        ['Issued', date(payload.issuedAt)],
        ['Valid until', date(payload.validUntil)],
      ]) {
        const fact = node('div', '', 'credential-fact'); fact.append(node('dt', label), node('dd', value)); facts.append(fact);
      }

      const foot = node('div', '', 'credential-card__foot');
      const raw = details('Credential details', credential); raw.classList.add('credential-card__details');
      const action = button(credential.revoked ? 'Restore credential' : 'Revoke credential', async event => {
        event.target.disabled = true; try { await api('/api/credentials', 'POST', { participantId: payload.participantId, policyVersion: payload.policyVersion, revoked: !credential.revoked }); await load(); status('Credential status updated', 'success'); } catch(error) { status(error.message, 'danger'); }
      }, credential.revoked ? '' : 'danger');
      foot.append(raw, action); card.append(head, attestations, facts, foot); return card;
    }));
  }
  async function load() { state = await api('/api/state'); bases = [...state.deployment.policy.baselineLevelIds]; envBases = [...state.deployment.policy.baselineEnvironmentIds]; draft = copy(state.draft); dirty = false; renderPolicy(); renderVersions(); renderSettings(); renderCredentials(); status(); }
  load().catch(e => status(e.message, 'danger'));
}

export function mountCompliancePage() {
  let records = [], selected = null, verification, vocabulary = { scopeDefinitions: [], environmentDefinitions: [] };
  const filters = [['filterAgent', 'agentId', 'All agents'], ['filterChat', 'chatId', 'All chats'], ['filterLevel', 'level', 'All levels'], ['filterTool', 'toolId', 'All tools'], ['filterEnvironment', 'environment', 'All environments'], ['filterRelease', 'release', 'All release states'], ['filterKind', 'kind', 'All events']];
  const title = r => ({ 'chat-created': 'Conversation started', 'chat-classified': 'Protection retained', 'chat-elevated': 'Protection increased', 'environment-transition-refused': 'Environment transition refused', 'scope-transition-refused': 'Environment transition refused', 'tool-elevation': 'Tool required higher protection', 'tool-withheld': 'Protected data withheld before release', 'model-authorized': 'Model permitted', 'model-egress-failed': 'Model route failed', 'model-route-fallback': 'Governed model fallback', 'tool-executed': 'Tool completed', 'tool-denied': 'Tool blocked', 'request-refused': 'Request refused', 'model-response': 'Agent answered', 'policy-published': 'Signed policy published' }[r.kind] || r.kind.replaceAll('-', ' '));
  const outcome = r => r.outcome || (/denied|refused|conflict/.test(r.kind) ? 'denied' : '');
  const matches = r => filters.every(([id, key]) => !$(id).value || (key === 'kind' && $(id).value === 'blocked' ? outcome(r) === 'denied' : r[key] === $(id).value));
  const scopeName = scopeId => vocabulary.scopeDefinitions?.find(definition => definition.id === scopeId)?.name || scopeId;
  const complianceEnvironmentName = environmentId => vocabulary.environmentDefinitions?.find(definition => definition.id === environmentId)?.name || environmentId;
  const scopeText = record => {
    const scope = record.scope || record.to?.scope;
    return [...(scope?.partnerNetworkIds || []).map(scopeName), ...(scope?.enterpriseOrganizationIds || []).map(scopeName)].join(' · ');
  };
  function verifyView() { $('verificationResult').replaceChildren(...(verification ? [badge(verification.ok ? `Verified ${verification.checked} records` : 'Verification failed', verification.ok ? 'success' : 'danger'), node('p', verification.error || verification.storage, 'note')] : [])); }
  function render() {
    const visible = records.filter(matches).sort((a, b) => b.seq - a.seq); if (selected && !visible.includes(selected)) selected = null;
    $('complianceStatus').replaceChildren(badge(`${visible.length} events`), badge(`${new Set(visible.map(r => r.chatId).filter(Boolean)).size} chats`), badge(`${visible.filter(r => outcome(r) === 'denied').length} blocked`, 'warning'), badge(`${visible.filter(r => r.release === 'withheld').length} withheld`));
    $('ledgerRows').replaceChildren();
    visible.forEach(r => {
      const row = node('tr'); row.tabIndex = 0; row.setAttribute('aria-selected', String(r === selected));
      const values = [r.seq, new Date(r.timestamp).toLocaleTimeString(), title(r), r.chatId?.slice(-8), r.agentId, r.level || r.to?.level, complianceEnvironmentName(r.environment), scopeText(r), r.toolId, r.release, outcome(r)]; values.forEach(v => row.append(node('td', v ?? '')));
      const choose = () => { selected = r; render(); }; row.onclick = choose; row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } }; $('ledgerRows').append(row);
    });
    if (!visible.length) { const r = node('tr'), td = node('td', 'No matching events.'); td.colSpan = 11; r.append(td); $('ledgerRows').append(r); }
    const chatId = $('filterChat').value || selected?.chatId;
    $('recordInspector').replaceChildren(...(selected ? [node('h3', title(selected)), ...(selected.code ? [badge(selected.code, 'warning')] : []), node('p', selected.prompt || selected.message || selected.reason || ''), ...(scopeText(selected) ? [node('p', scopeText(selected), 'note')] : []), ...(selected.from ? [node('p', `${selected.from.level} / ${complianceEnvironmentName(selected.from.sovereignty)} → ${selected.to.level} / ${complianceEnvironmentName(selected.to.sovereignty)}`)] : []), details('Signed event and attached evidence', selected)] : [node('p', 'Select an event to inspect its evidence.', 'note')]));
    $('chatTimeline').replaceChildren();
    if (chatId) records.filter(r => r.chatId === chatId && ['input', 'chat-created', 'chat-classified', 'chat-elevated', 'environment-transition-refused', 'scope-transition-refused', 'tool-elevation', 'tool-withheld', 'model-egress-failed', 'model-route-fallback', 'tool-executed', 'tool-denied', 'model-response', 'request-refused'].includes(r.kind)).forEach(r => { const n = node('article', '', 'timeline-item'); n.append(node('strong', title(r)), node('p', r.prompt || r.message || r.reason || `${r.level || r.to?.level || ''} · ${r.toolId || r.routeId || ''}`, 'note'), ...(scopeText(r) ? [node('p', scopeText(r), 'note')] : []), node('small', `#${r.seq} · policy ${r.policyVersion || 'see signed event'}${r.release ? ` · ${r.release}` : ''}`)); $('chatTimeline').append(n); });
    $('exportLedgerButton').disabled = !chatId; verifyView();
  }
  async function load() {
    const [data, state] = await Promise.all([api('/api/ledger'), api('/api/state')]); vocabulary = state.vocabulary || vocabulary;
    records = data.records.map(record => ({ ...record, environment: record.sovereignty || record.to?.sovereignty || '', release: record.release || (record.kind === 'tool-withheld' ? 'withheld' : record.kind === 'tool-executed' ? 'released' : '') })); verification = data.verification;
    for (const [id, key, all] of filters) { const previous = $(id).value; const values = [...new Set(records.map(r => r[key]).filter(Boolean))]; $(id).replaceChildren(option('', all), ...(key === 'kind' ? [option('blocked', 'Blocked / refused')] : []), ...values.map(v => option(v, key === 'environment' ? complianceEnvironmentName(v) : v))); $(id).value = values.includes(previous) || previous === 'blocked' ? previous : ''; }
    if (selected) selected = records.find(r => r.id === selected.id); render();
  }
  filters.forEach(([id]) => $(id).onchange = () => { if (id === 'filterChat') selected = null; render(); });
  const error = e => $('complianceStatus').replaceChildren(badge(e.message, 'danger'));
  $('refreshLedgerButton').onclick = () => load().catch(error);
  $('verifyLedgerButton').onclick = async () => { try { verification = await api('/api/ledger/verify', 'POST', {}); verifyView(); } catch(e) { error(e); } };
  $('exportLedgerButton').onclick = async () => {
    const chatId = $('filterChat').value || selected?.chatId; if (!chatId) return;
    try { const data = await api(`/api/ledger/export?chatId=${encodeURIComponent(chatId)}`); const url = URL.createObjectURL(new Blob([json(data)], { type: 'application/json' })); const a = node('a'); a.href = url; a.download = `ledger-${chatId}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); $('complianceStatus').append(badge('Selected chat exported', 'success')); } catch(e) { error(e); }
  };
  load().catch(error);
}
