import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProbablyBinary, sha, indexWorkspace, MAX_FILE_BYTES } from '../rag/indexer';
import { VectorStore } from '../rag/store';

describe('indexer helpers', () => {
  it('detects binary by NUL byte', () => {
    expect(isProbablyBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
    expect(isProbablyBinary(Buffer.from('hello world'))).toBe(false);
  });
  it('sha is stable', () => expect(sha('x')).toBe(sha('x')));
});

describe('indexWorkspace incremental', () => {
  it('embeds changed files and skips unchanged ones on re-run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-idx-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    const store = VectorStore.open(mkdtempSync(join(tmpdir(), 'fc-idxstore-')), 2, 'nomic');

    let calls = 0;
    const embed = async (texts: string[]) => { calls += texts.length; return texts.map(() => [1, 0]); };
    await indexWorkspace(root, store, embed, () => {});
    expect(calls).toBeGreaterThan(0);
    expect(store.stats().chunks).toBeGreaterThan(0);

    const before = calls;
    await indexWorkspace(root, store, embed, () => {}); // nothing changed
    expect(calls).toBe(before); // unchanged file skipped, no new embed calls
  });

  it('drops a file removed from disk while retaining a file that still exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-idx-drop-'));
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
    const store = VectorStore.open(mkdtempSync(join(tmpdir(), 'fc-idxstore-drop-')), 2, 'nomic');
    const embed = async (texts: string[]) => texts.map(() => [1, 0]);

    await indexWorkspace(root, store, embed, () => {});
    expect(store.files().sort()).toEqual(['a.ts', 'b.ts']);

    unlinkSync(join(root, 'b.ts'));
    await indexWorkspace(root, store, embed, () => {});

    expect(store.files()).toEqual(['a.ts']);
    expect(store.stats().files).toBe(1);
  });
});
