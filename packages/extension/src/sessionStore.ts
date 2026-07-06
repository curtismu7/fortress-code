import { randomUUID } from 'node:crypto';
import { validateHistory, type ChatMessage } from '@fortress-code/shared';
import { Session } from './chat/session';

export interface ChatMeta { id: string; title: string; folder?: string; personaId?: string }
interface MementoLike { get(key: string): unknown; update(key: string, value: unknown): Thenable<void> | void }
const KEY = 'fortressCode.chats';
const LEGACY = 'fortressCode.session';

export class SessionStore {
  activeId: string;
  private order: string[];
  private titles: Map<string, string>;
  private folders: Map<string, string>;
  private personaIds: Map<string, string>;
  private sessions: Map<string, Session>;

  private constructor(
    private state: MementoLike, activeId: string, order: string[],
    titles: Map<string, string>, folders: Map<string, string>, personaIds: Map<string, string>,
    sessions: Map<string, Session>,
  ) {
    this.activeId = activeId; this.order = order; this.titles = titles;
    this.folders = folders; this.personaIds = personaIds; this.sessions = sessions;
  }

  metas(): ChatMeta[] {
    return this.order.map((id) => ({
      id,
      title: this.titles.get(id) || 'New chat',
      folder: this.folders.get(id),
      personaId: this.personaIds.get(id),
    }));
  }

  listFolders(): string[] {
    return [...new Set([...this.folders.values()].filter(Boolean))].sort();
  }

  setFolder(chatId: string, folder: string | undefined): void {
    if (!this.sessions.has(chatId)) return;
    if (folder?.trim()) this.folders.set(chatId, folder.trim());
    else this.folders.delete(chatId);
    this.save();
  }

  setPersona(chatId: string, personaId: string | undefined): void {
    if (!this.sessions.has(chatId)) return;
    if (personaId) this.personaIds.set(chatId, personaId);
    else this.personaIds.delete(chatId);
    this.save();
  }

  active(): Session { return this.sessions.get(this.activeId)!; }
  messagesById(): Record<string, ChatMessage[]> {
    const result: Record<string, ChatMessage[]> = {};
    for (const [id, session] of this.sessions) result[id] = session.messages;
    return result;
  }

  newChat(): void {
    const id = randomUUID();
    this.order.unshift(id); this.titles.set(id, 'New chat'); this.sessions.set(id, new Session());
    this.activeId = id; this.save();
  }
  switchTo(id: string): void { if (this.sessions.has(id)) { this.activeId = id; this.save(); } }
  fork(index: number): void {
    const src = this.sessions.get(this.activeId);
    if (!src || src.messages.length === 0 || index < 0) return;
    const upTo = Math.min(index, src.messages.length - 1);
    const copy = new Session();
    copy.messages = src.messages.slice(0, upTo + 1).map((m) => ({
      ...m,
      ...(m.sources ? { sources: m.sources.map((s) => ({ ...s })) } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls.map((t) => ({ ...t, function: { ...t.function } })) } : {}),
    }));
    const id = randomUUID();
    const title = ('Fork: ' + (this.titles.get(this.activeId) || 'New chat')).slice(0, 40);
    this.order.unshift(id); this.titles.set(id, title); this.sessions.set(id, copy);
    const folder = this.folders.get(this.activeId);
    if (folder) this.folders.set(id, folder);
    this.activeId = id; this.save();
  }
  touchTitle(): void {
    const first = this.active().messages.find((m) => m.role === 'user' && m.content.trim());
    if (first && (this.titles.get(this.activeId) || 'New chat') === 'New chat') {
      this.titles.set(this.activeId, first.content.trim().slice(0, 40));
    }
  }
  save(): void {
    const messagesById: Record<string, ChatMessage[]> = {};
    for (const [id, s] of this.sessions) messagesById[id] = s.messages;
    void this.state.update(KEY, { activeId: this.activeId, metas: this.metas(), messagesById });
  }

  static load(state: MementoLike): SessionStore {
    const raw = state.get(KEY) as { activeId: string; metas: ChatMeta[]; messagesById: Record<string, ChatMessage[]> } | undefined;
    if (raw && raw.metas?.length) {
      const order = raw.metas.map((m) => m.id);
      const titles = new Map(raw.metas.map((m) => [m.id, m.title] as const));
      const folders = new Map(raw.metas.filter((m) => m.folder).map((m) => [m.id, m.folder!] as const));
      const personaIds = new Map(raw.metas.filter((m) => m.personaId).map((m) => [m.id, m.personaId!] as const));
      const sessions = new Map<string, Session>();
      for (const id of order) {
        const s = new Session();
        try { s.messages = validateHistory(raw.messagesById[id] ?? []); } catch { s.messages = []; }
        sessions.set(id, s);
      }
      const activeId = sessions.has(raw.activeId) ? raw.activeId : order[0];
      return new SessionStore(state, activeId, order, titles, folders, personaIds, sessions);
    }
    const legacy = state.get(LEGACY);
    const s = new Session();
    try { if (legacy) s.messages = validateHistory(legacy); } catch { s.messages = []; }
    const id = randomUUID();
    const store = new SessionStore(state, id, [id], new Map([[id, 'New chat']]), new Map(), new Map(), new Map([[id, s]]));
    store.touchTitle();
    store.save();
    return store;
  }
}
