import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  executeCustomEndpointSource,
} from "../../scripts/lib/servicetitan-endpoint-ingestion.mjs";
import {
  exportDomoDatasetCsv,
  fetchDomoDatasetMetadata,
  obtainDomoToken,
  parseDomoCredentialPayload,
  parseDomoCsv,
} from "../../scripts/lib/domo-dataset.mjs";
import { parseCredentialPayload } from "../../scripts/lib/servicetitan-validation.mjs";
import { governBinding } from "../../scripts/approve-data-source-binding.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VAULT_REFERENCE = /^supabase-vault:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_EXECUTION_BUDGET_MS = 50_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAXIMUM_ATTEMPTS = 2;
const DOMO_CAPABILITIES = Object.freeze(["data"]);
const DOMO_VALIDATION_ERROR_CODE = "validation_failed";

type GovernedMethod = "custom_endpoint" | "domo_dataset";

type WorkerOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

type InspectionPeriod = {
  start: Date;
  end: Date;
};

export type DataSourceGovernanceInput = {
  organizationId: string;
  bindingId: string;
  actorProfileId: string;
  periodStart: string;
  periodEnd: string;
  referenceValue: string;
  tolerance: string;
};

type CustomEndpointSource = {
  id: string;
  organization_id: string;
  connection_id: string;
  service_titan_tenant_id: string;
  category: string;
  query_parameters: Record<string, unknown>;
  reduction: string;
  value_field: string | null;
  business_unit_field: string | null;
  lifecycle: string;
  status: string;
  canonical_source_fingerprint: string;
};

type ServiceTitanConnection = {
  id: string;
  organization_id: string;
  service_titan_tenant_id: string;
  environment: string;
  status: string;
  secret_reference: string;
};

type DomoConnection = {
  id: string;
  organization_id: string;
  status: string;
  secret_reference: string;
};

type DomoDatasetSource = {
  id: string;
  organization_id: string;
  domo_connection_id: string;
  dataset_id: string;
  value_column: string | null;
  reduction: string;
  period_mode: string;
  date_column: string | null;
  month_column: string | null;
  year_column: string | null;
  filter_column: string | null;
  filter_value: string | null;
  expected_period_rows: number | null;
  lifecycle: string;
  status: string;
  canonical_source_fingerprint: string;
};

type BindingMethodRow = {
  id: string;
  organization_id: string;
  source_method: string | null;
};

export class DataSourceWorkerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DataSourceWorkerError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new DataSourceWorkerError(code, message);
}

function assertIdentity(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) fail("identity_invalid", `${label} must be a canonical UUID.`);
}

function assertPeriod(period: InspectionPeriod) {
  if (!(period.start instanceof Date) || !(period.end instanceof Date)
      || !Number.isFinite(period.start.getTime()) || !Number.isFinite(period.end.getTime())
      || period.end <= period.start) {
    fail("period_invalid", "A valid increasing inspection period is required.");
  }
}

function networkPolicy(options: WorkerOptions) {
  const now = options.now ?? Date.now;
  return {
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    maximumAttempts: DEFAULT_MAXIMUM_ATTEMPTS,
    deadlineAt: now() + DEFAULT_EXECUTION_BUDGET_MS,
  };
}

async function exactSingle<T>(
  query: { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> },
  code: string,
  message: string,
): Promise<T> {
  let result: { data: unknown; error: unknown };
  try {
    result = await query.maybeSingle();
  } catch {
    fail(code, message);
  }
  if (result.error || !result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    fail(code, message);
  }
  return result.data as T;
}

async function governedBooleanRpc(
  client: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
  code: string,
  message: string,
) {
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await client.rpc(name, args));
  } catch {
    fail(code, message);
  }
  if (error || data !== true) fail(code, message);
}

async function resolveServiceTitanCredentials(
  client: SupabaseClient,
  organizationId: string,
  connection: ServiceTitanConnection,
) {
  if (!VAULT_REFERENCE.test(connection.secret_reference)) {
    fail("credential_unavailable", "The managed ServiceTitan credential is unavailable.");
  }
  const { data, error } = await client.rpc("resolve_service_titan_connection_secret", {
    p_organization_id: organizationId,
    p_connection_id: connection.id,
    p_purpose: "validation",
  });
  if (error || typeof data !== "string" || !data) {
    fail("credential_unavailable", "The managed ServiceTitan credential is unavailable.");
  }
  try {
    return parseCredentialPayload(data);
  } catch {
    fail("credential_unavailable", "The managed ServiceTitan credential is unavailable.");
  }
}

async function resolveDomoCredentials(
  client: SupabaseClient,
  organizationId: string,
  connection: DomoConnection,
  purpose: "validation" | "ingestion",
) {
  if (!VAULT_REFERENCE.test(connection.secret_reference)) {
    fail("credential_unavailable", "The managed Domo credential is unavailable.");
  }
  const { data, error } = await client.rpc("resolve_domo_connection_secret", {
    p_organization_id: organizationId,
    p_connection_id: connection.id,
    p_purpose: purpose,
  });
  if (error || typeof data !== "string" || !data) {
    fail("credential_unavailable", "The managed Domo credential is unavailable.");
  }
  try {
    return parseDomoCredentialPayload(data);
  } catch {
    fail("credential_unavailable", "The managed Domo credential is unavailable.");
  }
}

export async function inspectCustomEndpointSource(
  client: SupabaseClient,
  organizationId: string,
  sourceId: string,
  period: InspectionPeriod,
  options: WorkerOptions = {},
): Promise<{ rowCount: number; totalRowCount: number; pageCount: number }> {
  assertIdentity(organizationId, "Organization ID");
  assertIdentity(sourceId, "Source ID");
  assertPeriod(period);

  const source = await exactSingle<CustomEndpointSource>(
    client.from("service_titan_custom_endpoint_sources")
      .select("id,organization_id,connection_id,service_titan_tenant_id,category,query_parameters,reduction,value_field,business_unit_field,lifecycle,status,canonical_source_fingerprint")
      .eq("organization_id", organizationId)
      .eq("id", sourceId)
      .eq("status", "active")
      .neq("lifecycle", "archived"),
    "custom_source_unavailable",
    "The exact active custom endpoint source is unavailable.",
  );

  if (source.id !== sourceId || source.organization_id !== organizationId
      || source.status !== "active" || source.lifecycle === "archived"
      || typeof source.canonical_source_fingerprint !== "string" || !source.canonical_source_fingerprint) {
    fail("custom_source_unavailable", "The exact active custom endpoint source is unavailable.");
  }

  const connection = await exactSingle<ServiceTitanConnection>(
    client.from("service_titan_connections")
      .select("id,organization_id,service_titan_tenant_id,environment,status,secret_reference")
      .eq("organization_id", organizationId)
      .eq("id", source.connection_id)
      .eq("service_titan_tenant_id", source.service_titan_tenant_id)
      .eq("status", "ready"),
    "service_titan_connection_unavailable",
    "The exact ready ServiceTitan connection is unavailable.",
  );

  if (connection.id !== source.connection_id || connection.organization_id !== organizationId
      || connection.service_titan_tenant_id !== source.service_titan_tenant_id || connection.status !== "ready") {
    fail("service_titan_connection_unavailable", "The exact ready ServiceTitan connection is unavailable.");
  }

  const credentials = await resolveServiceTitanCredentials(client, organizationId, connection);
  let sample: { rowCount: number; totalRowCount: number; pageCount: number };
  try {
    sample = await executeCustomEndpointSource({
      credentials,
      environment: connection.environment,
      tenantId: connection.service_titan_tenant_id,
      category: source.category,
      queryParameters: source.query_parameters,
      reduction: source.reduction,
      valueField: source.value_field,
      businessUnitMappings: {},
      businessUnitField: source.business_unit_field,
      period,
      options: networkPolicy(options),
    });
  } catch {
    fail("custom_source_inspection_failed", "Custom endpoint source inspection failed.");
  }

  await governedBooleanRpc(
    client,
    "inspect_service_titan_custom_endpoint_source",
    {
      p_organization_id: organizationId,
      p_source_id: sourceId,
      p_expected_fingerprint: source.canonical_source_fingerprint,
    },
    "custom_source_inspection_stale",
    "The custom endpoint source changed during inspection.",
  );

  return {
    rowCount: sample.rowCount,
    totalRowCount: sample.totalRowCount,
    pageCount: sample.pageCount,
  };
}

export async function validateDomoConnection(
  client: SupabaseClient,
  organizationId: string,
  connectionId: string,
  options: WorkerOptions = {},
): Promise<{ status: "ready"; capabilities: string[] }> {
  assertIdentity(organizationId, "Organization ID");
  assertIdentity(connectionId, "Connection ID");

  const connection = await exactSingle<DomoConnection>(
    client.from("domo_connections")
      .select("id,organization_id,status,secret_reference")
      .eq("organization_id", organizationId)
      .eq("id", connectionId)
      .in("status", ["needs_attention", "ready"]),
    "domo_connection_unavailable",
    "The exact enabled Domo connection is unavailable.",
  );
  if (connection.id !== connectionId || connection.organization_id !== organizationId
      || !["needs_attention", "ready"].includes(connection.status)) {
    fail("domo_connection_unavailable", "The exact enabled Domo connection is unavailable.");
  }

  try {
    const credentials = await resolveDomoCredentials(client, organizationId, connection, "validation");
    await obtainDomoToken(credentials, networkPolicy(options));
    await governedBooleanRpc(
      client,
      "set_domo_connection_status",
      {
        p_organization_id: organizationId,
        p_connection_id: connectionId,
        p_status: "ready",
        p_error_code: null,
      },
      "domo_validation_stale",
      "The Domo connection changed during validation.",
    );
    return { status: "ready", capabilities: [...DOMO_CAPABILITIES] };
  } catch (primaryError) {
    if (primaryError instanceof DataSourceWorkerError && primaryError.code === "domo_validation_stale") throw primaryError;
    try {
      await client.rpc("set_domo_connection_status", {
        p_organization_id: organizationId,
        p_connection_id: connectionId,
        p_status: "needs_attention",
        p_error_code: DOMO_VALIDATION_ERROR_CODE,
      });
    } catch {
      // Preserve the fixed, sanitized validation failure.
    }
    fail("domo_validation_failed", "Domo connection validation failed.");
  }
}

export async function inspectDomoDatasetSource(
  client: SupabaseClient,
  organizationId: string,
  sourceId: string,
  options: WorkerOptions = {},
): Promise<{ datasetName: string; rowCount: number; columnCount: number }> {
  assertIdentity(organizationId, "Organization ID");
  assertIdentity(sourceId, "Source ID");

  const source = await exactSingle<DomoDatasetSource>(
    client.from("domo_dataset_sources")
      .select("id,organization_id,domo_connection_id,dataset_id,value_column,reduction,period_mode,date_column,month_column,year_column,filter_column,filter_value,expected_period_rows,lifecycle,status,canonical_source_fingerprint")
      .eq("organization_id", organizationId)
      .eq("id", sourceId)
      .eq("status", "active")
      .neq("lifecycle", "archived"),
    "domo_source_unavailable",
    "The exact active Domo dataset source is unavailable.",
  );
  if (source.id !== sourceId || source.organization_id !== organizationId
      || source.status !== "active" || source.lifecycle === "archived"
      || typeof source.canonical_source_fingerprint !== "string" || !source.canonical_source_fingerprint) {
    fail("domo_source_unavailable", "The exact active Domo dataset source is unavailable.");
  }

  const connection = await exactSingle<DomoConnection>(
    client.from("domo_connections")
      .select("id,organization_id,status,secret_reference")
      .eq("organization_id", organizationId)
      .eq("id", source.domo_connection_id)
      .eq("status", "ready"),
    "domo_connection_unavailable",
    "The exact ready Domo connection is unavailable.",
  );
  if (connection.id !== source.domo_connection_id || connection.organization_id !== organizationId || connection.status !== "ready") {
    fail("domo_connection_unavailable", "The exact ready Domo connection is unavailable.");
  }

  const credentials = await resolveDomoCredentials(client, organizationId, connection, "validation");
  const policy = networkPolicy(options);
  let metadata: { name: string };
  let parsed: { header: string[]; rows: string[][] };
  try {
    const token = await obtainDomoToken(credentials, policy);
    metadata = await fetchDomoDatasetMetadata({ token, datasetId: source.dataset_id, options: policy });
    const csv = await exportDomoDatasetCsv({ token, datasetId: source.dataset_id, options: policy });
    parsed = parseDomoCsv(csv);
  } catch {
    fail("domo_source_inspection_failed", "Domo dataset source inspection failed.");
  }

  const configuredColumns = [source.value_column, source.date_column, source.month_column, source.year_column, source.filter_column]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const exportedColumns = new Set(parsed.header);
  if (configuredColumns.some((column) => !exportedColumns.has(column))) {
    fail("domo_configured_column_missing", "A configured Domo dataset column is absent from the export.");
  }

  await governedBooleanRpc(
    client,
    "inspect_domo_dataset_source",
    {
      p_organization_id: organizationId,
      p_source_id: sourceId,
      p_expected_fingerprint: source.canonical_source_fingerprint,
    },
    "domo_inspection_stale",
    "The Domo dataset source changed during inspection.",
  );

  return {
    datasetName: metadata.name,
    rowCount: parsed.rows.length,
    columnCount: parsed.header.length,
  };
}

export async function governDataSourceBinding(
  client: SupabaseClient,
  input: DataSourceGovernanceInput,
  expectedMethod: GovernedMethod,
  options: WorkerOptions = {},
): Promise<{ approved: boolean; delta: string; tolerance: string; rowCount: number }> {
  if (expectedMethod !== "custom_endpoint" && expectedMethod !== "domo_dataset") {
    fail("binding_method_invalid", "The data-source governance method is invalid.");
  }
  assertIdentity(input.organizationId, "Organization ID");
  assertIdentity(input.bindingId, "Binding ID");
  assertIdentity(input.actorProfileId, "Actor profile ID");

  const binding = await exactSingle<BindingMethodRow>(
    client.from("custom_kpi_location_bindings")
      .select("id,organization_id,source_method")
      .eq("organization_id", input.organizationId)
      .eq("id", input.bindingId),
    "binding_unavailable",
    "The exact data-source binding is unavailable.",
  );
  if (binding.id !== input.bindingId || binding.organization_id !== input.organizationId) {
    fail("binding_unavailable", "The exact data-source binding is unavailable.");
  }
  if (binding.source_method !== expectedMethod) {
    fail("binding_method_mismatch", "The binding does not use the expected governed source method.");
  }

  let result: { approved: boolean; delta: string; tolerance: string; rowCount: number };
  try {
    result = await governBinding({
      "organization-id": input.organizationId,
      "binding-id": input.bindingId,
      "actor-profile-id": input.actorProfileId,
      "period-start": input.periodStart,
      "period-end": input.periodEnd,
      "reference-value": input.referenceValue,
      tolerance: input.tolerance,
      confirm: `${input.organizationId}:${input.bindingId}:${new Date(input.periodStart).toISOString()}`,
    }, {
      supabase: client,
      expectedMethod,
      executionOptions: networkPolicy(options),
    });
  } catch (error) {
    if (error instanceof DataSourceWorkerError) throw error;
    fail("binding_governance_failed", "Data-source binding governance failed.");
  }

  return {
    approved: result.approved,
    delta: String(result.delta),
    tolerance: String(result.tolerance),
    rowCount: result.rowCount,
  };
}
