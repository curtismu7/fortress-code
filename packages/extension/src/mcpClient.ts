// packages/extension/src/mcpClient.ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface McpServerConfig { name: string; command: string; args?: string[]; env?: Record<string, string> }
export interface McpTool { name: string; description: string; inputSchema: object }

/** Minimal MCP stdio client (tools/list + tools/call). */
export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private tools: McpTool[] = [];

  constructor(private cfg: McpServerConfig) {}

  /** Connect and fetch tools from the MCP server. */
  async connect(): Promise<McpTool[]> {
    if (this.proc) return this.tools;
    this.proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      env: { ...process.env, ...this.cfg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.onLine(line));
    this.proc.stderr.on('data', () => { /* ignore */ });
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fortress-code', version: '0.1.0' } });
    await this.notify('notifications/initialized', {});
    const listed = await this.request('tools/list', {}) as { tools?: McpTool[] };
    this.tools = (listed?.tools ?? []).map((t) => ({
      name: `${this.cfg.name}__${t.name}`,
      description: t.description ?? t.name,
      inputSchema: (t as { inputSchema?: object }).inputSchema ?? { type: 'object', properties: {} },
    }));
    return this.tools;
  }

  /** Call an MCP tool by prefixed name. */
  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<string> {
    const short = prefixedName.replace(`${this.cfg.name}__`, '');
    const res = await this.request('tools/call', { name: short, arguments: args }) as { content?: { type: string; text?: string }[] };
    const parts = (res?.content ?? []).map((c) => c.text ?? '').filter(Boolean);
    return parts.join('\n') || JSON.stringify(res);
  }

  /** OpenAI-compatible tool schemas for agent loop. */
  openAiSchemas(): object[] {
    return this.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  dispose(): void {
    this.proc?.kill();
    this.proc = null;
  }

  private onLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message: string } };
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id == null) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }

  private request(method: string, params: object): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc?.stdin.write(payload);
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('MCP timeout')); } }, 30_000);
    });
  }

  private notify(method: string, params: object): Promise<void> {
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    return Promise.resolve();
  }
}

/** Parse MCP server configs from extension settings. */
export function parseMcpConfigs(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is McpServerConfig =>
    !!x && typeof x.name === 'string' && typeof x.command === 'string');
}
