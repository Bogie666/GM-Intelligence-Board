"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getTenantAuthContext, isAdminRole } from "@/lib/auth";
import { getAppConfig } from "@/lib/env";
import {
  validateConnectionInput,
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

  const validation = validateConnectionInput({
    tenantId: input(formData, "tenantId"),
    displayName: input(formData, "displayName"),
    environment: input(formData, "environment"),
    secretReference: input(formData, "secretReference"),
    locationId: input(formData, "locationId"),
  });
  if (!validation.ok) {
    return { status: "error", message: "Correct the connection metadata and try again.", fieldErrors: validation.fieldErrors };
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
    "register_service_titan_connection",
    {
      p_organization_id: writable.organizationId,
      p_service_titan_tenant_id: validation.value.tenantId,
      p_display_name: validation.value.displayName,
      p_environment: validation.value.environment,
      p_secret_reference: validation.value.secretReference,
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
      ? "Credential-free connection metadata and location assignment saved atomically. Validation by the integration worker is still required."
      : "Credential-free connection metadata saved. Validation by the integration worker is still required.",
  };
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
