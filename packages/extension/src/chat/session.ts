import type { Memento } from 'vscode';
import { validateHistory, type ChatMessage } from '@fortress-code/shared';

const KEY = 'fortressCode.session';

export class Session {
  messages: ChatMessage[] = [];

  addUser(text: string): void { this.messages.push({ role: 'user', content: text }); }
  addAssistant(text: string): void { this.messages.push({ role: 'assistant', content: text }); }
  addToolExchange(assistant: ChatMessage, results: ChatMessage[]): void { this.messages.push(assistant, ...results); }
  clear(): void { this.messages = []; }

  toRequestMessages(systemPrompt: string): ChatMessage[] {
    return validateHistory([{ role: 'system', content: systemPrompt }, ...this.messages]);
  }

  save(state: Memento): void { void state.update(KEY, this.messages); }

  static load(state: Memento): Session {
    const s = new Session();
    try { s.messages = validateHistory(state.get(KEY) ?? []); } catch { s.messages = []; }
    return s;
  }
}
