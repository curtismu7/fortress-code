import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CatalogModel, StatusResponse, StartRejection } from '@fortress-code/shared';

function dataDir(): string {
  return process.env.FC_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'fortress-code');
}

interface DaemonInfo { pid: number; port: number; token: string }

function readInfo(): DaemonInfo | null {
  try { return JSON.parse(readFileSync(join(dataDir(), 'daemon.json'), 'utf8')); } catch { return null; }
}

export class DaemonClient {
  constructor(private port: number, private token: string) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      ...init,
      headers: { 'x-fc-token': this.token, 'content-type': 'application/json', ...init.headers },
    });
    if (res.status === 401) throw new Error('daemon auth failed');
    return res;
  }

  async status(): Promise<StatusResponse> { return (await this.call('/status')).json(); }
  async catalog(): Promise<CatalogModel[]> { return (await this.call('/catalog')).json(); }
  async download(modelId: string): Promise<void> { await this.call('/download', { method: 'POST', body: JSON.stringify({ modelId }) }); }
  async installBinary(): Promise<void> { await this.call('/install-binary', { method: 'POST', body: '{}' }); }
  async stop(): Promise<void> { await this.call('/stop', { method: 'POST', body: '{}' }); }
  async foreignKill(pids: number[]): Promise<void> { await this.call('/foreign/kill', { method: 'POST', body: JSON.stringify({ pids }) }); }
  async shutdown(): Promise<void> { await this.call('/shutdown', { method: 'POST', body: '{}' }).catch(() => {}); }

  async start(modelId: string): Promise<{ ok: true } | { ok: false; rejection: StartRejection }> {
    const res = await this.call('/start', { method: 'POST', body: JSON.stringify({ modelId }) });
    if (res.status === 200) return { ok: true };
    if (res.status === 409) return { ok: false, rejection: await res.json() };
    throw new Error(`start failed: HTTP ${res.status} ${await res.text()}`);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await this.call('/embed', { method: 'POST', body: JSON.stringify({ texts }) });
    if (!res.ok) throw new Error(`embed failed: HTTP ${res.status}`);
    return (await res.json()).vectors;
  }

  async embedStart(): Promise<{ ok: boolean }> {
    const res = await this.call('/embed/start', { method: 'POST', body: '{}' });
    return { ok: res.status === 200 };
  }

  async embedStop(): Promise<void> {
    await this.call('/embed/stop', { method: 'POST', body: '{}' });
  }
}

async function alive(info: DaemonInfo): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/status`, {
      headers: { 'x-fc-token': info.token }, signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch { return false; }
}

export async function ensureDaemon(managerEntryPath: string): Promise<DaemonClient> {
  const existing = readInfo();
  if (existing && (await alive(existing))) return new DaemonClient(existing.port, existing.token);
  if (!existsSync(managerEntryPath)) throw new Error(`manager bundle missing: ${managerEntryPath}`);
  spawn(process.execPath, [managerEntryPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const info = readInfo();
    if (info && (await alive(info))) return new DaemonClient(info.port, info.token);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('daemon did not start within 10s (see daemon.log in the Fortress Code data folder)');
}
