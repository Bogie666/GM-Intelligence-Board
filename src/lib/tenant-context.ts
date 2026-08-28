import "server-only";

import { getTenantAuthContext, type OrganizationRole, type TenantAccessOption } from "@/lib/auth";
import { OPERATING_REGIONS, type OperatingRegion } from "./operating-regions";
import type { SupabaseClient } from "@supabase/supabase-js";

export { OPERATING_REGIONS, type OperatingRegion };

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_REFERENCE_PATTERN = /^(?:gcp-secret:\/\/projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/secrets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/versions\/(?:latest|[1-9][0-9]*)|env:\/\/[A-Z][A-Z0-9_]{1,127})$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const UNICODE_CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const RESERVED_DIVISION_NAMES = new Set(["not mapped", "unmapped"]);
const OPERATING_REGION_SET = new Set<string>(OPERATING_REGIONS);
const UNITED_STATES_TIMEZONES = new Set([
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
]);

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
  region: OperatingRegion;
}

export interface ConnectionInput {
  tenantId: string;
  displayName: string;
  environment: "production" | "integration";
  secretReference: string;
  locationId: string | null;
}

export interface ConnectionCredentialInput {
  tenantId: string;
  displayName: string;
  environment: "production" | "integration";
  clientId: string;
  clientSecret: string;
  appKey: string;
  locationId: string | null;
}

export interface CredentialRotationInput {
  clientId: string;
  clientSecret: string;
  appKey: string;
}

export interface DivisionInput {
  name: string;
}

/** Division-based mapping payload kept separate from the legacy trade mapping contract. */
export interface BusinessUnitMappingInput {
  locationId: string;
  providerBusinessUnitId: string;
  divisionId: string;
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
  region: OperatingRegion | null;
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

export type ServiceTitanDiscoveryStatus = "requested" | "running" | "completed" | "failed" | "stale";

export interface ServiceTitanDiscoveryRun {
  id: string;
  organization_id: string;
  connection_id: string;
  status: ServiceTitanDiscoveryStatus;
  requested_by: string;
  discovery_revision: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
}

export interface ServiceTitanBusinessUnit {
  organization_id: string;
  connection_id: string;
  provider_business_unit_id: string;
  name: string;
  active: boolean;
  provider_modified_at: string | null;
  discovery_revision: string;
  discovery_run_id: string;
  last_seen_at: string;
}

export interface OrganizationDivision {
  id: string;
  organization_id: string;
  name: string;
  status: "active" | "archived";
  sort_order: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ServiceTitanBusinessUnitMapping {
  id: string;
  organization_id: string;
  connection_id: string;
  location_id: string;
  provider_business_unit_id: string;
  division_id: string;
  discovery_revision: string;
  discovery_run_id: string;
  mapped_at: string;
  revoked_at: string | null;
}

export type OriginalKpiSection = "executive" | "revenue" | "calls" | "appointments" | "sales" | "membership";

export interface OriginalKpiCatalogItem {
  kpi_key: string;
  catalog_version: number;
  title: string;
  section: OriginalKpiSection;
  value_kind: "currency" | "number" | "percent" | "ratio";
  direction: "higher" | "lower" | "informational";
  subtitle: string;
  source_system: "ServiceTitan" | "Derived" | "Budget" | "Call System" | "GA4" | "Custom";
  source_readiness_requirement: "service_titan_connection" | "service_titan_business_unit_mapping" | "derived_inputs" | "budget_inputs" | "call_system_connection" | "ga4_connection" | "custom_integration";
  endpoint_recipe_id: string | null;
  endpoint_recipe_version: number | null;
  default_refresh_cadence: string;
}

export interface OriginalKpiDefinitionState {
  kpi_key: string;
  version: number;
  lifecycle: string;
  title: string;
  section: string;
  value_kind: string;
  external_source: Record<string, unknown>;
}

export interface ProductionAdminConfiguration {
  divisions: OrganizationDivision[];
  discoveryRuns: ServiceTitanDiscoveryRun[];
  businessUnits: ServiceTitanBusinessUnit[];
  businessUnitMappings: ServiceTitanBusinessUnitMapping[];
  originalKpiCatalog: OriginalKpiCatalogItem[];
  originalKpiDefinitions: OriginalKpiDefinitionState[];
}

export interface TenantReadiness {
  activeLocationCount: number;
  activeLocationsMissingRegionCount: number;
  enabledConnectionCount: number;
  assignedActiveLocationCount: number;
  isConfigured: boolean;
  hasValidatedConnection: boolean;
}

export type GovernedKpiSourceMethod = "endpoint_recipe" | "saved_report" | "custom_endpoint" | "domo_dataset";
export type PercentValueScale = "ratio" | "whole";

export function getPercentValueScaleForSourceMethod(sourceMethod: GovernedKpiSourceMethod): PercentValueScale {
  return sourceMethod === "endpoint_recipe" ? "ratio" : "whole";
}

export interface ProductionKpiStatus {
  bindingId: string | null;
  definitionId: string | null;
  kpiKey: string;
  title: string;
  section: "executive" | "revenue" | "calls" | "appointments" | "sales" | "membership";
  valueKind: "currency" | "number" | "percent" | "ratio";
  /** Endpoint recipes persist ratio values; other governed source contracts persist display-scale percentages. */
  percentValueScale: PercentValueScale;
  subtitle: string;
  sourceSystem: OriginalKpiCatalogItem["source_system"];
  locationId: string | null;
  locationName: string;
  sourceStatus: string;
  value: number | null;
  priorValue: number | null;
  periodEnd: string | null;
  observedAt: string | null;
  confidence: "high" | "medium" | "low" | "unknown";
  health: "current" | "stale" | "unavailable";
  /** Exact observed calendar contract; prior observations alone are never a PY comparison. */
  observationWindow?: "trailing" | "today" | "mtd" | "ytd";
  comparisonBasis?: "none" | "prior_year_to_date";
  comparisonValue?: number | null;
  comparisonPeriodStart?: string | null;
  comparisonPeriodEnd?: string | null;
  endpointRecipeId?: string | null;
  endpointRecipeVersion?: number | null;
}

/** Published, effective-dated planning input. Dashboard code decides whether it applies to an observation. */
export interface ProductionKpiBudget {
  kpiKey: string;
  locationId: string | null;
  amount: number;
  planningType: "budget";
  lifecycle: "published";
  effectiveStart: string;
  effectiveEnd: string | null;
  lineage: string;
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
  budgets: ProductionKpiBudget[] | null;
  /** Loaded only for an authenticated owner/admin Admin Center request. */
  adminConfiguration?: ProductionAdminConfiguration;
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

export function validateDivisionInput(
  input: Record<string, unknown>,
  existingNames: string[] = [],
): ValidationResult<DivisionInput> {
  const name = text(input.name);
  const normalizedName = name.toLocaleLowerCase("en-US");
  const fieldErrors: Record<string, string> = {};

  if (!name || name.length > 80 || UNICODE_CONTROL_CHARACTER_PATTERN.test(name)) {
    fieldErrors.name = "Division name must contain 1 to 80 printable characters.";
  } else if (RESERVED_DIVISION_NAMES.has(normalizedName)) {
    fieldErrors.name = "Choose a division name other than Not Mapped or Unmapped.";
  } else if (existingNames.some((existing) => text(existing).toLocaleLowerCase("en-US") === normalizedName)) {
    fieldErrors.name = "A division with this name already exists.";
  }

  return Object.keys(fieldErrors).length > 0
    ? { ok: false, fieldErrors }
    : { ok: true, value: { name } };
}

export function validateBusinessUnitMappingInput(
  input: Record<string, unknown>,
): ValidationResult<BusinessUnitMappingInput> {
  const locationId = text(input.locationId);
  const divisionId = text(input.divisionId);
  const providerBusinessUnitId = typeof input.providerBusinessUnitId === "string"
    ? input.providerBusinessUnitId
    : "";
  const fieldErrors: Record<string, string> = {};

  if (!validateUuid(locationId)) fieldErrors.locationId = "Choose a valid location.";
  if (!validateUuid(divisionId)) fieldErrors.divisionId = "Choose a valid division.";
  if (
    !providerBusinessUnitId ||
    providerBusinessUnitId !== providerBusinessUnitId.trim() ||
    providerBusinessUnitId.length > 160 ||
    UNICODE_CONTROL_CHARACTER_PATTERN.test(providerBusinessUnitId)
  ) {
    fieldErrors.providerBusinessUnitId = "The ServiceTitan business-unit identifier is invalid.";
  }

  return Object.keys(fieldErrors).length > 0
    ? { ok: false, fieldErrors }
    : { ok: true, value: { locationId, providerBusinessUnitId, divisionId } };
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
  const region = text(input.region).toLowerCase();
  const fieldErrors: Record<string, string> = {};

  if (!KEY_PATTERN.test(locationKey)) {
    fieldErrors.locationKey = "Location key must be 3 to 64 lowercase letters, numbers, or hyphens, without leading or trailing hyphens.";
  }
  validateName(brandName, "brandName", 120, fieldErrors);
  validateName(displayName, "displayName", 160, fieldErrors);

  if (!UNITED_STATES_TIMEZONES.has(timezone)) {
    fieldErrors.timezone = "Choose a supported United States timezone.";
  }
  if (!OPERATING_REGION_SET.has(region)) {
    fieldErrors.region = "Choose West, Midwest, Northwest, or Southwest.";
  }

  return Object.keys(fieldErrors).length > 0
    ? { ok: false, fieldErrors }
    : { ok: true, value: { locationKey, brandName, displayName, timezone, region: region as OperatingRegion } };
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

function credentialComponent(
  value: unknown,
  field: "clientId" | "clientSecret" | "appKey",
  label: string,
  errors: Record<string, string>,
): string {
  const candidate = typeof value === "string" ? value : "";
  if (
    candidate.length < 1 ||
    candidate.length > 4096 ||
    candidate !== candidate.trim() ||
    CONTROL_CHARACTER_PATTERN.test(candidate)
  ) {
    errors[field] = `${label} must contain 1 to 4096 characters with no leading, trailing, or control characters.`;
  }
  return candidate;
}

export function validateConnectionCredentialInput(
  input: Record<string, unknown>,
): ValidationResult<ConnectionCredentialInput> {
  const tenantId = text(input.tenantId);
  const displayName = text(input.displayName);
  const environment = text(input.environment);
  const locationId = text(input.locationId) || null;
  const fieldErrors: Record<string, string> = {};

  if (!TENANT_ID_PATTERN.test(tenantId)) {
    fieldErrors.tenantId = "ServiceTitan tenant ID must contain 1 to 128 letters, numbers, periods, underscores, or hyphens.";
  }
  validateName(displayName, "displayName", 160, fieldErrors);
  if (environment !== "production" && environment !== "integration") {
    fieldErrors.environment = "Choose production or integration.";
  }
  if (locationId && !validateUuid(locationId)) {
    fieldErrors.locationId = "Choose a valid location.";
  }

  const clientId = credentialComponent(input.clientId, "clientId", "Client ID", fieldErrors);
  const clientSecret = credentialComponent(input.clientSecret, "clientSecret", "Client secret", fieldErrors);
  const appKey = credentialComponent(input.appKey, "appKey", "ST App Key", fieldErrors);

  return Object.keys(fieldErrors).length > 0
    ? { ok: false, fieldErrors }
    : {
        ok: true,
        value: {
          tenantId,
          displayName,
          environment: environment as ConnectionCredentialInput["environment"],
          clientId,
          clientSecret,
          appKey,
          locationId,
        },
      };
}

export function validateCredentialRotationInput(
  input: Record<string, unknown>,
): ValidationResult<CredentialRotationInput> {
  const fieldErrors: Record<string, string> = {};
  const clientId = credentialComponent(input.clientId, "clientId", "Client ID", fieldErrors);
  const clientSecret = credentialComponent(input.clientSecret, "clientSecret", "Client secret", fieldErrors);
  const appKey = credentialComponent(input.appKey, "appKey", "ST App Key", fieldErrors);
  return Object.keys(fieldErrors).length > 0
    ? { ok: false, fieldErrors }
    : { ok: true, value: { clientId, clientSecret, appKey } };
}

export function getTenantReadiness(
  locations: ReadonlyArray<Pick<TenantLocation, "id" | "status" | "region">>,
  connections: ReadonlyArray<Pick<ServiceTitanConnection, "id" | "status"> & Partial<Pick<ServiceTitanConnection, "last_validated_at">>>,
  assignments: ReadonlyArray<Pick<ServiceTitanAssignment, "connection_id" | "location_id" | "revoked_at">>,
): TenantReadiness {
  const activeLocationIds = new Set(locations.filter((location) => location.status === "active").map((location) => location.id));
  const activeLocationsMissingRegionCount = locations.filter(
    (location) => location.status === "active" && location.region === null,
  ).length;
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
    activeLocationsMissingRegionCount,
    enabledConnectionCount: enabledConnections.length,
    assignedActiveLocationCount: assignedActiveLocationIds.size,
    isConfigured:
      activeLocationIds.size > 0 &&
      activeLocationsMissingRegionCount === 0 &&
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
  const [catalogResult, definitionsResult, bindingsResult] = await Promise.all([
    supabase.from("original_kpi_catalog")
      .select("kpi_key, title, section, value_kind, subtitle, source_system")
      .eq("catalog_version", 1),
    supabase.from("custom_kpi_definitions")
      .select("id, kpi_key, title, section, value_kind, stale_after_hours, external_source")
      .eq("organization_id", organizationId).eq("lifecycle", "published"),
    supabase.from("custom_kpi_location_bindings")
      .select("id, kpi_definition_id, location_id, source_method, endpoint_recipe_id, endpoint_recipe_version, refresh_interval, observation_window, comparison_basis, canonical_source_fingerprint")
      .eq("organization_id", organizationId).eq("approval_status", "approved"),
  ]);
  if (catalogResult.error || definitionsResult.error || bindingsResult.error) return null;

  const catalog = catalogResult.data as Array<{
    kpi_key: string; title: string; section: ProductionKpiStatus["section"];
    value_kind: ProductionKpiStatus["valueKind"];
    subtitle: string; source_system: ProductionKpiStatus["sourceSystem"];
  }>;
  const definitions = definitionsResult.data as Array<{
    id: string; kpi_key: string; title: string; section: ProductionKpiStatus["section"];
    value_kind: ProductionKpiStatus["valueKind"]; stale_after_hours: number | null;
    external_source: Record<string, unknown>;
  }>;
  const bindings = bindingsResult.data as Array<{
    id: string; kpi_definition_id: string; location_id: string;
    source_method: GovernedKpiSourceMethod;
    endpoint_recipe_id: string | null;
    endpoint_recipe_version: number | null;
    refresh_interval: string | null;
    observation_window: "trailing" | "today" | "mtd" | "ytd";
    comparison_basis: "none" | "prior_year_to_date";
    canonical_source_fingerprint: string | null;
  }>;
  const observationResults = await Promise.all(bindings.map((binding) => {
    if (!binding.canonical_source_fingerprint) return Promise.resolve({ data: [], error: null });
    return supabase.from("kpi_observations")
      .select("binding_id, source_fingerprint, period_end, observed_at, value, prior_value, comparison_basis, comparison_value, comparison_period_start, comparison_period_end, confidence")
      .eq("organization_id", organizationId)
      .eq("binding_id", binding.id)
      .eq("source_fingerprint", binding.canonical_source_fingerprint)
      .eq("status", "valid")
      .lte("period_end", new Date().toISOString())
      .order("period_end", { ascending: false })
      .order("observed_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(13);
  }));
  if (observationResults.some((result) => result.error)) return null;
  type ProductionObservation = {
    binding_id: string; source_fingerprint: string; period_end: string; observed_at: string;
    value: number; prior_value: number | null;
    comparison_basis: "none" | "prior_year_to_date";
    comparison_value: number | null;
    comparison_period_start: string | null;
    comparison_period_end: string | null;
    confidence: ProductionKpiStatus["confidence"];
  };
  const observations = observationResults.flatMap((result) => (result.data ?? []) as ProductionObservation[]);
  const originalDefinitions = definitions.filter((definition) => definition.external_source?.catalogName === "original");
  const definitionByKey = new Map(originalDefinitions.map((definition) => [definition.kpi_key, definition]));
  const locationById = new Map(locations.map((location) => [location.id, location]));
  const observationsByBinding = new Map<string, ProductionObservation[]>();
  for (const observation of observations) {
    const existing = observationsByBinding.get(observation.binding_id) ?? [];
    existing.push(observation);
    observationsByBinding.set(observation.binding_id, existing);
  }
  const cadenceHours: Record<string, number> = { "15m": 1, "30m": 2, "1h": 3, "4h": 8, "12h": 18, "24h": 36 };
  const now = Date.now();
  const sectionOrder = new Map(["executive", "revenue", "calls", "appointments", "sales", "membership"].map((section, index) => [section, index]));

  return catalog
    .sort((left, right) => (sectionOrder.get(left.section) ?? 99) - (sectionOrder.get(right.section) ?? 99) || left.title.localeCompare(right.title))
    .flatMap((catalogItem): ProductionKpiStatus[] => {
      const definition = definitionByKey.get(catalogItem.kpi_key);
      const catalogPresentation = {
        subtitle: catalogItem.subtitle,
        sourceSystem: catalogItem.source_system,
        percentValueScale: "whole" as const,
      };
      if (!definition) return [{
        bindingId: null, definitionId: null, kpiKey: catalogItem.kpi_key, title: catalogItem.title,
        section: catalogItem.section, valueKind: catalogItem.value_kind, ...catalogPresentation, locationId: null,
        locationName: "Catalog definition not enabled", sourceStatus: "Enable in Admin Center",
        value: null, priorValue: null, periodEnd: null, observedAt: null, confidence: "unknown", health: "unavailable",
      }];
      const definitionBindings = bindings.filter((binding) => binding.kpi_definition_id === definition.id);
      if (definitionBindings.length === 0) return [{
        bindingId: null, definitionId: definition.id, kpiKey: definition.kpi_key, title: definition.title,
        section: definition.section, valueKind: definition.value_kind, ...catalogPresentation, locationId: null,
        locationName: "No approved location binding", sourceStatus: "Source configuration required",
        value: null, priorValue: null, periodEnd: null, observedAt: null, confidence: "unknown", health: "unavailable",
      }];
      return definitionBindings.flatMap((binding): ProductionKpiStatus[] => {
        const location = locationById.get(binding.location_id);
        if (!location || location.status !== "active") return [];
        const candidateObservations = (observationsByBinding.get(binding.id) ?? [])
          .filter((candidate) => candidate.source_fingerprint === binding.canonical_source_fingerprint);
        const common = {
          bindingId: binding.id, definitionId: definition.id, kpiKey: definition.kpi_key, title: definition.title,
          section: definition.section, valueKind: definition.value_kind, ...catalogPresentation,
          percentValueScale: getPercentValueScaleForSourceMethod(binding.source_method),
          observationWindow: binding.observation_window,
          comparisonBasis: binding.comparison_basis,
          endpointRecipeId: binding.source_method === "endpoint_recipe" ? binding.endpoint_recipe_id : null,
          endpointRecipeVersion: binding.source_method === "endpoint_recipe" ? binding.endpoint_recipe_version : null,
          locationId: location.id,
          locationName: location.display_name,
          sourceStatus: binding.canonical_source_fingerprint ? "Approved governed source" : "Source fingerprint required",
        };
        if (candidateObservations.length === 0) return [{
          ...common,
          value: null, priorValue: null, periodEnd: null, observedAt: null,
          confidence: "unknown", health: "unavailable",
        }];
        const staleHours = definition.stale_after_hours ?? cadenceHours[binding.refresh_interval ?? ""] ?? 36;
        return candidateObservations.map((observation): ProductionKpiStatus => {
          const observedTime = Date.parse(observation.observed_at);
          const periodEndTime = Date.parse(observation.period_end);
          const freshnessTime = Math.min(observedTime, periodEndTime);
          const health: ProductionKpiStatus["health"] =
            !Number.isFinite(freshnessTime) || now - freshnessTime > staleHours * 60 * 60 * 1000 ? "stale" : "current";
          return {
            ...common,
            value: observation.value, priorValue: observation.prior_value,
            comparisonBasis: observation.comparison_basis,
            comparisonValue: observation.comparison_value,
            comparisonPeriodStart: observation.comparison_period_start,
            comparisonPeriodEnd: observation.comparison_period_end,
            periodEnd: observation.period_end, observedAt: observation.observed_at,
            confidence: observation.confidence, health,
          };
        });
      });
    });
}

async function loadProductionBudgets(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ProductionKpiBudget[] | null> {
  const { data, error } = await supabase.from("kpi_targets")
    .select("location_id, metric_key, target_value, effective_from, effective_to, dimensions, lifecycle, version")
    .eq("organization_id", organizationId)
    .eq("metric_key", "revenue-mtd")
    .eq("lifecycle", "published")
    .contains("dimensions", { planning_type: "budget" })
    .order("effective_from", { ascending: false })
    .order("version", { ascending: false });
  if (error || !data) return null;
  return data.flatMap((row): ProductionKpiBudget[] => {
    const amount = typeof row.target_value === "number" ? row.target_value : Number(row.target_value);
    if (!Number.isFinite(amount) || amount < 0 || typeof row.effective_from !== "string") return [];
    return [{
      kpiKey: "revenue-mtd",
      locationId: typeof row.location_id === "string" ? row.location_id : null,
      amount,
      planningType: "budget",
      lifecycle: "published",
      effectiveStart: row.effective_from,
      effectiveEnd: typeof row.effective_to === "string" ? row.effective_to : null,
      lineage: `kpi_targets:revenue-mtd:v${row.version}`,
    }];
  });
}

const ADMIN_PAGE_SIZE = 500;
const ADMIN_MAX_ROWS_PER_CONNECTION = 50_000;

async function loadAllAdminRows<T>(
  pageLoader: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[] | null> {
  const rows: T[] = [];
  for (let from = 0; ; from += ADMIN_PAGE_SIZE) {
    const page = await pageLoader(from, from + ADMIN_PAGE_SIZE - 1);
    if (page.error || !page.data) return null;
    rows.push(...page.data);
    if (rows.length > ADMIN_MAX_ROWS_PER_CONNECTION) return null;
    if (page.data.length < ADMIN_PAGE_SIZE) return rows;
  }
}

export async function getProductionTenantContext(
  options: { includeAdminConfiguration?: boolean } = {},
): Promise<ProductionTenantContextResult> {
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
      .select("id, organization_id, location_key, brand_name, display_name, timezone, region, status, presentation")
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
  const [kpis, budgets] = await Promise.all([
    loadProductionKpis(auth.supabase, organizationId, locations),
    loadProductionBudgets(auth.supabase, organizationId),
  ]);
  if (!kpis) {
    return { ok: false, reason: "tenant-query-failed", message: AUTH_MESSAGES["tenant-query-failed"] };
  }

  let adminConfiguration: ProductionAdminConfiguration | undefined;
  if (options.includeAdminConfiguration) {
    if (auth.membership.role !== "owner" && auth.membership.role !== "admin") {
      return { ok: false, reason: "tenant-query-failed", message: AUTH_MESSAGES["tenant-query-failed"] };
    }
    const [divisionsResult, discoveryResults, businessUnitResults, mappingResults, catalogResult, definitionsResult] = await Promise.all([
      auth.supabase
        .from("organization_divisions")
        .select("id, organization_id, name, status, sort_order, created_at, updated_at, archived_at")
        .eq("organization_id", organizationId)
        .order("sort_order")
        .order("name"),
      Promise.all(connections.map((connection) => auth.supabase
        .from("service_titan_discovery_runs")
        .select("id, organization_id, connection_id, status, requested_by, discovery_revision, requested_at, started_at, completed_at, error_code, error_message")
        .eq("organization_id", organizationId)
        .eq("connection_id", connection.id)
        .order("requested_at", { ascending: false })
        .limit(100))),
      Promise.all(connections.map((connection) => loadAllAdminRows<ServiceTitanBusinessUnit>(async (from, to) => {
        const result = await auth.supabase
          .from("service_titan_business_units")
          .select("organization_id, connection_id, provider_business_unit_id, name, active, provider_modified_at, discovery_revision, discovery_run_id, last_seen_at")
          .eq("organization_id", organizationId)
          .eq("connection_id", connection.id)
          .order("provider_business_unit_id")
          .range(from, to);
        return { data: result.data as ServiceTitanBusinessUnit[] | null, error: result.error };
      }))),
      Promise.all(connections.map((connection) => loadAllAdminRows<ServiceTitanBusinessUnitMapping>(async (from, to) => {
        const result = await auth.supabase
          .from("service_titan_business_unit_mappings")
          .select("id, organization_id, connection_id, location_id, provider_business_unit_id, division_id, discovery_revision, discovery_run_id, mapped_at, revoked_at")
          .eq("organization_id", organizationId)
          .eq("connection_id", connection.id)
          .is("revoked_at", null)
          .order("provider_business_unit_id")
          .range(from, to);
        return { data: result.data as ServiceTitanBusinessUnitMapping[] | null, error: result.error };
      }))),
      auth.supabase
        .from("original_kpi_catalog")
        .select("kpi_key, catalog_version, title, section, value_kind, direction, subtitle, source_system, source_readiness_requirement, endpoint_recipe_id, endpoint_recipe_version, default_refresh_cadence")
        .eq("catalog_version", 1)
        .order("section")
        .order("title"),
      auth.supabase
        .from("custom_kpi_definitions")
        .select("kpi_key, version, lifecycle, title, section, value_kind, external_source")
        .eq("organization_id", organizationId),
    ]);
    const discoveryRuns = discoveryResults.flatMap((result) => result.data ?? []);
    const businessUnits = businessUnitResults.flatMap((result) => result ?? []);
    const businessUnitMappings = mappingResults.flatMap((result) => result ?? []);
    if (
      divisionsResult.error || !divisionsResult.data ||
      discoveryResults.some((result) => result.error || !result.data) ||
      businessUnitResults.some((result) => result === null) ||
      mappingResults.some((result) => result === null) ||
      catalogResult.error || !catalogResult.data ||
      definitionsResult.error || !definitionsResult.data
    ) {
      return { ok: false, reason: "tenant-query-failed", message: AUTH_MESSAGES["tenant-query-failed"] };
    }
    adminConfiguration = {
      divisions: divisionsResult.data as OrganizationDivision[],
      discoveryRuns: discoveryRuns as ServiceTitanDiscoveryRun[],
      businessUnits,
      businessUnitMappings,
      originalKpiCatalog: catalogResult.data as OriginalKpiCatalogItem[],
      originalKpiDefinitions: definitionsResult.data as OriginalKpiDefinitionState[],
    };
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
      budgets,
      ...(adminConfiguration ? { adminConfiguration } : {}),
    },
  };
}
