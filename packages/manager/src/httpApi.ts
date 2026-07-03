import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog, type CatalogModel, type StatusResponse, type StartRejection, type DownloadProgress, hfUrl } from '@fortress-code/shared';
import { Supervisor } from './supervisor';
import { modelsDir } from './paths';
import { checkFit, totalRamBytes } from './memory';
import { scanForeign, killPids } from './processes';
import { downloadFile } from './download';
import { binaryInstalled, installBinary } from './binary';

export interface ApiDeps {
  supervisor: Supervisor;
  token: string;
  onActivity: () => void;
  availableBytes: () => Promise<number>;
}

function modelPath(m: CatalogModel, fileIndex = 0): string {
  return join(modelsDir(), m.id, m.files[fileIndex].name);
}
function modelDownloaded(m: CatalogModel): boolean {
  return m.files.length > 0 && m.files.every((f) => existsSync(join(modelsDir(), m.id, f.name)));
}
async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; }
}
function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createApi(deps: ApiDeps): Server {
  const catalog = loadCatalog();
  let download: DownloadProgress | null = null;
  let downloading = false;

  return createServer(async (req, res) => {
    if (req.headers['x-fc-token'] !== deps.token) return send(res, 401, { error: 'unauthorized' });
    deps.onActivity();
    const route = `${req.method} ${req.url?.split('?')[0]}`;
    try {
      switch (route) {
        case 'GET /status': {
          const body: StatusResponse = {
            state: deps.supervisor.state,
            modelId: deps.supervisor.modelId,
            endpoint: deps.supervisor.endpoint(),
            download,
            crashLog: deps.supervisor.crashLog,
            ram: { totalBytes: totalRamBytes(), availableBytes: await deps.availableBytes() },
            binaryInstalled: binaryInstalled(),
            downloadedModelIds: catalog.filter(modelDownloaded).map((m) => m.id),
          };
          return send(res, 200, body);
        }
        case 'GET /catalog': return send(res, 200, catalog);
        case 'POST /install-binary': {
          if (downloading) return send(res, 409, { error: 'busy' });
          downloading = true;
          installBinary((r, t) => { download = { modelId: '__binary__', receivedBytes: r, totalBytes: t }; })
            .catch(() => {}) // surfaced via binaryInstalled staying false
            .finally(() => { download = null; downloading = false; });
          return send(res, 202, {});
        }
        case 'POST /download': {
          const { modelId } = await readBody(req);
          const m = catalog.find((x) => x.id === modelId);
          if (!m) return send(res, 404, { error: 'unknown model' });
          if (downloading) return send(res, 409, { error: 'busy' });
          downloading = true;
          (async () => {
            const totalBytes = m.files.reduce((a, f) => a + f.bytes, 0);
            let doneBytes = 0;
            for (const f of m.files) {
              await downloadFile(hfUrl(m, f.name), join(modelsDir(), m.id, f.name), f.sha256, f.bytes,
                (r) => { download = { modelId: m.id, receivedBytes: doneBytes + r, totalBytes }; });
              doneBytes += f.bytes;
            }
          })().catch(() => {}).finally(() => { download = null; downloading = false; });
          return send(res, 202, {});
        }
        case 'POST /start': {
          const { modelId } = await readBody(req);
          const m = catalog.find((x) => x.id === modelId);
          if (!m) return send(res, 404, { error: 'unknown model' });
          if (!binaryInstalled() || !modelDownloaded(m)) return send(res, 428, { error: 'binary or model not downloaded' });
          if (deps.supervisor.state === 'ready' || deps.supervisor.state === 'loading-model') {
            await deps.supervisor.stop(); // one-model policy: replace our own automatically
          }
          const available = await deps.availableBytes();
          const fit = checkFit(m.memoryBytes, available, totalRamBytes());
          if (!fit.fits) {
            const foreign = await scanForeign([deps.supervisor.managedPid() ?? -1, process.pid]);
            const foreignBytes = foreign.reduce((a, p) => a + p.rssBytes, 0);
            const rejection: StartRejection = {
              reason: 'insufficient-memory',
              requiredBytes: fit.requiredBytes,
              availableBytes: fit.availableBytes,
              wouldFitAfterForeignKill: checkFit(m.memoryBytes, available + foreignBytes, totalRamBytes()).fits,
              foreign,
            };
            return send(res, 409, rejection);
          }
          await deps.supervisor.start(m, modelPath(m));
          return send(res, 200, {});
        }
        case 'POST /stop': { await deps.supervisor.stop(); return send(res, 200, {}); }
        case 'GET /foreign': return send(res, 200, await scanForeign([deps.supervisor.managedPid() ?? -1, process.pid]));
        case 'POST /foreign/kill': {
          const { pids } = await readBody(req);
          if (!Array.isArray(pids) || pids.some((p) => typeof p !== 'number')) return send(res, 400, { error: 'pids must be number[]' });
          return send(res, 200, killPids(pids));
        }
        case 'POST /shutdown': {
          send(res, 200, {});
          await deps.supervisor.stop();
          setTimeout(() => process.exit(0), 100);
          return;
        }
        default: return send(res, 404, { error: 'not found' });
      }
    } catch (e) {
      return send(res, 500, { error: String(e) });
    }
  });
}
