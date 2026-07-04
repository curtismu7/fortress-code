import type { ResolvedTarget } from './target';

// Developer Mode ONLY. This deliberately skips the US-only governance guard
// (assertAllowed) and sends to Fireworks' OpenAI-compatible API. This is the
// single, auditable place governance is bypassed — grep resolveDevTarget.
export function resolveDevTarget(slug: string, key: string): ResolvedTarget {
  if (!key) throw new Error('No Fireworks API key — add your key in Developer Mode.');
  return {
    url: 'https://api.fireworks.ai/inference/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    bodyExtra: {},
    model: slug,
  };
}
