import "server-only";

import { getTenantAuthContext, type OrganizationRole, type TenantAccessOption } from "@/lib/auth";
import type { SupabaseClient } from "@supabase/supabase-js";

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_REFERENCE_PATTERN = /^(?:gcp-secret:\/\/projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/secrets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/versions\/(?:latest|[1-9][0-9]*)|env:\/\/[A-Z][A-Z0-9_]{1,127})$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; fieldErrors: Record<string, string> };

export interface OrganizationInput {
  slug: string;
  name: string;
}

export interface LocationInput {
  locationKey: string;
  brandName: string;
  displayName: string;
  timezone: string;
}

export interface ConnectionInput {
  tenantId: string;
  displayName: string;
  environment: "production" | "integration";
  secretReference: string;
  locationId: string | null;
}

export interface TenantOrganization {
  id: string;
  slug: string;
  name: string;
  status: "active" | "suspended" | "archived";
  settings: Record<string, unknown>;
}

export interface TenantLocation {
  id: string;
  organization_id: string;
  location_key: string;
  brand_name: string;
  display_name: string;
  timezone: string;
  status: "active" | "inactive" | "archived";
  presentation: Record<string, unknown>;
}

export interface ServiceTitanConnection {
  id: string;
  organization_id: string;
  service_titan_tenant_id: string;
  display_name: string;
  environment: "production" | "integration";
  secret_reference: string;
  capabilities: unknown[];
  status: "needs_attention" | "ready" | "disabled" | "archived";
  last_validated_at: string | null;
}

export interface ServiceTitanAssignment {
  id: string;
  organization_id: string;
  connection_id: string;
  location_id: string;
  assigned_at: string;
  revoked_at: string | null;
}

export interface TenantReadiness {
  activeLocationCount: number;
  enabledConnectionCount: number;
  assignedActiveLocationCount: number;
  isConfigured: boolean;
  hasValidatedConnection: boolean;
}

export interface ProductionKpiStatus {
  bindingId: string;
  definitionId: string;
  kpiKey: string;
  title: string;
  section: "executive" | "revenue" | "calls" | "appointments" | "sales" | "membership";
  valueKind: "currency" | "number" | "percent" | "ratio";
  locationId: string;
  locationName: string;
  value: number | null;
  priorValue: number | null;
  periodEnd: string | null;
  observedAt: string | null;
  confidence: "high" | "medium" | "low" | "unknown";
  health: "current" | "stale" | "unavailable";
}

export interface ProductionTenantContext {
  user: { id: string; email: string | null };
  role: OrganizationRole;
  availableTenants: TenantAccessOption[];
  hasPortfolioAccess: boolean;
  organization: TenantOrganization;
  locations: TenantLocation[];
  connections: ServiceTitanConnection[];
  assignments: ServiceTitanAssignment[];
  readiness: TenantReadiness;
  kpis: ProductionKpiStatus[];
}

export type ProductionTenantContextResult =
  | { ok: true; tenant: ProductionTenantContext }
  | {
      ok: false;
      reason:
        | "unauthenticated"
        | "membership-query-failed"
        | "no-active-membership"
        | "tenant-selection-required"
        | "invalid-membership"
        | "tenant-query-failed";
      message: string;
      availableTenants?: TenantAccessOption[];
    };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validateName(value: string, field: string, maximum: number, errors: Record<string, string>) {
  if (!value || value.length > maximum || CONTROL_CHARACTER_PATTERN.test(value)) {
    errors[field] = `${field === "name" ? "Organization name" : field === "brandName" ? "Brand name" : "Display name"} must contain 1 to ${maximum} printable characters.`;
  }
}

export function validateUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function validateOrganizationInput(input: Record<string, unknown>): ValidationResult<OrganizationInput> {
  const slug = text(input.slug).toLowerCase();
  const name = text(input.name);
  const fieldErrors: Record<string, string> = {};

  if (!KEY_PATTERN.test(slug)) {
    fieldErrors.slug = "Slug must be 3 to 64 lowercase letters, numbers, or hyphens, without leading or trailing hyphens.";
  }
  validateName(name, "name", 160, fieldErrors);

  return Object.keys(fieldErrors).length > 0
    ? { ok: false, fieldErrors }
    : { ok: true, value: { slug, name } };
}

export function validateLocationInput(input: Record<string, unknown>): ValidationResult<LocationInput> {
  const locationKey = text(input.locationKey).toLowerCase();
  const brandName = text(input.brandName);
  const displayName = text(input.displayName);
  const timezone = text(input.timezone);
  const fieldErrors: Record<string, string> = {};

  if (!KEY_PATTERN.test(locationKey)) {
    fieldErrors.locationKey = "Location key must be 3 to 64 lowercase letters, numbers, or hyphens, without leading or trailing hyphens.";
  }
  validateName(brandName, "brandName", 120, fieldErrors);
  validateName(displayName, "displayName", 160, fieldErrors);

  try {
    if (!timezone || timezone.length > 100 || Intl.DateTimeFormat(undefined, { timeZone: timezone }).resolvedOptions().timeZone.length === 0) {
      fieldErrors.timezone = "Enter a valid IANA timezone, such as America/Denver or UTC.";
    }
  } catch {
    fieldErrors.timezone = "Enter a valid IANA timezone, such as America/Denver or UTC.";
  }

  return Object.keys(fieldErrors).length > 0
    ? { ok: false, fieldErrors }
    : { ok: true, value: { locationKey, brandName, displayName, timezone } };
}

export function validateConnectionInput(input: Record<string, unknown>): ValidationResult<ConnectionInput> {
  const tenantId = text(input.tenantId);
  const displayName = text(input.displayName);
  const environment = text(input.environment);
  const secretReference = text(input.secretReference);
  const locationId = text(input.locationId) || null;
  const fieldErrors: Record<string, string> = {};

  if (!TENANT_ID_PATTERN.test(tenantId)) {
    fieldErrors.tenantId = "ServiceTitan tenant ID must contain 1 to 128 letters, numbers, periods, underscores, or hyphens.";
  }
  validateName(displayName, "displayName", 160, fieldErrors);
  if (environment !== "production" && environment !== "integration") {
    fieldErrors.environment = "Choose production or integration.";
  }
  if (!SECRET_REFERENCE_PATTERN.test(secretReference)) {
    fieldErrors.secretReference = "Enter an operator-resolvable gcp-secret://.../versions/latest reference or uppercase env://VARIABLE reference, never a credential value.";
  }
  if (locationId && !validateUuid(locationId)) {
    fieldErrors.locationId = "Choose a valid location.";
  }

  return Object.keys(fieldErrors).length > 0
    ? { ok: false, fieldErrors }
    : {
        ok: true,
        value: {
          tenantId,
          displayName,
          environment: environment as ConnectionInput["environment"],
          secretReference,
          locationId,
        },
      };
}

export function getTenantReadiness(
  locations: ReadonlyArray<Pick<TenantLocation, "id" | "status">>,
  connections: ReadonlyArray<Pick<ServiceTitanConnection, "id" | "status"> & Partial<Pick<ServiceTitanConnection, "last_validated_at">>>,
  assignments: ReadonlyArray<Pick<ServiceTitanAssignment, "connection_id" | "location_id" | "revoked_at">>,
): TenantReadiness {
  const activeLocationIds = new Set(locations.filter((location) => location.status === "active").map((location) => location.id));
  const enabledConnections = connections.filter(
    (connection) => connection.status !== "disabled" && connection.status !== "archived",
  );
  const enabledConnectionIds = new Set(enabledConnections.map((connection) => connection.id));
  const assignedActiveLocationIds = new Set(
    assignments
      .filter(
        (assignment) =>
          assignment.revoked_at === null &&
          activeLocationIds.has(assignment.location_id) &&
          enabledConnectionIds.has(assignment.connection_id),
      )
      .map((assignment) => assignment.location_id),
  );

  return {
    activeLocationCount: activeLocationIds.size,
    enabledConnectionCount: enabledConnections.length,
    assignedActiveLocationCount: assignedActiveLocationIds.size,
    isConfigured:
      activeLocationIds.size > 0 &&
      enabledConnections.length > 0 &&
      assignedActiveLocationIds.size > 0,
    hasValidatedConnection: enabledConnections.some(
      (connection) => connection.status === "ready" && Boolean(connection.last_validated_at),
    ),
  };
}

const AUTH_MESSAGES: Record<Exclude<ProductionTenantContextResult, { ok: true }>["reason"], string> = {
  unauthenticated: "Sign in is required to access tenant data.",
  "membership-query-failed": "Your tenant membership could not be verified.",
  "no-active-membership": "No active tenant membership is available for this account.",
  "tenant-selection-required": "Choose the tenant you want to view or configure.",
  "invalid-membership": "The active tenant membership is invalid; access is blocked.",
  "tenant-query-failed": "Tenant configuration could not be loaded from the database.",
};

async function loadProductionKpis(
  supabase: SupabaseClient,
  organizationId: string,
  locations: TenantLocation[],
): Promise<ProductionKpiStatus[] | null> {
  const [definitionsResult, bindingsResult] = await Promise.all([
    supabase.from("custom_kpi_definitions")
      .select("id, kpi_key, title, section, value_kind, stale_after_hours")
      .eq("organization_id", organizationId).eq("type", "service_titan").eq("lifecycle", "published"),
    supabase.from("custom_kpi_location_bindings")
      .select("id, kpi_definition_id, location_id, refresh_interval, canonical_source_fingerprint")
      .eq("organization_id", organizationId).eq("approval_status", "approved"),
  ]);
  if (definitionsResult.error || bindingsResult.error) return null;

  const definitions = definitionsResult.data as Array<{
    id: string; kpi_key: string; title: string; section: ProductionKpiStatus["section"];
    value_kind: ProductionKpiStatus["valueKind"]; stale_after_hours: number | null;
  }>;
  const bindings = bindingsResult.data as Array<{
    id: string; kpi_definition_id: string; location_id: string; refresh_interval: string | null;
    canonical_source_fingerprint: string | null;
  }>;
  const observationResults = await Promise.all(bindings.map((binding) => {
    if (!binding.canonical_source_fingerprint) return Promise.resolve({ data: null, error: null });
    return supabase.from("kpi_observations")
      .select("binding_id, source_fingerprint, period_end, observed_at, value, prior_value, confidence")
      .eq("organization_id", organizationId)
      .eq("binding_id", binding.id)
      .eq("source_fingerprint", binding.canonical_source_fingerprint)
      .eq("status", "valid")
      .lte("period_end", new Date().toISOString())
      .order("period_end", { ascending: false })
      .order("observed_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
  }));
  if (observationResults.some((result) => result.error)) return null;
  const observations = observationResults.flatMap((result) => result.data ? [result.data as {
    binding_id: string; source_fingerprint: string; period_end: string; observed_at: string;
    value: number; prior_value: number | null; confidence: ProductionKpiStatus["confidence"];
  }] : []);
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
  const locationById = new Map(locations.map((location) => [location.id, location]));
  const latestByBinding = new Map(observations.map((observation) => [observation.binding_id, observation]));
  const cadenceHours: Record<string, number> = { "15m": 1, "30m": 2, "1h": 3, "4h": 8, "12h": 18, "24h": 36 };
  const now = Date.now();

  return bindings.flatMap((binding): ProductionKpiStatus[] => {
    const definition = definitionById.get(binding.kpi_definition_id);
    const location = locationById.get(binding.location_id);
    if (!definition || !location || location.status !== "active" || !binding.canonical_source_fingerprint) return [];
    const candidate = latestByBinding.get(binding.id);
    const observation = candidate?.source_fingerprint === binding.canonical_source_fingerprint ? candidate : undefined;
    const staleHours = definition.stale_after_hours ?? cadenceHours[binding.refresh_interval ?? ""] ?? 36;
    const observedTime = observation ? Date.parse(observation.observed_at) : Number.NaN;
    const periodEndTime = observation ? Date.parse(observation.period_end) : Number.NaN;
    const freshnessTime = Math.min(observedTime, periodEndTime);
    const health: ProductionKpiStatus["health"] = !observation
      ? "unavailable"
      : !Number.isFinite(freshnessTime) || now - freshnessTime > staleHours * 60 * 60 * 1000
        ? "stale"
        : "current";
    return [{
      bindingId: binding.id,
      definitionId: definition.id,
      kpiKey: definition.kpi_key,
      title: definition.title,
      section: definition.section,
      valueKind: definition.value_kind,
      locationId: location.id,
      locationName: location.display_name,
      value: observation?.value ?? null,
      priorValue: observation?.prior_value ?? null,
      periodEnd: observation?.period_end ?? null,
      observedAt: observation?.observed_at ?? null,
      confidence: observation?.confidence ?? "unknown",
      health,
    }];
  });
}

export async function getProductionTenantContext(): Promise<ProductionTenantContextResult> {
  const auth = await getTenantAuthContext();
  if (!auth.ok) {
    return { ok: false, reason: auth.reason, message: AUTH_MESSAGES[auth.reason], availableTenants: auth.availableTenants };
  }

  const organizationId = auth.membership.organizationId;
  const connectionQuery = auth.supabase
    .from("service_titan_connections")
    .select("id, organization_id, service_titan_tenant_id, display_name, environment, capabilities, status, last_validated_at")
    .eq("organization_id", organizationId)
    .order("display_name");
  const [organizationResult, locationsResult, connectionsResult, assignmentsResult, portfolioAccessResult] = await Promise.all([
    auth.supabase
      .from("organizations")
      .select("id, slug, name, status, settings")
      .eq("id", organizationId)
      .single(),
    auth.supabase
      .from("locations")
      .select("id, organization_id, location_key, brand_name, display_name, timezone, status, presentation")
      .eq("organization_id", organizationId)
      .order("display_name"),
    connectionQuery,
    auth.supabase
      .from("service_titan_connection_locations")
      .select("id, organization_id, connection_id, location_id, assigned_at, revoked_at")
      .eq("organization_id", organizationId)
      .order("assigned_at", { ascending: false }),
    auth.supabase.rpc("has_portfolio_access"),
  ]);

  if (
    organizationResult.error ||
    !organizationResult.data ||
    locationsResult.error ||
    !locationsResult.data ||
    connectionsResult.error ||
    !connectionsResult.data ||
    assignmentsResult.error ||
    !assignmentsResult.data ||
    portfolioAccessResult.error ||
    typeof portfolioAccessResult.data !== "boolean"
  ) {
    return { ok: false, reason: "tenant-query-failed", message: AUTH_MESSAGES["tenant-query-failed"] };
  }

  const organization = organizationResult.data as TenantOrganization;
  const locations = locationsResult.data as TenantLocation[];
  const connections = (connectionsResult.data as unknown as Array<Omit<ServiceTitanConnection, "secret_reference">>).map(
    (connection) => ({
      ...connection,
      secret_reference: "[managed reference restricted]",
    }),
  );
  const assignments = assignmentsResult.data as ServiceTitanAssignment[];
  const kpis = await loadProductionKpis(auth.supabase, organizationId, locations);
  if (!kpis) {
    return { ok: false, reason: "tenant-query-failed", message: AUTH_MESSAGES["tenant-query-failed"] };
  }

  return {
    ok: true,
    tenant: {
      user: { id: auth.user.id, email: auth.user.email ?? null },
      role: auth.membership.role,
      availableTenants: auth.availableTenants,
      hasPortfolioAccess: portfolioAccessResult.data,
      organization,
      locations,
      connections,
      assignments,
      readiness: getTenantReadiness(locations, connections, assignments),
      kpis,
    },
  };
}
