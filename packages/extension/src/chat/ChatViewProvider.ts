import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadPolicy, localEntries, explainBlock, type PolicyEntry, type StatusResponse } from '@fortress-code/shared';
import { DaemonClient } from '../daemon';
import { RagService } from '../rag/service';
import { Debouncer } from '../rag/watcher';
import { SessionStore } from '../sessionStore';
import { splitThink } from '../reasoning';
import { resolveTarget, type ResolvedTarget } from '../providers/target';
import { resolveDevTarget } from '../providers/dev';
import { buildInlineEditMessages, stripCodeFences } from '../inlineEdit';
import { DEV_PRESETS } from '../devPresets';
import { streamChat, type Usage } from '../providers/stream';
import { runAgentTurn } from '../agent/loop';
import { getOpenRouterKey, setOpenRouterKey, getFireworksKey, setFireworksKey } from '../secrets';
import { buildContextPreamble, parseMentions, capContent, type ChatContext, type AttachedFile } from '../context';
import { resolveInWorkspace, editFileWithApproval } from '../agent/tools';

const SYSTEM_PROMPT = 'You are Fortress Code, a helpful local coding assistant.';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private client: DaemonClient | null = null;
  private rag: RagService | null = null;
  private store: SessionStore;
  private generating: AbortController | null = null;
  private agentMode = false;
  private selected: PolicyEntry | null = null;
  private devMode = false;
  private devModel: string | null = null;
  private excluded = new Set<string>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private watcherStarted = false;
  private ragIndexing = false;

  constructor(private context: vscode.ExtensionContext, private connect: () => Promise<DaemonClient>) {
    this.store = SessionStore.load(context.workspaceState);
    this.devMode = context.globalState.get<boolean>('fortressCode.devMode', false);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    let html = readFileSync(join(this.context.extensionPath, 'media', 'chat.html'), 'utf8');
    html = html.replace(/\{cspSource\}/g, view.webview.cspSource);
    const bust = `?v=${Date.now()}`; // cache-bust so the webview never serves a stale chat.css/chat.js
    for (const f of ['chat.css', 'chat.js']) {
      html = html.replace(f, view.webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString() + bust);
    }
    view.webview.html = html;
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    void this.init();
  }

  private post(msg: unknown): void { void this.view?.webview.postMessage(msg); }
  private banner(message: string): void { this.post({ type: 'error', message: (message && message.trim()) ? message : 'Fortress Code error (no details)' }); }

  private async ensureClient(): Promise<DaemonClient> {
    if (!this.client) this.client = await this.connect();
    return this.client;
  }

  private ragService(): RagService | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;
    if (!this.rag) {
      const hash = createHash('sha256').update(root).digest('hex').slice(0, 16);
      const dir = vscode.Uri.joinPath(this.context.globalStorageUri, 'rag', hash).fsPath;
      this.rag = new RagService(dir, 768, root);
      if (this.rag.hasIndex()) this.startRagWatcher();
    }
    return this.rag;
  }

  private async init(): Promise<void> {
    try {
      this.client = await this.connect();
      this.post({ type: 'policy', local: localEntries(), openrouter: loadPolicy().filter((e) => e.provider === 'openrouter') });
      this.post({ type: 'openRouterKeySet', set: !!(await getOpenRouterKey(this.context.secrets)) });
      await this.postDev();
      this.post({ type: 'history', messages: this.store.active().messages });
      this.postChats();
      this.poller = setInterval(() => void this.pushStatus(), 2000);
      this.context.subscriptions.push({ dispose: () => this.poller && clearInterval(this.poller) });
      await this.pushStatus();
      const refresh = () => void this.postChips();
      this.context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(refresh),
        vscode.window.onDidChangeTextEditorSelection(refresh),
      );
      await this.postChips();
    } catch (e) {
      this.banner(`Could not start the Fortress Code daemon: ${e}`);
    }
  }

  setDevMode(on: boolean): void {
    this.devMode = on;
    if (!on) this.devModel = null;
    void this.postDev();
  }

  private async postDev(): Promise<void> {
    this.post({ type: 'devMode', on: this.devMode, presets: DEV_PRESETS, fireworksKeySet: !!(await getFireworksKey(this.context.secrets)) });
  }

  private postChats(): void {
    this.post({ type: 'chats', metas: this.store.metas(), activeId: this.store.activeId });
  }

  private postContextWindow(): void {
    let tokens = 8192;
    if (this.selected?.provider === 'openrouter') tokens = this.selected.openrouter?.contextLength ?? 8192;
    this.post({ type: 'contextWindow', tokens });
  }

  private async regenerate(): Promise<void> {
    const msgs = this.store.active().messages;
    while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop();
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'user') return;
    const text = last.content;
    msgs.pop(); // handleSend re-adds it
    this.store.save();
    this.post({ type: 'history', messages: msgs });
    await this.handleSend(text);
  }

  private async collectContext(userText: string): Promise<ChatContext> {
    const ed = vscode.window.activeTextEditor;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const diagsFor = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).map((d) =>
      `${d.range.start.line + 1}:${d.range.start.character + 1} ${vscode.DiagnosticSeverity[d.severity].toLowerCase()} ${d.message}`);
    let file: AttachedFile | null = null;
    let selection: ChatContext['selection'] = null;
    if (ed) {
      const doc = ed.document;
      const relPath = vscode.workspace.asRelativePath(doc.fileName);
      const fileId = 'file:' + relPath;
      if (!this.excluded.has(fileId)) {
        const cap = capContent(doc.getText());
        file = { id: fileId, relPath, language: doc.languageId, content: cap.content, truncated: cap.truncated, diagnostics: diagsFor(doc.uri) };
      }
      if (!ed.selection.isEmpty) {
        const selId = 'sel:' + relPath;
        if (!this.excluded.has(selId)) {
          selection = { id: selId, relPath, startLine: ed.selection.start.line + 1, endLine: ed.selection.end.line + 1, text: doc.getText(ed.selection) };
        }
      }
    }
    const mentions: AttachedFile[] = [];
    if (root) for (const mrel of parseMentions(userText)) {
      if (mrel === 'codebase') continue;
      const mid = 'mention:' + mrel;
      if (this.excluded.has(mid)) continue;
      try {
        const abs = resolveInWorkspace(root, mrel);
        const cap = capContent(readFileSync(abs, 'utf8'));
        mentions.push({ id: mid, relPath: mrel, language: mrel.split('.').pop() ?? '', content: cap.content, truncated: cap.truncated, diagnostics: [] });
      } catch { /* skip unreadable/escaping mention */ }
    }
    let codebase: ChatContext['codebase'] = null;
    const rag = this.ragService();
    if (rag && parseMentions(userText).includes('codebase') && this.client) {
      try { codebase = await rag.retrieveHits(this.client, userText); }
      catch (e) { this.banner(`@codebase retrieval failed: ${e instanceof Error ? e.message : e}`); }
    }
    return { file, selection, mentions, codebase };
  }

  private async postChips(): Promise<void> {
    const ctx = await this.collectContext('');
    const chips: { id: string; label: string; kind: string }[] = [];
    if (ctx.file) chips.push({ id: ctx.file.id, label: '📄 ' + ctx.file.relPath, kind: 'file' });
    if (ctx.selection) chips.push({ id: ctx.selection.id, label: `✂ ${ctx.selection.relPath} L${ctx.selection.startLine}-${ctx.selection.endLine}`, kind: 'sel' });
    this.post({ type: 'context', chips });
  }

  private async pushStatus(): Promise<void> {
    if (!this.client) return;
    try {
      const status: StatusResponse = await this.client.status();
      this.post({ type: 'state', status, selectedId: this.selected?.id ?? null });
      const rag = this.ragService();
      if (rag) this.post({ type: 'ragStatus', stats: rag.stats(), indexing: this.ragIndexing });
    } catch {
      this.client = null; // daemon idle-exited; next action re-spawns
    }
  }

  private startRagWatcher(): void {
    if (this.watcherStarted) return;
    const rag = this.ragService();
    if (!rag) return;
    this.watcherStarted = true;
    const debouncer = new Debouncer(1000, async () => {
      if (!this.client) return;
      if (this.ragIndexing) return;
      this.ragIndexing = true;
      try {
        await rag.index(this.client, (p) => this.post({ type: 'ragProgress', progress: p }));
        this.post({ type: 'ragStatus', stats: rag.stats(), indexing: false });
      } catch { /* transient; next save retries */ }
      finally { this.ragIndexing = false; }
    });
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const touch = (uri: vscode.Uri) => debouncer.add(uri.fsPath);
    watcher.onDidChange(touch); watcher.onDidCreate(touch); watcher.onDidDelete(touch);
    this.context.subscriptions.push(watcher);
  }

  private async onMessage(m: any): Promise<void> {
    try {
      switch (m.type) {
        case 'send': return await this.handleSend(String(m.text));
        case 'cancel': this.generating?.abort(); return;
        case 'newChat': this.generating?.abort(); this.store.newChat(); this.post({ type: 'history', messages: [] }); this.postChats(); return;
        case 'switchChat': this.generating?.abort(); this.store.switchTo(String(m.id)); this.post({ type: 'history', messages: this.store.active().messages }); this.postChats(); return;
        case 'regenerate': return await this.regenerate();
        case 'editLoad': {
          const msgs = this.store.active().messages;
          const um = msgs[Number(m.index)];
          if (um && um.role === 'user') { msgs.length = Number(m.index); this.store.save(); this.post({ type: 'history', messages: msgs }); this.post({ type: 'restoreInput', text: um.content }); }
          return;
        }
        case 'agentToggle': this.agentMode = !!m.on; return;
        case 'selectModel': return await this.selectModel(String(m.id));
        case 'addModel': return this.handleAddModel(String(m.slug));
        case 'setOpenRouterKey': await setOpenRouterKey(this.context.secrets, String(m.key)); this.post({ type: 'openRouterKeySet', set: true }); return;
        case 'setFireworksKey': await setFireworksKey(this.context.secrets, String(m.key)); await this.postDev(); return;
        case 'selectDevModel': this.devModel = String(m.slug) || null; this.selected = null; this.postContextWindow(); return;
        case 'downloadModel': await (await this.ensureClient()).download(String(m.catalogId)); return;
        case 'indexWorkspace': {
          if (this.ragIndexing) return;
          this.ragIndexing = true;
          let rag: RagService | null = null;
          try {
            rag = this.ragService();
            if (!rag) { this.banner('Open a folder to index a codebase.'); return; }
            const client = await this.ensureClient();
            this.post({ type: 'ragProgress', progress: { filesDone: 0, filesTotal: 0, chunksDone: 0, capped: false } });
            await rag.index(client, (p) => this.post({ type: 'ragProgress', progress: p }));
            this.post({ type: 'ragStatus', stats: rag.stats(), indexing: false });
            this.startRagWatcher();
          } catch (e) {
            this.banner(`Indexing failed: ${e instanceof Error ? e.message : e}`);
            if (rag) this.post({ type: 'ragStatus', stats: rag.stats(), indexing: false });
          } finally {
            this.ragIndexing = false;
          }
          return;
        }
        case 'installBinary': await (await this.ensureClient()).installBinary(); return;
        case 'killForeign': await (await this.ensureClient()).foreignKill(m.pids); return;
        case 'excludeContext': this.excluded.add(String(m.id)); void this.postChips(); return;
        case 'insertCode': {
          const ed = vscode.window.activeTextEditor;
          if (!ed) { this.banner('Open a file to insert into.'); return; }
          await ed.edit((b) => b.insert(ed.selection.active, String(m.code)));
          return;
        }
        case 'applyCode': {
          const ed = vscode.window.activeTextEditor;
          if (!ed) { this.banner('Open a file to apply into.'); return; }
          const rel = vscode.workspace.asRelativePath(ed.document.fileName);
          const next = ed.selection.isEmpty
            ? String(m.code)
            : ed.document.getText().slice(0, ed.document.offsetAt(ed.selection.start)) + String(m.code) + ed.document.getText().slice(ed.document.offsetAt(ed.selection.end));
          await editFileWithApproval(ed.document.fileName, next, rel);
          return;
        }
        case 'openSource': {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (!root) { this.banner('Open a folder to jump to a source.'); return; }
          try {
            const abs = resolveInWorkspace(root, String(m.file));
            const doc = await vscode.workspace.openTextDocument(abs);
            const editor = await vscode.window.showTextDocument(doc);
            const startLine = Math.max(0, Number(m.startLine) - 1);
            const endLine = Math.min(Math.max(startLine, Number(m.endLine) - 1), doc.lineCount - 1);
            const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          } catch (e) {
            this.banner(`Could not open ${String(m.file)}: ${e instanceof Error ? e.message : e}`);
          }
          return;
        }
      }
    } catch (e) {
      this.banner(String(e));
    }
  }

  private async selectModel(id: string): Promise<void> {
    const entry = loadPolicy().find((e) => e.id === id);
    if (!entry) return;
    this.selected = entry;
    this.devModel = null; // picking a governed model takes over from any dev-model routing
    if (entry.provider === 'local') {
      if (!this.client) this.client = await this.connect();
      try {
        const r = await this.client.start(entry.local!.catalogId);
        if (!r.ok) this.post({ type: 'startRejected', rejection: r.rejection, modelId: id });
      } catch (e) {
        const msg = String(e);
        if (msg.includes('428')) this.banner('This model needs to be downloaded first — click it to download.');
        else this.banner(msg);
      }
    }
    await this.pushStatus();
    this.postContextWindow();
  }

  private handleAddModel(slug: string): void {
    const reason = explainBlock(slug);
    if (reason) { this.post({ type: 'addBlocked', slug, reason }); return; }
    // Approved slug: it is already in the registry; surface it as selectable.
    this.post({ type: 'addAccepted', slug });
  }

  private static ACTION_PROMPTS: Record<string, string> = {
    explain: 'Explain what this code does, clearly and concisely.',
    fix: 'Find and fix bugs in this code. Return the corrected code.',
    test: 'Write unit tests for this code.',
    refactor: 'Refactor this code for clarity and quality without changing behavior.',
    doc: 'Add clear doc comments to this code.',
  };

  runSelectionAction(kind: string): void {
    const prompt = ChatViewProvider.ACTION_PROMPTS[kind];
    if (prompt) void this.handleSend(prompt);
  }

  private async targetDeps() {
    const status = this.client ? await this.client.status().catch(() => null) : null;
    return {
      localEndpoint: status?.endpoint ?? undefined,
      openRouterKey: await getOpenRouterKey(this.context.secrets),
    };
  }

  private async currentTarget(): Promise<ResolvedTarget> {
    if (this.devMode && this.devModel) {
      const key = await getFireworksKey(this.context.secrets);
      return resolveDevTarget(this.devModel, key ?? '');
    }
    if (this.selected) {
      if (!this.client) this.client = await this.connect();
      return resolveTarget(this.selected, await this.targetDeps());
    }
    throw new Error('Pick a model first.');
  }

  async inlineEdit(code: string, instruction: string, language: string, signal: AbortSignal): Promise<string> {
    const target = await this.currentTarget();
    const r = await streamChat(target, buildInlineEditMessages(code, instruction, language), () => {}, signal);
    return stripCodeFences(r.content);
  }

  private async handleSend(text: string): Promise<void> {
    if (this.generating) { this.banner('Still generating — press Stop first.'); this.post({ type: 'restoreInput', text }); return; }
    let target;
    try {
      target = await this.currentTarget();
    } catch (e) {
      this.banner(String(e instanceof Error ? e.message : e));
      this.post({ type: 'restoreInput', text });
      return;
    }
    const session = this.store.active();
    const ctx = await this.collectContext(text);
    const preamble = buildContextPreamble(ctx);
    const sys = SYSTEM_PROMPT + (preamble ? '\n\n---\n' + preamble : '');
    const preTurnLen = session.messages.length;
    session.addUser(text);
    this.post({ type: 'history', messages: session.messages });
    this.generating = new AbortController();
    let usage: Usage | null = null;
    try {
      if (this.agentMode) {
        await runAgentTurn(target, session, sys, (step) => this.post({ type: 'agentStep', step }), this.generating.signal);
      } else {
        const r = await streamChat(target, session.toRequestMessages(sys),
          (t) => this.post({ type: 'token', text: t }), this.generating.signal,
          (t) => this.post({ type: 'reasoning', text: t }));
        session.addAssistant(splitThink(r.content).content || '(no reply)');
        if (ctx.codebase && ctx.codebase.length) {
          const last = session.messages[session.messages.length - 1];
          last.sources = ctx.codebase.map(({ file, startLine, endLine }) => ({ file, startLine, endLine }));
        }
        this.post({ type: 'reasoningDone' });
        usage = r.usage;
      }
      this.store.touchTitle();
      this.store.save();
      this.post({ type: 'history', messages: session.messages });
      this.postChats();
      if (usage) this.post({ type: 'usage', usage });
    } catch (e) {
      session.messages.length = preTurnLen; // error hygiene: remove user msg + any tool exchange from the failed turn
      this.store.save();
      this.post({ type: 'history', messages: session.messages });
      this.post({ type: 'restoreInput', text });
      this.banner(String(e instanceof Error ? e.message : e));
    } finally {
      this.generating = null;
    }
  }
}
