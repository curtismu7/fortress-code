import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi } from './httpApi';
import { Supervisor } from './supervisor';
import { EmbedSupervisor } from './embedSupervisor';
import { dataDir, readDaemonInfo, writeDaemonInfo, isProcessAlive } from './paths';
import { readAvailableBytes } from './memory';

const EXIT_ALREADY_RUNNING = 3;
const IDLE_MS = Number(process.env.FC_IDLE_MS ?? 30 * 60 * 1000);

function log(msg: string): void {
  appendFileSync(join(dataDir(), 'daemon.log'), `${new Date().toISOString()} ${msg}\n`);
}

async function main(): Promise<void> {
  const existing = readDaemonInfo();
  if (existing && isProcessAlive(existing.pid)) {
    log(`refusing to start: daemon ${existing.pid} alive`);
    process.exit(EXIT_ALREADY_RUNNING);
  }
  const token = randomBytes(32).toString('hex');
  const supervisor = new Supervisor();
  const embed = new EmbedSupervisor();
  let lastActivity = Date.now();
  const api = createApi({
    supervisor,
    embed,
    token,
    onActivity: () => { lastActivity = Date.now(); },
    availableBytes: readAvailableBytes,
  });
  api.listen(0, '127.0.0.1', () => {
    const port = (api.address() as AddressInfo).port;
    writeDaemonInfo({ pid: process.pid, port, token });
    log(`listening on 127.0.0.1:${port}`);
  });
  const CHECK_INTERVAL_MS = Math.min(IDLE_MS, 5_000);
  setInterval(async () => {
    if (Date.now() - lastActivity > IDLE_MS) {
      log('idle timeout: stopping server and exiting');
      await supervisor.stop();
      await embed.stop();
      process.exit(0);
    }
  }, CHECK_INTERVAL_MS).unref();
  // keep process alive via the server; also survive terminal hangup when detached
  process.on('SIGHUP', () => {});
}

main().catch((e) => { log(`fatal: ${e}`); process.exit(1); });
