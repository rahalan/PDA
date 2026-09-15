const $ = id => document.getElementById(id);
const node = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
const badge = (text, tone = 'muted') => node('span', text, `badge badge--${tone}`);
const json = value => JSON.stringify(value, null, 2);
const csv = value => value.split(',').map(x => x.trim()).filter(Boolean);
const copy = value => structuredClone(value);
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
  if (!r.ok) throw new Error(data.message || data.error || `Request failed (${r.status})`);
  return data;
}
async function identityNavigation() {
  const identity = await api('/api/me');
  for (const link of document.querySelectorAll('.toplinks a')) {
    const target = new URL(link.href).pathname;
    link.hidden = target.includes('admin') ? !identity.roles.includes('Administrator')
      : target.includes('compliance') ? !identity.roles.includes('Compliance')
      : !identity.roles.some(role => ['User', 'Administrator'].includes(role));
  }
  if (!identity.local) {
    const logout = node('a', 'Sign out'); logout.href = '/.auth/logout';
    document.querySelector('.toplinks')?.append(logout);
  }
}
function routeText(route, source) { return source === 'governance' ? 'Governance refusal' : route ? `${route.name} · ${route.geography}${route.simulated ? ' · simulated' : ''}` : ''; }
function message(parent, role, text, footer = '') {
  const article = node('article', '', `message message--${role}`);
  const head = node('div', '', 'message__head'); head.append(node('span', role === 'user' ? 'You' : 'Assistant'), node('span', footer));
  const body = node('div', text, 'message__body'); article.append(head, body); parent.append(article); return { body, head };
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
  void identityNavigation().catch(() => {});
  let chat = null, busy = false, loaded = false, server;
  const prompt = $('promptInput'), level = $('confidentialitySelect'), transcript = $('chatTranscript');
  function controls() { prompt.disabled = busy || !loaded; level.disabled = busy || !!chat?.messages.length; $('sendButton').disabled = busy || !loaded || !prompt.value.trim(); $('newChatButton').disabled = busy || !loaded; }
  function status() {
    $('chatBadges').replaceChildren(...(chat ? [badge(chat.levelName || chat.level, 'accent'), badge(chat.sovereigntyName || chat.sovereignty), badge(`Policy v${chat.policyVersion}`)] : [badge('Choose how your conversation starts')]));
    $('chatMeta').textContent = chat ? `Chat ${chat.id.slice(-8)}` : 'New conversation'; controls();
  }
  function render() {
    transcript.replaceChildren();
    if (!chat?.messages.length) transcript.append(node('div', 'Ask a question to begin.', 'empty-state'));
    else chat.messages.forEach(m => message(transcript, m.role, m.content ?? m.text ?? '', routeText(m.route, m.source)));
    status();
  }
  async function send() {
    if (busy || !loaded || !prompt.value.trim()) return;
    busy = true; controls(); alert('chatAlerts', ''); const text = prompt.value.trim(); prompt.value = '';
    let pending;
    try {
      if (!chat) { chat = await api('/api/chats', 'POST', { level: level.value }); sessionStorage.setItem('cg.chat.id', chat.id); }
      chat.messages.push({ role: 'user', content: text }); render(); pending = message(transcript, 'assistant', 'Thinking…');
      await stream(`/api/chats/${chat.id}/messages`, { prompt: text }, event => {
        if (event.type === 'state' && event.chat) {
          const changed = chat.level !== event.chat.level || chat.sovereignty !== event.chat.sovereignty;
          chat = event.chat; status();
          if (changed) alert('chatAlerts', `Protection increased to ${chat.levelName || chat.level} · ${chat.sovereigntyName || chat.sovereignty}. This protection stays with the conversation.`, 'warning');
        } else if (event.type === 'delta') pending.body.textContent = (pending.body.textContent === 'Thinking…' ? '' : pending.body.textContent) + event.text;
        else if (event.type === 'route-fallback') alert('chatAlerts', `${event.fromRoute.name} was unavailable. Continuing with ${event.toRoute.name} under the same governed EU route policy.`, 'warning');
        else if (event.type === 'message') { pending.body.textContent = event.text; pending.head.lastChild.textContent = routeText(event.route, event.source); $('routeFooter').textContent = routeText(event.route, event.source); }
        else if (event.type === 'error') { pending.body.textContent = event.message; alert('chatAlerts', event.message); }
        else if (event.type === 'done' && event.chat) chat = event.chat;
      });
      chat = await api(`/api/chats/${chat.id}`); render();
    } catch (e) { alert('chatAlerts', e.message); if (pending) pending.body.textContent = e.message; }
    finally { busy = false; controls(); }
  }
  $('chatForm').onsubmit = e => { e.preventDefault(); void send(); };
  prompt.oninput = controls;
  prompt.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } };
  $('newChatButton').onclick = () => { if (busy) return; chat = null; sessionStorage.removeItem('cg.chat.id'); prompt.value = ''; $('routeFooter').textContent = ''; alert('chatAlerts', ''); render(); prompt.focus(); };
  controls();
  (async () => {
    server = await api('/api/state'); level.replaceChildren(...server.levels.map(id => option(id, server.vocabulary?.levels.find(d => d.id === id)?.name || id)));
    const old = sessionStorage.getItem('cg.chat.id'); if (old) { try { chat = await api(`/api/chats/${old}`); level.value = chat.initialLevel; } catch { sessionStorage.removeItem('cg.chat.id'); } }
    loaded = true; render();
  })().catch(e => alert('chatAlerts', e.message));
}

export function mountAdminPage() {
  void identityNavigation().catch(() => {});
  let state, draft, dirty = false, busy = false;
  const bases = ['Public', 'Internal', 'Highly Confidential'], envBases = ['Public cloud', 'EU-only', 'On-premises'];
  const status = (text = '', tone = 'muted') => $('adminStatus').replaceChildren(badge(`Policy v${state?.active.payload.version ?? '…'}`, 'accent'), badge(dirty ? 'Unsaved draft' : 'Saved draft', dirty ? 'warning' : 'muted'), ...(text ? [badge(text, tone)] : []));
  function mark() { dirty = true; $('policyJson').value = json(profile(draft)); $('publishDraftButton').disabled = true; status(); }
  function tabs(name) {
    document.querySelectorAll('[data-tab-target]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tabTarget === name)));
    document.querySelectorAll('[data-tab-panel]').forEach(p => p.classList.toggle('is-active', p.dataset.tabPanel === name));
  }
  document.querySelectorAll('[data-tab-target]').forEach(b => { b.onclick = () => tabs(b.dataset.tabTarget); });
  function definitions() {
    draft.levelDefinitions ||= bases.map(id => ({ id, name: id, baseLevel: id }));
    draft.environmentDefinitions ||= envBases.map(id => ({ id, name: id, baseEnvironment: id }));
  }
  function syncEditor() { $('policyJson').value = json(profile(draft)); }
  function renderPolicy() {
    definitions(); $('policyName').value = draft.name; $('policyName').oninput = e => { draft.name = e.target.value; mark(); };
    $('policyMatrixRows').replaceChildren();
    draft.levelDefinitions.forEach(def => {
      const row = node('tr'); row.append(node('td', def.id));
      const name = input('', def.name); name.setAttribute('aria-label', `${def.id} display name`); name.onchange = () => { def.name = name.value; mark(); }; row.append(cell(name));
      const base = select('', bases, def.baseLevel); base.disabled = bases.includes(def.id); base.setAttribute('aria-label', `${def.id} baseline`); base.onchange = () => { def.baseLevel = base.value; mark(); }; row.append(cell(base));
      for (const key of ['allowedModels', 'allowedTools', 'allowedEnvironments']) {
        draft[key][def.id] ||= [];
        const i = input(`policy${key}_${def.id.replace(/\W/g, '_')}`, draft[key][def.id].join(', ')); i.setAttribute('aria-label', `${def.name} ${key}`);
        i.onchange = () => { draft[key][def.id] = csv(i.value); mark(); }; row.append(cell(i));
      }
      row.append(cell(button('Remove', () => { draft.levelDefinitions = draft.levelDefinitions.filter(d => d.id !== def.id); for (const key of ['allowedModels', 'allowedTools', 'allowedEnvironments']) delete draft[key][def.id]; mark(); renderPolicy(); })));
      row.lastChild.firstChild.disabled = bases.includes(def.id); $('policyMatrixRows').append(row);
    });
    $('policyEnvironmentRows').replaceChildren();
    draft.environmentDefinitions.forEach(def => {
      const row = node('tr'); row.append(node('td', def.id)); const name = input('', def.name); name.setAttribute('aria-label', `${def.id} environment name`); name.onchange = () => { def.name = name.value; mark(); }; row.append(cell(name));
      const base = select('', envBases, def.baseEnvironment); base.disabled = envBases.includes(def.id); base.onchange = () => { def.baseEnvironment = base.value; mark(); }; row.append(cell(base));
      const remove = button('Remove', () => { draft.environmentDefinitions = draft.environmentDefinitions.filter(d => d.id !== def.id); mark(); renderPolicy(); }); remove.disabled = envBases.includes(def.id); row.append(cell(remove)); $('policyEnvironmentRows').append(row);
    });
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
    const choices = Object.values(settings.routes).map(r => ({ id: r.id, name: r.name }));
    root.append(node('p', 'All three routes are Azure OpenAI / AI Foundry deployments on one account, authenticated with the app\u2019s managed identity. The Global route is public cloud; the EU route runs in an EU region for genuine EU residency; the On-premises route is simulated, because a cloud region is not on-premises.', 'note'));
    for (const [id, label, value] of [['publicRoute', 'Public model preference', settings.preferences.public], ['internalRoute', 'Internal (EU) model preference', settings.preferences.internal], ['highRoute', 'Highly Confidential (on-premises) model preference', settings.preferences.high]]) root.append(field(label, select(id, choices, value)));
    for (const r of Object.values(settings.routes)) {
      const card = node('article', '', 'list-item');
      card.append(node('h3', r.name), badge(r.geography), r.simulated ? badge('Simulated', 'warning') : badge('Genuine', 'success'), node('p', r.simulated ? 'Simulated residency: the deployment runs in the cloud, not on-premises.' : 'Azure OpenAI deployment via managed identity; residency is genuine for this region.', 'note'));
      card.append(field('Name', input(`routeName_${r.id}`, r.name)), field('Deployment (model)', input(`routeModel_${r.id}`, r.model)), field('Enabled', input(`routeEnabled_${r.id}`, r.enabled, 'checkbox')));
      const result = node('div', '', 'note'); card.append(button('Probe / check model', async e => { e.target.disabled = true; try { const x = await api(`/api/routes/${r.id}/probe`, 'POST', {}); result.replaceChildren(badge(x.ok ? 'Check passed' : 'Unavailable', x.ok ? 'success' : 'danger'), node('p', x.message), ...(x.models ? [details(`${x.models.length} available models`, x.models.map(m => m.name || m.id).join('\n'))] : [])); } catch(error) { result.textContent = error.message; } finally { e.target.disabled = false; } }), result);
      root.append(card);
    }
    root.append(button('Save settings', async e => { e.target.disabled = true; try {
      const payload = { publicRoute: $('publicRoute').value, internalRoute: $('internalRoute').value, highRoute: $('highRoute').value,
        routes: Object.values(settings.routes).map(r => ({ id: r.id, name: $(`routeName_${r.id}`).value, model: $(`routeModel_${r.id}`).value, enabled: $(`routeEnabled_${r.id}`).checked })) };
      await api('/api/settings', 'PUT', payload); await load(); status('Settings saved', 'success');
    } catch(error) { status(error.message, 'danger'); } finally { e.target.disabled = false; } }, 'primary'));
    $('toolCatalog').replaceChildren(...state.tools.map(t => { const n = node('article', '', 'list-item'); n.append(node('h3', t.name), node('p', `${t.minimumLevel} · ${t.sovereignty} · ${t.endpoint}`), node('p', t.description, 'note')); return n; }));
  }
  function renderCredentials() {
    $('credentialList').replaceChildren(...state.credentials.map(c => {
      const n = node('article', '', 'list-item'); n.append(node('h3', `${c.payload.participantLabel || c.payload.participantId} · policy v${c.payload.policyVersion}`), badge(c.revoked ? 'Revoked' : 'Demo-issued commitment', c.revoked ? 'danger' : 'success'), node('p', 'Cryptographically signed by the demo authority; not an external provider attestation.', 'note'), details('Inspect acceptance, issuer and signature', c), button(c.revoked ? 'Restore credential' : 'Revoke credential', async e => {
        e.target.disabled = true; try { await api('/api/credentials', 'POST', { participantId: c.payload.participantId, policyVersion: c.payload.policyVersion, revoked: !c.revoked }); await load(); status('Credential status updated', 'success'); } catch(error) { status(error.message, 'danger'); }
      })); return n;
    }));
  }
  async function load() { state = await api('/api/state'); draft = copy(state.draft); dirty = false; renderPolicy(); renderVersions(); renderSettings(); renderCredentials(); status(); }
  load().catch(e => status(e.message, 'danger'));
}

export function mountCompliancePage() {
  void identityNavigation().catch(() => {});
  let records = [], selected = null, verification;
  const filters = [['filterAgent', 'agentId', 'All agents'], ['filterChat', 'chatId', 'All chats'], ['filterLevel', 'level', 'All levels'], ['filterTool', 'toolId', 'All tools'], ['filterKind', 'kind', 'All events']];
  const title = r => ({ 'chat-created': 'Conversation started', 'chat-elevated': 'Protection increased', 'tool-elevation': 'Tool required higher protection', 'tool-withheld': 'Protected data withheld from previous model', 'model-authorized': 'Model permitted', 'model-egress-failed': 'Model route failed', 'model-route-fallback': 'Governed model fallback', 'tool-executed': 'Tool completed', 'tool-denied': 'Tool blocked', 'request-refused': 'Request refused', 'model-response': 'Agent answered', 'policy-published': 'Signed policy published' }[r.kind] || r.kind.replaceAll('-', ' '));
  const outcome = r => r.outcome || (/denied|refused|conflict/.test(r.kind) ? 'denied' : '');
  const matches = r => filters.every(([id, key]) => !$(id).value || (key === 'kind' && $(id).value === 'blocked' ? outcome(r) === 'denied' : r[key] === $(id).value));
  function verifyView() { $('verificationResult').replaceChildren(...(verification ? [badge(verification.ok ? `Verified ${verification.checked} records` : 'Verification failed', verification.ok ? 'success' : 'danger'), node('p', verification.error || verification.storage, 'note')] : [])); }
  function render() {
    const visible = records.filter(matches).sort((a, b) => b.seq - a.seq); if (selected && !visible.includes(selected)) selected = null;
    $('complianceStatus').replaceChildren(badge(`${visible.length} events`), badge(`${new Set(visible.map(r => r.chatId).filter(Boolean)).size} chats`), badge(`${visible.filter(r => outcome(r) === 'denied').length} blocked`, 'warning'));
    $('ledgerRows').replaceChildren();
    visible.forEach(r => {
      const row = node('tr'); row.tabIndex = 0; row.setAttribute('aria-selected', String(r === selected));
      const values = [r.seq, new Date(r.timestamp).toLocaleTimeString(), title(r), r.chatId?.slice(-8), r.agentId, r.level || r.to?.level, r.toolId, outcome(r)]; values.forEach(v => row.append(node('td', v ?? '')));
      const choose = () => { selected = r; render(); }; row.onclick = choose; row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } }; $('ledgerRows').append(row);
    });
    if (!visible.length) { const r = node('tr'), td = node('td', 'No matching events.'); td.colSpan = 8; r.append(td); $('ledgerRows').append(r); }
    const chatId = $('filterChat').value || selected?.chatId;
    $('recordInspector').replaceChildren(...(selected ? [node('h3', title(selected)), node('p', selected.prompt || selected.message || selected.reason || ''), ...(selected.from ? [node('p', `${selected.from.level} / ${selected.from.sovereignty} → ${selected.to.level} / ${selected.to.sovereignty}`)] : []), details('Signed event and attached evidence', selected)] : [node('p', 'Select an event to inspect its evidence.', 'note')]));
    $('chatTimeline').replaceChildren();
    if (chatId) records.filter(r => r.chatId === chatId && ['input', 'chat-created', 'chat-elevated', 'tool-elevation', 'tool-withheld', 'model-egress-failed', 'model-route-fallback', 'tool-executed', 'tool-denied', 'model-response', 'request-refused'].includes(r.kind)).forEach(r => { const n = node('article', '', 'timeline-item'); n.append(node('strong', title(r)), node('p', r.prompt || r.message || r.reason || `${r.level || r.to?.level || ''} · ${r.toolId || r.routeId || ''}`, 'note'), node('small', `#${r.seq} · policy ${r.policyVersion || 'see signed event'}`)); $('chatTimeline').append(n); });
    $('exportLedgerButton').disabled = !chatId; verifyView();
  }
  async function load() {
    const data = await api('/api/ledger'); records = data.records; verification = data.verification;
    for (const [id, key, all] of filters) { const previous = $(id).value; const values = [...new Set(records.map(r => r[key]).filter(Boolean))]; $(id).replaceChildren(option('', all), ...(key === 'kind' ? [option('blocked', 'Blocked / refused')] : []), ...values.map(v => option(v))); $(id).value = values.includes(previous) || previous === 'blocked' ? previous : ''; }
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
