import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retrieve, buildCodebaseBlock } from '../rag/retriever';
import { VectorStore } from '../rag/store';

describe('retrieve', () => {
  it('embeds the query with the search_query prefix and returns nearest hits', async () => {
    const store = VectorStore.open(mkdtempSync(join(tmpdir(), 'fc-ret-')), 2, 'nomic');
    store.replaceFile('auth.ts', 'h', [{ meta: { startLine: 1, endLine: 9 }, vector: [1, 0] }]);
    store.replaceFile('math.ts', 'h', [{ meta: { startLine: 1, endLine: 9 }, vector: [0, 1] }]);
    let seen = '';
    const embed = async (t: string[]) => { seen = t[0]; return [[1, 0]]; };
    const hits = await retrieve('how does login work', store, embed, 1);
    expect(seen.startsWith('search_query: ')).toBe(true);
    expect(hits[0].file).toBe('auth.ts');
  });

  it('buildCodebaseBlock includes file:line headers', () => {
    const block = buildCodebaseBlock([{ file: 'a.ts', startLine: 2, endLine: 4, text: 'code' }]);
    expect(block).toContain('[codebase] a.ts:L2-L4');
    expect(block).toContain('code');
  });
});
