import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDevTarget } from '../providers/dev';
import { DEV_PRESETS } from '../devPresets';

describe('resolveDevTarget (governance bypass)', () => {
  it('builds a Fireworks OpenAI-compatible target with no provider pin', () => {
    const t = resolveDevTarget('accounts/fireworks/models/glm-5p2', 'fw_test');
    expect(t.url).toBe('https://api.fireworks.ai/inference/v1/chat/completions');
    expect(t.headers.authorization).toBe('Bearer fw_test');
    expect(t.headers['content-type']).toBe('application/json');
    expect(t.model).toBe('accounts/fireworks/models/glm-5p2');
    expect(t.bodyExtra).toEqual({}); // NO provider pin — this is the bypass
  });

  it('throws when the key is missing', () => {
    expect(() => resolveDevTarget('accounts/fireworks/models/glm-5p2', '')).toThrow(/key/i);
  });

  it('does NOT reference assertAllowed (the bypass must be guard-free)', () => {
    const src = readFileSync(join(__dirname, '..', 'providers', 'dev.ts'), 'utf8');
    expect(src).not.toMatch(/assertAllowed\s*\(/); // no guard CALL (comments may mention it)
    expect(src).not.toMatch(/from ['"][^'"]*governance/); // no governance import
  });
});

describe('DEV_PRESETS', () => {
  it('includes GLM-5.2 with the verified slug', () => {
    expect(DEV_PRESETS.some((p) => p.slug === 'accounts/fireworks/models/glm-5p2')).toBe(true);
    for (const p of DEV_PRESETS) expect(p.slug).toMatch(/^accounts\/fireworks\/models\/.+/);
  });
});
