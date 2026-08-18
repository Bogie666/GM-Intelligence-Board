import type { DemoServiceTitanConnection } from "./demo-connections";
import {
  isValidTimestamp,
  refreshOptionsForMethod,
  serviceTitanEndpointRecipes,
  staleHoursForRefresh,
  validateReportParameterValues,
  type ServiceTitanEvidenceStatus,
  type ServiceTitanRefreshInterval,
  type ServiceTitanReportParameterValue,
  type ServiceTitanReportReduction,
  type ServiceTitanReportSource,
  type ServiceTitanSourceMethod,
} from "./service-titan-sources";
import type { CustomMetricInput, LocationConfig, Metric, MetricKind, MetricSection, SourceKey } from "./types";

export const CUSTOM_KPI_STORAGE_KEY = "gmib.custom-kpis.v3";
export const V2_CUSTOM_KPI_STORAGE_KEY = "gmib.custom-kpis.v2";
export const CUSTOM_KPI_SCHEMA_VERSION = 3 as const;
export const LEGACY_CUSTOM_KPI_STORAGE_KEY = "gmib.custom-metrics.v1";

export type CustomKpiType = "catalog" | "derived" | "service-titan" | "manual" | "external";
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

export interface ServiceTitanBindingSampleEvidence {
  rowCount: number;
  computedValue: number;
  status: ServiceTitanEvidenceStatus;
  sampledAt: string;
  sourceFingerprint: string;
}

export interface ServiceTitanBindingReconciliationEvidence {
  expectedValue: number;
  referenceValue?: number;
  tolerance: number;
  delta: number;
  status: ServiceTitanEvidenceStatus;
  reconciledAt: string;
  sourceFingerprint: string;
}

export interface ServiceTitanMaterializedObservation {
  value: number;
  prior?: number;
  asOf: string;
  sourceFingerprint: string;
  sourceVersion: number;
  status: "valid" | "invalid";
}

export interface ServiceTitanTenantBinding {
  tenantId: string;
  connectionId: string;
  timezone: string;
  locationIds?: string[];
  parameterValues?: Record<string, ServiceTitanReportParameterValue>;
  businessUnitMappings?: Record<string, string[]>;
  reportSourceId?: string;
  expectedSchemaFingerprint?: string;
  /** Transitional alias for expectedSchemaFingerprint. */
  reportSchemaFingerprint?: string;
  valueField?: string;
  numeratorField?: string;
  denominatorField?: string;
  approvalStatus?: "draft" | "approved" | "rejected";
  sampleEvidence?: ServiceTitanBindingSampleEvidence;
  reconciliationEvidence?: ServiceTitanBindingReconciliationEvidence;
  observation?: ServiceTitanMaterializedObservation;
  /** Transitional aliases used only while the browser UI migrates to observation. */
  prototypeValue?: number;
  prototypePriorValue?: number;
  prototypeAsOf?: string;
}

export interface ServiceTitanKpiSource {
  method: ServiceTitanSourceMethod;
  refreshInterval: ServiceTitanRefreshInterval;
  endpointRecipeId?: string;
  endpointRecipeVersion?: number;
  reportReduction?: ServiceTitanReportReduction;
  tenantBindings: ServiceTitanTenantBinding[];
}

export interface CustomKpiValidationContext {
  locations?: LocationConfig[];
  connections?: DemoServiceTitanConnection[];
  serviceTitanReports?: ServiceTitanReportSource[];
  tenantId?: string;
  locationId?: string;
  now?: string;
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
  serviceTitanSource?: ServiceTitanKpiSource;
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
  /** Version 2 is accepted only for the current UI transition; persistence is always version 3. */
  schemaVersion: 2 | typeof CUSTOM_KPI_SCHEMA_VERSION;
  definitions: CustomKpiDefinition[];
  migratedAt?: string;
  availability?: "available" | "unavailable";
  unavailableReason?: string;
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
  lastValidObservation?: ServiceTitanMaterializedObservation;
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
  const clone = JSON.parse(JSON.stringify(definition)) as CustomKpiDefinition;
  const serviceTitanSource = clone.serviceTitanSource
    ? {
        ...clone.serviceTitanSource,
        tenantBindings: clone.serviceTitanSource.tenantBindings.map((binding) => {
          const next = { ...binding };
          delete next.observation;
          delete next.sampleEvidence;
          delete next.reconciliationEvidence;
          delete next.prototypeValue;
          delete next.prototypePriorValue;
          delete next.prototypeAsOf;
          return next;
        }),
      }
    : undefined;
  return {
    ...clone,
    id,
    key: slugifyKpiKey(`copy-${suffix}-${definition.key}`),
    title: `${definition.title} copy`,
    status: "draft",
    version: 1,
    serviceTitanSource,
    publishedAt: undefined,
    validatedAt: undefined,
    validationChecks: [],
    releaseNote: "",
    createdAt: now,
    updatedAt: now,
  };
}

export function requiredServiceTitanTenantIds(definition: Pick<CustomKpiDefinition, "scopeMode" | "locationIds">, locations: LocationConfig[]): string[] {
  const scoped = definition.scopeMode === "portfolio"
    ? locations
    : locations.filter((location) => definition.locationIds.includes(location.id));
  return Array.from(new Set(scoped.map((location) => location.tenantId))).sort();
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

function scopedLocations(definition: Pick<CustomKpiDefinition, "scopeMode" | "locationIds">, locations: LocationConfig[] = []): LocationConfig[] {
  return definition.scopeMode === "portfolio" ? locations : locations.filter((location) => definition.locationIds.includes(location.id));
}

function canonicalContractValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalContractValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalContractValue(nested)}`).join(",")}}`;
  return JSON.stringify(value);
}

function base64Url(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = new TextEncoder().encode(value);
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += alphabet[first >> 2];
    encoded += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) encoded += alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    if (third !== undefined) encoded += alphabet[third & 63];
  }
  return encoded;
}

/** Deterministic identity for the complete governed observation contract. */
export function serviceTitanObservationFingerprint(
  source: ServiceTitanKpiSource,
  binding: ServiceTitanTenantBinding,
  report?: ServiceTitanReportSource,
): string | undefined {
  const locationId = binding.locationIds?.length === 1 ? binding.locationIds[0] : undefined;
  const governedSource = source.method === "endpoint-recipe"
    ? { recipeId: source.endpointRecipeId, recipeVersion: source.endpointRecipeVersion }
    : {
      reportSourceId: binding.reportSourceId,
      reportCategoryId: report?.categoryId,
      reportId: report?.reportId,
      reportOwner: report?.owner,
      modifiedOn: report?.modifiedOn,
      parameters: report?.parameters.map(({ name, label, dataType, isArray, isRequired, dynamicSetId }) => ({ name, label, dataType, isArray, isRequired, dynamicSetId })),
      schema: binding.expectedSchemaFingerprint ?? binding.reportSchemaFingerprint,
    };
  if (!locationId || !binding.tenantId || !binding.connectionId
    || (source.method === "endpoint-recipe" && (!source.endpointRecipeId || !source.endpointRecipeVersion))
    || (source.method === "saved-report" && (!binding.reportSourceId || !(binding.expectedSchemaFingerprint ?? binding.reportSchemaFingerprint)))) return undefined;
  return `st-contract-v2.${base64Url(canonicalContractValue({
    tenantId: binding.tenantId,
    locationId,
    connectionId: binding.connectionId,
    method: source.method,
    refreshInterval: source.refreshInterval,
    governedSource,
    parameterValues: binding.parameterValues ?? {},
    businessUnitMappings: binding.businessUnitMappings ?? {},
    reduction: source.reportReduction,
    selectedFields: { value: binding.valueField, numerator: binding.numeratorField, denominator: binding.denominatorField },
  }))}`;
}

/** Creates prototype binding evidence tied to the exact configured saved-report contract. */
export function materializeServiceTitanReportBindingEvidence(
  source: ServiceTitanKpiSource,
  binding: ServiceTitanTenantBinding,
  report: ServiceTitanReportSource | undefined,
): ServiceTitanTenantBinding {
  const next = { ...binding };
  delete next.sampleEvidence;
  delete next.reconciliationEvidence;
  if (source.method !== "saved-report" || !report) return next;
  const sourceFingerprint = serviceTitanObservationFingerprint(source, next, report);
  if (!sourceFingerprint) return next;
  const reportSample = report.sampleEvidence;
  if (reportSample && validSampleEvidence(reportSample)) {
    next.sampleEvidence = {
      rowCount: reportSample.rowCount,
      computedValue: reportSample.computedValue,
      status: reportSample.status,
      sampledAt: reportSample.sampledAt,
      sourceFingerprint,
    };
  }
  const reportReconciliation = report.reconciliationEvidence;
  if (reportReconciliation && validReconciliationEvidence(reportReconciliation)) {
    next.reconciliationEvidence = {
      expectedValue: reportReconciliation.expectedValue,
      ...(reportReconciliation.referenceValue !== undefined ? { referenceValue: reportReconciliation.referenceValue } : {}),
      tolerance: reportReconciliation.tolerance,
      delta: reportReconciliation.delta,
      status: reportReconciliation.status,
      reconciledAt: reportReconciliation.reconciledAt,
      sourceFingerprint,
    };
  }
  return next;
}

function expectedObservationIdentity(
  _definition: Pick<CustomKpiDefinition, "version">,
  source: ServiceTitanKpiSource,
  binding: ServiceTitanTenantBinding,
  report?: ServiceTitanReportSource,
): { fingerprint?: string; version?: number } {
  return {
    fingerprint: serviceTitanObservationFingerprint(source, binding, report),
    version: source.method === "endpoint-recipe"
      ? source.endpointRecipeVersion
      : (report && isValidTimestamp(report.modifiedOn) ? Date.parse(report.modifiedOn) : undefined),
  };
}

function materializedObservation(
  definition: Pick<CustomKpiDefinition, "version">,
  source: ServiceTitanKpiSource,
  binding: ServiceTitanTenantBinding,
  report?: ServiceTitanReportSource,
): ServiceTitanMaterializedObservation | undefined {
  if (binding.observation) return binding.observation;
  if (!finite(binding.prototypeValue) || !isValidTimestamp(binding.prototypeAsOf)) return undefined;
  const identity = expectedObservationIdentity(definition, source, binding, report);
  if (!identity.fingerprint || !Number.isInteger(identity.version) || (identity.version ?? 0) < 1) return undefined;
  return {
    value: binding.prototypeValue,
    ...(finite(binding.prototypePriorValue) ? { prior: binding.prototypePriorValue } : {}),
    asOf: binding.prototypeAsOf,
    sourceFingerprint: identity.fingerprint,
    sourceVersion: identity.version!,
    status: "valid",
  };
}

function validSampleEvidence(
  evidence: { rowCount: number; computedValue: number; status: ServiceTitanEvidenceStatus; sampledAt: string; sourceFingerprint?: string } | undefined,
  expectedFingerprint?: string,
): boolean {
  return Boolean(evidence && Number.isInteger(evidence.rowCount) && evidence.rowCount >= 0 && finite(evidence.computedValue)
    && evidence.status === "pass" && isValidTimestamp(evidence.sampledAt)
    && (expectedFingerprint === undefined || evidence.sourceFingerprint === expectedFingerprint));
}

function validReconciliationEvidence(
  evidence: { expectedValue: number; referenceValue?: number; tolerance: number; delta: number; status: ServiceTitanEvidenceStatus; reconciledAt: string; sourceFingerprint?: string } | undefined,
  expectedFingerprint?: string,
): boolean {
  if (!evidence || !finite(evidence.expectedValue) || !finite(evidence.tolerance) || evidence.tolerance < 0 || !finite(evidence.delta)
    || evidence.status !== "pass" || !isValidTimestamp(evidence.reconciledAt)
    || (expectedFingerprint !== undefined && evidence.sourceFingerprint !== expectedFingerprint)) return false;
  const reference = evidence.referenceValue ?? evidence.expectedValue;
  return finite(reference) && Math.abs(evidence.delta - (evidence.expectedValue - reference)) < 1e-9
    && Math.abs(evidence.delta) <= evidence.tolerance;
}

interface ServiceTitanGateResult {
  binding?: ServiceTitanTenantBinding;
  recipe?: (typeof serviceTitanEndpointRecipes)[number];
  report?: ServiceTitanReportSource;
  observation?: ServiceTitanMaterializedObservation;
  reason?: string;
  lastValidObservation?: ServiceTitanMaterializedObservation;
}

function serviceTitanGate(
  definition: CustomKpiDefinition,
  context: CustomKpiValidationContext,
): ServiceTitanGateResult {
  const source = definition.serviceTitanSource;
  if (!source) return { reason: "ServiceTitan source mapping is incomplete." };
  if (!context.tenantId || !context.locationId) return { reason: "ServiceTitan evaluation requires an exact tenant and location context." };
  if (definition.scopeMode === "selected-locations" && !definition.locationIds.includes(context.locationId)) {
    return { reason: `Location ${context.locationId} is outside this KPI's governed scope.` };
  }
  const location = context.locations?.find((item) => item.id === context.locationId);
  if (location && location.tenantId !== context.tenantId) return { reason: "The selected location does not belong to the requested ServiceTitan tenant." };
  const matchingBindings = source.tenantBindings.filter((item) => item.tenantId === context.tenantId
    && item.locationIds?.length === 1 && item.locationIds[0] === context.locationId);
  if (matchingBindings.length !== 1) {
    return { reason: matchingBindings.length === 0
      ? `No exact ServiceTitan binding exists for tenant ${context.tenantId} and location ${context.locationId}.`
      : `Multiple ServiceTitan bindings exist for tenant ${context.tenantId} and location ${context.locationId}; evaluation failed closed.` };
  }
  const binding = matchingBindings[0];

  const unavailable = (reason: string): ServiceTitanGateResult => ({ binding, reason });
  const connection = context.connections?.find((item) => item.id === binding.connectionId);
  if (!connection) return unavailable(`ServiceTitan connection ${binding.connectionId || "is not selected"} is unavailable.`);
  if (connection.status !== "ready" || connection.tenantId !== binding.tenantId || !connection.locationIds.includes(context.locationId)) {
    return unavailable("The exact ServiceTitan connection is not ready, tenant-matched, and assigned to this location.");
  }

  let recipe: (typeof serviceTitanEndpointRecipes)[number] | undefined;
  let report: ServiceTitanReportSource | undefined;
  if (source.method === "endpoint-recipe") {
    recipe = serviceTitanEndpointRecipes.find((item) => item.id === source.endpointRecipeId && item.version === source.endpointRecipeVersion);
    if (!recipe) return unavailable("The versioned ServiceTitan endpoint recipe is unavailable or changed.");
    if (!connection.capabilities.includes(recipe.capability)) return unavailable(`The ServiceTitan connection lacks the ${recipe.capability} capability required by this recipe.`);
    if (!recipe.allowedRefreshIntervals.includes(source.refreshInterval)) return unavailable("The endpoint recipe does not allow the configured refresh interval.");
  } else {
    report = context.serviceTitanReports?.find((item) => item.id === binding.reportSourceId);
    if (!report || report.connectionId !== binding.connectionId || report.tenantId !== binding.tenantId) {
      return unavailable("The exact tenant and connection saved report is unavailable.");
    }
    if (report.lifecycle !== "approved" || report.status !== "active") return unavailable("The saved report is not active and approved.");
    if (!refreshOptionsForMethod("saved-report").some((option) => option.id === source.refreshInterval)) return unavailable("Saved reports may refresh only every 4, 12, or 24 hours.");
    const fingerprint = binding.expectedSchemaFingerprint ?? binding.reportSchemaFingerprint;
    if (!fingerprint || report.expectedSchemaFingerprint !== fingerprint || report.observedSchemaFingerprint !== fingerprint || report.schemaFingerprint !== fingerprint) {
      return unavailable("The saved report schema does not match its approved binding fingerprint.");
    }
    if (!validSampleEvidence(report.sampleEvidence)) return unavailable("The saved report does not have passing sample evidence.");
    if (!validReconciliationEvidence(report.reconciliationEvidence)) return unavailable("The saved report does not have passing reconciliation evidence.");
    const parameterIssues = validateReportParameterValues(report.parameters, binding.parameterValues ?? {});
    if (parameterIssues.length) return unavailable(parameterIssues[0]);
    const businessUnitParameters = report.parameters.filter((parameter) => parameter.dynamicSetId === "business-units");
    for (const parameter of businessUnitParameters) {
      const mappings = binding.businessUnitMappings;
      const mapped = mappings?.[context.locationId];
      if (!mappings || Object.keys(mappings).length !== 1 || !mapped?.length || new Set(mapped).size !== mapped.length) {
        return unavailable("The saved report requires one unambiguous business-unit mapping for the exact location.");
      }
      const supplied = binding.parameterValues?.[parameter.name];
      if (!Array.isArray(supplied) || supplied.length !== mapped.length
        || [...supplied].map(String).sort().some((value, index) => value !== [...mapped].sort()[index])) {
        return unavailable(`Report parameter ${parameter.name} must use exactly the mapped business units for this location.`);
      }
    }
    const numericFields = new Set(report.fields.filter((field) => field.type === "number").map((field) => field.name));
    if (!source.reportReduction) return unavailable("The saved report reduction is not configured.");
    if (source.reportReduction !== "count" && source.reportReduction !== "ratio" && (!binding.valueField || !numericFields.has(binding.valueField))) {
      return unavailable("The saved report value field is not a current numeric field.");
    }
    if (source.reportReduction === "ratio" && (!binding.numeratorField || !binding.denominatorField
      || binding.numeratorField === binding.denominatorField || !numericFields.has(binding.numeratorField) || !numericFields.has(binding.denominatorField))) {
      return unavailable("Saved-report ratio fields must be distinct current numeric fields.");
    }
    const bindingFingerprint = serviceTitanObservationFingerprint(source, binding, report);
    if (!bindingFingerprint) return unavailable("The saved-report KPI binding contract is incomplete.");
    if (binding.approvalStatus !== "approved") return unavailable("The saved-report KPI binding is not approved.");
    if (!validSampleEvidence(binding.sampleEvidence, bindingFingerprint)) return unavailable("The saved-report KPI binding needs passing sample evidence for this exact source contract.");
    if (!validReconciliationEvidence(binding.reconciliationEvidence, bindingFingerprint)) return unavailable("The saved-report KPI binding needs passing reconciliation evidence for this exact source contract.");
  }

  const observation = materializedObservation(definition, source, binding, report);
  if (!observation) return unavailable(`No materialized observation exists for tenant ${binding.tenantId} and location ${context.locationId}.`);
  if (!finite(observation.value) || (observation.prior !== undefined && !finite(observation.prior))) return { binding, recipe, report, reason: "The ServiceTitan observation is not finite." };
  if (observation.status !== "valid") return { binding, recipe, report, reason: "The ServiceTitan observation is marked invalid." };
  if (!isValidTimestamp(observation.asOf)) return { binding, recipe, report, reason: "The ServiceTitan observation timestamp is invalid." };
  const identity = expectedObservationIdentity(definition, source, binding, report);
  if (observation.sourceFingerprint !== identity.fingerprint || observation.sourceVersion !== identity.version) {
    return { binding, recipe, report, observation, reason: "The observation source fingerprint or version no longer matches the governed source." };
  }
  const evaluationTime = context.now ?? new Date().toISOString();
  if (!isValidTimestamp(evaluationTime)) return { binding, recipe, report, observation, reason: "The evaluation time is invalid." };
  const observedAt = Date.parse(observation.asOf);
  const evaluatedAt = Date.parse(evaluationTime);
  if (observedAt > evaluatedAt) return { binding, recipe, report, observation, reason: "The ServiceTitan observation timestamp is in the future." };
  const staleHours = staleHoursForRefresh(source.refreshInterval);
  if (staleHours === undefined || evaluatedAt - observedAt > staleHours * 60 * 60 * 1000) {
    return { binding, recipe, report, observation, reason: "The ServiceTitan observation is stale for its refresh cadence.", lastValidObservation: observation };
  }
  return { binding, recipe, report, observation };
}

export function evaluateCustomKpis(
  definitions: CustomKpiDefinition[],
  coreMetrics: Metric[],
  context: CustomKpiValidationContext = {},
): Map<string, EvaluatedCustomKpi> {
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
    } else if (definition.type === "service-titan") {
      const gate = serviceTitanGate(definition, context);
      if (gate.reason || !gate.binding || !gate.observation) {
        result = { state: "unavailable", sparkline: [], source: "ServiceTitan", lineage: ["ServiceTitan"], reason: gate.reason ?? "ServiceTitan source is unavailable.", lastValidObservation: gate.lastValidObservation };
      } else {
        const sourceName = gate.recipe?.name ?? gate.report?.name ?? "Saved report";
        const sourceIdentity = gate.recipe
          ? `${gate.recipe.id}@v${gate.recipe.version}`
          : `${gate.report!.categoryId}/${gate.report!.reportId} · ${gate.report!.expectedSchemaFingerprint}`;
        result = {
          state: "available",
          value: gate.observation.value,
          prior: gate.observation.prior,
          sparkline: [gate.observation.prior, gate.observation.value].filter(finite),
          source: "ServiceTitan",
          lineage: ["ServiceTitan", `${sourceName} · ${sourceIdentity}`, `Tenant ${gate.binding.tenantId}`, `Location ${context.locationId}`, "Materialized observation"],
          warning: gate.binding.observation ? undefined : "ServiceTitan source mapped · transitional prototype observation",
        };
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

export function validateCustomKpiStep(
  definition: CustomKpiDefinition,
  step: CustomKpiStep,
  catalog: Metric[],
  allDefinitions: CustomKpiDefinition[],
  context: CustomKpiValidationContext = {},
): ValidationIssue[] {
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
    if (definition.type === "service-titan") {
      const source = definition.serviceTitanSource;
      const requiredLocations = scopedLocations(definition, context.locations);
      const requiredTenants = Array.from(new Set(requiredLocations.map((location) => location.tenantId))).sort();
      if (!source) {
        add("st-source", "error", "Choose a governed ServiceTitan endpoint recipe or approved saved report.");
      } else {
        const allowedCadences = refreshOptionsForMethod(source.method).map((option) => option.id);
        if (!allowedCadences.includes(source.refreshInterval)) add("st-cadence", "error", source.method === "saved-report" ? "Saved reports may refresh only every 4, 12, or 24 hours." : "Choose an allowed endpoint refresh frequency.");
        const requiredBindings = requiredLocations.map((location) => `${location.tenantId}:${location.id}`);
        const boundLocations = source.tenantBindings.map((binding) => binding.locationIds?.length === 1
          ? `${binding.tenantId}:${binding.locationIds[0]}` : "invalid");
        if (!requiredTenants.length) add("st-scope-context", "error", "No ServiceTitan tenant could be resolved from the selected location scope.");
        if (new Set(boundLocations).size !== boundLocations.length) add("st-duplicate-location", "error", "ServiceTitan bindings may not overlap the same tenant and location.");
        if (requiredBindings.some((identity) => !boundLocations.includes(identity)) || boundLocations.some((identity) => !requiredBindings.includes(identity))) {
          add("st-location-coverage", "error", "Map exactly one ServiceTitan source binding for every location in scope.");
        }
        const recipe = source.method === "endpoint-recipe"
          ? serviceTitanEndpointRecipes.find((item) => item.id === source.endpointRecipeId && item.version === source.endpointRecipeVersion)
          : undefined;
        if (source.method === "endpoint-recipe" && !recipe) add("st-recipe", "error", "Choose a current governed endpoint recipe.");
        if (recipe && !recipe.allowedRefreshIntervals.includes(source.refreshInterval)) add("st-recipe-cadence", "error", "That endpoint recipe does not permit the selected refresh frequency.");
        if (recipe && definition.kind !== recipe.outputKind) add("st-recipe-kind", "error", `This endpoint recipe requires the ${recipe.outputKind} display format.`);
        source.tenantBindings.forEach((binding) => {
          const locationId = binding.locationIds?.length === 1 ? binding.locationIds[0] : undefined;
          const boundLocation = requiredLocations.find((location) => location.id === locationId && location.tenantId === binding.tenantId);
          if (!locationId || !boundLocation) {
            add(`st-location-coverage-${binding.tenantId}`, "error", `Tenant ${binding.tenantId} binding must identify exactly one in-scope location.`);
          }
          if (!binding.timezone.trim() || !boundLocation || boundLocation.timezone !== binding.timezone) {
            add(`st-timezone-${binding.tenantId}`, "error", `Tenant ${binding.tenantId} needs the exact configured location timezone.`);
          }
          const connection = context.connections?.find((item) => item.id === binding.connectionId);
          if (!connection || connection.status !== "ready" || connection.tenantId !== binding.tenantId
            || !locationId || !connection.locationIds.includes(locationId)) {
            add(`st-connection-${binding.tenantId}`, "error", `Tenant ${binding.tenantId} needs a ready, matching ServiceTitan connection assigned to its exact location.`);
          } else if (recipe && !connection.capabilities.includes(recipe.capability)) {
            add(`st-capability-${binding.tenantId}`, "error", `${connection.displayName} has not declared the ${recipe.capability} capability required by this recipe.`);
          }
          if (source.method === "saved-report") {
            const report = context.serviceTitanReports?.find((item) => item.id === binding.reportSourceId);
            if (!report || report.status !== "active" || report.lifecycle !== "approved" || report.connectionId !== binding.connectionId || report.tenantId !== binding.tenantId) {
              add(`st-report-${binding.tenantId}`, "error", `Choose the exact active approved saved report for tenant ${binding.tenantId} and its connection.`);
            } else {
              const fingerprint = binding.expectedSchemaFingerprint ?? binding.reportSchemaFingerprint;
              if (!fingerprint || report.expectedSchemaFingerprint !== fingerprint || report.observedSchemaFingerprint !== fingerprint || report.schemaFingerprint !== fingerprint) {
                add(`st-report-schema-${binding.tenantId}`, "error", `${report.name} changed schema and must be remapped before publication.`);
              }
              if (!validSampleEvidence(report.sampleEvidence)) add(`st-report-sample-${binding.tenantId}`, "error", `${report.name} needs passing sample evidence.`);
              if (!validReconciliationEvidence(report.reconciliationEvidence)) add(`st-report-reconciliation-${binding.tenantId}`, "error", `${report.name} needs passing reconciliation evidence.`);
              validateReportParameterValues(report.parameters, binding.parameterValues ?? {}).forEach((message, index) => {
                add(`st-report-parameter-${binding.tenantId}-${index}`, "error", message);
              });
              report.parameters.filter((parameter) => parameter.dynamicSetId === "business-units").forEach((parameter) => {
                const mappings = binding.businessUnitMappings;
                const mapped = locationId ? mappings?.[locationId] : undefined;
                const supplied = binding.parameterValues?.[parameter.name];
                if (!mappings || Object.keys(mappings).length !== 1 || !mapped?.length || new Set(mapped).size !== mapped.length) {
                  add(`st-business-unit-mapping-${binding.tenantId}`, "error", `Map one unambiguous business-unit set for location ${locationId ?? "unknown"}.`);
                } else if (!Array.isArray(supplied) || supplied.length !== mapped.length
                  || [...supplied].map(String).sort().some((value, index) => value !== [...mapped].sort()[index])) {
                  add(`st-business-unit-parameter-${binding.tenantId}`, "error", `Parameter ${parameter.name} must use exactly the mapped business units.`);
                }
              });
            }
            const bindingFingerprint = report ? serviceTitanObservationFingerprint(source, binding, report) : undefined;
            if (binding.approvalStatus !== "approved") add(`st-binding-approval-${binding.tenantId}`, "error", `Tenant ${binding.tenantId} report binding is not approved.`);
            if (!validSampleEvidence(binding.sampleEvidence, bindingFingerprint)) add(`st-binding-sample-${binding.tenantId}`, "error", `Tenant ${binding.tenantId} binding sample must pass for the exact source contract.`);
            if (!validReconciliationEvidence(binding.reconciliationEvidence, bindingFingerprint)) add(`st-binding-reconciliation-${binding.tenantId}`, "error", `Tenant ${binding.tenantId} binding reconciliation must pass for the exact source contract.`);
          }
        });
        add("st-demo", "warning", "The source contract is governed, but this public test build uses tenant-specific materialized demo observations until the server-side ServiceTitan worker is enabled.");
      }
    }
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
    if (definition.type === "service-titan") {
      const source = definition.serviceTitanSource;
      if (source?.method === "saved-report" && !source.reportReduction) add("st-report-reduction", "error", "Choose how report rows become one KPI value.");
      source?.tenantBindings.forEach((binding) => {
        const report = context.serviceTitanReports?.find((item) => item.id === binding.reportSourceId);
        const numericFields = report?.fields.filter((field) => field.type === "number").map((field) => field.name) ?? [];
        if (source.method === "saved-report" && source.reportReduction && source.reportReduction !== "count" && source.reportReduction !== "ratio" && (!binding.valueField || !numericFields.includes(binding.valueField))) {
          add(`st-value-field-${binding.tenantId}`, "error", `Choose a numeric report value field for tenant ${binding.tenantId}.`);
        }
        if (source.method === "saved-report" && source.reportReduction === "ratio" && (!binding.numeratorField || !binding.denominatorField
          || binding.numeratorField === binding.denominatorField || !numericFields.includes(binding.numeratorField) || !numericFields.includes(binding.denominatorField))) {
          add(`st-ratio-fields-${binding.tenantId}`, "error", `Choose distinct numeric numerator and denominator fields for tenant ${binding.tenantId}.`);
        }
        const observation = materializedObservation(definition, source, binding, report);
        if (!observation || !finite(observation.value) || (observation.prior !== undefined && !finite(observation.prior))) add(`st-observation-value-${binding.tenantId}`, "error", `Enter a finite materialized observation for tenant ${binding.tenantId}.`);
        if (!observation || !isValidTimestamp(observation.asOf)) add(`st-observation-date-${binding.tenantId}`, "error", `Enter a valid observation timestamp for tenant ${binding.tenantId}.`);
        if (observation?.status !== "valid") add(`st-observation-status-${binding.tenantId}`, "error", `The observation for tenant ${binding.tenantId} must be valid.`);
        const identity = expectedObservationIdentity(definition, source, binding, report);
        if (observation && (observation.sourceFingerprint !== identity.fingerprint || observation.sourceVersion !== identity.version)) add(`st-observation-source-${binding.tenantId}`, "error", `The observation for tenant ${binding.tenantId} does not match the governed source version.`);
      });
    }
    if ((definition.type === "manual" || definition.type === "external") && !finite(definition.manualValue)) add("manual-value", "error", "Enter a finite prototype observation.");
    if ((definition.type === "manual" || definition.type === "external") && !definition.asOf) add("as-of", "error", "Enter the observation date.");
    if (definition.goal !== undefined && !finite(definition.goal)) add("goal", "error", "Target must be a finite number.");
    if (definition.goal === 0) add("zero-goal", "warning", "A zero target is treated as informational because attainment cannot be calculated safely.");
  }
  if (step === "validate") {
    const evaluationDefinitions = [...allDefinitions.filter((item) => item.id !== definition.id), definition];
    const previewContexts = definition.type === "service-titan" && context.locations
      ? scopedLocations(definition, context.locations).map((location) => ({ tenantId: location.tenantId, locationId: location.id }))
      : [{ tenantId: context.tenantId, locationId: context.locationId }];
    if (definition.type === "service-titan" && previewContexts.length === 0) add("preview-context", "error", "No exact tenant/location context is available for validation.");
    previewContexts.forEach(({ tenantId, locationId }) => {
      const evaluation = evaluateCustomKpis(evaluationDefinitions, catalog, { ...context, tenantId, locationId }).get(definition.id);
      const identity = locationId ?? tenantId ?? "default";
      if (!evaluation || evaluation.state === "unavailable") add(`preview-${identity}`, "error", evaluation?.reason ?? "The KPI could not be evaluated.");
      if (evaluation?.warning) add(`lineage-warning-${identity}`, "warning", evaluation.warning);
    });
  }
  if (step === "publish") {
    if (definition.templateIds.length === 0) add("templates", "error", "Assign the KPI to at least one role template.");
    if (definition.releaseNote.trim().length < 5) add("release-note", "error", "Add a short publication reason or release note.");
  }
  return issues;
}

export function runCustomKpiValidation(
  definition: CustomKpiDefinition,
  catalog: Metric[],
  allDefinitions: CustomKpiDefinition[],
  context: CustomKpiValidationContext = {},
): { checks: ValidationCheck[]; issues: ValidationIssue[] } {
  const steps: CustomKpiStep[] = ["definition", "scope", "source", "calculation", "validate"];
  const issues = steps.flatMap((step) => validateCustomKpiStep(definition, step, catalog, allDefinitions, context));
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
  if (!metric || typeof metric.id !== "string" || typeof metric.title !== "string" || !finite(metric.actual)
    || !CUSTOM_KPI_SECTIONS.includes(metric.section) || !CUSTOM_KPI_KINDS.includes(metric.kind)
    || typeof metric.subtitle !== "string") return null;
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

const CUSTOM_KPI_TYPES: CustomKpiType[] = ["catalog", "derived", "service-titan", "manual", "external"];
const CUSTOM_KPI_STATUSES: CustomKpiStatus[] = ["draft", "published", "archived"];
const CUSTOM_KPI_DIRECTIONS: CustomKpiDirection[] = ["higher", "lower", "informational"];
const CUSTOM_KPI_SCOPES: CustomKpiScopeMode[] = ["portfolio", "selected-locations"];
const CUSTOM_KPI_SECTIONS: MetricSection[] = ["executive", "revenue", "calls", "appointments", "sales", "membership"];
const CUSTOM_KPI_KINDS: MetricKind[] = ["currency", "number", "percent", "ratio"];
const CUSTOM_KPI_OPERATIONS: FormulaOperation[] = ["add", "subtract", "multiply", "divide", "percent"];
const CUSTOM_KPI_PROVIDERS: ExternalProvider[] = ["Domo", "GA4", "Google Business Profile", "Call System", "Finance", "Other"];
const CUSTOM_KPI_REFRESH_CADENCES = ["daily", "weekly", "monthly", "ad-hoc"] as const;
const CUSTOM_KPI_METHODS: ServiceTitanSourceMethod[] = ["endpoint-recipe", "saved-report"];
const CUSTOM_KPI_REFRESH_INTERVALS: ServiceTitanRefreshInterval[] = ["15m", "30m", "1h", "4h", "12h", "24h"];
const CUSTOM_KPI_REDUCTIONS: ServiceTitanReportReduction[] = ["sum", "average", "count", "latest", "ratio"];
const CUSTOM_KPI_SECRET_KEY = /(secret|password|authorization|access.?token|refresh.?token|client.?id|app.?key|api.?key|bearer)/i;

function objectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function containsCustomKpiSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCustomKpiSecret);
  if (!objectRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => CUSTOM_KPI_SECRET_KEY.test(key) || containsCustomKpiSecret(nested));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function optionalFinite(value: unknown): value is number | undefined {
  return value === undefined || finite(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function exactValidationCheck(value: unknown): value is ValidationCheck {
  return objectRecord(value) && hasOnlyKeys(value, ["id", "label", "status", "detail"])
    && nonEmptyString(value.id) && typeof value.label === "string" && ["pass", "warning", "fail"].includes(value.status as string) && typeof value.detail === "string";
}

function exactSampleEvidence(value: unknown): value is ServiceTitanBindingSampleEvidence {
  return objectRecord(value) && hasOnlyKeys(value, ["rowCount", "computedValue", "status", "sampledAt"])
    && Number.isInteger(value.rowCount) && (value.rowCount as number) >= 0 && finite(value.computedValue)
    && ["pending", "pass", "fail"].includes(value.status as string) && isValidTimestamp(value.sampledAt);
}

function exactReconciliationEvidence(value: unknown): value is ServiceTitanBindingReconciliationEvidence {
  if (!objectRecord(value) || !hasOnlyKeys(value, ["expectedValue", "referenceValue", "tolerance", "delta", "status", "reconciledAt"])) return false;
  const reference = value.referenceValue ?? value.expectedValue;
  return finite(value.expectedValue) && finite(reference) && finite(value.tolerance) && value.tolerance >= 0 && finite(value.delta)
    && Math.abs(value.delta - (value.expectedValue - reference)) < 1e-9
    && Math.abs(value.delta) <= value.tolerance
    && ["pending", "pass", "fail"].includes(value.status as string) && isValidTimestamp(value.reconciledAt);
}

function exactObservation(value: unknown): value is ServiceTitanMaterializedObservation {
  return objectRecord(value) && hasOnlyKeys(value, ["value", "prior", "asOf", "sourceFingerprint", "sourceVersion", "status"])
    && finite(value.value) && optionalFinite(value.prior) && isValidTimestamp(value.asOf) && nonEmptyString(value.sourceFingerprint)
    && Number.isInteger(value.sourceVersion) && (value.sourceVersion as number) > 0 && ["valid", "invalid"].includes(value.status as string);
}

function exactParameterValue(value: unknown): value is ServiceTitanReportParameterValue {
  const scalar = (item: unknown) => typeof item === "string" || typeof item === "boolean" || finite(item);
  return scalar(value) || (Array.isArray(value) && value.length > 0 && value.every(scalar));
}

function exactStringArrayRecord(value: unknown): value is Record<string, string[]> {
  return objectRecord(value) && Object.keys(value).every(nonEmptyString) && Object.values(value).every(stringArray);
}

function sanitizeTenantBinding(value: unknown, schemaVersion: 2 | 3): ServiceTitanTenantBinding | null {
  if (!objectRecord(value) || !hasOnlyKeys(value, [
    "tenantId", "connectionId", "timezone", "locationIds", "parameterValues", "businessUnitMappings", "reportSourceId",
    "expectedSchemaFingerprint", "reportSchemaFingerprint", "valueField", "numeratorField", "denominatorField", "approvalStatus",
    "sampleEvidence", "reconciliationEvidence", "observation", "prototypeValue", "prototypePriorValue", "prototypeAsOf",
  ])) return null;
  if (!nonEmptyString(value.tenantId) || !nonEmptyString(value.connectionId)) return null;
  const timezone = schemaVersion === 2 && value.timezone === undefined ? "UTC" : value.timezone;
  if (!nonEmptyString(timezone) || !stringArray(value.locationIds) || value.locationIds.length !== 1) return null;
  if (value.parameterValues !== undefined && (!objectRecord(value.parameterValues) || !Object.keys(value.parameterValues).every(nonEmptyString) || !Object.values(value.parameterValues).every(exactParameterValue))) return null;
  if (value.businessUnitMappings !== undefined && (!exactStringArrayRecord(value.businessUnitMappings)
    || Object.keys(value.businessUnitMappings).length !== 1 || !(value.locationIds[0] in value.businessUnitMappings)
    || Object.values(value.businessUnitMappings).some((ids) => ids.length === 0 || new Set(ids).size !== ids.length))) return null;
  for (const key of ["reportSourceId", "expectedSchemaFingerprint", "reportSchemaFingerprint", "valueField", "numeratorField", "denominatorField"] as const) {
    if (value[key] !== undefined && !nonEmptyString(value[key])) return null;
  }
  if (value.approvalStatus !== undefined && !["draft", "approved", "rejected"].includes(value.approvalStatus as string)) return null;
  if (value.sampleEvidence !== undefined && !exactSampleEvidence(value.sampleEvidence)) return null;
  if (value.reconciliationEvidence !== undefined && !exactReconciliationEvidence(value.reconciliationEvidence)) return null;
  if (value.observation !== undefined && !exactObservation(value.observation)) return null;
  if (!optionalFinite(value.prototypeValue) || !optionalFinite(value.prototypePriorValue) || (value.prototypeAsOf !== undefined && !isValidTimestamp(value.prototypeAsOf))) return null;

  const binding = { ...value, timezone } as unknown as ServiceTitanTenantBinding;
  if (binding.expectedSchemaFingerprint === undefined && binding.reportSchemaFingerprint !== undefined) binding.expectedSchemaFingerprint = binding.reportSchemaFingerprint;
  return binding;
}

function sanitizeServiceTitanSource(value: unknown, schemaVersion: 2 | 3): ServiceTitanKpiSource | null {
  if (!objectRecord(value) || !hasOnlyKeys(value, ["method", "refreshInterval", "endpointRecipeId", "endpointRecipeVersion", "reportReduction", "tenantBindings"])) return null;
  if (!CUSTOM_KPI_METHODS.includes(value.method as ServiceTitanSourceMethod) || !CUSTOM_KPI_REFRESH_INTERVALS.includes(value.refreshInterval as ServiceTitanRefreshInterval)) return null;
  if (value.endpointRecipeId !== undefined && !nonEmptyString(value.endpointRecipeId)) return null;
  if (value.endpointRecipeVersion !== undefined && (!Number.isInteger(value.endpointRecipeVersion) || (value.endpointRecipeVersion as number) < 1)) return null;
  if (value.reportReduction !== undefined && !CUSTOM_KPI_REDUCTIONS.includes(value.reportReduction as ServiceTitanReportReduction)) return null;
  if (!Array.isArray(value.tenantBindings)) return null;
  const bindings = value.tenantBindings.map((binding) => sanitizeTenantBinding(binding, schemaVersion));
  if (bindings.some((binding) => binding === null)) return null;
  const typedBindings = bindings as ServiceTitanTenantBinding[];
  const identities = typedBindings.map((binding) => `${binding.tenantId}:${binding.locationIds![0]}`);
  if (new Set(identities).size !== identities.length) return null;
  if (!refreshOptionsForMethod(value.method as ServiceTitanSourceMethod).some((option) => option.id === value.refreshInterval)) return null;
  return { ...(value as unknown as ServiceTitanKpiSource), tenantBindings: typedBindings };
}

const DEFINITION_KEYS = [
  "id", "key", "type", "status", "version", "title", "definition", "owner", "section", "kind", "direction", "subtitle",
  "scopeMode", "locationIds", "roles", "catalogMetricId", "serviceTitanSource", "provider", "externalDatasetId", "externalMetricKey",
  "refreshCadence", "staleAfterHours", "leftMetricId", "operation", "rightMetricId", "manualValue", "priorValue", "asOf", "goal",
  "warningAt", "templateIds", "releaseNote", "validationChecks", "validatedAt", "createdAt", "updatedAt", "publishedAt", "migratedFromLegacy",
] as const;

function sanitizeDefinition(value: unknown, schemaVersion: 2 | 3): CustomKpiDefinition | null {
  if (!objectRecord(value) || !hasOnlyKeys(value, DEFINITION_KEYS)) return null;
  if (!nonEmptyString(value.id) || typeof value.key !== "string" || !CUSTOM_KPI_TYPES.includes(value.type as CustomKpiType)
    || !CUSTOM_KPI_STATUSES.includes(value.status as CustomKpiStatus) || !Number.isInteger(value.version) || (value.version as number) < 1
    || typeof value.title !== "string" || typeof value.definition !== "string" || typeof value.owner !== "string"
    || !CUSTOM_KPI_SECTIONS.includes(value.section as MetricSection) || !CUSTOM_KPI_KINDS.includes(value.kind as MetricKind)
    || !CUSTOM_KPI_DIRECTIONS.includes(value.direction as CustomKpiDirection) || typeof value.subtitle !== "string"
    || !CUSTOM_KPI_SCOPES.includes(value.scopeMode as CustomKpiScopeMode) || !stringArray(value.locationIds) || !stringArray(value.roles)
    || !stringArray(value.templateIds) || typeof value.releaseNote !== "string" || !Array.isArray(value.validationChecks)
    || !value.validationChecks.every(exactValidationCheck) || !isValidTimestamp(value.createdAt) || !isValidTimestamp(value.updatedAt)) return null;
  for (const key of ["catalogMetricId", "externalDatasetId", "externalMetricKey", "leftMetricId", "rightMetricId"] as const) if (!optionalString(value[key])) return null;
  if (value.provider !== undefined && !CUSTOM_KPI_PROVIDERS.includes(value.provider as ExternalProvider)) return null;
  if (value.refreshCadence !== undefined && !CUSTOM_KPI_REFRESH_CADENCES.includes(value.refreshCadence as typeof CUSTOM_KPI_REFRESH_CADENCES[number])) return null;
  if (value.operation !== undefined && !CUSTOM_KPI_OPERATIONS.includes(value.operation as FormulaOperation)) return null;
  for (const key of ["staleAfterHours", "manualValue", "priorValue", "goal", "warningAt"] as const) if (!optionalFinite(value[key])) return null;
  if (value.asOf !== undefined && !isValidTimestamp(value.asOf)) return null;
  for (const key of ["validatedAt", "publishedAt"] as const) if (value[key] !== undefined && !isValidTimestamp(value[key])) return null;
  if (value.migratedFromLegacy !== undefined && typeof value.migratedFromLegacy !== "boolean") return null;
  const source = value.serviceTitanSource === undefined ? undefined : sanitizeServiceTitanSource(value.serviceTitanSource, schemaVersion);
  if (value.serviceTitanSource !== undefined && !source) return null;
  return { ...(value as unknown as CustomKpiDefinition), ...(source ? { serviceTitanSource: source } : {}) };
}

function sanitizedCustomKpiStore(value: unknown): CustomKpiStore | null {
  if (!objectRecord(value) || containsCustomKpiSecret(value) || !hasOnlyKeys(value, ["schemaVersion", "definitions", "migratedAt", "availability", "unavailableReason"])) return null;
  if ((value.schemaVersion !== 2 && value.schemaVersion !== CUSTOM_KPI_SCHEMA_VERSION) || !Array.isArray(value.definitions)) return null;
  if (value.migratedAt !== undefined && !isValidTimestamp(value.migratedAt)) return null;
  if (value.availability !== undefined && !["available", "unavailable"].includes(value.availability as string)) return null;
  if (value.unavailableReason !== undefined && typeof value.unavailableReason !== "string") return null;
  const definitions = value.definitions.map((definition) => sanitizeDefinition(definition, value.schemaVersion as 2 | 3));
  if (definitions.some((definition) => definition === null)) return null;
  const typed = definitions as CustomKpiDefinition[];
  if (new Set(typed.map((definition) => definition.id)).size !== typed.length) return null;
  const activeKeys = typed.filter((definition) => definition.status !== "archived").map((definition) => definition.key);
  if (new Set(activeKeys).size !== activeKeys.length) return null;
  return JSON.parse(JSON.stringify({
    schemaVersion: CUSTOM_KPI_SCHEMA_VERSION,
    definitions: typed,
    ...(value.migratedAt ? { migratedAt: value.migratedAt } : {}),
    ...(value.availability ? { availability: value.availability } : {}),
    ...(value.unavailableReason ? { unavailableReason: value.unavailableReason } : {}),
  })) as CustomKpiStore;
}

function unavailableCustomKpiStore(reason: string): CustomKpiStore {
  return { schemaVersion: CUSTOM_KPI_SCHEMA_VERSION, definitions: [], availability: "unavailable", unavailableReason: reason };
}

export function normalizeCustomKpiStore(value: unknown): CustomKpiStore {
  return sanitizedCustomKpiStore(value) ?? unavailableCustomKpiStore("Stored custom KPI definitions are malformed or unsafe.");
}

export function readCustomKpiStore(storage: Pick<Storage, "getItem" | "setItem">, now: string): CustomKpiStore {
  let current: string | null;
  try { current = storage.getItem(CUSTOM_KPI_STORAGE_KEY); } catch { return unavailableCustomKpiStore("Stored custom KPI definitions could not be read."); }
  if (current !== null) {
    try {
      const parsed = JSON.parse(current);
      const normalized = sanitizedCustomKpiStore(parsed);
      if (!normalized) return unavailableCustomKpiStore("Stored custom KPI definitions are malformed or unsafe.");
      if (parsed.schemaVersion === 2) {
        try { storage.setItem(CUSTOM_KPI_STORAGE_KEY, JSON.stringify(normalized)); } catch { return unavailableCustomKpiStore("Migrated custom KPI definitions could not be persisted."); }
      }
      return normalized;
    } catch { return unavailableCustomKpiStore("Stored custom KPI definitions contain malformed JSON."); }
  }
  let v2: string | null;
  try { v2 = storage.getItem(V2_CUSTOM_KPI_STORAGE_KEY); } catch { return unavailableCustomKpiStore("Stored v2 custom KPI definitions could not be read."); }
  if (v2 !== null) {
    try {
      const parsed = JSON.parse(v2);
      if (!objectRecord(parsed) || parsed.schemaVersion !== 2) return unavailableCustomKpiStore("Stored v2 custom KPI definitions are malformed or unsafe.");
      const normalized = sanitizedCustomKpiStore(parsed);
      if (!normalized) return unavailableCustomKpiStore("Stored v2 custom KPI definitions are malformed or unsafe.");
      try { storage.setItem(CUSTOM_KPI_STORAGE_KEY, JSON.stringify(normalized)); } catch { return unavailableCustomKpiStore("Migrated custom KPI definitions could not be persisted."); }
      return normalized;
    } catch { return unavailableCustomKpiStore("Stored v2 custom KPI definitions contain malformed JSON."); }
  }
  if (!isValidTimestamp(now)) return unavailableCustomKpiStore("The custom KPI migration timestamp is invalid.");
  let definitions: CustomKpiDefinition[] = [];
  try {
    const legacy = storage.getItem(LEGACY_CUSTOM_KPI_STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (Array.isArray(parsed)) definitions = parsed.map((item) => legacyToDefinition(item as CustomMetricInput, now)).filter((item): item is CustomKpiDefinition => Boolean(item));
    }
  } catch { /* malformed legacy data is ignored during the one-time safe migration */ }
  const migrated: CustomKpiStore = { schemaVersion: CUSTOM_KPI_SCHEMA_VERSION, definitions, migratedAt: now, availability: "available" };
  const normalized = sanitizedCustomKpiStore(migrated) ?? unavailableCustomKpiStore("Legacy custom KPI definitions could not be migrated safely.");
  try { storage.setItem(CUSTOM_KPI_STORAGE_KEY, JSON.stringify(normalized)); } catch { return unavailableCustomKpiStore("Migrated custom KPI definitions could not be persisted."); }
  return normalized;
}

export function writeCustomKpiStore(storage: Pick<Storage, "setItem">, store: CustomKpiStore): boolean {
  const normalized = sanitizedCustomKpiStore(store);
  if (!normalized) return false;
  try { storage.setItem(CUSTOM_KPI_STORAGE_KEY, JSON.stringify(normalized)); return true; } catch { return false; }
}
