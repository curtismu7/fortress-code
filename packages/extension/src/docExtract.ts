// packages/extension/src/docExtract.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

export type DocExtractResult = { text: string } | { error: string };

export const DOC_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.pdf']);

/** Cache path for extracted PDF plain text (line-based chunking reads from here). */
export function docExtractCachePath(cacheDir: string, absPath: string): string {
  const h = createHash('sha256').update(absPath).digest('hex').slice(0, 16);
  const base = basename(absPath).replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(cacheDir, `${h}-${base}.txt`);
}

/** Read document text from disk; PDFs are extracted and cached as UTF-8. */
export async function extractDocText(absPath: string, cacheDir: string): Promise<DocExtractResult> {
  const ext = absPath.slice(absPath.lastIndexOf('.')).toLowerCase();
  if (!DOC_EXTENSIONS.has(ext)) return { error: 'Unsupported file type.' };
  if (ext === '.pdf') return extractPdf(absPath, cacheDir);
  try {
    return { text: readFileSync(absPath, 'utf8') };
  } catch {
    return { error: 'Could not read file.' };
  }
}

/** Read a line range from a text file or cached PDF extract. */
export function readDocLines(absPath: string, startLine: number, endLine: number, cacheDir: string): string {
  const ext = absPath.slice(absPath.lastIndexOf('.')).toLowerCase();
  const path = ext === '.pdf' ? docExtractCachePath(cacheDir, absPath) : absPath;
  if (!existsSync(path)) return '';
  try {
    const lines = readFileSync(path, 'utf8').split('\n');
    return lines.slice(startLine - 1, endLine).join('\n');
  } catch {
    return '';
  }
}

/** Extract plain text from a PDF via pdf-parse; rejects encrypted PDFs. */
async function extractPdf(absPath: string, cacheDir: string): Promise<DocExtractResult> {
  mkdirSync(cacheDir, { recursive: true });
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const buf = readFileSync(absPath);
    const data = await pdfParse(buf);
    const text = (data.text ?? '').trim();
    if (!text) return { error: 'PDF contains no extractable text (scanned or empty).' };
    writeFileSync(docExtractCachePath(cacheDir, absPath), text + '\n', 'utf8');
    return { text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password|encrypted/i.test(msg)) return { error: 'Encrypted PDFs are not supported.' };
    return { error: `PDF extraction failed: ${msg}` };
  }
}
