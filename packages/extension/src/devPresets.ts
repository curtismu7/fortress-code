// Fireworks model presets for Developer Mode. Slugs are best-effort against the
// Fireworks catalog (which changes); the free-text box is the reliable fallback.
export const DEV_PRESETS: { label: string; slug: string }[] = [
  { label: 'GLM-5.2', slug: 'accounts/fireworks/models/glm-5p2' },
  { label: 'Llama 3.3 70B', slug: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
  { label: 'DeepSeek V3', slug: 'accounts/fireworks/models/deepseek-v3' },
  { label: 'Qwen 2.5 72B', slug: 'accounts/fireworks/models/qwen2p5-72b-instruct' },
  { label: 'Mixtral 8x22B', slug: 'accounts/fireworks/models/mixtral-8x22b-instruct' },
];
