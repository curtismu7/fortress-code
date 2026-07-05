export interface Chunk { startLine: number; endLine: number; text: string }

export function chunkFile(text: string, windowLines = 50, overlap = 10): Chunk[] {
  const lines = text.split('\n');
  const step = Math.max(1, windowLines - overlap);
  const out: Chunk[] = [];
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + windowLines);
    const slice = lines.slice(start, end);
    if (slice.join('').trim().length > 0) {
      out.push({ startLine: start + 1, endLine: end, text: slice.join('\n') });
    }
    if (end === lines.length) break;
  }
  return out;
}
