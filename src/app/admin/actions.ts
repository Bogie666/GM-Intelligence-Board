"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getTenantAuthContext, isAdminRole } from "@/lib/auth";
import { getAppConfig } from "@/lib/env";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/service-role";
import {
  executeServiceTitanBusinessUnitDiscovery,
  executeServiceTitanValidation,
} from "@/lib/servicetitan-workers";
import {
  validateBusinessUnitMappingInput,
  validateConnectionCredentialInput,
  validateCredentialRotationInput,
  validateDivisionInput,
  validateLocationInput,
  validateOrganizationInput,
  validateUuid,
} from "@/lib/tenant-context";

export interface AdminActionState {
  status: "idle" | "success" | "error";
  message: string;
  fieldErrors?: Record<string, string>;
}

export interface ServiceTitanExecutionActionState extends AdminActionState {
  operation: "validation" | "business_unit_discovery";
  phase: "ready" | "completed" | "failed";
  retryable: boolean;
  errorCode?: "worker_unavailable" | "validation_failed" | "discovery_request_failed" | "discovery_failed";
  businessUnitCount?: number;
}

type DatabaseError = { code?: string; message?: string } | null;

function input(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function databaseError(operation: string, error: DatabaseError): AdminActionState {
  if (error?.code === "23505") {
    return { status: "error", message: `${operation} was not saved because that value is already in use. Division names and ServiceTitan tenant IDs must be unique within the organization.` };
  }
  return { status: "error", message: `${operation} could not be saved by the tenant database. No success is being reported.` };
}

function refreshTenantPages() {
  revalidatePath("/");
  revalidatePath("/admin");
}

async function hasValidRequestOrigin(): Promise<boolean> {
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin");
  if (!origin) return false;

  const expectedHost = requestHeaders.get("host");
  if (!expectedHost) return false;

  try {
    const originUrl = new URL(origin);
    return originUrl.host === expectedHost && (originUrl.protocol === "https:" || originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

async function requireAdminMutation(): Promise<
  | { ok: true; organizationId: string; supabase: Awaited<ReturnType<typeof getTenantAuthContext>> & { ok: true } }
  | { ok: false; state: AdminActionState }
> {
  if (!(await hasValidRequestOrigin())) {
    return { ok: false, state: { status: "error", message: "The request origin could not be verified." } };
  }

  if (getAppConfig().isDemo) {
    return { ok: false, state: { status: "error", message: "Demo mode does not write tenant data." } };
  }

  const auth = await getTenantAuthContext();
  if (!auth.ok) {
    return { ok: false, state: { status: "error", message: "Your authenticated tenant membership could not be verified." } };
  }
  if (!isAdminRole(auth.membership.role)) {
    return { ok: false, state: { status: "error", message: "Only tenant owners and administrators can change this configuration." } };
  }

  return { ok: true, organizationId: auth.membership.organizationId, supabase: auth };
}

export async function updateOrganizationAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) return writable.state;

  const validation = validateOrganizationInput({ slug: input(formData, "slug"), name: input(formData, "name") });
  if (!validation.ok) {
    return { status: "error", message: "Correct the organization fields and try again.", fieldErrors: validation.fieldErrors };
  }

  const { error, data } = await writable.supabase.supabase
    .from("organizations")
    .update({ slug: validation.value.slug, name: validation.value.name })
    .eq("id", writable.organizationId)
    .select("id")
    .maybeSingle();

  if (error) return databaseError("Brand", error);
  if (!data) return { status: "error", message: "Brand was not updated because the authorized brand row was not writable." };
  refreshTenantPages();
  return { status: "success", message: "Brand details saved." };
}

export async function createLocationAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) return writable.state;

  const validation = validateLocationInput({
    locationKey: input(formData, "locationKey"),
    brandName: input(formData, "brandName"),
    displayName: input(formData, "displayName"),
    timezone: input(formData, "timezone"),
  });
  if (!validation.ok) {
    return { status: "error", message: "Correct the location fields and try again.", fieldErrors: validation.fieldErrors };
  }

  const { error } = await writable.supabase.supabase.from("locations").insert({
    organization_id: writable.organizationId,
    location_key: validation.value.locationKey,
    brand_name: validation.value.brandName,
    display_name: validation.value.displayName,
    timezone: validation.value.timezone,
    status: "active",
    presentation: {},
  });

  if (error) return databaseError("Location", error);
  refreshTenantPages();
  return { status: "success", message: "Location added to the tenant." };
}

export async function updateLocationAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) return writable.state;
  const locationId = input(formData, "locationId");
  if (!validateUuid(locationId)) return { status: "error", message: "The location identifier is invalid." };

  const validation = validateLocationInput({
    locationKey: input(formData, "locationKey"),
    brandName: input(formData, "brandName"),
    displayName: input(formData, "displayName"),
    timezone: input(formData, "timezone"),
  });
  if (!validation.ok) {
    return { status: "error", message: "Correct the location fields and try again.", fieldErrors: validation.fieldErrors };
  }

  const { data, error } = await writable.supabase.supabase
    .from("locations")
    .update({
      location_key: validation.value.locationKey,
      brand_name: validation.value.brandName,
      display_name: validation.value.displayName,
      timezone: validation.value.timezone,
    })
    .eq("organization_id", writable.organizationId)
    .eq("id", locationId)
    .neq("status", "archived")
    .select("id")
    .maybeSingle();

  if (error) return databaseError("Location", error);
  if (!data) return { status: "error", message: "Location was not updated because it was not found or is archived." };
  refreshTenantPages();
  return { status: "success", message: "Location changes saved." };
}

export async function archiveLocationAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) return writable.state;
  const locationId = input(formData, "locationId");
  if (!validateUuid(locationId)) return { status: "error", message: "The location identifier is invalid." };

  const { data, error } = await writable.supabase.supabase
    .from("locations")
    .update({ status: "archived" })
    .eq("organization_id", writable.organizationId)
    .eq("id", locationId)
    .neq("status", "archived")
    .select("id")
    .maybeSingle();

  if (error) return databaseError("Location", error);
  if (!data) return { status: "error", message: "Location was not archived because it was not found or was already archived." };
  refreshTenantPages();
  return { status: "success", message: "Location archived. Historical records remain intact." };
}

export async function createDivisionAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) return writable.state;
  const validation = validateDivisionInput({ name: input(formData, "name") });
  if (!validation.ok) {
    return { status: "error", message: "Correct the division name and try again.", fieldErrors: validation.fieldErrors };
  }
  const { data, error } = await writable.supabase.supabase.rpc("create_organization_division", {
    p_organization_id: writable.organizationId,
    p_name: validation.value.name,
  });
  if (error || typeof data !== "string" || !validateUuid(data)) return databaseError("Division", error);
  refreshTenantPages();
  return { status: "success", message: `${validation.value.name} division created.` };
}

export async function renameDivisionAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) return writable.state;
  const divisionId = input(formData, "divisionId").trim();
  if (!validateUuid(divisionId)) return { status: "error", message: "The division identifier is invalid." };
  const validation = validateDivisionInput({ name: input(formData, "name") });
  if (!validation.ok) {
    return { status: "error", message: "Correct the division name and try again.", fieldErrors: validation.fieldErrors };
  }
  const { data, error } = await writable.supabase.supabase.rpc("rename_organization_division", {
    p_organization_id: writable.organizationId,
    p_division_id: divisionId,
    p_name: validation.value.name,
  });
  if (error || data !== true) return databaseError("Division", error);
  refreshTenantPages();
  return { status: "success", message: `Division renamed to ${validation.value.name}.` };
}

export async function setDivisionStatusAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) return writable.state;
  const divisionId = input(formData, "divisionId").trim();
  const status = input(formData, "status").trim();
  if (!validateUuid(divisionId) || (status !== "active" && status !== "archived")) {
    return { status: "error", message: "The division status request is invalid." };
  }
  const { data, error } = await writable.supabase.supabase.rpc("set_organization_division_status", {
    p_organization_id: writable.organizationId,
    p_division_id: divisionId,
    p_status: status,
  });
  if (error?.code === "55000") {
    return { status: "error", message: "Reassign or unmap every active business unit before archiving this division." };
  }
  if (error || data !== true) return databaseError("Division status", error);
  refreshTenantPages();
  return { status: "success", message: status === "active" ? "Division restored." : "Division archived. Historical mappings remain intact." };
}

export async function moveDivisionAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) return writable.state;
  const divisionId = input(formData, "divisionId").trim();
  const direction = input(formData, "direction").trim();
  if (!validateUuid(divisionId) || (direction !== "up" && direction !== "down")) {
    return { status: "error", message: "The division move request is invalid." };
  }
  const { data, error } = await writable.supabase.supabase.rpc("move_organization_division", {
    p_organization_id: writable.organizationId,
    p_division_id: divisionId,
    p_direction: direction,
  });
  if (error || typeof data !== "boolean") return databaseError("Division order", error);
  refreshTenantPages();
  return { status: "success", message: data ? "Division order updated." : `Division is already ${direction === "up" ? "first" : "last"}.` };
}

export async function createConnectionAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) return writable.state;

  const validation = validateConnectionCredentialInput({
    tenantId: input(formData, "tenantId"),
    displayName: input(formData, "displayName"),
    environment: input(formData, "environment"),
    clientId: input(formData, "clientId"),
    clientSecret: input(formData, "clientSecret"),
    appKey: input(formData, "appKey"),
    locationId: input(formData, "locationId"),
  });
  if (!validation.ok) {
    return { status: "error", message: "Correct the connection and credential fields and try again.", fieldErrors: validation.fieldErrors };
  }

  if (validation.value.locationId) {
    const { data: location, error: locationError } = await writable.supabase.supabase
      .from("locations")
      .select("id")
      .eq("organization_id", writable.organizationId)
      .eq("id", validation.value.locationId)
      .eq("status", "active")
      .maybeSingle();
    if (locationError || !location) {
      return { status: "error", message: "The selected active tenant location could not be verified." };
    }
  }

  const { data: connectionId, error } = await writable.supabase.supabase.rpc(
    "register_service_titan_connection_with_credentials",
    {
      p_organization_id: writable.organizationId,
      p_service_titan_tenant_id: validation.value.tenantId,
      p_display_name: validation.value.displayName,
      p_environment: validation.value.environment,
      p_client_id: validation.value.clientId,
      p_client_secret: validation.value.clientSecret,
      p_app_key: validation.value.appKey,
      p_location_id: validation.value.locationId,
    },
  );

  if (error || typeof connectionId !== "string") {
    return databaseError("ServiceTitan connection", error);
  }

  refreshTenantPages();
  return {
    status: "success",
    message: validation.value.locationId
      ? "Credentials encrypted in the managed vault; connection metadata and location assignment saved atomically. Trusted validation is still required."
      : "Credentials encrypted in the managed vault and connection metadata saved. Trusted validation is still required.",
  };
}

export async function rotateConnectionCredentialsAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) return writable.state;
  const connectionId = input(formData, "connectionId").trim();
  if (!validateUuid(connectionId)) {
    return { status: "error", message: "The connection identifier is invalid.", fieldErrors: { connectionId: "Invalid identifier." } };
  }
  const validation = validateCredentialRotationInput({
    clientId: input(formData, "clientId"),
    clientSecret: input(formData, "clientSecret"),
    appKey: input(formData, "appKey"),
  });
  if (!validation.ok) {
    return { status: "error", message: "Correct the highlighted ServiceTitan credentials.", fieldErrors: validation.fieldErrors };
  }

  const { error } = await writable.supabase.supabase.rpc("rotate_service_titan_connection_credentials", {
    p_organization_id: writable.organizationId,
    p_connection_id: connectionId,
    p_client_id: validation.value.clientId,
    p_client_secret: validation.value.clientSecret,
    p_app_key: validation.value.appKey,
  });
  if (error) return databaseError("Credential rotation", error);
  refreshTenantPages();
  return { status: "success", message: "Credentials encrypted and replaced. Revalidate the connection before ingestion." };
}

function executionFailure(
  operation: ServiceTitanExecutionActionState["operation"],
  message: string,
  errorCode: NonNullable<ServiceTitanExecutionActionState["errorCode"]> | undefined,
  retryable: boolean,
): ServiceTitanExecutionActionState {
  return { status: "error", operation, phase: "failed", retryable, message, ...(errorCode ? { errorCode } : {}) };
}

export async function validateServiceTitanConnectionAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<ServiceTitanExecutionActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) {
    return executionFailure("validation", writable.state.message, undefined, false);
  }
  const connectionId = input(formData, "connectionId").trim();
  if (!validateUuid(connectionId)) {
    return executionFailure("validation", "The connection identifier is invalid.", undefined, false);
  }

  let serviceClient;
  try {
    serviceClient = createServiceRoleSupabaseClient();
  } catch {
    return executionFailure(
      "validation",
      "Connection validation is temporarily unavailable. Verify the server worker configuration and retry.",
      "worker_unavailable",
      true,
    );
  }

  try {
    await executeServiceTitanValidation(serviceClient, writable.organizationId, connectionId);
    refreshTenantPages();
    return {
      status: "success",
      operation: "validation",
      phase: "ready",
      retryable: false,
      message: "ServiceTitan credentials and business-unit access validated. The connection is ready.",
    };
  } catch {
    refreshTenantPages();
    return executionFailure(
      "validation",
      "ServiceTitan validation did not succeed. Check the managed credentials and tenant access, then retry.",
      "validation_failed",
      true,
    );
  }
}

export async function disableConnectionAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) return writable.state;
  const connectionId = input(formData, "connectionId");
  if (!validateUuid(connectionId)) return { status: "error", message: "The connection identifier is invalid." };

  const { data, error } = await writable.supabase.supabase.rpc(
    "disable_service_titan_connection",
    {
      p_organization_id: writable.organizationId,
      p_connection_id: connectionId,
    },
  );

  if (error || data !== true) return databaseError("ServiceTitan connection", error);

  refreshTenantPages();
  return { status: "success", message: "Connection disabled and active location assignments revoked atomically." };
}

function repeatedInput(formData: FormData, key: string): string[] {
  return formData.getAll(key).filter((value): value is string => typeof value === "string");
}

function rpcConfigurationError(operation: string, error: DatabaseError): AdminActionState {
  if (error?.code === "40001") {
    return { status: "error", message: `${operation} was not saved because discovery changed. Reload the Admin Center and review the latest inventory.` };
  }
  if (error?.code === "23505") {
    return { status: "error", message: `${operation} conflicts with an existing active mapping or KPI definition. No changes were reported as successful.` };
  }
  if (error?.code === "P0002") {
    return { status: "error", message: `${operation} is unavailable because the required validated connection was not found.` };
  }
  if (error?.code === "22023") {
    return { status: "error", message: `${operation} was rejected because the submitted configuration is invalid or no longer current.` };
  }
  return databaseError(operation, error);
}

async function executeBusinessUnitDiscoveryAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<ServiceTitanExecutionActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) {
    return executionFailure("business_unit_discovery", writable.state.message, undefined, false);
  }
  const connectionId = input(formData, "connectionId").trim();
  if (!validateUuid(connectionId)) {
    return executionFailure("business_unit_discovery", "The connection identifier is invalid.", undefined, false);
  }

  const { data, error } = await writable.supabase.supabase.rpc(
    "request_service_titan_business_unit_discovery",
    { p_organization_id: writable.organizationId, p_connection_id: connectionId },
  );
  if (error || typeof data !== "string" || !validateUuid(data)) {
    return executionFailure(
      "business_unit_discovery",
      "Business-unit discovery could not be requested for this validated connection.",
      "discovery_request_failed",
      true,
    );
  }

  let serviceClient;
  try {
    serviceClient = createServiceRoleSupabaseClient();
  } catch {
    return executionFailure(
      "business_unit_discovery",
      "Business-unit discovery is queued but trusted execution is temporarily unavailable. Verify the server worker configuration and retry.",
      "worker_unavailable",
      true,
    );
  }
  try {
    const result = await executeServiceTitanBusinessUnitDiscovery(
      serviceClient,
      writable.organizationId,
      connectionId,
    );
    refreshTenantPages();
    return {
      status: "success",
      operation: "business_unit_discovery",
      phase: "completed",
      retryable: false,
      businessUnitCount: result.businessUnitCount,
      message: `${result.businessUnitCount} ServiceTitan business unit${result.businessUnitCount === 1 ? "" : "s"} discovered and saved for review.`,
    };
  } catch {
    refreshTenantPages();
    return executionFailure(
      "business_unit_discovery",
      "Business-unit discovery did not complete. Check the validated connection and provider access, then retry.",
      "discovery_failed",
      true,
    );
  }
}

/** Backward-compatible export: existing forms now request and execute discovery in-product. */
export async function requestBusinessUnitDiscoveryAction(
  previousState: AdminActionState,
  formData: FormData,
): Promise<ServiceTitanExecutionActionState> {
  return executeBusinessUnitDiscoveryAction(previousState, formData);
}

/** Preferred Run/Retry export for the production Admin Center integration. */
export async function runBusinessUnitDiscoveryAction(
  previousState: AdminActionState,
  formData: FormData,
): Promise<ServiceTitanExecutionActionState> {
  return executeBusinessUnitDiscoveryAction(previousState, formData);
}

export async function replaceConnectionLocationsAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) return writable.state;
  const connectionId = input(formData, "connectionId").trim();
  const locationIds = repeatedInput(formData, "locationId").map((value) => value.trim());
  if (!validateUuid(connectionId)) {
    return { status: "error", message: "The connection identifier is invalid." };
  }
  if (input(formData, "confirmReplacement") !== "yes") {
    return { status: "error", message: "Confirm that this selection will replace all active location assignments." };
  }
  if (locationIds.length > 1000 || locationIds.some((value) => !validateUuid(value)) || new Set(locationIds).size !== locationIds.length) {
    return { status: "error", message: "The location assignment selection is invalid." };
  }

  const { data, error } = await writable.supabase.supabase.rpc(
    "replace_service_titan_connection_locations",
    {
      p_organization_id: writable.organizationId,
      p_connection_id: connectionId,
      p_location_ids: locationIds,
    },
  );
  if (error || typeof data !== "number" || data !== locationIds.length) {
    return rpcConfigurationError("Location assignments", error);
  }
  refreshTenantPages();
  return {
    status: "success",
    message: `${data} active location assignment${data === 1 ? "" : "s"} saved. Removed locations and their business-unit mappings were revoked atomically.`,
  };
}

export async function replaceBusinessUnitMappingsAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) return writable.state;
  const connectionId = input(formData, "connectionId").trim();
  const discoveryRevision = input(formData, "discoveryRevision").trim();
  let providerIds = repeatedInput(formData, "providerBusinessUnitId");
  let locationIds = repeatedInput(formData, "mappedLocationId");
  let divisionIds = repeatedInput(formData, "divisionId");
  const bulkPayload = input(formData, "bulkMappings").trim();
  if (bulkPayload) {
    if (bulkPayload.length > 8_000_000) {
      return { status: "error", message: "The bulk mapping file exceeds the 8 MB safety limit." };
    }
    try {
      const parsed: unknown = JSON.parse(bulkPayload);
      if (!Array.isArray(parsed)) throw new Error("array required");
      providerIds = parsed.map((item) => typeof item === "object" && item !== null && "providerBusinessUnitId" in item
        ? String(item.providerBusinessUnitId)
        : "");
      locationIds = parsed.map((item) => typeof item === "object" && item !== null && "locationId" in item
        ? String(item.locationId)
        : "");
      divisionIds = parsed.map((item) => typeof item === "object" && item !== null && "divisionId" in item
        ? String(item.divisionId)
        : "");
    } catch {
      return { status: "error", message: "The bulk mapping file is not valid GM Intelligence mapping JSON." };
    }
  }
  if (!validateUuid(connectionId) || !validateUuid(discoveryRevision)) {
    return { status: "error", message: "The connection or discovery revision identifier is invalid." };
  }
  if (input(formData, "confirmMappings") !== "yes") {
    return { status: "error", message: "Confirm that this submission will replace every active business-unit mapping for the connection." };
  }
  if (providerIds.length !== locationIds.length || providerIds.length !== divisionIds.length || providerIds.length > 10000) {
    return { status: "error", message: "The business-unit mapping selection is incomplete or too large." };
  }

  const mappings: Array<{ locationId: string; providerBusinessUnitId: string; divisionId: string }> = [];
  const selectedProviderIds = new Set<string>();
  for (let index = 0; index < providerIds.length; index += 1) {
    const providerBusinessUnitId = providerIds[index] ?? "";
    const locationId = (locationIds[index] ?? "").trim();
    const divisionId = (divisionIds[index] ?? "").trim();
    if (!locationId && !divisionId) continue;
    const validation = validateBusinessUnitMappingInput({ locationId, providerBusinessUnitId, divisionId });
    if (!validation.ok || selectedProviderIds.has(providerBusinessUnitId)) {
      return { status: "error", message: "One or more business-unit mappings are invalid or incomplete." };
    }
    selectedProviderIds.add(providerBusinessUnitId);
    mappings.push(validation.value);
  }

  const { data, error } = await writable.supabase.supabase.rpc(
    "replace_service_titan_business_unit_division_mappings",
    {
      p_organization_id: writable.organizationId,
      p_connection_id: connectionId,
      p_discovery_revision: discoveryRevision,
      p_mappings: mappings,
    },
  );
  if (error || typeof data !== "number" || data !== mappings.length) {
    return rpcConfigurationError("Business-unit mappings", error);
  }
  refreshTenantPages();
  return { status: "success", message: `${data} current business-unit mapping${data === 1 ? "" : "s"} saved against the reviewed discovery revision.` };
}

export async function activateOriginalKpiCatalogAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await requireAdminMutation();
  if (writable.ok === false) return writable.state;
  const selectionMode = input(formData, "selectionMode");
  const selectedKeys = repeatedInput(formData, "kpiKey").map((value) => value.trim());
  if (input(formData, "confirmActivation") !== "yes") {
    return { status: "error", message: "Confirm that activation publishes governed KPI definitions for this tenant." };
  }
  if (selectionMode !== "selected" && selectionMode !== "all") {
    return { status: "error", message: "Choose selected KPIs or the complete original catalog." };
  }
  if (
    selectedKeys.length > 36 || new Set(selectedKeys).size !== selectedKeys.length ||
    selectedKeys.some((key) => !/^[a-z0-9][a-z0-9-]{2,54}$/.test(key))
  ) {
    return { status: "error", message: "The KPI catalog selection is invalid." };
  }
  if (selectionMode === "selected" && selectedKeys.length === 0) {
    return { status: "error", message: "Select at least one inactive KPI, or activate the complete catalog." };
  }

  const requestedKeys = selectionMode === "all" ? [] : selectedKeys;
  const { data, error } = await writable.supabase.supabase.rpc(
    "enable_original_kpi_catalog",
    { p_organization_id: writable.organizationId, p_kpi_keys: requestedKeys },
  );
  if (error || typeof data !== "number" || data < 0 || data > 36) {
    return rpcConfigurationError("Original KPI catalog activation", error);
  }
  refreshTenantPages();
  return {
    status: "success",
    message: data === 0
      ? "The requested original KPI definitions were already active; no duplicate definitions were created."
      : `${data} original KPI definition${data === 1 ? "" : "s"} published. Data remains explicitly unavailable until each KPI's source and location bindings are governed.`,
  };
}
