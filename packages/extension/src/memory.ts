// packages/extension/src/memory.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface MemoryFile { enabled: boolean; facts: string[] }

const DEFAULT: MemoryFile = { enabled: false, facts: [] };

/** Load and save local user memory facts (privacy-forward, off by default). */
export class MemoryStore {
  constructor(private filePath: string) {}

  /** Read memory from disk. */
  load(): MemoryFile {
    try {
      if (!existsSync(this.filePath)) return { ...DEFAULT };
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as MemoryFile;
      if (!raw || typeof raw !== 'object') return { ...DEFAULT };
      return {
        enabled: !!raw.enabled,
        facts: Array.isArray(raw.facts) ? raw.facts.filter((f) => typeof f === 'string' && f.trim()) : [],
      };
    } catch {
      return { ...DEFAULT };
    }
  }

  /** Persist memory to disk. */
  save(data: MemoryFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  /** Format enabled facts for the system preamble. */
  static preamble(data: MemoryFile): string {
    if (!data.enabled || !data.facts.length) return '';
    return `[user memory — facts the user asked you to remember]\n${data.facts.map((f) => `- ${f}`).join('\n')}`;
  }
}
