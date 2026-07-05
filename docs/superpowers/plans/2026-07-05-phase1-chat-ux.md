# Phase 1 — Chat UX Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six chat-UX features — prompt library, model params UI, chat export, chat search, fork-from-message, LaTeX+Mermaid — in the shared webview + twinned controllers, shipped in the VS Code extension then the Mac app.

**Architecture:** New pure module `prefs.ts` (prompts + params over MementoLike); `SessionStore.fork` + a pure search ranker; a pure Markdown export renderer; six new message cases twinned across ChatViewProvider (ext) and ChatController (mac); webview UI additions in the shared `media/` files; KaTeX+Mermaid vendored locally (CSP-safe).

**Tech Stack:** TypeScript, vitest, esbuild, KaTeX, Mermaid (IIFE build), VS Code webview / Electron.

## Global Constraints

- Repos: extension work in `~/Development/curtis-llama/fortress-code` (branch `feat/phase1-chat-ux`, merged to main at the end); Mac work in `~/Development/curtis-llama/fortress-code-mac` (main, per that repo's convention).
- `chat.js`/`chat.css` stay byte-identical-shareable: additive changes only; NO frontend-specific branches inside them. `chat.html` changes must keep the Mac sync-renderer's anchors intact (`{cspSource}`, the `chat.css` link line, the `chat.js` script line).
- Emoji rule: only `⚠️ ✅ ❌ 🔐 ✕ ✓` (existing glyphs like `✎` stay; the fork button uses text glyph `⑂`).
- Webview XSS posture: never template attacker-influenced values into HTML attributes — DOM construction (`dataset`, `textContent`) as established. KaTeX `trust:false, throwOnError:false`; Mermaid `securityLevel:'strict', startOnLoad:false`.
- New message handlers follow the existing banner-on-error pattern; storage failures never crash a turn.
- TDD per task. Test commands: `npm test -w fortress-code` (ext), `npm test` (mac). Builds must stay clean (`npm run build`).
- Params semantics: unset values are ABSENT from the request body (not null/default numbers). Ranges: temperature 0-2, top_p 0-1, max_tokens positive int.
- Storage keys: `fortressCode.prompts` → `SavedPrompt[]`; `fortressCode.params` → `Params`.
- Message protocol additions — inbound: `savePrompt {prompt}`, `deletePrompt {id}`, `setParams {params}`, `exportChat {}`, `searchChats {query}`, `forkChat {index}`; outbound: `prefs { prompts, params }`, `searchResults { metas }`.

---

## File Structure

**fortress-code (extension repo)**
- Create: `packages/extension/src/prefs.ts`, `src/exportChat.ts`, `src/chatSearch.ts`, `media/vendor/` (katex.min.js, katex.min.css, fonts/, auto-render.min.js, mermaid.min.js)
- Modify: `src/sessionStore.ts` (add `fork`), `src/chat/ChatViewProvider.ts` (init prefs post, six cases, params injection), `media/chat.html` (header buttons, prompts section, search input, CSP font-src, vendor tags), `media/chat.css`, `media/chat.js` (handlers, slash dropdown, popover, fork button, math/mermaid post-pass)
- Tests: `src/test/prefs.test.ts`, `src/test/exportChat.test.ts`, `src/test/chatSearch.test.ts`, extend `src/test/sessionStore.test.ts`

**fortress-code-mac**
- Modify: `vendor/fortress-code` (submodule bump), `scripts/sync-renderer.mjs` (copy `vendor/`), `src/main/controller.ts` (twin six cases + prefs), `src/main/main.ts` (`saveFile` dep), `test/controller.test.ts` (new cases)

---

### Task 1: `prefs.ts` — prompts + params storage (extension repo)

**Files:**
- Create: `packages/extension/src/prefs.ts`
- Test: `packages/extension/src/test/prefs.test.ts`

**Interfaces:**
- Produces:
  - `interface SavedPrompt { id: string; title: string; text: string }`
  - `interface Params { temperature?: number; top_p?: number; max_tokens?: number }`
  - `class Prefs { constructor(state: MementoLike); prompts(): SavedPrompt[]; savePrompt(p: SavedPrompt): void; deletePrompt(id: string): void; params(): Params; setParams(p: Params): void; }`
  - `interface MementoLike { get(key: string): unknown; update(key: string, value: unknown): unknown }` (structural — matches vscode Memento AND FileMemento)
  - `savePrompt` with an existing id replaces; with a new id appends. `setParams` drops keys whose value is `undefined`/`null`/`NaN` or out of range (temperature 0-2, top_p 0-1, max_tokens positive int) — stored object contains only valid set keys.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { Prefs } from '../prefs';

function mem() {
  const m = new Map<string, unknown>();
  return { get: (k: string) => m.get(k), update: (k: string, v: unknown) => void m.set(k, v) };
}

describe('Prefs prompts', () => {
  it('save appends, replace by id, delete removes', () => {
    const p = new Prefs(mem());
    p.savePrompt({ id: 'a', title: 'T', text: 'hello {name}' });
    p.savePrompt({ id: 'b', title: 'U', text: 'x' });
    p.savePrompt({ id: 'a', title: 'T2', text: 'bye' });
    expect(p.prompts().map((x) => x.title)).toEqual(['T2', 'U']);
    p.deletePrompt('b');
    expect(p.prompts()).toHaveLength(1);
  });
  it('persists through the memento', () => {
    const state = mem();
    new Prefs(state).savePrompt({ id: 'a', title: 'T', text: 'x' });
    expect(new Prefs(state).prompts()).toHaveLength(1);
  });
});

describe('Prefs params', () => {
  it('stores only valid set keys', () => {
    const p = new Prefs(mem());
    p.setParams({ temperature: 0.7, top_p: 5, max_tokens: -1 } as any);
    expect(p.params()).toEqual({ temperature: 0.7 }); // top_p out of range, max_tokens invalid
  });
  it('empty params round-trips as {}', () => {
    const p = new Prefs(mem());
    p.setParams({});
    expect(p.params()).toEqual({});
  });
});
```

- [ ] **Step 2: red** — `npm test -w fortress-code -- prefs` fails (module missing).
- [ ] **Step 3: implement**

```ts
export interface SavedPrompt { id: string; title: string; text: string }
export interface Params { temperature?: number; top_p?: number; max_tokens?: number }
export interface MementoLike { get(key: string): unknown; update(key: string, value: unknown): unknown }

const PROMPTS_KEY = 'fortressCode.prompts';
const PARAMS_KEY = 'fortressCode.params';

const RANGES: Record<keyof Params, (v: number) => boolean> = {
  temperature: (v) => v >= 0 && v <= 2,
  top_p: (v) => v >= 0 && v <= 1,
  max_tokens: (v) => Number.isInteger(v) && v > 0,
};

export class Prefs {
  constructor(private state: MementoLike) {}

  prompts(): SavedPrompt[] {
    const raw = this.state.get(PROMPTS_KEY);
    return Array.isArray(raw) ? raw.filter((p): p is SavedPrompt =>
      !!p && typeof p.id === 'string' && typeof p.title === 'string' && typeof p.text === 'string') : [];
  }
  savePrompt(p: SavedPrompt): void {
    const list = this.prompts();
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = p; else list.push(p);
    void this.state.update(PROMPTS_KEY, list);
  }
  deletePrompt(id: string): void {
    void this.state.update(PROMPTS_KEY, this.prompts().filter((x) => x.id !== id));
  }

  params(): Params {
    const raw = this.state.get(PARAMS_KEY);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Params) : {};
  }
  setParams(p: Params): void {
    const out: Params = {};
    for (const key of Object.keys(RANGES) as (keyof Params)[]) {
      const v = p[key];
      if (typeof v === 'number' && !Number.isNaN(v) && RANGES[key](v)) out[key] = v;
    }
    void this.state.update(PARAMS_KEY, out);
  }
}
```

- [ ] **Step 4: green** — `npm test -w fortress-code -- prefs` passes; full suite + build stay green.
- [ ] **Step 5: commit** — `git add packages/extension/src/prefs.ts packages/extension/src/test/prefs.test.ts && git commit -m "feat(prefs): prompt library + model params storage"`

---

### Task 2: `SessionStore.fork` + `chatSearch.ts` (extension repo)

**Files:**
- Modify: `packages/extension/src/sessionStore.ts`
- Create: `packages/extension/src/chatSearch.ts`
- Test: extend `packages/extension/src/test/sessionStore.test.ts`; create `packages/extension/src/test/chatSearch.test.ts`

**Interfaces:**
- Produces:
  - `SessionStore.fork(index: number): void` — copies `active().messages[0..index]` (inclusive; clamp to array bounds; if the store is empty or index < 0, no-op) into a NEW chat, title `('Fork: ' + originalTitle).slice(0, 40)`, makes it active (newest-first ordering preserved), saves.
  - `searchChats(query: string, metas: ChatMeta[], messagesById: Record<string, ChatMessage[]>): ChatMeta[]` — case-insensitive substring; score = 3×(title hit) + 1×(count of messages containing the query); descending score, ties keep original order; empty/whitespace query → `metas` unchanged.

- [ ] **Step 1: Failing tests**

Add to `sessionStore.test.ts` (reuse its existing memento helper):

```ts
it('fork copies messages up to index into a new active chat', () => {
  const store = SessionStore.load(mem());
  store.active().addUser('one');
  store.active().addAssistant('two');
  store.active().addUser('three');
  store.touchTitle();
  const originalId = store.activeId;
  store.fork(1); // keep 'one','two'
  expect(store.activeId).not.toBe(originalId);
  expect(store.active().messages.map((m) => m.content)).toEqual(['one', 'two']);
  expect(store.metas()[0].title.startsWith('Fork: ')).toBe(true);
});
it('fork with out-of-range index clamps to full copy', () => {
  const store = SessionStore.load(mem());
  store.active().addUser('only');
  store.fork(99);
  expect(store.active().messages).toHaveLength(1);
});
```

`chatSearch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { searchChats } from '../chatSearch';

const metas = [{ id: 'a', title: 'Rust helpers' }, { id: 'b', title: 'Notes' }, { id: 'c', title: 'misc' }];
const msgs = {
  a: [{ role: 'user', content: 'hi' }],
  b: [{ role: 'user', content: 'rust question' }, { role: 'assistant', content: 'RUST answer' }],
  c: [{ role: 'user', content: 'nothing' }],
} as any;

describe('searchChats', () => {
  it('ranks title hits above content hits, case-insensitive', () => {
    const r = searchChats('rust', metas, msgs);
    expect(r.map((m) => m.id)).toEqual(['a', 'b']); // a: 3 (title), b: 2 (two messages)
  });
  it('empty query returns all unchanged', () => {
    expect(searchChats('  ', metas, msgs)).toEqual(metas);
  });
});
```

- [ ] **Step 2: red.**
- [ ] **Step 3: implement**

In `sessionStore.ts` (after `switchTo`):

```ts
  fork(index: number): void {
    const src = this.sessions.get(this.activeId);
    if (!src || src.messages.length === 0 || index < 0) return;
    const upTo = Math.min(index, src.messages.length - 1);
    const copy = new Session();
    copy.messages = src.messages.slice(0, upTo + 1).map((m) => ({ ...m }));
    const id = randomUUID();
    const title = ('Fork: ' + (this.titles.get(this.activeId) || 'New chat')).slice(0, 40);
    this.order.unshift(id); this.titles.set(id, title); this.sessions.set(id, copy);
    this.activeId = id; this.save();
  }
```

`chatSearch.ts`:

```ts
import type { ChatMessage } from '@fortress-code/shared';
import type { ChatMeta } from './sessionStore';

export function searchChats(query: string, metas: ChatMeta[], messagesById: Record<string, ChatMessage[]>): ChatMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return metas;
  const scored = metas.map((m, i) => {
    let score = m.title.toLowerCase().includes(q) ? 3 : 0;
    for (const msg of messagesById[m.id] ?? []) if (msg.content.toLowerCase().includes(q)) score += 1;
    return { m, score, i };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((x) => x.m);
}
```

Also add to `SessionStore` a small accessor the controller needs for search: `messagesById(): Record<string, ChatMessage[]>` returning `{ [id]: session.messages }` for all sessions.

- [ ] **Step 4: green** — targeted then full suite + build.
- [ ] **Step 5: commit** — `feat(session): fork-from-message + ranked chat search`

---

### Task 3: `exportChat.ts` — Markdown renderer (extension repo)

**Files:**
- Create: `packages/extension/src/exportChat.ts`
- Test: `packages/extension/src/test/exportChat.test.ts`

**Interfaces:**
- Produces: `exportMarkdown(title: string, messages: ChatMessage[], now: Date): string` — `# <title>`, `_Exported <ISO date>_`, then per message `## User` / `## Assistant` (skip `system`/`tool` roles) with raw content, and for assistant messages with `sources` a trailing `Sources:` bullet list of `- <file>:L<start>-L<end>`. (`ChatMessage` has no stored reasoning — the spec's "reasoning if stored" clause resolves to omitted.)

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { exportMarkdown } from '../exportChat';

describe('exportMarkdown', () => {
  it('renders title, date, roles, and sources', () => {
    const md = exportMarkdown('My chat', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello', sources: [{ file: 'a.ts', startLine: 1, endLine: 3 }] },
      { role: 'tool', content: 'ignored' },
    ] as any, new Date('2026-07-05T12:00:00Z'));
    expect(md).toContain('# My chat');
    expect(md).toContain('2026-07-05');
    expect(md).toContain('## User\n\nhi');
    expect(md).toContain('## Assistant\n\nhello');
    expect(md).toContain('- a.ts:L1-L3');
    expect(md).not.toContain('ignored');
  });
});
```

- [ ] **Step 2: red.**
- [ ] **Step 3: implement**

```ts
import type { ChatMessage } from '@fortress-code/shared';

export function exportMarkdown(title: string, messages: ChatMessage[], now: Date): string {
  const parts: string[] = [`# ${title}`, `_Exported ${now.toISOString().slice(0, 10)}_`];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    parts.push(`## ${m.role === 'user' ? 'User' : 'Assistant'}\n\n${m.content}`);
    if (m.sources?.length) {
      parts.push('Sources:\n' + m.sources.map((s) => `- ${s.file}:L${s.startLine}-L${s.endLine}`).join('\n'));
    }
  }
  return parts.join('\n\n') + '\n';
}
```

- [ ] **Step 4: green.**
- [ ] **Step 5: commit** — `feat(export): Markdown chat export renderer`

---

### Task 4: ChatViewProvider wiring (extension repo)

**Files:**
- Modify: `packages/extension/src/chat/ChatViewProvider.ts`

**Interfaces:**
- Consumes Tasks 1-3: `Prefs`, `searchChats`, `SessionStore.fork/messagesById`, `exportMarkdown`.
- Produces the six message cases + `prefs` post, twinned verbatim by Task 8 in the mac controller.

- [ ] **Step 1: wire (no new unit harness — the provider has none; the pure logic is already tested; verify via full suite + typecheck)**

1. Field + construction: `private prefs = new Prefs(this.context.globalState);` (import from `../prefs`).
2. In `init()` after the policy post: `this.post({ type: 'prefs', prompts: this.prefs.prompts(), params: this.prefs.params() });`
3. New cases in `onMessage` (before the closing brace of the switch):

```ts
        case 'savePrompt': this.prefs.savePrompt(m.prompt); this.post({ type: 'prefs', prompts: this.prefs.prompts(), params: this.prefs.params() }); return;
        case 'deletePrompt': this.prefs.deletePrompt(String(m.id)); this.post({ type: 'prefs', prompts: this.prefs.prompts(), params: this.prefs.params() }); return;
        case 'setParams': this.prefs.setParams(m.params ?? {}); this.post({ type: 'prefs', prompts: this.prefs.prompts(), params: this.prefs.params() }); return;
        case 'forkChat': this.generating?.abort(); this.store.fork(Number(m.index)); this.post({ type: 'history', messages: this.store.active().messages }); this.postChats(); return;
        case 'searchChats': this.post({ type: 'searchResults', metas: searchChats(String(m.query ?? ''), this.store.metas(), this.store.messagesById()) }); return;
        case 'exportChat': {
          const title = this.store.metas().find((x) => x.id === this.store.activeId)?.title ?? 'Chat';
          const md = exportMarkdown(title, this.store.active().messages, new Date());
          const uri = await vscode.window.showSaveDialog({ filters: { Markdown: ['md'] }, defaultUri: vscode.Uri.file(title.replace(/[^\w-]+/g, '-') + '.md') });
          if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(md, 'utf8'));
          return;
        }
```

4. Params injection in `handleSend`, right after `target` resolves successfully:

```ts
    const params = this.prefs.params();
    if (Object.keys(params).length) target = { ...target, bodyExtra: { ...target.bodyExtra, ...params } };
```

(`target` is already `let`.)

- [ ] **Step 2: verify** — `npm test -w fortress-code` all green; `npm run build` clean.
- [ ] **Step 3: commit** — `feat(chat): wire prompts/params/export/search/fork into ChatViewProvider`

---

### Task 5: Webview UI (extension repo)

**Files:**
- Modify: `packages/extension/media/chat.html`, `chat.css`, `chat.js`

**Requirements (adapt to the real current markup — read all three files first):**

1. `chat.html` header (`#chat-head`): add, after `#new-chat`: `<button id="export-chat" title="Export chat as Markdown">Export</button> <button id="params-btn" title="Model parameters">⚙</button>`. Above/beside `#chat-picker`: `<input id="chat-search" placeholder="Search chats" />`. After the header (before `#messages`): a hidden params popover `<div id="params-pop" hidden>` with three labeled number inputs (`#p-temp` step 0.1 min 0 max 2, `#p-topp` step 0.05 min 0 max 1, `#p-maxtok` step 1 min 1) each with an empty-means-inherit convention, and an Apply button `#params-apply`. A hidden prompts manage section `<div id="prompts-mgr" hidden>` (list + `#pr-title`/`#pr-text` inputs + Save/Close buttons) toggled by `<button id="prompts-btn" title="Prompt library">Prompts</button>` in the header. A slash dropdown container `<div id="slash-menu" hidden></div>` positioned above the composer.
2. `chat.css`: styles for the popover, slash menu (absolute above `#composer`, keyboard-highlight class), prompts manager, search input — follow existing tokens (`--vscode-*`).
3. `chat.js` (additive; keep byte-identical-shareable — no frontend branches):
   - `prefs` handler: cache `window.__prefs = { prompts, params }`; fill params inputs; render the prompts manager list (DOM construction, `textContent` — never template titles into HTML).
   - `searchResults` handler: rebuild `#chat-picker` options from `m.metas` (keep the current-selection logic).
   - `#chat-search` input event: `postMessage({ type: 'searchChats', query })`; empty query → repopulate from the last `chats` message (cache it).
   - `#export-chat` click → `{ type: 'exportChat' }`. `#params-apply` → read inputs (empty string → omit key) → `{ type: 'setParams', params }`. Prompts manager Save → `{ type: 'savePrompt', prompt: { id: existingOrRandom, title, text } }`; per-item delete → `{ type: 'deletePrompt', id }` (id via `dataset`, not templated).
   - Slash menu: on `input` in `#input`, if the value starts with `/` AND the previous value was empty-or-slash-prefixed, show the menu filtered by the text after `/`; ArrowUp/Down + Enter to pick, Escape closes. Picking sets `#input.value = prompt.text`, then if a `{var}` exists, `setSelectionRange` over the first `{...}` occurrence. Guarded early bindings (`{ const _x = $('id'); if (_x) ... }`) per house style.
   - Fork button: in `renderHistory`, alongside the existing user-message `✎` button add `<button class="forkmsg" data-idx="${i}" title="Fork from here">⑂</button>` (i is a loop index — same safe pattern as `editmsg`); delegated click posts `{ type: 'forkChat', index: +el.dataset.idx }`.
4. Validate: `node --check packages/extension/media/chat.js`; `npm run build`; manual sanity deferred to Task 7's install.

- [ ] Commit — `feat(webview): prompts library UI, params popover, export, chat search, fork buttons`

---

### Task 6: KaTeX + Mermaid (extension repo)

**Files:**
- Create: `packages/extension/media/vendor/` (committed artifacts)
- Modify: `media/chat.html` (CSP + tags), `media/chat.js` (post-pass), `packages/extension/src/chat/ChatViewProvider.ts` (URL rewrite list)

**Steps:**

1. Obtain artifacts (dev-only install, then copy — do NOT add runtime deps):

```bash
npm i -D katex mermaid -w fortress-code
mkdir -p packages/extension/media/vendor/fonts
cp node_modules/katex/dist/katex.min.js packages/extension/media/vendor/
cp node_modules/katex/dist/katex.min.css packages/extension/media/vendor/
cp node_modules/katex/dist/contrib/auto-render.min.js packages/extension/media/vendor/
cp node_modules/katex/dist/fonts/*.woff2 packages/extension/media/vendor/fonts/
cp node_modules/mermaid/dist/mermaid.min.js packages/extension/media/vendor/
```

(If `mermaid/dist/mermaid.min.js` does not exist in the installed version, use the IIFE bundle the package ships — check `ls node_modules/mermaid/dist` — and note the actual file used.)

2. `chat.html`: CSP gains `font-src {cspSource};` (inside the same content attribute). Before the `vscode-shim`-independent `chat.js` tag, add:

```html
  <link rel="stylesheet" href="vendor/katex.min.css" />
  <script src="vendor/katex.min.js"></script>
  <script src="vendor/auto-render.min.js"></script>
  <script src="vendor/mermaid.min.js"></script>
```

(KEEP the existing `chat.css` link line and `chat.js` script line byte-for-byte — the Mac sync anchors on them.)

3. `ChatViewProvider.resolveWebviewView`: extend the rewrite loop list from `['chat.css', 'chat.js']` to also include `'vendor/katex.min.css'`, `'vendor/katex.min.js'`, `'vendor/auto-render.min.js'`, `'vendor/mermaid.min.js'` so the webview loads them via `asWebviewUri` (KaTeX's relative `fonts/` urls resolve against the css's webview URI automatically).
4. `chat.js` post-pass — a single function called after messages render (both `renderHistory` and stream completion):

```js
function enhanceRich(container) {
  try {
    if (window.renderMathInElement) {
      window.renderMathInElement(container, {
        delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
        throwOnError: false, trust: false,
      });
    }
    if (window.mermaid) {
      if (!window.__mermaidInit) { window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' }); window.__mermaidInit = true; }
      container.querySelectorAll('pre code').forEach((code) => {
        // adapt this selector to how renderMarkdown actually marks fenced blocks (read the function first)
        const text = code.textContent || '';
        if (!/^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|journey|timeline)\b/.test(text)) return;
        const holder = document.createElement('div');
        holder.className = 'mermaid-holder';
        code.parentElement.insertAdjacentElement('afterend', holder);
        window.mermaid.render('mm' + Math.random().toString(36).slice(2), text)
          .then(({ svg }) => { holder.innerHTML = svg; code.parentElement.hidden = true; })
          .catch(() => holder.remove()); // fail-soft: plain code block stays
      });
    }
  } catch { /* rendering extras must never break chat */ }
}
```

Requirements over the sketch: detect mermaid via the fenced language when `renderMarkdown` preserves it (read the function; prefer `class="language-mermaid"`/info-string detection over the regex heuristic if available), add a "show code" toggle on the holder, and never run `enhanceRich` on user-typed content before it is escaped (call it only on the already-escaped rendered DOM).
5. Validate: `node --check`; `npm run build`; full suite.

- [ ] Commit — `feat(webview): local KaTeX math + Mermaid diagrams (CSP-safe, fail-soft)`

---

### Task 7: Ship the extension

- [ ] Full sweep: `npm test -w @fortress-code/shared && npm test -w @fortress-code/manager && npm test -w fortress-code && npm run build`
- [ ] Bump `packages/extension/package.json` patch version; `npm run package -w fortress-code`; `code --install-extension fortress-code.vsix --force`; remove the previous installed version dir.
- [ ] Merge `feat/phase1-chat-ux` → main (--no-ff), push, delete branch.
- [ ] Manual smoke list for the user (fresh window): slash-prompt insert, params set + visible effect, export dialog, search filters chats, fork creates "Fork:" chat, a mermaid block renders, `$x^2$` renders.

---

### Task 8: Mac app — submodule bump + twin (fortress-code-mac repo)

**Files:**
- Modify: `vendor/fortress-code` (bump to the merged main commit), `scripts/sync-renderer.mjs`, `src/main/controller.ts`, `src/main/main.ts`, `test/controller.test.ts`

**Steps:**

1. `git -C vendor/fortress-code fetch && git -C vendor/fortress-code checkout <merged-main-sha>`; commit the gitlink bump.
2. `sync-renderer.mjs`: also copy the `vendor/` subdirectory of the media dir (recursive `cpSync`) into the renderer output; extend the sync test to assert `renderer/vendor/katex.min.js` exists and `chat.js` is still byte-identical.
3. `controller.ts`: twin Task 4 exactly — `Prefs` over `FileMemento(join(userDataDir,'prefs.json'))`; the six cases verbatim except `exportChat` uses a new `deps.saveFile(defaultName: string, content: string): Promise<void>` (added to `ControllerDeps`); `main.ts` implements it with `dialog.showSaveDialog` + `writeFileSync`.
4. Extend `test/controller.test.ts`: prefs post on init; savePrompt→prefs post; forkChat produces a "Fork:" chat with truncated messages; searchChats posts ranked metas; exportChat calls `deps.saveFile` with markdown containing `# `.
5. Verify: `npm test`, `npm run build`, `env -u ELECTRON_RUN_AS_NODE npm run smoke`, then `npm run dist`; bump app version to 0.2.0; push; `gh release create v0.2.0` with the DMG after the user's manual smoke.

---

## Self-Review

**Spec coverage:** prompt library (T1 storage, T5 UI), params (T1, T4 injection via bodyExtra, T5 popover), export (T3 renderer, T4 ext save, T8 mac saveFile), search (T2 ranker + accessor, T4 case, T5 UI), fork (T2, T4, T5), KaTeX/Mermaid (T6), twinning + delivery order (T8). Error handling: banner pattern inherited via the existing onMessage try/catch; fail-soft render in T6; storage validation in T1.
**Placeholders:** none — T5/T6 webview steps give concrete snippets plus explicit adapt-to-real-markup instructions (correct for a file the plan author cannot fully quote).
**Type consistency:** `Prefs`/`SavedPrompt`/`Params` names consistent across T1/T4/T5/T8; `fork(index)`/`messagesById()` consistent T2/T4/T8; `searchChats(query, metas, messagesById)` consistent T2/T4; protocol names match the spec's list everywhere.
