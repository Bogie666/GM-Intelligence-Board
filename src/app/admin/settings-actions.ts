"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getTenantAuthContext, isAdminRole } from "@/lib/auth";
import { getAppConfig } from "@/lib/env";
import { reportSchemaFingerprint, type ServiceTitanReportField } from "@/lib/service-titan-sources";
import {
  isIsoDate,
  isValidMetricKey,
  parseConfigurationJson,
  parseFiniteConfigurationNumber,
} from "@/lib/production-admin-settings";
import { validateUuid } from "@/lib/tenant-context";
import type { AdminActionState } from "./actions";

const SOURCE_METHODS = new Set(["endpoint_recipe", "saved_report"]);
const REPORT_REDUCTIONS = new Set(["sum", "average", "count", "latest", "ratio"]);
const TARGET_LIFECYCLES = new Set(["draft", "published"]);
const FIELD_TYPES = new Set(["number", "string", "date", "boolean"]);
const PARAMETER_TYPES = new Set(["String", "Number", "Boolean", "Date", "Time"]);

type DatabaseError = { code?: string; message?: string } | null;

function input(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function failure(message: string, fieldErrors?: Record<string, string>): AdminActionState {
  return { status: "error", message, ...(fieldErrors ? { fieldErrors } : {}) };
}

function databaseFailure(operation: string, error: DatabaseError): AdminActionState {
  if (error?.code === "23505") return failure(`${operation} conflicts with an existing tenant record.`);
  if (error?.code === "23514" || error?.code === "23503") return failure(`${operation} does not satisfy the governed tenant configuration.`);
  return failure(`${operation} could not be saved by the tenant database. No success is being reported.`);
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
  return Array.isArray(value) && value.length > 0 && value.every((field) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) return false;
    const candidate = field as Record<string, unknown>;
    return typeof candidate.name === "string" && candidate.name.trim() !== ""
      && typeof candidate.label === "string" && candidate.label.trim() !== ""
      && typeof candidate.type === "string" && FIELD_TYPES.has(candidate.type);
  });
}

function validReportParameters(value: unknown): boolean {
  return Array.isArray(value) && value.every((parameter) => {
    if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) return false;
    const candidate = parameter as Record<string, unknown>;
    return typeof candidate.name === "string" && candidate.name.trim() !== ""
      && typeof candidate.label === "string" && candidate.label.trim() !== ""
      && typeof candidate.dataType === "string" && PARAMETER_TYPES.has(candidate.dataType)
      && typeof candidate.isArray === "boolean" && typeof candidate.isRequired === "boolean"
      && (candidate.dynamicSetId === undefined || (typeof candidate.dynamicSetId === "string" && candidate.dynamicSetId.trim() !== ""));
  });
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
    .eq("organization_id", writable.organizationId).eq("id", connectionId).neq("status", "archived").maybeSingle();
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
  const connectionId = input(formData, "connectionId");
  const sourceMethod = input(formData, "sourceMethod");
  const refreshInterval = input(formData, "refreshInterval");
  const parameterValues = parseConfigurationJson(input(formData, "parameterValues") || "{}", "object");
  const businessUnitMappings = parseConfigurationJson(input(formData, "businessUnitMappings") || "{}", "object");
  if (![kpiDefinitionId, locationId, connectionId].every(validateUuid) || !SOURCE_METHODS.has(sourceMethod)) {
    return failure("Choose a published KPI, active location, tenant connection, and supported source method.");
  }
  if (!parameterValues.ok || !businessUnitMappings.ok) {
    return failure("Correct the binding JSON and try again.", {
      ...(!parameterValues.ok ? { parameterValues: parameterValues.message } : {}),
      ...(!businessUnitMappings.ok ? { businessUnitMappings: businessUnitMappings.message } : {}),
    });
  }

  const [{ data: definition }, { data: assignment }, { data: connection }] = await Promise.all([
    writable.supabase.from("custom_kpi_definitions").select("id, type")
      .eq("organization_id", writable.organizationId).eq("id", kpiDefinitionId).eq("lifecycle", "published").maybeSingle(),
    writable.supabase.from("service_titan_connection_locations").select("id")
      .eq("organization_id", writable.organizationId).eq("connection_id", connectionId).eq("location_id", locationId).is("revoked_at", null).maybeSingle(),
    writable.supabase.from("service_titan_connections").select("id, service_titan_tenant_id")
      .eq("organization_id", writable.organizationId).eq("id", connectionId).neq("status", "archived").maybeSingle(),
  ]);
  if (!definition || definition.type !== "service_titan") return failure("Only a published ServiceTitan KPI definition can be bound here.");
  if (!assignment || !connection) return failure("The selected connection must have an active assignment to the exact tenant location.");

  const base = {
    organization_id: writable.organizationId,
    kpi_definition_id: kpiDefinitionId,
    location_id: locationId,
    connection_id: connectionId,
    service_titan_tenant_id: connection.service_titan_tenant_id,
    source_method: sourceMethod,
    refresh_interval: refreshInterval,
    parameter_values: parameterValues.value,
    business_unit_mappings: businessUnitMappings.value,
    approval_status: "draft",
    approved_by: null,
    approved_at: null,
  };
  let row: Record<string, unknown>;

  if (sourceMethod === "endpoint_recipe") {
    const recipeId = input(formData, "endpointRecipeId");
    const recipeVersion = Number(input(formData, "endpointRecipeVersion"));
    const { data: recipe } = await writable.supabase.from("service_titan_endpoint_recipe_refresh_policies").select("endpoint_recipe_id")
      .eq("endpoint_recipe_id", recipeId).eq("endpoint_recipe_version", recipeVersion).eq("refresh_interval", refreshInterval).maybeSingle();
    if (!recipe) return failure("That endpoint recipe version and refresh cadence are not migration-approved.");
    row = {
      ...base,
      endpoint_recipe_id: recipeId,
      endpoint_recipe_version: recipeVersion,
      report_source_id: null,
      report_reduction: null,
      value_field: null,
      numerator_field: null,
      denominator_field: null,
    };
  } else {
    const reportSourceId = input(formData, "reportSourceId");
    const reduction = input(formData, "reportReduction");
    const valueField = input(formData, "valueField");
    const numeratorField = input(formData, "numeratorField");
    const denominatorField = input(formData, "denominatorField");
    if (!validateUuid(reportSourceId) || !REPORT_REDUCTIONS.has(reduction) || !["4h", "12h", "24h"].includes(refreshInterval)) {
      return failure("Choose an approved saved report, reduction, and supported report cadence.");
    }
    const { data: report } = await writable.supabase.from("service_titan_report_sources").select("id, fields")
      .eq("organization_id", writable.organizationId).eq("id", reportSourceId).eq("connection_id", connectionId)
      .eq("lifecycle", "approved").eq("status", "active").maybeSingle();
    if (!report) return failure("The saved report is not approved and active for the selected tenant connection.");
    const fieldNames = new Set((Array.isArray(report.fields) ? report.fields : []).flatMap((field) =>
      field && typeof field === "object" && typeof (field as Record<string, unknown>).name === "string"
        ? [(field as Record<string, unknown>).name as string] : []));
    if (reduction === "ratio") {
      if (!fieldNames.has(numeratorField) || !fieldNames.has(denominatorField) || numeratorField === denominatorField) {
        return failure("Ratio bindings require two different fields present in the approved report schema.");
      }
    } else if (reduction !== "count" && !fieldNames.has(valueField)) {
      return failure("Choose a value field present in the approved report schema.");
    }
    row = {
      ...base,
      endpoint_recipe_id: null,
      endpoint_recipe_version: null,
      report_source_id: reportSourceId,
      report_reduction: reduction,
      value_field: reduction === "ratio" || reduction === "count" ? null : valueField,
      numerator_field: reduction === "ratio" ? numeratorField : null,
      denominator_field: reduction === "ratio" ? denominatorField : null,
    };
  }

  const { error } = await writable.supabase.from("custom_kpi_location_bindings")
    .upsert(row, { onConflict: "organization_id,kpi_definition_id,location_id" });
  if (error) return databaseFailure("KPI source binding", error);
  refreshAdmin();
  return { status: "success", message: "Draft exact-location binding saved. Worker evidence is still required before approval." };
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
  if (kpiDefinitionId && !validateUuid(kpiDefinitionId)) errors.kpiDefinitionId = "Choose a valid published KPI definition.";
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
      .eq("organization_id", writable.organizationId).eq("id", locationId).neq("status", "archived").maybeSingle();
    if (!location) return failure("The selected location is not active in this tenant.");
  }
  if (kpiDefinitionId) {
    const { data: definition } = await writable.supabase.from("custom_kpi_definitions").select("id, kpi_key")
      .eq("organization_id", writable.organizationId).eq("id", kpiDefinitionId).eq("lifecycle", "published").maybeSingle();
    if (!definition || definition.kpi_key !== metricKey) return failure("The metric key must match the selected published KPI definition.");
  }

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
