import { describe, it, expect } from 'vitest';
import { Session } from '../chat/session';

describe('Session', () => {
  it('builds request messages with system prompt first', () => {
    const s = new Session();
    s.addUser('hi'); s.addAssistant('hello');
    const msgs = s.toRequestMessages('SYS');
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(msgs).toHaveLength(3);
  });

  it('round-trips through a Memento-like store', () => {
    const store = new Map<string, unknown>();
    const memento = { get: (k: string) => store.get(k), update: (k: string, v: unknown) => (store.set(k, v), Promise.resolve()) } as any;
    const s = new Session();
    s.addUser('persisted');
    s.save(memento);
    expect(Session.load(memento).messages[0].content).toBe('persisted');
  });

  it('drops a poisoned persisted history rather than throwing', () => {
    const store = new Map<string, unknown>([['fortressCode.session', [{ content: 'Request failed with status code 503' }]]]);
    const memento = { get: (k: string) => store.get(k), update: () => Promise.resolve() } as any;
    expect(Session.load(memento).messages).toEqual([]);
  });
});
