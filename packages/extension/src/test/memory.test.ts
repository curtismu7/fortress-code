import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../memory';

describe('MemoryStore', () => {
  it('persists facts and enabled flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-mem-'));
    const path = join(dir, 'memory.json');
    const store = new MemoryStore(path);
    store.save({ enabled: true, facts: ['Prefers TypeScript', 'Uses pnpm'] });
    const loaded = new MemoryStore(path).load();
    expect(loaded.enabled).toBe(true);
    expect(loaded.facts).toEqual(['Prefers TypeScript', 'Uses pnpm']);
  });

  it('preamble is empty when disabled', () => {
    expect(MemoryStore.preamble({ enabled: false, facts: ['x'] })).toBe('');
  });

  it('preamble lists enabled facts', () => {
    const p = MemoryStore.preamble({ enabled: true, facts: ['Use tabs'] });
    expect(p).toContain('[user memory');
    expect(p).toContain('- Use tabs');
  });
});
