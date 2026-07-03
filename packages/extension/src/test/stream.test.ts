import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { streamChat, WatchdogError } from '../providers/stream';
import type { ResolvedTarget } from '../providers/target';

let server: Server; let target: ResolvedTarget;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  target = { url: `${base}/v1/chat/completions`, headers: { 'content-type': 'application/json' }, bodyExtra: {} };
});
afterAll(() => server.close());

describe('streamChat', () => {
  it('concatenates SSE deltas and reports tokens', async () => {
    const tokens: string[] = [];
    const full = await streamChat(target, [{ role: 'user', content: 'hi' }], (t) => tokens.push(t), new AbortController().signal);
    expect(full).toBe('Hello');
    expect(tokens).toEqual(['Hel', 'lo']);
  });

  it('watchdog rejects when the stream stalls', async () => {
    process.env.FC_WATCHDOG_MS = '200';
    const stall = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }));
    await new Promise<void>((r) => stall.listen(0, '127.0.0.1', r));
    const stallTarget: ResolvedTarget = { url: `http://127.0.0.1:${(stall.address() as AddressInfo).port}/v1/chat/completions`, headers: {}, bodyExtra: {} };
    await expect(streamChat(stallTarget, [{ role: 'user', content: 'hi' }], () => {}, new AbortController().signal))
      .rejects.toThrow(WatchdogError);
    stall.close();
    delete process.env.FC_WATCHDOG_MS;
  });
});
