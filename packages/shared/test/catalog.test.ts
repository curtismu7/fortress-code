import { describe, it, expect } from 'vitest';
import { loadCatalog } from '../src/catalog';

describe('catalog', () => {
  it('loads and validates all seven models', () => {
    const models = loadCatalog();
    expect(models).toHaveLength(7);
    const ids = models.map((m) => m.id);
    expect(ids).toContain('gemma-3-12b-qat');
    expect(ids).toContain('gpt-oss-20b');
    expect(ids).toContain('nomic-embed-text-v1.5');
  });

  it('every model pins sha256 for every file', () => {
    for (const m of loadCatalog()) {
      expect(m.files.length).toBeGreaterThan(0);
      for (const f of m.files) expect(f.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('toolCalling flags match spec (12B+ gemma and gpt-oss only)', () => {
    const byId = Object.fromEntries(loadCatalog().map((m) => [m.id, m.toolCalling]));
    expect(byId['gemma-3-1b-qat']).toBe(false);
    expect(byId['gemma-3-4b-qat']).toBe(false);
    expect(byId['gemma-3-12b-qat']).toBe(true);
    expect(byId['gemma-3-27b-qat']).toBe(true);
    expect(byId['gpt-oss-20b']).toBe(true);
    expect(byId['gpt-oss-120b']).toBe(true);
  });
});

describe('embedding model', () => {
  it('catalog has nomic embed with dims 768 and embedding flag', () => {
    const m = loadCatalog().find((x) => x.id === 'nomic-embed-text-v1.5');
    expect(m).toBeTruthy();
    expect(m!.embedding).toBe(true);
    expect(m!.dims).toBe(768);
    expect(m!.files[0].name).toMatch(/\.gguf$/);
  });
});
