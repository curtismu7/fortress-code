// packages/extension/src/mcpDefaults.ts
import { type McpServerConfig, parseMcpConfigs } from './mcpClient';

export const PINGONE_MCP_SERVER_NAME = 'pingone';

export interface PingOneMcpSettings {
  enabled?: boolean;
  environmentId?: string;
  clientId?: string;
  rootDomain?: string;
}

/** Normalize PingOne MCP settings from extension / Mac settings storage. */
export function normalizePingOneMcpSettings(raw: unknown): PingOneMcpSettings {
  if (!raw || typeof raw !== 'object') return { enabled: true, rootDomain: 'pingone.com' };
  const o = raw as Record<string, unknown>;
  return {
    enabled: o.enabled !== false,
    environmentId: typeof o.environmentId === 'string' ? o.environmentId.trim() : '',
    clientId: typeof o.clientId === 'string' ? o.clientId.trim() : '',
    rootDomain: typeof o.rootDomain === 'string' && o.rootDomain.trim()
      ? o.rootDomain.trim()
      : 'pingone.com',
  };
}

/** Built-in PingOne MCP server (stdio client; APIs hosted on PingOne). */
export function defaultPingOneMcpServer(settings: PingOneMcpSettings): McpServerConfig | null {
  if (settings.enabled === false) return null;
  const env: Record<string, string> = { PINGONE_ROOT_DOMAIN: settings.rootDomain || 'pingone.com' };
  if (settings.environmentId) env.PINGONE_MCP_ENVIRONMENT_ID = settings.environmentId;
  if (settings.clientId) env.PINGONE_AUTHORIZATION_CODE_CLIENT_ID = settings.clientId;
  return {
    name: PINGONE_MCP_SERVER_NAME,
    command: 'pingone-mcp-server',
    args: ['run'],
    env,
    builtin: true,
  };
}

/** Merge built-in PingOne MCP with user-configured stdio/remote servers. User entries override by name. */
export function resolveMcpConfigs(userRaw: unknown, pingOneRaw?: unknown): McpServerConfig[] {
  const pingOne = normalizePingOneMcpSettings(pingOneRaw);
  const byName = new Map<string, McpServerConfig>();
  const builtin = defaultPingOneMcpServer(pingOne);
  if (builtin) byName.set(builtin.name, builtin);

  const user = Array.isArray(userRaw) ? userRaw : [];
  for (const entry of user) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as McpServerConfig;
    if (typeof row.name !== 'string') continue;
    if (row.disabled === true) {
      byName.delete(row.name);
      continue;
    }
    const command = typeof row.command === 'string' && row.command.trim() ? row.command.trim() : undefined;
    const url = typeof row.url === 'string' && row.url.trim() ? row.url.trim() : undefined;
    if (!command && !url) continue;

    byName.set(row.name, {
      name: row.name,
      transport: row.transport,
      command,
      args: Array.isArray(row.args) ? row.args.filter((a): a is string => typeof a === 'string') : undefined,
      env: row.env && typeof row.env === 'object'
        ? Object.fromEntries(Object.entries(row.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>
        : undefined,
      url,
      messageUrl: typeof row.messageUrl === 'string' && row.messageUrl.trim() ? row.messageUrl.trim() : undefined,
      headers: row.headers && typeof row.headers === 'object'
        ? Object.fromEntries(Object.entries(row.headers).filter(([, v]) => typeof v === 'string')) as Record<string, string>
        : undefined,
      builtin: row.builtin,
    });
  }

  return [...byName.values()];
}

/** Re-export for callers that only need parsed user entries. */
export { parseMcpConfigs };

function stringMap(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const entries = Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => [k, String(v)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * Parse imported MCP JSON from either fortressChat.mcpServers array format
 * or VS Code .vscode/mcp.json object format ({ servers: { name: {...} } }).
 */
export function parseImportedMcpServersJson(rawText: string): McpServerConfig[] {
  const parsed = JSON.parse(rawText) as unknown;

  // FortressChat setting shape: [{ name, command|url, ... }]
  if (Array.isArray(parsed)) {
    return resolveMcpConfigs(parsed, { enabled: false }).filter((s) => !s.builtin);
  }

  // VS Code shape: { servers: { "name": { command, args, env, ... } } }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const root = parsed as Record<string, unknown>;
    const servers = root.servers;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      const rows: McpServerConfig[] = [];
      for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const src = value as Record<string, unknown>;
        const command = typeof src.command === 'string' && src.command.trim() ? src.command.trim() : undefined;
        const url = typeof src.url === 'string' && src.url.trim() ? src.url.trim() : undefined;
        const args = Array.isArray(src.args) ? src.args.filter((a): a is string => typeof a === 'string') : undefined;
        const messageUrl = typeof src.messageUrl === 'string' && src.messageUrl.trim() ? src.messageUrl.trim() : undefined;
        const transport = src.transport === 'stdio' || src.transport === 'http' || src.transport === 'sse'
          ? src.transport
          : undefined;
        rows.push({
          name,
          transport,
          command,
          args,
          env: stringMap(src.env),
          url,
          messageUrl,
          headers: stringMap(src.headers),
          disabled: src.disabled === true,
        });
      }
      return resolveMcpConfigs(rows, { enabled: false }).filter((s) => !s.builtin);
    }
  }

  throw new Error('Invalid MCP JSON. Expected an array or an object with a "servers" map.');
}
