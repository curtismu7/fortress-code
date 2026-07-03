import { describe, it, expect } from 'vitest';
import { resolveTarget } from '../providers/target';
import { PolicyViolationError, type PolicyEntry } from '@fortress-code/shared';

const localEntry: PolicyEntry = {
  id: 'gpt-oss-20b', displayName: 'gpt-oss', provider: 'local', agentCapable: true,
  origin: { org: 'OpenAI', country: 'US' }, hosting: { kind: 'on-device' },
  approved: true, local: { catalogId: 'gpt-oss-20b' },
};

describe('resolveTarget (local)', () => {
  it('builds a local llama-server target with no auth and no bodyExtra', () => {
    const t = resolveTarget(localEntry, { localEndpoint: 'http://127.0.0.1:5599' });
    expect(t.url).toBe('http://127.0.0.1:5599/v1/chat/completions');
    expect(t.headers['content-type']).toBe('application/json');
    expect(t.headers.authorization).toBeUndefined();
    expect(t.bodyExtra).toEqual({});
    expect(t.model).toBeUndefined(); // llama-server ignores model
  });

  it('throws if the local endpoint is missing', () => {
    expect(() => resolveTarget(localEntry, {})).toThrow(/endpoint/i);
  });

  it('throws PolicyViolationError before building for a disallowed entry', () => {
    const bad = { ...localEntry, approved: false };
    expect(() => resolveTarget(bad, { localEndpoint: 'http://x' })).toThrow(PolicyViolationError);
  });
});
