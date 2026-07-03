import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { llamaServerPath, binaryInstalled } from '../src/binary';

beforeEach(() => {
  process.env.FC_DATA_DIR = mkdtempSync(join(tmpdir(), 'fc-bin-'));
  delete process.env.FC_LLAMA_BIN;
});

describe('binary', () => {
  it('FC_LLAMA_BIN overrides the path', () => {
    process.env.FC_LLAMA_BIN = '/tmp/stub';
    expect(llamaServerPath()).toBe('/tmp/stub');
  });

  it('binaryInstalled false when missing, true when file exists', () => {
    expect(binaryInstalled()).toBe(false);
    const dir = join(process.env.FC_DATA_DIR!, 'bin', 'b9840');
    require('node:fs').mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'llama-server'), '#!/bin/sh\n');
    expect(binaryInstalled()).toBe(true);
  });
});
