export interface DiscoveryWorkerConnection {
  id: string;
  organizationId: string;
  serviceTitanTenantId: string;
  environment: "production" | "integration";
  secretReference: string;
  configurationRevision?: string;
  discoveryRunId: string;
}

export interface DiscoveryCredentials {
  clientId: string;
  clientSecret: string;
  appKey: string;
}

export type DiscoveryRpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

export class DiscoveryError extends Error {
  readonly code: string;
}

export const BUSINESS_UNIT_PAGE_SIZE: number;
export const MAX_BUSINESS_UNIT_PAGES: number;
export const MAX_BUSINESS_UNITS: number;
export function readBoundedJson(response: Response, maximumBytes: number, code: string): Promise<unknown>;
export function fetchWithDiscoveryPolicy(
  url: string,
  init: RequestInit,
  operation: string,
  options?: DiscoveryNetworkOptions,
): Promise<Response>;

export interface DiscoveryNetworkOptions {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  maximumAttempts?: number;
  deadlineAt?: number;
}

export function runBusinessUnitDiscovery(input: DiscoveryNetworkOptions & {
  organizationId: string;
  connectionId: string;
  rpc: DiscoveryRpc;
  resolveCredentials: (connection: DiscoveryWorkerConnection) => Promise<DiscoveryCredentials>;
}): Promise<{ discoveryRunId: string; businessUnitCount: number }>;
