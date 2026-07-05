import { loadCatalog, type CatalogModel } from './catalog';
import { isAllowed, type PolicyEntry } from './governance';

const LOCAL_ORG: Record<CatalogModel['family'], string> = {
  gemma3: 'Google',
  'gpt-oss': 'OpenAI',
  embedding: 'Nomic AI',
};

export function localEntries(): PolicyEntry[] {
  return loadCatalog().map((m): PolicyEntry => ({
    id: m.id,
    displayName: m.displayName,
    provider: 'local',
    agentCapable: m.toolCalling,
    origin: { org: LOCAL_ORG[m.family], country: 'US' },
    hosting: { kind: 'on-device' },
    approved: true,
    local: { catalogId: m.id },
  }));
}

// Curated US-origin OpenRouter models with US inference providers pinned.
// MAINTENANCE: adding an entry is a governance decision — verify the developer is
// US-headquartered AND that every listed provider is US-operated on OpenRouter.
// Provider slugs follow OpenRouter's provider names; re-verify against
// https://openrouter.ai/docs when updating.
export function openRouterEntries(): PolicyEntry[] {
  return [
    {
      id: 'or-gpt-4o', displayName: 'GPT-4o (OpenRouter)', provider: 'openrouter', agentCapable: true,
      origin: { org: 'OpenAI', country: 'US' },
      hosting: { kind: 'openrouter', usProviders: ['openai', 'azure'] },
      approved: true, openrouter: { slug: 'openai/gpt-4o', contextLength: 128000 },
    },
    {
      id: 'or-gpt-4o-mini', displayName: 'GPT-4o mini (OpenRouter)', provider: 'openrouter', agentCapable: true,
      origin: { org: 'OpenAI', country: 'US' },
      hosting: { kind: 'openrouter', usProviders: ['openai', 'azure'] },
      approved: true, openrouter: { slug: 'openai/gpt-4o-mini', contextLength: 128000 },
    },
    {
      id: 'or-claude-3-5-sonnet', displayName: 'Claude 3.5 Sonnet (OpenRouter)', provider: 'openrouter', agentCapable: true,
      origin: { org: 'Anthropic', country: 'US' },
      hosting: { kind: 'openrouter', usProviders: ['anthropic', 'amazon-bedrock', 'google-vertex'] },
      approved: true, openrouter: { slug: 'anthropic/claude-3.5-sonnet', contextLength: 200000 },
    },
    {
      id: 'or-llama-3-3-70b', displayName: 'Llama 3.3 70B (OpenRouter)', provider: 'openrouter', agentCapable: true,
      origin: { org: 'Meta', country: 'US' },
      hosting: { kind: 'openrouter', usProviders: ['together', 'fireworks', 'lambda'] },
      approved: true, openrouter: { slug: 'meta-llama/llama-3.3-70b-instruct', contextLength: 131072 },
    },
  ];
}

export function loadPolicy(): PolicyEntry[] {
  return [...localEntries(), ...openRouterEntries()];
}

// Known non-US developer prefixes → human-readable reason. Used by the add-model
// blocked state. Extend as needed; unknown slugs fall through to the generic message.
const NON_US: { test: RegExp; reason: string }[] = [
  { test: /^deepseek\//i, reason: 'DeepSeek is a China-based developer.' },
  { test: /^(qwen|alibaba)\//i, reason: 'Qwen (Alibaba) is a China-based developer.' },
  { test: /^(01-ai|yi)\//i, reason: 'Yi (01.AI) is a China-based developer.' },
  { test: /^(thudm|z-ai|zhipu|glm)\//i, reason: 'GLM (Zhipu AI) is a China-based developer.' },
  { test: /^(mistralai|mistral)\//i, reason: 'Mistral AI is a France-based developer.' },
  { test: /^cohere\//i, reason: 'Cohere is a Canada-based developer.' },
];

export function explainBlock(slugOrId: string): string | null {
  if (loadPolicy().some((e) => (e.openrouter?.slug === slugOrId || e.id === slugOrId) && isAllowed(e))) return null;
  for (const n of NON_US) if (n.test.test(slugOrId)) return n.reason;
  return 'This model is not on the US-approved list.';
}
