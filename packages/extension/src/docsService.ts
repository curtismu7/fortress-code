// packages/extension/src/docsService.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonClient } from './daemon';
import { VectorStore } from './rag/store';
import { chunkFile } from './rag/chunker';
import { retrieve } from './rag/retriever';
import { sha } from './rag/indexer';
import { extractDocText, readDocLines, DOC_EXTENSIONS } from './docExtract';

export interface DocsIndexResult {
  indexed: number;
  skipped: string[];
  errors: { file: string; reason: string }[];
}

/** Document RAG — separate index from workspace code (@docs). */
export class DocsService {
  private store: VectorStore;
  private extractDir: string;

  constructor(private storeDir: string, private dims = 768, private model = 'nomic-embed-text-v1.5') {
    this.store = VectorStore.open(join(storeDir, 'docs'), dims, model);
    this.extractDir = join(storeDir, 'extracts');
  }

  stats(): { files: number; chunks: number } { return this.store.stats(); }
  hasIndex(): boolean { return this.store.stats().chunks > 0; }

  /** Index selected documents (txt/md/json/csv/pdf) into the docs vector store. */
  async indexFiles(
    client: DaemonClient,
    paths: string[],
    onProgress?: (done: number, total: number, file?: string) => void,
  ): Promise<DocsIndexResult> {
    const result: DocsIndexResult = { indexed: 0, skipped: [], errors: [] };
    const started = await client.embedStart();
    if (!started.ok) throw new Error('embedding server could not start (check RAM or download the embed model)');
    try {
      let n = 0;
      for (const abs of paths) {
        n++;
        onProgress?.(n, paths.length, abs);
        if (!existsSync(abs)) {
          result.errors.push({ file: abs, reason: 'File not found.' });
          continue;
        }
        const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase();
        if (!DOC_EXTENSIONS.has(ext)) {
          result.skipped.push(abs);
          continue;
        }
        const extracted = await extractDocText(abs, this.extractDir);
        if ('error' in extracted) {
          result.errors.push({ file: abs, reason: extracted.error });
          continue;
        }
        const rel = abs;
        const h = sha(extracted.text);
        if (this.store.hashOf(rel) === h) continue;
        const chunks = chunkFile(extracted.text);
        if (!chunks.length) {
          this.store.replaceFile(rel, h, []);
          continue;
        }
        const vectors = await client.embed(chunks.map((c) => `search_document: ${c.text}`));
        this.store.replaceFile(rel, h, chunks.map((c, i) => ({ meta: { startLine: c.startLine, endLine: c.endLine }, vector: vectors[i] })));
        result.indexed++;
      }
      this.store.save();
      return result;
    } finally {
      await client.embedStop().catch(() => {});
    }
  }

  /** Retrieve doc chunks for @docs queries. */
  async retrieveHits(client: DaemonClient, query: string): Promise<{ file: string; startLine: number; endLine: number; text: string }[]> {
    if (!this.hasIndex()) return [];
    const started = await client.embedStart();
    if (!started.ok) return [];
    try {
      const hits = await retrieve(query, this.store, (t) => client.embed(t), 6);
      return hits.map((h) => ({
        ...h,
        text: readDocLines(h.file, h.startLine, h.endLine, this.extractDir),
      })).filter((h) => h.text);
    } finally {
      await client.embedStop().catch(() => {});
    }
  }
}
