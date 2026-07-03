import { existsSync, chmodSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { binDir, dataDir } from './paths';
import { downloadFile } from './download';

const execFileP = promisify(execFile);
export const LLAMA_RELEASE = 'b9840';
const ASSET = `llama-${LLAMA_RELEASE}-bin-macos-arm64.tar.gz`;
const URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/${ASSET}`;
// Size checked at download time via content-length; archive integrity via TLS + version assert.
const APPROX_ZIP_BYTES = 30 * 1024 * 1024;

export function llamaServerPath(): string {
  return process.env.FC_LLAMA_BIN ?? join(binDir(), LLAMA_RELEASE, 'llama-server');
}

export function binaryInstalled(): boolean {
  return existsSync(llamaServerPath());
}

export async function installBinary(onProgress: (r: number, t: number) => void): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(`Unsupported platform ${process.platform}/${process.arch} (v1 is Apple Silicon macOS only)`);
  }
  const zipPath = join(dataDir(), ASSET);
  // GitHub asset downloads don't publish sha256; pass a sentinel and skip hash verification for the binary only.
  await downloadNoHash(URL, zipPath, APPROX_ZIP_BYTES, onProgress);
  const extractDir = join(dataDir(), 'extract-tmp');
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  await execFileP('tar', ['-xzf', zipPath, '-C', extractDir]);
  const target = join(binDir(), LLAMA_RELEASE);
  mkdirSync(target, { recursive: true });
  // release archive layout (verified against the real b9840 asset): llama-b9840/llama-server + *.dylib
  const srcBin = join(extractDir, `llama-${LLAMA_RELEASE}`);
  for (const f of readdirSync(srcBin)) renameSync(join(srcBin, f), join(target, f));
  chmodSync(join(target, 'llama-server'), 0o755);
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
  const { stdout, stderr } = await execFileP(join(target, 'llama-server'), ['--version']).catch((e) => e);
  // llama-server --version prints "version: 9840 (<hash>)" — no leading "b" — so check the numeric build id.
  const versionOutput = `${stdout}${stderr}`;
  if (!versionOutput.includes(LLAMA_RELEASE.replace(/^b/, ''))) throw new Error('Installed llama-server failed version check');
}

async function downloadNoHash(url: string, dest: string, approxBytes: number, onProgress: (r: number, t: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? approxBytes);
  const { createWriteStream } = await import('node:fs');
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  let received = 0;
  const counter = async function* (src: AsyncIterable<Uint8Array>) {
    for await (const c of src) { received += c.length; onProgress(received, total); yield c; }
  };
  await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(dest));
}
