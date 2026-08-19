export interface WorkerConnection {
  id: string;
  organizationId: string;
  serviceTitanTenantId: string;
  environment: "production" | "integration";
  secretReference: string;
  configurationRevision?: string;
  discoveryRunId?: string;
}

export interface ServiceTitanCredentials {
  clientId: string;
  clientSecret: string;
  appKey: string;
}

export type WorkerRpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

export class ValidationError extends Error {
  readonly code: string;
}

export function parseCredentialPayload(raw: string): ServiceTitanCredentials;
export function parseValidationWorkerContext(value: unknown, organizationId: string, connectionId: string): WorkerConnection;
export function probeServiceTitanConnection(
  connection: WorkerConnection,
  credentials: ServiceTitanCredentials,
  options?: WorkerNetworkOptions,
): Promise<string[]>;

export interface WorkerNetworkOptions {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  maximumAttempts?: number;
  deadlineAt?: number;
}

export function runServiceTitanConnectionValidation(input: WorkerNetworkOptions & {
  organizationId: string;
  connectionId: string;
  rpc: WorkerRpc;
  resolveCredentials: (connection: WorkerConnection) => Promise<ServiceTitanCredentials>;
}): Promise<{ capabilities: string[] }>;
