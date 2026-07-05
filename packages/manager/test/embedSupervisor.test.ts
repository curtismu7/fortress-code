import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { EmbedSupervisor } from '../src/embedSupervisor';
import type { CatalogModel } from '@fortress-code/shared';

describe('EmbedSupervisor.buildArgs', () => {
  it('runs llama-server in embedding mode with mean pooling, no --jinja', () => {
    const s = new EmbedSupervisor();
    (s as any).port = 9999;
    const args = s.buildArgs('/models/nomic.gguf');
    expect(args).toContain('--embedding');
    expect(args).toEqual(expect.arrayContaining(['--pooling', 'mean']));
    expect(args).toEqual(expect.arrayContaining(['-m', '/models/nomic.gguf']));
    expect(args).toEqual(expect.arrayContaining(['--port', '9999']));
    expect(args).not.toContain('--jinja');
  });
});

const STUB = join(__dirname, 'fixtures', 'stub-llama-server.mjs');
const model: CatalogModel = {
  id: 'stub', family: 'gemma3', displayName: 'Stub', hfRepo: 'x/y',
  files: [{ name: 'stub.gguf', sha256: 'a'.repeat(64), bytes: 1 }],
  memoryBytes: 1, ramTierBytes: 1, toolCalling: true, license: 'test', extraArgs: [],
};

describe('EmbedSupervisor lifecycle (stub harness)', () => {
  beforeEach(() => {
    process.env.FC_LLAMA_BIN = process.execPath; // node
    process.env.FC_LLAMA_BIN_ARGS = STUB;        // embedSupervisor prepends this when set (test hook)
  });

  afterEach(() => {
    delete process.env.FC_LLAMA_BIN;
    delete process.env.FC_LLAMA_BIN_ARGS;
    delete process.env.STUB_LOAD_MS;
    delete process.env.STUB_CRASH_MS;
  });

  it('walks starting → ready, exposes endpoint/pid, then stops back to idle', async () => {
    const sup = new EmbedSupervisor();
    await sup.start(model, '/dev/null');
    expect(sup.state).toBe('ready');
    expect(sup.endpoint()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(typeof sup.managedPid()).toBe('number');
    await sup.stop();
    expect(sup.state).toBe('idle');
    expect(sup.endpoint()).toBeNull();
  });

  it('detects a crash and rejects start() with the stub crash message', async () => {
    process.env.STUB_CRASH_MS = '200';
    const sup = new EmbedSupervisor();
    await expect(sup.start(model, '/dev/null')).rejects.toThrow(/simulated crash/);
    expect(sup.state).toBe('crashed');
  });
});
