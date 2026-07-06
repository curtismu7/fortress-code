// packages/extension/src/voice.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Speak text via macOS `say` (local TTS v1). */
export async function speakText(text: string): Promise<void> {
  const chunk = text.slice(0, 500).replace(/[\[\]`#*]/g, ' ').trim();
  if (!chunk) return;
  await execFileP('/usr/bin/say', [chunk], { timeout: 120_000 });
}
