import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPolicy, localEntries, explainBlock, type PolicyEntry, type StatusResponse } from '@fortress-code/shared';
import { DaemonClient } from '../daemon';
import { Session } from './session';
import { resolveTarget } from '../providers/target';
import { streamChat } from '../providers/stream';
import { runAgentTurn } from '../agent/loop';
import { getOpenRouterKey, setOpenRouterKey } from '../secrets';

const SYSTEM_PROMPT = 'You are Fortress Code, a helpful local coding assistant.';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private client: DaemonClient | null = null;
  private session: Session;
  private generating: AbortController | null = null;
  private agentMode = false;
  private selected: PolicyEntry | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(private context: vscode.ExtensionContext, private connect: () => Promise<DaemonClient>) {
    this.session = Session.load(context.workspaceState);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    let html = readFileSync(join(this.context.extensionPath, 'media', 'chat.html'), 'utf8');
    html = html.replace(/\{cspSource\}/g, view.webview.cspSource);
    for (const f of ['chat.css', 'chat.js']) {
      html = html.replace(f, view.webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString());
    }
    view.webview.html = html;
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    void this.init();
  }

  private post(msg: unknown): void { void this.view?.webview.postMessage(msg); }
  private banner(message: string): void { this.post({ type: 'error', message }); }

  private async init(): Promise<void> {
    try {
      this.client = await this.connect();
      this.post({ type: 'policy', local: localEntries(), openrouter: loadPolicy().filter((e) => e.provider === 'openrouter') });
      this.post({ type: 'openRouterKeySet', set: !!(await getOpenRouterKey(this.context.secrets)) });
      this.post({ type: 'history', messages: this.session.messages });
      this.poller = setInterval(() => void this.pushStatus(), 2000);
      this.context.subscriptions.push({ dispose: () => this.poller && clearInterval(this.poller) });
      await this.pushStatus();
    } catch (e) {
      this.banner(`Could not start the Fortress Code daemon: ${e}`);
    }
  }

  private async pushStatus(): Promise<void> {
    if (!this.client) return;
    try {
      const status: StatusResponse = await this.client.status();
      this.post({ type: 'state', status, selectedId: this.selected?.id ?? null });
    } catch { /* daemon idle-exited; next send re-spawns */ }
  }

  private async onMessage(m: any): Promise<void> {
    try {
      switch (m.type) {
        case 'send': return await this.handleSend(String(m.text));
        case 'cancel': this.generating?.abort(); return;
        case 'newChat': this.session.clear(); this.session.save(this.context.workspaceState); this.post({ type: 'history', messages: [] }); return;
        case 'agentToggle': this.agentMode = !!m.on; return;
        case 'selectModel': return await this.selectModel(String(m.id));
        case 'addModel': return this.handleAddModel(String(m.slug));
        case 'setOpenRouterKey': await setOpenRouterKey(this.context.secrets, String(m.key)); this.post({ type: 'openRouterKeySet', set: true }); return;
        case 'downloadModel': await this.client?.download(String(m.catalogId)); return;
        case 'installBinary': await this.client?.installBinary(); return;
        case 'killForeign': await this.client?.foreignKill(m.pids); return;
      }
    } catch (e) {
      this.banner(String(e));
    }
  }

  private async selectModel(id: string): Promise<void> {
    const entry = loadPolicy().find((e) => e.id === id);
    if (!entry) return;
    this.selected = entry;
    if (entry.provider === 'local') {
      if (!this.client) this.client = await this.connect();
      const r = await this.client.start(entry.local!.catalogId);
      if (!r.ok) this.post({ type: 'startRejected', rejection: r.rejection, modelId: id });
    }
    await this.pushStatus();
  }

  private handleAddModel(slug: string): void {
    const reason = explainBlock(slug);
    if (reason) { this.post({ type: 'addBlocked', slug, reason }); return; }
    // Approved slug: it is already in the registry; surface it as selectable.
    this.post({ type: 'addAccepted', slug });
  }

  private async targetDeps() {
    const status = this.client ? await this.client.status().catch(() => null) : null;
    return {
      localEndpoint: status?.endpoint ?? undefined,
      openRouterKey: await getOpenRouterKey(this.context.secrets),
    };
  }

  private async handleSend(text: string): Promise<void> {
    if (!this.selected) { this.banner('Pick a model first.'); this.post({ type: 'restoreInput', text }); return; }
    let target;
    try {
      target = resolveTarget(this.selected, await this.targetDeps());
    } catch (e) {
      this.banner(String(e instanceof Error ? e.message : e));
      this.post({ type: 'restoreInput', text });
      return;
    }
    this.session.addUser(text);
    this.post({ type: 'history', messages: this.session.messages });
    this.generating = new AbortController();
    try {
      if (this.agentMode) {
        await runAgentTurn(target, this.session, SYSTEM_PROMPT, (step) => this.post({ type: 'agentStep', step }), this.generating.signal);
      } else {
        const full = await streamChat(target, this.session.toRequestMessages(SYSTEM_PROMPT), (t) => this.post({ type: 'token', text: t }), this.generating.signal);
        this.session.addAssistant(full);
      }
      this.session.save(this.context.workspaceState);
      this.post({ type: 'history', messages: this.session.messages });
    } catch (e) {
      this.session.messages.pop(); // error hygiene: never leave a poisoned turn
      this.session.save(this.context.workspaceState);
      this.post({ type: 'history', messages: this.session.messages });
      this.post({ type: 'restoreInput', text });
      this.banner(String(e instanceof Error ? e.message : e));
    } finally {
      this.generating = null;
    }
  }
}
