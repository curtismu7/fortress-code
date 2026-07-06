// packages/extension/src/webSearch.ts

/** US-governed web search providers (fail-closed). */
export const WEB_SEARCH_PROVIDERS = ['duckduckgo'] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export function isAllowedSearchProvider(p: string): p is WebSearchProvider {
  return (WEB_SEARCH_PROVIDERS as readonly string[]).includes(p);
}

/** Search DuckDuckGo HTML and return a short text summary for the model. */
export async function webSearch(query: string, maxResults = 5): Promise<string> {
  const q = query.trim();
  if (!q) return 'empty query';
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'FortressCode/1.0 (local; US-governed search)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return `search HTTP ${res.status}`;
  const html = await res.text();
  const hits: string[] = [];
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < maxResults) {
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    const link = m[1];
    if (title) hits.push(`- ${title}\n  ${link}`);
  }
  if (!hits.length) return 'No results found.';
  return `Web search results for "${q}":\n${hits.join('\n')}`;
}
