const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let streaming = '';
let provider = 'local';
let policy = { local: [], openrouter: [] };
let selectedId = null;

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function badges(m, status) {
  const out = [`<span class="b b-us">🇺🇸 US · ${esc(m.origin.org)}</span>`];
  out.push(m.provider === 'local' ? `<span class="b b-host">on-device</span>` : `<span class="b b-host">US providers pinned</span>`);
  if (m.agentCapable) out.push(`<span class="b b-agent">agent</span>`);
  if (m.provider === 'local') {
    const dl = status && status.downloadedModelIds.includes(m.local.catalogId);
    out.push(`<span class="b b-ram">${dl ? 'ready' : 'download'}</span>`);
  } else out.push(`<span class="b b-ram">cloud</span>`);
  return out.join('');
}

function renderModels(status) {
  const list = provider === 'local' ? policy.local : policy.openrouter;
  $('models').innerHTML = list.map((m) => `
    <div class="mcard ${m.id === selectedId ? 'sel' : ''}" data-id="${m.id}">
      <div class="mrow"><span class="mname">${esc(m.displayName)}</span>${m.id === selectedId ? '<span style="color:#4ec98a">✓</span>' : ''}</div>
      <div class="badges">${badges(m, status)}</div>
    </div>`).join('');
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
  if (provider === 'local' && !status.binaryInstalled) {
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
  if (m.type === 'error') { $('banner-text').textContent = m.message; $('banner').hidden = false; }
  if (m.type === 'token') appendToken(m.text);
  if (m.type === 'agentStep') { $('steps').hidden = false; $('steps').innerHTML += `<div>${esc(m.step)}</div>`; }
});

function renderHistory(messages) {
  streaming = '';
  $('messages').innerHTML = messages
    .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
    .map((m) => `<div class="msg ${m.role}"><pre>${esc(m.content)}</pre></div>`).join('');
  $('messages').scrollTop = $('messages').scrollHeight;
}
function appendToken(t) {
  streaming += t;
  let el = document.querySelector('.msg.streaming pre');
  if (!el) { const d = document.createElement('div'); d.className = 'msg assistant streaming'; d.innerHTML = '<pre></pre>'; $('messages').appendChild(d); el = d.querySelector('pre'); }
  el.textContent = streaming; $('messages').scrollTop = $('messages').scrollHeight;
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
$('send').onclick = () => { const t = $('input').value.trim(); if (!t) return; $('input').value = ''; $('banner').hidden = true; $('steps').innerHTML = ''; $('steps').hidden = true; vscode.postMessage({ type: 'send', text: t }); $('cancel').hidden = false; };
$('cancel').onclick = () => { vscode.postMessage({ type: 'cancel' }); $('cancel').hidden = true; };
$('new-chat').onclick = () => vscode.postMessage({ type: 'newChat' });
$('agent-toggle').onchange = (e) => vscode.postMessage({ type: 'agentToggle', on: e.target.checked });
$('banner-close').onclick = () => { $('banner').hidden = true; };
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('send').click(); } });

setProvider('local');
