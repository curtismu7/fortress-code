import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { createApi } from '../src/httpApi';
import { EmbedSupervisor } from '../src/embedSupervisor';

let embedSrv: Server; let embedUrl: string;
beforeAll(async () => {
  embedSrv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { input } = JSON.parse(body || '{}');
      const data = (input as string[]).map((t, i) => ({ embedding: [t.length, i], index: i }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((r) => embedSrv.listen(0, '127.0.0.1', r));
  embedUrl = `http://127.0.0.1:${(embedSrv.address() as any).port}`;
});
afterAll(() => embedSrv.close());

function fakeEmbed(): EmbedSupervisor {
  const e = new EmbedSupervisor();
  e.state = 'ready'; e.modelId = 'nomic-embed-text-v1.5';
  (e as any).port = Number(embedUrl.split(':').pop());
  return e;
}

async function call(api: Server, path: string, body: unknown) {
  const port = (api.address() as any).port;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'x-fc-token': 't', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /embed', () => {
  it('returns vectors in input order', async () => {
    const embed = fakeEmbed();
    const api = createApi({
      supervisor: { state: 'idle', modelId: null, endpoint: () => null, crashLog: null, managedPid: () => null, stop: async () => {} } as any,
      embed, token: 't', onActivity: () => {}, availableBytes: async () => 32 * 1024 ** 3,
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    const res = await call(api, '/embed', { texts: ['ab', 'cde'] });
    expect(res.status).toBe(200);
    const { vectors } = await res.json();
    expect(vectors).toEqual([[2, 0], [3, 1]]);
    api.close();
  });

  it('returns 502 (not 500) when the embed upstream is unreachable', async () => {
    // Grab a free port, then close it immediately so the port is known-closed.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const closedPort = (probe.address() as any).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const embed = new EmbedSupervisor();
    embed.state = 'ready'; embed.modelId = 'nomic-embed-text-v1.5';
    (embed as any).port = closedPort;

    const api = createApi({
      supervisor: { state: 'idle', modelId: null, endpoint: () => null, crashLog: null, managedPid: () => null, stop: async () => {} } as any,
      embed, token: 't', onActivity: () => {}, availableBytes: async () => 32 * 1024 ** 3,
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    const res = await call(api, '/embed', { texts: ['ab'] });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    api.close();
  });

  it('returns 502 when the embed upstream returns a malformed body (no data array)', async () => {
    const malformedSrv = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({}));
      });
    });
    await new Promise<void>((r) => malformedSrv.listen(0, '127.0.0.1', r));
    const malformedPort = (malformedSrv.address() as any).port;

    const embed = new EmbedSupervisor();
    embed.state = 'ready'; embed.modelId = 'nomic-embed-text-v1.5';
    (embed as any).port = malformedPort;

    const api = createApi({
      supervisor: { state: 'idle', modelId: null, endpoint: () => null, crashLog: null, managedPid: () => null, stop: async () => {} } as any,
      embed, token: 't', onActivity: () => {}, availableBytes: async () => 32 * 1024 ** 3,
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    const res = await call(api, '/embed', { texts: ['ab'] });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    api.close();
    malformedSrv.close();
  });
});
