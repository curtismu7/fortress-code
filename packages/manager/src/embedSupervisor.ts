import { spawn, ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { CatalogModel, ServerState } from '@fortress-code/shared';
import { llamaServerPath } from './binary';

const EMBED_CTX = 8192;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export class EmbedSupervisor {
  state: ServerState = 'idle';
  modelId: string | null = null;
  port: number | null = null;
  private child: ChildProcess | null = null;
  private stderrRing: string[] = [];
  private expectedExit = false;

  managedPid(): number | null { return this.child?.pid ?? null; }
  endpoint(): string | null { return this.state === 'ready' && this.port ? `http://127.0.0.1:${this.port}` : null; }

  buildArgs(modelPath: string): string[] {
    return [
      ...(process.env.FC_LLAMA_BIN_ARGS ? [process.env.FC_LLAMA_BIN_ARGS] : []),
      '-m', modelPath, '-ngl', '99', '-c', String(EMBED_CTX),
      '--embedding', '--pooling', 'mean',
      '--host', '127.0.0.1', '--port', String(this.port),
    ];
  }

  async start(model: CatalogModel, modelPath: string): Promise<void> {
    if (this.child) await this.stop();
    this.stderrRing = [];
    this.expectedExit = false;
    this.port = await freePort();
    this.state = 'starting';
    this.child = spawn(llamaServerPath(), this.buildArgs(modelPath), { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child.stderr!.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue;
        this.stderrRing.push(line);
        if (this.stderrRing.length > 50) this.stderrRing.shift();
      }
    });
    this.child.on('exit', () => {
      this.child = null;
      if (!this.expectedExit) this.state = 'crashed';
    });
    this.modelId = model.id;
    await this.waitReady();
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (this.state === 'crashed') throw new Error('embed server crashed:\n' + this.stderrRing.join('\n'));
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) { this.state = 'ready'; return; }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.stop();
    throw new Error('embed server did not become ready within 120s');
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) { this.state = 'idle'; this.modelId = null; return; }
    this.state = 'stopping';
    this.expectedExit = true;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });
    this.child = null;
    this.modelId = null;
    this.state = 'idle';
  }
}
