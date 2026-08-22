import type { ProductionKpiStatus } from "./tenant-context";

export const PRODUCTION_DASHBOARD_SECTIONS = [
  { id: "executive", label: "Executive Overview", shortLabel: "Executive", description: "The operating signals available to the general manager for this location." },
  { id: "revenue", label: "Revenue & Financial", shortLabel: "Revenue", description: "Governed revenue observations and financial performance signals." },
  { id: "calls", label: "Calls & Digital", shortLabel: "Calls & Digital", description: "Call handling and digital demand observations from connected sources." },
  { id: "appointments", label: "Appointments", shortLabel: "Appointments", description: "Booked, run, and completed appointment performance." },
  { id: "sales", label: "Sales Performance", shortLabel: "Sales", description: "Sales execution and conversion observations for the selected location." },
  { id: "membership", label: "Membership", shortLabel: "Membership", description: "Membership growth, retention, and recurring-customer signals." },
] as const satisfies ReadonlyArray<{
  id: ProductionKpiStatus["section"];
  label: string;
  shortLabel: string;
  description: string;
}>;

export interface ProductionDashboardPeriod {
  value: string;
  label: string;
}

export interface ProductionDashboardKpi extends ProductionKpiStatus {
  periodAvailable: boolean;
}

function validTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** UTC day is the dashboard's honest period grain because observations expose period_end, not demo period presets. */
export function productionPeriodKey(value: string | null): string | null {
  const timestamp = validTimestamp(value);
  return timestamp === null ? null : new Date(timestamp).toISOString().slice(0, 10);
}

export function formatProductionPeriod(value: string | null): string {
  const timestamp = validTimestamp(value);
  if (timestamp === null) return "Period unavailable";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

export function formatProductionDateTime(value: string | null): string {
  const timestamp = validTimestamp(value);
  if (timestamp === null) return "Unavailable";
  return `${new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(timestamp))} UTC`;
}

function isScopedToLocation(kpi: ProductionKpiStatus, locationId: string | null): boolean {
  if (kpi.locationId === null) return true;
  return locationId !== null && kpi.locationId === locationId;
}

export function getSupportedProductionPeriods(
  kpis: ReadonlyArray<ProductionKpiStatus>,
  locationId: string | null,
  section: ProductionKpiStatus["section"],
): ProductionDashboardPeriod[] {
  const periodValues = new Map<string, string>();
  for (const kpi of kpis) {
    if (kpi.section !== section || !isScopedToLocation(kpi, locationId) || kpi.value === null) continue;
    const key = productionPeriodKey(kpi.periodEnd);
    if (key) periodValues.set(key, kpi.periodEnd ?? key);
  }
  return Array.from(periodValues.entries())
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([value, sourceValue]) => ({ value, label: formatProductionPeriod(sourceValue) }));
}

function identity(kpi: ProductionKpiStatus): string {
  return `${kpi.kpiKey}:${kpi.bindingId ?? "unbound"}`;
}

function byNewestObservation(left: ProductionKpiStatus, right: ProductionKpiStatus): number {
  const leftPeriod = validTimestamp(left.periodEnd) ?? Number.NEGATIVE_INFINITY;
  const rightPeriod = validTimestamp(right.periodEnd) ?? Number.NEGATIVE_INFINITY;
  if (leftPeriod !== rightPeriod) return rightPeriod - leftPeriod;
  const leftObserved = validTimestamp(left.observedAt) ?? Number.NEGATIVE_INFINITY;
  const rightObserved = validTimestamp(right.observedAt) ?? Number.NEGATIVE_INFINITY;
  return rightObserved - leftObserved;
}

export function shapeProductionDashboardKpis({
  kpis,
  locationId,
  section,
  period,
}: {
  kpis: ReadonlyArray<ProductionKpiStatus>;
  locationId: string | null;
  section: ProductionKpiStatus["section"];
  period: string | null;
}): ProductionDashboardKpi[] {
  const groups = new Map<string, ProductionKpiStatus[]>();
  for (const kpi of kpis) {
    if (kpi.section !== section || !isScopedToLocation(kpi, locationId)) continue;
    const key = identity(kpi);
    groups.set(key, [...(groups.get(key) ?? []), kpi]);
  }

  return Array.from(groups.values()).map((group) => {
    const sorted = [...group].sort(byNewestObservation);
    const selected = period
      ? sorted.find((kpi) => productionPeriodKey(kpi.periodEnd) === period && kpi.value !== null)
      : sorted.find((kpi) => kpi.value !== null);
    const base = selected ?? sorted[0];
    if (selected || !period) return { ...base, periodAvailable: base.value !== null };

    const latestPeriod = productionPeriodKey(base.periodEnd);
    const selectedLabel = formatProductionPeriod(`${period}T00:00:00.000Z`);
    const unavailable: ProductionDashboardKpi = {
      ...base,
      value: null,
      priorValue: null,
      periodEnd: `${period}T00:00:00.000Z`,
      observedAt: null,
      confidence: "unknown",
      health: "unavailable",
      sourceStatus: latestPeriod
        ? `No governed observation is available for ${selectedLabel}. Latest loaded period: ${formatProductionPeriod(base.periodEnd)}.`
        : `No governed observation is available for ${selectedLabel}. ${base.sourceStatus}`,
      periodAvailable: false,
    };
    return unavailable;
  }).sort((left, right) => left.title.localeCompare(right.title) || left.locationName.localeCompare(right.locationName));
}

export function formatProductionValue(
  value: number | null,
  kind: ProductionKpiStatus["valueKind"],
  percentValueScale: ProductionKpiStatus["percentValueScale"] = "whole",
): string {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  if (kind === "currency") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: Math.abs(value) >= 1_000 ? 0 : 2,
    }).format(value);
  }
  if (kind === "percent") {
    const displayValue = percentValueScale === "ratio" ? value * 100 : value;
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(displayValue)}%`;
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: kind === "ratio" ? 2 : 0 }).format(value);
}

export function getProductionSparklinePoints(
  kpi: Pick<ProductionKpiStatus, "value" | "priorValue" | "valueKind" | "percentValueScale">,
): string | null {
  if (kpi.value === null || !Number.isFinite(kpi.value)) return null;
  const normalize = (value: number) =>
    kpi.valueKind === "percent" && kpi.percentValueScale === "ratio" ? value * 100 : value;
  const currentValue = normalize(kpi.value);
  const priorValue = kpi.priorValue === null || !Number.isFinite(kpi.priorValue)
    ? currentValue
    : normalize(kpi.priorValue);
  const values = [priorValue, currentValue];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  return values.map((value, index) => `${index * 120},${32 - ((value - min) / range) * 27}`).join(" ");
}

export interface ProductionPriorTrend {
  direction: "up" | "down" | "flat";
  percentage: number | null;
  priorLabel: string;
  changeLabel: string;
}

export function getProductionPriorTrend(kpi: Pick<ProductionKpiStatus, "value" | "priorValue" | "valueKind" | "percentValueScale">): ProductionPriorTrend | null {
  if (kpi.value === null || kpi.priorValue === null || !Number.isFinite(kpi.value) || !Number.isFinite(kpi.priorValue)) return null;
  const difference = kpi.value - kpi.priorValue;
  const percentage = kpi.priorValue === 0 ? null : (difference / Math.abs(kpi.priorValue)) * 100;
  return {
    direction: difference > 0 ? "up" : difference < 0 ? "down" : "flat",
    percentage,
    priorLabel: formatProductionValue(kpi.priorValue, kpi.valueKind, kpi.percentValueScale),
    changeLabel: percentage === null
      ? `${difference > 0 ? "+" : ""}${formatProductionValue(difference, kpi.valueKind, kpi.percentValueScale)} vs prior`
      : `${percentage > 0 ? "+" : ""}${percentage.toFixed(1)}% vs prior`,
  };
}

export const PRODUCTION_HEALTH_COPY: Record<ProductionKpiStatus["health"], string> = {
  current: "Current",
  stale: "Stale",
  unavailable: "Unavailable",
};

export function getProductionFreshness(kpi: ProductionKpiStatus): string {
  if (kpi.value === null || !kpi.observedAt || !kpi.periodEnd) return kpi.sourceStatus;
  return `Period ended ${formatProductionPeriod(kpi.periodEnd)} · observed ${formatProductionDateTime(kpi.observedAt)} · ${kpi.confidence} confidence`;
}

function csvCell(value: string): string {
  const safeValue = /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safeValue) ? `"${safeValue.replace(/"/g, '""')}"` : safeValue;
}

export function createProductionDashboardCsv(rows: ReadonlyArray<ProductionDashboardKpi>): string {
  const headers = ["KPI", "Location", "Actual", "Prior", "Vs prior", "Period ended", "Observed", "Source", "Confidence", "Status", "Source status"];
  const body = rows.map((kpi) => {
    const trend = getProductionPriorTrend(kpi);
    return [
      kpi.title,
      kpi.locationName,
      formatProductionValue(kpi.value, kpi.valueKind, kpi.percentValueScale),
      kpi.priorValue === null ? "Unavailable" : formatProductionValue(kpi.priorValue, kpi.valueKind, kpi.percentValueScale),
      trend?.changeLabel ?? "Unavailable",
      formatProductionPeriod(kpi.periodEnd),
      formatProductionDateTime(kpi.observedAt),
      kpi.sourceSystem,
      kpi.confidence,
      PRODUCTION_HEALTH_COPY[kpi.health],
      kpi.sourceStatus,
    ];
  });
  return [headers, ...body].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function productionDashboardExportFilename({
  organizationSlug,
  locationKey,
  section,
  period,
}: {
  organizationSlug: string;
  locationKey: string;
  section: ProductionKpiStatus["section"];
  period: string | null;
}): string {
  const safe = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
  return `gm-intelligence-${safe(organizationSlug)}-${safe(locationKey)}-${section}-${safe(period ?? "no-observed-period")}.csv`;
}
