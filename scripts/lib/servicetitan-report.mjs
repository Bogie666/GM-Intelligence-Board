import { createHash } from "node:crypto";

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const PLACEHOLDERS = new Set(["$periodStartIso", "$periodEndIso", "$periodStartDate", "$periodEndDate"]);

export class WorkerInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkerInputError";
    this.code = code;
  }
}

function assertRecord(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkerInputError(code, message);
  return value;
}

export function parseCredentialPayload(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WorkerInputError("secret-json-invalid", "The managed secret is not valid JSON.");
  }
  assertRecord(value, "secret-shape-invalid", "The managed secret must be a JSON object.");
  const allowed = new Set(["clientId", "clientSecret", "appKey"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new WorkerInputError("secret-shape-invalid", "The managed secret contains unsupported fields.");
  }
  for (const key of allowed) {
    if (typeof value[key] !== "string" || value[key].trim().length < 8) {
      throw new WorkerInputError("secret-shape-invalid", "The managed secret is missing a required credential field.");
    }
  }
  return { clientId: value.clientId, clientSecret: value.clientSecret, appKey: value.appKey };
}

export function resolveParameterPlaceholders(value, periodStart, periodEnd) {
  const replacements = {
    $periodStartIso: periodStart.toISOString(),
    $periodEndIso: periodEnd.toISOString(),
    $periodStartDate: periodStart.toISOString().slice(0, 10),
    $periodEndDate: periodEnd.toISOString().slice(0, 10),
  };
  if (typeof value === "string" && PLACEHOLDERS.has(value)) return replacements[value];
  if (Array.isArray(value)) return value.map((item) => resolveParameterPlaceholders(item, periodStart, periodEnd));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolveParameterPlaceholders(nested, periodStart, periodEnd)]));
  }
  return value;
}

export function buildReportParameters(parameterValues, periodStart, periodEnd) {
  assertRecord(parameterValues, "parameter-values-invalid", "Binding parameter values must be an object.");
  return Object.entries(parameterValues)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (!name.trim()) throw new WorkerInputError("parameter-name-invalid", "Report parameter names must not be blank.");
      return { name, value: resolveParameterPlaceholders(value, periodStart, periodEnd) };
    });
}

export function parseReportDataResponse(value, expectedFields) {
  const payload = assertRecord(value, "report-response-invalid", "ServiceTitan returned an invalid report response.");
  if (!Array.isArray(payload.fields) || !Array.isArray(payload.data) || typeof payload.hasMore !== "boolean") {
    throw new WorkerInputError("report-response-invalid", "ServiceTitan report fields, rows, or pagination metadata are invalid.");
  }
  const observedFields = payload.fields.map((field) => {
    const item = assertRecord(field, "report-fields-invalid", "ServiceTitan returned malformed report field metadata.");
    if (typeof item.name !== "string" || !item.name.trim()) throw new WorkerInputError("report-fields-invalid", "ServiceTitan returned a blank report field name.");
    return item.name;
  });
  const expectedNames = expectedFields.map((field) => field.name);
  if (observedFields.length !== expectedNames.length || observedFields.some((name, index) => name !== expectedNames[index])) {
    throw new WorkerInputError("report-schema-drift", "The observed ServiceTitan report fields do not match the approved source schema.");
  }
  const rows = payload.data.map((row) => {
    if (!Array.isArray(row) || row.length !== observedFields.length) {
      throw new WorkerInputError("report-row-invalid", "A ServiceTitan report row does not match the approved field count.");
    }
    return row;
  });
  return { fields: observedFields, rows, hasMore: payload.hasMore };
}

export function toFiniteNumber(value, fieldName) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && DECIMAL_PATTERN.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new WorkerInputError("report-value-invalid", `Report field ${fieldName} contains a non-numeric value.`);
}

function fieldIndex(fields, name, requiredCode) {
  if (typeof name !== "string" || !name.trim()) throw new WorkerInputError(requiredCode, "The approved binding is missing a required report field.");
  const index = fields.indexOf(name);
  if (index < 0) throw new WorkerInputError("report-field-missing", `Approved report field ${name} was not returned.`);
  return index;
}

function numericColumn(rows, index, name) {
  return rows.map((row) => toFiniteNumber(row[index], name));
}

export function reduceReportRows({ rows, fields, reduction, valueField, numeratorField, denominatorField, valueKind }) {
  if (!Array.isArray(rows) || !Array.isArray(fields)) throw new WorkerInputError("report-data-invalid", "Report data is not an array.");
  if (reduction === "count") return { value: rows.length, numerator: null, denominator: null };
  if (!rows.length) throw new WorkerInputError("report-empty", "The approved ServiceTitan report returned no rows.");

  if (reduction === "ratio") {
    const numeratorIndex = fieldIndex(fields, numeratorField, "numerator-field-required");
    const denominatorIndex = fieldIndex(fields, denominatorField, "denominator-field-required");
    const numerator = numericColumn(rows, numeratorIndex, numeratorField).reduce((sum, item) => sum + item, 0);
    const denominator = numericColumn(rows, denominatorIndex, denominatorField).reduce((sum, item) => sum + item, 0);
    if (denominator === 0) throw new WorkerInputError("ratio-denominator-zero", "The report ratio denominator is zero.");
    const raw = numerator / denominator;
    return { value: valueKind === "percent" ? raw * 100 : raw, numerator, denominator };
  }

  const index = fieldIndex(fields, valueField, "value-field-required");
  const values = numericColumn(rows, index, valueField);
  if (reduction === "sum") return { value: values.reduce((sum, item) => sum + item, 0), numerator: null, denominator: null };
  if (reduction === "average") return { value: values.reduce((sum, item) => sum + item, 0) / values.length, numerator: null, denominator: null };
  if (reduction === "latest") {
    throw new WorkerInputError("latest-order-contract-required", "Latest reduction requires a governed provider ordering contract and is disabled by this worker.");
  }
  throw new WorkerInputError("reduction-unsupported", "The approved report reduction is unsupported.");
}

export function makeObservationIdempotencyKey({ organizationId, bindingId, sourceFingerprint, periodStart, periodEnd }) {
  const canonical = JSON.stringify({ organizationId, bindingId, sourceFingerprint, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() });
  return createHash("sha256").update(canonical).digest("hex");
}

export function parsePeriod(startRaw, endRaw) {
  const start = new Date(startRaw);
  const end = new Date(endRaw);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new WorkerInputError("period-invalid", "The ingestion period must contain valid increasing ISO timestamps.");
  }
  return { start, end };
}
