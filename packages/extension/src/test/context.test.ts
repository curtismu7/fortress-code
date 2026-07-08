import { describe, it, expect } from 'vitest';
import { parseMentions, capContent, buildContextPreamble, hasAttachedContext, contextAttachmentHint, type ChatContext } from '../context';

describe('parseMentions', () => {
  it('extracts @paths and dedupes', () => {
    expect(parseMentions('look at @src/a.ts and @src/a.ts and @b.js please')).toEqual(['src/a.ts', 'b.js']);
  });
  it('returns [] when none', () => expect(parseMentions('no mentions here')).toEqual([]));
  it('does not treat an email as a mention', () => expect(parseMentions('mail me at a@b.com')).toEqual([]));
});

describe('capContent', () => {
  it('passes short content through untruncated', () => {
    expect(capContent('hello', 100)).toEqual({ content: 'hello', truncated: false });
  });
  it('truncates over the cap and flags it', () => {
    const r = capContent('x'.repeat(50), 10);
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(10 + 20); // + a short marker
    expect(r.content).toContain('truncated');
  });
  it('caps by BYTES for multibyte content', () => {
    const r = capContent('あ'.repeat(20000), 30000); // 3 bytes each
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(30000 + 20);
  });
});

describe('buildContextPreamble', () => {
  const base: ChatContext = { file: null, selection: null, mentions: [] };
  it('is empty when no context', () => expect(buildContextPreamble(base)).toBe(''));
  it('includes active file, selection, mention, and diagnostics', () => {
    const ctx: ChatContext = {
      file: { id: 'f', relPath: 'src/app.ts', language: 'typescript', content: 'const a=1;', truncated: false, diagnostics: ['12:5 error TS2345 nope'] },
      selection: { id: 's', relPath: 'src/app.ts', startLine: 10, endLine: 12, text: 'return x;' },
      mentions: [{ id: 'm', relPath: 'src/b.ts', language: 'typescript', content: 'export const b=2;', truncated: true, diagnostics: [] }],
    };
    const out = buildContextPreamble(ctx);
    expect(out).toContain('src/app.ts');
    expect(out).toContain('const a=1;');
    expect(out).toContain('L10');
    expect(out).toContain('return x;');
    expect(out).toContain('src/b.ts');
    expect(out).toContain('truncated');
    expect(out).toContain('TS2345');
  });
});

describe('hasAttachedContext', () => {
  it('is false for empty context', () => {
    expect(hasAttachedContext({ file: null, selection: null, mentions: [] })).toBe(false);
  });
  it('is true when a file is attached', () => {
    expect(hasAttachedContext({
      file: { id: 'f', relPath: 'a.ts', language: 'ts', content: 'x', truncated: false, diagnostics: [] },
      selection: null,
      mentions: [],
    })).toBe(true);
  });
});

describe('contextAttachmentHint', () => {
  it('suggests @codebase in ask mode with a folder', () => {
    expect(contextAttachmentHint({ hasFolder: true, agentMode: false, agentCapable: false })).toMatch(/@codebase/);
  });
  it('warns when agent mode is on a non-agent model', () => {
    expect(contextAttachmentHint({ hasFolder: true, agentMode: true, agentCapable: false })).toMatch(/12B/);
  });
  it('is null when agent mode can use tools', () => {
    expect(contextAttachmentHint({ hasFolder: true, agentMode: true, agentCapable: true })).toBeNull();
  });
  it('is null without a folder', () => {
    expect(contextAttachmentHint({ hasFolder: false, agentMode: false, agentCapable: false })).toBeNull();
  });
});
