export type ServerState =
  | 'idle'
  | 'downloading'
  | 'starting'
  | 'loading-model'
  | 'ready'
  | 'stopping'
  | 'crashed';

export interface DownloadProgress {
  modelId: string;
  receivedBytes: number;
  totalBytes: number;
}

export interface EmbedRequest { texts: string[] }
export interface EmbedResponse { vectors: number[][] }
export interface EmbedStatus {
  state: ServerState;
  modelId: string | null;
  endpoint: string | null;
}

export interface StatusResponse {
  state: ServerState;
  modelId: string | null;
  endpoint: string | null; // e.g. http://127.0.0.1:PORT when ready
  download: DownloadProgress | null;
  crashLog: string[] | null; // last stderr lines when state === 'crashed'
  ram: { totalBytes: number; availableBytes: number };
  binaryInstalled: boolean;
  downloadedModelIds: string[];
  downloadError: string | null; // last download/install failure, surfaced to the UI
  embed: EmbedStatus;
}

export interface ForeignProcess {
  pid: number;
  command: string; // truncated command line
  rssBytes: number; // best-effort resident size
}

export interface StartRejection {
  reason: 'insufficient-memory';
  requiredBytes: number;
  availableBytes: number;
  wouldFitAfterForeignKill: boolean;
  foreign: ForeignProcess[];
}
