export interface SavedPrompt { id: string; title: string; text: string }
export interface Params { temperature?: number; top_p?: number; max_tokens?: number }
export interface MementoLike { get(key: string): unknown; update(key: string, value: unknown): unknown }

const PROMPTS_KEY = 'fortressCode.prompts';
const PARAMS_KEY = 'fortressCode.params';

const RANGES: Record<keyof Params, (v: number) => boolean> = {
  temperature: (v) => v >= 0 && v <= 2,
  top_p: (v) => v >= 0 && v <= 1,
  max_tokens: (v) => Number.isInteger(v) && v > 0,
};

export class Prefs {
  constructor(private state: MementoLike) {}

  prompts(): SavedPrompt[] {
    const raw = this.state.get(PROMPTS_KEY);
    return Array.isArray(raw) ? raw.filter((p): p is SavedPrompt =>
      !!p && typeof p.id === 'string' && typeof p.title === 'string' && typeof p.text === 'string') : [];
  }
  savePrompt(p: SavedPrompt): void {
    const list = this.prompts();
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = p; else list.push(p);
    void this.state.update(PROMPTS_KEY, list);
  }
  deletePrompt(id: string): void {
    void this.state.update(PROMPTS_KEY, this.prompts().filter((x) => x.id !== id));
  }

  params(): Params {
    const raw = this.state.get(PARAMS_KEY);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Params) : {};
  }
  setParams(p: Params): void {
    const out: Params = {};
    for (const key of Object.keys(RANGES) as (keyof Params)[]) {
      const v = p[key];
      if (typeof v === 'number' && !Number.isNaN(v) && RANGES[key](v)) out[key] = v;
    }
    void this.state.update(PARAMS_KEY, out);
  }
}
