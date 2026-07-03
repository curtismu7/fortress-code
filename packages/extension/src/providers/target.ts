import { assertAllowed, type PolicyEntry } from '@fortress-code/shared';

export interface TargetDeps {
  localEndpoint?: string;   // http://127.0.0.1:PORT from daemon status, when a local model is ready
  openRouterKey?: string;   // from SecretStorage, for OpenRouter entries
}

export interface ResolvedTarget {
  url: string;
  headers: Record<string, string>;
  bodyExtra: Record<string, unknown>;
  model?: string;
}

export function resolveTarget(entry: PolicyEntry, deps: TargetDeps): ResolvedTarget {
  assertAllowed(entry); // fail closed before we build anything

  if (entry.provider === 'local') {
    if (!deps.localEndpoint) throw new Error('No local model endpoint — start a local model first.');
    return {
      url: `${deps.localEndpoint}/v1/chat/completions`,
      headers: { 'content-type': 'application/json' },
      bodyExtra: {},
    };
  }

  // OpenRouter branch is added in Task 15.
  throw new Error(`Unsupported provider: ${entry.provider}`);
}
