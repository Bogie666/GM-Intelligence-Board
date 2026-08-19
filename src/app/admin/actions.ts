"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getTenantAuthContext, isAdminRole } from "@/lib/auth";
import { getAppConfig } from "@/lib/env";
import {
  validateConnectionCredentialInput,
  validateCredentialRotationInput,
  validateLocationInput,
  validateOrganizationInput,
  validateUuid,
} from "@/lib/tenant-context";

export interface AdminActionState {
  status: "idle" | "success" | "error";
  message: string;
  fieldErrors?: Record<string, string>;
}

type DatabaseError = { code?: string; message?: string } | null;

function input(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function databaseError(operation: string, error: DatabaseError): AdminActionState {
  if (error?.code === "23505") {
    return { status: "error", message: `${operation} was not saved because that key or tenant ID is already in use.` };
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

async function getWritableTenant(): Promise<
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
  const writable = await getWritableTenant();
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
  const writable = await getWritableTenant();
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
  const writable = await getWritableTenant();
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
  const writable = await getWritableTenant();
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

export async function createConnectionAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await getWritableTenant();
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
  const writable = await getWritableTenant();
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

export async function disableConnectionAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await getWritableTenant();
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

export async function requestBusinessUnitDiscoveryAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await getWritableTenant();
  if (writable.ok === false) return writable.state;
  const connectionId = input(formData, "connectionId").trim();
  if (!validateUuid(connectionId)) {
    return { status: "error", message: "The connection identifier is invalid." };
  }

  const { data, error } = await writable.supabase.supabase.rpc(
    "request_service_titan_business_unit_discovery",
    { p_organization_id: writable.organizationId, p_connection_id: connectionId },
  );
  if (error || typeof data !== "string" || !validateUuid(data)) {
    return rpcConfigurationError("Business-unit discovery", error);
  }
  refreshTenantPages();
  return { status: "success", message: `Discovery request ${data} is queued for the trusted ServiceTitan worker.` };
}

export async function replaceConnectionLocationsAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const writable = await getWritableTenant();
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
  const writable = await getWritableTenant();
  if (writable.ok === false) return writable.state;
  const connectionId = input(formData, "connectionId").trim();
  const discoveryRevision = input(formData, "discoveryRevision").trim();
  const providerIds = repeatedInput(formData, "providerBusinessUnitId");
  const locationIds = repeatedInput(formData, "mappedLocationId");
  const trades = repeatedInput(formData, "trade");
  if (!validateUuid(connectionId) || !validateUuid(discoveryRevision)) {
    return { status: "error", message: "The connection or discovery revision identifier is invalid." };
  }
  if (input(formData, "confirmMappings") !== "yes") {
    return { status: "error", message: "Confirm that this submission will replace every active business-unit mapping for the connection." };
  }
  if (providerIds.length !== locationIds.length || providerIds.length !== trades.length || providerIds.length > 10000) {
    return { status: "error", message: "The business-unit mapping selection is incomplete or too large." };
  }

  const mappings: Array<{ locationId: string; providerBusinessUnitId: string; trade: string }> = [];
  const selectedProviderIds = new Set<string>();
  for (let index = 0; index < providerIds.length; index += 1) {
    const providerBusinessUnitId = providerIds[index] ?? "";
    const locationId = (locationIds[index] ?? "").trim();
    const trade = (trades[index] ?? "").trim();
    if (!locationId && !trade) continue;
    if (
      !providerBusinessUnitId || providerBusinessUnitId !== providerBusinessUnitId.trim() ||
      providerBusinessUnitId.length > 160 || /[\u0000-\u001f\u007f]/.test(providerBusinessUnitId) ||
      !validateUuid(locationId) || !["hvac", "plumbing", "electrical", "other"].includes(trade) ||
      selectedProviderIds.has(providerBusinessUnitId)
    ) {
      return { status: "error", message: "One or more business-unit mappings are invalid or incomplete." };
    }
    selectedProviderIds.add(providerBusinessUnitId);
    mappings.push({ locationId, providerBusinessUnitId, trade });
  }

  const { data, error } = await writable.supabase.supabase.rpc(
    "replace_service_titan_business_unit_mappings",
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
  const writable = await getWritableTenant();
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
