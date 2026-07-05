import { describe, it, expect } from 'vitest';
import { loadPolicy, localEntries, openRouterEntries, explainBlock } from '../src/policy';
import { isAllowed } from '../src/governance';

describe('policy registry', () => {
  it('maps every local catalog model to an approved US on-device entry', () => {
    const locals = localEntries();
    expect(locals.length).toBe(7); // the seven catalog models
    for (const e of locals) {
      expect(e.provider).toBe('local');
      expect(e.origin.country).toBe('US');
      expect(e.hosting.kind).toBe('on-device');
      expect(isAllowed(e)).toBe(true);
      expect(e.local?.catalogId).toBe(e.id);
    }
    const orgs = new Set(locals.map((e) => e.origin.org));
    expect(orgs).toContain('Google');   // gemma
    expect(orgs).toContain('OpenAI');   // gpt-oss
    expect(orgs).toContain('Nomic AI'); // embedding
  });

  it('every OpenRouter entry is US-origin with pinned US providers and passes the guard', () => {
    const ors = openRouterEntries();
    expect(ors.length).toBeGreaterThan(0);
    for (const e of ors) {
      expect(e.provider).toBe('openrouter');
      expect(e.origin.country).toBe('US');
      expect(e.hosting.kind === 'openrouter' && e.hosting.usProviders.length).toBeTruthy();
      expect(e.openrouter?.slug).toMatch(/.+\/.+/);
      expect(isAllowed(e)).toBe(true);
    }
  });

  it('loadPolicy is local + openrouter combined', () => {
    expect(loadPolicy().length).toBe(localEntries().length + openRouterEntries().length);
  });

  it('explainBlock names known non-US developers and is null for approved slugs', () => {
    expect(explainBlock('deepseek/deepseek-chat')).toMatch(/China/i);
    expect(explainBlock('qwen/qwen-2.5-72b-instruct')).toMatch(/China/i);
    expect(explainBlock('mistralai/mistral-large')).toMatch(/France/i);
    expect(explainBlock('openai/gpt-4o')).toBeNull();       // it's approved
    expect(explainBlock('some/unknown-model')).toMatch(/not on the .*approved/i);
  });

  it('policy exposes the embed model as an approved US entry', () => {
    const e = loadPolicy().find((x) => x.id === 'nomic-embed-text-v1.5');
    expect(e).toBeTruthy();
    expect(isAllowed(e!)).toBe(true);
    expect(e!.origin).toEqual({ org: 'Nomic AI', country: 'US' });
  });
});
