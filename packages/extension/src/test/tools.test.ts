import { describe, it, expect } from 'vitest';
import { resolveInWorkspace, PathEscapeError, TOOL_SCHEMAS } from '../agent/tools';

describe('resolveInWorkspace', () => {
  it('resolves inside the workspace', () => {
    expect(resolveInWorkspace('/ws', 'src/a.ts')).toBe('/ws/src/a.ts');
  });
  it('blocks .. escape and absolute paths', () => {
    expect(() => resolveInWorkspace('/ws', '../etc/passwd')).toThrow(PathEscapeError);
    expect(() => resolveInWorkspace('/ws', '/etc/passwd')).toThrow(PathEscapeError);
    expect(() => resolveInWorkspace('/ws', 'a/../../x')).toThrow(PathEscapeError);
  });
});

describe('TOOL_SCHEMAS', () => {
  it('exposes exactly the eight agent tools', () => {
    const names = TOOL_SCHEMAS.map((t: any) => t.function.name).sort();
    expect(names).toEqual(['create_file', 'edit_file', 'list_files', 'read_file', 'remember', 'run_command', 'search', 'web_search']);
  });
});
