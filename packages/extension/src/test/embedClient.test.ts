import { describe, it, expect, vi, afterEach } from 'vitest';
import { DaemonClient } from '../daemon';

afterEach(() => vi.restoreAllMocks());

describe('DaemonClient.embed', () => {
  it('posts texts and returns vectors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ vectors: [[1, 2]] }), { status: 200 }),
    );
    const c = new DaemonClient(1234, 'tok');
    const v = await c.embed(['hi']);
    expect(v).toEqual([[1, 2]]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/embed');
    expect(JSON.parse((init as any).body)).toEqual({ texts: ['hi'] });
  });

  it('embedStart reports ok:false on 409', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 409 }));
    const c = new DaemonClient(1234, 'tok');
    expect(await c.embedStart()).toEqual({ ok: false });
  });

  it('embed throws an error including the status and response text on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('embed upstream unreachable', { status: 502 }));
    const c = new DaemonClient(1234, 'tok');
    await expect(c.embed(['hi'])).rejects.toThrow(/embed failed: HTTP 502 embed upstream unreachable/);
  });
});
