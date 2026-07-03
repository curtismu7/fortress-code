import type { ChatMessage } from '@fortress-code/shared';
import type { ResolvedTarget } from './target';

export class WatchdogError extends Error {}

export async function streamChat(
  target: ResolvedTarget, messages: ChatMessage[], onToken: (t: string) => void, signal: AbortSignal,
): Promise<string> {
  const watchdogMs = Number(process.env.FC_WATCHDOG_MS ?? 60_000);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  let timer = setTimeout(() => ctrl.abort(new WatchdogError('no tokens for 60s')), watchdogMs);
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...target.headers },
      body: JSON.stringify({ ...(target.model ? { model: target.model } : {}), messages, stream: true, ...target.bodyExtra }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Model server HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    let full = '';
    let buf = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const data = event.replace(/^data: /m, '').trim();
        if (!data || data === '[DONE]') continue;
        const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length) {
          clearTimeout(timer);
          timer = setTimeout(() => ctrl.abort(new WatchdogError('no tokens for 60s')), watchdogMs);
          full += delta;
          onToken(delta);
        }
      }
    }
    return full;
  } catch (e) {
    if (ctrl.signal.reason instanceof WatchdogError) throw ctrl.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
