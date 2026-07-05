import { describe, it, expect } from 'vitest';
import { buildContextPreamble, type ChatContext } from '../context';

describe('buildContextPreamble with codebase', () => {
  it('appends retrieved codebase excerpts', () => {
    const ctx: ChatContext = {
      file: null, selection: null, mentions: [],
      codebase: [{ file: 'auth.ts', startLine: 1, endLine: 3, text: 'login()' }],
    };
    const p = buildContextPreamble(ctx);
    expect(p).toContain('[codebase] auth.ts:L1-L3');
    expect(p).toContain('login()');
  });
});
