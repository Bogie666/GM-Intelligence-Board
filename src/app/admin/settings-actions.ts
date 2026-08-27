"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getTenantAuthContext, isAdminRole } from "@/lib/auth";
import { getAppConfig } from "@/lib/env";
import { reportSchemaFingerprint, selectableServiceTitanEndpointRecipes, type ServiceTitanReportField } from "@/lib/service-titan-sources";
import { validateCustomEndpointSourceInput } from "@/lib/custom-endpoint-sources";
import {
  validateBoundedDecimal,
  validateCompletedPeriod,
  validateDomoConnectionInput,
  validateDomoDatasetSourceInput,
  validateDomoRefreshCadence,
} from "@/lib/domo-admin";
import {
  governDataSourceBinding,
  inspectCustomEndpointSource,
  inspectDomoDatasetSource,
  validateDomoConnection,
} from "@/lib/data-source-workers";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/service-role";
import {
  isIsoDate,
  isValidMetricKey,
  parseConfigurationJson,
  parseFiniteConfigurationNumber,
  validateEndpointRecipeBindingConfiguration,
} from "@/lib/production-admin-settings";
import { validateUuid } from "@/lib/tenant-context";
import type { AdminActionState } from "./actions";

const SOURCE_METHODS = new Set(["endpoint_recipe", "saved_report", "custom_endpoint", "domo_dataset"]);
const OBSERVATION_WINDOWS = new Set(["trailing", "today", "mtd", "ytd"]);
const REPORT_REDUCTIONS = new Set(["sum", "average", "count", "ratio"]);
const ENDPOINT_REFRESH_INTERVALS = new Set(["15m", "30m", "1h", "4h", "12h", "24h"]);
const SELECTABLE_ENDPOINT_RECIPE_KEYS = new Set(selectableServiceTitanEndpointRecipes.map((recipe) => `${recipe.id}:${recipe.version}`));
const REPORT_REFRESH_INTERVALS = new Set(["4h", "12h", "24h"]);
const CUSTOM_ENDPOINT_REFRESH_INTERVALS = new Set(["1h", "4h", "12h", "24h"]);
const TARGET_LIFECYCLES = new Set(["draft", "published"]);
const FIELD_TYPES = new Set(["number", "string", "date", "boolean"]);
const PARAMETER_TYPES = new Set(["String", "Number", "Boolean", "Date", "Time"]);

type DatabaseError = { code?: string; message?: string } | null;

function input(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function rawInput(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function nonNegativeIntegerInput(formData: FormData, key: string): number | null {
  const value = input(formData, key);
  if (!/^(0|[1-9]\d{0,8})$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function failure(message: string, fieldErrors?: Record<string, string>): AdminActionState {
  return { status: "error", message, ...(fieldErrors ? { fieldErrors } : {}) };
}

function databaseFailure(operation: string, error: DatabaseError): AdminActionState {
  if (error?.code === "23505") return failure(`${operation} conflicts with an existing tenant record.`);
  if (error?.code === "23514" || error?.code === "23503") return failure(`${operation} does not satisfy the governed tenant configuration.`);
  return failure(`${operation} could not be saved by the tenant database. No success is being reported.`);
}

function exactUuidRpcResult(data: unknown, error: DatabaseError): data is string {
  return !error && typeof data === "string" && validateUuid(data);
}

function safeWorkerFailure(operation: string): AdminActionState {
  return failure(`${operation} could not be completed by the trusted worker. Try again after verifying the governed source configuration.`);
}

async function hasValidRequestOrigin(): Promise<boolean> {
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin");
  const host = requestHeaders.get("host");
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === host && (parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

async function writableTenant(): Promise<
  | { ok: true; organizationId: string; profileId: string; supabase: NonNullable<Awaited<ReturnType<typeof getTenantAuthContext>> extends infer T ? T extends { ok: true; supabase: infer S } ? S : never : never> }
  | { ok: false; state: AdminActionState }
> {
  if (!(await hasValidRequestOrigin())) return { ok: false, state: failure("The request origin could not be verified.") };
  if (getAppConfig().isDemo) return { ok: false, state: failure("Demo mode does not write tenant data.") };
  const auth = await getTenantAuthContext();
  if (!auth.ok) return { ok: false, state: failure("Your authenticated tenant membership could not be verified.") };
  if (!isAdminRole(auth.membership.role)) return { ok: false, state: failure("Only tenant owners and administrators can change this configuration.") };
  return { ok: true, organizationId: auth.membership.organizationId, profileId: auth.user.id, supabase: auth.supabase };
}

function refreshAdmin() {
  revalidatePath("/admin");
  revalidatePath("/");
}

function validReportFields(value: unknown): value is ServiceTitanReportField[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) return false;
  const names = new Set<string>();
  return value.every((field) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) return false;
    const candidate = field as Record<string, unknown>;
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const keys = Object.keys(candidate);
    if (!name || names.has(name) || name.length > 160 || keys.some((key) => !["name", "label", "type"].includes(key))) return false;
    names.add(name);
    return typeof candidate.label === "string" && candidate.label.trim().length > 0 && candidate.label.length <= 200
      && typeof candidate.type === "string" && FIELD_TYPES.has(candidate.type);
  });
}

function validReportParameters(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 100) return false;
  const names = new Set<string>();
  return value.every((parameter) => {
    if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) return false;
    const candidate = parameter as Record<string, unknown>;
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const keys = Object.keys(candidate);
    if (!name || names.has(name) || name.length > 160 || keys.some((key) => !["name", "label", "dataType", "isArray", "isRequired", "dynamicSetId"].includes(key))) return false;
    names.add(name);
    return typeof candidate.label === "string" && candidate.label.trim().length > 0 && candidate.label.length <= 200
      && typeof candidate.dataType === "string" && PARAMETER_TYPES.has(candidate.dataType)
      && typeof candidate.isArray === "boolean" && typeof candidate.isRequired === "boolean"
      && (candidate.dynamicSetId === undefined || (typeof candidate.dynamicSetId === "string" && candidate.dynamicSetId.trim() !== "" && candidate.dynamicSetId.length <= 160));
  });
}

export async function createCustomEndpointSourceAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await writableTenant();
  if (!writable.ok) return writable.state;

  const connectionId = input(formData, "connectionId");
  const serviceTitanTenantId = input(formData, "serviceTitanTenantId");
  const validated = validateCustomEndpointSourceInput({
    name: rawInput(formData, "name"),
    description: rawInput(formData, "description"),
    category: input(formData, "category"),
    queryParameters: rawInput(formData, "queryParameters"),
    reduction: input(formData, "reduction"),
    valueField: rawInput(formData, "valueField"),
    businessUnitField: rawInput(formData, "businessUnitField"),
  });
  const fieldErrors: Record<string, string> = validated.ok ? {} : { ...validated.fieldErrors };
  if (!validateUuid(connectionId)) fieldErrors.connectionId = "Choose a valid ServiceTitan connection.";
  if (!serviceTitanTenantId || serviceTitanTenantId.length > 200) {
    fieldErrors.serviceTitanTenantId = "Choose the exact bounded ServiceTitan tenant for this connection.";
  }
  if (!validated.ok || Object.keys(fieldErrors).length > 0) {
    return failure("Correct the custom endpoint source and try again.", fieldErrors);
  }

  const { data, error } = await writable.supabase.rpc("create_service_titan_custom_endpoint_source", {
    p_organization_id: writable.organizationId,
    p_connection_id: connectionId,
    p_service_titan_tenant_id: serviceTitanTenantId,
    p_name: validated.value.name,
    p_description: validated.value.description,
    p_category: validated.value.category,
    p_query_parameters: validated.value.queryParameters,
    p_reduction: validated.value.reduction,
    p_value_field: validated.value.valueField,
    p_business_unit_field: validated.value.businessUnitField,
  });
  if (!exactUuidRpcResult(data, error)) return databaseFailure("Custom endpoint source", error);
  refreshAdmin();
  return { status: "success", message: "Custom endpoint source created as a governed draft." };
}

export async function archiveCustomEndpointSourceAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await writableTenant();
  if (!writable.ok) return writable.state;
  const sourceId = input(formData, "sourceId");
  const expectedDependentBindings = nonNegativeIntegerInput(formData, "expectedDependentBindings");
  if (!validateUuid(sourceId) || expectedDependentBindings === null) {
    return failure("The custom endpoint archive impact is incomplete. Reload and review dependencies before retrying.");
  }
  try {
    const { data, error } = await writable.supabase.rpc("archive_service_titan_custom_endpoint_source", {
      p_organization_id: writable.organizationId,
      p_source_id: sourceId,
      p_expected_dependent_bindings: expectedDependentBindings,
    });
    if (error || data !== true) return failure("The source or its dependency count changed. Reload, review impact, and retry.");
  } catch {
    refreshAdmin();
    return failure("The archive response was interrupted. Reload before retrying so the current source state is verified.");
  }
  refreshAdmin();
  return { status: "success", message: "Custom endpoint source archived." };
}

export async function inspectCustomEndpointSourceAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await writableTenant();
  if (!writable.ok) return writable.state;
  const sourceId = input(formData, "sourceId");
  const period = validateCompletedPeriod({
    periodStart: rawInput(formData, "periodStart"),
    periodEnd: rawInput(formData, "periodEnd"),
  });
  const fieldErrors: Record<string, string> = period.ok ? {} : { ...period.fieldErrors };
  if (!validateUuid(sourceId)) fieldErrors.sourceId = "Choose a valid custom endpoint source.";
  if (!period.ok || Object.keys(fieldErrors).length > 0) {
    return failure("Correct the custom endpoint inspection period and try again.", fieldErrors);
  }
  try {
    const serviceClient = createServiceRoleSupabaseClient();
    const result = await inspectCustomEndpointSource(
      serviceClient,
      writable.organizationId,
      sourceId,
      { start: new Date(period.value.periodStart), end: new Date(period.value.periodEnd) },
    );
    refreshAdmin();
    return {
      status: "success",
      message: `Custom endpoint source inspected successfully (${result.rowCount} sampled rows across ${result.pageCount} pages).`,
    };
  } catch {
    return safeWorkerFailure("Custom endpoint inspection");
  }
}

export async function registerDomoConnectionAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await writableTenant();
  if (!writable.ok) return writable.state;
  const validated = validateDomoConnectionInput({
    displayName: rawInput(formData, "displayName"),
    clientId: rawInput(formData, "clientId"),
    clientSecret: rawInput(formData, "clientSecret"),
  });
  if (!validated.ok) return failure("Correct the Domo connection fields and try again.", validated.fieldErrors);
  const { data, error } = await writable.supabase.rpc("register_domo_connection_with_credentials", {
    p_organization_id: writable.organizationId,
    p_display_name: validated.value.displayName,
    p_client_id: validated.value.clientId,
    p_client_secret: validated.value.clientSecret,
  });
  if (!exactUuidRpcResult(data, error)) return failure("Domo connection registration failed. No credentials or provider details were returned.");
  refreshAdmin();
  return { status: "success", message: "Domo connection registered. Validate it before creating production bindings." };
}

export async function validateDomoConnectionAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await writableTenant();
  if (!writable.ok) return writable.state;
  const connectionId = input(formData, "connectionId");
  if (!validateUuid(connectionId)) return failure("Choose a valid Domo connection.");
  try {
    const serviceClient = createServiceRoleSupabaseClient();
    await validateDomoConnection(serviceClient, writable.organizationId, connectionId);
    refreshAdmin();
    return { status: "success", message: "Domo credentials validated. The connection is ready." };
  } catch {
    refreshAdmin();
    return safeWorkerFailure("Domo connection validation");
  }
}

export async function disableDomoConnectionAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await writableTenant();
  if (!writable.ok) return writable.state;
  const connectionId = input(formData, "connectionId");
  const expectedDependentSources = nonNegativeIntegerInput(formData, "expectedDependentSources");
  const expectedDependentBindings = nonNegativeIntegerInput(formData, "expectedDependentBindings");
  if (!validateUuid(connectionId) || expectedDependentSources === null || expectedDependentBindings === null) {
    return failure("The Domo disable impact is incomplete. Reload and review dependencies before retrying.");
  }
  try {
    const { data, error } = await writable.supabase.rpc("disable_domo_connection", {
      p_organization_id: writable.organizationId,
      p_connection_id: connectionId,
      p_expected_dependent_sources: expectedDependentSources,
      p_expected_dependent_bindings: expectedDependentBindings,
    });
    if (error || data !== true) return failure("The connection or its dependency counts changed. Reload, review impact, and retry.");
  } catch {
    refreshAdmin();
    return failure("The disable response was interrupted. Reload before retrying so credential and connection state are verified.");
  }
  refreshAdmin();
  return { status: "success", message: "Domo connection disabled and its exact managed Vault credential permanently retired." };
}

export async function createDomoDatasetSourceAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await writableTenant();
  if (!writable.ok) return writable.state;
  const connectionId = input(formData, "connectionId");
  const validated = validateDomoDatasetSourceInput({
    datasetId: rawInput(formData, "datasetId"),
    name: rawInput(formData, "name"),
    description: rawInput(formData, "description"),
    valueColumn: rawInput(formData, "valueColumn"),
    reduction: input(formData, "reduction"),
    dateColumn: rawInput(formData, "dateColumn"),
    filterColumn: rawInput(formData, "filterColumn"),
    filterValue: rawInput(formData, "filterValue"),
  });
  const fieldErrors: Record<string, string> = validated.ok ? {} : { ...validated.fieldErrors };
  if (!validateUuid(connectionId)) fieldErrors.connectionId = "Choose a valid Domo connection.";
  if (!validated.ok || Object.keys(fieldErrors).length > 0) {
    return failure("Correct the Domo dataset source and try again.", fieldErrors);
  }
  const { data, error } = await writable.supabase.rpc("create_domo_dataset_source", {
    p_organization_id: writable.organizationId,
    p_domo_connection_id: connectionId,
    p_dataset_id: validated.value.datasetId,
    p_name: validated.value.name,
    p_description: validated.value.description,
    p_value_column: validated.value.valueColumn,
    p_reduction: validated.value.reduction,
    p_date_column: validated.value.dateColumn,
    p_filter_column: validated.value.filterColumn,
    p_filter_value: validated.value.filterValue,
  });
  if (!exactUuidRpcResult(data, error)) return databaseFailure("Domo dataset source", error);
  refreshAdmin();
  return { status: "success", message: "Domo dataset source created as a governed draft." };
}

export async function archiveDomoDatasetSourceAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await writableTenant();
  if (!writable.ok) return writable.state;
  const sourceId = input(formData, "sourceId");
  const expectedDependentBindings = nonNegativeIntegerInput(formData, "expectedDependentBindings");
  if (!validateUuid(sourceId) || expectedDependentBindings === null) {
    return failure("The Domo archive impact is incomplete. Reload and review dependencies before retrying.");
  }
  try {
    const { data, error } = await writable.supabase.rpc("archive_domo_dataset_source", {
      p_organization_id: writable.organizationId,
      p_source_id: sourceId,
      p_expected_dependent_bindings: expectedDependentBindings,
    });
    if (error || data !== true) return failure("The source or its dependency count changed. Reload, review impact, and retry.");
  } catch {
    refreshAdmin();
    return failure("The archive response was interrupted. Reload before retrying so the current source state is verified.");
  }
  refreshAdmin();
  return { status: "success", message: "Domo dataset source archived." };
}

export async function inspectDomoDatasetSourceAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await writableTenant();
  if (!writable.ok) return writable.state;
  const sourceId = input(formData, "sourceId");
  if (!validateUuid(sourceId)) return failure("Choose a valid Domo dataset source.");
  try {
    const serviceClient = createServiceRoleSupabaseClient();
    const result = await inspectDomoDatasetSource(serviceClient, writable.organizationId, sourceId);
    refreshAdmin();
    return {
      status: "success",
      message: `Domo dataset source inspected successfully (${result.rowCount} rows and ${result.columnCount} columns).`,
    };
  } catch {
    return safeWorkerFailure("Domo dataset inspection");
  }
}

async function governBindingAction(
  formData: FormData,
  expectedMethod: "custom_endpoint" | "domo_dataset",
): Promise<AdminActionState> {
  const writable = await writableTenant();
  if (!writable.ok) return writable.state;
  const bindingId = input(formData, "bindingId");
  const period = validateCompletedPeriod({
    periodStart: rawInput(formData, "periodStart"),
    periodEnd: rawInput(formData, "periodEnd"),
  });
  const referenceValue = validateBoundedDecimal(rawInput(formData, "referenceValue"), { field: "referenceValue" });
  const tolerance = validateBoundedDecimal(rawInput(formData, "tolerance"), { field: "tolerance", nonNegative: true });
  const fieldErrors: Record<string, string> = {
    ...(!period.ok ? period.fieldErrors : {}),
    ...(!referenceValue.ok ? referenceValue.fieldErrors : {}),
    ...(!tolerance.ok ? tolerance.fieldErrors : {}),
  };
  if (!validateUuid(bindingId)) fieldErrors.bindingId = "Choose a valid exact-location KPI binding.";
  if (!period.ok || !referenceValue.ok || !tolerance.ok || Object.keys(fieldErrors).length > 0) {
    return failure("Correct the binding governance evidence and try again.", fieldErrors);
  }
  try {
    const serviceClient = createServiceRoleSupabaseClient();
    const result = await governDataSourceBinding(serviceClient, {
      organizationId: writable.organizationId,
      bindingId,
      actorProfileId: writable.profileId,
      periodStart: period.value.periodStart,
      periodEnd: period.value.periodEnd,
      referenceValue: referenceValue.value,
      tolerance: tolerance.value,
    }, expectedMethod);
    refreshAdmin();
    return result.approved
      ? { status: "success", message: `Binding approved after governed reconciliation of ${result.rowCount} sampled rows.` }
      : failure("Binding reconciliation exceeded tolerance. The binding remains unapproved.");
  } catch {
    return safeWorkerFailure("Data-source binding governance");
  }
}

export async function governCustomEndpointBindingAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  return governBindingAction(formData, "custom_endpoint");
}

export async function governDomoDatasetBindingAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  return governBindingAction(formData, "domo_dataset");
}

export async function registerReportSourceAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await writableTenant();
  if (!writable.ok) return writable.state;

  const connectionId = input(formData, "connectionId");
  const categoryId = input(formData, "categoryId");
  const reportId = input(formData, "reportId");
  const ownerExternalId = input(formData, "ownerExternalId");
  const ownerDisplayName = input(formData, "ownerDisplayName");
  const name = input(formData, "name");
  const description = input(formData, "description");
  const providerModifiedAt = input(formData, "providerModifiedAt");
  const fields = parseConfigurationJson(input(formData, "fields"), "array");
  const parameters = parseConfigurationJson(input(formData, "parameters") || "[]", "array");
  const fieldErrors: Record<string, string> = {};
  if (!validateUuid(connectionId)) fieldErrors.connectionId = "Choose a valid tenant connection.";
  if (!categoryId || categoryId.length > 128) fieldErrors.categoryId = "Category ID is required (128 characters maximum).";
  if (!reportId || reportId.length > 128) fieldErrors.reportId = "Report ID is required (128 characters maximum).";
  if (!ownerExternalId || ownerExternalId.length > 160) fieldErrors.ownerExternalId = "Owner ID is required (160 characters maximum).";
  if (!ownerDisplayName || ownerDisplayName.length > 160) fieldErrors.ownerDisplayName = "Owner name is required (160 characters maximum).";
  if (!name || name.length > 200) fieldErrors.name = "Report name is required (200 characters maximum).";
  if (!providerModifiedAt || !Number.isFinite(Date.parse(providerModifiedAt))) fieldErrors.providerModifiedAt = "Enter the provider's valid modified timestamp.";
  if (!fields.ok || !validReportFields(fields.value)) fieldErrors.fields = fields.ok ? "Fields must be a non-empty array of name, label, and supported type records." : fields.message;
  if (!parameters.ok || !validReportParameters(parameters.value)) fieldErrors.parameters = parameters.ok ? "Parameters must contain the governed ServiceTitan parameter shape." : parameters.message;
  if (Object.keys(fieldErrors).length) return failure("Correct the report source fields and try again.", fieldErrors);

  const { data: connection, error: connectionError } = await writable.supabase
    .from("service_titan_connections")
    .select("id, service_titan_tenant_id")
    .eq("organization_id", writable.organizationId).eq("id", connectionId).eq("status", "ready").maybeSingle();
  if (connectionError || !connection) return failure("The selected ServiceTitan connection is not available in this tenant.");

  const reportFields = fields.ok ? fields.value as ServiceTitanReportField[] : [];
  const reportParameters = parameters.ok ? parameters.value : [];
  const { error } = await writable.supabase.from("service_titan_report_sources").insert({
    organization_id: writable.organizationId,
    connection_id: connection.id,
    service_titan_tenant_id: connection.service_titan_tenant_id,
    category_id: categoryId,
    report_id: reportId,
    owner_external_id: ownerExternalId,
    owner_display_name: ownerDisplayName,
    name,
    description,
    parameters: reportParameters,
    fields: reportFields,
    expected_schema_fingerprint: reportSchemaFingerprint(reportFields),
    observed_schema_fingerprint: null,
    provider_modified_at: new Date(providerModifiedAt).toISOString(),
    lifecycle: "draft",
    status: "active",
    verification: "declared",
  });
  if (error) return databaseFailure("Saved report source", error);
  refreshAdmin();
  return { status: "success", message: "Declared report source registered. A trusted worker must inspect and reconcile it before approval." };
}

export async function saveKpiBindingAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await writableTenant();
  if (!writable.ok) return writable.state;

  const kpiDefinitionId = input(formData, "kpiDefinitionId");
  const locationId = input(formData, "locationId");
  const sourceMethod = input(formData, "sourceMethod");
  const refreshInterval = input(formData, "refreshInterval");
  const observationWindow = input(formData, "observationWindow") || "trailing";
  const parameterValues = parseConfigurationJson(rawInput(formData, "parameterValues") || "{}", "object");
  const businessUnitMappings = parseConfigurationJson(rawInput(formData, "businessUnitMappings") || "{}", "object");
  if (![kpiDefinitionId, locationId].every(validateUuid) || !SOURCE_METHODS.has(sourceMethod)) {
    return failure("Choose a published KPI, active location, and supported source method.");
  }
  if (!OBSERVATION_WINDOWS.has(observationWindow)) {
    return failure("Choose a supported observation window: trailing cadence, local day, or local month-to-date.");
  }
  if (!parameterValues.ok || !businessUnitMappings.ok) {
    return failure("Correct the binding JSON and try again.", {
      ...(!parameterValues.ok ? { parameterValues: parameterValues.message } : {}),
      ...(!businessUnitMappings.ok ? { businessUnitMappings: businessUnitMappings.message } : {}),
    });
  }

  const [{ data: definition }, { data: location }, { data: existingBinding }] = await Promise.all([
    writable.supabase.from("custom_kpi_definitions").select("id, type, external_source")
      .eq("organization_id", writable.organizationId).eq("id", kpiDefinitionId).eq("lifecycle", "published").maybeSingle(),
    writable.supabase.from("locations").select("id")
      .eq("organization_id", writable.organizationId).eq("id", locationId).eq("status", "active").maybeSingle(),
    writable.supabase.from("custom_kpi_location_bindings").select("id, approval_status")
      .eq("organization_id", writable.organizationId).eq("kpi_definition_id", kpiDefinitionId)
      .eq("location_id", locationId).neq("approval_status", "archived").maybeSingle(),
  ]);
  if (!definition || !location) return failure("The selected published KPI or exact tenant location is unavailable.");
  if (existingBinding?.approval_status === "approved" || existingBinding?.approval_status === "archived") {
    return failure("The existing approved or archived binding is immutable and cannot be replaced from the Admin Center.");
  }
  if (existingBinding && input(formData, "confirmReplacement") !== "replace") {
    return failure("Confirm replacement of the existing draft binding before changing its source contract.", {
      confirmReplacement: "Explicit replacement confirmation is required.",
    });
  }

  const row: Record<string, unknown> = {
    organization_id: writable.organizationId,
    kpi_definition_id: kpiDefinitionId,
    location_id: locationId,
    connection_id: null,
    service_titan_tenant_id: null,
    source_method: sourceMethod,
    observation_window: observationWindow,
    endpoint_recipe_id: null,
    endpoint_recipe_version: null,
    report_source_id: null,
    custom_endpoint_source_id: null,
    domo_connection_id: null,
    domo_dataset_source_id: null,
    refresh_interval: refreshInterval,
    report_reduction: null,
    parameter_values: parameterValues.value,
    business_unit_mappings: businessUnitMappings.value,
    value_field: null,
    numerator_field: null,
    denominator_field: null,
    canonical_source_fingerprint: null,
    approved_report_source_fingerprint: null,
    approved_custom_endpoint_fingerprint: null,
    approved_domo_dataset_fingerprint: null,
    approval_status: "draft",
    approved_by: null,
    approved_at: null,
  };

  if (sourceMethod === "domo_dataset") {
    const domoConnectionId = input(formData, "domoConnectionId") || input(formData, "connectionId");
    const domoDatasetSourceId = input(formData, "domoDatasetSourceId");
    if (![domoConnectionId, domoDatasetSourceId].every(validateUuid) || !validateDomoRefreshCadence(refreshInterval)) {
      return failure("Choose an active Domo dataset source, ready connection, and supported Domo cadence.");
    }
    const externalSource = definition.external_source;
    if (definition.type !== "external" || !externalSource || typeof externalSource !== "object"
      || Array.isArray(externalSource) || (externalSource as Record<string, unknown>).provider !== "domo") {
      return failure("Domo dataset bindings require a published external KPI whose provider is exactly domo.");
    }
    const [{ data: connection }, { data: source }] = await Promise.all([
      writable.supabase.from("domo_connections").select("id")
        .eq("organization_id", writable.organizationId).eq("id", domoConnectionId).eq("status", "ready").maybeSingle(),
      writable.supabase.from("domo_dataset_sources").select("id")
        .eq("organization_id", writable.organizationId).eq("id", domoDatasetSourceId)
        .eq("domo_connection_id", domoConnectionId).eq("status", "active").neq("lifecycle", "archived").maybeSingle(),
    ]);
    if (!connection || !source) return failure("The exact active Domo source and ready tenant connection are unavailable.");
    row.domo_connection_id = domoConnectionId;
    row.domo_dataset_source_id = domoDatasetSourceId;
  } else {
    const connectionId = input(formData, "connectionId");
    if (!validateUuid(connectionId) || definition.type !== "service_titan") {
      return failure("ServiceTitan source methods require a published ServiceTitan KPI and exact tenant connection.");
    }
    const [{ data: assignment }, { data: connection }] = await Promise.all([
      writable.supabase.from("service_titan_connection_locations").select("id")
        .eq("organization_id", writable.organizationId).eq("connection_id", connectionId)
        .eq("location_id", locationId).is("revoked_at", null).maybeSingle(),
      writable.supabase.from("service_titan_connections").select("id, service_titan_tenant_id")
        .eq("organization_id", writable.organizationId).eq("id", connectionId).neq("status", "archived").maybeSingle(),
    ]);
    if (!assignment || !connection) {
      return failure("The selected ServiceTitan connection must be active and assigned to the exact tenant location.");
    }
    row.connection_id = connectionId;
    row.service_titan_tenant_id = connection.service_titan_tenant_id;

    if (sourceMethod === "endpoint_recipe") {
      const recipeId = input(formData, "endpointRecipeId");
      const recipeVersionRaw = input(formData, "endpointRecipeVersion");
      const recipeVersion = Number(recipeVersionRaw);
      if (!recipeId || recipeId.length > 160 || !/^\d+$/.test(recipeVersionRaw)
        || !Number.isSafeInteger(recipeVersion) || recipeVersion < 1 || !ENDPOINT_REFRESH_INTERVALS.has(refreshInterval)) {
        return failure("Choose a governed endpoint recipe version and supported cadence.");
      }
      if (!SELECTABLE_ENDPOINT_RECIPE_KEYS.has(`${recipeId}:${recipeVersion}`)) {
        return failure("That endpoint recipe version is retired and cannot be used for a new binding.");
      }
      const endpointConfiguration = validateEndpointRecipeBindingConfiguration(
        recipeId,
        recipeVersion,
        parameterValues.value as Record<string, unknown>,
        businessUnitMappings.value as Record<string, unknown>,
      );
      if (!endpointConfiguration.ok) {
        return failure("Correct the endpoint recipe configuration and try again.", endpointConfiguration.fieldErrors);
      }
      const { data: recipe } = await writable.supabase.from("service_titan_endpoint_recipe_refresh_policies").select("endpoint_recipe_id")
        .eq("endpoint_recipe_id", recipeId).eq("endpoint_recipe_version", recipeVersion)
        .eq("refresh_interval", refreshInterval).maybeSingle();
      if (!recipe) return failure("That endpoint recipe version and refresh cadence are not migration-approved.");
      row.endpoint_recipe_id = recipeId;
      row.endpoint_recipe_version = recipeVersion;
    } else if (sourceMethod === "saved_report") {
      const reportSourceId = input(formData, "reportSourceId");
      const reduction = input(formData, "reportReduction");
      const valueField = input(formData, "valueField");
      const numeratorField = input(formData, "numeratorField");
      const denominatorField = input(formData, "denominatorField");
      if (!validateUuid(reportSourceId) || !REPORT_REDUCTIONS.has(reduction) || !REPORT_REFRESH_INTERVALS.has(refreshInterval)) {
        return failure("Choose an active saved report, reduction, and supported report cadence.");
      }
      const { data: report } = await writable.supabase.from("service_titan_report_sources").select("id, fields, parameters")
        .eq("organization_id", writable.organizationId).eq("id", reportSourceId).eq("connection_id", connectionId)
        .eq("service_titan_tenant_id", connection.service_titan_tenant_id)
        .neq("lifecycle", "archived").eq("status", "active").maybeSingle();
      if (!report) return failure("The saved report is not active for the exact selected tenant connection.");
      const reportFields = Array.isArray(report.fields) ? report.fields : [];
      const fieldNames = new Set(reportFields.flatMap((field) =>
        field && typeof field === "object" && typeof (field as Record<string, unknown>).name === "string"
          ? [(field as Record<string, unknown>).name as string] : []));
      const numericFieldNames = new Set(reportFields.flatMap((field) =>
        field && typeof field === "object" && (field as Record<string, unknown>).type === "number"
          && typeof (field as Record<string, unknown>).name === "string"
          ? [(field as Record<string, unknown>).name as string] : []));
      const submittedParameters = parameterValues.value as Record<string, unknown>;
      const requiredParameterNames = (Array.isArray(report.parameters) ? report.parameters : []).flatMap((parameter) =>
        parameter && typeof parameter === "object" && (parameter as Record<string, unknown>).isRequired === true
          && typeof (parameter as Record<string, unknown>).name === "string"
          ? [(parameter as Record<string, unknown>).name as string] : []);
      if (requiredParameterNames.some((name) => !(name in submittedParameters))) {
        return failure("Provide every required parameter from the approved report contract.", { parameterValues: "One or more required report parameters are missing." });
      }
      if (reduction === "ratio") {
        if (!numericFieldNames.has(numeratorField) || !numericFieldNames.has(denominatorField) || numeratorField === denominatorField) {
          return failure("Ratio bindings require two different numeric fields from the approved report schema.");
        }
      } else if (reduction !== "count" && (!fieldNames.has(valueField) || !numericFieldNames.has(valueField))) {
        return failure("Choose a numeric value field from the approved report schema.");
      }
      row.report_source_id = reportSourceId;
      row.report_reduction = reduction;
      row.value_field = reduction === "ratio" || reduction === "count" ? null : valueField;
      row.numerator_field = reduction === "ratio" ? numeratorField : null;
      row.denominator_field = reduction === "ratio" ? denominatorField : null;
    } else {
      const customEndpointSourceId = input(formData, "customEndpointSourceId");
      if (!validateUuid(customEndpointSourceId) || !CUSTOM_ENDPOINT_REFRESH_INTERVALS.has(refreshInterval)) {
        return failure("Choose an active custom endpoint source and supported custom endpoint cadence.");
      }
      const { data: source } = await writable.supabase.from("service_titan_custom_endpoint_sources").select("id")
        .eq("organization_id", writable.organizationId).eq("id", customEndpointSourceId)
        .eq("connection_id", connectionId).eq("service_titan_tenant_id", connection.service_titan_tenant_id)
        .eq("status", "active").neq("lifecycle", "archived").maybeSingle();
      if (!source) return failure("The custom endpoint source is not active for the exact selected ServiceTitan connection and tenant.");
      row.custom_endpoint_source_id = customEndpointSourceId;
    }
  }

  // Exact-location uniqueness is enforced by a partial unique index over
  // non-archived bindings, which PostgREST upsert cannot infer; the existing
  // draft (already confirmed for replacement) is updated in place instead.
  const { error } = existingBinding
    ? await writable.supabase.from("custom_kpi_location_bindings")
      .update(row).eq("organization_id", writable.organizationId).eq("id", existingBinding.id)
      .in("approval_status", ["draft", "rejected"])
    : await writable.supabase.from("custom_kpi_location_bindings").insert(row);
  if (error) return databaseFailure("KPI source binding", error);
  refreshAdmin();
  return { status: "success", message: "Fresh draft exact-location binding saved. Worker evidence is still required before approval." };
}

export async function saveKpiTargetAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await writableTenant();
  if (!writable.ok) return writable.state;

  const targetId = input(formData, "targetId");
  const locationId = input(formData, "locationId");
  const kpiDefinitionId = input(formData, "kpiDefinitionId");
  const metricKey = input(formData, "metricKey");
  const lifecycle = input(formData, "lifecycle");
  const effectiveFrom = input(formData, "effectiveFrom");
  const effectiveTo = input(formData, "effectiveTo");
  const planningType = input(formData, "planningType") === "budget" ? "budget" : "target";
  const note = input(formData, "note");
  const targetValue = parseFiniteConfigurationNumber(input(formData, "targetValue"));
  const warningRaw = input(formData, "warningValue");
  const warningValue = warningRaw ? parseFiniteConfigurationNumber(warningRaw) : null;
  const errors: Record<string, string> = {};
  if (targetId && !validateUuid(targetId)) errors.targetId = "Invalid target identifier.";
  if (locationId && !validateUuid(locationId)) errors.locationId = "Choose a valid location or organization-wide scope.";
  if (!validateUuid(kpiDefinitionId)) errors.kpiDefinitionId = "Choose a valid published KPI definition.";
  if (!isValidMetricKey(metricKey)) errors.metricKey = "Use a 3–81 character lowercase metric key.";
  if (targetValue === null) errors.targetValue = "Enter a finite value up to 1 quadrillion.";
  if (warningRaw && warningValue === null) errors.warningValue = "Enter a finite warning value or leave it blank.";
  if (!isIsoDate(effectiveFrom)) errors.effectiveFrom = "Enter a valid effective-from date.";
  if (effectiveTo && (!isIsoDate(effectiveTo) || effectiveTo < effectiveFrom)) errors.effectiveTo = "Effective-to must be a valid date on or after effective-from.";
  if (!TARGET_LIFECYCLES.has(lifecycle)) errors.lifecycle = "Choose draft or published.";
  if (note.length > 500) errors.note = "Notes are limited to 500 characters.";
  if (Object.keys(errors).length) return failure("Correct the target or budget entry and try again.", errors);

  if (locationId) {
    const { data: location } = await writable.supabase.from("locations").select("id")
      .eq("organization_id", writable.organizationId).eq("id", locationId).eq("status", "active").maybeSingle();
    if (!location) return failure("The selected location is not active in this tenant.");
  }
  const { data: definition } = await writable.supabase.from("custom_kpi_definitions").select("id, kpi_key")
    .eq("organization_id", writable.organizationId).eq("id", kpiDefinitionId).eq("lifecycle", "published").maybeSingle();
  if (!definition || definition.kpi_key !== metricKey) return failure("The metric key must match the selected published KPI definition.");

  const dimensions = { planning_type: planningType, ...(note ? { note } : {}) };
  if (targetId) {
    const { data: existing } = await writable.supabase.from("kpi_targets")
      .select("id, location_id, kpi_definition_id, metric_key, effective_from, version, lifecycle")
      .eq("organization_id", writable.organizationId).eq("id", targetId).maybeSingle();
    if (!existing) return failure("The target entry no longer exists in this tenant.");
    if (existing.location_id !== (locationId || null) || existing.kpi_definition_id !== (kpiDefinitionId || null)
      || existing.metric_key !== metricKey || existing.effective_from !== effectiveFrom) {
      return failure("Target scope, metric, and effective-from identity cannot be changed. Create a new entry instead.");
    }
    if (existing.lifecycle === "draft") {
      const { data, error } = await writable.supabase.from("kpi_targets").update({
        target_value: targetValue,
        warning_value: warningValue,
        effective_to: effectiveTo || null,
        dimensions,
        lifecycle,
      }).eq("organization_id", writable.organizationId).eq("id", targetId).eq("lifecycle", "draft").select("id").maybeSingle();
      if (error) return databaseFailure("Target or budget entry", error);
      if (!data) return failure("The draft changed before it could be saved.");
      refreshAdmin();
      return { status: "success", message: lifecycle === "published" ? "Target or budget entry published with approval provenance." : "Target or budget draft updated." };
    }
    if (existing.lifecycle !== "published") return failure("Archived target entries are immutable.");
  }

  let versionQuery = writable.supabase.from("kpi_targets").select("version")
    .eq("organization_id", writable.organizationId).eq("metric_key", metricKey).eq("effective_from", effectiveFrom)
    .order("version", { ascending: false }).limit(1);
  versionQuery = locationId ? versionQuery.eq("location_id", locationId) : versionQuery.is("location_id", null);
  const { data: versions, error: versionError } = await versionQuery;
  if (versionError) return databaseFailure("Target version", versionError);
  const version = (versions?.[0]?.version ?? 0) + 1;
  const { error } = await writable.supabase.from("kpi_targets").insert({
    organization_id: writable.organizationId,
    location_id: locationId || null,
    kpi_definition_id: kpiDefinitionId || null,
    metric_key: metricKey,
    version,
    target_value: targetValue,
    warning_value: warningValue,
    effective_from: effectiveFrom,
    effective_to: effectiveTo || null,
    dimensions,
    lifecycle,
    owner_profile_id: writable.profileId,
  });
  if (error) return databaseFailure("Target or budget entry", error);
  refreshAdmin();
  return {
    status: "success",
    message: targetId
      ? `Published entry was immutable; governed successor version ${version} was created.`
      : `Target or budget version ${version} ${lifecycle === "published" ? "published" : "saved as a draft"}.`,
  };
}

export async function assignProfileLayoutAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await writableTenant();
  if (!writable.ok) return writable.state;
  const profileId = input(formData, "profileId");
  const locationId = input(formData, "locationId");
  const templateId = input(formData, "templateId");
  if (![profileId, locationId, templateId].every(validateUuid)) return failure("Choose a valid active member, location, and layout template.");

  const [{ data: membership }, { data: location }, { data: template }] = await Promise.all([
    writable.supabase.from("organization_memberships").select("profile_id, role")
      .eq("organization_id", writable.organizationId).eq("profile_id", profileId).eq("status", "active").maybeSingle(),
    writable.supabase.from("locations").select("id").eq("organization_id", writable.organizationId)
      .eq("id", locationId).eq("status", "active").maybeSingle(),
    writable.supabase.from("layout_templates").select("id, audience_role")
      .eq("organization_id", writable.organizationId).eq("id", templateId).eq("lifecycle", "published").maybeSingle(),
  ]);
  if (!membership || !location || !template) return failure("The member, location, or published template is no longer eligible.");
  if (membership.role !== template.audience_role) {
    return failure(`This governed template is for ${template.audience_role.replaceAll("_", " ")} access, not the member's ${membership.role.replaceAll("_", " ")} role.`);
  }

  const { error } = await writable.supabase.from("profile_layouts").upsert({
    organization_id: writable.organizationId,
    profile_id: profileId,
    location_id: locationId,
    template_id: templateId,
    overrides: {},
  }, { onConflict: "organization_id,profile_id,location_id" });
  if (error) return databaseFailure("Profile layout selection", error);
  refreshAdmin();
  return { status: "success", message: "Published role-matched layout selected for the member and location." };
}
