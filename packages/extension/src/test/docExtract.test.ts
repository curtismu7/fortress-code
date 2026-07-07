import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractDocText, readDocLines, docExtractCachePath } from '../docExtract';

describe('docExtract', () => {
  it('reads plain text files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-doc-'));
    const path = join(dir, 'note.txt');
    writeFileSync(path, 'line one\nline two\n', 'utf8');
    const r = await extractDocText(path, join(dir, 'cache'));
    expect('text' in r && r.text).toBe('line one\nline two\n');
  });

  it('readDocLines returns a slice from a text file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-doc-'));
    const path = join(dir, 'note.txt');
    writeFileSync(path, 'a\nb\nc\n', 'utf8');
    expect(readDocLines(path, 2, 2, join(dir, 'cache'))).toBe('b');
  });

  it('rejects unsupported extensions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-doc-'));
    const path = join(dir, 'data.bin');
    writeFileSync(path, 'x', 'utf8');
    const r = await extractDocText(path, join(dir, 'cache'));
    expect('error' in r).toBe(true);
  });

  it('writes PDF extract cache path for line reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-doc-'));
    const cache = join(dir, 'cache');
    const pdf = join(dir, 'sample.pdf');
    writeFileSync(pdf, '%PDF-1.4 fake', 'utf8');
    const cachePath = docExtractCachePath(cache, pdf);
    mkdirSync(cache, { recursive: true });
    writeFileSync(cachePath, 'cached line 1\ncached line 2\n', 'utf8');
    expect(existsSync(cachePath)).toBe(true);
    expect(readDocLines(pdf, 1, 1, cache)).toBe('cached line 1');
  });
});
