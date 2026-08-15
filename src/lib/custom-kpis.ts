import type { CustomMetricInput, Metric, MetricKind, MetricSection, SourceKey } from "./types";

export const CUSTOM_KPI_STORAGE_KEY = "gmib.custom-kpis.v2";
export const LEGACY_CUSTOM_KPI_STORAGE_KEY = "gmib.custom-metrics.v1";

export type CustomKpiType = "catalog" | "derived" | "manual" | "external";
export type CustomKpiStatus = "draft" | "published" | "archived";
export type CustomKpiDirection = "higher" | "lower" | "informational";
export type CustomKpiScopeMode = "portfolio" | "selected-locations";
export type FormulaOperation = "add" | "subtract" | "multiply" | "divide" | "percent";
export type ExternalProvider = "Domo" | "GA4" | "Google Business Profile" | "Call System" | "Finance" | "Other";
export type CustomKpiStep = "definition" | "scope" | "source" | "calculation" | "validate" | "publish";

export interface ValidationIssue {
  code: string;
  step: CustomKpiStep;
  severity: "error" | "warning";
  message: string;
}

export interface ValidationCheck {
  id: string;
  label: string;
  status: "pass" | "warning" | "fail";
  detail: string;
}

export interface CustomKpiDefinition {
  id: string;
  key: string;
  type: CustomKpiType;
  status: CustomKpiStatus;
  version: number;
  title: string;
  definition: string;
  owner: string;
  section: MetricSection;
  kind: MetricKind;
  direction: CustomKpiDirection;
  subtitle: string;
  scopeMode: CustomKpiScopeMode;
  locationIds: string[];
  roles: string[];
  catalogMetricId?: string;
  provider?: ExternalProvider;
  externalDatasetId?: string;
  externalMetricKey?: string;
  refreshCadence?: "daily" | "weekly" | "monthly" | "ad-hoc";
  staleAfterHours?: number;
  leftMetricId?: string;
  operation?: FormulaOperation;
  rightMetricId?: string;
  manualValue?: number;
  priorValue?: number;
  asOf?: string;
  goal?: number;
  warningAt?: number;
  templateIds: string[];
  releaseNote: string;
  validationChecks: ValidationCheck[];
  validatedAt?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  migratedFromLegacy?: boolean;
}

export interface CustomKpiStore {
  schemaVersion: 2;
  definitions: CustomKpiDefinition[];
  migratedAt?: string;
}

export interface EvaluatedCustomKpi {
  state: "available" | "unavailable";
  value?: number;
  prior?: number;
  sparkline: number[];
  source: SourceKey;
  lineage: string[];
  reason?: string;
  warning?: string;
}

export const wizardSteps: { id: CustomKpiStep; label: string }[] = [
  { id: "definition", label: "Definition" },
  { id: "scope", label: "Scope" },
  { id: "source", label: "Data source" },
  { id: "calculation", label: "Calculation" },
  { id: "validate", label: "Validate" },
  { id: "publish", label: "Publish" },
];

export function createKpiId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  return typeof randomUuid === "function"
    ? `custom-${randomUuid.call(globalThis.crypto)}`
    : `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function slugifyKpiKey(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 54);
}

export function createCustomKpiDraft(id: string, now: string): CustomKpiDefinition {
  return {
    id,
    key: "",
    type: "catalog",
    status: "draft",
    version: 1,
    title: "",
    definition: "",
    owner: "",
    section: "executive",
    kind: "number",
    direction: "higher",
    subtitle: "",
    scopeMode: "portfolio",
    locationIds: [],
    roles: ["general-manager"],
    refreshCadence: "monthly",
    staleAfterHours: 744,
    templateIds: ["gm-daily"],
    releaseNote: "",
    validationChecks: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function duplicateCustomKpiDefinition(
  definition: CustomKpiDefinition,
  id: string,
  now: string,
): CustomKpiDefinition {
  const suffix = id.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase();
  return {
    ...definition,
    id,
    key: slugifyKpiKey(`copy-${suffix}-${definition.key}`),
    title: `${definition.title} copy`,
    status: "draft",
    version: 1,
    locationIds: [...definition.locationIds],
    roles: [...definition.roles],
    templateIds: [...definition.templateIds],
    publishedAt: undefined,
    validatedAt: undefined,
    validationChecks: [],
    releaseNote: "",
    createdAt: now,
    updatedAt: now,
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function applyOperation(left: number, operation: FormulaOperation, right: number): number | undefined {
  if ((operation === "divide" || operation === "percent") && right === 0) return undefined;
  if (operation === "add") return left + right;
  if (operation === "subtract") return left - right;
  if (operation === "multiply") return left * right;
  if (operation === "divide") return left / right;
  return (left / right) * 100;
}

function providerToSource(provider?: ExternalProvider): SourceKey {
  if (provider === "Domo") return "Domo";
  if (provider === "GA4") return "GA4";
  if (provider === "Call System") return "Call System";
  if (provider === "Finance") return "Budget";
  return "Custom";
}

export function evaluateCustomKpis(definitions: CustomKpiDefinition[], coreMetrics: Metric[]): Map<string, EvaluatedCustomKpi> {
  const core = new Map(coreMetrics.map((metric) => [metric.id, metric]));
  const custom = new Map(definitions.map((definition) => [definition.id, definition]));
  const cache = new Map<string, EvaluatedCustomKpi>();

  function resolve(metricId: string, stack: string[]): EvaluatedCustomKpi {
    const coreMetric = core.get(metricId);
    if (coreMetric) return { state: "available", value: coreMetric.actual, prior: coreMetric.prior, sparkline: coreMetric.sparkline, source: coreMetric.source, lineage: [coreMetric.title] };
    const cached = cache.get(metricId);
    if (cached) return cached;
    const definition = custom.get(metricId);
    if (!definition || definition.status === "archived") return { state: "unavailable", sparkline: [], source: "Custom", lineage: [], reason: "Referenced KPI is unavailable" };
    if (stack.includes(metricId)) return { state: "unavailable", sparkline: [], source: "Derived", lineage: [], reason: "Circular KPI dependency" };

    let result: EvaluatedCustomKpi;
    if (definition.type === "catalog") {
      const base = definition.catalogMetricId ? resolve(definition.catalogMetricId, [...stack, metricId]) : undefined;
      result = base ?? { state: "unavailable", sparkline: [], source: "Custom", lineage: [], reason: "Choose a governed KPI" };
    } else if (definition.type === "derived") {
      if (!definition.leftMetricId || !definition.rightMetricId || !definition.operation) {
        result = { state: "unavailable", sparkline: [], source: "Derived", lineage: [], reason: "Formula is incomplete" };
      } else {
        const left = resolve(definition.leftMetricId, [...stack, metricId]);
        const right = resolve(definition.rightMetricId, [...stack, metricId]);
        if (left.state !== "available" || right.state !== "available" || left.value === undefined || right.value === undefined) {
          result = { state: "unavailable", sparkline: [], source: "Derived", lineage: [...left.lineage, ...right.lineage], reason: left.reason ?? right.reason ?? "Formula input is unavailable" };
        } else {
          const value = applyOperation(left.value, definition.operation, right.value);
          const prior = left.prior !== undefined && right.prior !== undefined ? applyOperation(left.prior, definition.operation, right.prior) : undefined;
          const count = Math.min(left.sparkline.length, right.sparkline.length);
          const sparkline = Array.from({ length: count }, (_, index) => applyOperation(left.sparkline[index], definition.operation!, right.sparkline[index])).filter((item): item is number => item !== undefined && Number.isFinite(item));
          result = value === undefined || !Number.isFinite(value)
            ? { state: "unavailable", sparkline: [], source: "Derived", lineage: [...left.lineage, ...right.lineage], reason: "Formula returned an unavailable value" }
            : { state: "available", value, prior, sparkline, source: "Derived", lineage: [...left.lineage, ...right.lineage] };
        }
      }
    } else if (definition.type === "manual") {
      result = finite(definition.manualValue)
        ? { state: "available", value: definition.manualValue, prior: definition.priorValue, sparkline: [definition.priorValue, definition.manualValue].filter(finite), source: "Custom", lineage: ["Manual observation"], warning: "Manually maintained" }
        : { state: "unavailable", sparkline: [], source: "Custom", lineage: ["Manual observation"], reason: "No manual observation" };
    } else {
      result = finite(definition.manualValue)
        ? { state: "available", value: definition.manualValue, prior: definition.priorValue, sparkline: [definition.priorValue, definition.manualValue].filter(finite), source: providerToSource(definition.provider), lineage: [definition.provider ?? "External source", "Manual demo snapshot"], warning: "External connector not active · manual demo snapshot" }
        : { state: "unavailable", sparkline: [], source: providerToSource(definition.provider), lineage: [definition.provider ?? "External source"], reason: "External connector is not active" };
    }
    cache.set(metricId, result);
    return result;
  }

  definitions.forEach((definition) => resolve(definition.id, []));
  return cache;
}

export function customKpiToMetric(definition: CustomKpiDefinition, evaluation: EvaluatedCustomKpi): Metric | null {
  if (definition.status !== "published" || evaluation.state !== "available" || evaluation.value === undefined) return null;
  return {
    id: definition.id,
    section: definition.section,
    title: definition.title,
    actual: evaluation.value,
    goal: definition.goal,
    prior: evaluation.prior,
    kind: definition.kind,
    source: evaluation.source,
    subtitle: evaluation.warning ?? definition.subtitle,
    direction: definition.direction === "informational" ? undefined : definition.direction,
    warningAt: definition.warningAt,
    sparkline: evaluation.sparkline.length ? evaluation.sparkline : [evaluation.value],
  };
}

export function validateCustomKpiStep(definition: CustomKpiDefinition, step: CustomKpiStep, catalog: Metric[], allDefinitions: CustomKpiDefinition[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: string, severity: "error" | "warning", message: string) => issues.push({ code, step, severity, message });
  if (step === "definition") {
    if (definition.title.trim().length < 3) add("title", "error", "Enter a KPI name with at least 3 characters.");
    if (!/^[a-z0-9][a-z0-9-]{2,54}$/.test(definition.key)) add("key", "error", "Use a unique lowercase KPI key with letters, numbers, and hyphens.");
    if (catalog.some((metric) => metric.id === definition.key) || allDefinitions.some((item) => item.id !== definition.id && item.key === definition.key && item.status !== "archived")) add("duplicate-key", "error", "That KPI key is already in use.");
    if (definition.definition.trim().length < 12) add("definition", "error", "Write a clear business definition with at least 12 characters.");
    if (!definition.owner.trim()) add("owner", "error", "Assign a definition owner.");
    if (!definition.subtitle.trim()) add("subtitle", "error", "Add a concise supporting label for the card.");
  }
  if (step === "scope") {
    if (definition.scopeMode === "selected-locations" && definition.locationIds.length === 0) add("locations", "error", "Select at least one location.");
    if (definition.roles.length === 0) add("roles", "error", "Select at least one role that can view this KPI.");
  }
  if (step === "source") {
    if (definition.type === "catalog" && !definition.catalogMetricId) add("catalog-source", "error", "Choose the governed KPI this variant inherits.");
    if (definition.type === "external") {
      if (!definition.provider) add("provider", "error", "Choose an external provider.");
      if (definition.provider === "Domo" && !definition.externalDatasetId?.trim()) add("domo-dataset", "error", "Enter the Domo dataset ID; the server allowlist will be enforced during ingestion.");
      if (!definition.externalMetricKey?.trim()) add("external-key", "error", "Enter the external metric or event key.");
      add("external-demo", "warning", definition.provider === "Domo" ? "The Domo connector framework is installed; this test build still uses a clearly labeled manual KPI snapshot until field mapping and materialization are enabled." : "The connector is not active; this test build will use a clearly labeled manual snapshot.");
    }
    if (definition.type === "manual" && !definition.refreshCadence) add("cadence", "error", "Choose how often the value must be updated.");
  }
  if (step === "calculation") {
    if (definition.type === "derived") {
      if (!definition.leftMetricId || !definition.rightMetricId || !definition.operation) add("formula", "error", "Complete both formula inputs and the operation.");
      if (definition.leftMetricId === definition.id || definition.rightMetricId === definition.id) add("self-reference", "error", "A KPI cannot reference itself.");
    }
    if ((definition.type === "manual" || definition.type === "external") && !finite(definition.manualValue)) add("manual-value", "error", "Enter a finite prototype observation.");
    if ((definition.type === "manual" || definition.type === "external") && !definition.asOf) add("as-of", "error", "Enter the observation date.");
    if (definition.goal !== undefined && !finite(definition.goal)) add("goal", "error", "Target must be a finite number.");
    if (definition.goal === 0) add("zero-goal", "warning", "A zero target is treated as informational because attainment cannot be calculated safely.");
  }
  if (step === "validate") {
    const evaluation = evaluateCustomKpis([...allDefinitions.filter((item) => item.id !== definition.id), definition], catalog).get(definition.id);
    if (!evaluation || evaluation.state === "unavailable") add("preview", "error", evaluation?.reason ?? "The KPI could not be evaluated.");
    if (evaluation?.warning) add("lineage-warning", "warning", evaluation.warning);
  }
  if (step === "publish") {
    if (definition.templateIds.length === 0) add("templates", "error", "Assign the KPI to at least one role template.");
    if (definition.releaseNote.trim().length < 5) add("release-note", "error", "Add a short publication reason or release note.");
  }
  return issues;
}

export function runCustomKpiValidation(definition: CustomKpiDefinition, catalog: Metric[], allDefinitions: CustomKpiDefinition[]): { checks: ValidationCheck[]; issues: ValidationIssue[] } {
  const steps: CustomKpiStep[] = ["definition", "scope", "source", "calculation", "validate"];
  const issues = steps.flatMap((step) => validateCustomKpiStep(definition, step, catalog, allDefinitions));
  const groups: { id: string; label: string; steps: CustomKpiStep[]; pass: string }[] = [
    { id: "definition", label: "Definition completeness", steps: ["definition"], pass: "Name, key, owner, format, and business definition are complete." },
    { id: "scope", label: "Scope coverage", steps: ["scope"], pass: "Location scope and viewing roles are valid." },
    { id: "source", label: "Source readiness", steps: ["source"], pass: "Source lineage and refresh expectations are configured." },
    { id: "formula", label: "Calculation execution", steps: ["calculation", "validate"], pass: "The calculation produced an available, finite preview value." },
  ];
  const checks = groups.map((group) => {
    const related = issues.filter((issue) => group.steps.includes(issue.step));
    const failed = related.find((issue) => issue.severity === "error");
    const warning = related.find((issue) => issue.severity === "warning");
    return failed
      ? { id: group.id, label: group.label, status: "fail" as const, detail: failed.message }
      : warning
        ? { id: group.id, label: group.label, status: "warning" as const, detail: warning.message }
        : { id: group.id, label: group.label, status: "pass" as const, detail: group.pass };
  });
  return { checks, issues };
}

function legacyToDefinition(metric: CustomMetricInput, now: string): CustomKpiDefinition | null {
  if (!metric || typeof metric.id !== "string" || typeof metric.title !== "string" || !finite(metric.actual)) return null;
  return {
    ...createCustomKpiDraft(metric.id, now),
    key: slugifyKpiKey(metric.title) || metric.id,
    type: "manual",
    status: "published",
    title: metric.title,
    definition: `Legacy browser-local KPI migrated from the original prototype: ${metric.title}.`,
    owner: "Needs review",
    section: metric.section,
    kind: metric.kind,
    subtitle: metric.subtitle || "Migrated manual observation",
    manualValue: metric.actual,
    goal: finite(metric.goal) ? metric.goal : undefined,
    asOf: now.slice(0, 10),
    releaseNote: "Migrated from custom KPI prototype",
    publishedAt: now,
    migratedFromLegacy: true,
  };
}

export function normalizeCustomKpiStore(value: unknown): CustomKpiStore {
  if (!value || typeof value !== "object") return { schemaVersion: 2, definitions: [] };
  const candidate = value as Partial<CustomKpiStore>;
  if (candidate.schemaVersion !== 2 || !Array.isArray(candidate.definitions)) return { schemaVersion: 2, definitions: [] };
  return { schemaVersion: 2, definitions: candidate.definitions.filter((item): item is CustomKpiDefinition => Boolean(item && typeof item.id === "string" && typeof item.title === "string" && typeof item.status === "string")), migratedAt: candidate.migratedAt };
}

export function readCustomKpiStore(storage: Pick<Storage, "getItem" | "setItem">, now: string): CustomKpiStore {
  const current = storage.getItem(CUSTOM_KPI_STORAGE_KEY);
  if (current !== null) {
    try { return normalizeCustomKpiStore(JSON.parse(current)); } catch { return { schemaVersion: 2, definitions: [] }; }
  }
  let definitions: CustomKpiDefinition[] = [];
  const legacy = storage.getItem(LEGACY_CUSTOM_KPI_STORAGE_KEY);
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy);
      if (Array.isArray(parsed)) definitions = parsed.map((item) => legacyToDefinition(item as CustomMetricInput, now)).filter((item): item is CustomKpiDefinition => Boolean(item));
    } catch { /* malformed legacy data is ignored */ }
  }
  const migrated = { schemaVersion: 2 as const, definitions, migratedAt: now };
  storage.setItem(CUSTOM_KPI_STORAGE_KEY, JSON.stringify(migrated));
  return migrated;
}

export function writeCustomKpiStore(storage: Pick<Storage, "setItem">, store: CustomKpiStore): void {
  storage.setItem(CUSTOM_KPI_STORAGE_KEY, JSON.stringify(store));
}
