// packages/extension/src/mcpClient.ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface McpServerConfig {
  name: string;
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  messageUrl?: string;
  headers?: Record<string, string>;
  /** When true, omit this server from the active list (used to disable built-ins). */
  disabled?: boolean;
  /** True for FortressChat-provided defaults such as PingOne MCP. */
  builtin?: boolean;
}
export interface McpTool { name: string; description: string; inputSchema: object }
export interface McpResource { name: string; uri: string; description?: string }
export interface McpPrompt { name: string; description?: string }

type RpcError = { code?: number; message?: string; data?: unknown };
type RpcMessage = { id?: number; method?: string; result?: unknown; error?: RpcError };
type WireMode = 'framed' | 'newline';
type ClientTransport = 'stdio' | 'http' | 'sse';

const MCP_ACCEPT_HEADER = 'application/json, text/event-stream';

/** Minimal MCP stdio client (tools/list + tools/call). */
export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private tools: McpTool[] = [];
  private resources: McpResource[] = [];
  private prompts: McpPrompt[] = [];
  private lastError: string | null = null;
  private recvBuffer = '';
  private wireMode: WireMode = 'framed';
  private connected = false;
  private readonly transport: ClientTransport;
  private sseAbort: AbortController | null = null;
  private ssePostUrl: string | null = null;
  private sseReadyResolver: (() => void) | null = null;
  private sseReadyRejecter: ((err: Error) => void) | null = null;
  private sseReadyPromise: Promise<void> | null = null;
  private sseBuffer = '';

  constructor(private cfg: McpServerConfig) {
    this.transport = this.resolveTransport(cfg);
  }

  private resolveTransport(cfg: McpServerConfig): ClientTransport {
    if (cfg.transport) return cfg.transport;
    if (cfg.command) return 'stdio';
    if (cfg.url) return 'http';
    throw new Error(`MCP config ${cfg.name} is invalid: expected command or url`);
  }

  /** Connect and fetch tools from the MCP server. */
  async connect(): Promise<McpTool[]> {
    if (this.connected) return this.tools;
    this.lastError = null;
    if (this.transport === 'stdio') {
      try {
        await this.connectWithMode('framed');
        return this.tools;
      } catch (e) {
        const firstError = e instanceof Error ? e.message : String(e);
        this.lastError = firstError;
        this.dispose();
        try {
          // Compatibility fallback for non-standard line-delimited MCP servers.
          await this.connectWithMode('newline');
          return this.tools;
        } catch (e2) {
          this.lastError = e2 instanceof Error ? e2.message : String(e2);
          this.dispose();
          throw new Error(`MCP connect failed (${this.cfg.name}): ${firstError}; fallback failed: ${this.lastError}`);
        }
      }
    }

    if (this.transport === 'sse') {
      await this.connectSse();
    }

    const handshakeTimeoutMs = 10_000;
    await this.initializeWithFallback(handshakeTimeoutMs);
    await this.notify('notifications/initialized', {});
    await this.refreshCapabilities(handshakeTimeoutMs);
    this.connected = true;
    return this.tools;
  }

  private async connectWithMode(mode: WireMode): Promise<void> {
    this.wireMode = mode;
    this.recvBuffer = '';
    if (!this.cfg.command) throw new Error(`MCP config ${this.cfg.name} missing command`);
    this.proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      env: { ...process.env, ...this.cfg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (d) => this.onStdoutData(String(d)));
    this.proc.stderr.on('data', (d) => {
      const msg = String(d).trim();
      if (msg) this.lastError = msg.slice(0, 200);
    });
    this.proc.on('error', (e) => { this.lastError = e.message; });

    const handshakeTimeoutMs = mode === 'framed' ? 4_000 : 10_000;
    await this.initializeWithFallback(handshakeTimeoutMs);
    await this.notify('notifications/initialized', {});
    await this.refreshCapabilities(handshakeTimeoutMs);
    this.connected = true;
  }

  private async refreshCapabilities(timeoutMs: number): Promise<void> {
    this.tools = await this.fetchTools(timeoutMs);
    this.resources = await this.fetchResources(timeoutMs);
    this.prompts = await this.fetchPrompts(timeoutMs);
  }

  private async fetchTools(timeoutMs: number): Promise<McpTool[]> {
    try {
      const listed = await this.request('tools/list', {}, timeoutMs) as { tools?: McpTool[] };
      return (listed?.tools ?? []).map((t) => ({
        name: `${this.cfg.name}__${t.name}`,
        description: t.description ?? t.name,
        inputSchema: (t as { inputSchema?: object }).inputSchema ?? { type: 'object', properties: {} },
      }));
    } catch (e) {
      if (this.isMethodNotFoundError(e)) return [];
      throw e;
    }
  }

  private async fetchResources(timeoutMs: number): Promise<McpResource[]> {
    try {
      const listed = await this.request('resources/list', {}, timeoutMs) as { resources?: Array<{ name?: string; uri?: string; description?: string }> };
      return (listed?.resources ?? [])
        .filter((r) => typeof r?.uri === 'string' && r.uri.trim().length > 0)
        .map((r) => ({
          name: String(r.name || r.uri || '').trim(),
          uri: String(r.uri || '').trim(),
          description: typeof r.description === 'string' ? r.description : undefined,
        }));
    } catch (e) {
      if (this.isMethodNotFoundError(e)) return [];
      throw e;
    }
  }

  private async fetchPrompts(timeoutMs: number): Promise<McpPrompt[]> {
    try {
      const listed = await this.request('prompts/list', {}, timeoutMs) as { prompts?: Array<{ name?: string; description?: string }> };
      return (listed?.prompts ?? [])
        .filter((p) => typeof p?.name === 'string' && p.name.trim().length > 0)
        .map((p) => ({
          name: String(p.name || '').trim(),
          description: typeof p.description === 'string' ? p.description : undefined,
        }));
    } catch (e) {
      if (this.isMethodNotFoundError(e)) return [];
      throw e;
    }
  }

  private isMethodNotFoundError(err: unknown): boolean {
    const msg = String(err instanceof Error ? err.message : err).toLowerCase();
    return msg.includes('method not found') || msg.includes('-32601');
  }

  private async connectSse(): Promise<void> {
    const sseUrl = this.cfg.url;
    if (!sseUrl) throw new Error(`MCP config ${this.cfg.name} missing url`);

    this.sseAbort = new AbortController();
    this.sseBuffer = '';
    this.ssePostUrl = this.cfg.messageUrl ? this.resolveUrl(this.cfg.messageUrl, sseUrl) : null;
    this.sseReadyPromise = new Promise<void>((resolve, reject) => {
      this.sseReadyResolver = resolve;
      this.sseReadyRejecter = reject;
    });

    const res = await fetch(sseUrl, {
      method: 'GET',
      headers: { accept: 'text/event-stream', ...this.cfg.headers },
      signal: this.sseAbort.signal,
    });
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      throw this.webPageUrlError(sseUrl);
    }
    if (!res.ok || !res.body) throw new Error(`MCP SSE connect failed HTTP ${res.status}`);

    this.connected = true;
    void this.consumeSseStream(res.body);

    if (this.ssePostUrl) {
      this.sseReadyResolver?.();
      this.sseReadyResolver = null;
      this.sseReadyRejecter = null;
      return;
    }

    await Promise.race([
      this.sseReadyPromise,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('MCP SSE endpoint timeout')), 4_000)),
    ]);
  }

  private async consumeSseStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.sseBuffer += decoder.decode(value, { stream: true });
        this.drainSseBuffer();
      }
    } catch (e) {
      if (!this.sseAbort?.signal.aborted) {
        this.lastError = e instanceof Error ? e.message : String(e);
        this.sseReadyRejecter?.(new Error(this.lastError));
      }
    }
  }

  private drainSseBuffer(): void {
    while (true) {
      const idx = this.findSseMessageBoundary(this.sseBuffer);
      if (idx < 0) return;
      const chunk = this.sseBuffer.slice(0, idx);
      const sepLen = this.sseBuffer.startsWith('\r\n\r\n', idx) ? 4 : this.sseBuffer.startsWith('\n\n', idx) ? 2 : this.sseBuffer.startsWith('\r\r', idx) ? 2 : 2;
      this.sseBuffer = this.sseBuffer.slice(idx + sepLen);
      this.onSseChunk(chunk);
    }
  }

  private findSseMessageBoundary(input: string): number {
    const a = input.indexOf('\r\n\r\n');
    const b = input.indexOf('\n\n');
    const c = input.indexOf('\r\r');
    const vals = [a, b, c].filter((v) => v >= 0);
    if (vals.length === 0) return -1;
    return Math.min(...vals);
  }

  private onSseChunk(chunk: string): void {
    const lines = chunk.split(/\r?\n/);
    let event = '';
    const data: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }

    if (data.length === 0) return;
    const payload = data.join('\n').trim();

    if (event === 'endpoint' || payload.startsWith('/')) {
      const base = this.cfg.url;
      if (!base) return;
      this.ssePostUrl = this.resolveUrl(payload, base);
      this.sseReadyResolver?.();
      this.sseReadyResolver = null;
      this.sseReadyRejecter = null;
      return;
    }

    this.onRawMessage(payload);
  }

  private resolveUrl(pathOrUrl: string, base: string): string {
    try {
      return new URL(pathOrUrl, base).toString();
    } catch {
      return pathOrUrl;
    }
  }

  private looksLikeHtmlResponse(text: string, contentType: string): boolean {
    const ct = String(contentType || '').toLowerCase();
    if (ct.includes('text/html')) return true;
    const trimmed = String(text || '').trim().toLowerCase();
    return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html');
  }

  private webPageUrlError(url: string): Error {
    const lower = String(url || '').toLowerCase();
    if (lower.includes('mcp-test-client')) {
      return new Error('That URL is an MCP test client web page, not an MCP server endpoint. For mcpplaygroundonline, use a server endpoint such as /mcp-echo-server, /mcp-auth-server, /mcp-complex-schema-server, or /mcp-apps-server.');
    }
    return new Error('URL appears to be a web page, not an MCP endpoint. Use the MCP server endpoint URL (JSON-RPC or SSE).');
  }

  private framedPayload(rawJson: string): string {
    return `Content-Length: ${Buffer.byteLength(rawJson, 'utf8')}\r\n\r\n${rawJson}`;
  }

  private async initializeWithFallback(timeoutMs: number): Promise<void> {
    const protocolVersions = ['2025-03-26', '2024-11-05', '2024-10-07'];
    let lastError: unknown;
    for (const protocolVersion of protocolVersions) {
      try {
        await this.request('initialize', {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'fortress-chat', version: '0.1.0' },
        }, timeoutMs);
        return;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('MCP initialize failed');
  }

  private sendRpc(payload: object): void {
    if (!this.proc) throw new Error('MCP process is not connected');
    const raw = JSON.stringify(payload);
    if (this.wireMode === 'framed') this.proc.stdin.write(this.framedPayload(raw));
    else this.proc.stdin.write(`${raw}\n`);
  }

  private onStdoutData(chunk: string): void {
    this.recvBuffer += chunk;
    while (this.recvBuffer.length > 0) {
      const trimmed = this.recvBuffer.replace(/^[\r\n]+/, '');
      if (trimmed.length !== this.recvBuffer.length) this.recvBuffer = trimmed;

      const headerEndRfc = this.recvBuffer.indexOf('\r\n\r\n');
      const headerEndLf = this.recvBuffer.indexOf('\n\n');
      let headerEnd = -1;
      let sepLen = 0;
      if (headerEndRfc >= 0 && (headerEndLf < 0 || headerEndRfc < headerEndLf)) {
        headerEnd = headerEndRfc;
        sepLen = 4;
      } else if (headerEndLf >= 0) {
        headerEnd = headerEndLf;
        sepLen = 2;
      }

      const looksFramed = /^content-length\s*:/i.test(this.recvBuffer);
      if (looksFramed) {
        if (headerEnd < 0) return;
        const headerBlock = this.recvBuffer.slice(0, headerEnd);
        const lenMatch = headerBlock.match(/(?:^|\r?\n)content-length\s*:\s*(\d+)/i);
        if (!lenMatch) {
          this.recvBuffer = this.recvBuffer.slice(headerEnd + sepLen);
          continue;
        }
        const bodyLength = Number.parseInt(lenMatch[1], 10);
        const bodyStart = headerEnd + sepLen;
        if (this.recvBuffer.length < bodyStart + bodyLength) return;
        const body = this.recvBuffer.slice(bodyStart, bodyStart + bodyLength);
        this.recvBuffer = this.recvBuffer.slice(bodyStart + bodyLength);
        this.onRawMessage(body);
        continue;
      }

      const lineEnd = this.recvBuffer.indexOf('\n');
      if (lineEnd < 0) return;
      const line = this.recvBuffer.slice(0, lineEnd).trim();
      this.recvBuffer = this.recvBuffer.slice(lineEnd + 1);
      if (!line) continue;
      this.onRawMessage(line);
    }
  }

  private onRawMessage(raw: string): void {
    let msg: RpcMessage;
    try { msg = JSON.parse(raw) as RpcMessage; } catch { return; }
    this.onMessage(msg);
  }

  private onMessage(msg: RpcMessage): void {
    if (msg.method && msg.id != null) {
      try {
        this.sendRpc({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      } catch {
        // Ignore if process already closed.
      }
      return;
    }

    if (msg.id == null) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'));
    else p.resolve(msg.result);
  }

  /** Call an MCP tool by prefixed name. */
  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<string> {
    const prefix = `${this.cfg.name}__`;
    const short = prefixedName.startsWith(prefix) ? prefixedName.slice(prefix.length) : prefixedName;
    const res = await this.request('tools/call', { name: short, arguments: args }) as {
      content?: Array<{ type?: string; text?: string; json?: unknown }>;
      structuredContent?: unknown;
      [k: string]: unknown;
    };
    const parts = (res?.content ?? []).map((c) => {
      if (typeof c.text === 'string') return c.text;
      if (c.json !== undefined) return JSON.stringify(c.json);
      return '';
    }).filter(Boolean);
    if (parts.length > 0) return parts.join('\n');
    if (res?.structuredContent !== undefined) return JSON.stringify(res.structuredContent);
    return JSON.stringify(res);
  }

  /** OpenAI-compatible tool schemas for agent loop. */
  openAiSchemas(): object[] {
    return this.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  /** Raw MCP tools discovered from the server, with prefixed names. */
  listTools(): McpTool[] {
    return [...this.tools];
  }

  /** MCP resources discovered from the server. */
  listResources(): McpResource[] {
    return [...this.resources];
  }

  /** MCP prompts discovered from the server. */
  listPrompts(): McpPrompt[] {
    return [...this.prompts];
  }

  serverName(): string { return this.cfg.name; }
  isBuiltin(): boolean { return !!this.cfg.builtin; }
  isConnected(): boolean { return this.connected; }
  toolCount(): number { return this.tools.length; }
  error(): string | null { return this.lastError; }

  dispose(): void {
    for (const [, p] of this.pending) p.reject(new Error('MCP client disposed'));
    this.pending.clear();
    this.sseAbort?.abort();
    this.sseAbort = null;
    this.ssePostUrl = null;
    this.sseReadyResolver = null;
    this.sseReadyRejecter = null;
    this.sseReadyPromise = null;
    this.sseBuffer = '';
    this.proc?.kill();
    this.proc = null;
    this.tools = [];
    this.resources = [];
    this.prompts = [];
    this.recvBuffer = '';
    this.connected = false;
  }

  private request(method: string, params: object, timeoutMs = 30_000): Promise<unknown> {
    if (this.transport === 'http') {
      return this.requestHttp(method, params);
    }
    if (this.transport === 'sse') {
      return this.requestSse(method, params, timeoutMs);
    }

    const id = this.nextId++;
    if (!this.proc) return Promise.reject(new Error('MCP process is not connected'));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendRpc({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout (${method})`));
        }
      }, timeoutMs);
    });
  }

  private async requestHttp(method: string, params: object): Promise<unknown> {
    const url = this.cfg.url;
    if (!url) throw new Error(`MCP config ${this.cfg.name} missing url`);
    const id = this.nextId++;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: MCP_ACCEPT_HEADER, ...this.cfg.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const text = await res.text();
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (this.looksLikeHtmlResponse(text, contentType)) {
      throw this.webPageUrlError(url);
    }
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
    const msg = this.parseRpcMessage(text, contentType);
    if (!msg) throw new Error('MCP HTTP response was not valid JSON-RPC');
    if (msg.error) throw new Error(msg.error.message ?? 'MCP error');
    return msg.result;
  }

  private parseRpcMessage(text: string, contentType: string): RpcMessage | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    if (contentType.includes('text/event-stream') || trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
      const chunks = trimmed.split(/\r?\n\r?\n/);
      for (const chunk of chunks) {
        const dataLines: string[] = [];
        for (const line of chunk.split(/\r?\n/)) {
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        const payload = dataLines.join('\n').trim();
        if (!payload) continue;
        try { return JSON.parse(payload) as RpcMessage; } catch { /* try next chunk */ }
      }
      return null;
    }

    try { return JSON.parse(trimmed) as RpcMessage; } catch { return null; }
  }

  private requestSse(method: string, params: object, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.postSseRequest({ jsonrpc: '2.0', id, method, params }).catch((e) => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout (${method})`));
        }
      }, timeoutMs);
    });
  }

  private async postSseRequest(payload: object): Promise<void> {
    const base = this.cfg.url;
    if (!base) throw new Error(`MCP config ${this.cfg.name} missing url`);
    if (!this.ssePostUrl) {
      if (!this.sseReadyPromise) throw new Error('MCP SSE session is not ready');
      await this.sseReadyPromise;
    }
    const target = this.ssePostUrl ?? base;
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: MCP_ACCEPT_HEADER, ...this.cfg.headers },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP SSE POST ${res.status}: ${text.slice(0, 200)}`);
    }

    // Some servers reply directly on POST instead of the SSE stream.
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return;
    const text = await res.text();
    if (!text.trim()) return;
    this.onRawMessage(text);
  }

  private notify(method: string, params: object): Promise<void> {
    if (this.transport === 'http') {
      const url = this.cfg.url;
      if (!url) return Promise.resolve();
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: MCP_ACCEPT_HEADER, ...this.cfg.headers },
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      }).then(() => undefined);
    }
    if (this.transport === 'sse') {
      return this.postSseRequest({ jsonrpc: '2.0', method, params }).then(() => undefined);
    }
    if (!this.proc) return Promise.resolve();
    this.sendRpc({ jsonrpc: '2.0', method, params });
    return Promise.resolve();
  }
}

/** Parse MCP server configs from extension settings. */
export function parseMcpConfigs(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is McpServerConfig => {
    if (!x || typeof x !== 'object') return false;
    const row = x as McpServerConfig;
    if (typeof row.name !== 'string' || row.disabled === true) return false;
    const hasCommand = typeof row.command === 'string' && row.command.trim().length > 0;
    const hasUrl = typeof row.url === 'string' && row.url.trim().length > 0;
    return hasCommand || hasUrl;
  });
}
