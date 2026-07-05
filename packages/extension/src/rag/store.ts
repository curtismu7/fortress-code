import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ChunkMeta { file: string; startLine: number; endLine: number; fileHash: string }
export interface Retrieved extends ChunkMeta { score: number }
interface MetaDoc { dims: number; model: string; chunks: ChunkMeta[]; emptyFiles?: Record<string, string> }

function normalize(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export class VectorStore {
  private constructor(
    private dir: string,
    public dims: number,
    private model: string,
    private chunks: ChunkMeta[],
    private vectors: Float32Array, // row-aligned to chunks, length = chunks.length * dims
    private emptyFiles: Record<string, string> = {},
  ) {}

  static open(dir: string, dims: number, model: string): VectorStore {
    const metaPath = join(dir, 'meta.json');
    const vecPath = join(dir, 'vectors.bin');
    if (existsSync(metaPath) && existsSync(vecPath)) {
      const meta: MetaDoc = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meta.dims === dims && meta.model === model) {
        const buf = readFileSync(vecPath);
        // buf.buffer is Node's shared allocation pool; buf.byteOffset is not
        // guaranteed to be a multiple of 4, and Float32Array's constructor
        // throws ("start offset ... should be a multiple of 4") if it isn't.
        // Slice out just this buffer's bytes into their own ArrayBuffer so
        // the Float32Array view always starts at offset 0.
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const vectors = new Float32Array(ab);
        return new VectorStore(dir, dims, model, meta.chunks, vectors, meta.emptyFiles ?? {});
      }
    }
    return new VectorStore(dir, dims, model, [], new Float32Array(0), {});
  }

  hashOf(file: string): string | null {
    const c = this.chunks.find((x) => x.file === file);
    return c ? c.fileHash : (this.emptyFiles[file] ?? null);
  }

  private rebuild(chunks: ChunkMeta[], vecRows: Float32Array[]): void {
    const flat = new Float32Array(vecRows.length * this.dims);
    vecRows.forEach((row, i) => flat.set(row, i * this.dims));
    this.chunks = chunks;
    this.vectors = flat;
  }

  private rows(): Float32Array[] {
    const out: Float32Array[] = [];
    for (let i = 0; i < this.chunks.length; i++) out.push(this.vectors.subarray(i * this.dims, (i + 1) * this.dims));
    return out;
  }

  replaceFile(file: string, fileHash: string, rows: { meta: { startLine: number; endLine: number }; vector: number[] }[]): void {
    for (const r of rows) {
      if (r.vector.length !== this.dims) {
        throw new Error(`vector dims mismatch: expected ${this.dims}, got ${r.vector.length}`);
      }
    }
    const keepChunks: ChunkMeta[] = [];
    const keepVecs: Float32Array[] = [];
    const existing = this.rows();
    this.chunks.forEach((c, i) => { if (c.file !== file) { keepChunks.push(c); keepVecs.push(existing[i]); } });
    for (const r of rows) {
      keepChunks.push({ file, startLine: r.meta.startLine, endLine: r.meta.endLine, fileHash });
      keepVecs.push(normalize(r.vector));
    }
    this.rebuild(keepChunks, keepVecs);
    if (rows.length === 0) {
      this.emptyFiles[file] = fileHash;
    } else {
      delete this.emptyFiles[file];
    }
  }

  removeFile(file: string): void {
    const existing = this.rows();
    const keepChunks: ChunkMeta[] = [];
    const keepVecs: Float32Array[] = [];
    this.chunks.forEach((c, i) => { if (c.file !== file) { keepChunks.push(c); keepVecs.push(existing[i]); } });
    this.rebuild(keepChunks, keepVecs);
    delete this.emptyFiles[file];
  }

  topK(queryVec: number[], k: number): Retrieved[] {
    const q = normalize(queryVec);
    const scored = this.chunks.map((c, i) => {
      let dot = 0;
      const base = i * this.dims;
      for (let j = 0; j < this.dims; j++) dot += this.vectors[base + j] * q[j];
      return { ...c, score: dot };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  stats(): { files: number; chunks: number } {
    return { files: new Set(this.chunks.map((c) => c.file)).size, chunks: this.chunks.length };
  }

  files(): string[] {
    return [...new Set([...this.chunks.map((c) => c.file), ...Object.keys(this.emptyFiles)])];
  }

  save(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const meta: MetaDoc = { dims: this.dims, model: this.model, chunks: this.chunks, emptyFiles: this.emptyFiles };
    writeFileSync(join(this.dir, 'meta.json'), JSON.stringify(meta));
    writeFileSync(join(this.dir, 'vectors.bin'), Buffer.from(this.vectors.buffer, this.vectors.byteOffset, this.vectors.byteLength));
  }
}
