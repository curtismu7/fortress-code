import { describe, it, expect } from 'vitest';
import { chunkFile } from '../rag/chunker';

describe('chunkFile', () => {
  it('windows with overlap and 1-based line numbers', () => {
    const text = Array.from({ length: 120 }, (_, i) => `line${i + 1}`).join('\n');
    const chunks = chunkFile(text, 50, 10);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(50);
    expect(chunks[1].startLine).toBe(41); // step = 40
    expect(chunks.at(-1)!.endLine).toBe(120);
  });
  it('returns one chunk for a short file', () => {
    const chunks = chunkFile('a\nb\nc', 50, 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 3 });
  });
  it('drops whitespace-only windows', () => {
    expect(chunkFile('\n\n   \n', 50, 10)).toEqual([]);
  });
});
