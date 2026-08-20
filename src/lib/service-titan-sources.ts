import type { DemoServiceTitanConnection } from "./demo-connections";

export const SERVICE_TITAN_SOURCE_STORAGE_KEY = "gmib.servicetitan-sources.v3";
export const SERVICE_TITAN_SOURCE_SCHEMA_VERSION = 3 as const;

export type ServiceTitanSourceMethod = "endpoint-recipe" | "saved-report";
export type ServiceTitanRefreshInterval = "15m" | "30m" | "1h" | "4h" | "12h" | "24h";
export type ServiceTitanReportReduction = "sum" | "average" | "count" | "latest" | "ratio";
export type ServiceTitanReportFieldType = "number" | "string" | "date" | "boolean";
export type ServiceTitanReportParameterDataType = "String" | "Number" | "Boolean" | "Date" | "Time";
export type ServiceTitanReportLifecycle = "draft" | "inspected" | "reconciled" | "approved" | "archived";
export type ServiceTitanReportSourceStatus = "active" | "archived";
export type ServiceTitanEvidenceStatus = "pending" | "pass" | "fail";
export type ServiceTitanReportParameterScalar = string | number | boolean;
export type ServiceTitanReportParameterValue = ServiceTitanReportParameterScalar | ServiceTitanReportParameterScalar[];

export interface RefreshOption {
  id: ServiceTitanRefreshInterval;
  label: string;
  staleAfterHours: number;
  description: string;
}

export const SERVICE_TITAN_ENDPOINT_REFRESH_OPTIONS: RefreshOption[] = [
  { id: "15m", label: "Every 15 minutes", staleAfterHours: 1, description: "Use only for high-priority operating KPIs." },
  { id: "30m", label: "Every 30 minutes", staleAfterHours: 2, description: "Good for dispatch and call-center visibility." },
  { id: "1h", label: "Hourly", staleAfterHours: 3, description: "Recommended default for most endpoint KPIs." },
  { id: "4h", label: "Every 4 hours", staleAfterHours: 8, description: "Lower API consumption for slower-moving metrics." },
  { id: "24h", label: "Daily", staleAfterHours: 36, description: "Use for metrics that do not need intraday updates." },
];

export const SERVICE_TITAN_REPORT_REFRESH_OPTIONS: RefreshOption[] = [
  { id: "4h", label: "Every 4 hours", staleAfterHours: 8, description: "Fastest permitted saved-report schedule in this application." },
  { id: "12h", label: "Every 12 hours", staleAfterHours: 18, description: "Balanced option for twice-daily report snapshots." },
  { id: "24h", label: "Daily", staleAfterHours: 36, description: "Recommended default for saved ServiceTitan reports." },
];

export interface ServiceTitanEndpointRecipe {
  id: string;
  version: number;
  name: string;
  description: string;
  capability: string;
  outputKind: "currency" | "number" | "percent" | "ratio";
  defaultRefreshInterval: ServiceTitanRefreshInterval;
  allowedRefreshIntervals: ServiceTitanRefreshInterval[];
  lineage: string;
}

export const serviceTitanEndpointRecipes: ServiceTitanEndpointRecipe[] = [
  { id: "completed-revenue", version: 1, name: "Completed revenue", description: "Completed jobs and invoice actuals filtered through governed business-unit and revenue mappings.", capability: "jobs", outputKind: "currency", defaultRefreshInterval: "1h", allowedRefreshIntervals: ["15m", "30m", "1h", "4h", "24h"], lineage: "Jobs + invoices" },
  { id: "completed-appointments", version: 1, name: "Completed appointments", description: "Completed appointment count using governed status, cancellation, recall, and business-unit mappings.", capability: "appointments", outputKind: "number", defaultRefreshInterval: "1h", allowedRefreshIntervals: ["15m", "30m", "1h", "4h", "24h"], lineage: "Appointments + status mapping" },
  { id: "sales-close-rate", version: 1, name: "Sales close rate", description: "Sold estimates divided by governed sales opportunities for the selected location and period.", capability: "estimates", outputKind: "percent", defaultRefreshInterval: "1h", allowedRefreshIntervals: ["30m", "1h", "4h", "24h"], lineage: "Estimates + opportunity mapping" },
  { id: "active-memberships", version: 1, name: "Active memberships", description: "Active customer memberships after tenant-specific tier and status mapping.", capability: "memberships", outputKind: "number", defaultRefreshInterval: "4h", allowedRefreshIntervals: ["1h", "4h", "24h"], lineage: "Customer memberships + tier mapping" },
  { id: "inbound-call-booking-rate", version: 1, name: "Inbound call booking rate", description: "Booked eligible calls divided by eligible inbound calls when Call Center API access is available.", capability: "call-center", outputKind: "percent", defaultRefreshInterval: "30m", allowedRefreshIntervals: ["15m", "30m", "1h", "4h"], lineage: "Call Center + booking eligibility mapping" },
  { id: "completed-jobs-count", version: 1, name: "Completed jobs count", description: "Completed job count for the period using governed business-unit mappings for department scoping.", capability: "jobs", outputKind: "number", defaultRefreshInterval: "1h", allowedRefreshIntervals: ["15m", "30m", "1h", "4h", "24h"], lineage: "Jobs + business-unit mapping" },
  { id: "average-invoice-ticket", version: 1, name: "Average invoice ticket", description: "Invoice total divided by invoice count for the period, filtered through governed business-unit mappings.", capability: "invoices", outputKind: "currency", defaultRefreshInterval: "1h", allowedRefreshIntervals: ["30m", "1h", "4h", "24h"], lineage: "Invoices + business-unit mapping" },
  { id: "inbound-calls-booked", version: 1, name: "Inbound calls booked", description: "Inbound calls with a job number attached, counted for the period.", capability: "call-center", outputKind: "number", defaultRefreshInterval: "30m", allowedRefreshIntervals: ["15m", "30m", "1h", "4h"], lineage: "Call Center + booking attachment" },
  { id: "inbound-calls-not-booked", version: 1, name: "Inbound calls not booked", description: "Non-abandoned inbound calls without a job number attached, counted for the period.", capability: "call-center", outputKind: "number", defaultRefreshInterval: "30m", allowedRefreshIntervals: ["15m", "30m", "1h", "4h"], lineage: "Call Center + booking attachment" },
];

export interface ServiceTitanReportParameter {
  name: string;
  label: string;
  dataType: ServiceTitanReportParameterDataType;
  isArray: boolean;
  isRequired: boolean;
  dynamicSetId?: string;
}

export interface ServiceTitanReportField {
  name: string;
  label: string;
  type: ServiceTitanReportFieldType;
}

export interface ServiceTitanSampleEvidence {
  rowCount: number;
  computedValue: number;
  status: ServiceTitanEvidenceStatus;
  sampledAt: string;
  sourceFingerprint: string;
}

export interface ServiceTitanReconciliationEvidence {
  expectedValue: number;
  /** Backwards-friendly name for displays that call the expected value a reference value. */
  referenceValue?: number;
  tolerance: number;
  delta: number;
  status: ServiceTitanEvidenceStatus;
  reconciledAt: string;
  sourceFingerprint: string;
}

export type ServiceTitanSampleEvidenceInput = Omit<ServiceTitanSampleEvidence, "sourceFingerprint"> & { sourceFingerprint?: string };
export type ServiceTitanReconciliationEvidenceInput = Omit<ServiceTitanReconciliationEvidence, "sourceFingerprint"> & { sourceFingerprint?: string };

export interface ServiceTitanReportOwner {
  id: string;
  name: string;
}

export interface ServiceTitanReportSource {
  id: string;
  connectionId: string;
  tenantId: string;
  categoryId: string;
  reportId: string;
  owner: ServiceTitanReportOwner;
  name: string;
  description: string;
  parameters: ServiceTitanReportParameter[];
  fields: ServiceTitanReportField[];
  expectedSchemaFingerprint: string;
  observedSchemaFingerprint?: string;
  /** Transitional alias; always equal to expectedSchemaFingerprint. */
  schemaFingerprint: string;
  modifiedOn: string;
  lifecycle: ServiceTitanReportLifecycle;
  status: ServiceTitanReportSourceStatus;
  verification: "demo" | "declared" | "inspected";
  sampleEvidence?: ServiceTitanSampleEvidence;
  reconciliationEvidence?: ServiceTitanReconciliationEvidence;
  inspectedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceTitanSourceStore {
  schemaVersion: typeof SERVICE_TITAN_SOURCE_SCHEMA_VERSION;
  reports: ServiceTitanReportSource[];
  availability?: "available" | "unavailable";
  unavailableReason?: string;
}

export interface ServiceTitanReportSourceInput {
  id?: string;
  connectionId: string;
  tenantId: string;
  categoryId: string;
  reportId: string;
  /** Required by validation; optional here only while the existing form migrates to structured owner input. */
  owner?: ServiceTitanReportOwner;
  name: string;
  description?: string;
  parameters?: ServiceTitanReportParameter[];
  fields: ServiceTitanReportField[];
  modifiedOn?: string;
  observedFields?: ServiceTitanReportField[];
  lifecycle?: ServiceTitanReportLifecycle;
  sampleEvidence?: ServiceTitanSampleEvidenceInput;
  reconciliationEvidence?: ServiceTitanReconciliationEvidenceInput;
}

export interface ReportSourceValidationIssue {
  code: string;
  field: keyof ServiceTitanReportSourceInput | "store";
  message: string;
}

const seedDate = "2026-08-17T00:00:00.000Z";
const PARAMETER_TYPES: ServiceTitanReportParameterDataType[] = ["String", "Number", "Boolean", "Date", "Time"];
const FIELD_TYPES: ServiceTitanReportFieldType[] = ["number", "string", "date", "boolean"];
const LIFECYCLES: ServiceTitanReportLifecycle[] = ["draft", "inspected", "reconciled", "approved", "archived"];
const EVIDENCE_STATUSES: ServiceTitanEvidenceStatus[] = ["pending", "pass", "fail"];
const SECRET_KEY = /(secret|password|authorization|access.?token|refresh.?token|client.?id|app.?key|api.?key|bearer)/i;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function containsSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretKey);
  if (!record(value)) return false;
  return Object.entries(value).some(([key, nested]) => SECRET_KEY.test(key) || containsSecretKey(nested));
}

export function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && Number.isFinite(Date.parse(value));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
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

export function reportSchemaFingerprint(fields: ServiceTitanReportField[]): string {
  // ServiceTitan report responses authoritatively expose ordered field names, not types.
  // Declared types remain validated reducer configuration; observed drift evidence covers
  // only provider metadata that can be independently observed.
  return `schema-v3.${base64Url(JSON.stringify(fields.map(({ name }) => name)))}`;
}

export function reportSourceFingerprint(report: Pick<ServiceTitanReportSource, "connectionId" | "tenantId" | "categoryId" | "reportId" | "owner" | "parameters" | "fields" | "modifiedOn">): string {
  return `report-source-v1.${base64Url(JSON.stringify({
    connectionId: report.connectionId,
    tenantId: report.tenantId,
    categoryId: report.categoryId,
    reportId: report.reportId,
    owner: report.owner,
    parameters: report.parameters,
    fields: report.fields,
    modifiedOn: report.modifiedOn,
  }))}`;
}

export function createServiceTitanReportSourceId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  return typeof randomUuid === "function"
    ? `st-report-${randomUuid.call(globalThis.crypto)}`
    : `st-report-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function seedReport(id: string, connectionId: string, tenantId: string, reportId: string): ServiceTitanReportSource {
  const parameters: ServiceTitanReportParameter[] = [
    { name: "From", label: "From", dataType: "Date", isArray: false, isRequired: true },
    { name: "To", label: "To", dataType: "Date", isArray: false, isRequired: true },
    { name: "BusinessUnitIds", label: "Business units", dataType: "Number", isArray: true, isRequired: true, dynamicSetId: "business-units" },
  ];
  const fields: ServiceTitanReportField[] = [
    { name: "BookedCalls", label: "Booked calls", type: "number" },
    { name: "EligibleCalls", label: "Eligible inbound calls", type: "number" },
    { name: "BusinessUnit", label: "Business unit", type: "string" },
    { name: "PeriodEnd", label: "Period end", type: "date" },
  ];
  const fingerprint = reportSchemaFingerprint(fields);
  const owner = { id: "gm-analytics", name: "GM Analytics" };
  const sourceFingerprint = reportSourceFingerprint({
    connectionId, tenantId, categoryId: "operations", reportId, owner, parameters, fields, modifiedOn: seedDate,
  });
  return {
    id, connectionId, tenantId, categoryId: "operations", reportId,
    owner,
    name: "GM Call Booking Detail",
    description: "Illustrative approved-report registration used to demonstrate tenant-specific field mapping.",
    parameters, fields,
    expectedSchemaFingerprint: fingerprint,
    observedSchemaFingerprint: fingerprint,
    schemaFingerprint: fingerprint,
    modifiedOn: seedDate,
    lifecycle: "approved",
    status: "active",
    verification: "demo",
    sampleEvidence: { rowCount: 25, computedValue: 70, status: "pass", sampledAt: seedDate, sourceFingerprint },
    reconciliationEvidence: { expectedValue: 70, referenceValue: 70, tolerance: 0.01, delta: 0, status: "pass", reconciledAt: seedDate, sourceFingerprint },
    inspectedAt: seedDate,
    createdAt: seedDate,
    updatedAt: seedDate,
  };
}

export function createSeedServiceTitanSourceStore(): ServiceTitanSourceStore {
  return {
    schemaVersion: SERVICE_TITAN_SOURCE_SCHEMA_VERSION,
    availability: "available",
    reports: [
      seedReport("st-report-sierra-booking", "st-sierra", "sierra", "100101"),
      seedReport("st-report-asi-booking", "st-asi", "asi", "200202"),
      seedReport("st-report-swan-booking", "st-swan", "swan", "300303"),
    ],
  };
}

function normalizedFields(fields: ServiceTitanReportField[]): ServiceTitanReportField[] {
  const seen = new Set<string>();
  return fields.map((field) => ({ name: field.name.trim(), label: field.label.trim() || field.name.trim(), type: field.type })).filter((field) => {
    if (!field.name || seen.has(field.name)) return false;
    seen.add(field.name);
    return true;
  });
}

function normalizedParameters(parameters: ServiceTitanReportParameter[] = []): ServiceTitanReportParameter[] {
  return parameters.map((parameter) => ({
    name: parameter.name.trim(),
    label: parameter.label.trim() || parameter.name.trim(),
    dataType: parameter.dataType,
    isArray: parameter.isArray,
    isRequired: parameter.isRequired,
    ...(parameter.dynamicSetId?.trim() ? { dynamicSetId: parameter.dynamicSetId.trim() } : {}),
  }));
}

function validParameterScalar(value: unknown, type: ServiceTitanReportParameterDataType): boolean {
  if (type === "Number") return finite(value);
  if (type === "Boolean") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  if (type === "Date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }
  if (type === "Time") return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value);
  return value.length > 0;
}

export function validateReportParameterValues(
  parameters: ServiceTitanReportParameter[],
  values: Record<string, ServiceTitanReportParameterValue>,
): string[] {
  const issues: string[] = [];
  const names = new Set(parameters.map((parameter) => parameter.name));
  for (const name of Object.keys(values)) if (!names.has(name)) issues.push(`Unknown report parameter ${name}.`);
  for (const parameter of parameters) {
    const value = values[parameter.name];
    if (value === undefined) {
      if (parameter.isRequired) issues.push(`Report parameter ${parameter.name} is required.`);
      continue;
    }
    if (parameter.isArray) {
      if (!Array.isArray(value) || value.length === 0 || !value.every((item) => validParameterScalar(item, parameter.dataType))) issues.push(`Report parameter ${parameter.name} requires a non-empty ${parameter.dataType} array.`);
    } else if (Array.isArray(value) || !validParameterScalar(value, parameter.dataType)) {
      issues.push(`Report parameter ${parameter.name} requires a ${parameter.dataType} value.`);
    }
  }
  return issues;
}

export function validateServiceTitanReportSourceInput(
  input: ServiceTitanReportSourceInput,
  connections: DemoServiceTitanConnection[],
  existingReports: ServiceTitanReportSource[],
  currentId?: string,
): ReportSourceValidationIssue[] {
  const issues: ReportSourceValidationIssue[] = [];
  const add = (code: string, field: ReportSourceValidationIssue["field"], message: string) => issues.push({ code, field, message });
  const connection = connections.find((item) => item.id === input.connectionId && item.status !== "archived");
  if (!connection) add("connection", "connectionId", "Choose an active ServiceTitan connection.");
  if (connection && connection.tenantId !== input.tenantId) add("tenant-mismatch", "tenantId", "The report tenant must match its connection tenant.");
  if (!input.categoryId.trim()) add("category", "categoryId", "Enter the immutable ServiceTitan report category ID.");
  if (!input.reportId.trim()) add("report-id", "reportId", "Enter the immutable ServiceTitan report ID.");
  if (!input.owner || !input.owner.id.trim() || !input.owner.name.trim()) add("owner", "owner", "Choose the saved report owner with an immutable ID and display name.");
  if (input.name.trim().length < 3) add("name", "name", "Enter a report display name.");
  if (!input.fields.length) add("fields", "fields", "Declare at least one expected output field.");
  if (input.fields.length && !input.fields.some((field) => field.type === "number")) add("numeric-field", "fields", "Declare at least one numeric field that can materialize a KPI value.");
  if (input.fields.some((field) => !field.name.trim() || !FIELD_TYPES.includes(field.type))) add("field-name", "fields", "Every report field needs a valid ServiceTitan field name and type.");
  const fieldNames = input.fields.map((field) => field.name.trim()).filter(Boolean);
  if (new Set(fieldNames).size !== fieldNames.length) add("duplicate-field", "fields", "Report field names must be unique.");
  const parameters = input.parameters ?? [];
  if (parameters.some((parameter) => !parameter.name.trim() || !PARAMETER_TYPES.includes(parameter.dataType) || typeof parameter.isArray !== "boolean" || typeof parameter.isRequired !== "boolean")) add("parameters", "parameters", "Report parameters must use official String, Number, Boolean, Date, or Time metadata.");
  const parameterNames = parameters.map((parameter) => parameter.name.trim());
  if (new Set(parameterNames).size !== parameterNames.length) add("duplicate-parameter", "parameters", "Report parameter names must be unique.");
  if (input.modifiedOn !== undefined && !isValidTimestamp(input.modifiedOn)) add("modified-on", "modifiedOn", "Report modifiedOn must be a valid timestamp.");
  if (existingReports.some((report) => report.id !== currentId && report.status !== "archived" && report.connectionId === input.connectionId && report.categoryId === input.categoryId.trim() && report.reportId === input.reportId.trim())) add("duplicate-report", "reportId", "This connection already has an active registration for that category and report ID.");
  return issues;
}

export function buildServiceTitanReportSource(
  input: ServiceTitanReportSourceInput,
  connections: DemoServiceTitanConnection[],
  existingReports: ServiceTitanReportSource[],
  current?: ServiceTitanReportSource,
  now = new Date().toISOString(),
): { report?: ServiceTitanReportSource; issues: ReportSourceValidationIssue[] } {
  const normalized: ServiceTitanReportSourceInput = {
    ...input,
    connectionId: input.connectionId.trim(), tenantId: input.tenantId.trim(), categoryId: input.categoryId.trim(), reportId: input.reportId.trim(), name: input.name.trim(),
    description: input.description?.trim(), owner: input.owner
      ? { id: input.owner.id.trim(), name: input.owner.name.trim() }
      : current?.owner,
    parameters: normalizedParameters(input.parameters), fields: normalizedFields(input.fields), observedFields: input.observedFields ? normalizedFields(input.observedFields) : undefined,
  };
  const issues = validateServiceTitanReportSourceInput(normalized, connections, existingReports, current?.id);
  if (current) {
    for (const field of ["connectionId", "tenantId", "categoryId", "reportId"] as const) {
      if (normalized[field] !== current[field]) issues.push({ code: `immutable-${field}`, field, message: `The saved report ${field} is immutable; create a new registration instead.` });
    }
  }
  if (!isValidTimestamp(now)) issues.push({ code: "timestamp", field: "store", message: "The source update timestamp is invalid." });
  if (issues.length) return { issues };
  const expected = reportSchemaFingerprint(normalized.fields);
  const observed = normalized.observedFields ? reportSchemaFingerprint(normalized.observedFields) : current?.observedSchemaFingerprint;
  const modifiedOn = normalized.modifiedOn ?? current?.modifiedOn ?? now;
  const sourceFingerprint = reportSourceFingerprint({
    connectionId: normalized.connectionId,
    tenantId: normalized.tenantId,
    categoryId: normalized.categoryId,
    reportId: normalized.reportId,
    owner: normalized.owner!,
    parameters: normalized.parameters ?? [],
    fields: normalized.fields,
    modifiedOn,
  });
  const sourceContractChanged = Boolean(current && reportSourceFingerprint(current) !== sourceFingerprint);
  const requestedLifecycle = normalized.lifecycle ?? current?.lifecycle ?? "draft";
  const lifecycle = sourceContractChanged && (requestedLifecycle === "reconciled" || requestedLifecycle === "approved")
    ? (observed ? "inspected" : "draft")
    : requestedLifecycle;
  const sampleInput = sourceContractChanged ? undefined : normalized.sampleEvidence ?? current?.sampleEvidence;
  const reconciliationInput = sourceContractChanged ? undefined : normalized.reconciliationEvidence ?? current?.reconciliationEvidence;
  const sample: ServiceTitanSampleEvidence | undefined = sampleInput ? { ...sampleInput, sourceFingerprint } : undefined;
  const reconciliation: ServiceTitanReconciliationEvidence | undefined = reconciliationInput ? { ...reconciliationInput, sourceFingerprint } : undefined;
  if (lifecycle === "approved") {
    if (observed !== expected) issues.push({ code: "approval-schema", field: "observedFields", message: "Approval requires an observed schema that exactly matches the expected schema." });
    if (!isSampleEvidence(sample) || sample.status !== "pass" || sample.sourceFingerprint !== sourceFingerprint) issues.push({ code: "approval-sample", field: "sampleEvidence", message: "Approval requires passing sample evidence for the exact report source contract." });
    if (!isReconciliationEvidence(reconciliation) || reconciliation.status !== "pass" || reconciliation.sourceFingerprint !== sourceFingerprint) issues.push({ code: "approval-reconciliation", field: "reconciliationEvidence", message: "Approval requires passing reconciliation evidence within tolerance for the exact report source contract." });
  }
  if (issues.length) return { issues };
  return {
    issues,
    report: {
      id: current?.id ?? input.id ?? createServiceTitanReportSourceId(), connectionId: normalized.connectionId, tenantId: normalized.tenantId,
      categoryId: normalized.categoryId, reportId: normalized.reportId, owner: normalized.owner!, name: normalized.name, description: normalized.description ?? "",
      parameters: normalized.parameters ?? [], fields: normalized.fields,
      expectedSchemaFingerprint: expected, observedSchemaFingerprint: observed, schemaFingerprint: expected,
      modifiedOn,
      lifecycle, status: lifecycle === "archived" ? "archived" : "active",
      verification: observed ? "inspected" : current?.verification ?? "declared",
      sampleEvidence: sample,
      reconciliationEvidence: reconciliation,
      inspectedAt: observed ? current?.inspectedAt ?? now : current?.inspectedAt,
      createdAt: current?.createdAt ?? now, updatedAt: now,
    },
  };
}

function isReportField(value: unknown): value is ServiceTitanReportField {
  return record(value) && exactKeys(value, ["name", "label", "type"]) && nonEmpty(value.name) && typeof value.label === "string" && FIELD_TYPES.includes(value.type as ServiceTitanReportFieldType);
}

function isReportParameter(value: unknown): value is ServiceTitanReportParameter {
  return record(value) && exactKeys(value, ["name", "label", "dataType", "isArray", "isRequired", "dynamicSetId"])
    && nonEmpty(value.name) && typeof value.label === "string" && PARAMETER_TYPES.includes(value.dataType as ServiceTitanReportParameterDataType)
    && typeof value.isArray === "boolean" && typeof value.isRequired === "boolean" && (value.dynamicSetId === undefined || nonEmpty(value.dynamicSetId));
}

function isReportOwner(value: unknown): value is ServiceTitanReportOwner {
  return record(value) && exactKeys(value, ["id", "name"]) && nonEmpty(value.id) && nonEmpty(value.name);
}

function isSampleEvidence(value: unknown): value is ServiceTitanSampleEvidence {
  return record(value) && exactKeys(value, ["rowCount", "computedValue", "status", "sampledAt", "sourceFingerprint"])
    && Number.isInteger(value.rowCount) && (value.rowCount as number) >= 0 && finite(value.computedValue)
    && EVIDENCE_STATUSES.includes(value.status as ServiceTitanEvidenceStatus) && isValidTimestamp(value.sampledAt) && nonEmpty(value.sourceFingerprint);
}

function isReconciliationEvidence(value: unknown): value is ServiceTitanReconciliationEvidence {
  if (!record(value) || !exactKeys(value, ["expectedValue", "referenceValue", "tolerance", "delta", "status", "reconciledAt", "sourceFingerprint"])) return false;
  const reference = value.referenceValue === undefined ? value.expectedValue : value.referenceValue;
  if (!finite(value.expectedValue) || !finite(reference) || !finite(value.tolerance) || value.tolerance < 0 || !finite(value.delta)
    || Math.abs(value.delta - (value.expectedValue - reference)) >= 1e-9
    || !EVIDENCE_STATUSES.includes(value.status as ServiceTitanEvidenceStatus) || !isValidTimestamp(value.reconciledAt) || !nonEmpty(value.sourceFingerprint)) return false;
  const withinTolerance = Math.abs(value.delta) <= value.tolerance;
  return value.status === "pending" || (value.status === "pass" ? withinTolerance : !withinTolerance);
}

function isReportSource(value: unknown): value is ServiceTitanReportSource {
  if (!record(value) || containsSecretKey(value) || !exactKeys(value, ["id", "connectionId", "tenantId", "categoryId", "reportId", "owner", "name", "description", "parameters", "fields", "expectedSchemaFingerprint", "observedSchemaFingerprint", "schemaFingerprint", "modifiedOn", "lifecycle", "status", "verification", "sampleEvidence", "reconciliationEvidence", "inspectedAt", "createdAt", "updatedAt"])) return false;
  if (!nonEmpty(value.id) || !nonEmpty(value.connectionId) || !nonEmpty(value.tenantId) || !nonEmpty(value.categoryId) || !nonEmpty(value.reportId) || !isReportOwner(value.owner) || !nonEmpty(value.name) || typeof value.description !== "string") return false;
  if (!Array.isArray(value.parameters) || !value.parameters.every(isReportParameter) || new Set(value.parameters.map((item) => item.name)).size !== value.parameters.length) return false;
  if (!Array.isArray(value.fields) || !value.fields.length || !value.fields.every(isReportField) || new Set(value.fields.map((item) => item.name)).size !== value.fields.length) return false;
  const fingerprint = reportSchemaFingerprint(value.fields);
  if (value.expectedSchemaFingerprint !== fingerprint || value.schemaFingerprint !== fingerprint || (value.observedSchemaFingerprint !== undefined && typeof value.observedSchemaFingerprint !== "string")) return false;
  if (!isValidTimestamp(value.modifiedOn) || !LIFECYCLES.includes(value.lifecycle as ServiceTitanReportLifecycle) || !["active", "archived"].includes(value.status as string) || !["demo", "declared", "inspected"].includes(value.verification as string)) return false;
  if ((value.lifecycle === "archived") !== (value.status === "archived")) return false;
  if (value.sampleEvidence !== undefined && !isSampleEvidence(value.sampleEvidence)) return false;
  if (value.reconciliationEvidence !== undefined && !isReconciliationEvidence(value.reconciliationEvidence)) return false;
  const candidate = value as unknown as ServiceTitanReportSource;
  const sourceFingerprint = reportSourceFingerprint(candidate);
  if (candidate.sampleEvidence !== undefined && candidate.sampleEvidence.sourceFingerprint !== sourceFingerprint) return false;
  if (candidate.reconciliationEvidence !== undefined && candidate.reconciliationEvidence.sourceFingerprint !== sourceFingerprint) return false;
  if (value.inspectedAt !== undefined && !isValidTimestamp(value.inspectedAt)) return false;
  if (!isValidTimestamp(value.createdAt) || !isValidTimestamp(value.updatedAt)) return false;
  if (value.lifecycle === "approved") {
    const sample = value.sampleEvidence;
    const reconciliation = value.reconciliationEvidence;
    if (value.status !== "active" || value.observedSchemaFingerprint !== fingerprint || !isSampleEvidence(sample)
      || sample.status !== "pass" || !isReconciliationEvidence(reconciliation) || reconciliation.status !== "pass") return false;
  }
  return true;
}

export function normalizeServiceTitanSourceStore(value: unknown): ServiceTitanSourceStore | null {
  if (!record(value) || containsSecretKey(value) || !exactKeys(value, ["schemaVersion", "reports", "availability", "unavailableReason"])) return null;
  if (value.schemaVersion !== SERVICE_TITAN_SOURCE_SCHEMA_VERSION || !Array.isArray(value.reports) || !value.reports.every(isReportSource)) return null;
  if (value.availability !== undefined && !["available", "unavailable"].includes(value.availability as string)) return null;
  if (value.unavailableReason !== undefined && typeof value.unavailableReason !== "string") return null;
  if (new Set(value.reports.map((report) => report.id)).size !== value.reports.length) return null;
  const activeIdentity = value.reports.filter((report) => report.status === "active").map((report) => `${report.connectionId}:${report.categoryId}:${report.reportId}`);
  if (new Set(activeIdentity).size !== activeIdentity.length) return null;
  return JSON.parse(JSON.stringify({ schemaVersion: SERVICE_TITAN_SOURCE_SCHEMA_VERSION, reports: value.reports, ...(value.availability ? { availability: value.availability } : {}), ...(value.unavailableReason ? { unavailableReason: value.unavailableReason } : {}) }));
}

function unavailableSourceStore(reason: string): ServiceTitanSourceStore {
  return { schemaVersion: SERVICE_TITAN_SOURCE_SCHEMA_VERSION, reports: [], availability: "unavailable", unavailableReason: reason };
}

export function readServiceTitanSourceStore(storage: Pick<Storage, "getItem" | "setItem">): ServiceTitanSourceStore {
  try {
    const raw = storage.getItem(SERVICE_TITAN_SOURCE_STORAGE_KEY);
    if (raw === null) {
      const seeded = createSeedServiceTitanSourceStore();
      storage.setItem(SERVICE_TITAN_SOURCE_STORAGE_KEY, JSON.stringify(seeded));
      return seeded;
    }
    const normalized = normalizeServiceTitanSourceStore(JSON.parse(raw));
    return normalized ?? unavailableSourceStore("Stored ServiceTitan source registry is malformed or unsafe.");
  } catch {
    return unavailableSourceStore("Stored ServiceTitan source registry could not be read.");
  }
}

export function writeServiceTitanSourceStore(storage: Pick<Storage, "setItem">, store: ServiceTitanSourceStore): boolean {
  const normalized = normalizeServiceTitanSourceStore(store);
  if (!normalized) return false;
  try { storage.setItem(SERVICE_TITAN_SOURCE_STORAGE_KEY, JSON.stringify(normalized)); return true; } catch { return false; }
}

export function upsertServiceTitanReportSource(store: ServiceTitanSourceStore, report: ServiceTitanReportSource): ServiceTitanSourceStore {
  const exists = store.reports.some((item) => item.id === report.id);
  return { ...store, reports: exists ? store.reports.map((item) => item.id === report.id ? report : item) : [...store.reports, report] };
}

export function archiveServiceTitanReportSource(store: ServiceTitanSourceStore, id: string, now = new Date().toISOString()): ServiceTitanSourceStore {
  if (!isValidTimestamp(now)) return store;
  return { ...store, reports: store.reports.map((report) => report.id === id ? { ...report, lifecycle: "archived", status: "archived", updatedAt: now } : report) };
}

export function refreshOptionsForMethod(method?: ServiceTitanSourceMethod): RefreshOption[] {
  return method === "saved-report" ? SERVICE_TITAN_REPORT_REFRESH_OPTIONS : SERVICE_TITAN_ENDPOINT_REFRESH_OPTIONS;
}

export function staleHoursForRefresh(interval?: ServiceTitanRefreshInterval): number | undefined {
  return [...SERVICE_TITAN_ENDPOINT_REFRESH_OPTIONS, ...SERVICE_TITAN_REPORT_REFRESH_OPTIONS].find((option) => option.id === interval)?.staleAfterHours;
}
