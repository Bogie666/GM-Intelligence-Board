import "server-only";

import { createServerSupabaseClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const PORTFOLIO_ROLES = new Set(["owner", "admin", "viewer"]);

export interface PortfolioBrandSummary {
  id: string;
  slug: string;
  name: string;
  activeLocationCount: number;
  enabledConnectionCount: number;
  readyConnectionCount: number;
  assignedLocationCount: number;
  publishedKpiCount: number;
  approvedBindingCount: number;
  observedBindingCount: number;
  stage: "onboarding" | "connection" | "validation" | "kpi-setup" | "observation" | "operational";
}

export interface PortfolioOverview {
  id: string;
  slug: string;
  name: string;
  role: "owner" | "admin" | "viewer";
  brands: PortfolioBrandSummary[];
  totals: {
    brands: number;
    activeLocations: number;
    enabledConnections: number;
    readyConnections: number;
    assignedLocations: number;
    publishedKpis: number;
    approvedBindings: number;
    observedBindings: number;
  };
}

export type PortfolioOverviewResult =
  | { ok: true; portfolio: PortfolioOverview }
  | { ok: false; reason: "unauthenticated" | "unauthorized" | "unavailable" };

type PortfolioRpcRow = {
  portfolio_id: unknown;
  portfolio_slug: unknown;
  portfolio_name: unknown;
  portfolio_role: unknown;
  brand_id: unknown;
  brand_slug: unknown;
  brand_name: unknown;
  active_location_count: unknown;
  enabled_connection_count: unknown;
  ready_connection_count: unknown;
  assigned_location_count: unknown;
  published_kpi_count: unknown;
  approved_binding_count: unknown;
  observed_binding_count: unknown;
};

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function stageFor(brand: Omit<PortfolioBrandSummary, "stage">): PortfolioBrandSummary["stage"] {
  if (brand.activeLocationCount === 0) return "onboarding";
  if (brand.enabledConnectionCount === 0 || brand.assignedLocationCount === 0) return "connection";
  if (brand.readyConnectionCount === 0) return "validation";
  if (brand.publishedKpiCount === 0 || brand.approvedBindingCount === 0) return "kpi-setup";
  if (brand.observedBindingCount < brand.approvedBindingCount) return "observation";
  return "operational";
}

function parseRows(rows: unknown): PortfolioOverview | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0] as PortfolioRpcRow;
  if (
    !validText(first.portfolio_id, 36) || !UUID_PATTERN.test(first.portfolio_id) ||
    !validText(first.portfolio_slug, 64) || !SLUG_PATTERN.test(first.portfolio_slug) ||
    !validText(first.portfolio_name, 160) ||
    !validText(first.portfolio_role, 20) || !PORTFOLIO_ROLES.has(first.portfolio_role)
  ) return null;

  const seen = new Set<string>();
  const brands: PortfolioBrandSummary[] = [];
  for (const item of rows as PortfolioRpcRow[]) {
    if (
      item.portfolio_id !== first.portfolio_id || item.portfolio_slug !== first.portfolio_slug ||
      item.portfolio_name !== first.portfolio_name || item.portfolio_role !== first.portfolio_role ||
      !validText(item.brand_id, 36) || !UUID_PATTERN.test(item.brand_id) || seen.has(item.brand_id) ||
      !validText(item.brand_slug, 64) || !SLUG_PATTERN.test(item.brand_slug) ||
      !validText(item.brand_name, 160) ||
      !validCount(item.active_location_count) || !validCount(item.enabled_connection_count) ||
      !validCount(item.ready_connection_count) || !validCount(item.assigned_location_count) ||
      !validCount(item.published_kpi_count) || !validCount(item.approved_binding_count) ||
      !validCount(item.observed_binding_count)
    ) return null;
    seen.add(item.brand_id);
    const base = {
      id: item.brand_id,
      slug: item.brand_slug,
      name: item.brand_name.trim(),
      activeLocationCount: item.active_location_count,
      enabledConnectionCount: item.enabled_connection_count,
      readyConnectionCount: item.ready_connection_count,
      assignedLocationCount: item.assigned_location_count,
      publishedKpiCount: item.published_kpi_count,
      approvedBindingCount: item.approved_binding_count,
      observedBindingCount: item.observed_binding_count,
    };
    brands.push({ ...base, stage: stageFor(base) });
  }

  const totals = brands.reduce((result, brand) => ({
    brands: result.brands + 1,
    activeLocations: result.activeLocations + brand.activeLocationCount,
    enabledConnections: result.enabledConnections + brand.enabledConnectionCount,
    readyConnections: result.readyConnections + brand.readyConnectionCount,
    assignedLocations: result.assignedLocations + brand.assignedLocationCount,
    publishedKpis: result.publishedKpis + brand.publishedKpiCount,
    approvedBindings: result.approvedBindings + brand.approvedBindingCount,
    observedBindings: result.observedBindings + brand.observedBindingCount,
  }), { brands: 0, activeLocations: 0, enabledConnections: 0, readyConnections: 0, assignedLocations: 0, publishedKpis: 0, approvedBindings: 0, observedBindings: 0 });

  return {
    id: first.portfolio_id,
    slug: first.portfolio_slug,
    name: first.portfolio_name.trim(),
    role: first.portfolio_role as PortfolioOverview["role"],
    brands,
    totals,
  };
}

export async function getPortfolioOverview(): Promise<PortfolioOverviewResult> {
  const supabase = await createServerSupabaseClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return { ok: false, reason: "unauthenticated" };

  const { data: hasAccess, error: accessError } = await supabase.rpc("has_portfolio_access");
  if (accessError) return { ok: false, reason: "unavailable" };
  if (hasAccess !== true) return { ok: false, reason: "unauthorized" };

  const { data, error } = await supabase.rpc("get_portfolio_overview");
  if (error) return { ok: false, reason: "unavailable" };
  const portfolio = parseRows(data);
  return portfolio ? { ok: true, portfolio } : { ok: false, reason: "unavailable" };
}
