import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/httpApi';
import { Supervisor } from '../src/supervisor';
import { loadCatalog } from '@fortress-code/shared';

const STUB = join(__dirname, 'fixtures', 'stub-llama-server.mjs');
let server: ReturnType<typeof createApi>; let base: string;
const TOKEN = 'test-token';
let available = 40 * 1024 ** 3;

function req(path: string, opts: RequestInit = {}, token = TOKEN) {
  return fetch(base + path, { ...opts, headers: { 'x-fc-token': token, 'content-type': 'application/json', ...opts.headers } });
}

beforeEach(async () => {
  process.env.FC_DATA_DIR = mkdtempSync(join(tmpdir(), 'fc-api-'));
  process.env.FC_LLAMA_BIN = process.execPath;
  process.env.FC_LLAMA_BIN_ARGS = STUB;
  // fake a downloaded model file for the smallest catalog entry
  const m = loadCatalog()[0];
  const dir = join(process.env.FC_DATA_DIR, 'models', m.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, m.files[0].name), 'fake');
  server = createApi({ supervisor: new Supervisor(), token: TOKEN, onActivity: () => {}, availableBytes: async () => available });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => server.close());

describe('api auth', () => {
  it('401 without token', async () => {
    expect((await req('/status', {}, 'wrong')).status).toBe(401);
  });
});

describe('start with memory guard', () => {
  it('starts smallest model when memory fits', async () => {
    const m = loadCatalog()[0];
    const res = await req('/start', { method: 'POST', body: JSON.stringify({ modelId: m.id }) });
    expect(res.status).toBe(200);
    const status = await (await req('/status')).json();
    expect(status.state).toBe('ready');
    expect(status.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('409 + StartRejection with foreign list when memory does not fit', async () => {
    available = 1024; // nothing fits
    const m = loadCatalog()[0];
    const res = await req('/start', { method: 'POST', body: JSON.stringify({ modelId: m.id }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe('insufficient-memory');
    expect(Array.isArray(body.foreign)).toBe(true);
  });

  it('428 when model not downloaded', async () => {
    const res = await req('/start', { method: 'POST', body: JSON.stringify({ modelId: 'gpt-oss-120b' }) });
    expect(res.status).toBe(428);
  });
});
