# FortressChat

Local + US-governed AI chat and coding agent for VS Code. Run models fully on
your machine via llama.cpp, or use **Google Gemini** with your own API key — with
a governance policy that blocks any non-US model.

## Providers

- **Local (private):** Google Gemma 3 and OpenAI gpt-oss via llama.cpp. Nothing
  leaves your machine. A memory guard refuses to load a model that won't fit.
- **Google Gemini (cloud):** curated US-origin Gemini models via the [Google AI API](https://aistudio.google.com/apikey). Add your API key in **Settings → Google Gemini**. Prompts are sent to Google; less private than local — the UI labels cloud models clearly.

## Governance

Only US-origin models are selectable or addable. Enforcement is a curated
allow-list maintained in the app. Pasting a non-US or unsupported cloud slug is
blocked with a plain-language reason. OpenRouter and other cloud providers are
disabled. See `docs/superpowers/specs/2026-07-06-gemini-cloud-design.md`.

## Install

Download `fortress-chat.vsix` from the latest Release → VS Code Extensions →
Install from VSIX. Requirements: Apple Silicon Mac, macOS 13+, VS Code 1.90+.

## Development

```bash
npm install
npm run build
npm test          # unit tests (vitest, all packages)
npm run test:e2e  # webview + command smoke tests (@vscode/test-electron)
npm run dev       # esbuild watch (alias for npm run watch)
```

## Standalone Mac App (Preview)

Run FortressChat as a normal macOS app window (Electron shell):

```bash
npm install
export FORTRESS_OIDC_CLIENT_ID="your-oidc-client-id"
# preferred: single issuer URL (auto-discovers OIDC endpoints)
export FORTRESS_OIDC_ISSUER="https://your-issuer.example.com"
# optional for confidential clients (PingOne app with client authentication)
export FORTRESS_OIDC_CLIENT_SECRET="your-oidc-client-secret"
# optional overrides if your IdP needs explicit endpoint values
export FORTRESS_OIDC_DEVICE_AUTHORIZATION_ENDPOINT="https://your-issuer.example.com/as/device_authorization"
export FORTRESS_OIDC_TOKEN_ENDPOINT="https://your-issuer.example.com/as/token"
export FORTRESS_OIDC_USERINFO_ENDPOINT="https://your-issuer.example.com/idp/userinfo.openid"
npm run desktop:dev
```

Standalone sign-in policy:

- OIDC Device Authorization flow is required.
- Only `@pingidentity.com` accounts are allowed.

DEV-only fallback auth (local development only, never production):

```bash
export FORTRESS_DEV_AUTH_BYPASS=1
export FORTRESS_DEV_AUTH_EMAIL="you@pingidentity.com" # optional
```

Optional macOS signing + notarization env vars:

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Build app artifacts:

```bash
npm run desktop:pack  # creates an unpacked .app in packages/desktop/dist/mac
npm run desktop:dist  # creates a DMG in packages/desktop/dist
```

Note: this is a standalone preview shell. VS Code-specific integrations are not fully wired yet.

Release prep docs:

- `docs/releases/2026-07-24-v0.1.15.md`
- `docs/releases/RELEASE-CHECKLIST.md`

**Full harness guide:** [`docs/DEV-HARNESS.md`](docs/DEV-HARNESS.md) — launch configs, hot reload, fixture sandbox, E2E, troubleshooting.

### Extension Development Host (VS Code or Cursor)

1. Open this repo (any git worktree — `.vscode/launch.json` is committed).
2. Run **`Run Extension (Fixture Workspace)`** from Run and Debug (recommended),  
   or **`Run Extension (watch + Fixture)`** for esbuild watch + fixture workspace.
3. A second window opens with `fixtures/sample-app` — dogfood chat, agent, `@codebase`, and project rules there.

| Launch config | Purpose |
|---------------|---------|
| **Run Extension** | Empty window, extension only |
| **Run Extension (Fixture Workspace)** | Opens the sample app workspace |
| **Run Extension (watch + Fixture)** | Fixture + esbuild watch; reload window after TS changes |
| **Extension Tests (E2E smoke)** | Automated webview wiring tests |

**Hot reload:** edits to `packages/extension/media/*` auto-reload the chat webview in dev. TypeScript changes need esbuild watch + **Developer: Reload Window**. Command: **FortressChat: Reload Chat Webview**.

The fixture includes a bug in `src/greeter.js`, rules in `.fortress/rules.md`, and docs for `@docs` — see `fixtures/sample-app/AGENT-SANDBOX.md` for scenarios.
