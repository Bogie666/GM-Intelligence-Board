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

export interface DomoDatasetContract {
  datasetId: string;
  valueColumn?: string | null;
  reduction: "sum" | "average" | "count" | "latest";
  periodMode?: "none" | "date" | "month_year";
  dateColumn?: string | null;
  monthColumn?: string | null;
  yearColumn?: string | null;
  filterColumn?: string | null;
  filterValue?: string | null;
  expectedPeriodRows?: number | null;
}

export function validateDomoDatasetContract(contract: DomoDatasetContract): true;
export function reduceDomoRows(input: {
  header: string[];
  rows: string[][];
  contract: DomoDatasetContract;
  period: { start: Date; end: Date };
  timeZone?: string;
}): { value: string; rowCount: number; sourceRowCount: number; reduction: DomoDatasetContract["reduction"] };
export function executeDomoDatasetSource(input: {
  credentials: DomoCredentials;
  contract: DomoDatasetContract;
  period: { start: Date; end: Date };
  timeZone?: string;
  options?: NetworkOptions;
}): Promise<{ value: string; rowCount: number; sourceRowCount: number; reduction: DomoDatasetContract["reduction"] }>;
