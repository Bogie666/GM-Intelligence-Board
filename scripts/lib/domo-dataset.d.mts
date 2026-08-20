export interface NetworkOptions {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  maximumAttempts?: number;
  deadlineAt?: number;
}

export interface DomoCredentials {
  clientId: string;
  clientSecret: string;
}

export function parseDomoCredentialPayload(raw: string): DomoCredentials;
export function obtainDomoToken(credentials: DomoCredentials, options?: NetworkOptions): Promise<string>;
export function fetchDomoDatasetMetadata(input: {
  token: string;
  datasetId: string;
  options?: NetworkOptions;
}): Promise<{ id: string; name: string; rows: number | null; columns: number | null }>;
export function exportDomoDatasetCsv(input: {
  token: string;
  datasetId: string;
  options?: NetworkOptions;
}): Promise<string>;
export function parseDomoCsv(text: string): { header: string[]; rows: string[][] };
