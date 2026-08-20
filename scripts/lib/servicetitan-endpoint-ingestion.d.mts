export interface NetworkOptions {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  maximumAttempts?: number;
  deadlineAt?: number;
}

export interface ServiceTitanCredentials {
  clientId: string;
  clientSecret: string;
  appKey: string;
}

export interface Period {
  start: Date;
  end: Date;
}

export interface CustomEndpointExecutionInput {
  credentials: ServiceTitanCredentials;
  environment: string;
  tenantId: string;
  category: string;
  queryParameters: Record<string, unknown>;
  reduction: string;
  valueField: string | null;
  businessUnitMappings: Record<string, unknown>;
  businessUnitField: string | null;
  period: Period;
  options?: NetworkOptions;
}

export interface CustomEndpointExecutionResult {
  decimalValue: string;
  decimalNumerator: string | null;
  decimalDenominator: string | null;
  rowCount: number;
  totalRowCount: number;
  pageCount: number;
}

export function executeCustomEndpointSource(input: CustomEndpointExecutionInput): Promise<CustomEndpointExecutionResult>;
