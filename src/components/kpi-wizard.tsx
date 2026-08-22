"use client";

import {
  ArrowLeft,
  ArrowRight,
  Calculator,
  Check,
  CheckCircle2,
  CircleAlert,
  Database,
  FileInput,
  Gauge,
  Layers3,
  Plus,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatMetric } from "@/lib/metrics";
import {
  createCustomKpiDraft,
  createKpiId,
  customKpiToMetric,
  evaluateCustomKpis,
  materializeServiceTitanReportBindingEvidence,
  runCustomKpiValidation,
  serviceTitanObservationFingerprint,
  slugifyKpiKey,
  validateCustomKpiStep,
  wizardSteps,
  type CustomKpiDefinition,
  type CustomKpiValidationContext,
  type ServiceTitanKpiSource,
  type ServiceTitanTenantBinding,
  type ValidationIssue,
} from "@/lib/custom-kpis";
import { sectionMeta } from "@/lib/demo-data";
import { createSeedConnectionStore, readConnectionStore, type DemoServiceTitanConnection } from "@/lib/demo-connections";
import {
  createSeedServiceTitanSourceStore,
  readServiceTitanSourceStore,
  refreshOptionsForMethod,
  selectableServiceTitanEndpointRecipes,
  serviceTitanEndpointRecipes,
  staleHoursForRefresh,
  validateReportParameterValues,
  type ServiceTitanRefreshInterval,
  type ServiceTitanReportParameter,
  type ServiceTitanReportParameterDataType,
  type ServiceTitanReportParameterScalar,
  type ServiceTitanReportParameterValue,
  type ServiceTitanReportReduction,
  type ServiceTitanReportSource,
  type ServiceTitanSourceMethod,
} from "@/lib/service-titan-sources";
import type { LayoutTemplate, LocationConfig, Metric, MetricKind, MetricSection } from "@/lib/types";

const typeOptions: { id: CustomKpiDefinition["type"]; title: string; copy: string; icon: typeof Layers3 }[] = [
  { id: "catalog", title: "Existing KPI variant", copy: "Reuse a governed formula and change its scope, target, or presentation.", icon: Layers3 },
  { id: "derived", title: "Derived KPI", copy: "Calculate a controlled ratio or formula from approved KPI inputs.", icon: Calculator },
  { id: "service-titan", title: "ServiceTitan KPI", copy: "Map an approved endpoint recipe or tenant-specific saved report with guarded refresh timing.", icon: Database },
  { id: "manual", title: "Manual / CSV KPI", copy: "Maintain a value outside ServiceTitan with ownership and freshness controls.", icon: FileInput },
  { id: "external", title: "External KPI", copy: "Model Domo, GA4, GBP, call-system, finance, or another governed connector.", icon: Gauge },
];

const roleOptions = [
  ["general-manager", "General manager"],
  ["department-leader", "Department leader"],
  ["brand-executive", "Brand executive"],
  ["portfolio-admin", "Portfolio admin"],
] as const;

const reportReductions: { id: ServiceTitanReportReduction; label: string; copy: string }[] = [
  { id: "sum", label: "Sum", copy: "Sum the mapped numeric column." },
  { id: "average", label: "Average", copy: "Average the mapped numeric column." },
  { id: "count", label: "Count rows", copy: "Count eligible rows after governed filters." },
  { id: "latest", label: "Latest value", copy: "Use the latest period value after sorting." },
  { id: "ratio", label: "Ratio / percent", copy: "Divide summed numerator by a distinct denominator." },
];

type ObservationDraft = { value: string; prior: string; asOf: string };
type ReadinessItem = { id: string; label: string; ready: boolean; detail: string };

function cloneDefinition(definition: CustomKpiDefinition): CustomKpiDefinition {
  return JSON.parse(JSON.stringify(definition));
}

function numericValue(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function scopedLocations(definition: Pick<CustomKpiDefinition, "scopeMode" | "locationIds">, locations: LocationConfig[]) {
  return definition.scopeMode === "portfolio" ? locations : locations.filter((location) => definition.locationIds.includes(location.id));
}

function bindingKey(binding: Pick<ServiceTitanTenantBinding, "tenantId" | "locationIds">): string {
  return `${binding.tenantId}:${binding.locationIds?.[0] ?? "unscoped"}`;
}

function clearObservations(source: ServiceTitanKpiSource): ServiceTitanKpiSource {
  return {
    ...source,
    tenantBindings: source.tenantBindings.map((binding) => {
      const next = { ...binding };
      delete next.observation;
      delete next.sampleEvidence;
      delete next.reconciliationEvidence;
      delete next.prototypeValue;
      delete next.prototypePriorValue;
      delete next.prototypeAsOf;
      return next;
    }),
  };
}

function bindingLocationIdentity(binding: ServiceTitanTenantBinding): ServiceTitanTenantBinding {
  return {
    tenantId: binding.tenantId,
    connectionId: binding.connectionId,
    timezone: binding.timezone,
    locationIds: binding.locationIds ? [...binding.locationIds] : undefined,
  };
}

function syncLocationBindings(
  definition: Pick<CustomKpiDefinition, "scopeMode" | "locationIds">,
  source: ServiceTitanKpiSource,
  locations: LocationConfig[],
  connections: DemoServiceTitanConnection[],
): ServiceTitanKpiSource {
  return {
    ...source,
    tenantBindings: scopedLocations(definition, locations).map((location) => {
      const current = source.tenantBindings.find((binding) => binding.tenantId === location.tenantId
        && binding.locationIds?.length === 1 && binding.locationIds[0] === location.id);
      const selectedConnection = current && connections.find((connection) => connection.id === current.connectionId
        && connection.tenantId === location.tenantId && connection.locationIds.includes(location.id));
      const readyDefault = connections.find((connection) => connection.status === "ready"
        && connection.tenantId === location.tenantId && connection.locationIds.includes(location.id));
      return {
        ...(current ?? {}),
        tenantId: location.tenantId,
        locationIds: [location.id],
        timezone: location.timezone,
        connectionId: selectedConnection?.id ?? readyDefault?.id ?? "",
      };
    }),
  };
}

function parameterInputType(type: ServiceTitanReportParameterDataType): "text" | "number" | "date" | "time" {
  if (type === "Number") return "number";
  if (type === "Date") return "date";
  if (type === "Time") return "time";
  return "text";
}

function parseParameterScalar(raw: string, type: ServiceTitanReportParameterDataType): ServiceTitanReportParameterScalar | undefined {
  if (type === "Number") return numericValue(raw);
  if (type === "Boolean") return raw === "true" ? true : raw === "false" ? false : undefined;
  return raw || undefined;
}

function defaultParameterScalar(type: ServiceTitanReportParameterDataType): ServiceTitanReportParameterScalar {
  if (type === "Number") return 0;
  if (type === "Boolean") return false;
  return "";
}

function formatInTimezone(iso: string | undefined, timezone: string): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(iso));
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
  } catch {
    return "";
  }
}

function zonedLocalToIso(value: string, timezone: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match;
  const target = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  let guess = target;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rendered = formatInTimezone(new Date(guess).toISOString(), timezone);
      const renderedMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(rendered);
      if (!renderedMatch) return undefined;
      const renderedUtc = Date.UTC(Number(renderedMatch[1]), Number(renderedMatch[2]) - 1, Number(renderedMatch[3]), Number(renderedMatch[4]), Number(renderedMatch[5]));
      guess += target - renderedUtc;
    }
    const iso = new Date(guess).toISOString();
    return formatInTimezone(iso, timezone) === value ? iso : undefined;
  } catch {
    return undefined;
  }
}

function reportHasSchemaMatch(report: ServiceTitanReportSource | undefined): boolean {
  return Boolean(report && report.expectedSchemaFingerprint === report.schemaFingerprint
    && report.observedSchemaFingerprint === report.expectedSchemaFingerprint);
}

function StepIssues({ issues }: { issues: ValidationIssue[] }) {
  if (!issues.length) return null;
  return <div className="wizard-issues" role="alert">{issues.map((issue) => <div className={issue.severity} key={`${issue.step}-${issue.code}`}>
    {issue.severity === "error" ? <XCircle size={16}/> : <CircleAlert size={16}/>}<span>{issue.message}</span>
  </div>)}</div>;
}

export function KpiWizard({
  initial,
  catalog,
  definitions,
  locations,
  templates,
  onSaveDraft,
  onPublish,
  onCancel,
}: {
  initial?: CustomKpiDefinition;
  catalog: Metric[];
  definitions: CustomKpiDefinition[];
  locations: LocationConfig[];
  templates: LayoutTemplate[];
  onSaveDraft: (definition: CustomKpiDefinition) => boolean;
  onPublish: (definition: CustomKpiDefinition) => boolean;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<CustomKpiDefinition>(() => cloneDefinition(initial ?? createCustomKpiDraft(createKpiId(), new Date().toISOString())));
  const [stepIndex, setStepIndex] = useState(0);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [saved, setSaved] = useState(false);
  const [persistenceError, setPersistenceError] = useState("");
  const [connections, setConnections] = useState<DemoServiceTitanConnection[]>(() => createSeedConnectionStore().connections);
  const [serviceTitanReports, setServiceTitanReports] = useState<ServiceTitanReportSource[]>(() => createSeedServiceTitanSourceStore().reports);
  const [contextNow, setContextNow] = useState(() => new Date().toISOString());
  const [observationDrafts, setObservationDrafts] = useState<Record<string, ObservationDraft>>({});
  const currentStep = wizardSteps[stepIndex].id;

  useEffect(() => {
    const hydrate = window.setTimeout(() => {
      const hydratedConnections = readConnectionStore(localStorage).connections;
      const hydratedReports = readServiceTitanSourceStore(localStorage).reports;
      setConnections(hydratedConnections);
      setServiceTitanReports(hydratedReports);
      setContextNow(new Date().toISOString());
      setDraft((current) => {
        if (current.type !== "service-titan" || !current.serviceTitanSource) return current;
        const synced = syncLocationBindings(current, current.serviceTitanSource, locations, hydratedConnections);
        return {
          ...current,
          serviceTitanSource: synced.method === "saved-report"
            ? {
                ...synced,
                tenantBindings: synced.tenantBindings.map((binding) => materializeServiceTitanReportBindingEvidence(
                  synced,
                  binding,
                  hydratedReports.find((report) => report.id === binding.reportSourceId),
                )),
              }
            : synced,
        };
      });
    }, 0);
    const refreshReports = () => {
      const reports = readServiceTitanSourceStore(localStorage).reports;
      setServiceTitanReports(reports);
      setObservationDrafts({});
      setContextNow(new Date().toISOString());
      setDraft((current) => {
        if (current.type !== "service-titan" || current.serviceTitanSource?.method !== "saved-report") return current;
        const cleared = clearObservations(current.serviceTitanSource);
        return {
          ...current,
          serviceTitanSource: {
            ...cleared,
            tenantBindings: cleared.tenantBindings.map((binding) => materializeServiceTitanReportBindingEvidence(
              cleared,
              binding,
              reports.find((report) => report.id === binding.reportSourceId),
            )),
          },
          validationChecks: [],
          validatedAt: undefined,
          updatedAt: new Date().toISOString(),
        };
      });
    };
    const clock = window.setInterval(() => setContextNow(new Date().toISOString()), 60_000);
    window.addEventListener("gmib:servicetitan-sources-updated", refreshReports);
    return () => {
      window.clearTimeout(hydrate);
      window.clearInterval(clock);
      window.removeEventListener("gmib:servicetitan-sources-updated", refreshReports);
    };
  }, [locations]);

  const scoped = scopedLocations(draft, locations);
  const previewLocation = draft.type === "service-titan" ? scoped[0] : undefined;
  const validationContext = useMemo<CustomKpiValidationContext>(() => ({
    locations,
    connections,
    serviceTitanReports,
    tenantId: previewLocation?.tenantId,
    locationId: previewLocation?.id,
    now: contextNow,
  }), [locations, connections, serviceTitanReports, previewLocation?.tenantId, previewLocation?.id, contextNow]);
  const publishedDependencies = definitions.filter((item) => item.status === "published" && item.id !== draft.id);
  const dependencyOptions = [
    ...catalog.map((metric) => ({ id: metric.id, label: metric.title })),
    ...publishedDependencies.map((metric) => ({ id: metric.id, label: metric.title })),
  ];
  const evaluation = useMemo(
    () => evaluateCustomKpis([...definitions.filter((item) => item.id !== draft.id), draft], catalog, validationContext).get(draft.id),
    [catalog, definitions, draft, validationContext],
  );
  const previewMetric = evaluation ? customKpiToMetric({ ...draft, status: "published" }, evaluation) : null;
  const source = draft.serviceTitanSource;
  const selectedRecipe = source?.method === "endpoint-recipe"
    ? serviceTitanEndpointRecipes.find((recipe) => recipe.id === source.endpointRecipeId && recipe.version === source.endpointRecipeVersion)
    : undefined;
  const cadence = source ? refreshOptionsForMethod(source.method).find((option) => option.id === source.refreshInterval) : undefined;

  function markChanged() {
    setIssues([]);
    setSaved(false);
    setPersistenceError("");
    setContextNow(new Date().toISOString());
  }

  function patch(values: Partial<CustomKpiDefinition>) {
    setDraft((current) => {
      let next = { ...current, ...values, validationChecks: [], validatedAt: undefined, updatedAt: new Date().toISOString() };
      if (next.type === "service-titan" && next.serviceTitanSource && (values.scopeMode !== undefined || values.locationIds !== undefined)) {
        next = { ...next, serviceTitanSource: syncLocationBindings(next, next.serviceTitanSource, locations, connections) };
      }
      return next;
    });
    markChanged();
  }

  function selectType(type: CustomKpiDefinition["type"]) {
    if (type === "service-titan") {
      const recipe = selectableServiceTitanEndpointRecipes[0];
      const base: ServiceTitanKpiSource = {
        method: "endpoint-recipe",
        refreshInterval: recipe.defaultRefreshInterval,
        endpointRecipeId: recipe.id,
        endpointRecipeVersion: recipe.version,
        tenantBindings: [],
      };
      patch({ type, kind: recipe.outputKind, serviceTitanSource: syncLocationBindings(draft, base, locations, connections) });
      return;
    }
    setObservationDrafts({});
    patch({
      type,
      serviceTitanSource: undefined,
      catalogMetricId: undefined,
      leftMetricId: undefined,
      rightMetricId: undefined,
      provider: undefined,
      externalDatasetId: undefined,
      externalMetricKey: undefined,
    });
  }

  function selectServiceTitanMethod(method: ServiceTitanSourceMethod) {
    const recipe = selectableServiceTitanEndpointRecipes[0];
    const existingBindings = source?.tenantBindings ?? [];
    const nextSource: ServiceTitanKpiSource = method === "endpoint-recipe"
      ? {
          method,
          refreshInterval: recipe.defaultRefreshInterval,
          endpointRecipeId: recipe.id,
          endpointRecipeVersion: recipe.version,
          tenantBindings: existingBindings.map(bindingLocationIdentity),
        }
      : {
          method,
          refreshInterval: "24h",
          reportReduction: "sum",
          tenantBindings: existingBindings.map(bindingLocationIdentity),
        };
    setObservationDrafts({});
    patch({
      serviceTitanSource: syncLocationBindings(draft, clearObservations(nextSource), locations, connections),
      kind: method === "endpoint-recipe" ? recipe.outputKind : draft.kind,
    });
  }

  function patchServiceTitanSource(values: Partial<ServiceTitanKpiSource>, clearObservation = true) {
    if (!source) return;
    let next = { ...source, ...values } as ServiceTitanKpiSource;
    if (clearObservation) {
      setObservationDrafts({});
      next = clearObservations(next);
    }
    if (next.method === "saved-report") {
      next = {
        ...next,
        tenantBindings: next.tenantBindings.map((binding) => materializeServiceTitanReportBindingEvidence(
          next,
          binding,
          serviceTitanReports.find((report) => report.id === binding.reportSourceId),
        )),
      };
    }
    patch({ serviceTitanSource: next });
  }

  function patchTenantBinding(tenantId: string, locationId: string, values: Partial<ServiceTitanTenantBinding>, clearObservation = true) {
    if (!source) return;
    const tenantBindings = source.tenantBindings.map((binding) => binding.tenantId === tenantId
      && binding.locationIds?.length === 1 && binding.locationIds[0] === locationId
      ? {
          ...binding,
          ...values,
          ...(clearObservation ? {
            observation: undefined,
            sampleEvidence: undefined,
            reconciliationEvidence: undefined,
            prototypeValue: undefined,
            prototypePriorValue: undefined,
            prototypeAsOf: undefined,
          } : {}),
        }
      : binding);
    if (clearObservation) {
      const key = `${tenantId}:${locationId}`;
      setObservationDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== key)));
    }
    patchServiceTitanSource({ tenantBindings }, false);
  }

  function selectReport(binding: ServiceTitanTenantBinding, reportId: string) {
    const locationId = binding.locationIds?.[0];
    if (!locationId) return;
    const report = serviceTitanReports.find((item) => item.id === reportId && item.lifecycle === "approved" && item.status === "active"
      && item.connectionId === binding.connectionId && item.tenantId === binding.tenantId);
    patchTenantBinding(binding.tenantId, locationId, {
      reportSourceId: report?.id,
      expectedSchemaFingerprint: report?.expectedSchemaFingerprint,
      reportSchemaFingerprint: undefined,
      parameterValues: undefined,
      businessUnitMappings: undefined,
      valueField: undefined,
      numeratorField: undefined,
      denominatorField: undefined,
      approvalStatus: report ? "approved" : undefined,
    });
  }

  function patchParameterValue(binding: ServiceTitanTenantBinding, parameter: ServiceTitanReportParameter, value: ServiceTitanReportParameterValue | undefined) {
    const locationId = binding.locationIds?.[0];
    if (!locationId) return;
    const parameterValues = { ...(binding.parameterValues ?? {}) };
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete parameterValues[parameter.name];
    else parameterValues[parameter.name] = value;
    let businessUnitMappings = binding.businessUnitMappings;
    if (parameter.dynamicSetId === "business-units") {
      businessUnitMappings = Array.isArray(value) && value.length
        ? { [locationId]: value.map(String) }
        : undefined;
    }
    patchTenantBinding(binding.tenantId, locationId, {
      parameterValues: Object.keys(parameterValues).length ? parameterValues : undefined,
      businessUnitMappings,
    });
  }

  function observationInput(binding: ServiceTitanTenantBinding): ObservationDraft {
    return observationDrafts[bindingKey(binding)] ?? {
      value: binding.observation?.value?.toString() ?? "",
      prior: binding.observation?.prior?.toString() ?? "",
      asOf: formatInTimezone(binding.observation?.asOf, binding.timezone),
    };
  }

  function editObservation(binding: ServiceTitanTenantBinding, field: keyof ObservationDraft, raw: string) {
    const key = bindingKey(binding);
    const nextInput = { ...observationInput(binding), [field]: raw };
    setObservationDrafts((current) => ({ ...current, [key]: nextInput }));
    setDraft((current) => {
      const currentSource = current.serviceTitanSource;
      if (!currentSource) return current;
      const currentBinding = currentSource.tenantBindings.find((item) => bindingKey(item) === key);
      if (!currentBinding) return current;
      const report = serviceTitanReports.find((item) => item.id === currentBinding.reportSourceId);
      const fingerprint = serviceTitanObservationFingerprint(currentSource, currentBinding, report);
      const value = numericValue(nextInput.value);
      const prior = numericValue(nextInput.prior);
      const asOf = zonedLocalToIso(nextInput.asOf, currentBinding.timezone);
      const priorValid = !nextInput.prior.trim() || prior !== undefined;
      const sourceVersion = currentSource.method === "endpoint-recipe"
        ? currentSource.endpointRecipeVersion
        : report && Number.isFinite(Date.parse(report.modifiedOn)) ? Date.parse(report.modifiedOn) : undefined;
      const observation = value !== undefined && priorValid && asOf && fingerprint && sourceVersion
        ? { value, ...(prior !== undefined ? { prior } : {}), asOf, sourceFingerprint: fingerprint, sourceVersion, status: "valid" as const }
        : undefined;
      return {
        ...current,
        validationChecks: [],
        validatedAt: undefined,
        updatedAt: new Date().toISOString(),
        serviceTitanSource: {
          ...currentSource,
          tenantBindings: currentSource.tenantBindings.map((item) => bindingKey(item) === key
            ? { ...item, observation, prototypeValue: undefined, prototypePriorValue: undefined, prototypeAsOf: undefined }
            : item),
        },
      };
    });
    markChanged();
  }

  function updateTitle(title: string) {
    setDraft((current) => {
      const previousGenerated = slugifyKpiKey(current.title);
      const shouldUpdateKey = !current.key || current.key === previousGenerated;
      return { ...current, title, key: shouldUpdateKey ? slugifyKpiKey(title) : current.key, validationChecks: [], validatedAt: undefined, updatedAt: new Date().toISOString() };
    });
    markChanged();
  }

  function toggleArray(field: "locationIds" | "roles" | "templateIds", value: string) {
    const current = draft[field];
    patch({ [field]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] });
  }

  function currentValidationContext(): CustomKpiValidationContext {
    return { ...validationContext, now: new Date().toISOString() };
  }

  function goNext() {
    const nextIssues = validateCustomKpiStep(draft, currentStep, catalog, definitions, currentValidationContext());
    setIssues(nextIssues);
    if (nextIssues.some((issue) => issue.severity === "error")) return;
    if (stepIndex < wizardSteps.length - 1) setStepIndex(stepIndex + 1);
  }

  function runValidation() {
    const now = new Date().toISOString();
    setContextNow(now);
    const result = runCustomKpiValidation(draft, catalog, definitions, { ...validationContext, now });
    setDraft({ ...draft, validationChecks: result.checks, validatedAt: now, updatedAt: now });
    setIssues(result.issues);
  }

  function saveDraft() {
    const next = { ...draft, status: "draft" as const, updatedAt: new Date().toISOString() };
    if (!onSaveDraft(next)) {
      setSaved(false);
      setPersistenceError("The draft could not be written to browser storage. It remains open and was not treated as saved.");
      return;
    }
    setDraft(next);
    setPersistenceError("");
    setSaved(true);
  }

  function publish() {
    const now = new Date().toISOString();
    setContextNow(now);
    const liveContext = { ...validationContext, now };
    const technical = runCustomKpiValidation(draft, catalog, definitions, liveContext);
    const publishIssues = validateCustomKpiStep(draft, "publish", catalog, definitions, liveContext);
    const combined = [...technical.issues, ...publishIssues];
    setIssues(combined);
    if (combined.some((issue) => issue.severity === "error")) return;
    const next = { ...draft, status: "published" as const, version: initial?.status === "published" ? initial.version + 1 : draft.version, validationChecks: technical.checks, validatedAt: now, updatedAt: now, publishedAt: now };
    if (!onPublish(next)) {
      setSaved(false);
      setPersistenceError("The KPI could not be written to browser storage. The builder remains open and nothing was treated as published.");
      return;
    }
    setPersistenceError("");
  }

  function renderScalarParameterInput(binding: ServiceTitanTenantBinding, parameter: ServiceTitanReportParameter, value: ServiceTitanReportParameterScalar | undefined, onChange: (value: ServiceTitanReportParameterScalar | undefined) => void, label: string) {
    if (parameter.dataType === "Boolean") {
      return <select aria-label={label} value={value === undefined ? "" : String(value)} onChange={(event) => onChange(parseParameterScalar(event.target.value, parameter.dataType))}>
        <option value="">Select…</option><option value="true">True</option><option value="false">False</option>
      </select>;
    }
    return <input
      aria-label={label}
      type={parameterInputType(parameter.dataType)}
      step={parameter.dataType === "Number" ? "any" : undefined}
      value={value === undefined ? "" : String(value)}
      onChange={(event) => onChange(parseParameterScalar(event.target.value, parameter.dataType))}
    />;
  }

  function renderReportParameters(binding: ServiceTitanTenantBinding, report: ServiceTitanReportSource) {
    if (!report.parameters.length) return <div className="st-parameter-empty"><CheckCircle2 size={16}/><span>This approved report declares no runtime parameters.</span></div>;
    const parameterIssues = validateReportParameterValues(report.parameters, binding.parameterValues ?? {});
    return <fieldset className="binding-parameters"><legend>Typed report parameters</legend><p>Values are validated against the registered ServiceTitan parameter metadata; no free-form field definitions are accepted.</p>
      <div className="binding-parameter-list">{report.parameters.map((parameter) => {
        const stored = binding.parameterValues?.[parameter.name];
        const values = Array.isArray(stored) ? stored : [];
        const relatedIssues = parameterIssues.filter((message) => message.includes(parameter.name));
        return <div className={`binding-parameter ${relatedIssues.length ? "invalid" : "valid"}`} key={parameter.name}>
          <div className="binding-parameter-head"><div><strong>{parameter.label}</strong><code>{parameter.name}</code></div><div className="parameter-badges"><span>{parameter.dataType}{parameter.isArray ? "[]" : ""}</span><span className={parameter.isRequired ? "required" : "optional"}>{parameter.isRequired ? "Required" : "Optional"}</span>{parameter.dynamicSetId && <span className="dynamic">Dynamic: {parameter.dynamicSetId}</span>}</div></div>
          {parameter.isArray ? <div className="array-parameter-editor">
            {values.map((item, index) => <div className="array-parameter-row" key={`${parameter.name}-${index}`}>
              {renderScalarParameterInput(binding, parameter, item, (nextItem) => {
                const next = [...values];
                if (nextItem === undefined) next.splice(index, 1); else next[index] = nextItem;
                patchParameterValue(binding, parameter, next);
              }, `${parameter.label} item ${index + 1}`)}
              <button type="button" className="remove-array-value" aria-label={`Remove ${parameter.label} item ${index + 1}`} onClick={() => patchParameterValue(binding, parameter, values.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={14}/></button>
            </div>)}
            <button type="button" className="add-array-value" onClick={() => patchParameterValue(binding, parameter, [...values, defaultParameterScalar(parameter.dataType)])}><Plus size={14}/>Add {parameter.label} value</button>
          </div> : renderScalarParameterInput(binding, parameter, Array.isArray(stored) ? undefined : stored, (value) => patchParameterValue(binding, parameter, value), parameter.label)}
          {parameter.dynamicSetId === "business-units" && <div className="business-unit-map"><span>Exact location mapping</span><strong>{binding.locationIds?.[0]} → {binding.businessUnitMappings?.[binding.locationIds?.[0] ?? ""]?.join(", ") || "Not mapped"}</strong></div>}
          {relatedIssues.length ? <small role="alert">{relatedIssues.join(" ")}</small> : <small><Check size={12}/> Parameter value matches registered metadata.</small>}
        </div>;
      })}</div>
    </fieldset>;
  }

  function readinessForBinding(binding: ServiceTitanTenantBinding): ReadinessItem[] {
    if (!source) return [];
    const locationId = binding.locationIds?.[0];
    const connection = connections.find((item) => item.id === binding.connectionId);
    const connectionReady = Boolean(locationId && connection?.status === "ready" && connection.tenantId === binding.tenantId && connection.locationIds.includes(locationId));
    const recipe = source.method === "endpoint-recipe"
      ? serviceTitanEndpointRecipes.find((item) => item.id === source.endpointRecipeId && item.version === source.endpointRecipeVersion)
      : undefined;
    const report = source.method === "saved-report" ? serviceTitanReports.find((item) => item.id === binding.reportSourceId) : undefined;
    const reportReady = source.method === "endpoint-recipe"
      ? Boolean(recipe && connection?.capabilities.includes(recipe.capability))
      : Boolean(report && report.lifecycle === "approved" && report.status === "active" && report.connectionId === binding.connectionId && report.tenantId === binding.tenantId);
    const schemaReady = source.method === "endpoint-recipe"
      ? Boolean(recipe)
      : Boolean(reportHasSchemaMatch(report) && binding.expectedSchemaFingerprint === report?.expectedSchemaFingerprint);
    const fingerprint = serviceTitanObservationFingerprint(source, binding, report);
    const sampleReady = source.method === "endpoint-recipe"
      ? Boolean(recipe)
      : Boolean(binding.sampleEvidence?.status === "pass" && binding.sampleEvidence.sourceFingerprint === fingerprint);
    const reconciliationReady = source.method === "endpoint-recipe"
      ? Boolean(recipe)
      : Boolean(binding.reconciliationEvidence?.status === "pass" && binding.reconciliationEvidence.sourceFingerprint === fingerprint);
    const parameterMessages = report ? validateReportParameterValues(report.parameters, binding.parameterValues ?? {}) : [];
    const dynamicReady = !report || report.parameters.filter((parameter) => parameter.dynamicSetId === "business-units").every((parameter) => {
      if (!locationId) return false;
      const mapped = binding.businessUnitMappings?.[locationId];
      const supplied = binding.parameterValues?.[parameter.name];
      return Boolean(mapped?.length && Object.keys(binding.businessUnitMappings ?? {}).length === 1 && Array.isArray(supplied)
        && supplied.length === mapped?.length && [...supplied].map(String).sort().every((value, index) => value === [...mapped!].sort()[index]));
    });
    const parametersReady = source.method === "endpoint-recipe" || Boolean(report && !parameterMessages.length && dynamicReady);
    const expectedVersion = source.method === "endpoint-recipe"
      ? source.endpointRecipeVersion
      : report && Number.isFinite(Date.parse(report.modifiedOn)) ? Date.parse(report.modifiedOn) : undefined;
    const staleHours = staleHoursForRefresh(source.refreshInterval);
    const observedAt = binding.observation ? Date.parse(binding.observation.asOf) : Number.NaN;
    const evaluatedAt = Date.parse(contextNow);
    const observationReady = Boolean(binding.observation && binding.observation.status === "valid" && Number.isFinite(binding.observation.value)
      && binding.observation.sourceFingerprint === fingerprint && binding.observation.sourceVersion === expectedVersion
      && Number.isFinite(observedAt) && observedAt <= evaluatedAt && staleHours !== undefined && evaluatedAt - observedAt <= staleHours * 60 * 60 * 1000);
    return [
      { id: "connection", label: "Connection", ready: connectionReady, detail: connectionReady ? `Ready and assigned to ${locationId}.` : "Needs a ready tenant-matched connection assigned to this location." },
      { id: "source", label: "Report / recipe", ready: reportReady, detail: reportReady ? `${recipe?.name ?? report?.name} is current and allowed.` : "Select an available governed source with the required capability." },
      { id: "schema", label: "Schema", ready: schemaReady, detail: source.method === "endpoint-recipe" ? "Versioned recipe output contract is governed." : schemaReady ? "Expected and observed fingerprints match the binding." : "Expected, observed, and bound schema fingerprints must match." },
      { id: "sample", label: "Sample", ready: sampleReady, detail: source.method === "endpoint-recipe" ? "Covered by the approved recipe contract." : `Binding sample: ${binding.sampleEvidence?.status ?? "missing"}${sampleReady ? " · exact source fingerprint" : ""}.` },
      { id: "reconciliation", label: "Reconciliation", ready: reconciliationReady, detail: source.method === "endpoint-recipe" ? "Covered by the approved recipe contract." : `Binding reconciliation: ${binding.reconciliationEvidence?.status ?? "missing"}${reconciliationReady ? " · exact source fingerprint" : ""}.` },
      { id: "parameters", label: "Parameters", ready: parametersReady, detail: source.method === "endpoint-recipe" ? "Recipe inputs are governed by exact location scope." : parametersReady ? "All registered parameters and dynamic mappings are exact." : parameterMessages[0] ?? "Dynamic business-unit mapping is incomplete." },
      { id: "observation", label: "Observation freshness", ready: observationReady, detail: observationReady ? `Valid through the ${cadence?.label ?? source.refreshInterval} freshness contract.` : "Enter a fresh local observation after all source-contract edits." },
    ];
  }

  const publicationBlockedReasons = useMemo(() => {
    const technical = runCustomKpiValidation(draft, catalog, definitions, validationContext).issues;
    const publication = validateCustomKpiStep(draft, "publish", catalog, definitions, validationContext);
    return Array.from(new Set([...technical, ...publication].filter((issue) => issue.severity === "error").map((issue) => issue.message)));
  }, [draft, catalog, definitions, validationContext]);

  const completed = (index: number) => index < stepIndex;
  const previewBinding = source?.tenantBindings.find((binding) => binding.tenantId === previewLocation?.tenantId && binding.locationIds?.[0] === previewLocation?.id);
  const lastObservation = evaluation?.lastValidObservation ?? previewBinding?.observation;

  return <section className="kpi-wizard" aria-label="Custom KPI builder">
    <header className="wizard-header">
      <div><span>Governed KPI builder</span><h2>{draft.title || "New custom KPI"}</h2><p>Browser-local prototype · all observations are manually entered or simulated; no ServiceTitan API is called.</p></div>
      <div className="wizard-header-actions"><span className={`kpi-status ${draft.status}`}>{draft.status}</span><button type="button" className="icon-btn" aria-label="Close KPI builder" onClick={onCancel}><XCircle size={20}/></button></div>
    </header>
    <div className="wizard-stepper" aria-label="KPI builder steps">{wizardSteps.map((step, index) => <button type="button" key={step.id} className={index === stepIndex ? "active" : completed(index) ? "complete" : ""} aria-current={index === stepIndex ? "step" : undefined} disabled={index > stepIndex} onClick={() => { setIssues([]); setStepIndex(index); }}>
      <span>{completed(index) ? <Check size={14}/> : index + 1}</span><strong>{step.label}</strong>
    </button>)}</div>

    <div className="wizard-body">
      <div className="wizard-main">
        {currentStep === "definition" && <div className="wizard-panel"><div className="wizard-panel-title"><span>Step 1</span><h3>Define what this KPI means</h3><p>Choose a governed KPI type and document the business definition before configuring data.</p></div>
          <div className="kpi-type-grid">{typeOptions.map(({id,title,copy,icon:Icon}) => <button type="button" className={draft.type === id ? "selected" : ""} aria-pressed={draft.type === id} key={id} onClick={() => selectType(id)}><Icon size={20}/><strong>{title}</strong><span>{copy}</span></button>)}</div>
          <div className="wizard-form-grid"><label>KPI name<input value={draft.title} onChange={(event) => updateTitle(event.target.value)} placeholder="e.g. Plumbing booking rate" aria-invalid={issues.some((issue) => issue.code === "title")}/></label><label>Stable KPI key<input value={draft.key} onChange={(event) => patch({key:slugifyKpiKey(event.target.value)})} placeholder="plumbing-booking-rate" aria-invalid={issues.some((issue) => issue.code.includes("key"))}/></label><label className="span-two">Business definition<textarea value={draft.definition} onChange={(event) => patch({definition:event.target.value})} placeholder="Define the numerator, denominator, exclusions, and operating meaning in plain language."/></label><label>Definition owner<input value={draft.owner} onChange={(event) => patch({owner:event.target.value})} placeholder="e.g. Call Center"/></label><label>Dashboard tab<select value={draft.section} onChange={(event) => patch({section:event.target.value as MetricSection})}>{Object.entries(sectionMeta).map(([id,meta]) => <option key={id} value={id}>{meta.label}</option>)}</select></label><label>Card format<select value={draft.kind} disabled={draft.type === "service-titan" && source?.method === "endpoint-recipe"} onChange={(event) => patch({kind:event.target.value as MetricKind})}><option value="number">Number</option><option value="currency">Currency</option><option value="percent">Percent</option><option value="ratio">Ratio</option></select></label><label>Favorable direction<select value={draft.direction} onChange={(event) => patch({direction:event.target.value as CustomKpiDefinition["direction"]})}><option value="higher">Higher is better</option><option value="lower">Lower is better</option><option value="informational">Informational only</option></select></label><label className="span-two">Card supporting label<input value={draft.subtitle} onChange={(event) => patch({subtitle:event.target.value})} placeholder="Short context shown under the current value"/></label></div>
        </div>}

        {currentStep === "scope" && <div className="wizard-panel"><div className="wizard-panel-title"><span>Step 2</span><h3>Set portfolio scope and access</h3><p>Each scoped location receives one exact tenant, connection, timezone, and observation binding.</p></div>
          <div className="choice-row"><button type="button" className={draft.scopeMode === "portfolio" ? "selected" : ""} aria-pressed={draft.scopeMode === "portfolio"} onClick={() => patch({scopeMode:"portfolio",locationIds:[]})}><Layers3/><strong>All current locations</strong><span>Available across the portfolio where each exact source binding is ready.</span></button><button type="button" className={draft.scopeMode === "selected-locations" ? "selected" : ""} aria-pressed={draft.scopeMode === "selected-locations"} onClick={() => patch({scopeMode:"selected-locations"})}><Gauge/><strong>Selected locations</strong><span>Restrict this definition and each materialized value to named locations.</span></button></div>
          {draft.scopeMode === "selected-locations" && <div className="selection-card"><strong>Eligible locations</strong>{locations.map((location) => <label key={location.id}><input type="checkbox" checked={draft.locationIds.includes(location.id)} onChange={() => toggleArray("locationIds",location.id)}/><span><b>{location.brand}</b>{location.location} · {location.tenantId} · {location.timezone}</span></label>)}</div>}
          <div className="selection-card"><strong>Roles allowed to view</strong>{roleOptions.map(([id,label]) => <label key={id}><input type="checkbox" checked={draft.roles.includes(id)} onChange={() => toggleArray("roles",id)}/><span><b>{label}</b>Role-level visibility is still subject to location scope.</span></label>)}</div>
        </div>}

        {currentStep === "source" && <div className="wizard-panel"><div className="wizard-panel-title"><span>Step 3</span><h3>Configure data lineage</h3><p>The selected KPI type controls which typed, governed source settings are allowed.</p></div>
          {draft.type === "catalog" && <div className="wizard-form-grid"><label className="span-two">Governed KPI to inherit<select value={draft.catalogMetricId ?? ""} onChange={(event) => { const metric=catalog.find((item) => item.id===event.target.value); patch({catalogMetricId:event.target.value,kind:metric?.kind??draft.kind,section:metric?.section??draft.section}); }}><option value="">Select a core KPI…</option>{catalog.map((metric) => <option value={metric.id} key={metric.id}>{sectionMeta[metric.section].label} · {metric.title}</option>)}</select></label><div className="lineage-note span-two"><ShieldCheck/><div><strong>Formula and source remain governed</strong><p>This variant inherits the selected KPI&apos;s value, period, source, and lineage.</p></div></div></div>}
          {draft.type === "derived" && <div className="lineage-note"><Calculator/><div><strong>Controlled formula source</strong><p>Calculation inputs are limited to governed core KPIs and published custom KPIs. Free-form SQL and JavaScript are not allowed.</p></div></div>}
          {draft.type === "service-titan" && source && <>
            <div className="st-method-grid">
              <button type="button" className={source.method === "endpoint-recipe" ? "selected" : ""} aria-pressed={source.method === "endpoint-recipe"} onClick={() => selectServiceTitanMethod("endpoint-recipe")}><Database/><div><strong>Approved endpoint recipe</strong><span>Versioned allowlist · typed output · recipe capability gate</span><small>Location-timezone calendar boundaries; cadence-specific stale cutoff.</small></div></button>
              <button type="button" className={source.method === "saved-report" ? "selected" : ""} aria-pressed={source.method === "saved-report"} onClick={() => selectServiceTitanMethod("saved-report")}><FileInput/><div><strong>Approved saved report</strong><span>Reporting API v2 IDs · inspected schema · reconciled sample</span><small>Typed report parameters; 4/12/24-hour cadence and fail-closed stale values.</small></div></button>
            </div>
            <div className="wizard-form-grid source-controls">
              {source.method === "endpoint-recipe" && <label className="span-two">Endpoint recipe<select value={source.endpointRecipeId ?? ""} onChange={(event) => { const recipe=selectableServiceTitanEndpointRecipes.find((item) => item.id===event.target.value); if (recipe) { setObservationDrafts({}); patch({kind:recipe.outputKind,serviceTitanSource:clearObservations({...source,endpointRecipeId:recipe.id,endpointRecipeVersion:recipe.version,refreshInterval:recipe.defaultRefreshInterval})}); } }}><option value="">Select recipe…</option>{selectableServiceTitanEndpointRecipes.map((recipe) => <option value={recipe.id} key={`${recipe.id}:${recipe.version}`}>{recipe.name} · v{recipe.version} · {recipe.outputKind}</option>)}</select></label>}
              <label>Data refresh frequency<select value={source.refreshInterval} onChange={(event) => patchServiceTitanSource({refreshInterval:event.target.value as ServiceTitanRefreshInterval})}>{refreshOptionsForMethod(source.method).filter((option) => !selectedRecipe || selectedRecipe.allowedRefreshIntervals.includes(option.id)).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select><small className="input-help">{cadence?.description}</small></label>
              <label>Automatic stale threshold<input readOnly value={staleHoursForRefresh(source.refreshInterval) ? `${staleHoursForRefresh(source.refreshInterval)} hours after as-of` : "Not set"}/><small className="input-help">A stale observation is shown only as unavailable history.</small></label>
            </div>
            {selectedRecipe && <article className="endpoint-recipe-card" aria-label="Selected endpoint recipe contract"><div className="recipe-card-head"><div><span>Endpoint recipe contract</span><h4>{selectedRecipe.name}</h4><p>{selectedRecipe.description}</p></div><span className="recipe-version">v{selectedRecipe.version}</span></div><dl><div><dt>Recipe ID</dt><dd><code>{selectedRecipe.id}</code></dd></div><div><dt>Capability</dt><dd>{selectedRecipe.capability}</dd></div><div><dt>Lineage</dt><dd>{selectedRecipe.lineage}</dd></div><div><dt>Output kind</dt><dd>{selectedRecipe.outputKind}</dd></div><div><dt>Date boundary</dt><dd>Calendar boundaries in each exact binding timezone; period start inclusive and end exclusive.</dd></div><div><dt>Cadence / stale</dt><dd>{cadence?.label}; stale after {cadence?.staleAfterHours} hours. Future or stale observations fail closed.</dd></div></dl></article>}
            <div className="lineage-note warning"><CircleAlert/><div><strong>Public demo boundary</strong><p>These settings model production contracts, but this browser does not call ServiceTitan. Every displayed observation below is manually entered and stored locally.</p></div></div>
            <div className="tenant-binding-list"><div className="tenant-binding-head"><strong>Exact location source coverage</strong><span>{source.tenantBindings.length} bindings · {new Set(source.tenantBindings.map((binding) => binding.tenantId)).size} tenants</span></div>{source.tenantBindings.map((binding) => {
              const locationId=binding.locationIds?.[0];
              const location=locations.find((item) => item.id===locationId && item.tenantId===binding.tenantId);
              const matchingConnections=connections.filter((connection) => connection.tenantId===binding.tenantId && connection.locationIds.includes(locationId ?? "") && connection.status!=="archived");
              const matchingReports=serviceTitanReports.filter((report) => report.tenantId===binding.tenantId && report.connectionId===binding.connectionId && report.status==="active" && report.lifecycle==="approved");
              const report=matchingReports.find((item) => item.id===binding.reportSourceId);
              return <section className="tenant-binding-card" key={bindingKey(binding)}><div className="binding-card-head"><div><strong>{location?.brand ?? binding.tenantId} · {location?.location ?? locationId}</strong><span>Tenant <code>{binding.tenantId}</code> · Location <code>{locationId}</code> · {binding.timezone}</span></div><span className="exact-binding-badge">1 exact location</span></div>
                <div className="wizard-form-grid"><label>ServiceTitan connection<select value={binding.connectionId} onChange={(event) => patchTenantBinding(binding.tenantId,locationId ?? "",{connectionId:event.target.value,reportSourceId:undefined,expectedSchemaFingerprint:undefined,reportSchemaFingerprint:undefined,parameterValues:undefined,businessUnitMappings:undefined,valueField:undefined,numeratorField:undefined,denominatorField:undefined})}><option value="">Select assigned connection…</option>{matchingConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName} · {connection.status} · {connection.id}</option>)}</select><small className="input-help">Only tenant-matched connections assigned to this location are shown.</small></label>{source.method === "saved-report" && <label>Approved saved report<select value={binding.reportSourceId ?? ""} onChange={(event) => selectReport(binding,event.target.value)}><option value="">Select active approved report…</option>{matchingReports.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.categoryId}/{item.reportId}</option>)}</select><small className="input-help">Only active, lifecycle-approved reports for this exact connection and tenant are eligible.</small></label>}</div>
                {source.method === "saved-report" && report && <article className="selected-report-card"><div className="selected-report-title"><div><span>Approved saved report</span><strong>{report.name}</strong></div><span className="validation-chip pass">{report.lifecycle}</span></div><dl><div><dt>Registry ID</dt><dd><code>{report.id}</code></dd></div><div><dt>ServiceTitan IDs</dt><dd><code>{report.categoryId}/{report.reportId}</code></dd></div><div><dt>Modified on</dt><dd>{report.modifiedOn}</dd></div><div><dt>Verification</dt><dd>{report.verification}{report.inspectedAt ? ` · ${report.inspectedAt}` : ""}</dd></div><div><dt>Schema</dt><dd className={reportHasSchemaMatch(report) ? "ready-text" : "blocked-text"}>{reportHasSchemaMatch(report) ? "Match" : "Drift"} · <code>{report.expectedSchemaFingerprint}</code></dd></div><div><dt>Sample</dt><dd>{report.sampleEvidence?.status ?? "missing"}{report.sampleEvidence ? ` · ${report.sampleEvidence.rowCount} rows · ${report.sampleEvidence.sampledAt}` : ""}</dd></div><div><dt>Reconciliation</dt><dd>{report.reconciliationEvidence?.status ?? "missing"}{report.reconciliationEvidence ? ` · Δ ${report.reconciliationEvidence.delta} / tolerance ${report.reconciliationEvidence.tolerance}` : ""}</dd></div></dl></article>}
                {source.method === "saved-report" && report && renderReportParameters(binding,report)}
              </section>;
            })}</div>
          </>}
          {draft.type === "manual" && <div className="wizard-form-grid"><label>Update cadence<select value={draft.refreshCadence} onChange={(event) => patch({refreshCadence:event.target.value as CustomKpiDefinition["refreshCadence"]})}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="ad-hoc">Ad hoc</option></select></label><label>Stale after hours<input type="number" min="1" value={draft.staleAfterHours ?? ""} onChange={(event) => patch({staleAfterHours:numericValue(event.target.value)})}/></label></div>}
          {draft.type === "external" && <div className="wizard-form-grid"><label>External provider<select value={draft.provider ?? ""} onChange={(event) => { const provider=event.target.value as CustomKpiDefinition["provider"]; patch({provider,externalDatasetId:provider === "Domo" ? draft.externalDatasetId : undefined}); }}><option value="">Select provider…</option><option>Domo</option><option>GA4</option><option>Google Business Profile</option><option>Call System</option><option>Finance</option><option>Other</option></select></label>{draft.provider === "Domo" && <label>Domo dataset ID<input value={draft.externalDatasetId ?? ""} onChange={(event) => patch({externalDatasetId:event.target.value})}/></label>}<label>Metric / column key<input value={draft.externalMetricKey ?? ""} onChange={(event) => patch({externalMetricKey:event.target.value})}/></label><label>Expected refresh<select value={draft.refreshCadence} onChange={(event) => patch({refreshCadence:event.target.value as CustomKpiDefinition["refreshCadence"]})}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="ad-hoc">Ad hoc</option></select></label><label>Stale after hours<input type="number" min="1" value={draft.staleAfterHours ?? ""} onChange={(event) => patch({staleAfterHours:numericValue(event.target.value)})}/></label></div>}
        </div>}

        {currentStep === "calculation" && <div className="wizard-panel"><div className="wizard-panel-title"><span>Step 4</span><h3>Configure calculation and local observation</h3><p>Saved reports reduce typed rows through a governed field mapping. Demo observations are manually entered and local only.</p></div>
          {draft.type === "derived" && <div className="formula-builder"><label>First KPI<select value={draft.leftMetricId ?? ""} onChange={(event) => patch({leftMetricId:event.target.value})}><option value="">Select KPI…</option>{dependencyOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label><label>Operation<select value={draft.operation ?? ""} onChange={(event) => patch({operation:event.target.value as CustomKpiDefinition["operation"],kind:event.target.value === "percent" ? "percent" : draft.kind})}><option value="">Select…</option><option value="add">Add</option><option value="subtract">Subtract</option><option value="multiply">Multiply</option><option value="divide">Divide</option><option value="percent">Percent of</option></select></label><label>Second KPI<select value={draft.rightMetricId ?? ""} onChange={(event) => patch({rightMetricId:event.target.value})}><option value="">Select KPI…</option>{dependencyOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label></div>}
          {draft.type === "service-titan" && source && <div className="st-calculation-panel">
            {source.method === "saved-report" && <div className="wizard-form-grid"><label className="span-two">Report row reduction<select value={source.reportReduction ?? ""} onChange={(event) => patchServiceTitanSource({reportReduction:event.target.value as ServiceTitanReportReduction,tenantBindings:source.tenantBindings.map((binding) => ({...binding,valueField:undefined,numeratorField:undefined,denominatorField:undefined}))})}><option value="">Select reduction…</option>{reportReductions.map((option) => <option value={option.id} key={option.id}>{option.label} · {option.copy}</option>)}</select></label></div>}
            <div className="tenant-binding-list">{source.tenantBindings.map((binding) => {
              const locationId=binding.locationIds?.[0] ?? "";
              const location=locations.find((item) => item.id===locationId);
              const report=serviceTitanReports.find((item) => item.id===binding.reportSourceId);
              const numericFields=report?.fields.filter((field) => field.type==="number") ?? [];
              const input=observationInput(binding);
              const readiness=readinessForBinding(binding);
              return <section className="tenant-binding-card calculation-binding" key={bindingKey(binding)}><div className="binding-card-head"><div><strong>{location?.brand ?? binding.tenantId} · {location?.location ?? locationId}</strong><span>{source.method === "saved-report" ? report?.name ?? "Saved report not selected" : selectedRecipe?.name ?? "Recipe not selected"} · {binding.timezone}</span></div><span className="exact-binding-badge">{bindingKey(binding)}</span></div>
                {source.method === "saved-report" && source.reportReduction && source.reportReduction!=="count" && <div className="wizard-form-grid field-mapping">{source.reportReduction==="ratio" ? <><label>Numerator field<select value={binding.numeratorField ?? ""} onChange={(event) => patchTenantBinding(binding.tenantId,locationId,{numeratorField:event.target.value})}><option value="">Select numeric field…</option>{numericFields.map((field) => <option disabled={field.name === binding.denominatorField} key={field.name} value={field.name}>{field.label} · {field.name}</option>)}</select></label><label>Distinct denominator field<select value={binding.denominatorField ?? ""} onChange={(event) => patchTenantBinding(binding.tenantId,locationId,{denominatorField:event.target.value})}><option value="">Select different numeric field…</option>{numericFields.map((field) => <option disabled={field.name === binding.numeratorField} key={field.name} value={field.name}>{field.label} · {field.name}</option>)}</select></label></> : <label className="span-two">Numeric value field<select value={binding.valueField ?? ""} onChange={(event) => patchTenantBinding(binding.tenantId,locationId,{valueField:event.target.value})}><option value="">Select numeric field…</option>{numericFields.map((field) => <option key={field.name} value={field.name}>{field.label} · {field.name}</option>)}</select></label>}</div>}
                {source.method === "saved-report" && source.reportReduction === "count" && <div className="field-count-note"><CheckCircle2 size={16}/><span>Count reduction uses eligible row count; no numeric value field is required.</span></div>}
                <fieldset className="observation-editor"><legend>Local simulated observation</legend><p>Editing these fields materializes a real browser-local observation tied to the exact current source fingerprint and version. It is never fetched from ServiceTitan.</p><div className="wizard-form-grid"><label>Value<input type="number" step="any" value={input.value} onChange={(event) => editObservation(binding,"value",event.target.value)}/></label><label>Prior value (optional)<input type="number" step="any" value={input.prior} onChange={(event) => editObservation(binding,"prior",event.target.value)}/></label><label className="span-two">As-of datetime ({binding.timezone})<input type="datetime-local" value={input.asOf} onChange={(event) => editObservation(binding,"asOf",event.target.value)}/><small className="input-help">Interpreted in the exact location timezone and stored as an ISO timestamp.</small></label></div>{binding.observation ? <div className="observation-contract ready"><CheckCircle2 size={16}/><div><strong>Materialized locally · status valid</strong><code>{binding.observation.sourceFingerprint} · source v{binding.observation.sourceVersion} · {binding.observation.asOf}</code></div></div> : <div className="observation-contract blocked"><CircleAlert size={16}/><div><strong>Observation not materialized</strong><span>Complete the governed source, typed inputs, value, and valid local datetime.</span></div></div>}</fieldset>
                <div className="binding-readiness"><div className="binding-readiness-head"><strong>Binding readiness checklist</strong><span>{readiness.filter((item) => item.ready).length}/{readiness.length} ready</span></div>{readiness.map((item) => <div className={item.ready ? "ready" : "blocked"} key={item.id}>{item.ready ? <CheckCircle2 size={16}/> : <XCircle size={16}/>}<div><strong>{item.label}</strong><span>{item.detail}</span></div></div>)}</div>
              </section>;
            })}</div>
            <div className="lineage-note warning"><CircleAlert/><div><strong>Contract edits invalidate observations</strong><p>Changing connection, report, parameters, business-unit mapping, reduction, fields, recipe, or cadence clears the old materialized observation. Re-enter it only after reviewing the new contract.</p></div></div>
          </div>}
          {(draft.type === "manual" || draft.type === "external") && <div className="wizard-form-grid"><label>Prototype observation<input type="number" step="any" value={draft.manualValue ?? ""} onChange={(event) => patch({manualValue:numericValue(event.target.value)})}/></label><label>Prior value (optional)<input type="number" step="any" value={draft.priorValue ?? ""} onChange={(event) => patch({priorValue:numericValue(event.target.value)})}/></label><label>As-of datetime<input type="datetime-local" value={draft.asOf ? draft.asOf.slice(0,16) : ""} onChange={(event) => patch({asOf:event.target.value ? new Date(event.target.value).toISOString() : undefined})}/></label></div>}
          {draft.type === "catalog" && <div className="lineage-note"><Layers3/><div><strong>No formula override permitted</strong><p>The selected governed KPI supplies the calculation.</p></div></div>}
          <div className="wizard-form-grid target-fields"><label>Target (optional)<input type="number" step="any" value={draft.goal ?? ""} onChange={(event) => patch({goal:numericValue(event.target.value)})}/></label><label>Watch threshold (% attainment)<input type="number" min="1" max="100" value={draft.warningAt ?? ""} onChange={(event) => patch({warningAt:numericValue(event.target.value)})} placeholder="e.g. 95"/></label></div>
          <div className={`formula-preview ${evaluation?.state === "unavailable" ? "unavailable" : ""}`} aria-live="polite"><span>Exact-context preview{previewLocation ? ` · ${previewLocation.tenantId}/${previewLocation.id}` : ""}</span><strong>{evaluation?.state === "available" && evaluation.value !== undefined ? formatMetric(evaluation.value,draft.kind) : "Unavailable"}</strong><p>{evaluation?.state === "available" ? `Lineage: ${evaluation.lineage.join(" → ")}` : evaluation?.reason ?? "Complete the calculation to preview this KPI."}</p>{evaluation?.state === "unavailable" && lastObservation && <div className="last-observation"><span>Last observation (not used)</span><code>{lastObservation.value} · {lastObservation.asOf} · {lastObservation.sourceFingerprint}</code></div>}</div>
        </div>}

        {currentStep === "validate" && <div className="wizard-panel"><div className="wizard-panel-title"><span>Step 5</span><h3>Validate before publication</h3><p>Validation evaluates every scoped location independently at the current time and fails closed.</p></div>
          <button type="button" className="button primary run-validation" onClick={runValidation}><ShieldCheck size={16}/>Run validation now</button>
          {!draft.validationChecks.length ? <div className="validation-empty"><ShieldCheck/><strong>Validation has not run</strong><p>Publishing remains blocked until all required checks pass.</p></div> : <div className="validation-results">{draft.validationChecks.map((check) => <div className={check.status} key={check.id}>{check.status === "pass" ? <CheckCircle2/> : check.status === "warning" ? <CircleAlert/> : <XCircle/>}<div><strong>{check.label}</strong><p>{check.detail}</p></div><span>{check.status}</span></div>)}</div>}
          {previewMetric ? <div className="validation-preview"><div><span>Calculated value</span><strong>{formatMetric(previewMetric.actual,previewMetric.kind)}</strong></div><div><span>Target</span><strong>{previewMetric.goal === undefined ? "Not configured" : formatMetric(previewMetric.goal,previewMetric.kind)}</strong></div><div><span>Source lineage</span><strong>{evaluation?.lineage.join(" → ")}</strong></div></div> : <div className="unavailable-preview" role="status"><XCircle size={20}/><div><strong>Preview unavailable — failed closed</strong><p>{evaluation?.reason ?? "The current governed contract cannot produce an available value."}</p>{lastObservation && <small>Last observation retained as history only: {lastObservation.value} at {lastObservation.asOf}.</small>}</div></div>}
          {source && <div className="all-binding-readiness"><h4>All location bindings</h4>{source.tenantBindings.map((binding) => { const readiness=readinessForBinding(binding); return <section key={bindingKey(binding)}><strong>{bindingKey(binding)}</strong><span>{readiness.every((item) => item.ready) ? "Ready" : readiness.filter((item) => item.ready).length + "/7 ready"}</span><ul>{readiness.filter((item) => !item.ready).map((item) => <li key={item.id}>{item.label}: {item.detail}</li>)}</ul></section>; })}</div>}
        </div>}

        {currentStep === "publish" && <div className="wizard-panel"><div className="wizard-panel-title"><span>Step 6</span><h3>Assign and publish</h3><p>Choose role templates and record why this KPI is being introduced.</p></div>
          <div className="selection-card"><strong>Role-template assignment</strong>{templates.map((template) => <label key={template.id}><input type="checkbox" checked={draft.templateIds.includes(template.id)} onChange={() => toggleArray("templateIds",template.id)}/><span><b>{template.name}</b>{template.description}</span></label>)}</div>
          <div className="wizard-form-grid"><label className="span-two">Release note / business reason<textarea value={draft.releaseNote} onChange={(event) => patch({releaseNote:event.target.value})} placeholder="Why is this KPI being published and who approved the definition?"/></label></div>
          <div className="publish-summary"><div><span>Status</span><strong>{publicationBlockedReasons.length ? "Publication blocked" : "Ready for browser-local publication"}</strong></div><div><span>Scope</span><strong>{draft.scopeMode === "portfolio" ? `${scoped.length} current locations` : `${draft.locationIds.length} selected locations`}</strong></div><div><span>Templates</span><strong>{draft.templateIds.length}</strong></div><div><span>Validation</span><strong>{draft.validationChecks.some((check) => check.status==="fail") || !draft.validationChecks.length ? "Needs current passing validation" : "Passed with disclosed warnings"}</strong></div>{source && <><div><span>ServiceTitan source</span><strong>{source.method === "saved-report" ? "Approved saved report" : `Endpoint ${selectedRecipe?.id}@v${selectedRecipe?.version}`}</strong></div><div><span>Refresh</span><strong>{cadence?.label ?? source.refreshInterval} · stale after {cadence?.staleAfterHours ?? "?"}h</strong></div></>}</div>
          <div className={`publication-blockers ${publicationBlockedReasons.length ? "blocked" : "ready"}`} role="status"><div>{publicationBlockedReasons.length ? <XCircle size={18}/> : <CheckCircle2 size={18}/>}<strong>{publicationBlockedReasons.length ? `${publicationBlockedReasons.length} publication blocker${publicationBlockedReasons.length === 1 ? "" : "s"}` : "No live publication blockers"}</strong></div>{publicationBlockedReasons.length > 0 && <ul>{publicationBlockedReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}</div>
          <div className="lineage-note warning"><CircleAlert/><div><strong>Prototype publication boundary</strong><p>Publish writes this governed definition and manually entered observations to this browser only. No live ServiceTitan value is represented.</p></div></div>
        </div>}
        <StepIssues issues={issues}/>
        {persistenceError && <div className="wizard-issues" role="alert"><div className="error"><XCircle size={16}/><span>{persistenceError}</span></div></div>}
      </div>
      <aside className="wizard-summary"><span>Live definition</span><h3>{draft.title || "Untitled KPI"}</h3><dl><div><dt>Type</dt><dd>{typeOptions.find((item) => item.id===draft.type)?.title}</dd></div><div><dt>Owner</dt><dd>{draft.owner || "Not assigned"}</dd></div><div><dt>Section</dt><dd>{sectionMeta[draft.section].label}</dd></div><div><dt>Scope</dt><dd>{draft.scopeMode === "portfolio" ? `${scoped.length} locations` : `${draft.locationIds.length} locations`}</dd></div><div><dt>Format</dt><dd>{draft.kind}</dd></div>{source && <><div><dt>ST method</dt><dd>{source.method === "saved-report" ? "Saved report" : "Endpoint"}</dd></div><div><dt>Refresh</dt><dd>{cadence?.label ?? source.refreshInterval}</dd></div><div><dt>Exact bindings</dt><dd>{source.tenantBindings.length}</dd></div></>}<div><dt>Templates</dt><dd>{draft.templateIds.length}</dd></div></dl><div className={`summary-value ${evaluation?.state}`}><span>Preview{previewLocation ? ` · ${previewLocation.id}` : ""}</span><strong>{evaluation?.state === "available" && evaluation.value !== undefined ? formatMetric(evaluation.value,draft.kind) : "Unavailable"}</strong><p>{evaluation?.reason ?? evaluation?.warning ?? "Calculation available"}</p>{evaluation?.state === "unavailable" && lastObservation && <small>Last: {lastObservation.value} · {lastObservation.asOf}</small>}</div></aside>
    </div>

    <footer className="wizard-footer"><div>{saved ? <><CheckCircle2 size={16}/>Draft saved locally</> : <><CircleAlert size={16}/>Unsaved browser-local changes</>}</div><div><button type="button" className="button secondary" onClick={onCancel}>Cancel</button><button type="button" className="button secondary" onClick={saveDraft}><Save size={16}/>Save draft</button>{stepIndex > 0 && <button type="button" className="button secondary" onClick={() => {setIssues([]);setStepIndex(stepIndex-1);}}><ArrowLeft size={16}/>Back</button>}{currentStep !== "publish" ? <button type="button" className="button primary" onClick={goNext}>Continue<ArrowRight size={16}/></button> : <button type="button" className="button primary" disabled={publicationBlockedReasons.length > 0} onClick={publish}><Send size={16}/>Publish in this browser</button>}</div></footer>
  </section>;
}
