import { describe, it, expect } from 'vitest';
import { Prefs } from '../prefs';

function mem() {
  const m = new Map<string, unknown>();
  return { get: (k: string) => m.get(k), update: (k: string, v: unknown) => void m.set(k, v) };
}

describe('Prefs prompts', () => {
  it('save appends, replace by id, delete removes', () => {
    const p = new Prefs(mem());
    p.savePrompt({ id: 'a', title: 'T', text: 'hello {name}' });
    p.savePrompt({ id: 'b', title: 'U', text: 'x' });
    p.savePrompt({ id: 'a', title: 'T2', text: 'bye' });
    expect(p.prompts().map((x) => x.title)).toEqual(['T2', 'U']);
    p.deletePrompt('b');
    expect(p.prompts()).toHaveLength(1);
  });
  it('persists through the memento', () => {
    const state = mem();
    new Prefs(state).savePrompt({ id: 'a', title: 'T', text: 'x' });
    expect(new Prefs(state).prompts()).toHaveLength(1);
  });
});

describe('Prefs params', () => {
  it('stores only valid set keys', () => {
    const p = new Prefs(mem());
    p.setParams({ temperature: 0.7, top_p: 5, max_tokens: -1 } as any);
    expect(p.params()).toEqual({ temperature: 0.7 }); // top_p out of range, max_tokens invalid
  });
  it('empty params round-trips as {}', () => {
    const p = new Prefs(mem());
    p.setParams({});
    expect(p.params()).toEqual({});
  });
});
