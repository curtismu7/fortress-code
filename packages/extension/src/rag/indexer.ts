import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { VectorStore } from './store';
import { chunkFile } from './chunker';

export const MAX_FILE_BYTES = 512_000;
export const MAX_FILES = 4000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'build', 'coverage']);

export interface IndexProgress { filesDone: number; filesTotal: number; chunksDone: number; capped: boolean }

export function sha(text: string): string { return createHash('sha256').update(text).digest('hex'); }

export function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(root, abs, out); }
    else if (entry.isFile()) out.push(relative(root, abs).split(sep).join('/'));
  }
}

export function listFiles(root: string): string[] {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    const out: string[] = [];
    walk(root, root, out);
    return out;
  }
}

export async function indexWorkspace(
  root: string,
  store: VectorStore,
  embed: (texts: string[]) => Promise<number[][]>,
  onProgress: (p: IndexProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const allFiles = listFiles(root);
  const capped = allFiles.length > MAX_FILES;
  const present = new Set(allFiles); // full eligible set — drop only files truly gone from disk
  const toProcess = capped ? allFiles.slice(0, MAX_FILES) : allFiles;
  let filesDone = 0, chunksDone = 0;

  for (const rel of toProcess) {
    if (signal?.aborted) return;
    filesDone++;
    const abs = join(root, rel);
    let buf: Buffer;
    try {
      const st = statSync(abs);
      if (st.size > MAX_FILE_BYTES) { onProgress({ filesDone, filesTotal: toProcess.length, chunksDone, capped }); continue; }
      buf = readFileSync(abs);
    } catch { continue; }
    if (isProbablyBinary(buf)) { onProgress({ filesDone, filesTotal: toProcess.length, chunksDone, capped }); continue; }
    const text = buf.toString('utf8');
    const h = sha(text);
    if (store.hashOf(rel) === h) { onProgress({ filesDone, filesTotal: toProcess.length, chunksDone, capped }); continue; }
    const chunks = chunkFile(text);
    if (chunks.length === 0) { store.replaceFile(rel, h, []); onProgress({ filesDone, filesTotal: toProcess.length, chunksDone, capped }); continue; }
    const vectors = await embed(chunks.map((c) => `search_document: ${c.text}`));
    store.replaceFile(rel, h, chunks.map((c, i) => ({ meta: { startLine: c.startLine, endLine: c.endLine }, vector: vectors[i] })));
    chunksDone += chunks.length;
    onProgress({ filesDone, filesTotal: toProcess.length, chunksDone, capped });
  }

  // drop files removed from disk / no longer eligible
  for (const gone of store.files().filter((f) => !present.has(f))) store.removeFile(gone);
  store.save();
}
