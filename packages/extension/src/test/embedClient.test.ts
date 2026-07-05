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
});
