import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadPolicy, visibleLocalEntries, hiddenLocalEntries, googleEntries, explainBlock, formatPolicyFatal, type PolicyEntry, type StatusResponse } from '@fortress-chat/shared';
import { DaemonClient } from '../daemon';
import { RagService } from '../rag/service';
import { Debouncer } from '../rag/watcher';
import { SessionStore } from '../sessionStore';
import { Session } from './session';
import { splitThink } from '../reasoning';
import { resolveTarget, type ResolvedTarget } from '../providers/target';
import { resolveDevTarget } from '../providers/dev';
import { buildInlineEditMessages, stripCodeFences } from '../inlineEdit';
import { DEV_PRESETS } from '../devPresets';
import { streamChat, type Usage } from '../providers/stream';
import { runAgentTurn } from '../agent/loop';
import { getOpenRouterKey, setOpenRouterKey, getFireworksKey, setFireworksKey, getGoogleKey, setGoogleKey } from '../secrets';
import { buildContextPreamble, parseMentions, capContent, type ChatContext, type AttachedFile } from '../context';
import { resolveInWorkspace, editFileWithApproval } from '../agent/tools';
import { Prefs } from '../prefs';
import { searchChats } from '../chatSearch';
import { exportMarkdown } from '../exportChat';
import { MemoryStore } from '../memory';
import { DocsService } from '../docsService';
import { McpClient, parseMcpConfigs } from '../mcpClient';
import { webSearch } from '../webSearch';
import { speakText } from '../voice';
import { loadProjectRules, defaultRulesRel } from '../projectRules';
import { AgentCheckpoint } from '../agentCheckpoint';
import { mentionCandidates } from '../mentionFiles';
import { discoverSkills, type Skill } from '../skills';

const SYSTEM_PROMPT = 'You are FortressChat, a helpful local coding assistant.';

const MODE_PROMPTS: Record<string, string> = {
  plan: 'You are in plan mode. Outline a clear step-by-step plan before editing files. Discuss tradeoffs and wait for confirmation before applying changes unless the user asked you to implement immediately.',
  debug: 'You are in debug mode. Focus on reproducing the issue, tracing root cause, and proposing minimal targeted fixes.',
};

type ChatMode = 'ask' | 'agent' | 'plan' | 'debug' | 'multitask';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private webviews = new Set<vscode.Webview>();
  private initialized = false;
  private client: DaemonClient | null = null;
  private rag: RagService | null = null;
  private docs: DocsService | null = null;
  private mcpClients: McpClient[] = [];
  private mcpTools: object[] = [];
  private pendingImages: { mime: string; base64: string; name: string }[] = [];
  private compareModelId: string | null = null;
  private store: SessionStore;
  private generating: AbortController | null = null;
  private promptQueue: string[] = [];
  private agentMode = false;
  private chatMode: ChatMode = 'ask';
  private selected: PolicyEntry | null = null;
  private devMode = false;
  private devModel: string | null = null;
  private excluded = new Set<string>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private watcherStarted = false;
  private ragIndexing = false;
  private lastCheckpoint: AgentCheckpoint | null = null;
  private prefs: Prefs;
  private skills: Skill[] = [];
  private testPosts: unknown[] = [];
  private mediaWatcherStarted = false;
  private policyStopped = false;
  private mediaReloadDebouncer: Debouncer | null = null;

  constructor(private context: vscode.ExtensionContext, private connect: () => Promise<DaemonClient>) {
    this.store = SessionStore.load(context.workspaceState);
    void context.globalState.update('fortressChat.devMode', false);
    void context.globalState.update('fortressCode.devMode', undefined);
    this.devMode = false;
    this.prefs = new Prefs(this.context.globalState);
    this.startMediaWatcher();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.buildHtml(view.webview);
    this.attachWebview(view.webview);
    view.onDidDispose(() => this.detachWebview(view.webview));
    void this.ensureReady();
  }

  /** Snapshot of webview wiring for E2E tests (FORTRESS_CODE_TEST=1). */
  getTestState(): Record<string, unknown> {
    const types = this.testPosts.map((m) => (m as { type?: string }).type).filter(Boolean) as string[];
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return {
      webviewCount: this.webviews.size,
      initialized: this.initialized,
      postedTypes: [...new Set(types)],
      hasPolicy: types.includes('policy'),
      hasError: types.includes('error'),
      hasProjectRules: types.includes('projectRules'),
      chatMode: this.chatMode,
      projectRulesPath: loadProjectRules(root).path ?? defaultRulesRel(root),
    };
  }

  /** Reload chat HTML/CSS/JS in all open webviews (dev hot reload). */
  async reloadWebviews(): Promise<void> {
    for (const wv of [...this.webviews]) {
      wv.html = this.buildHtml(wv);
      await this.syncWebview(wv);
    }
  }

  /** Reload MCP server connections and tool schemas. */
  async reloadMcpServers(): Promise<void> {
    await this.initMcp();
  }

  /** Rescan SKILL.md directories. */
  reloadSkillsList(): void {
    this.refreshSkills();
  }

  /** Open the chat UI in an editor tab (alongside the sidebar panel). */
  async openInEditor(): Promise<void> {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'fortressChat.chatPanel',
      'FortressChat',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
    );
    panel.webview.html = this.buildHtml(panel.webview);
    this.attachWebview(panel.webview);
    panel.onDidDispose(() => this.detachWebview(panel.webview));
    this.context.subscriptions.push(panel);
    await this.ensureReady();
    await this.syncWebview(panel.webview);
  }

  private buildHtml(webview: vscode.Webview): string {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    let html = readFileSync(join(this.context.extensionPath, 'media', 'chat.html'), 'utf8');
    html = html.replace(/\{cspSource\}/g, webview.cspSource);
    const bust = `?v=${Date.now()}`;
    for (const f of ['chat.css', 'chat.js', 'vendor/katex.min.css', 'vendor/katex.min.js', 'vendor/auto-render.min.js', 'vendor/mermaid.min.js']) {
      html = html.replace(f, webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString() + bust);
    }
    return html;
  }

  /** Watch media/ in dev and hot-reload webviews when HTML/CSS/JS change. */
  private startMediaWatcher(): void {
    if (this.mediaWatcherStarted) return;
    if (this.context.extensionMode !== vscode.ExtensionMode.Development) return;
    this.mediaWatcherStarted = true;
    const pattern = new vscode.RelativePattern(this.context.extensionUri, 'media/**');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.mediaReloadDebouncer = new Debouncer(300, () => void this.reloadWebviews());
    watcher.onDidChange((uri) => this.mediaReloadDebouncer!.add(uri.fsPath));
    watcher.onDidCreate((uri) => this.mediaReloadDebouncer!.add(uri.fsPath));
    this.context.subscriptions.push(watcher);
  }

  private trackPost(msg: unknown): void {
    if (process.env.FORTRESS_CODE_TEST === '1') this.testPosts.push(msg);
  }

  private deliver(msg: unknown, target?: vscode.Webview): void {
    this.trackPost(msg);
    if (target) void target.postMessage(msg);
    else for (const wv of this.webviews) void wv.postMessage(msg);
  }

  private attachWebview(webview: vscode.Webview): void {
    this.webviews.add(webview);
    webview.onDidReceiveMessage((m) => this.onMessage(m));
  }

  private detachWebview(webview: vscode.Webview): void {
    this.webviews.delete(webview);
  }

  private async ensureReady(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.init();
  }

  private post(msg: unknown): void {
    this.deliver(msg);
  }
  private banner(message: string): void { this.post({ type: 'error', message: (message && message.trim()) ? message : 'FortressChat error (no details)' }); }

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

  private docsService(): DocsService {
    if (!this.docs) {
      const dir = vscode.Uri.joinPath(this.context.globalStorageUri, 'docs-index').fsPath;
      this.docs = new DocsService(dir);
    }
    return this.docs;
  }

  private memoryPath(): string {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'memory.json').fsPath;
  }

  private memoryData(): ReturnType<MemoryStore['load']> {
    return new MemoryStore(this.memoryPath()).load();
  }

  /** Build system prompt from skill, persona, memory, project rules, and defaults. */
  private systemPromptForChat(): string {
    const meta = this.store.metas().find((m) => m.id === this.store.activeId);
    const persona = meta?.personaId ? this.prefs.personas().find((p) => p.id === meta.personaId) : undefined;
    const skill = meta?.skillId ? this.skills.find((s) => s.id === meta.skillId) : undefined;
    const mem = MemoryStore.preamble(this.memoryData());
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const rules = loadProjectRules(root).text;
    let base = persona?.systemPrompt?.trim() || SYSTEM_PROMPT;
    if (skill?.body.trim()) base = `${base}\n\n[skill: ${skill.name}]\n${skill.body.trim()}`;
    const modeHint = MODE_PROMPTS[this.chatMode] ?? '';
    const parts = [base, mem, rules, modeHint].filter(Boolean);
    return parts.join('\n\n');
  }

  private skillDirectories(): string[] {
    const raw = vscode.workspace.getConfiguration('fortressChat').get<string[]>('skillDirectories');
    return Array.isArray(raw) ? raw.filter((d) => typeof d === 'string') : [];
  }

  /** Rescan SKILL.md files from configured directories. */
  private refreshSkills(): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.skills = discoverSkills(this.skillDirectories(), root);
    this.post({ type: 'skills', skills: this.skills });
  }

  private startSkillsWatcher(): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const pattern = new vscode.RelativePattern(vscode.Uri.file(root), '.fortress/skills/**');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const debouncer = new Debouncer(500, () => this.refreshSkills());
    watcher.onDidChange((u) => debouncer.add(u.fsPath));
    watcher.onDidCreate((u) => debouncer.add(u.fsPath));
    watcher.onDidDelete((u) => debouncer.add(u.fsPath));
    this.context.subscriptions.push(watcher);
  }

  private postMcpStatus(): void {
    this.postMcpStatusTarget();
  }

  private postMcpStatusTarget(emit?: (msg: unknown) => void): void {
    const msg = {
      type: 'mcpStatus',
      servers: this.mcpClients.map((c) => ({
        name: c.serverName(),
        connected: c.isConnected(),
        tools: c.toolCount(),
        error: c.error(),
      })),
    };
    if (emit) emit(msg);
    else this.post(msg);
  }

  private postChatMode(): void {
    const agentCapable = this.devMode && this.devModel ? true : !!this.selected?.agentCapable;
    this.post({ type: 'chatMode', mode: this.chatMode, agentOn: this.agentMode, compareId: this.compareModelId, agentCapable });
  }

  /** Restore agent toggle from the active chat's persisted meta (init + switch). */
  private restoreAgentModeFromActiveChat(): void {
    const meta = this.store.metas().find((c) => c.id === this.store.activeId);
    this.agentMode = !!meta?.agentMode;
    this.chatMode = this.agentMode ? 'agent' : 'ask';
  }

  private toolExtras(checkpoint?: AgentCheckpoint) {
    const memPath = this.memoryPath();
    return {
      webSearch: (q: string) => webSearch(q),
      remember: (fact: string) => {
        const store = new MemoryStore(memPath);
        const data = store.load();
        data.enabled = true;
        if (fact.trim() && !data.facts.includes(fact.trim())) data.facts.push(fact.trim());
        store.save(data);
        this.post({ type: 'memory', data });
        return 'saved to local memory';
      },
      mcpCall: async (name: string, args: Record<string, unknown>) => {
        for (const c of this.mcpClients) {
          try { return await c.callTool(name, args); } catch { continue; }
        }
        return 'mcp tool not found';
      },
      onFileTouch: checkpoint ? (rel: string, abs: string) => checkpoint.capture(rel, abs) : undefined,
      onFileRevertCapture: checkpoint ? (rel: string) => checkpoint.revert(rel) : undefined,
    };
  }

  private postAgentUndo(): void {
    this.post({ type: 'agentUndo', available: !!(this.lastCheckpoint && this.lastCheckpoint.hasChanges()) });
  }

  private async initMcp(): Promise<void> {
    const cfgs = parseMcpConfigs(vscode.workspace.getConfiguration('fortressChat').get('mcpServers'));
    for (const c of this.mcpClients) c.dispose();
    this.mcpClients = cfgs.map((cfg) => new McpClient(cfg));
    this.mcpTools = [];
    for (const client of this.mcpClients) {
      try {
        await client.connect();
        this.mcpTools.push(...client.openAiSchemas());
      } catch { /* error stored on client */ }
    }
    this.postMcpStatus();
  }

  private async init(): Promise<void> {
    try {
      this.sanitizeLocalUsOnly();
      try {
        this.client = await this.connect();
      } catch (e) {
        if (!(await getGoogleKey(this.context.secrets))) {
          this.initialized = false;
          this.banner(`Could not start the FortressChat daemon: ${e}`);
          return;
        }
      }
      this.poller = setInterval(() => void this.pushStatus(), 2000);
      this.context.subscriptions.push({ dispose: () => this.poller && clearInterval(this.poller) });
      const refresh = () => void this.postChips();
      this.context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(refresh),
        vscode.window.onDidChangeTextEditorSelection(refresh),
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (e.affectsConfiguration('fortressChat.mcpServers')) void this.initMcp();
          if (e.affectsConfiguration('fortressChat.skillDirectories')) this.refreshSkills();
        }),
      );
      this.refreshSkills();
      this.startSkillsWatcher();
      await this.initMcp();
      await this.pushFullState();
      await this.postChips();
    } catch (e) {
      this.initialized = false;
      this.banner(`Could not start the FortressChat daemon: ${e}`);
    }
  }

  /** Push current UI state to one webview or all connected webviews. */
  private async pushFullState(target?: vscode.Webview): Promise<void> {
    const emit = (msg: unknown) => this.deliver(msg, target);
    emit({ type: 'policy', local: visibleLocalEntries(), hidden: hiddenLocalEntries(), google: googleEntries(), openrouter: [] });
    emit({ type: 'prefs', prompts: this.prefs.prompts(), params: this.prefs.params() });
    emit({ type: 'personas', personas: this.prefs.personas() });
    emit({ type: 'skills', skills: this.skills });
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    emit({ type: 'projectRules', path: loadProjectRules(root).path ?? defaultRulesRel(root) });
    emit({ type: 'memory', data: this.memoryData() });
    emit({ type: 'folders', folders: this.store.listFolders() });
    emit({ type: 'docsStatus', stats: this.docsService().stats() });
    this.postMcpStatusTarget(emit);
    emit({ type: 'openRouterKeySet', set: !!(await getOpenRouterKey(this.context.secrets)) });
    emit({ type: 'googleKeySet', set: !!(await getGoogleKey(this.context.secrets)) });
    await this.postDevTarget(emit);
    emit({ type: 'history', messages: this.store.active().messages });
    this.postChatsTarget(emit);
    await this.pushStatusTarget(emit);
    this.postAgentUndoTarget(emit);
    this.restoreAgentModeFromActiveChat();
    this.postChatModeTarget(emit);
    emit({ type: 'queue', items: [...this.promptQueue] });
    emit({ type: 'generating', active: !!this.generating });
  }

  private async syncWebview(webview: vscode.Webview): Promise<void> {
    await this.pushFullState(webview);
    await this.postChipsTarget(webview);
  }

  private postChatsTarget(emit: (msg: unknown) => void): void {
    emit({ type: 'chats', metas: this.store.metas(), activeId: this.store.activeId });
  }

  private postAgentUndoTarget(emit: (msg: unknown) => void): void {
    emit({ type: 'agentUndo', available: !!(this.lastCheckpoint && this.lastCheckpoint.hasChanges()) });
  }

  private postChatModeTarget(emit: (msg: unknown) => void): void {
    const agentCapable = this.devMode && this.devModel ? true : !!this.selected?.agentCapable;
    emit({ type: 'chatMode', mode: this.chatMode, agentOn: this.agentMode, compareId: this.compareModelId, agentCapable });
  }

  private async postDevTarget(emit: (msg: unknown) => void): Promise<void> {
    emit({ type: 'devMode', on: this.devMode, presets: DEV_PRESETS, fireworksKeySet: !!(await getFireworksKey(this.context.secrets)) });
  }

  private async pushStatusTarget(emit: (msg: unknown) => void): Promise<void> {
    if (!this.client) return;
    try {
      const status: StatusResponse = await this.client.status();
      emit({ type: 'state', status, selectedId: this.selected?.id ?? null });
      const rag = this.ragService();
      if (rag) emit({ type: 'ragStatus', stats: rag.stats(), indexing: this.ragIndexing });
    } catch {
      this.client = null;
    }
  }

  private async postChipsTarget(webview: vscode.Webview): Promise<void> {
    const ctx = await this.collectContext('');
    const chips: { id: string; label: string; kind: string }[] = [];
    if (ctx.file) chips.push({ id: ctx.file.id, label: '📄 ' + ctx.file.relPath, kind: 'file' });
    if (ctx.selection) chips.push({ id: ctx.selection.id, label: `✂ ${ctx.selection.relPath} L${ctx.selection.startLine}-${ctx.selection.endLine}`, kind: 'sel' });
    void webview.postMessage({ type: 'context', chips });
  }

  setDevMode(on: boolean): void {
    if (on) {
      void this.stopForPolicyViolation('Developer mode and cloud models are not allowed.');
      return;
    }
    this.devMode = false;
    this.devModel = null;
    void this.context.globalState.update('fortressChat.devMode', false);
    void this.postDev();
  }

  /** Stop FortressChat after a local-US-only policy violation. */
  private stopForPolicyViolation(reason: string, slug?: string): void {
    if (this.policyStopped) return;
    this.policyStopped = true;
    const message = formatPolicyFatal(reason, slug);
    this.post({ type: 'policyFatal', message });
    void vscode.window.showErrorMessage(message.replace(/\n\n/g, ' '), { modal: true });
  }

  /** Clear cloud/dev routing left over from before local-US-only enforcement. */
  private sanitizeLocalUsOnly(): void {
    if (this.devMode || this.devModel) {
      this.devMode = false;
      this.devModel = null;
      void this.context.globalState.update('fortressChat.devMode', false);
    }
    if (this.selected?.provider !== 'local' && this.selected?.provider !== 'google') this.selected = null;
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
    else if (this.selected?.provider === 'google') tokens = this.selected.google?.contextLength ?? 8192;
    this.post({ type: 'contextWindow', tokens });
  }

  private postQueue(): void {
    this.post({ type: 'queue', items: [...this.promptQueue] });
  }

  private postGenerating(active: boolean): void {
    this.post({ type: 'generating', active });
  }

  private clearPromptQueue(): void {
    this.promptQueue = [];
    this.postQueue();
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
      if (mrel === 'codebase' || mrel === 'docs') continue;
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
    let embedSwap = false;
    if (rag && parseMentions(userText).includes('codebase') && this.client) {
      try { codebase = await rag.retrieveHits(this.client, userText); embedSwap = true; }
      catch (e) { this.banner(`@codebase retrieval failed: ${e instanceof Error ? e.message : e}`); }
    }
    let docs: ChatContext['docs'] = null;
    if (parseMentions(userText).includes('docs')) {
      if (!this.docsService().hasIndex()) {
        this.banner('No documents indexed yet — use Settings → Documents → Add documents.');
      } else if (this.client) {
        try { docs = await this.docsService().retrieveHits(this.client, userText); embedSwap = true; }
        catch (e) { this.banner(`@docs retrieval failed: ${e instanceof Error ? e.message : e}`); }
      }
    }
    if (embedSwap) await this.restartLocalIfSelected();
    const images = this.pendingImages.length ? [...this.pendingImages] : undefined;
    this.pendingImages = [];
    return { file, selection, mentions, codebase, docs, images };
  }

  private async postChips(): Promise<void> {
    const ctx = await this.collectContext('');
    const chips: { id: string; label: string; kind: string }[] = [];
    if (ctx.file) chips.push({ id: ctx.file.id, label: '📄 ' + ctx.file.relPath, kind: 'file' });
    if (ctx.selection) chips.push({ id: ctx.selection.id, label: `✂ ${ctx.selection.relPath} L${ctx.selection.startLine}-${ctx.selection.endLine}`, kind: 'sel' });
    this.post({ type: 'context', chips });
  }

  /** Unload the local chat llama-server when switching to cloud or dev routing. */
  private async unloadLocalModel(): Promise<void> {
    if (!this.client) return;
    try {
      const status = await this.client.status();
      if (status.state === 'ready' || status.state === 'loading-model' || status.state === 'starting') {
        await this.client.stop();
      }
    } catch { /* daemon gone */ }
  }

  /** Reload the selected local chat model after a temporary embed swap. */
  private async restartLocalIfSelected(): Promise<void> {
    if (this.selected?.provider !== 'local' || !this.client) return;
    try {
      const r = await this.client.start(this.selected.local!.catalogId);
      if (!r.ok) this.post({ type: 'startRejected', rejection: r.rejection, modelId: this.selected.id });
    } catch (e) {
      this.banner(String(e));
    }
    await this.pushStatus();
  }

  private cloudFallbackStatus(): StatusResponse {
    return {
      state: 'idle',
      modelId: null,
      endpoint: null,
      download: null,
      crashLog: null,
      ram: { totalBytes: 0, availableBytes: 0 },
      binaryInstalled: false,
      downloadedModelIds: [],
      downloadError: null,
      embed: { state: 'idle', modelId: null, endpoint: null },
    };
  }

  private async pushStatus(): Promise<void> {
    if (!this.client) {
      this.post({ type: 'state', status: this.cloudFallbackStatus(), selectedId: this.selected?.id ?? null });
      return;
    }
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
      finally {
        this.ragIndexing = false;
        await this.restartLocalIfSelected();
      }
    });
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const touch = (uri: vscode.Uri) => debouncer.add(uri.fsPath);
    watcher.onDidChange(touch); watcher.onDidCreate(touch); watcher.onDidDelete(touch);
    this.context.subscriptions.push(watcher);
  }

  private async onMessage(m: any): Promise<void> {
    if (this.policyStopped) return;
    try {
      switch (m.type) {
        case 'openChatInEditor': return await this.openInEditor();
        case 'send': return await this.handleSend(String(m.text));
        case 'removeQueued': {
          const i = Number(m.index);
          if (Number.isInteger(i) && i >= 0 && i < this.promptQueue.length) {
            this.promptQueue.splice(i, 1);
            this.postQueue();
          }
          return;
        }
        case 'cancel': this.generating?.abort(); return;
        case 'newChat': {
          this.generating?.abort(); this.clearPromptQueue();
          const agent = !!m.agent;
          this.store.newChat(agent);
          this.agentMode = agent; this.chatMode = agent ? 'agent' : 'ask';
          this.post({ type: 'history', messages: [] });
          this.postChatMode(); this.postChats();
          return;
        }
        case 'switchChat': {
          this.generating?.abort(); this.clearPromptQueue();
          this.store.switchTo(String(m.id));
          this.restoreAgentModeFromActiveChat();
          this.post({ type: 'history', messages: this.store.active().messages });
          this.postChatMode(); this.postChats();
          return;
        }
        case 'deleteChat': {
          const id = String(m.id);
          this.generating?.abort();
          this.store.deleteChat(id);
          this.restoreAgentModeFromActiveChat();
          this.post({ type: 'history', messages: this.store.active().messages });
          this.postChatMode(); this.postChats();
          return;
        }
        case 'renameChat': {
          this.store.renameChat(String(m.id), String(m.title ?? ''));
          this.postChats();
          return;
        }
        case 'regenerate': return await this.regenerate();
        case 'editLoad': {
          const msgs = this.store.active().messages;
          const um = msgs[Number(m.index)];
          if (um && um.role === 'user') { msgs.length = Number(m.index); this.store.save(); this.post({ type: 'history', messages: msgs }); this.post({ type: 'restoreInput', text: um.content }); }
          return;
        }
        case 'agentToggle': this.agentMode = !!m.on; this.chatMode = this.agentMode ? 'agent' : 'ask'; this.store.setAgentMode(this.store.activeId, this.agentMode); this.postChatMode(); this.postChats(); return;
        case 'setChatMode': {
          const mode = String(m.mode) as ChatMode;
          if (!['ask', 'agent', 'plan', 'debug', 'multitask'].includes(mode)) return;
          const agentCapable = this.devMode && this.devModel ? true : !!this.selected?.agentCapable;
          if ((mode === 'plan' || mode === 'debug' || mode === 'agent') && !agentCapable) {
            this.banner('This model does not support agent modes. Pick an agent-capable model.');
            return;
          }
          this.chatMode = mode;
          this.agentMode = mode === 'agent' || mode === 'plan' || mode === 'debug';
          this.store.setAgentMode(this.store.activeId, this.agentMode);
          if (mode === 'multitask' && !this.compareModelId) this.post({ type: 'openActionSub', sub: 'multitask' });
          this.postChatMode();
          return;
        }
        case 'openMcpSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'fortressChat.mcpServers');
          return;
        case 'reloadMcp':
          await this.initMcp();
          return;
        case 'reloadSkills':
          this.refreshSkills();
          return;
        case 'openSkillSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'fortressChat.skillDirectories');
          return;
        case 'selectModel': return await this.selectModel(String(m.id));
        case 'addModel': return this.handleAddModel(String(m.slug));
        case 'setOpenRouterKey':
          return this.stopForPolicyViolation('Cloud models are not allowed.');
        case 'setGoogleKey':
          await setGoogleKey(this.context.secrets, String(m.key));
          this.post({ type: 'googleKeySet', set: true });
          return;
        case 'setFireworksKey':
          return this.stopForPolicyViolation('Developer mode and cloud models are not allowed.');
        case 'selectDevModel':
          return this.stopForPolicyViolation('Developer mode and cloud models are not allowed.', String(m.slug || ''));
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
            await this.restartLocalIfSelected();
          }
          return;
        }
        case 'installBinary': await (await this.ensureClient()).installBinary(); return;
        case 'killForeign': await (await this.ensureClient()).foreignKill(m.pids); return;
        case 'retryModelAfterKill': return await this.retryModelAfterKill(m.pids, String(m.modelId ?? ''));
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
        case 'savePrompt': this.prefs.savePrompt(m.prompt); this.post({ type: 'prefs', prompts: this.prefs.prompts(), params: this.prefs.params() }); return;
        case 'deletePrompt': this.prefs.deletePrompt(String(m.id)); this.post({ type: 'prefs', prompts: this.prefs.prompts(), params: this.prefs.params() }); return;
        case 'setParams': this.prefs.setParams(m.params ?? {}); this.post({ type: 'prefs', prompts: this.prefs.prompts(), params: this.prefs.params() }); return;
        case 'forkChat': this.generating?.abort(); this.store.fork(Number(m.index)); this.post({ type: 'history', messages: this.store.active().messages }); this.postChats(); return;
        case 'searchChats': this.post({ type: 'searchResults', metas: searchChats(String(m.query ?? ''), this.store.metas(), this.store.messagesById(), m.folder ? String(m.folder) : undefined) }); return;
        case 'setFolder': this.store.setFolder(this.store.activeId, m.folder ? String(m.folder) : undefined); this.post({ type: 'folders', folders: this.store.listFolders() }); this.postChats(); return;
        case 'setMemory': {
          const store = new MemoryStore(this.memoryPath());
          store.save({ enabled: !!m.enabled, facts: Array.isArray(m.facts) ? m.facts.map(String) : store.load().facts });
          this.post({ type: 'memory', data: store.load() }); return;
        }
        case 'rememberFact': {
          const fact = String(m.text ?? '').trim();
          if (!fact) return;
          const store = new MemoryStore(this.memoryPath());
          const data = store.load();
          data.enabled = true;
          if (!data.facts.includes(fact)) data.facts.push(fact);
          store.save(data);
          this.post({ type: 'memory', data });
          this.banner('Saved to local memory.');
          return;
        }
        case 'indexDocs': {
          const picks = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Index documents',
            filters: { Documents: ['txt', 'md', 'markdown', 'json', 'csv', 'pdf'] },
          });
          if (!picks?.length) return;
          const client = await this.ensureClient();
          const result = await this.docsService().indexFiles(
            client,
            picks.map((u) => u.fsPath),
            (done, total, file) => this.post({ type: 'docsProgress', done, total, file: file ? vscode.workspace.asRelativePath(file) : undefined }),
          );
          if (result.errors.length) {
            const first = result.errors[0]!;
            this.banner(`Could not index ${result.errors.length} file(s): ${first.reason}`);
          }
          await this.restartLocalIfSelected();
          this.post({ type: 'docsStatus', stats: this.docsService().stats(), lastIndex: result }); return;
        }
        case 'attachImage': {
          const picks = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] } });
          if (!picks?.[0]) return;
          const buf = readFileSync(picks[0].fsPath);
          const ext = picks[0].fsPath.split('.').pop()?.toLowerCase() ?? 'png';
          const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
          this.pendingImages.push({ mime, base64: buf.toString('base64'), name: picks[0].fsPath.split('/').pop() ?? 'image' });
          this.post({ type: 'attachedImages', count: this.pendingImages.length }); return;
        }
        case 'speakLast': {
          const msgs = this.store.active().messages;
          const last = [...msgs].reverse().find((x) => x.role === 'assistant');
          if (last) void speakText(last.content).catch((e) => this.banner(String(e))); return;
        }
        case 'setCompareModel': this.compareModelId = m.id ? String(m.id) : null; if (this.compareModelId) this.chatMode = 'multitask'; this.postChatMode(); return;
        case 'showArtifact': this.post({ type: 'artifact', html: String(m.html ?? '') }); return;
        case 'exportChat': {
          const title = this.store.metas().find((x) => x.id === this.store.activeId)?.title ?? 'Chat';
          const md = exportMarkdown(title, this.store.active().messages, new Date());
          const uri = await vscode.window.showSaveDialog({ filters: { Markdown: ['md'] }, defaultUri: vscode.Uri.file(title.replace(/[^\w-]+/g, '-') + '.md') });
          if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(md, 'utf8'));
          return;
        }
        case 'listMentionFiles': {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          this.post({ type: 'mentionFiles', items: mentionCandidates(root, String(m.query ?? '')) });
          return;
        }
        case 'undoAgentRun': {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (!root || !this.lastCheckpoint?.hasChanges()) { this.banner('Nothing to undo from the last agent run.'); return; }
          const restored = this.lastCheckpoint.restore(root);
          this.lastCheckpoint = null;
          this.postAgentUndo();
          vscode.window.showInformationMessage(restored.length ? `Restored ${restored.length} file(s) from before the last agent run.` : 'Agent run undone.');
          return;
        }
        case 'openRulesFile': {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (!root) { this.banner('Open a folder to edit project rules.'); return; }
          const rel = defaultRulesRel(root);
          const abs = join(root, rel);
          try { readFileSync(abs); } catch {
            await vscode.workspace.fs.writeFile(vscode.Uri.file(abs), Buffer.from('# Project rules\n\nAdd instructions FortressChat should follow in this repo.\n', 'utf8'));
          }
          const doc = await vscode.workspace.openTextDocument(abs);
          await vscode.window.showTextDocument(doc);
          return;
        }
        case 'savePersona': this.prefs.savePersona(m.persona); this.post({ type: 'personas', personas: this.prefs.personas() }); return;
        case 'deletePersona': this.prefs.deletePersona(String(m.id)); this.post({ type: 'personas', personas: this.prefs.personas() }); return;
        case 'setPersona': this.store.setPersona(this.store.activeId, m.id ? String(m.id) : undefined); this.postChats(); return;
        case 'setSkill': this.store.setSkill(this.store.activeId, m.id ? String(m.id) : undefined); this.postChats(); return;
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
    } else {
      await this.unloadLocalModel();
    }
    await this.pushStatus();
    this.postContextWindow();
  }

  /** Kill foreign llama-server processes then retry starting the selected model. */
  private async retryModelAfterKill(pids: unknown, modelId: string): Promise<void> {
    const killPids = (Array.isArray(pids) ? pids : []).map((p) => Number(p)).filter((p) => p > 0);
    if (!modelId || !killPids.length) {
      this.banner('Nothing to retry — pick a model again.');
      return;
    }
    try {
      this.banner('Stopping other models…');
      await (await this.ensureClient()).foreignKill(killPids);
      await new Promise((r) => setTimeout(r, 2000));
      this.banner('Starting model…');
      await this.selectModel(modelId);
      const status = this.client ? await this.client.status().catch(() => null) : null;
      if (status?.state === 'ready') this.post({ type: 'clearBanner' });
    } catch (e) {
      this.banner(`Could not restart model: ${e instanceof Error ? e.message : e}`);
    }
  }

  private handleAddModel(slug: string): void {
    const reason = explainBlock(slug);
    if (reason) {
      this.stopForPolicyViolation(reason, slug);
      return;
    }
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
      googleKey: await getGoogleKey(this.context.secrets),
    };
  }

  private async currentTarget(): Promise<ResolvedTarget> {
    if (this.devMode && this.devModel) {
      const key = await getFireworksKey(this.context.secrets);
      return resolveDevTarget(this.devModel, key ?? '');
    }
    if (this.selected) {
      if (this.selected.provider === 'local' && !this.client) this.client = await this.connect();
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
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.generating) {
      this.promptQueue.push(trimmed);
      this.postQueue();
      return;
    }
    await this.processSendQueue(trimmed);
  }

  private async processSendQueue(initial: string): Promise<void> {
    let text: string | undefined = initial;
    while (text) {
      await this.executeSend(text);
      text = this.promptQueue.shift();
      if (text !== undefined) this.postQueue();
    }
  }

  private async executeSend(text: string): Promise<void> {
    this.generating = new AbortController();
    this.postGenerating(true);
    try {
      let target;
      try {
        target = await this.currentTarget();
      } catch (e) {
        this.banner(String(e instanceof Error ? e.message : e));
        this.post({ type: 'restoreInput', text });
        return;
      }
      const params = this.prefs.params();
      if (Object.keys(params).length) target = { ...target, bodyExtra: { ...target.bodyExtra, ...params } };
      const session = this.store.active();
      const ctx = await this.collectContext(text);
      const preamble = buildContextPreamble(ctx);
      const sys = this.systemPromptForChat() + (preamble ? '\n\n---\n' + preamble : '');
      const preTurnLen = session.messages.length;
      session.addUser(text);
      this.post({ type: 'history', messages: session.messages });
      let usage: Usage | null = null;
      const checkpoint = this.agentMode ? new AgentCheckpoint() : null;
      try {
      if (this.compareModelId) {
        const entry = loadPolicy().find((e) => e.id === this.compareModelId);
        if (entry) {
          const targetB = await resolveTarget(entry, await this.targetDeps());
          const sessionB = new Session();
          sessionB.messages = session.messages.map((m) => ({ ...m }));
          this.post({ type: 'compareStart' });
          await Promise.all([
            (async () => {
              if (this.agentMode) await runAgentTurn(target, session, sys, (step) => this.post({ type: 'agentStep', step: `[A] ${step}` }), this.generating!.signal, { extraTools: this.mcpTools, toolExtras: this.toolExtras(checkpoint ?? undefined) });
              else {
                const r = await streamChat(target, session.toRequestMessages(sys), (t) => this.post({ type: 'token', text: t }), this.generating!.signal, (t) => this.post({ type: 'reasoning', text: t }));
                session.addAssistant(splitThink(r.content).content || '(no reply)');
                usage = r.usage;
              }
            })(),
            (async () => {
              const r = await streamChat(targetB, sessionB.toRequestMessages(sys), (t) => this.post({ type: 'compareToken', side: 'B', text: t }), this.generating!.signal);
              this.post({ type: 'compareDone', side: 'B', content: splitThink(r.content).content || '(no reply)' });
            })(),
          ]);
          this.post({ type: 'compareDone', side: 'A', content: session.messages[session.messages.length - 1]?.content ?? '' });
        }
      } else if (this.agentMode) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
          this.banner('Agent mode needs a project folder. Use File → Open Folder (Mac) or open a workspace in VS Code.');
          throw new Error('agent-needs-folder');
        }
        await runAgentTurn(target, session, sys, (step) => this.post({ type: 'agentStep', step }), this.generating.signal, { extraTools: this.mcpTools, toolExtras: this.toolExtras(checkpoint ?? undefined), workspaceRoot: root });
      } else {
        const r = await streamChat(target, session.toRequestMessages(sys),
          (t) => this.post({ type: 'token', text: t }), this.generating.signal,
          (t) => this.post({ type: 'reasoning', text: t }));
        session.addAssistant(splitThink(r.content).content || '(no reply)');
        const hits = [
          ...(ctx.codebase ?? []).map(({ file, startLine, endLine }) => ({ file, startLine, endLine })),
          ...(ctx.docs ?? []).map(({ file, startLine, endLine }) => ({ file, startLine, endLine })),
        ];
        if (hits.length) {
          const last = session.messages[session.messages.length - 1];
          last.sources = hits;
        }
        this.post({ type: 'reasoningDone' });
        usage = r.usage;
      }
      this.store.touchTitle();
      this.store.save();
      this.post({ type: 'history', messages: session.messages });
      this.postChats();
      if (usage) this.post({ type: 'usage', usage });
      if (checkpoint?.hasChanges()) {
        this.lastCheckpoint = checkpoint;
        this.postAgentUndo();
      }
      } catch (e) {
        session.messages.length = preTurnLen; // error hygiene: remove user msg + any tool exchange from the failed turn
        this.store.save();
        this.post({ type: 'history', messages: session.messages });
        this.post({ type: 'restoreInput', text });
        this.banner(String(e instanceof Error ? e.message : e));
      }
    } finally {
      this.generating = null;
      this.postGenerating(false);
    }
  }
}
