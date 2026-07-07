const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
document.addEventListener('click', (e) => { if (e.target && e.target.id === 'banner-close') { $('banner').hidden = true; } });
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('.src-link');
  if (!a) return;
  e.preventDefault();
  vscode.postMessage({ type: 'openSource', file: a.dataset.file, startLine: +a.dataset.start, endLine: +a.dataset.end });
});
let streaming = '';
let provider = 'local';
let policy = { local: [], hidden: [], google: [], openrouter: [] };
let selectedId = null;

/** Cloud models available when the user has saved the matching API key. */
function cloudModels() {
  const out = [];
  if (window.__googleKeySet) out.push(...(policy.google || []));
  if (window.__orKeySet) out.push(...(policy.openrouter || []));
  return out;
}

function allPolicyModels() {
  return [...(policy.local || []), ...(policy.hidden || []), ...cloudModels()];
}

function isCloudProvider(m) {
  return !!m && (m.provider === 'openrouter' || m.provider === 'google');
}

function openModelPicker() {
  closeSettings(false);
  const p = $('model-picker');
  if (p) { p.hidden = false; window.__modelPickerOpen = true; window.__modelPickerPinned = true; }
}
function closeModelPicker() {
  const p = $('model-picker');
  if (p) { p.hidden = true; window.__modelPickerOpen = false; window.__modelPickerPinned = false; }
}

let chatMode = 'ask';
let actionSub = null;
let actionMenuOpen = false;
let mcpServers = [];

const ACTION_MODES = [
  { id: 'plan', label: 'Plan', icon: '≡' },
  { id: 'debug', label: 'Debug', icon: '⛭' },
  { id: 'multitask', label: 'Multitask', icon: '↻' },
  { id: 'ask', label: 'Ask', icon: '?' },
];

const ACTION_TOOLS = [
  { id: 'image', label: 'Image', icon: '▣' },
  { id: 'models', label: 'Models', icon: '◇', sub: true },
  { id: 'skills', label: 'Skills', icon: '☰', sub: true },
  { id: 'mcp', label: 'MCP Servers', icon: '⌁', sub: true },
  { id: 'context', label: 'Context', icon: '@', sub: true },
];

function updateModeBadge() {
  const badge = $('mode-badge');
  if (!badge) return;
  const labels = { ask: 'Ask', agent: 'Agent', plan: 'Plan', debug: 'Debug', multitask: 'Multitask' };
  const mode = window.__compareId ? 'multitask' : chatMode;
  if (mode === 'ask') { badge.hidden = true; return; }
  badge.textContent = labels[mode] || mode;
  badge.hidden = false;
}

function syncAgentToggle() {
  const el = $('agent-toggle');
  if (el) el.checked = chatMode === 'agent' || chatMode === 'plan' || chatMode === 'debug';
}

function closeActionMenu() {
  const menu = $('action-menu');
  const btn = $('action-btn');
  if (menu) menu.hidden = true;
  if (btn) btn.classList.remove('on');
  actionMenuOpen = false;
  actionSub = null;
  const search = $('action-search');
  if (search) search.value = '';
}

function openActionMenu(sub) {
  closeSettings(false);
  closeSlashMenu();
  closeMentionMenu();
  const menu = $('action-menu');
  const btn = $('action-btn');
  if (!menu) return;
  actionSub = sub || null;
  menu.hidden = false;
  if (btn) btn.classList.add('on');
  actionMenuOpen = true;
  renderActionMenu();
  const search = $('action-search');
  if (search) { search.focus(); }
}

function actionFilter(text, items) {
  const q = text.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => it.label.toLowerCase().includes(q) || (it.hint && it.hint.toLowerCase().includes(q)));
}

function actionDivider() {
  const d = document.createElement('div');
  d.className = 'action-divider';
  return d;
}

function actionRow(item, selected, showChevron) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'action-item' + (selected ? ' sel' : '');
  btn.innerHTML = `<span class="action-icon">${item.icon}</span><span class="action-label">${esc(item.label)}</span>${selected ? '<span class="action-check">✓</span>' : (showChevron ? '<span class="action-chevron">›</span>' : '')}`;
  return btn;
}

function insertAtCursor(text) {
  const input = $('input');
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
  resizeInput();
  updateMeter();
}

function handleActionItem(id) {
  switch (id) {
    case 'plan': case 'debug': case 'ask': case 'multitask':
      vscode.postMessage({ type: 'setChatMode', mode: id });
      if (id === 'multitask') { actionSub = 'multitask'; renderActionMenu(); }
      else closeActionMenu();
      break;
    case 'image':
      vscode.postMessage({ type: 'attachImage' });
      closeActionMenu();
      break;
    case 'models':
      closeActionMenu();
      openModelPicker();
      break;
    case 'skills':
      actionSub = 'skills';
      renderActionMenu();
      break;
    case 'mcp':
      actionSub = 'mcp';
      renderActionMenu();
      break;
    case 'context':
      actionSub = 'context';
      renderActionMenu();
      break;
    default: break;
  }
}

function renderActionSub(body, q) {
  if (actionSub === 'skills') {
    const skills = window.__skills || [];
    const personas = window.__personas || [];
    const prompts = (window.__prefs && window.__prefs.prompts) || [];
    const metas = (window.__lastChats && window.__lastChats.metas) || [];
    const activeId = (window.__lastChats && window.__lastChats.activeId) || '';
    const activeSkill = metas.find((c) => c.id === activeId)?.skillId;
    const items = [
      ...skills.map((s) => ({
        id: 'skill:' + s.id,
        label: s.name,
        icon: '⚡',
        hint: s.description || s.source,
        active: s.id === activeSkill,
      })),
      ...personas.map((p) => ({ id: 'persona:' + p.id, label: p.name, icon: '◉', hint: 'Persona' })),
      ...prompts.map((p) => ({ id: 'prompt:' + p.id, label: promptLabel(p), icon: '✎', hint: 'Prompt' })),
      { id: 'skill-clear', label: 'Clear active skill', icon: '×', hint: '' },
      { id: 'skills-reload', label: 'Reload skills', icon: '↻', hint: '' },
      { id: 'skills-settings', label: 'Skill directories…', icon: '⚙', hint: '' },
    ];
    const filtered = actionFilter(q, items);
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'action-empty';
      empty.textContent = 'No skills found — add SKILL.md files or configure directories';
      body.appendChild(empty);
      return;
    }
    filtered.forEach((item) => {
      const row = actionRow(item, !!item.active, false);
      row.onclick = () => {
        if (item.id.startsWith('skill:')) vscode.postMessage({ type: 'setSkill', id: item.id.slice(6) });
        else if (item.id === 'skill-clear') vscode.postMessage({ type: 'setSkill', id: null });
        else if (item.id === 'skills-reload') vscode.postMessage({ type: 'reloadSkills' });
        else if (item.id === 'skills-settings') vscode.postMessage({ type: 'openSkillSettings' });
        else if (item.id.startsWith('persona:')) vscode.postMessage({ type: 'setPersona', id: item.id.slice(8) });
        else if (item.id.startsWith('prompt:')) {
          const p = prompts.find((x) => x.id === item.id.slice(7));
          if (p) pickSlashItem(p);
        }
        closeActionMenu();
      };
      body.appendChild(row);
    });
    return;
  }
  if (actionSub === 'mcp') {
    const servers = mcpServers || [];
    if (!servers.length) {
      const hint = document.createElement('div');
      hint.className = 'action-hint';
      hint.textContent = 'No MCP servers configured. Add fortressChat.mcpServers in VS Code settings.';
      body.appendChild(hint);
    } else {
      servers.forEach((s) => {
        const status = s.connected ? '●' : '○';
        const err = s.error ? ` — ${s.error}` : '';
        const item = { label: s.name, icon: status, hint: `${s.tools} tool${s.tools === 1 ? '' : 's'}${err}` };
        const row = actionRow(item, false, false);
        row.disabled = true;
        body.appendChild(row);
      });
    }
    const reload = actionRow({ label: 'Reload MCP servers', icon: '↻' }, false, false);
    reload.onclick = () => { vscode.postMessage({ type: 'reloadMcp' }); closeActionMenu(); };
    body.appendChild(reload);
    const cfg = actionRow({ label: 'Configure MCP servers…', icon: '⚙' }, false, true);
    cfg.onclick = () => { vscode.postMessage({ type: 'openMcpSettings' }); closeActionMenu(); };
    body.appendChild(cfg);
    return;
  }
  if (actionSub === 'context') {
    const items = [
      { id: 'ctx:codebase', label: '@codebase', icon: '@', hint: 'Search indexed repo' },
      { id: 'ctx:docs', label: '@docs', icon: '@', hint: 'Search documents' },
      { id: 'ctx:files', label: 'Browse files…', icon: '@', hint: 'Pick a file mention' },
    ];
    actionFilter(q, items).forEach((item) => {
      const row = actionRow(item, false, item.id === 'ctx:files');
      row.onclick = () => {
        if (item.id === 'ctx:codebase') insertAtCursor('@codebase ');
        else if (item.id === 'ctx:docs') insertAtCursor('@docs ');
        else { insertAtCursor('@'); vscode.postMessage({ type: 'listMentionFiles', query: '' }); }
        closeActionMenu();
        $('input')?.focus();
      };
      body.appendChild(row);
    });
    return;
  }
  if (actionSub === 'multitask') {
    const models = allPolicyModels();
    const hint = document.createElement('div');
    hint.className = 'action-hint';
    hint.textContent = 'Pick a second model to compare side-by-side.';
    body.appendChild(hint);
    actionFilter(q, models.map((m) => ({ id: 'cmp:' + m.id, label: m.displayName, icon: '◇', hint: m.provider === 'local' ? 'Local' : 'Cloud' }))).forEach((item) => {
      const row = actionRow(item, window.__compareId === item.id.slice(4), false);
      row.onclick = () => {
        vscode.postMessage({ type: 'setCompareModel', id: item.id.slice(4) });
        vscode.postMessage({ type: 'setChatMode', mode: 'multitask' });
        closeActionMenu();
      };
      body.appendChild(row);
    });
    const none = actionRow({ label: 'Disable compare', icon: '×' }, !window.__compareId, false);
    none.onclick = () => {
      vscode.postMessage({ type: 'setCompareModel', id: null });
      vscode.postMessage({ type: 'setChatMode', mode: 'ask' });
      closeActionMenu();
    };
    body.appendChild(none);
  }
}

function renderActionMenu() {
  const body = $('action-body');
  const search = $('action-search');
  if (!body) return;
  const q = search ? search.value : '';
  body.innerHTML = '';

  if (actionSub) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'action-back';
    back.textContent = '← Back';
    back.onclick = () => { actionSub = null; renderActionMenu(); };
    body.appendChild(back);
    renderActionSub(body, q);
    return;
  }

  const modes = actionFilter(q, ACTION_MODES);
  const tools = actionFilter(q, ACTION_TOOLS);
  if (!modes.length && !tools.length) {
    body.innerHTML = '<div class="action-empty">No matches</div>';
    return;
  }
  modes.forEach((item) => {
    const row = actionRow(item, item.id === chatMode, false);
    row.onclick = () => handleActionItem(item.id);
    body.appendChild(row);
  });
  if (modes.length && tools.length) body.appendChild(actionDivider());
  tools.forEach((item) => {
    const row = actionRow(item, false, !!item.sub);
    row.onclick = () => handleActionItem(item.id);
    body.appendChild(row);
  });
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function queueLabel(text) {
  const line = String(text).trim().split('\n')[0];
  if (!line) return 'Queued message';
  return line.length > 56 ? `${line.slice(0, 53)}…` : line;
}

function renderPromptQueue(items) {
  queueCount = items?.length || 0;
  updateComposerStatus();
  const box = $('prompt-queue');
  if (!box) return;
  if (!items || !items.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = items.map((text, i) =>
    `<div class="queue-item"><span class="queue-label">${esc(queueLabel(text))}</span><button type="button" class="queue-remove" data-idx="${i}" title="Remove from queue">×</button></div>`,
  ).join('');
  box.querySelectorAll('.queue-remove').forEach((b) => {
    b.onclick = () => vscode.postMessage({ type: 'removeQueued', index: +b.dataset.idx });
  });
}

let lastAgentStep = '';
let queueCount = 0;

/** Refresh the activity line under the composer from current turn state. */
function updateComposerStatus() {
  const el = $('composer-status');
  if (!el) return;
  let text = '';
  let active = false;
  if (window.__generating) {
    active = true;
    if (lastAgentStep) text = lastAgentStep;
    else if (turnReasoning && !streaming) text = 'Reasoning…';
    else if (streaming) text = 'Writing…';
    else text = 'Thinking…';
  } else {
    const input = $('input');
    const win = window.__ctxWindow || 8192;
    const est = Math.ceil(((input?.value || '').length + 200) / 4);
    if (input?.value.trim()) {
      text = `~${(est / 1000).toFixed(1)}k / ${Math.round(win / 1000)}k tokens`;
      el.classList.toggle('warn', est > win * 0.9);
    } else el.classList.remove('warn');
  }
  if (queueCount > 0) {
    const q = `${queueCount} message${queueCount === 1 ? '' : 's'} queued`;
    text = text ? `${text} · ${q}` : q;
  }
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('active');
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle('active', active);
}

function setGenerating(active) {
  window.__generating = !!active;
  const cancel = $('cancel');
  const send = $('send');
  if (cancel) cancel.hidden = !active;
  if (send) send.title = active ? 'Queue message (sends after current reply)' : 'Send';
  if (!active) { lastAgentStep = ''; }
  updateComposerStatus();
}

let cbCodes = [];
function renderInline(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, '<code class="inl">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');
}
function renderMarkdown(text) {
  const parts = String(text).split('```');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const nl = parts[i].indexOf('\n');
      const lang = nl >= 0 ? parts[i].slice(0, nl).trim() : '';
      const code = (nl >= 0 ? parts[i].slice(nl + 1) : parts[i]).replace(/\n$/, '');
      const id = cbCodes.push(code) - 1;
      const langClass = /^[\w-]+$/.test(lang) ? ` language-${lang}` : '';
      out += `<div class="codeblock"><div class="cb-head"><span>${esc(lang || 'code')}</span><span class="cb-btns"><button data-cb="${id}" data-act="copy">Copy</button><button data-cb="${id}" data-act="insert">Insert</button><button data-cb="${id}" data-act="apply">Apply</button>${lang === 'html' ? `<button data-cb="${id}" data-act="artifact">Artifact</button>` : ''}</span></div><pre><code class="${langClass.trim()}">${esc(code)}</code></pre></div>`;
    } else if (parts[i]) {
      out += `<div class="md">${renderInline(parts[i])}</div>`;
    }
  }
  return out;
}

// Post-render pass: KaTeX math + Mermaid diagrams. Runs only on already-escaped
// rendered DOM (never on raw/unescaped user text). Must never throw out of this
// function — rendering extras degrading is fine, breaking chat is not.
function enhanceRich(container) {
  try {
    if (window.renderMathInElement) {
      window.renderMathInElement(container, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
        trust: false,
      });
    }
    if (!window.mermaid) return;
    if (!window.__mermaidInit) {
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
      window.__mermaidInit = true;
    }
    container.querySelectorAll('pre code').forEach((code) => {
      if (code.dataset.mermaidDone) return;
      const text = code.textContent || '';
      // Prefer the fenced-code info string (class="language-mermaid", set by
      // renderMarkdown from the ```lang fence) over guessing from content.
      const isMermaidLang = code.classList.contains('language-mermaid');
      const looksLikeMermaid = /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|journey|timeline)\b/.test(text);
      if (!isMermaidLang && !looksLikeMermaid) return;
      code.dataset.mermaidDone = '1';
      const block = code.closest('.codeblock') || code.parentElement;
      const holder = document.createElement('div');
      holder.className = 'mermaid-holder';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'mermaid-toggle';
      toggle.hidden = true;
      let showingDiagram = true;
      toggle.textContent = 'Show code';
      toggle.onclick = () => {
        showingDiagram = !showingDiagram;
        block.hidden = showingDiagram;
        holder.hidden = !showingDiagram;
        toggle.textContent = showingDiagram ? 'Show code' : 'Show diagram';
      };
      block.insertAdjacentElement('afterend', toggle);
      block.insertAdjacentElement('afterend', holder);
      window.mermaid.render('mm' + Math.random().toString(36).slice(2), text)
        .then(({ svg }) => {
          holder.innerHTML = svg;
          block.hidden = true;
          toggle.hidden = false;
        })
        .catch(() => { holder.remove(); toggle.remove(); }); // fail-soft: plain code block stays visible
    });
  } catch { /* rendering extras must never break chat */ }
}

function modelRowMeta(m, status) {
  if (m.provider === 'google') return { sub: 'Google Gemini · Cloud', action: '' };
  if (m.provider === 'openrouter') return { sub: 'Cloud · US providers pinned', action: '' };
  const cid = m.local.catalogId;
  if (status && status.download && status.download.modelId === cid && status.download.totalBytes) {
    const pct = Math.max(0, Math.min(100, Math.floor((status.download.receivedBytes / status.download.totalBytes) * 100)));
    return { sub: 'On this Mac', action: `Downloading ${pct}%` };
  }
  if (!status || !status.downloadedModelIds.includes(cid)) return { sub: 'On this Mac', action: 'Download' };
  if (status.modelId === cid && (status.state === 'loading-model' || status.state === 'starting')) {
    return { sub: 'On this Mac', action: 'Starting…' };
  }
  return { sub: 'On this Mac · Ready', action: '' };
}

function renderModels(status) {
  const box = $('models');
  if (!box) return;
  const local = policy.local || [];
  const hidden = policy.hidden || [];
  const cloud = cloudModels();
  const all = [...local, ...hidden, ...cloud];
  const row = (m) => {
    const meta = modelRowMeta(m, status);
    const sel = m.id === selectedId;
    const agent = m.agentCapable ? ' · Agent' : '';
    return `<button type="button" class="model-row${sel ? ' sel' : ''}" data-id="${esc(m.id)}">
      <span class="model-row-main">
        <span class="model-row-name">${esc(m.displayName)}</span>
        <span class="model-row-sub">${esc(meta.sub)}${agent}</span>
      </span>
      ${sel ? '<span class="model-row-check">✓</span>' : (meta.action ? `<span class="model-row-action">${esc(meta.action)}</span>` : '')}
    </button>`;
  };
  const hiddenOpen = window.__hiddenModelsOpen !== false;
  box.innerHTML = local.map(row).join('') +
    (hidden.length ? `<details class="model-hidden-group"${hiddenOpen ? ' open' : ''}><summary class="model-group-label">Hidden models</summary><div class="model-hidden-list">${hidden.map(row).join('')}</div></details>` : '') +
    (cloud.length ? `<div class="model-group-label">Cloud models</div>${cloud.map(row).join('')}` : '') +
    (!window.__googleKeySet ? `<p class="model-group-hint">Add a Google Gemini API key in Settings to use cloud models.</p>` : '');
  const hiddenGroup = box.querySelector('.model-hidden-group');
  if (hiddenGroup) hiddenGroup.addEventListener('toggle', () => { window.__hiddenModelsOpen = hiddenGroup.open; });
  box.querySelectorAll('.model-row').forEach((el) => {
    el.onclick = () => {
      const m = all.find((x) => x.id === el.dataset.id);
      if (!m) return;
      if (m.provider === 'local' && status && !status.downloadedModelIds.includes(m.local.catalogId)) {
        vscode.postMessage({ type: 'downloadModel', catalogId: m.local.catalogId });
        return;
      }
      selectedId = m.id;
      if (window.__status) renderState(window.__status);
      vscode.postMessage({ type: 'selectModel', id: m.id });
    };
  });
}

function renderState(status) {
  window.__status = status;
  renderModels(status);
  const setup = $('setup');
  if (status.downloadError) {
    setup.hidden = false;
    openModelPicker();
    setup.innerHTML = `<b style="color:#e07a7a">⚠ ${esc(status.downloadError)}</b><p>Tap the model again to retry.</p>`;
  } else if (!status.binaryInstalled && !(selectedId && allPolicyModels().some((m) => m.id === selectedId && isCloudProvider(m)))) {
    setup.hidden = false;
    const gb = Math.round(status.ram.totalBytes / 2 ** 30);
    setup.innerHTML = `<b>Welcome to FortressChat</b><p>This Mac has ${gb} GB RAM. Set up the local engine to run models on-device.</p><button type="button" id="do-setup">Set up local engine</button>`;
    const btn = $('do-setup');
    if (btn) btn.onclick = () => vscode.postMessage({ type: 'installBinary' });
    if (!selectedId && !window.__pickerShown) { window.__pickerShown = true; openModelPicker(); }
  } else if (status.download) {
    setup.hidden = false;
    openModelPicker();
    const pct = Math.round((status.download.receivedBytes / status.download.totalBytes) * 100);
    setup.innerHTML = `<p>Downloading model… ${pct}%</p><progress max="100" value="${pct}"></progress>`;
  } else {
    setup.hidden = true;
  }

  const m = selectedId ? allPolicyModels().find((x) => x.id === selectedId) : null;
  const loading = !!m && m.provider === 'local' && (status.state === 'starting' || status.state === 'loading-model');
  const ready = !!m && (isCloudProvider(m) ? true : status.state === 'ready');
  const engineReady = status.binaryInstalled || window.__googleKeySet || window.__orKeySet;
  const showComposer = !!m && engineReady;
  $('composer').hidden = !showComposer;
  const empty = $('empty-state');
  if (empty) empty.hidden = showComposer && (ready || loading);
  const emptyText = $('empty-state-text');
  if (emptyText) {
    if (!engineReady) emptyText.textContent = 'Set up the local engine or add a Google Gemini API key in Settings.';
    else if (!m) emptyText.textContent = 'Pick a model from the sidebar to start chatting.';
    else if (loading) emptyText.textContent = 'Loading model…';
    else if (!ready && m.provider === 'local' && status.state === 'crashed') emptyText.textContent = 'Model crashed — choose another model from the sidebar.';
    else if (!ready && m.provider === 'local') emptyText.textContent = 'Model did not start — pick a model again from the sidebar.';
    else emptyText.textContent = '';
  }
  const sidebarModelBtn = $('sidebar-model-btn');
  const sidebarModelLabel = $('sidebar-model-label');
  if (sidebarModelBtn) sidebarModelBtn.hidden = !engineReady;
  if (sidebarModelLabel) sidebarModelLabel.textContent = m ? m.displayName : 'Choose model';
  const msgs = $('messages');
  if (msgs) msgs.hidden = !selectedId;
  $('send').disabled = !ready;
  $('active-model').textContent = m ? m.displayName : 'Choose a model';
  const agentEl = $('agent-toggle');
  if (agentEl) {
    agentEl.disabled = !m || !m.agentCapable;
    if (agentEl.disabled) agentEl.checked = false;
  }
  if (!selectedId && !window.__pickerShown) { window.__pickerShown = true; openModelPicker(); }
}

function setProvider(p) {
  provider = p;
  if (window.__status) renderState(window.__status);
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'policy') { policy = { local: m.local, hidden: m.hidden || [], google: m.google || [], openrouter: m.openrouter }; if (window.__status) renderState(window.__status); }
  if (m.type === 'openRouterKeySet') {
    window.__orKeySet = m.set;
    if (window.__status) renderState(window.__status);
  }
  if (m.type === 'googleKeySet') {
    window.__googleKeySet = m.set;
    const statusEl = $('google-key-status');
    if (statusEl) statusEl.hidden = !m.set;
    if (window.__status) renderState(window.__status);
  }
  if (m.type === 'state') { selectedId = m.selectedId; renderState(m.status); }
  if (m.type === 'history') renderHistory(m.messages);
  if (m.type === 'startRejected') renderRejection(m.rejection, m.modelId);
  if (m.type === 'addBlocked') { $('add-blocked').hidden = false; $('add-blocked').innerHTML = `<b style="color:#e07a7a">⛔ Blocked by policy</b><p>${esc(m.reason)}</p><span class="b">✗ non-US</span><p style="margin-top:6px">Local US models are listed in the model picker.</p>`; }
  if (m.type === 'policyFatal') {
    const overlay = $('policy-fatal');
    const text = $('policy-fatal-text');
    if (overlay && text) {
      text.textContent = m.message || 'This model is not allowed.';
      overlay.hidden = false;
      document.body.classList.add('policy-stopped');
    }
  }
  if (m.type === 'addAccepted') { $('add-blocked').hidden = false; $('add-blocked').innerHTML = `<p>${esc(m.slug)} is already on the approved list — select it above.</p>`; }
  if (m.type === 'restoreInput') { $('input').value = m.text; resetInputHistoryBrowse(); resizeInput(); }
  if (m.type === 'error') {
    if (m.message) {
      $('banner-text').textContent = m.message;
      $('banner').hidden = false;
      clearTimeout(window.__bannerTimer);
      const retry = $('banner-retry');
      if (!retry || retry.hidden) {
        window.__bannerTimer = setTimeout(() => { $('banner').hidden = true; }, 12000);
      }
    } else { $('banner').hidden = true; }
  }
  if (m.type === 'clearBanner') {
    $('banner').hidden = true;
    const retry = $('banner-retry');
    if (retry) retry.hidden = true;
  }
  if (m.type === 'token') appendToken(m.text);
  if (m.type === 'context') {
    $('chips').innerHTML = (m.chips || []).map((c) => `<span class="chip">${esc(c.label)}<button data-chip="${esc(c.id)}">×</button></span>`).join('');
    document.querySelectorAll('#chips button').forEach((b) => b.onclick = () => vscode.postMessage({ type: 'excludeContext', id: b.dataset.chip }));
  }
  if (m.type === 'agentStep') {
    $('steps').hidden = false;
    $('steps').innerHTML += `<div>${esc(m.step)}</div>`;
    lastAgentStep = m.step;
    updateComposerStatus();
  }
  if (m.type === 'reasoning') appendReasoning(m.text);
  if (m.type === 'reasoningDone') { const b = document.querySelector('.reasoning-live'); if (b) b.open = false; }
  if (m.type === 'usage' && m.usage) { const u = $('usage-last'); if (u) u.textContent = `↑${m.usage.promptTokens} ↓${m.usage.completionTokens} tok`; }
  if (m.type === 'chats') { window.__lastChats = m; renderChatPicker(m.metas, m.activeId); renderSidebar(m.metas, m.activeId); fillPersonaPicker(); fillSkillPicker(); }
  if (m.type === 'prefs') {
    window.__prefs = { prompts: m.prompts || [], params: m.params || {} };
    fillParams(); renderPrompts(); fillComparePicker();
    if (actionMenuOpen && actionSub === 'skills') renderActionMenu();
  }
  if (m.type === 'memory') {
    window.__memory = m.data || { enabled: false, facts: [] };
    fillMemory();
  }
  if (m.type === 'folders') renderFolderFilter(m.folders || []);
  if (m.type === 'personas') { window.__personas = m.personas || []; renderPersonas(); fillPersonaPicker(); if (actionMenuOpen && actionSub === 'skills') renderActionMenu(); }
  if (m.type === 'skills') { window.__skills = m.skills || []; renderSkillsList(); fillSkillPicker(); if (actionMenuOpen && actionSub === 'skills') renderActionMenu(); }
  if (m.type === 'chatMode') {
    chatMode = m.mode || 'ask';
    window.__compareId = m.compareId || null;
    syncAgentToggle();
    updateModeBadge();
  }
  if (m.type === 'mcpStatus') { mcpServers = m.servers || []; renderMcpList(); if (actionMenuOpen && actionSub === 'mcp') renderActionMenu(); }
  if (m.type === 'openActionSub') openActionMenu(m.sub);
  if (m.type === 'projectRules') {
    const el = $('rules-path');
    if (el) el.textContent = m.path ? `Rules: ${m.path}` : 'No rules file yet';
  }
  if (m.type === 'agentUndo') {
    const btn = $('undo-agent');
    if (btn) btn.disabled = !m.available;
  }
  if (m.type === 'mentionFiles') renderMentionMenu(m.items || []);
  if (m.type === 'docsStatus') {
    const s = m.stats || { files: 0, chunks: 0 };
    const el = $('docs-status'); if (el) el.textContent = s.chunks ? `${s.files} docs · ${s.chunks} chunks` : 'No docs indexed';
    if (m.lastIndex?.errors?.length && el) el.textContent += ` (${m.lastIndex.errors.length} failed)`;
  }
  if (m.type === 'docsProgress') {
    const el = $('docs-status');
    if (el) el.textContent = m.file ? `Indexing ${m.file} (${m.done}/${m.total})…` : `Indexing docs ${m.done}/${m.total}…`;
  }
  if (m.type === 'attachedImages') {
    const el = $('meter'); if (el) el.textContent = `${m.count} image(s) attached for next message`;
  }
  if (m.type === 'artifact') {
    const pane = $('artifact-pane'); const frame = $('artifact-frame');
    if (pane && frame) { pane.hidden = false; frame.srcdoc = String(m.html || ''); }
  }
  if (m.type === 'compareStart') { const p = $('compare-pane'); if (p) { p.hidden = false; $('compare-a').textContent = ''; $('compare-b').textContent = ''; } }
  if (m.type === 'compareToken' && m.side === 'B') { const b = $('compare-b'); if (b) b.textContent += m.text; }
  if (m.type === 'compareDone') {
    const el = m.side === 'A' ? $('compare-a') : $('compare-b');
    if (el && m.content) el.textContent = m.content;
  }
  if (m.type === 'searchResults') { renderChatPicker(m.metas, $('chat-picker') ? $('chat-picker').value : undefined); renderSidebar(m.metas, window.__lastChats && window.__lastChats.activeId); }
  if (m.type === 'contextWindow') { window.__ctxWindow = m.tokens; updateMeter(); }
  if (m.type === 'queue') renderPromptQueue(m.items || []);
  if (m.type === 'generating') setGenerating(!!m.active);
  if (m.type === 'devMode') {
    window.__dev = m.on;
    const ds = $('dev-settings');
    if (ds) ds.hidden = !m.on;
    const fw = $('fw-key-row');
    if (fw) fw.hidden = m.fireworksKeySet;
    const preset = $('dev-preset');
    if (preset) {
      preset.innerHTML = '<option value="">— pick a Fireworks model —</option>' +
        (m.presets || []).map((p) => `<option value="${p.slug}">${esc(p.label)}</option>`).join('');
    }
  }
  if (m.type === 'ragStatus') {
    const s = m.stats || { files: 0, chunks: 0 };
    $('rag-status').textContent = s.chunks ? `Indexed ${s.files} files · ${s.chunks} chunks` : 'Not indexed';
    if (m.indexing) { $('rag-index').disabled = true; }
    else { $('rag-index').disabled = false; $('rag-bar').hidden = true; }
  }
  if (m.type === 'ragProgress') {
    const p = m.progress || {};
    $('rag-bar').hidden = false;
    $('rag-index').disabled = true;
    const pct = p.filesTotal ? Math.round((p.filesDone / p.filesTotal) * 100) : 0;
    $('rag-fill').style.width = pct + '%';
    $('rag-status').textContent = `Indexing ${p.filesDone}/${p.filesTotal}${p.capped ? ' (capped)' : ''} · ${p.chunksDone} chunks`;
  }
});

let inputHistory = [];
let historyBrowseIdx = -1;
let historyDraft = '';

/** Keep sent user prompts for ↑/↓ recall in the composer. */
function syncInputHistory(messages) {
  inputHistory = (messages || []).filter((m) => m.role === 'user').map((m) => m.content);
  resetInputHistoryBrowse();
}

function resetInputHistoryBrowse() {
  historyBrowseIdx = -1;
  historyDraft = '';
}

function canBrowseInputHistory() {
  const el = $('input');
  if (!el) return false;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  if (start !== end) return false;
  return !el.value.slice(0, start).includes('\n');
}

function browseInputHistory(direction) {
  const el = $('input');
  if (!el || !inputHistory.length) return false;
  const max = inputHistory.length - 1;
  if (direction < 0) {
    if (!canBrowseInputHistory()) return false;
    if (historyBrowseIdx === -1) {
      historyDraft = el.value;
      historyBrowseIdx = 0;
    } else if (historyBrowseIdx < max) historyBrowseIdx++;
    else return true;
    el.value = inputHistory[inputHistory.length - 1 - historyBrowseIdx];
  } else {
    if (historyBrowseIdx === -1) return false;
    if (historyBrowseIdx === 0) {
      historyBrowseIdx = -1;
      el.value = historyDraft;
    } else {
      historyBrowseIdx--;
      el.value = inputHistory[inputHistory.length - 1 - historyBrowseIdx];
    }
  }
  const len = el.value.length;
  el.setSelectionRange(len, len);
  resizeInput();
  updateMeter();
  return true;
}

let lastMessages = [];

function renderHistory(messages) {
  lastMessages = messages;
  streaming = ''; cbCodes = [];
  syncInputHistory(messages);
  const shown = messages.map((m, i) => ({ m, i })).filter(({ m }) => m.role === 'user' || (m.role === 'assistant' && m.content));
  let lastA = -1; shown.forEach((x, k) => { if (x.m.role === 'assistant') lastA = k; });
  $('messages').innerHTML = shown.map(({ m, i }, k) => {
    if (m.role === 'assistant') {
      const reason = (k === lastA && turnReasoning) ? `<details class="reasoning"><summary>▸ Reasoning</summary><pre>${esc(turnReasoning)}</pre></details>` : '';
      const foot = k === lastA ? `<div class="msg-foot"><button class="remember" data-idx="${i}" title="Save to local memory">Remember</button><button class="regen">↻ Regenerate</button><span class="usage" id="usage-last"></span></div>` : '';
      const sources = (m.sources && m.sources.length) ? `<div class="src-list" data-src-idx="${k}">Sources: </div>` : '';
      return `<div class="msg assistant"><div class="assistant-body">${reason}${renderMarkdown(m.content)}${sources}${foot}</div></div>`;
    }
    return `<div class="msg user"><div class="user-bubble"><pre>${esc(m.content)}</pre><button class="editmsg" data-idx="${i}" title="Edit &amp; resend">✎</button><button class="forkmsg" data-idx="${i}" title="Fork from here">⑂</button></div></div>`;
  }).join('');
  document.querySelectorAll('.src-list[data-src-idx]').forEach((el) => {
    const entry = shown[+el.dataset.srcIdx];
    if (!entry || !entry.m.sources) return;
    entry.m.sources.forEach((s) => {
      const startLine = Number(s.startLine);
      const endLine = Number(s.endLine);
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'src-link';
      a.dataset.file = s.file;
      a.dataset.start = String(startLine);
      a.dataset.end = String(endLine);
      a.textContent = `${s.file}:L${startLine}-L${endLine}`;
      el.appendChild(a);
      el.appendChild(document.createTextNode(' '));
    });
  });
  enhanceRich($('messages'));
  $('messages').scrollTop = $('messages').scrollHeight;
}
function appendToken(t) {
  streaming += t;
  let el = document.querySelector('.msg.streaming pre');
  if (!el) { const d = document.createElement('div'); d.className = 'msg assistant streaming'; d.innerHTML = '<pre></pre>'; $('messages').appendChild(d); el = d.querySelector('pre'); }
  el.textContent = streaming;
  $('messages').scrollTop = $('messages').scrollHeight;
  updateComposerStatus();
}
let turnReasoning = '';
function appendReasoning(t) {
  turnReasoning += t;
  let box = document.querySelector('.reasoning-live');
  if (!box) {
    box = document.createElement('details');
    box.className = 'reasoning reasoning-live'; box.open = true;
    box.innerHTML = '<summary>▸ Reasoning</summary><pre></pre>';
    $('messages').appendChild(box);
  }
  box.querySelector('pre').textContent = turnReasoning;
  $('messages').scrollTop = $('messages').scrollHeight;
  updateComposerStatus();
}
function updateMeter() {
  const win = window.__ctxWindow || 8192;
  const est = Math.ceil(($('input').value.length + 200) / 4);
  const el = $('meter'); if (!el) return;
  el.textContent = `~${(est / 1000).toFixed(1)}k / ${Math.round(win / 1000)}k tokens`;
  el.classList.toggle('warn', est > win * 0.9);
  updateComposerStatus();
}
function renderRejection(r, modelId) {
  const need = Math.round(r.requiredBytes / 2 ** 30), have = Math.round(r.availableBytes / 2 ** 30);
  const rows = r.foreign.map((p) => `<li>${esc(p.command.slice(0, 70))} — ${Math.round(p.rssBytes / 2 ** 30)} GB (pid ${p.pid})</li>`).join('');
  const setup = $('setup');
  if (setup) {
    setup.hidden = true;
    setup.innerHTML = '';
  }
  window.__pendingModelId = modelId;
  window.__pendingKillPids = (r.foreign || []).map((p) => p.pid);
  const msg = r.wouldFitAfterForeignKill
    ? `Not enough memory (~${need} GB needed, ${have} GB free). Another llama-server is using RAM.`
    : `Not enough memory (~${need} GB needed, ${have} GB free). Try a smaller model.`;
  $('banner-text').innerHTML = `${esc(msg)}${r.foreign.length ? `<ul style="margin:8px 0 0;padding-left:18px">${rows}</ul>` : ''}`;
  const retry = $('banner-retry');
  if (retry) {
    retry.hidden = !r.wouldFitAfterForeignKill;
    retry.disabled = false;
    retry.textContent = 'Stop other models and retry';
    retry.onclick = () => {
      retry.disabled = true;
      retry.textContent = 'Stopping other models…';
      $('banner-text').textContent = 'Stopping other llama-server processes…';
      vscode.postMessage({ type: 'retryModelAfterKill', pids: window.__pendingKillPids || [], modelId: window.__pendingModelId });
    };
  }
  $('banner').hidden = false;
  clearTimeout(window.__bannerTimer);
  if (window.__status) renderState(window.__status);
}

function renderChatPicker(metas, activeId) {
  const p = $('chat-picker');
  if (!p) return;
  const keep = activeId !== undefined ? activeId : p.value;
  p.innerHTML = (metas || []).map((c) => `<option value="${c.id}">${esc(c.title || 'New chat')}</option>`).join('');
  p.value = keep;
}

// Render the left-rail chat list. metas may be a search-filtered subset; activeId is the real active chat.
function renderSidebar(metas, activeId) {
  const list = $('chat-list');
  if (!list) return;
  const items = metas || [];
  if (!items.length) {
    list.innerHTML = '<div class="chat-list-empty">No chats</div>';
    return;
  }
  const active = activeId !== undefined ? activeId : (window.__lastChats && window.__lastChats.activeId);
  list.innerHTML = items.map((c) => {
    const isActive = c.id === active;
    const badge = c.agentMode ? '<span class="agent-badge" title="Agent chat">Agent</span>' : '';
    return `<div class="chat-item-wrap${isActive ? ' active' : ''}">`
      + `<button type="button" class="chat-item" data-id="${esc(c.id)}" title="${esc(c.title || 'New chat')}">`
      + `<span class="chat-item-title">${esc(c.title || 'New chat')}</span>${badge}</button>`
      + `<button type="button" class="chat-item-menu" data-id="${esc(c.id)}" title="Chat actions" aria-label="Chat actions">⋯</button>`
      + `</div>`;
  }).join('');
}

function fillParams() {
  const params = (window.__prefs && window.__prefs.params) || {};
  const t = $('p-temp'); if (t) t.value = params.temperature != null ? String(params.temperature) : '';
  const tp = $('p-topp'); if (tp) tp.value = params.top_p != null ? String(params.top_p) : '';
  const mt = $('p-maxtok'); if (mt) mt.value = params.max_tokens != null ? String(params.max_tokens) : '';
}

function promptLabel(p) {
  const line = (p.text || p.title || '').trim().split('\n')[0];
  if (!line) return 'Prompt';
  return line.length > 48 ? `${line.slice(0, 45)}…` : line;
}

function fillComparePicker() {
  const pick = $('compare-picker'); if (!pick) return;
  const models = allPolicyModels();
  pick.innerHTML = '<option value="">No compare</option>' + models.map((m) => `<option value="${m.id}">${esc(m.displayName)}</option>`).join('');
}

function fillMemory() {
  const data = window.__memory || { enabled: false, facts: [] };
  const en = $('mem-enabled'); if (en) en.checked = !!data.enabled;
  const ta = $('mem-facts'); if (ta) ta.value = (data.facts || []).join('\n');
}

function renderFolderFilter(folders) {
  const sel = $('folder-filter'); if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = '<option value="">All folders</option>' + folders.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('') + '<option value="__new__">+ New folder…</option>';
  sel.value = keep;
}

function fillPersonaPicker() {
  const pick = $('persona-picker'); if (!pick) return;
  const list = window.__personas || [];
  const metas = (window.__lastChats && window.__lastChats.metas) || [];
  const activeId = (window.__lastChats && window.__lastChats.activeId) || ($('chat-picker') && $('chat-picker').value);
  const meta = metas.find((c) => c.id === activeId);
  pick.innerHTML = '<option value="">Default</option>' + list.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if (meta && meta.personaId) pick.value = meta.personaId;
}

function fillSkillPicker() {
  const pick = $('skill-picker'); if (!pick) return;
  const list = window.__skills || [];
  const metas = (window.__lastChats && window.__lastChats.metas) || [];
  const activeId = (window.__lastChats && window.__lastChats.activeId) || ($('chat-picker') && $('chat-picker').value);
  const meta = metas.find((c) => c.id === activeId);
  pick.innerHTML = '<option value="">None</option>' + list.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  if (meta && meta.skillId) pick.value = meta.skillId;
}

function renderSkillsList() {
  const box = $('skills-list'); if (!box) return;
  const list = window.__skills || [];
  if (!list.length) {
    box.innerHTML = '<p class="settings-hint">No SKILL.md files found in configured directories.</p>';
    return;
  }
  box.innerHTML = list.map((s) => `<div class="skill-item"><span class="skill-use" data-id="${esc(s.id)}">⚡ ${esc(s.name)}</span><span class="settings-hint">${esc(s.description || '')}</span></div>`).join('');
}

function renderMcpList() {
  const box = $('mcp-list'); if (!box) return;
  const servers = mcpServers || [];
  if (!servers.length) {
    box.innerHTML = '<p class="settings-hint">No MCP servers configured.</p>';
    return;
  }
  box.innerHTML = servers.map((s) => {
    const status = s.connected ? 'connected' : 'offline';
    const err = s.error ? ` — ${esc(s.error)}` : '';
    return `<div class="mcp-item"><span>${s.connected ? '●' : '○'} ${esc(s.name)}</span><span class="settings-hint">${status} · ${s.tools} tool(s)${err}</span></div>`;
  }).join('');
}

function renderPersonas() {
  const box = $('personas-list'); if (!box) return;
  const list = window.__personas || [];
  box.innerHTML = '';
  list.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'persona-item';
    const use = document.createElement('span');
    use.className = 'persona-use';
    use.dataset.id = p.id;
    use.textContent = p.name;
    const del = document.createElement('button');
    del.className = 'persona-del';
    del.dataset.id = p.id;
    del.textContent = '✕';
    row.appendChild(use);
    row.appendChild(del);
    box.appendChild(row);
  });
}

let mentionActive = -1;
let mentionQuery = '';
function closeMentionMenu() {
  const menu = $('mention-menu');
  if (menu) menu.hidden = true;
  mentionActive = -1;
  window.__mentionItems = [];
}
function renderMentionMenu(items) {
  const menu = $('mention-menu');
  if (!menu) return;
  window.__mentionItems = items;
  menu.innerHTML = items.map((it, i) =>
    `<div class="mention-item${i === mentionActive ? ' active' : ''}" data-idx="${i}">${esc(it.label)}${it.hint ? `<span class="mention-hint">${esc(it.hint)}</span>` : ''}</div>`,
  ).join('');
  menu.hidden = items.length === 0;
}
function pickMentionItem(item) {
  const input = $('input');
  if (!input || !item) return;
  const v = input.value;
  const at = v.lastIndexOf('@');
  if (at < 0) return;
  const insert = item.id === 'codebase' ? '@codebase ' : item.id === 'docs' ? '@docs ' : `@${item.id} `;
  input.value = v.slice(0, at) + insert;
  closeMentionMenu();
  input.focus();
  resizeInput();
  updateMeter();
}
function mentionAtCursor() {
  const input = $('input');
  if (!input) return null;
  const v = input.value;
  const pos = input.selectionStart ?? v.length;
  const before = v.slice(0, pos);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const chunk = before.slice(at + 1);
  if (/\s/.test(chunk)) return null;
  return { at, query: chunk };
}

function openSettings(open) {
  if (open && window.__modelPickerPinned) { /* keep model list open */ }
  else if (open) closeModelPicker();
  const panel = $('settings-panel');
  const scrim = $('settings-scrim');
  if (!panel || !scrim) return;
  panel.hidden = !open;
  scrim.hidden = !open;
  if (open) { fillParams(); renderPrompts(); fillMemory(); renderPersonas(); fillPersonaPicker(); }
}
function closeSettings(open) {
  if (open === false) {
    const panel = $('settings-panel');
    const scrim = $('settings-scrim');
    if (panel) panel.hidden = true;
    if (scrim) scrim.hidden = true;
    return;
  }
  openSettings(false);
}

function resizeInput() {
  const el = $('input');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(160, Math.max(24, el.scrollHeight)) + 'px';
}

function renderPrompts() {
  const box = $('prompts-list');
  if (!box) return;
  const list = (window.__prefs && window.__prefs.prompts) || [];
  box.innerHTML = '';
  list.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'prompt-item';
    const use = document.createElement('span');
    use.className = 'pr-title-use';
    use.dataset.id = p.id;
    use.textContent = promptLabel(p);
    const del = document.createElement('button');
    del.className = 'pr-del';
    del.dataset.id = p.id;
    del.title = 'Delete prompt';
    del.textContent = '✕';
    row.appendChild(use);
    row.appendChild(del);
    box.appendChild(row);
  });
}

let slashActive = -1;
function slashCandidates(filter) {
  const list = (window.__prefs && window.__prefs.prompts) || [];
  const f = filter.toLowerCase();
  return list.filter((p) => promptLabel(p).toLowerCase().includes(f) || p.text.toLowerCase().includes(f));
}
function renderSlashMenu(items) {
  const menu = $('slash-menu');
  if (!menu) return;
  menu.innerHTML = '';
  items.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'slash-item' + (i === slashActive ? ' active' : '');
    row.dataset.idx = String(i);
    row.textContent = promptLabel(p);
    menu.appendChild(row);
  });
  menu.hidden = items.length === 0;
}
function closeSlashMenu() {
  const menu = $('slash-menu');
  if (menu) menu.hidden = true;
  slashActive = -1;
  window.__slashItems = [];
}
function pickSlashItem(p) {
  const input = $('input');
  if (!input || !p) return;
  input.value = p.text;
  closeSlashMenu();
  input.focus();
  const match = /\{[^}]*\}/.exec(p.text);
  if (match) input.setSelectionRange(match.index, match.index + match[0].length);
  else input.setSelectionRange(input.value.length, input.value.length);
  updateMeter();
}

{ const _ab = $('action-btn'); if (_ab) _ab.onclick = (e) => { e.stopPropagation(); actionMenuOpen ? closeActionMenu() : openActionMenu(); }; }
{ const _as = $('action-search'); if (_as) _as.addEventListener('input', () => renderActionMenu()); }
document.addEventListener('click', (e) => {
  if (!actionMenuOpen) return;
  if (e.target.closest('#action-menu') || e.target.closest('#action-btn')) return;
  closeActionMenu();
});
{ const _ok = $('or-key-save'); if (_ok) _ok.onclick = () => { const k = $('or-key-input').value.trim(); if (k) vscode.postMessage({ type: 'setOpenRouterKey', key: k }); }; }
{ const _gk = $('google-key-save'); if (_gk) _gk.onclick = () => { const k = $('google-key-input').value.trim(); if (k) vscode.postMessage({ type: 'setGoogleKey', key: k }); }; }
{ const _ab = $('add-btn'); if (_ab) _ab.onclick = () => { const s = $('add-slug').value.trim(); if (s) vscode.postMessage({ type: 'addModel', slug: s }); }; }
$('send').onclick = () => {
  let t = $('input').value.trim();
  if (!t) return;
  const slash = { '/explain': 'Explain this code.', '/fix': 'Find and fix bugs in this code.', '/test': 'Write unit tests for this code.', '/refactor': 'Refactor this code without changing behavior.', '/doc': 'Add doc comments to this code.' };
  const cmd = t.split(/\s+/)[0];
  if (slash[cmd]) { const rest = t.slice(cmd.length).trim(); t = slash[cmd] + (rest ? ' ' + rest : ''); }
  $('input').value = ''; $('banner').hidden = true; $('steps').innerHTML = ''; $('steps').hidden = true;
  closeSlashMenu(); closeMentionMenu(); closeActionMenu(); resetInputHistoryBrowse();
  turnReasoning = ''; lastAgentStep = ''; streaming = '';
  vscode.postMessage({ type: 'send', text: t }); if (!window.__generating) setGenerating(true); updateMeter(); resizeInput();
};
$('cancel').onclick = () => { vscode.postMessage({ type: 'cancel' }); setGenerating(false); };
$('new-chat').onclick = () => { turnReasoning = ''; closeSettings(false); resetInputHistoryBrowse(); vscode.postMessage({ type: 'newChat' }); };
{ const _oec = $('open-editor-chat'); if (_oec) _oec.onclick = () => { closeSettings(false); vscode.postMessage({ type: 'openChatInEditor' }); }; }
{ const _mpb = $('model-picker-btn'); if (_mpb) _mpb.onclick = () => openModelPicker(); }
{ const _smb = $('sidebar-model-btn'); if (_smb) _smb.onclick = () => openModelPicker(); }
{ const _mpc = $('model-picker-close'); if (_mpc) _mpc.onclick = () => closeModelPicker(); }
{ const _mps = $('model-picker-scrim'); if (_mps) _mps.onclick = () => closeModelPicker(); }
{ const _ri = $('rag-index'); if (_ri) _ri.onclick = () => { $('rag-index').disabled = true; vscode.postMessage({ type: 'indexWorkspace' }); }; }
$('chat-picker').onchange = (e) => { turnReasoning = ''; vscode.postMessage({ type: 'switchChat', id: e.target.value }); };

// Sidebar: New chat / New agent / search / click-to-switch
{ const _ncb = $('new-chat-btn'); if (_ncb) _ncb.onclick = () => { turnReasoning = ''; resetInputHistoryBrowse(); vscode.postMessage({ type: 'newChat' }); }; }
{ const _nab = $('new-agent-btn'); if (_nab) _nab.onclick = () => { turnReasoning = ''; resetInputHistoryBrowse(); vscode.postMessage({ type: 'newChat', agent: true }); }; }
{ const _ss = $('sidebar-search'); if (_ss) _ss.oninput = () => {
  const q = _ss.value;
  if (!q.trim()) { if (window.__lastChats) renderSidebar(window.__lastChats.metas, window.__lastChats.activeId); return; }
  vscode.postMessage({ type: 'searchChats', query: q, folder: '' });
}; }
{ const _cl = $('chat-list'); if (_cl) _cl.onclick = (e) => {
  const menuBtn = e.target.closest('.chat-item-menu');
  if (menuBtn) {
    e.stopPropagation();
    const id = menuBtn.getAttribute('data-id');
    if (!id) return;
    const metas = (window.__lastChats && window.__lastChats.metas) || [];
    const chat = metas.find((c) => c.id === id);
    const title = chat?.title || 'New chat';
    const next = window.prompt('Rename chat (or type DELETE to remove):', title);
    if (next == null) return;
    if (next.trim().toUpperCase() === 'DELETE') {
      if (window.confirm(`Delete "${title}"?`)) vscode.postMessage({ type: 'deleteChat', id });
      return;
    }
    if (next.trim() && next.trim() !== title) vscode.postMessage({ type: 'renameChat', id, title: next.trim() });
    return;
  }
  const item = e.target.closest('.chat-item'); if (!item) return;
  const id = item.getAttribute('data-id'); if (!id) return;
  turnReasoning = ''; vscode.postMessage({ type: 'switchChat', id });
}; }
$('input').addEventListener('input', () => {
  if (historyBrowseIdx >= 0) {
    const expected = inputHistory[inputHistory.length - 1 - historyBrowseIdx];
    if ($('input').value !== expected) resetInputHistoryBrowse();
  }
  updateMeter();
  resizeInput();
});
{ const _at = $('agent-toggle'); if (_at) _at.onchange = (e) => vscode.postMessage({ type: 'agentToggle', on: e.target.checked }); }
$('banner-close').onclick = () => { $('banner').hidden = true; };

{ const _sb = $('settings-btn'); if (_sb) _sb.onclick = () => openSettings(true); }
{ const _sc = $('settings-close'); if (_sc) _sc.onclick = () => closeSettings(false); }
{ const _ss = $('settings-scrim'); if (_ss) _ss.onclick = () => closeSettings(false); }
{ const _ro = $('rules-open'); if (_ro) _ro.onclick = () => vscode.postMessage({ type: 'openRulesFile' }); }
{ const _ua = $('undo-agent'); if (_ua) _ua.onclick = () => vscode.postMessage({ type: 'undoAgentRun' }); }
{ const _pp = $('persona-picker'); if (_pp) _pp.onchange = () => vscode.postMessage({ type: 'setPersona', id: _pp.value || null }); }
{ const _sp = $('skill-picker'); if (_sp) _sp.onchange = () => vscode.postMessage({ type: 'setSkill', id: _sp.value || null }); }
{ const _sr = $('skills-reload'); if (_sr) _sr.onclick = () => vscode.postMessage({ type: 'reloadSkills' }); }
{ const _ss = $('skills-settings'); if (_ss) _ss.onclick = () => vscode.postMessage({ type: 'openSkillSettings' }); }
{ const _mr = $('mcp-reload'); if (_mr) _mr.onclick = () => vscode.postMessage({ type: 'reloadMcp' }); }
{ const _ms = $('mcp-settings'); if (_ms) _ms.onclick = () => vscode.postMessage({ type: 'openMcpSettings' }); }
{ const _psv = $('persona-save'); if (_psv) _psv.onclick = () => {
  const name = ($('persona-name')?.value || '').trim();
  const systemPrompt = ($('persona-prompt')?.value || '').trim();
  if (!name || !systemPrompt) return;
  const id = window.__editingPersonaId || crypto.randomUUID();
  vscode.postMessage({ type: 'savePersona', persona: { id, name, systemPrompt } });
  window.__editingPersonaId = null;
  if ($('persona-name')) $('persona-name').value = '';
  if ($('persona-prompt')) $('persona-prompt').value = '';
}; }

{ const _cs = $('chat-search'); if (_cs) _cs.oninput = () => {
  const q = _cs.value;
  const folder = ($('folder-filter') && $('folder-filter').value) || '';
  if (!q.trim()) { if (window.__lastChats) renderChatPicker(window.__lastChats.metas, window.__lastChats.activeId); return; }
  vscode.postMessage({ type: 'searchChats', query: q, folder: folder && folder !== '__new__' ? folder : '' });
}; }
{ const _ff = $('folder-filter'); if (_ff) _ff.onchange = () => {
  if (_ff.value === '__new__') {
    const name = prompt('Folder name'); if (name) vscode.postMessage({ type: 'setFolder', folder: name });
    return;
  }
  _ff.oninput && $('chat-search').dispatchEvent(new Event('input'));
}; }
{ const _cp = $('compare-picker'); if (_cp) _cp.onchange = () => vscode.postMessage({ type: 'setCompareModel', id: _cp.value || null }); }
{ const _di = $('docs-index'); if (_di) _di.onclick = () => vscode.postMessage({ type: 'indexDocs' }); }
{ const _ai = $('attach-img'); if (_ai) _ai.onclick = () => vscode.postMessage({ type: 'attachImage' }); }
{ const _sb2 = $('speak-btn'); if (_sb2) _sb2.onclick = () => vscode.postMessage({ type: 'speakLast' }); }
{ const _ms = $('mem-save'); if (_ms) _ms.onclick = () => {
  const facts = ($('mem-facts')?.value || '').split('\n').map((l) => l.trim()).filter(Boolean);
  vscode.postMessage({ type: 'setMemory', enabled: !!$('mem-enabled')?.checked, facts });
}; }
{ const _ac = $('artifact-close'); if (_ac) _ac.onclick = () => { const p = $('artifact-pane'); if (p) p.hidden = true; }; }
{ const _ec = $('export-chat'); if (_ec) _ec.onclick = () => vscode.postMessage({ type: 'exportChat' }); }
{ const _pa = $('params-apply'); if (_pa) _pa.onclick = () => {
  const params = {};
  const t = $('p-temp'); if (t && t.value !== '') params.temperature = Number(t.value);
  const tp = $('p-topp'); if (tp && tp.value !== '') params.top_p = Number(tp.value);
  const mt = $('p-maxtok'); if (mt && mt.value !== '') params.max_tokens = Number(mt.value);
  vscode.postMessage({ type: 'setParams', params });
}; }
{ const _ps = $('pr-save'); if (_ps) _ps.onclick = () => {
  const textEl = $('pr-text');
  if (!textEl) return;
  const text = textEl.value.trim();
  if (!text) return;
  const id = window.__editingPromptId || crypto.randomUUID();
  const title = text.split('\n')[0].trim().slice(0, 60) || 'Prompt';
  vscode.postMessage({ type: 'savePrompt', prompt: { id, title, text } });
  window.__editingPromptId = null;
  textEl.value = '';
}; }
document.addEventListener('click', (e) => {
  const del = e.target.closest && e.target.closest('.pr-del');
  if (del) { vscode.postMessage({ type: 'deletePrompt', id: del.dataset.id }); return; }
  const pDel = e.target.closest && e.target.closest('.persona-del');
  if (pDel) { vscode.postMessage({ type: 'deletePersona', id: pDel.dataset.id }); return; }
  const pUse = e.target.closest && e.target.closest('.persona-use');
  if (pUse) {
    const list = window.__personas || [];
    const p = list.find((x) => x.id === pUse.dataset.id);
    if (p) {
      window.__editingPersonaId = p.id;
      if ($('persona-name')) $('persona-name').value = p.name;
      if ($('persona-prompt')) $('persona-prompt').value = p.systemPrompt;
    }
    return;
  }
  const sUse = e.target.closest && e.target.closest('.skill-use');
  if (sUse) {
    vscode.postMessage({ type: 'setSkill', id: sUse.dataset.id });
    const pick = $('skill-picker');
    if (pick) pick.value = sUse.dataset.id;
    return;
  }
  const use = e.target.closest && e.target.closest('.pr-title-use');
  if (use) {
    const list = (window.__prefs && window.__prefs.prompts) || [];
    const p = list.find((x) => x.id === use.dataset.id);
    if (p) { const xe = $('pr-text'); if (xe) xe.value = p.text; window.__editingPromptId = p.id; }
    return;
  }
  const item = e.target.closest && e.target.closest('.slash-item');
  if (item) { pickSlashItem((window.__slashItems || [])[+item.dataset.idx]); return; }
  const mention = e.target.closest && e.target.closest('.mention-item');
  if (mention) { pickMentionItem((window.__mentionItems || [])[+mention.dataset.idx]); }
});
let slashPrevValue = '';
{ const _in = $('input'); if (_in) _in.addEventListener('input', () => {
  const v = _in.value;
  const wasEmptyOrSlash = slashPrevValue === '' || slashPrevValue.startsWith('/');
  if (v.startsWith('/') && wasEmptyOrSlash) {
    const items = slashCandidates(v.slice(1));
    slashActive = items.length ? 0 : -1;
    window.__slashItems = items;
    renderSlashMenu(items);
    closeMentionMenu();
  } else {
    closeSlashMenu();
    const ctx = mentionAtCursor();
    if (ctx) {
      mentionQuery = ctx.query;
      mentionActive = 0;
      vscode.postMessage({ type: 'listMentionFiles', query: ctx.query });
    } else {
      closeMentionMenu();
    }
  }
  slashPrevValue = v;
}); }
{ const _in = $('input'); if (_in) _in.addEventListener('keydown', (e) => {
  const mentionMenu = $('mention-menu');
  if (mentionMenu && !mentionMenu.hidden) {
    const items = window.__mentionItems || [];
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionActive = Math.min(items.length - 1, mentionActive + 1); renderMentionMenu(items); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); mentionActive = Math.max(0, mentionActive - 1); renderMentionMenu(items); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); pickMentionItem(items[mentionActive]); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeMentionMenu(); return; }
  }
  const menu = $('slash-menu');
  if (!menu || menu.hidden) return;
  const items = window.__slashItems || [];
  if (e.key === 'ArrowDown') { e.preventDefault(); slashActive = Math.min(items.length - 1, slashActive + 1); renderSlashMenu(items); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); slashActive = Math.max(0, slashActive - 1); renderSlashMenu(items); return; }
  if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); pickSlashItem(items[slashActive]); return; }
  if (e.key === 'Escape') { e.preventDefault(); closeSlashMenu(); return; }
}); }
$('messages').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cb]');
  if (b) {
    const code = cbCodes[+b.dataset.cb];
    if (b.dataset.act === 'copy') { navigator.clipboard.writeText(code); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 900); }
    if (b.dataset.act === 'insert') vscode.postMessage({ type: 'insertCode', code });
    if (b.dataset.act === 'apply') vscode.postMessage({ type: 'applyCode', code });
    if (b.dataset.act === 'artifact') vscode.postMessage({ type: 'showArtifact', html: code });
    return;
  }
  if (e.target.closest('.regen')) { turnReasoning = ''; vscode.postMessage({ type: 'regenerate' }); return; }
  const rm = e.target.closest('.remember');
  if (rm) {
    const idx = +rm.dataset.idx;
    const msg = lastMessages[idx];
    if (msg?.content) vscode.postMessage({ type: 'rememberFact', text: msg.content });
    return;
  }
  const em = e.target.closest('.editmsg');
  if (em) { turnReasoning = ''; vscode.postMessage({ type: 'editLoad', index: +em.dataset.idx }); return; }
  const fm = e.target.closest('.forkmsg');
  if (fm) { turnReasoning = ''; vscode.postMessage({ type: 'forkChat', index: +fm.dataset.idx }); return; }
});
$('input').addEventListener('keydown', (e) => {
  const mentionMenu = $('mention-menu');
  const slashMenu = $('slash-menu');
  if ((mentionMenu && !mentionMenu.hidden) || (slashMenu && !slashMenu.hidden)) return;
  if (e.key === 'ArrowUp' && browseInputHistory(-1)) { e.preventDefault(); return; }
  if (e.key === 'ArrowDown' && browseInputHistory(1)) { e.preventDefault(); return; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('send').click(); }
});

$('fw-key-save').onclick = () => { const k = $('fw-key').value.trim(); if (k) vscode.postMessage({ type: 'setFireworksKey', key: k }); };
$('dev-use').onclick = () => {
  const slug = ($('dev-slug').value.trim() || $('dev-preset').value || '').trim();
  if (!slug) return;
  vscode.postMessage({ type: 'selectDevModel', slug });
  $('composer').hidden = false;
  $('send').disabled = false;
  $('active-model').innerHTML = '<span class="dev-active">' + esc(slug) + '</span>';
  const empty = $('empty-state');
  if (empty) empty.hidden = true;
  closeSettings(false);
};

setProvider('local');
resizeInput();
updateModeBadge();
