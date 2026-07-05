const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let streaming = '';
let provider = 'local';
let policy = { local: [], openrouter: [] };
let selectedId = null;

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
      out += `<div class="codeblock"><div class="cb-head"><span>${esc(lang || 'code')}</span><span class="cb-btns"><button data-cb="${id}" data-act="copy">Copy</button><button data-cb="${id}" data-act="insert">Insert</button><button data-cb="${id}" data-act="apply">Apply</button></span></div><pre><code>${esc(code)}</code></pre></div>`;
    } else if (parts[i]) {
      out += `<div class="md">${renderInline(parts[i])}</div>`;
    }
  }
  return out;
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
  if (m.type === 'error') { if (m.message) { $('banner-text').textContent = m.message; $('banner').hidden = false; } else { $('banner').hidden = true; } }
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
  if (m.type === 'chats') { const p = $('chat-picker'); if (p) { p.innerHTML = (m.metas || []).map((c) => `<option value="${c.id}">${esc(c.title || 'New chat')}</option>`).join(''); p.value = m.activeId; } }
  if (m.type === 'contextWindow') { window.__ctxWindow = m.tokens; updateMeter(); }
  if (m.type === 'devMode') {
    window.__dev = m.on;
    $('dev').hidden = !m.on;
    $('fw-key-row').hidden = m.fireworksKeySet;
    $('dev-preset').innerHTML = '<option value="">— pick a Fireworks model —</option>' +
      (m.presets || []).map((p) => `<option value="${p.slug}">${esc(p.label)}</option>`).join('');
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
      return `<div class="msg assistant">${reason}${renderMarkdown(m.content)}${foot}</div>`;
    }
    return `<div class="msg user"><pre>${esc(m.content)}</pre><button class="editmsg" data-idx="${i}" title="Edit &amp; resend">✎</button></div>`;
  }).join('');
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
$('chat-picker').onchange = (e) => { turnReasoning = ''; vscode.postMessage({ type: 'switchChat', id: e.target.value }); };
$('input').addEventListener('input', updateMeter);
$('agent-toggle').onchange = (e) => vscode.postMessage({ type: 'agentToggle', on: e.target.checked });
$('banner-close').onclick = () => { $('banner').hidden = true; };
$('messages').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cb]');
  if (b) {
    const code = cbCodes[+b.dataset.cb];
    if (b.dataset.act === 'copy') { navigator.clipboard.writeText(code); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 900); }
    if (b.dataset.act === 'insert') vscode.postMessage({ type: 'insertCode', code });
    if (b.dataset.act === 'apply') vscode.postMessage({ type: 'applyCode', code });
    return;
  }
  if (e.target.closest('.regen')) { turnReasoning = ''; vscode.postMessage({ type: 'regenerate' }); return; }
  const em = e.target.closest('.editmsg');
  if (em) { turnReasoning = ''; vscode.postMessage({ type: 'editLoad', index: +em.dataset.idx }); return; }
});
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('send').click(); } });

$('fw-key-save').onclick = () => { const k = $('fw-key').value.trim(); if (k) vscode.postMessage({ type: 'setFireworksKey', key: k }); };
$('dev-use').onclick = () => {
  const slug = ($('dev-slug').value.trim() || $('dev-preset').value || '').trim();
  if (!slug) return;
  vscode.postMessage({ type: 'selectDevModel', slug });
  $('chat-head').hidden = false; $('composer').hidden = false; $('send').disabled = false;
  $('active-model').innerHTML = '<span class="dev-active">⚠ DEV · ' + esc(slug) + '</span>';
};

setProvider('local');
