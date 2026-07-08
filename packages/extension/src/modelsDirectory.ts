import * as vscode from 'vscode';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MODELS_DIR_KEY = 'fortressChat.modelsDirectory';

const DEFAULT_MODELS_DIR = join(homedir(), 'Library', 'Application Support', 'fortress-chat', 'models');

function dataDir(): string {
  return process.env.FC_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'fortress-chat');
}

function modelsDirConfigFile(): string {
  return join(dataDir(), 'models-dir.txt');
}

/** Default local models folder when no custom path is set. */
export function defaultModelsDirectory(): string {
  return DEFAULT_MODELS_DIR;
}

/** Read the configured custom models directory from VS Code settings. */
export function getModelsDirectory(): string {
  return vscode.workspace.getConfiguration('fortressChat').get<string>(MODELS_DIR_KEY, '').trim();
}

/** Persist models directory to settings and the daemon config file. */
export async function setModelsDirectory(dir: string): Promise<void> {
  const value = dir.trim();
  await vscode.workspace.getConfiguration('fortressChat').update(
    MODELS_DIR_KEY,
    value || undefined,
    vscode.ConfigurationTarget.Global,
  );
  writeModelsDirOverride(value || null);
}

/** Write or clear models-dir.txt for the llama.cpp daemon. */
export function writeModelsDirOverride(dir: string | null): void {
  const root = dataDir();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const file = modelsDirConfigFile();
  if (!dir?.trim()) {
    try { unlinkSync(file); } catch { /* already absent */ }
    return;
  }
  writeFileSync(file, `${dir.trim()}\n`, { mode: 0o600 });
}

/** Sync settings → daemon config file on startup. */
export function syncModelsDirectoryConfig(): void {
  writeModelsDirOverride(getModelsDirectory() || null);
}

/** Read override path from daemon config file (for display/debug). */
export function readModelsDirOverride(): string | null {
  try {
    const file = modelsDirConfigFile();
    if (!existsSync(file)) return null;
    const value = readFileSync(file, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}
