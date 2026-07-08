import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDir, modelsDir, readModelsDirOverride, writeModelsDirOverride, writeDaemonInfo, readDaemonInfo, isProcessAlive } from '../src/paths';

beforeEach(() => {
  process.env.FC_DATA_DIR = mkdtempSync(join(tmpdir(), 'fc-test-'));
  delete process.env.FC_MODELS_DIR;
});

describe('paths', () => {
  it('uses FC_DATA_DIR override and creates it', () => {
    expect(dataDir()).toBe(process.env.FC_DATA_DIR);
  });

  it('daemon.json round-trips and is 0600', () => {
    writeDaemonInfo({ pid: 123, port: 45678, token: 'abc' });
    expect(readDaemonInfo()).toEqual({ pid: 123, port: 45678, token: 'abc' });
    const mode = statSync(join(dataDir(), 'daemon.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('readDaemonInfo returns null when missing', () => {
    expect(readDaemonInfo()).toBeNull();
  });

  it('isProcessAlive: own pid alive, absurd pid not', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 - 7)).toBe(false);
  });

  it('modelsDir uses default subfolder when no override is set', () => {
    expect(modelsDir()).toBe(join(dataDir(), 'models'));
  });

  it('modelsDir honors FC_MODELS_DIR and models-dir.txt override', () => {
    const custom = join(tmpdir(), 'fc-custom-models');
    mkdirSync(custom, { recursive: true });
    process.env.FC_MODELS_DIR = custom;
    expect(modelsDir()).toBe(custom);

    delete process.env.FC_MODELS_DIR;
    writeModelsDirOverride(custom);
    expect(readModelsDirOverride()).toBe(custom);
    expect(modelsDir()).toBe(custom);

    writeModelsDirOverride(null);
    expect(readModelsDirOverride()).toBeNull();
    expect(modelsDir()).toBe(join(dataDir(), 'models'));
  });
});
