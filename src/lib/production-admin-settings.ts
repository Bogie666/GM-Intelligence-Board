import type { SupabaseClient } from "@supabase/supabase-js";

export type ProductionSettingWarning = { area: string; message: string };

export interface EndpointRecipePolicy {
  endpoint_recipe_id: string;
  endpoint_recipe_version: number;
  refresh_interval: string;
}

export interface ProductionReportSource {
  id: string;
  connection_id: string;
  service_titan_tenant_id: string;
  category_id: string;
  report_id: string;
  owner_display_name: string;
  name: string;
  description: string;
  fields: unknown[];
  parameters: unknown[];
  lifecycle: string;
  verification: string;
  expected_schema_fingerprint: string;
  observed_schema_fingerprint: string | null;
  provider_modified_at: string;
  updated_at: string;
}

export interface ProductionKpiDefinitionOption {
  id: string;
  kpi_key: string;
  title: string;
  type: string;
  value_kind: string;
  lifecycle: string;
  version: number;
}

export interface ProductionKpiBinding {
  id: string;
  kpi_definition_id: string;
  location_id: string;
  connection_id: string | null;
  source_method: string | null;
  endpoint_recipe_id: string | null;
  endpoint_recipe_version: number | null;
  report_source_id: string | null;
  refresh_interval: string | null;
  report_reduction: string | null;
  value_field: string | null;
  numerator_field: string | null;
  denominator_field: string | null;
  approval_status: string;
  updated_at: string;
}

export interface ProductionKpiTarget {
  id: string;
  location_id: string | null;
  kpi_definition_id: string | null;
  metric_key: string;
  version: number;
  target_value: number;
  warning_value: number | null;
  effective_from: string;
  effective_to: string | null;
  dimensions: Record<string, unknown>;
  lifecycle: string;
  updated_at: string;
}

export interface ProductionLayoutTemplate {
  id: string;
  template_key: string;
  name: string;
  audience_role: string;
  lifecycle: string;
  version: number;
  layout: Record<string, unknown>;
  updated_at: string;
}

export interface ProductionProfileLayout {
  id: string;
  profile_id: string;
  location_id: string;
  template_id: string;
  overrides: Record<string, unknown>;
  updated_at: string;
}

export interface ProductionAccessMembership {
  id: string;
  profile_id: string;
  role: string;
  status: string;
  profiles: { display_name: string | null; job_title: string | null } | { display_name: string | null; job_title: string | null }[] | null;
}

export interface ProductionAdminSettingsWorkspace {
  endpointRecipes: EndpointRecipePolicy[];
  reportSources: ProductionReportSource[];
  kpiDefinitions: ProductionKpiDefinitionOption[];
  bindings: ProductionKpiBinding[];
  targets: ProductionKpiTarget[];
  layoutTemplates: ProductionLayoutTemplate[];
  profileLayouts: ProductionProfileLayout[];
  memberships: ProductionAccessMembership[];
  warnings: ProductionSettingWarning[];
}

type QueryResult = { data: unknown; error: { message?: string } | null };

function rows<T>(result: QueryResult, area: string, warnings: ProductionSettingWarning[]): T[] {
  if (result.error || !Array.isArray(result.data)) {
    warnings.push({ area, message: `${area} could not be loaded from the tenant database.` });
    return [];
  }
  return result.data as T[];
}

/**
 * Loads the three enterprise-settings workspaces through the caller's authenticated
 * Supabase client. Every tenant-owned query has an explicit organization predicate;
 * database RLS remains the authoritative second boundary.
 */
export async function loadProductionAdminSettings(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ProductionAdminSettingsWorkspace> {
  const [recipes, reports, definitions, bindings, targets, templates, profileLayouts, memberships] = await Promise.all([
    supabase.from("service_titan_endpoint_recipe_refresh_policies")
      .select("endpoint_recipe_id, endpoint_recipe_version, refresh_interval")
      .order("endpoint_recipe_id").order("endpoint_recipe_version").order("refresh_interval"),
    supabase.from("service_titan_report_sources")
      .select("id, connection_id, service_titan_tenant_id, category_id, report_id, owner_display_name, name, description, fields, parameters, lifecycle, verification, expected_schema_fingerprint, observed_schema_fingerprint, provider_modified_at, updated_at")
      .eq("organization_id", organizationId).order("updated_at", { ascending: false }),
    supabase.from("custom_kpi_definitions")
      .select("id, kpi_key, title, type, value_kind, lifecycle, version")
      .eq("organization_id", organizationId).eq("lifecycle", "published").order("title"),
    supabase.from("custom_kpi_location_bindings")
      .select("id, kpi_definition_id, location_id, connection_id, source_method, endpoint_recipe_id, endpoint_recipe_version, report_source_id, refresh_interval, report_reduction, value_field, numerator_field, denominator_field, approval_status, updated_at")
      .eq("organization_id", organizationId).order("updated_at", { ascending: false }),
    supabase.from("kpi_targets")
      .select("id, location_id, kpi_definition_id, metric_key, version, target_value, warning_value, effective_from, effective_to, dimensions, lifecycle, updated_at")
      .eq("organization_id", organizationId).order("effective_from", { ascending: false }).order("version", { ascending: false }),
    supabase.from("layout_templates")
      .select("id, template_key, name, audience_role, lifecycle, version, layout, updated_at")
      .eq("organization_id", organizationId).order("name").order("version", { ascending: false }),
    supabase.from("profile_layouts")
      .select("id, profile_id, location_id, template_id, overrides, updated_at")
      .eq("organization_id", organizationId).order("updated_at", { ascending: false }),
    supabase.from("organization_memberships")
      .select("id, profile_id, role, status, profiles(display_name, job_title)")
      .eq("organization_id", organizationId).order("role").order("profile_id"),
  ]) as unknown as QueryResult[];

  const warnings: ProductionSettingWarning[] = [];
  return {
    endpointRecipes: rows<EndpointRecipePolicy>(recipes, "Endpoint recipes", warnings),
    reportSources: rows<ProductionReportSource>(reports, "Saved report sources", warnings),
    kpiDefinitions: rows<ProductionKpiDefinitionOption>(definitions, "Published KPI definitions", warnings),
    bindings: rows<ProductionKpiBinding>(bindings, "KPI bindings", warnings),
    targets: rows<ProductionKpiTarget>(targets, "Targets and budgets", warnings),
    layoutTemplates: rows<ProductionLayoutTemplate>(templates, "Layout templates", warnings),
    profileLayouts: rows<ProductionProfileLayout>(profileLayouts, "Profile layouts", warnings),
    memberships: rows<ProductionAccessMembership>(memberships, "Access roles", warnings),
    warnings,
  };
}

const FORBIDDEN_KEY = /(secret|password|authorization|access.?token|refresh.?token|client.?id|app.?key|api.?key|bearer|credential)/i;
const METRIC_KEY = /^[a-z0-9][a-z0-9-]{2,80}$/;

export function containsForbiddenConfigurationKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenConfigurationKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([key, nested]) => FORBIDDEN_KEY.test(key) || containsForbiddenConfigurationKey(nested));
}

export function parseConfigurationJson(
  raw: string,
  shape: "array" | "object",
): { ok: true; value: unknown[] | Record<string, unknown> } | { ok: false; message: string } {
  try {
    const value: unknown = JSON.parse(raw);
    const validShape = shape === "array"
      ? Array.isArray(value)
      : Boolean(value) && typeof value === "object" && !Array.isArray(value);
    if (!validShape) return { ok: false, message: `Enter a valid JSON ${shape}.` };
    if (containsForbiddenConfigurationKey(value)) {
      return { ok: false, message: "Credential-like keys are not permitted in configuration JSON." };
    }
    return { ok: true, value: value as unknown[] | Record<string, unknown> };
  } catch {
    return { ok: false, message: `Enter a valid JSON ${shape}.` };
  }
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isValidMetricKey(value: string): boolean {
  return METRIC_KEY.test(value);
}

export function parseFiniteConfigurationNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= 1_000_000_000_000_000 ? parsed : null;
}

export function profileDisplayName(membership: ProductionAccessMembership): string {
  const profile = Array.isArray(membership.profiles) ? membership.profiles[0] : membership.profiles;
  return profile?.display_name?.trim() || `Profile ${membership.profile_id.slice(0, 8)}`;
}
