import type { ProductionKpiBudget, ProductionKpiStatus } from "./tenant-context";

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

/**
 * The authenticated dashboard transport can grow into these fields without making
 * legacy observations look like an MTD/PY contract.  In particular, `priorValue`
 * is deliberately not represented as a comparison here.
 */
export interface ExecutiveScorecardKpi extends ProductionKpiStatus {
  dataHealth?: ProductionKpiStatus["health"];
  observationWindow?: ProductionKpiStatus["observationWindow"];
  observationStart?: string | null;
  observationEnd?: string | null;
  /** The source's stated as-of instant; `observedAt` is accepted for legacy transport compatibility. */
  asOf?: string | null;
  comparisonBasis?: "none" | "prior_year_to_date";
  comparisonValue?: number | null;
  comparisonPeriodStart?: string | null;
  comparisonPeriodEnd?: string | null;
}

/** Published monthly budget transport. This is intentionally separate from KPI observations. */
export type ExecutiveScorecardBudget = ProductionKpiBudget;

export type ExecutivePerformanceStatus = "On Plan" | "Watch" | "Off Plan" | "Not assessed";
export type ExecutiveDataStatus = "Current" | "Stale" | "Unavailable";
export type ExecutiveScorecardCardId =
  | "revenue-mtd"
  | "run-rate-forecast"
  | "repair-volume"
  | "maintenance-volume"
  | "sales-opportunity-volume"
  | "sales-close-rate"
  | "sales-average-ticket"
  | "active-memberships";

export interface ExecutiveScorecardFact {
  label: string;
  value: string;
}

export interface ExecutiveScorecardCard {
  id: ExecutiveScorecardCardId;
  title: string;
  subtitle: string;
  value: number | null;
  valueKind: ProductionKpiStatus["valueKind"];
  percentValueScale: ProductionKpiStatus["percentValueScale"];
  comparisonValue: number | null;
  comparisonLabel: string | null;
  performanceStatus: ExecutivePerformanceStatus;
  dataStatus: ExecutiveDataStatus;
  dataMessage: string;
  periodLabel: string;
  asOf: string | null;
  budgetLineage: string | null;
  facts: ExecutiveScorecardFact[];
  /** The governed source used for opening the existing insight drawer. */
  source: ProductionKpiStatus;
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

const EXECUTIVE_CARD_ORDER: ReadonlyArray<ExecutiveScorecardCardId> = [
  "revenue-mtd",
  "run-rate-forecast",
  "repair-volume",
  "maintenance-volume",
  "sales-opportunity-volume",
  "sales-close-rate",
  "sales-average-ticket",
  "active-memberships",
];

export { EXECUTIVE_CARD_ORDER };

function isFiniteValue(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function executiveDataStatus(health: ProductionKpiStatus["health"]): ExecutiveDataStatus {
  return health === "current" ? "Current" : health === "stale" ? "Stale" : "Unavailable";
}

function unavailableExecutiveSource(kpiKey: string, title: string, message: string): ProductionKpiStatus {
  return {
    bindingId: null, definitionId: null, kpiKey, title, section: "executive", valueKind: "number", percentValueScale: "whole",
    subtitle: message, sourceSystem: "Derived", locationId: null, locationName: "Unavailable", sourceStatus: message,
    value: null, priorValue: null, periodEnd: null, observedAt: null, confidence: "unknown", health: "unavailable",
  };
}

interface SelectedExecutiveSource {
  source: ExecutiveScorecardKpi | null;
  message: string;
}

function sourceAsOf(kpi: ExecutiveScorecardKpi): string | null {
  return kpi.asOf ?? kpi.observedAt;
}

function sourceMatchesPeriod(kpi: ExecutiveScorecardKpi, period: string | null): boolean {
  return period === null || productionPeriodKey(kpi.periodEnd) === period;
}

function selectExecutiveSource({
  kpis,
  keys,
  locationId,
  period,
  needsComparison = false,
  requiredWindow = "mtd" as "mtd" | "trailing" | "today" | "ytd" | null,
}: {
  kpis: ReadonlyArray<ExecutiveScorecardKpi>;
  keys: ReadonlyArray<string>;
  locationId: string | null;
  period: string | null;
  needsComparison?: boolean;
  requiredWindow?: "mtd" | "trailing" | "today" | "ytd" | null;
}): SelectedExecutiveSource {
  const candidates = kpis.filter((kpi) => keys.includes(kpi.kpiKey) && sourceMatchesPeriod(kpi, period));
  const scoped = candidates.filter((kpi) => locationId !== null && kpi.locationId === locationId);
  if (scoped.length === 0) return { source: null, message: "No exact location-scoped governed source is available." };
  const windowed = requiredWindow === null ? scoped : scoped.filter((kpi) => kpi.observationWindow === requiredWindow);
  if (windowed.length === 0) return { source: null, message: `The source does not declare the required ${requiredWindow ?? "governed"} observation window.` };
  const timestamped = windowed.filter((kpi) => validTimestamp(sourceAsOf(kpi)) !== null);
  if (timestamped.length === 0) return { source: null, message: "The source does not declare a valid as-of timestamp." };
  const comparisonReady = needsComparison
    ? timestamped.filter((kpi) => kpi.comparisonBasis === "prior_year_to_date" && isFiniteValue(kpi.comparisonValue)
      && validTimestamp(kpi.comparisonPeriodStart ?? null) !== null && validTimestamp(kpi.comparisonPeriodEnd ?? null) !== null)
    : timestamped;
  if (comparisonReady.length === 0) {
    return { source: null, message: "A governed same-local-date prior-year comparison is unavailable; prior observations are not labeled PY." };
  }
  const selected = [...comparisonReady].sort(byNewestObservation)[0];
  if (!isFiniteValue(selected.value)) return { source: selected, message: "The governed source has no finite observation value." };
  const health = selected.dataHealth ?? selected.health;
  if (health === "unavailable") return { source: selected, message: selected.sourceStatus || "The governed source is unavailable." };
  return { source: selected, message: selected.sourceStatus };
}

function localCalendarElapsedFraction(asOf: string, timeZone: string): number | null {
  const timestamp = validTimestamp(asOf);
  if (timestamp === null) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
    }).formatToParts(new Date(timestamp));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const year = get("year"); const month = get("month"); const day = get("day");
    const hour = get("hour"); const minute = get("minute"); const second = get("second");
    if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return Math.max(0, Math.min(1, (day - 1 + (hour + minute / 60 + second / 3600) / 24) / daysInMonth));
  } catch { return null; }
}

function localPeriodLabel(value: string | null, timeZone: string): string {
  const timestamp = validTimestamp(value);
  if (timestamp === null) return "Local period unavailable";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone }).format(new Date(timestamp));
  } catch { return "Local period unavailable"; }
}

function localIsoDate(asOf: string, timeZone: string): string | null {
  const timestamp = validTimestamp(asOf);
  if (timestamp === null) return null;
  try {
    const values = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(timestamp));
    const get = (type: string) => values.find((part) => part.type === type)?.value;
    const year = get("year"); const month = get("month"); const day = get("day");
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch { return null; }
}

function validBudget(budgets: ReadonlyArray<ExecutiveScorecardBudget>, locationId: string | null, asOf: string | null, timeZone: string): ExecutiveScorecardBudget | null {
  if (locationId === null || !asOf) return null;
  const localDate = localIsoDate(asOf, timeZone);
  if (!localDate) return null;
  const applicable = (budget: ExecutiveScorecardBudget, exactLocation: boolean) => budget.kpiKey === "revenue-mtd"
    && (exactLocation ? budget.locationId === locationId : budget.locationId === null)
    && budget.planningType === "budget" && budget.lifecycle === "published" && isFiniteValue(budget.amount)
    && budget.amount >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(budget.effectiveStart)
    && (budget.effectiveEnd === null || /^\d{4}-\d{2}-\d{2}$/.test(budget.effectiveEnd))
    && budget.effectiveStart <= localDate && (budget.effectiveEnd === null || budget.effectiveEnd >= localDate);
  return budgets.find((budget) => applicable(budget, true)) ?? budgets.find((budget) => applicable(budget, false)) ?? null;
}

function attainmentStatus(actual: number | null, target: number | null): ExecutivePerformanceStatus {
  if (!isFiniteValue(actual) || !isFiniteValue(target) || target <= 0) return "Not assessed";
  const attainment = actual / target;
  return attainment >= 1 ? "On Plan" : attainment >= 0.9 ? "Watch" : "Off Plan";
}

function cardFromSource({
  id, title, subtitle, selected, valueKind, comparison = false, facts = [], periodLabel,
}: {
  id: ExecutiveScorecardCardId; title: string; subtitle: string; selected: SelectedExecutiveSource;
  valueKind: ProductionKpiStatus["valueKind"]; comparison?: boolean; facts?: ExecutiveScorecardFact[]; periodLabel: string;
}): ExecutiveScorecardCard {
  const source = selected.source ?? unavailableExecutiveSource(id, title, selected.message);
  const dataStatus = selected.source && isFiniteValue(selected.source.value)
    ? executiveDataStatus(selected.source.dataHealth ?? selected.source.health) : "Unavailable";
  return {
    id, title, subtitle, value: dataStatus === "Unavailable" ? null : source.value, valueKind,
    percentValueScale: source.percentValueScale, comparisonValue: comparison && dataStatus !== "Unavailable" && selected.source && isFiniteValue(selected.source.comparisonValue) ? selected.source.comparisonValue : null,
    comparisonLabel: comparison && dataStatus !== "Unavailable" ? "vs PY (same local elapsed period)" : null,
    performanceStatus: "Not assessed", dataStatus, dataMessage: selected.message, periodLabel,
    asOf: sourceAsOf(source as ExecutiveScorecardKpi), budgetLineage: null, facts, source,
  };
}

/** Builds the only Executive composition; it never infers budgets or PY from legacy values. */
export function shapeExecutiveScorecard({
  kpis,
  budgets = [],
  locationId,
  timeZone,
  period = null,
}: {
  kpis: ReadonlyArray<ExecutiveScorecardKpi | ProductionKpiStatus>;
  budgets?: ReadonlyArray<ExecutiveScorecardBudget>;
  locationId: string | null;
  timeZone: string;
  period?: string | null;
}): ExecutiveScorecardCard[] {
  const executiveKpis = kpis as ReadonlyArray<ExecutiveScorecardKpi>;
  const revenue = selectExecutiveSource({ kpis: executiveKpis, keys: ["revenue-mtd"], locationId, period });
  const revenueSource = revenue.source;
  const periodLabel = localPeriodLabel(revenueSource?.periodEnd ?? null, timeZone);
  const budget = validBudget(budgets, locationId, revenueSource ? sourceAsOf(revenueSource) : null, timeZone);
  const fraction = revenueSource ? localCalendarElapsedFraction(sourceAsOf(revenueSource) ?? "", timeZone) : null;
  const revenueDataStatus = revenueSource && isFiniteValue(revenueSource.value) ? executiveDataStatus(revenueSource.dataHealth ?? revenueSource.health) : "Unavailable";
  const pacedBudget = budget && fraction !== null ? budget.amount * fraction : null;
  const revenueActual = revenueDataStatus === "Unavailable" ? null : revenueSource?.value ?? null;
  const revenueCard: ExecutiveScorecardCard = {
    ...cardFromSource({ id: "revenue-mtd", title: "Revenue MTD vs Budget", subtitle: "Completed-job revenue on the local MTD completion-date basis.", selected: revenue, valueKind: "currency", periodLabel }),
    value: revenueActual, performanceStatus: attainmentStatus(revenueActual, pacedBudget), budgetLineage: budget?.lineage ?? null,
    facts: [{ label: "Budget pace", value: pacedBudget === null ? "Not published" : formatProductionValue(pacedBudget, "currency") }, { label: "Monthly budget", value: budget ? formatProductionValue(budget.amount, "currency") : "Not published" }],
  };
  const forecast = revenueActual !== null && fraction !== null && fraction > 0 ? revenueActual / fraction : null;
  const forecastDataStatus: ExecutiveDataStatus = revenueDataStatus;
  const forecastMessage = fraction === null || fraction <= 0 ? "A valid local-calendar elapsed fraction is unavailable." : revenue.message;
  const forecastSource = revenueSource ?? unavailableExecutiveSource("run-rate-forecast", "Run-Rate Forecast vs Budget", forecastMessage);
  const forecastCard: ExecutiveScorecardCard = {
    id: "run-rate-forecast", title: "Run-Rate Forecast vs Budget", subtitle: "Revenue MTD ÷ local-calendar elapsed fraction; not a statistical projected close.",
    value: forecastDataStatus === "Unavailable" ? null : forecast, valueKind: "currency", percentValueScale: "whole", comparisonValue: budget?.amount ?? null,
    comparisonLabel: budget ? "monthly budget" : null, performanceStatus: attainmentStatus(forecast, budget?.amount ?? null), dataStatus: forecastDataStatus,
    dataMessage: forecastMessage, periodLabel, asOf: sourceAsOf(forecastSource as ExecutiveScorecardKpi), budgetLineage: budget?.lineage ?? null,
    facts: [{ label: "Elapsed local calendar", value: fraction === null ? "Unavailable" : `${(fraction * 100).toFixed(1)}%` }, { label: "Monthly budget", value: budget ? formatProductionValue(budget.amount, "currency") : "Not published" }], source: forecastSource,
  };
  const repair = cardFromSource({ id: "repair-volume", title: "Repair Volume vs PY", subtitle: "Completed repair jobs, using binding-pinned job-type IDs.", selected: selectExecutiveSource({ kpis: executiveKpis, keys: ["repair-job-volume"], locationId, period, needsComparison: true }), valueKind: "number", comparison: true, periodLabel });
  const maintenanceCard = cardFromSource({ id: "maintenance-volume", title: "Maintenance Job Volume vs PY", subtitle: "Completed maintenance jobs, using binding-pinned job-type IDs.", selected: selectExecutiveSource({ kpis: executiveKpis, keys: ["maintenance-job-volume"], locationId, period, needsComparison: true }), valueKind: "number", comparison: true, periodLabel });
  const opportunity = cardFromSource({ id: "sales-opportunity-volume", title: "Sales Opportunity Volume vs PY", subtitle: "Distinct estimate job opportunities created in the MTD period.", selected: selectExecutiveSource({ kpis: executiveKpis, keys: ["sales-opportunity-volume"], locationId, period, needsComparison: true }), valueKind: "number", comparison: true, periodLabel });
  const close = cardFromSource({ id: "sales-close-rate", title: "Sales Close Rate", subtitle: "Sold opportunity jobs divided by opportunity jobs in the created-period cohort.", selected: selectExecutiveSource({ kpis: executiveKpis, keys: ["sales-close"], locationId, period }), valueKind: "percent", periodLabel });
  const ticket = cardFromSource({ id: "sales-average-ticket", title: "Sales Average Ticket", subtitle: "Sold estimate-record subtotal divided by sold estimate-record count.", selected: selectExecutiveSource({ kpis: executiveKpis, keys: ["sales-average-ticket"], locationId, period }), valueKind: "currency", periodLabel });
  const active = selectExecutiveSource({ kpis: executiveKpis, keys: ["active-members"], locationId, period, requiredWindow: "trailing" });
  const membershipsCard = cardFromSource({ id: "active-memberships", title: "Active Memberships", subtitle: "Current active membership base from the governed membership source.", selected: active, valueKind: "number", periodLabel });
  return [revenueCard, forecastCard, repair, maintenanceCard, opportunity, close, ticket, membershipsCard];
}

export function createExecutiveScorecardCsv(cards: ReadonlyArray<ExecutiveScorecardCard>): string {
  const headers = ["KPI", "Actual", "Comparison", "Comparison basis", "Period", "Performance status", "Data status", "Budget lineage", "Data message", "Formula"];
  const body = cards.map((card) => [card.title, formatProductionValue(card.value, card.valueKind, card.percentValueScale), card.comparisonValue === null ? "Unavailable" : formatProductionValue(card.comparisonValue, card.valueKind, card.percentValueScale), card.comparisonLabel ?? "Not applicable", card.periodLabel, card.performanceStatus, card.dataStatus, card.budgetLineage ?? "Not applicable", card.dataMessage, card.id === "run-rate-forecast" ? "Revenue MTD / local-calendar elapsed fraction" : "Governed source value"]);
  return [headers, ...body].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
