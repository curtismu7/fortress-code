import { randomBytes } from 'node:crypto';

type CliOptions = {
  ttlMinutes: number;
  scopes: string[];
  label: string;
  bytes: number;
  mergeEnv: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    ttlMinutes: 60,
    scopes: ['news.search'],
    label: 'user',
    bytes: 24,
    mergeEnv: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === '--ttl-min' || a === '--ttl') && argv[i + 1]) {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) opts.ttlMinutes = Math.floor(v);
      i += 1;
      continue;
    }
    if ((a === '--scopes' || a === '--scope') && argv[i + 1]) {
      opts.scopes = argv[i + 1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (a === '--label' && argv[i + 1]) {
      opts.label = argv[i + 1].trim() || opts.label;
      i += 1;
      continue;
    }
    if (a === '--bytes' && argv[i + 1]) {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v >= 16 && v <= 64) opts.bytes = Math.floor(v);
      i += 1;
      continue;
    }
    if (a === '--merge-env') {
      opts.mergeEnv = true;
    }
  }

  if (!opts.scopes.length) opts.scopes = ['news.search'];
  return opts;
}

function parseExistingTokensFromEnv(): Record<string, unknown> {
  const raw = process.env.BRAVE_WRAPPER_TOKENS ?? '';
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
    if (Array.isArray(parsed)) {
      const out: Record<string, unknown> = {};
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;
        const token = typeof rec.token === 'string' ? rec.token : '';
        if (!token) continue;
        out[token] = {
          scopes: Array.isArray(rec.scopes) ? rec.scopes : ['news.search'],
          exp: rec.exp ?? rec.expiresAt ?? '',
          label: rec.label ?? '',
        };
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const token = randomBytes(opts.bytes).toString('hex');
  const exp = new Date(Date.now() + opts.ttlMinutes * 60_000).toISOString();

  const entry = {
    scopes: opts.scopes,
    exp,
    label: opts.label,
  };

  const wrappedSingle = {
    [token]: entry,
  };

  const wrappedMerged = opts.mergeEnv
    ? {
        ...parseExistingTokensFromEnv(),
        [token]: entry,
      }
    : wrappedSingle;

  process.stdout.write(`${JSON.stringify({ token, exp, scopes: opts.scopes, label: opts.label }, null, 2)}\n`);
  process.stdout.write('\n');
  if (opts.mergeEnv) {
    process.stdout.write('# Merged BRAVE_WRAPPER_TOKENS JSON\n');
  } else {
    process.stdout.write('# Add this token into BRAVE_WRAPPER_TOKENS JSON\n');
  }
  process.stdout.write(`${JSON.stringify(wrappedMerged, null, 2)}\n`);
  process.stdout.write('\n');
  process.stdout.write('# Quick export:\n');
  process.stdout.write(`export BRAVE_WRAPPER_TOKENS='${JSON.stringify(wrappedMerged)}'\n`);
}

main();
