// packages/extension/src/docsService.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonClient } from './daemon';
import { VectorStore } from './rag/store';
import { chunkFile } from './rag/chunker';
import { retrieve } from './rag/retriever';
import { sha } from './rag/indexer';

const DOC_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv']);

/** Document RAG — separate index from workspace code (@docs). */
export class DocsService {
  private store: VectorStore;

  constructor(private storeDir: string, private dims = 768, private model = 'nomic-embed-text-v1.5') {
    this.store = VectorStore.open(join(storeDir, 'docs'), dims, model);
  }

  stats(): { files: number; chunks: number } { return this.store.stats(); }
  hasIndex(): boolean { return this.store.stats().chunks > 0; }

  /** Index selected text files into the docs vector store. */
  async indexFiles(client: DaemonClient, paths: string[], onProgress?: (n: number, total: number) => void): Promise<number> {
    await client.embedStart();
    let n = 0;
    for (const abs of paths) {
      n++;
      onProgress?.(n, paths.length);
      if (!existsSync(abs)) continue;
      const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase();
      if (!DOC_EXT.has(ext)) continue;
      let text: string;
      try { text = readFileSync(abs, 'utf8'); } catch { continue; }
      const rel = abs;
      const h = sha(text);
      if (this.store.hashOf(rel) === h) continue;
      const chunks = chunkFile(text);
      if (!chunks.length) { this.store.replaceFile(rel, h, []); continue; }
      const vectors = await client.embed(chunks.map((c) => `search_document: ${c.text}`));
      this.store.replaceFile(rel, h, chunks.map((c, i) => ({ meta: { startLine: c.startLine, endLine: c.endLine }, vector: vectors[i] })));
    }
    this.store.save();
    return paths.length;
  }

  /** Retrieve doc chunks for @docs queries. */
  async retrieveHits(client: DaemonClient, query: string): Promise<{ file: string; startLine: number; endLine: number; text: string }[]> {
    if (!this.hasIndex()) return [];
    await client.embedStart();
    const hits = await retrieve(query, this.store, (t) => client.embed(t), 6);
    return hits.map((h) => {
      let text = '';
      try {
        const lines = readFileSync(h.file, 'utf8').split('\n');
        text = lines.slice(h.startLine - 1, h.endLine).join('\n');
      } catch { /* gone */ }
      return { ...h, text };
    }).filter((h) => h.text);
  }
}
