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
let policy = { local: [], openrouter: [] };
let selectedId = null;
let galleryUserToggled = false;
function updateGalleryToggle() {
  if (!$('gallery-toggle')) return;
  const collapsed = $('gallery-body').hidden;
  const active = ($('active-model').textContent || '').trim();
  $('gallery-toggle').innerHTML = `${collapsed ? '▸' : '▾'} Models${collapsed && active ? ` · <span style="color:#4ec98a">${esc(active)}</span>` : ''}`;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

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

function cardStatus(m, status) {
  if (m.provider !== 'local') return { badge: '<span class="b b-ram">cloud</span>', bar: '' };
  const cid = m.local.catalogId;
  if (status && status.download && status.download.modelId === cid && status.download.totalBytes) {
    const pct = Math.max(0, Math.min(100, Math.floor((status.download.receivedBytes / status.download.totalBytes) * 100)));
    return { badge: `<span class="b b-dl">⬇ downloading ${pct}%</span>`, bar: `<progress class="dlbar" max="100" value="${pct}"></progress>` };
  }
  if (status && status.downloadedModelIds.includes(cid)) {
    if (status.modelId === cid && status.state === 'ready') return { badge: '<span class="b b-ready">● ready</span>', bar: '' };
    if (status.modelId === cid && (status.state === 'loading-model' || status.state === 'starting')) return { badge: '<span class="b b-dl">starting…</span>', bar: '' };
    return { badge: '<span class="b b-ready">✓ downloaded</span>', bar: '' };
  }
  return { badge: '<span class="b b-ram">⬇ download</span>', bar: '' };
}

function badges(m, status) {
  const out = [`<span class="b b-us">🇺🇸 US · ${esc(m.origin.org)}</span>`];
  out.push(m.provider === 'local' ? `<span class="b b-host">on-device</span>` : `<span class="b b-host">US providers pinned</span>`);
  if (m.agentCapable) out.push(`<span class="b b-agent">agent</span>`);
  out.push(cardStatus(m, status).badge);
  return out.join('');
}

function renderModels(status) {
  const list = provider === 'local' ? policy.local : policy.openrouter;
  $('models').innerHTML = list.map((m) => {
    const cs = cardStatus(m, status);
    return `<div class="mcard ${m.id === selectedId ? 'sel' : ''}" data-id="${m.id}">
      <div class="mrow"><span class="mname">${esc(m.displayName)}</span>${m.id === selectedId ? '<span style="color:#4ec98a">✓</span>' : ''}</div>
      <div class="badges">${badges(m, status)}</div>${cs.bar}</div>`;
  }).join('');
  document.querySelectorAll('.mcard').forEach((el) => el.onclick = () => {
    const m = list.find((x) => x.id === el.dataset.id);
    if (m && m.provider === 'local' && status && !status.downloadedModelIds.includes(m.local.catalogId)) {
      vscode.postMessage({ type: 'downloadModel', catalogId: m.local.catalogId });
    } else {
      vscode.postMessage({ type: 'selectModel', id: el.dataset.id });
    }
  });
}

function renderState(status) {
  window.__status = status;
  renderModels(status);
  const setup = $('setup');
  if (status.downloadError) {
    setup.hidden = false;
    setup.innerHTML = `<b style="color:#e07a7a">⚠ ${esc(status.downloadError)}</b><p>Click the model again to retry.</p>`;
  } else if (provider === 'local' && !status.binaryInstalled) {
    setup.hidden = false;
    const gb = Math.round(status.ram.totalBytes / 2 ** 30);
    setup.innerHTML = `<b>Welcome to Fortress Code</b><p>This Mac has ${gb} GB RAM. One click installs the local engine.</p><button id="do-setup">Set up local engine</button>`;
    $('do-setup').onclick = () => vscode.postMessage({ type: 'installBinary' });
  } else if (status.download) {
    setup.hidden = false;
    const pct = Math.round((status.download.receivedBytes / status.download.totalBytes) * 100);
    setup.innerHTML = `<p>Downloading… ${pct}%</p><progress max="100" value="${pct}"></progress>`;
  } else if (status.state === 'loading-model' || status.state === 'starting') {
    setup.hidden = false; setup.innerHTML = `<p>Loading model…</p>`;
  } else setup.hidden = true;

  const ready = provider === 'openrouter' ? !!selectedId : (status.state === 'ready' && !!selectedId);
  $('chat-head').hidden = !selectedId; $('composer').hidden = !selectedId;
  $('send').disabled = !ready;
  if (selectedId) {
    const m = [...policy.local, ...policy.openrouter].find((x) => x.id === selectedId);
    $('active-model').textContent = (provider === 'openrouter' ? '☁️ ' : '🖥 ') + (m ? m.displayName : '');
    const agentEl = $('agent-toggle');
    agentEl.disabled = !m || !m.agentCapable;
    if (agentEl.disabled) agentEl.checked = false;
  }
  if (selectedId && !galleryUserToggled) $('gallery-body').hidden = true;
  updateGalleryToggle();
}

function setProvider(p) {
  provider = p; selectedId = null;
  $('seg-local').classList.toggle('on', p === 'local');
  $('seg-or').classList.toggle('on', p === 'openrouter');
  $('req-local').hidden = p !== 'local';
  $('req-or').hidden = p !== 'openrouter';
  $('or-key').hidden = p !== 'openrouter' || window.__orKeySet;
  $('add-row').hidden = p !== 'openrouter';
  $('add-blocked').hidden = true;
  if (window.__status) renderState(window.__status);
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'policy') { policy = { local: m.local, openrouter: m.openrouter }; if (window.__status) renderState(window.__status); }
  if (m.type === 'openRouterKeySet') { window.__orKeySet = m.set; $('or-key').hidden = provider !== 'openrouter' || m.set; }
  if (m.type === 'state') { selectedId = m.selectedId; renderState(m.status); }
  if (m.type === 'history') renderHistory(m.messages);
  if (m.type === 'startRejected') renderRejection(m.rejection, m.modelId);
  if (m.type === 'addBlocked') { $('add-blocked').hidden = false; $('add-blocked').innerHTML = `<b style="color:#e07a7a">⛔ Blocked by policy</b><p>${esc(m.reason)}</p><span class="b">✗ non-US</span><p style="margin-top:6px">Approved US models are listed above, or request an addition.</p>`; }
  if (m.type === 'addAccepted') { $('add-blocked').hidden = false; $('add-blocked').innerHTML = `<p>${esc(m.slug)} is already on the approved list — select it above.</p>`; }
  if (m.type === 'restoreInput') $('input').value = m.text;
  if (m.type === 'error') {
    if (m.message) {
      $('banner-text').textContent = m.message; $('banner').hidden = false;
      clearTimeout(window.__bannerTimer);
      window.__bannerTimer = setTimeout(() => { $('banner').hidden = true; }, 7000);
    } else { $('banner').hidden = true; }
  }
  if (m.type === 'clearBanner') $('banner').hidden = true;
  if (m.type === 'token') appendToken(m.text);
  if (m.type === 'context') {
    $('chips').innerHTML = (m.chips || []).map((c) => `<span class="chip">${esc(c.label)}<button data-chip="${esc(c.id)}">×</button></span>`).join('');
    document.querySelectorAll('#chips button').forEach((b) => b.onclick = () => vscode.postMessage({ type: 'excludeContext', id: b.dataset.chip }));
  }
  if (m.type === 'agentStep') { $('steps').hidden = false; $('steps').innerHTML += `<div>${esc(m.step)}</div>`; }
  if (m.type === 'reasoning') appendReasoning(m.text);
  if (m.type === 'reasoningDone') { const b = document.querySelector('.reasoning-live'); if (b) b.open = false; }
  if (m.type === 'usage' && m.usage) { const u = $('usage-last'); if (u) u.textContent = `↑${m.usage.promptTokens} ↓${m.usage.completionTokens} tok`; }
  if (m.type === 'chats') { window.__lastChats = m; renderChatPicker(m.metas, m.activeId); }
  if (m.type === 'prefs') {
    window.__prefs = { prompts: m.prompts || [], params: m.params || {}, personas: m.personas || [] };
    fillParams(); renderPrompts(); renderPersonas(); fillComparePicker();
  }
  if (m.type === 'memory') {
    window.__memory = m.data || { enabled: false, facts: [] };
    fillMemory();
  }
  if (m.type === 'folders') renderFolderFilter(m.folders || []);
  if (m.type === 'docsStatus') {
    const s = m.stats || { files: 0, chunks: 0 };
    const el = $('docs-status'); if (el) el.textContent = s.chunks ? `${s.files} docs · ${s.chunks} chunks` : 'No docs indexed';
  }
  if (m.type === 'docsProgress') {
    const el = $('docs-status'); if (el) el.textContent = `Indexing docs ${m.done}/${m.total}…`;
  }
  if (m.type === 'attachedImages') {
    const el = $('meter'); if (el) el.textContent = `${m.count} image(s) attached`;
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
  if (m.type === 'searchResults') { renderChatPicker(m.metas, $('chat-picker') ? $('chat-picker').value : undefined); }
  if (m.type === 'contextWindow') { window.__ctxWindow = m.tokens; updateMeter(); }
  if (m.type === 'devMode') {
    window.__dev = m.on;
    $('dev').hidden = !m.on;
    $('fw-key-row').hidden = m.fireworksKeySet;
    $('dev-preset').innerHTML = '<option value="">— pick a Fireworks model —</option>' +
      (m.presets || []).map((p) => `<option value="${p.slug}">${esc(p.label)}</option>`).join('');
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

function renderHistory(messages) {
  streaming = ''; cbCodes = [];
  const shown = messages.map((m, i) => ({ m, i })).filter(({ m }) => m.role === 'user' || (m.role === 'assistant' && m.content));
  let lastA = -1; shown.forEach((x, k) => { if (x.m.role === 'assistant') lastA = k; });
  $('messages').innerHTML = shown.map(({ m, i }, k) => {
    if (m.role === 'assistant') {
      const reason = (k === lastA && turnReasoning) ? `<details class="reasoning"><summary>▸ Reasoning</summary><pre>${esc(turnReasoning)}</pre></details>` : '';
      const foot = k === lastA ? `<div class="msg-foot"><button class="regen">↻ Regenerate</button><span class="usage" id="usage-last"></span></div>` : '';
      const sources = (m.sources && m.sources.length) ? `<div class="src-list" data-src-idx="${k}">Sources: </div>` : '';
      return `<div class="msg assistant">${reason}${renderMarkdown(m.content)}${sources}${foot}</div>`;
    }
    return `<div class="msg user"><pre>${esc(m.content)}</pre><button class="editmsg" data-idx="${i}" title="Edit &amp; resend">✎</button><button class="forkmsg" data-idx="${i}" title="Fork from here">⑂</button></div>`;
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
  el.textContent = streaming; $('messages').scrollTop = $('messages').scrollHeight;
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
}
function updateMeter() {
  const win = window.__ctxWindow || 8192;
  const est = Math.ceil(($('input').value.length + 200) / 4);
  const el = $('meter'); if (!el) return;
  el.textContent = `~${(est / 1000).toFixed(1)}k / ${Math.round(win / 1000)}k`;
  el.classList.toggle('warn', est > win * 0.9);
}
function renderRejection(r, modelId) {
  const need = Math.round(r.requiredBytes / 2 ** 30), have = Math.round(r.availableBytes / 2 ** 30);
  const rows = r.foreign.map((p) => `<li>${esc(p.command.slice(0, 70))} — ${Math.round(p.rssBytes / 2 ** 30)} GB (pid ${p.pid})</li>`).join('');
  $('setup').hidden = false;
  $('setup').innerHTML = `<b>Not enough memory</b><p>Needs ~${need} GB but ${have} GB is available.</p>${r.foreign.length ? `<ul>${rows}</ul>` : ''}${r.wouldFitAfterForeignKill ? `<button id="kill-foreign">Stop those and continue</button>` : `<p>Even stopping those won't free enough — try a smaller model.</p>`}`;
  const btn = $('kill-foreign');
  if (btn) btn.onclick = () => { vscode.postMessage({ type: 'killForeign', pids: r.foreign.map((p) => p.pid) }); setTimeout(() => vscode.postMessage({ type: 'selectModel', id: modelId }), 1500); };
}

function renderChatPicker(metas, activeId) {
  const p = $('chat-picker');
  if (!p) return;
  const keep = activeId !== undefined ? activeId : p.value;
  p.innerHTML = (metas || []).map((c) => `<option value="${c.id}">${esc(c.title || 'New chat')}</option>`).join('');
  p.value = keep;
}

function fillParams() {
  const params = (window.__prefs && window.__prefs.params) || {};
  const t = $('p-temp'); if (t) t.value = params.temperature != null ? String(params.temperature) : '';
  const tp = $('p-topp'); if (tp) tp.value = params.top_p != null ? String(params.top_p) : '';
  const mt = $('p-maxtok'); if (mt) mt.value = params.max_tokens != null ? String(params.max_tokens) : '';
}

function renderPersonas() {
  const list = (window.__prefs && window.__prefs.personas) || [];
  const box = $('personas-list'); if (box) box.innerHTML = list.map((p) => `<div class="prompt-item"><span>${esc(p.name)}</span></div>`).join('');
  const pick = $('persona-picker'); if (!pick) return;
  const keep = pick.value;
  pick.innerHTML = '<option value="">Default persona</option>' + list.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  pick.value = keep;
}

function fillComparePicker() {
  const pick = $('compare-picker'); if (!pick) return;
  const models = [...(policy.local || []), ...(policy.openrouter || [])];
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
    use.textContent = p.title;
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
  return list.filter((p) => p.title.toLowerCase().includes(f));
}
function renderSlashMenu(items) {
  const menu = $('slash-menu');
  if (!menu) return;
  menu.innerHTML = '';
  items.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'slash-item' + (i === slashActive ? ' active' : '');
    row.dataset.idx = String(i);
    row.textContent = p.title;
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

$('seg-local').onclick = () => setProvider('local');
$('seg-or').onclick = () => setProvider('openrouter');
$('or-key-save').onclick = () => { const k = $('or-key-input').value.trim(); if (k) vscode.postMessage({ type: 'setOpenRouterKey', key: k }); };
$('add-btn').onclick = () => { const s = $('add-slug').value.trim(); if (s) vscode.postMessage({ type: 'addModel', slug: s }); };
$('send').onclick = () => {
  let t = $('input').value.trim();
  if (!t) return;
  const slash = { '/explain': 'Explain this code.', '/fix': 'Find and fix bugs in this code.', '/test': 'Write unit tests for this code.', '/refactor': 'Refactor this code without changing behavior.', '/doc': 'Add doc comments to this code.' };
  const cmd = t.split(/\s+/)[0];
  if (slash[cmd]) { const rest = t.slice(cmd.length).trim(); t = slash[cmd] + (rest ? ' ' + rest : ''); }
  $('input').value = ''; $('banner').hidden = true; $('steps').innerHTML = ''; $('steps').hidden = true;
  turnReasoning = ''; vscode.postMessage({ type: 'send', text: t }); $('cancel').hidden = false; updateMeter();
};
$('cancel').onclick = () => { vscode.postMessage({ type: 'cancel' }); $('cancel').hidden = true; };
$('new-chat').onclick = () => { turnReasoning = ''; vscode.postMessage({ type: 'newChat' }); };
{ const _gt = $('gallery-toggle'); if (_gt) _gt.onclick = () => { galleryUserToggled = true; $('gallery-body').hidden = !$('gallery-body').hidden; updateGalleryToggle(); }; }
{ const _ri = $('rag-index'); if (_ri) _ri.onclick = () => { $('rag-index').disabled = true; vscode.postMessage({ type: 'indexWorkspace' }); }; }
$('chat-picker').onchange = (e) => { turnReasoning = ''; vscode.postMessage({ type: 'switchChat', id: e.target.value }); };
$('input').addEventListener('input', updateMeter);
$('agent-toggle').onchange = (e) => vscode.postMessage({ type: 'agentToggle', on: e.target.checked });
$('banner-close').onclick = () => { $('banner').hidden = true; };

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
{ const _pp = $('persona-picker'); if (_pp) _pp.onchange = () => vscode.postMessage({ type: 'setPersona', personaId: _pp.value || null }); }
{ const _cp = $('compare-picker'); if (_cp) _cp.onchange = () => vscode.postMessage({ type: 'setCompareModel', id: _cp.value || null }); }
{ const _di = $('docs-index'); if (_di) _di.onclick = () => vscode.postMessage({ type: 'indexDocs' }); }
{ const _ai = $('attach-img'); if (_ai) _ai.onclick = () => vscode.postMessage({ type: 'attachImage' }); }
{ const _sb = $('speak-btn'); if (_sb) _sb.onclick = () => vscode.postMessage({ type: 'speakLast' }); }
{ const _mb = $('memory-btn'); if (_mb) _mb.onclick = () => { const mgr = $('memory-mgr'); if (mgr) { mgr.hidden = !mgr.hidden; fillMemory(); } }; }
{ const _mc = $('memory-close'); if (_mc) _mc.onclick = () => { const mgr = $('memory-mgr'); if (mgr) mgr.hidden = true; }; }
{ const _ms = $('mem-save'); if (_ms) _ms.onclick = () => {
  const facts = ($('mem-facts')?.value || '').split('\n').map((l) => l.trim()).filter(Boolean);
  vscode.postMessage({ type: 'setMemory', enabled: !!$('mem-enabled')?.checked, facts });
}; }
{ const _pb2 = $('personas-btn'); if (_pb2) _pb2.onclick = () => { const mgr = $('personas-mgr'); if (mgr) { mgr.hidden = !mgr.hidden; renderPersonas(); } }; }
{ const _pc = $('personas-close'); if (_pc) _pc.onclick = () => { const mgr = $('personas-mgr'); if (mgr) mgr.hidden = true; }; }
{ const _ps2 = $('pe-save'); if (_ps2) _ps2.onclick = () => {
  const name = $('pe-name')?.value.trim(); const text = $('pe-prompt')?.value.trim();
  if (!name || !text) return;
  vscode.postMessage({ type: 'savePersona', persona: { id: crypto.randomUUID(), name, systemPrompt: text } });
  $('pe-name').value = ''; $('pe-prompt').value = '';
}; }
{ const _ac = $('artifact-close'); if (_ac) _ac.onclick = () => { const p = $('artifact-pane'); if (p) p.hidden = true; }; }
{ const _ec = $('export-chat'); if (_ec) _ec.onclick = () => vscode.postMessage({ type: 'exportChat' }); }
{ const _pb = $('params-btn'); if (_pb) _pb.onclick = () => { const pop = $('params-pop'); if (pop) pop.hidden = !pop.hidden; }; }
{ const _pa = $('params-apply'); if (_pa) _pa.onclick = () => {
  const params = {};
  const t = $('p-temp'); if (t && t.value !== '') params.temperature = Number(t.value);
  const tp = $('p-topp'); if (tp && tp.value !== '') params.top_p = Number(tp.value);
  const mt = $('p-maxtok'); if (mt && mt.value !== '') params.max_tokens = Number(mt.value);
  vscode.postMessage({ type: 'setParams', params });
}; }
{ const _prb = $('prompts-btn'); if (_prb) _prb.onclick = () => { const mgr = $('prompts-mgr'); if (mgr) { mgr.hidden = !mgr.hidden; if (!mgr.hidden) renderPrompts(); } }; }
{ const _pcl = $('prompts-close'); if (_pcl) _pcl.onclick = () => { const mgr = $('prompts-mgr'); if (mgr) mgr.hidden = true; }; }
{ const _ps = $('pr-save'); if (_ps) _ps.onclick = () => {
  const titleEl = $('pr-title'); const textEl = $('pr-text');
  if (!titleEl || !textEl) return;
  const title = titleEl.value.trim();
  const text = textEl.value;
  if (!title || !text.trim()) return;
  const id = window.__editingPromptId || crypto.randomUUID();
  vscode.postMessage({ type: 'savePrompt', prompt: { id, title, text } });
  window.__editingPromptId = null;
  titleEl.value = ''; textEl.value = '';
}; }
document.addEventListener('click', (e) => {
  const del = e.target.closest && e.target.closest('.pr-del');
  if (del) { vscode.postMessage({ type: 'deletePrompt', id: del.dataset.id }); return; }
  const use = e.target.closest && e.target.closest('.pr-title-use');
  if (use) {
    const list = (window.__prefs && window.__prefs.prompts) || [];
    const p = list.find((x) => x.id === use.dataset.id);
    if (p) { const te = $('pr-title'); const xe = $('pr-text'); if (te) te.value = p.title; if (xe) xe.value = p.text; window.__editingPromptId = p.id; }
    return;
  }
  const item = e.target.closest && e.target.closest('.slash-item');
  if (item) { pickSlashItem((window.__slashItems || [])[+item.dataset.idx]); }
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
  } else {
    closeSlashMenu();
  }
  slashPrevValue = v;
}); }
{ const _in = $('input'); if (_in) _in.addEventListener('keydown', (e) => {
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
  const em = e.target.closest('.editmsg');
  if (em) { turnReasoning = ''; vscode.postMessage({ type: 'editLoad', index: +em.dataset.idx }); return; }
  const fm = e.target.closest('.forkmsg');
  if (fm) { turnReasoning = ''; vscode.postMessage({ type: 'forkChat', index: +fm.dataset.idx }); return; }
});
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('send').click(); } });

$('fw-key-save').onclick = () => { const k = $('fw-key').value.trim(); if (k) vscode.postMessage({ type: 'setFireworksKey', key: k }); };
$('dev-use').onclick = () => {
  const slug = ($('dev-slug').value.trim() || $('dev-preset').value || '').trim();
  if (!slug) return;
  vscode.postMessage({ type: 'selectDevModel', slug });
  $('chat-head').hidden = false; $('composer').hidden = false; $('send').disabled = false;
  $('active-model').innerHTML = '<span class="dev-active">⚠ DEV · ' + esc(slug) + '</span>';
  if (!galleryUserToggled) $('gallery-body').hidden = true;
  updateGalleryToggle();
};

setProvider('local');
