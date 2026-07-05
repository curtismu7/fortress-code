import type { VectorStore } from './store';

export interface CodeHit { file: string; startLine: number; endLine: number }

export async function retrieve(
  query: string,
  store: VectorStore,
  embed: (texts: string[]) => Promise<number[][]>,
  k = 8,
): Promise<CodeHit[]> {
  const [q] = await embed([`search_query: ${query}`]);
  return store.topK(q, k).map((h) => ({ file: h.file, startLine: h.startLine, endLine: h.endLine }));
}

export function buildCodebaseBlock(hits: { file: string; startLine: number; endLine: number; text: string }[]): string {
  if (hits.length === 0) return '';
  const blocks = hits.map((h) => `[codebase] ${h.file}:L${h.startLine}-L${h.endLine}\n\`\`\`\n${h.text}\n\`\`\``);
  return `The following repository excerpts were retrieved for this question:\n\n${blocks.join('\n\n')}`;
}
