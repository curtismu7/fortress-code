import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type JsonRpcId = string | number | null;

type TokenRecord = {
  token: string;
  scopes: string[];
  expMs: number;
};

type RateBucket = {
  windowStartMs: number;
  count: number;
};

const PORT = Number(process.env.BRAVE_WRAPPER_PORT ?? 8787);
const HOST = process.env.BRAVE_WRAPPER_HOST ?? '127.0.0.1';
const BRAVE_API_KEY = process.env.BRAVE_API_KEY ?? '';
const BRAVE_NEWS_ENDPOINT = process.env.BRAVE_NEWS_ENDPOINT ?? 'https://api.search.brave.com/res/v1/news/search';
const RATE_LIMIT_PER_MIN = Number(process.env.BRAVE_WRAPPER_RATE_LIMIT_PER_MIN ?? 60);
const AUDIT_LOG_PATH = process.env.BRAVE_WRAPPER_AUDIT_LOG_PATH ?? '';

const rateByToken = new Map<string, RateBucket>();

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function writeAudit(event: string, fields: Record<string, unknown>): void {
  const line = `${new Date().toISOString()} ${event} ${JSON.stringify(fields)}\n`;
  if (AUDIT_LOG_PATH) {
    const dir = dirname(AUDIT_LOG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(AUDIT_LOG_PATH, line);
    return;
  }
  process.stdout.write(line);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function readString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === 'string' ? v : '';
}

function readScopes(rec: Record<string, unknown>, key: string): string[] {
  const v = rec[key];
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean);
}

function toExpMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const num = Number(value);
    if (Number.isFinite(num)) return num > 10_000_000_000 ? num : num * 1000;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function parseTokenConfig(): TokenRecord[] {
  const raw = process.env.BRAVE_WRAPPER_TOKENS ?? '';
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const out: TokenRecord[] = [];
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const rec = asRecord(entry);
      if (!rec) continue;
      const token = readString(rec, 'token').trim();
      const scopes = readScopes(rec, 'scopes');
      const expMs = toExpMs(rec.exp ?? rec.expiresAt);
      if (token && scopes.length > 0 && expMs > 0) out.push({ token, scopes, expMs });
    }
    return out;
  }

  if (parsed && typeof parsed === 'object') {
    for (const [token, meta] of Object.entries(parsed as Record<string, unknown>)) {
      const rec = asRecord(meta);
      if (!token || !rec) continue;
      const scopes = readScopes(rec, 'scopes');
      const expMs = toExpMs(rec.exp ?? rec.expiresAt);
      if (scopes.length > 0 && expMs > 0) out.push({ token, scopes, expMs });
    }
  }
  return out;
}

function bearerToken(req: IncomingMessage): string {
  const h = req.headers.authorization;
  if (!h) return '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function checkRateLimit(token: string): { ok: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const winMs = 60_000;
  const current = rateByToken.get(token);
  if (!current || now - current.windowStartMs >= winMs) {
    rateByToken.set(token, { windowStartMs: now, count: 1 });
    return { ok: true };
  }
  if (current.count >= RATE_LIMIT_PER_MIN) {
    const retryAfterSec = Math.ceil((current.windowStartMs + winMs - now) / 1000);
    return { ok: false, retryAfterSec };
  }
  current.count += 1;
  return { ok: true };
}

function normalizeArgString(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.slice(0, maxLen);
}

function authToken(req: IncomingMessage, requiredScope: string, tokens: Map<string, TokenRecord>): { ok: true; token: string } | { ok: false; status: number; reason: string; retryAfterSec?: number } {
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, reason: 'missing bearer token' };
  const rec = tokens.get(token);
  if (!rec) return { ok: false, status: 401, reason: 'invalid token' };
  if (Date.now() >= rec.expMs) return { ok: false, status: 401, reason: 'expired token' };
  if (!rec.scopes.includes(requiredScope)) return { ok: false, status: 403, reason: 'insufficient scope' };
  const rate = checkRateLimit(token);
  if (!rate.ok) return { ok: false, status: 429, reason: 'rate limit exceeded', retryAfterSec: rate.retryAfterSec };
  return { ok: true, token };
}

function listToolsResult(): unknown {
  return {
    tools: [
      {
        name: 'brave_news_search',
        description: 'Search Brave News with server-side X-Subscription-Token injection.',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Search query.' },
            country: { type: 'string', description: '2-letter country code, e.g. US.' },
            search_lang: { type: 'string', description: 'Language code, e.g. en.' },
            freshness: { type: 'string', description: 'One of pd, pw, pm, py.' },
            count: { type: 'number', description: 'Number of results (1-20).' },
            offset: { type: 'number', description: 'Result offset (0+).' },
          },
          required: ['q'],
        },
      },
    ],
  };
}

function buildBraveNewsQuery(args: Record<string, unknown>): URLSearchParams {
  const qs = new URLSearchParams();
  const q = normalizeArgString(args.q, 400);
  if (!q) throw new Error('q is required');
  qs.set('q', q);

  const country = normalizeArgString(args.country, 8);
  if (country) qs.set('country', country.toUpperCase());
  const lang = normalizeArgString(args.search_lang, 16);
  if (lang) qs.set('search_lang', lang.toLowerCase());

  const freshness = normalizeArgString(args.freshness, 8);
  if (freshness) {
    const allowed = new Set(['pd', 'pw', 'pm', 'py']);
    if (!allowed.has(freshness)) throw new Error('freshness must be one of pd, pw, pm, py');
    qs.set('freshness', freshness);
  }

  if (typeof args.count === 'number' && Number.isFinite(args.count)) {
    const n = Math.max(1, Math.min(20, Math.floor(args.count)));
    qs.set('count', String(n));
  }
  if (typeof args.offset === 'number' && Number.isFinite(args.offset)) {
    const n = Math.max(0, Math.floor(args.offset));
    qs.set('offset', String(n));
  }
  return qs;
}

async function callBraveNews(args: Record<string, unknown>): Promise<unknown> {
  if (!BRAVE_API_KEY) throw new Error('BRAVE_API_KEY is not configured');
  const query = buildBraveNewsQuery(args);
  const url = `${BRAVE_NEWS_ENDPOINT}?${query.toString()}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': BRAVE_API_KEY,
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Brave upstream ${resp.status}${text ? `: ${text.slice(0, 500)}` : ''}`);
  }
  return resp.json();
}

function tokenLabel(token: string): string {
  if (token.length <= 8) return token;
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

async function start(): Promise<void> {
  const tokenRecords = parseTokenConfig();
  if (tokenRecords.length === 0) {
    throw new Error('BRAVE_WRAPPER_TOKENS is missing or invalid; expected JSON token config');
  }
  const tokens = new Map(tokenRecords.map((t) => [t.token, t]));

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      return json(res, 200, { ok: true });
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      return json(res, 404, { error: 'not found' });
    }

    const body = await readJsonBody(req);
    const bodyRec = asRecord(body);
    const idRaw = bodyRec && Object.hasOwn(bodyRec, 'id') ? bodyRec.id : null;
    const id: JsonRpcId = (typeof idRaw === 'string' || typeof idRaw === 'number' || idRaw === null) ? idRaw : null;
    const method = typeof bodyRec?.method === 'string' ? bodyRec.method : '';

    if (method === 'initialize') {
      writeAudit('mcp.initialize', { ok: true, remote: req.socket.remoteAddress ?? '' });
      return json(res, 200, rpcResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fortress-brave-news-wrapper', version: '0.1.0' },
      }));
    }

    if (method === 'tools/list') {
      const auth = authToken(req, 'news.search', tokens);
      if (!auth.ok) {
        if (auth.retryAfterSec) res.setHeader('retry-after', String(auth.retryAfterSec));
        writeAudit('mcp.tools.list.denied', { reason: auth.reason, remote: req.socket.remoteAddress ?? '' });
        return json(res, auth.status, rpcError(id, -32001, auth.reason));
      }
      writeAudit('mcp.tools.list', { ok: true, token: tokenLabel(auth.token) });
      return json(res, 200, rpcResult(id, listToolsResult()));
    }

    if (method === 'tools/call') {
      const auth = authToken(req, 'news.search', tokens);
      if (!auth.ok) {
        if (auth.retryAfterSec) res.setHeader('retry-after', String(auth.retryAfterSec));
        writeAudit('mcp.tools.call.denied', { reason: auth.reason, remote: req.socket.remoteAddress ?? '' });
        return json(res, auth.status, rpcError(id, -32001, auth.reason));
      }
      const params = asRecord(bodyRec?.params);
      const toolName = typeof params?.name === 'string' ? params.name : '';
      const args = asRecord(params?.arguments) ?? {};
      if (toolName !== 'brave_news_search') {
        return json(res, 200, rpcError(id, -32602, 'unknown tool'));
      }
      try {
        const result = await callBraveNews(args);
        writeAudit('mcp.tools.call', {
          ok: true,
          token: tokenLabel(auth.token),
          toolName,
          q: typeof args.q === 'string' ? args.q.slice(0, 120) : '',
        });
        return json(res, 200, rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeAudit('mcp.tools.call.error', { ok: false, token: tokenLabel(auth.token), toolName, error: msg });
        return json(res, 200, rpcError(id, -32000, msg));
      }
    }

    return json(res, 200, rpcError(id, -32601, `unsupported method: ${method || 'unknown'}`));
  });

  server.listen(PORT, HOST, () => {
    writeAudit('server.start', {
      host: HOST,
      port: PORT,
      tokens: tokenRecords.length,
      rateLimitPerMin: RATE_LIMIT_PER_MIN,
      endpoint: BRAVE_NEWS_ENDPOINT,
    });
  });
}

start().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  writeAudit('server.fatal', { error: msg });
  process.exit(1);
});
