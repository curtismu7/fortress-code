import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonClient } from '../daemon';
import { VectorStore } from './store';
import { indexWorkspace, type IndexProgress } from './indexer';
import { retrieve } from './retriever';

export class RagService {
  private store: VectorStore;
  constructor(private storeDir: string, private dims: number, private root: string, private model = 'nomic-embed-text-v1.5') {
    this.store = VectorStore.open(storeDir, dims, this.model);
  }
  hasIndex(): boolean { return this.store.stats().chunks > 0; }
  stats(): { files: number; chunks: number } { return this.store.stats(); }

  async index(client: DaemonClient, onProgress: (p: IndexProgress) => void, signal?: AbortSignal): Promise<void> {
    const started = await client.embedStart();
    if (!started.ok) throw new Error('embedding server could not start (check RAM or download the embed model)');
    await indexWorkspace(this.root, this.store, (t) => client.embed(t), onProgress, signal);
  }

  async retrieveHits(client: DaemonClient, query: string): Promise<{ file: string; startLine: number; endLine: number; text: string }[]> {
    if (!this.hasIndex()) return [];
    await client.embedStart();
    const hits = await retrieve(query, this.store, (t) => client.embed(t), 8);
    return hits.map((h) => {
      let text = '';
      try {
        const lines = readFileSync(join(this.root, h.file), 'utf8').split('\n');
        text = lines.slice(h.startLine - 1, h.endLine).join('\n');
      } catch { /* file gone; skip body */ }
      return { ...h, text };
    }).filter((h) => h.text);
  }
}
