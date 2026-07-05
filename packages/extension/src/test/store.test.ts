import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorStore } from '../rag/store';

const dir = () => mkdtempSync(join(tmpdir(), 'fc-store-'));

describe('VectorStore', () => {
  it('ranks by cosine and round-trips through disk', () => {
    const d = dir();
    const s = VectorStore.open(d, 2, 'nomic');
    s.replaceFile('a.ts', 'h1', [{ meta: { startLine: 1, endLine: 5 }, vector: [1, 0] }]);
    s.replaceFile('b.ts', 'h2', [{ meta: { startLine: 1, endLine: 5 }, vector: [0, 1] }]);
    s.save();

    const reloaded = VectorStore.open(d, 2, 'nomic');
    const top = reloaded.topK([1, 0], 1);
    expect(top[0].file).toBe('a.ts');
    expect(top[0].score).toBeGreaterThan(0.99);
    expect(reloaded.stats()).toEqual({ files: 2, chunks: 2 });
    expect(reloaded.hashOf('a.ts')).toBe('h1');
  });

  it('replaceFile swaps a file\'s rows; removeFile drops them', () => {
    const s = VectorStore.open(dir(), 2, 'nomic');
    s.replaceFile('a.ts', 'h1', [{ meta: { startLine: 1, endLine: 5 }, vector: [1, 0] }]);
    s.replaceFile('a.ts', 'h2', [{ meta: { startLine: 1, endLine: 9 }, vector: [1, 0] }]);
    expect(s.stats().chunks).toBe(1);
    expect(s.hashOf('a.ts')).toBe('h2');
    s.removeFile('a.ts');
    expect(s.stats()).toEqual({ files: 0, chunks: 0 });
  });

  it('replaceFile with no rows records a reusable hash for an empty file, surviving save+reopen', () => {
    const d = dir();
    const s = VectorStore.open(d, 2, 'nomic');
    s.replaceFile('empty.ts', 'h-empty', []);
    expect(s.hashOf('empty.ts')).toBe('h-empty');
    expect(s.stats()).toEqual({ files: 0, chunks: 0 });
    s.save();

    const reloaded = VectorStore.open(d, 2, 'nomic');
    expect(reloaded.hashOf('empty.ts')).toBe('h-empty');
  });

  it('replaceFile throws on a vector dims mismatch and leaves the store unchanged', () => {
    const s = VectorStore.open(dir(), 2, 'nomic');
    s.replaceFile('a.ts', 'h1', [{ meta: { startLine: 1, endLine: 5 }, vector: [1, 0] }]);
    expect(() => s.replaceFile('b.ts', 'h2', [{ meta: { startLine: 1, endLine: 5 }, vector: [1, 0, 0] }]))
      .toThrow('vector dims mismatch: expected 2, got 3');
    expect(s.stats()).toEqual({ files: 1, chunks: 1 });
  });

  it('reads correct vector values back after disk round-trip even when the Buffer is not 4-byte aligned', () => {
    const d = dir();
    const s = VectorStore.open(d, 3, 'nomic');
    // Enough rows that at least one Buffer read from the shared pool is
    // likely to land at a non-4-byte-aligned offset; the real regression
    // guard is the assertion on exact values below, not the row count.
    s.replaceFile('a.ts', 'h1', [
      { meta: { startLine: 1, endLine: 2 }, vector: [3, 4, 0] },
      { meta: { startLine: 3, endLine: 4 }, vector: [0, 0, 5] },
    ]);
    s.save();

    const reloaded = VectorStore.open(d, 3, 'nomic');
    const top = reloaded.topK([1, 0, 0], 2);
    // [3,4,0] normalizes to [0.6, 0.8, 0], dot with [1,0,0] = 0.6
    expect(top[0].score).toBeCloseTo(0.6, 5);
    // [0,0,5] normalizes to [0,0,1], dot with [1,0,0] = 0
    expect(top[1].score).toBeCloseTo(0, 5);
  });
});
