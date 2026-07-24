# Brave News MCP Cloud Setup

This deploys the Brave wrapper as a hosted MCP server so Fortress clients use HTTPS instead of localhost.

## 1) Build artifacts

```bash
npm run build -w @fortress-chat/manager
```

## 2) Mint a delegated client token

```bash
npm run brave:token -- --ttl-min 10080 --label fortress-prod
```

The command prints:
- Minted token (used by Fortress client as Bearer token)
- `BRAVE_WRAPPER_TOKENS` export line (stored server-side in Fly secrets)

## 3) Configure Fly app

Update app name in [fly.brave-wrapper.toml](../fly.brave-wrapper.toml) to a unique value.

Create app if needed:

```bash
flyctl apps create YOUR_BRAVE_WRAPPER_APP
```

## 4) Set secrets (server-side only)

```bash
flyctl secrets set \
  BRAVE_API_KEY="YOUR_BRAVE_SUBSCRIPTION_TOKEN" \
  BRAVE_WRAPPER_TOKENS='{"TOKEN_NAME":{"scopes":["news.search"],"exp":"2099-01-01T00:00:00Z","label":"fortress-prod"}}' \
  -a YOUR_BRAVE_WRAPPER_APP
```

Notes:
- Never expose `BRAVE_API_KEY` in Fortress UI.
- `BRAVE_WRAPPER_TOKENS` should include the real minted token key from step 2.

## 5) Deploy

```bash
flyctl deploy -c fly.brave-wrapper.toml -a YOUR_BRAVE_WRAPPER_APP
```

Health check:

```bash
curl -fsSL https://YOUR_BRAVE_WRAPPER_APP.fly.dev/healthz
```

## 6) Fortress MCP config (client-side)

Add an MCP HTTP server in Fortress with:
- URL: `https://YOUR_BRAVE_WRAPPER_APP.fly.dev/mcp`
- Header: `Authorization: Bearer YOUR_MINTED_TOKEN`

Example:

```json
{
  "name": "brave-news-cloud",
  "transport": "http",
  "url": "https://YOUR_BRAVE_WRAPPER_APP.fly.dev/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_MINTED_TOKEN"
  }
}
```

## 7) Verify tools/list

```bash
curl -sS -X POST https://YOUR_BRAVE_WRAPPER_APP.fly.dev/mcp \
  -H "content-type: application/json" \
  -H "Authorization: Bearer YOUR_MINTED_TOKEN" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
