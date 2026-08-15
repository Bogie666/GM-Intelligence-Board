import type { Metric } from "./types";

/**
 * Browser-local persistence for target administration. The records deliberately
 * use ids, statuses, versions, effective periods, and ownership fields so they
 * can move to relational tables without changing the domain API.
 */
export const TARGET_BUDGET_STORAGE_KEY = "gmib.target-budget.v1";
export const TARGETS_STORAGE_KEY = TARGET_BUDGET_STORAGE_KEY;
export const TARGET_STORE_SCHEMA_VERSION = 1 as const;
export const PORTFOLIO_LOCATION_ID = "*" as const;
export const DEMO_AS_OF_DATE = "2026-08-15";
export const DEMO_FISCAL_MONTH = "2026-08";

export type TargetTrade = "all" | "hvac" | "plumbing" | "electrical";
export type TargetServiceLine = "all" | "service" | "maintenance" | "replacement" | "install";
export type RecordStatus = "draft" | "published" | "archived";
export type RevenueMetricId = "revenue-mtd" | "hvac-revenue" | "plumbing-revenue" | "electrical-revenue";

export interface TargetRule {
  id: string;
  metricId: string;
  /** A location id, `*`, or the backwards-compatible literal `portfolio`. */
  locationId: string;
  trade: TargetTrade;
  serviceLine: TargetServiceLine;
  targetValue: number;
  /** Percentage attainment at which a metric enters the warning band. */
  warningAttainment: number;
  /** Percentage attainment below which a metric is critical. */
  criticalAttainment: number;
  effectiveFrom: string;
  effectiveTo?: string;
  version: number;
  status: RecordStatus;
  owner: string;
  note: string;
  updatedAt: string;
}

export interface BudgetRecord {
  id: string;
  metricId: RevenueMetricId;
  locationId: string;
  trade: TargetTrade;
  fiscalMonth: string;
  amount: number;
  version: number;
  versionName: string;
  status: RecordStatus;
  owner: string;
  updatedAt: string;
}

export interface TargetBudgetStore {
  schemaVersion: typeof TARGET_STORE_SCHEMA_VERSION;
  rules: TargetRule[];
  budgets: BudgetRecord[];
}

export interface TargetValidationIssue {
  code: string;
  field: keyof TargetRule | keyof BudgetRecord | "store";
  message: string;
}

export interface TargetContext {
  source: "target-rule" | "budget";
  id: string;
  /** Explicit aliases make lineage convenient for callers and audit UIs. */
  ruleId?: string;
  budgetId?: string;
  metricId: string;
  locationId: string;
  trade: TargetTrade;
  serviceLine?: TargetServiceLine;
  owner: string;
  updatedAt: string;
  version?: number;
  versionName?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  fiscalMonth?: string;
  warningAttainment?: number;
  criticalAttainment?: number;
}

export type TargetedMetric = Metric & { targetContext?: TargetContext };

export interface TargetResolutionScope {
  trade?: TargetTrade;
  serviceLine?: TargetServiceLine;
}

type ReadStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem" | "removeItem">>;
type WriteStorage = Pick<Storage, "setItem">;

const RATE_METRIC_IDS = new Set(["booking-rate", "hvac-close", "plumbing-close", "hvac-maintenance-close", "club-conversion"]);
const REVENUE_METRIC_IDS = new Set<RevenueMetricId>([
  "revenue-mtd",
  "hvac-revenue",
  "plumbing-revenue",
  "electrical-revenue",
]);
const TRADES = new Set<TargetTrade>(["all", "hvac", "plumbing", "electrical"]);
const SERVICE_LINES = new Set<TargetServiceLine>(["all", "service", "maintenance", "replacement", "install"]);
const STATUSES = new Set<RecordStatus>(["draft", "published", "archived"]);

const seedUpdatedAt = "2026-08-01T00:00:00.000Z";
const seedEffectiveFrom = "2026-01-01";

const seedTargetValues: Record<string, Record<string, number>> = {
  "sierra-abq": { "booking-rate": 72, "hvac-close": 42, "plumbing-close": 45, "hvac-maintenance-close": 62, "club-conversion": 20 },
  "asi-san-diego": { "booking-rate": 76, "hvac-close": 46, "plumbing-close": 49, "hvac-maintenance-close": 65, "club-conversion": 18 },
  "swan-denver": { "booking-rate": 74, "hvac-close": 44, "plumbing-close": 47, "hvac-maintenance-close": 60, "club-conversion": 22 },
};

export const TARGET_METRIC_SCOPES: Record<string, Required<TargetResolutionScope>> = {
  "booking-rate": { trade: "all", serviceLine: "all" },
  "hvac-close": { trade: "hvac", serviceLine: "replacement" },
  "plumbing-close": { trade: "plumbing", serviceLine: "service" },
  "hvac-maintenance-close": { trade: "hvac", serviceLine: "maintenance" },
  "club-conversion": { trade: "all", serviceLine: "maintenance" },
};

const seedBudgetValues: Record<string, Record<RevenueMetricId, number>> = {
  "sierra-abq": { "revenue-mtd": 4_017_538, "hvac-revenue": 3_447_539, "plumbing-revenue": 404_999, "electrical-revenue": 165_000 },
  "asi-san-diego": { "revenue-mtd": 2_972_978, "hvac-revenue": 2_551_179, "plumbing-revenue": 299_699, "electrical-revenue": 122_100 },
  "swan-denver": { "revenue-mtd": 2_450_698, "hvac-revenue": 2_103_999, "plumbing-revenue": 247_049, "electrical-revenue": 99_650 },
};

const metricTrade: Record<RevenueMetricId, TargetTrade> = {
  "revenue-mtd": "all",
  "hvac-revenue": "hvac",
  "plumbing-revenue": "plumbing",
  "electrical-revenue": "electrical",
};

function buildSeedStore(): TargetBudgetStore {
  const rules: TargetRule[] = [];
  for (const [locationId, metrics] of Object.entries(seedTargetValues)) {
    for (const [metricId, targetValue] of Object.entries(metrics)) {
      rules.push({
        id: `target-${locationId}-${metricId}-v1`,
        metricId,
        locationId,
        trade: TARGET_METRIC_SCOPES[metricId]?.trade ?? "all",
        serviceLine: TARGET_METRIC_SCOPES[metricId]?.serviceLine ?? "all",
        targetValue,
        warningAttainment: 90,
        criticalAttainment: 80,
        effectiveFrom: seedEffectiveFrom,
        version: 1,
        status: "published",
        owner: "Operations leadership",
        note: "2026 operating plan",
        updatedAt: seedUpdatedAt,
      });
    }
  }

  const budgets: BudgetRecord[] = [];
  for (const [locationId, metrics] of Object.entries(seedBudgetValues)) {
    for (const [metricId, amount] of Object.entries(metrics) as [RevenueMetricId, number][]) {
      budgets.push({
        id: `budget-${locationId}-${metricId}-2026-08-v1`,
        metricId,
        locationId,
        trade: metricTrade[metricId],
        fiscalMonth: DEMO_FISCAL_MONTH,
        amount,
        version: 1,
        versionName: "FY2026 operating plan v1",
        status: "published",
        owner: "Finance",
        updatedAt: seedUpdatedAt,
      });
    }
  }
  return { schemaVersion: TARGET_STORE_SCHEMA_VERSION, rules, budgets };
}

/** Returns a fresh deep copy; callers cannot mutate the module's seed state. */
export function createSeedTargetBudgetStore(): TargetBudgetStore {
  return buildSeedStore();
}

export const seedTargetBudgetStore = createSeedTargetBudgetStore;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value));
}

function isFiscalMonth(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= 2000 && year <= 9999;
}

function isPortfolio(locationId: string): boolean {
  return locationId === PORTFOLIO_LOCATION_ID || locationId === "portfolio";
}

function periodsOverlap(aFrom: string, aTo: string | undefined, bFrom: string, bTo: string | undefined): boolean {
  return aFrom <= (bTo ?? "9999-12-31") && bFrom <= (aTo ?? "9999-12-31");
}

function previousIsoDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function supersedeTargetRulesForPublication(existingRules: TargetRule[], successor: TargetRule): TargetRule[] {
  return existingRules.map((item) => {
    const sameScope = item.id !== successor.id
      && item.status === "published"
      && item.metricId === successor.metricId
      && item.locationId === successor.locationId
      && item.trade === successor.trade
      && item.serviceLine === successor.serviceLine;
    if (!sameScope || !periodsOverlap(item.effectiveFrom, item.effectiveTo, successor.effectiveFrom, successor.effectiveTo)) return item;
    if (item.effectiveFrom < successor.effectiveFrom) return { ...item, effectiveTo: previousIsoDay(successor.effectiveFrom) };
    return { ...item, status: "archived" as const };
  });
}

function sameActiveRuleScope(a: TargetRule, b: TargetRule): boolean {
  return a.id !== b.id
    && a.status === "published"
    && b.status === "published"
    && a.metricId === b.metricId
    && a.locationId === b.locationId
    && a.trade === b.trade
    && a.serviceLine === b.serviceLine
    && periodsOverlap(a.effectiveFrom, a.effectiveTo, b.effectiveFrom, b.effectiveTo);
}

/** Validate one rule, including conflicts with other non-archived versions. */
export function validateTargetRule(rule: TargetRule, existingRules: TargetRule[] = []): TargetValidationIssue[] {
  const issues: TargetValidationIssue[] = [];
  const add = (code: string, field: TargetValidationIssue["field"], message: string) => issues.push({ code, field, message });

  if (!nonEmpty(rule.id)) add("required-id", "id", "Target rule id is required.");
  if (!nonEmpty(rule.metricId)) add("required-metric", "metricId", "Metric id is required.");
  if (!nonEmpty(rule.locationId)) add("required-location", "locationId", "Choose a location or the portfolio wildcard.");
  if (!TRADES.has(rule.trade)) add("invalid-trade", "trade", "Trade is not supported.");
  if (!SERVICE_LINES.has(rule.serviceLine)) add("invalid-service-line", "serviceLine", "Service line is not supported.");
  if (!finite(rule.targetValue) || rule.targetValue < 0 || rule.targetValue > 1_000_000_000_000) {
    add("target-range", "targetValue", "Target must be a finite number from 0 through 1 trillion.");
  } else if (RATE_METRIC_IDS.has(rule.metricId) && rule.targetValue > 100) {
    add("target-range", "targetValue", "Rate targets must be between 0 and 100.");
  }
  if (!finite(rule.warningAttainment) || rule.warningAttainment < 0 || rule.warningAttainment > 100) {
    add("warning-attainment", "warningAttainment", "Warning attainment must be between 0 and 100.");
  }
  if (!finite(rule.criticalAttainment) || rule.criticalAttainment < 0 || rule.criticalAttainment > 100) {
    add("critical-attainment", "criticalAttainment", "Critical attainment must be between 0 and 100.");
  }
  if (finite(rule.warningAttainment) && finite(rule.criticalAttainment) && rule.criticalAttainment > rule.warningAttainment) {
    add("attainment-order", "criticalAttainment", "Critical attainment cannot exceed warning attainment.");
  }
  if (!isIsoDate(rule.effectiveFrom)) add("effective-from", "effectiveFrom", "Effective from must be a valid YYYY-MM-DD date.");
  if (rule.effectiveTo !== undefined && !isIsoDate(rule.effectiveTo)) add("effective-to", "effectiveTo", "Effective to must be a valid YYYY-MM-DD date.");
  if (isIsoDate(rule.effectiveFrom) && rule.effectiveTo !== undefined && isIsoDate(rule.effectiveTo) && rule.effectiveTo < rule.effectiveFrom) {
    add("effective-order", "effectiveTo", "Effective to cannot be before effective from.");
  }
  if (!Number.isInteger(rule.version) || rule.version < 1) add("version", "version", "Version must be a positive integer.");
  if (!STATUSES.has(rule.status)) add("status", "status", "Status is not supported.");
  if (!nonEmpty(rule.owner)) add("owner", "owner", "An owner is required.");
  if (typeof rule.note !== "string") add("note", "note", "Note must be text.");
  if (!isIsoTimestamp(rule.updatedAt)) add("updated-at", "updatedAt", "Updated at must be a valid timestamp.");
  if (isIsoDate(rule.effectiveFrom) && (rule.effectiveTo === undefined || isIsoDate(rule.effectiveTo)) && existingRules.some((item) => sameActiveRuleScope(rule, item))) {
    add("duplicate-active-scope", "store", "Another active target has the same scope and an overlapping effective period.");
  }
  return issues;
}

function sameActiveBudgetScope(a: BudgetRecord, b: BudgetRecord): boolean {
  return a.id !== b.id
    && a.status !== "archived"
    && b.status !== "archived"
    && a.metricId === b.metricId
    && a.locationId === b.locationId
    && a.trade === b.trade
    && a.fiscalMonth === b.fiscalMonth
    && a.version === b.version;
}

/** Validate one budget, including duplicate active records in one named version. */
export function validateBudgetRecord(record: BudgetRecord, existingRecords: BudgetRecord[] = []): TargetValidationIssue[] {
  const issues: TargetValidationIssue[] = [];
  const add = (code: string, field: TargetValidationIssue["field"], message: string) => issues.push({ code, field, message });

  if (!nonEmpty(record.id)) add("required-id", "id", "Budget id is required.");
  if (!REVENUE_METRIC_IDS.has(record.metricId)) add("budget-metric", "metricId", "Budget metric is not supported.");
  if (!nonEmpty(record.locationId) || isPortfolio(record.locationId)) add("budget-location", "locationId", "Budgets require an exact location.");
  if (!TRADES.has(record.trade)) add("invalid-trade", "trade", "Trade is not supported.");
  if (REVENUE_METRIC_IDS.has(record.metricId) && metricTrade[record.metricId] !== record.trade) {
    add("budget-trade", "trade", "Trade must match the revenue metric.");
  }
  if (!isFiscalMonth(record.fiscalMonth)) add("budget-period", "fiscalMonth", "Fiscal month must be a valid YYYY-MM period.");
  if (!finite(record.amount) || record.amount < 0 || record.amount > 1_000_000_000_000) {
    add("budget-amount", "amount", "Budget amount must be a finite non-negative number up to 1 trillion.");
  }
  if (!Number.isInteger(record.version) || record.version < 1) add("budget-version", "version", "Budget version must be a positive integer.");
  if (!nonEmpty(record.versionName)) add("version-name", "versionName", "Budget version name is required.");
  if (!STATUSES.has(record.status)) add("status", "status", "Status is not supported.");
  if (!nonEmpty(record.owner)) add("owner", "owner", "An owner is required.");
  if (!isIsoTimestamp(record.updatedAt)) add("updated-at", "updatedAt", "Updated at must be a valid timestamp.");
  if (existingRecords.some((item) => sameActiveBudgetScope(record, item))) {
    add("duplicate-budget", "store", "Another active budget has the same location, metric, trade, period, and version.");
  }
  return issues;
}

export function validateTargetBudgetStore(store: TargetBudgetStore): TargetValidationIssue[] {
  const issues: TargetValidationIssue[] = [];
  if (store.schemaVersion !== TARGET_STORE_SCHEMA_VERSION) {
    issues.push({ code: "schema-version", field: "store", message: "Target store schema version is not supported." });
    return issues;
  }
  store.rules.forEach((rule) => issues.push(...validateTargetRule(rule, store.rules)));
  store.budgets.forEach((budget) => issues.push(...validateBudgetRecord(budget, store.budgets)));
  return issues;
}

function isTargetRuleShape(value: unknown): value is TargetRule {
  return Boolean(value && typeof value === "object" && validateTargetRule(value as TargetRule).length === 0);
}

function isBudgetRecordShape(value: unknown): value is BudgetRecord {
  return Boolean(value && typeof value === "object" && validateBudgetRecord(value as BudgetRecord).length === 0);
}

/** Strict normalization avoids allowing malformed local data into target resolution. */
export function normalizeTargetBudgetStore(value: unknown): TargetBudgetStore | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TargetBudgetStore>;
  if (candidate.schemaVersion !== TARGET_STORE_SCHEMA_VERSION || !Array.isArray(candidate.rules) || !Array.isArray(candidate.budgets)) return null;
  if (!candidate.rules.every(isTargetRuleShape) || !candidate.budgets.every(isBudgetRecordShape)) return null;
  const store: TargetBudgetStore = { schemaVersion: TARGET_STORE_SCHEMA_VERSION, rules: candidate.rules, budgets: candidate.budgets };
  return validateTargetBudgetStore(store).length === 0 ? store : null;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof globalThis.localStorage === "undefined" ? undefined : globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Read safely in SSR/private browsing; malformed or obsolete data recovers to seeds. */
export function readTargetBudgetStore(storage: ReadStorage | undefined = browserStorage()): TargetBudgetStore {
  const fallback = createSeedTargetBudgetStore();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(TARGET_BUDGET_STORAGE_KEY);
    if (raw === null) {
      storage.setItem?.(TARGET_BUDGET_STORAGE_KEY, JSON.stringify(fallback));
      return fallback;
    }
    return normalizeTargetBudgetStore(JSON.parse(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Returns false rather than throwing when browser storage is unavailable or full. */
export function writeTargetBudgetStore(store: TargetBudgetStore, storage?: WriteStorage): boolean;
export function writeTargetBudgetStore(storage: WriteStorage, store: TargetBudgetStore): boolean;
export function writeTargetBudgetStore(
  first: TargetBudgetStore | WriteStorage,
  second?: TargetBudgetStore | WriteStorage,
): boolean {
  const store = "schemaVersion" in first ? first : second as TargetBudgetStore;
  const suppliedStorage = ("schemaVersion" in first ? second : first) as WriteStorage | undefined;
  const storage: WriteStorage | undefined = suppliedStorage ?? browserStorage();
  if (!storage || !normalizeTargetBudgetStore(store)) return false;
  try {
    storage.setItem(TARGET_BUDGET_STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

/** Reset to a fresh seeded dataset. It is safe when storage cannot be accessed. */
export function resetTargetBudgetStore(storage: WriteStorage | undefined = browserStorage()): TargetBudgetStore {
  const seeded = createSeedTargetBudgetStore();
  if (storage) {
    try { storage.setItem(TARGET_BUDGET_STORAGE_KEY, JSON.stringify(seeded)); } catch { /* in-memory seed remains usable */ }
  }
  return seeded;
}

// Short aliases make the storage API ergonomic while retaining explicit names.
export const readTargetsStore = readTargetBudgetStore;
export const writeTargetsStore = writeTargetBudgetStore;
export const resetTargetsStore = resetTargetBudgetStore;

function fallbackId(prefix: "target" | "budget"): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === "function") return `${prefix}-${randomUuid.call(globalThis.crypto)}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createTargetRuleId(): string {
  return fallbackId("target");
}

export function createBudgetRecordId(): string {
  return fallbackId("budget");
}

function dateKey(value: string | Date): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (isIsoDate(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function inferredScope(metricId: string): Required<TargetResolutionScope> {
  const governedScope = TARGET_METRIC_SCOPES[metricId];
  if (governedScope) return governedScope;
  const trade: TargetTrade = metricId.startsWith("hvac-")
    ? "hvac"
    : metricId.startsWith("plumbing-")
      ? "plumbing"
      : metricId.startsWith("electrical-")
        ? "electrical"
        : "all";
  return { trade, serviceLine: "all" };
}

function scopeMatches(ruleValue: string, requested: string): boolean {
  return ruleValue === "all" || ruleValue === requested;
}

/**
 * Resolve a published effective rule deterministically. Location specificity is
 * considered first, followed by trade/service-line specificity, then version,
 * update timestamp, and id as a stable final ordering.
 */
export function resolveTargetRule(
  metricId: string,
  locationId: string,
  date: string | Date,
  rules: TargetRule[],
  scope: TargetResolutionScope = inferredScope(metricId),
): TargetRule | undefined {
  const day = dateKey(date);
  if (!day) return undefined;
  const requested = { ...inferredScope(metricId), ...scope };
  return rules
    .filter((rule) => rule.status === "published"
      && rule.metricId === metricId
      && (rule.locationId === locationId || isPortfolio(rule.locationId))
      && scopeMatches(rule.trade, requested.trade)
      && scopeMatches(rule.serviceLine, requested.serviceLine)
      && rule.effectiveFrom <= day
      && (rule.effectiveTo === undefined || rule.effectiveTo >= day))
    .sort((a, b) => {
      const locationDifference = Number(b.locationId === locationId) - Number(a.locationId === locationId);
      if (locationDifference) return locationDifference;
      const aScope = Number(a.trade !== "all") + Number(a.serviceLine !== "all");
      const bScope = Number(b.trade !== "all") + Number(b.serviceLine !== "all");
      if (bScope !== aScope) return bScope - aScope;
      if (b.version !== a.version) return b.version - a.version;
      const updatedDifference = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      if (updatedDifference) return updatedDifference;
      return a.id.localeCompare(b.id);
    })[0];
}

/** Published location+metric budgets only; governed numeric versions win. */
export function resolveBudgetRecord(
  metricId: string,
  locationId: string,
  fiscalMonth: string,
  budgets: BudgetRecord[],
): BudgetRecord | undefined {
  if (!isFiscalMonth(fiscalMonth) || !REVENUE_METRIC_IDS.has(metricId as RevenueMetricId)) return undefined;
  return budgets
    .filter((budget) => budget.status === "published"
      && budget.metricId === metricId
      && budget.locationId === locationId
      && budget.fiscalMonth === fiscalMonth)
    .sort((a, b) => {
      if (b.version !== a.version) return b.version - a.version;
      return a.id.localeCompare(b.id);
    })[0];
}

/** Apply governed goals without mutating either the metrics or domain records. */
export function applyPublishedTargets(
  metrics: Metric[],
  locationId: string,
  date: string | Date,
  rules: TargetRule[],
  budgets: BudgetRecord[],
  fiscalMonth: string,
): TargetedMetric[] {
  return metrics.map((input) => {
    const metric: TargetedMetric = { ...input };
    const budget = resolveBudgetRecord(metric.id, locationId, fiscalMonth, budgets);
    if (budget) {
      return {
        ...metric,
        goal: budget.amount,
        subtitle: `${budget.amount > 0 ? Math.round((metric.actual / budget.amount) * 100) : 0}% of ${budget.fiscalMonth} budget · ${budget.versionName}`,
        targetContext: {
          source: "budget",
          id: budget.id,
          budgetId: budget.id,
          metricId: budget.metricId,
          locationId: budget.locationId,
          trade: budget.trade,
          version: budget.version,
          fiscalMonth: budget.fiscalMonth,
          versionName: budget.versionName,
          owner: budget.owner,
          updatedAt: budget.updatedAt,
        },
      };
    }

    const rule = resolveTargetRule(metric.id, locationId, date, rules);
    if (!rule) return metric;
    return {
      ...metric,
      goal: rule.targetValue,
      warningAt: rule.warningAttainment,
      criticalAt: rule.criticalAttainment,
      targetContext: {
        source: "target-rule",
        id: rule.id,
        ruleId: rule.id,
        metricId: rule.metricId,
        locationId: rule.locationId,
        trade: rule.trade,
        serviceLine: rule.serviceLine,
        version: rule.version,
        effectiveFrom: rule.effectiveFrom,
        effectiveTo: rule.effectiveTo,
        warningAttainment: rule.warningAttainment,
        criticalAttainment: rule.criticalAttainment,
        owner: rule.owner,
        updatedAt: rule.updatedAt,
      },
    };
  });
}
