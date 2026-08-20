export const DOMO_DATASET_REDUCTIONS = ["sum", "average", "count", "latest"] as const;
export const DOMO_REFRESH_CADENCES = ["4h", "12h", "24h"] as const;
export const BOUNDED_DECIMAL_MAX_LENGTH = 120;
export const COMPLETED_PERIOD_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export type DomoDatasetReduction = (typeof DOMO_DATASET_REDUCTIONS)[number];
export type DomoRefreshCadence = (typeof DOMO_REFRESH_CADENCES)[number];

export type DomoValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; fieldErrors: Record<string, string> };

export interface DomoConnectionInput {
  displayName: string;
  clientId: string;
  clientSecret: string;
}

export interface DomoDatasetSourceInput {
  datasetId: string;
  name: string;
  description: string;
  valueColumn: string | null;
  reduction: DomoDatasetReduction;
  dateColumn: string | null;
  filterColumn: string | null;
  filterValue: string | null;
}

export interface DomoDatasetConfigurationInput extends DomoDatasetSourceInput {
  refreshCadence: DomoRefreshCadence;
}

export interface CompletedPeriodInput {
  periodStart: string;
  periodEnd: string;
}

export interface DomoConnectionRecord {
  id: string;
  organization_id: string;
  display_name: string;
  status: "needs_attention" | "ready" | "disabled" | "archived";
  last_validated_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface DomoDatasetSourceRecord {
  id: string;
  organization_id: string;
  domo_connection_id: string;
  dataset_id: string;
  name: string;
  description: string;
  value_column: string | null;
  reduction: DomoDatasetReduction;
  date_column: string | null;
  filter_column: string | null;
  filter_value: string | null;
  canonical_source_fingerprint: string;
  lifecycle: "draft" | "inspected" | "approved" | "archived";
  status: "active" | "archived";
  inspected_at: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

const DATASET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,119}$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const STRICT_DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const UTC_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;
const REDUCTION_SET = new Set<string>(DOMO_DATASET_REDUCTIONS);
const CADENCE_SET = new Set<string>(DOMO_REFRESH_CADENCES);

function trimmedPrintableText(value: unknown): string | null {
  return typeof value === "string" && !CONTROL_CHARACTER_PATTERN.test(value) ? value.trim() : null;
}

function optionalColumn(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && COLUMN_PATTERN.test(value) ? value : undefined;
}

function isDomoDatasetReduction(value: unknown): value is DomoDatasetReduction {
  return typeof value === "string" && REDUCTION_SET.has(value);
}

export function validateDomoRefreshCadence(value: unknown): value is DomoRefreshCadence {
  return typeof value === "string" && CADENCE_SET.has(value);
}

function credentialField(
  value: unknown,
  field: "clientId" | "clientSecret",
  fieldErrors: Record<string, string>,
): string {
  const candidate = typeof value === "string" ? value : "";
  if (
    candidate.length < 8
    || candidate.length > 4_096
    || candidate !== candidate.trim()
    || CONTROL_CHARACTER_PATTERN.test(candidate)
  ) {
    fieldErrors[field] = `${field === "clientId" ? "Client ID" : "Client secret"} must contain 8 to 4096 characters with no leading, trailing, or control characters.`;
  }
  return candidate;
}

/** Validates Domo credentials without ever trimming, coercing, or retaining them outside the result. */
export function validateDomoConnectionInput(input: Record<string, unknown>): DomoValidationResult<DomoConnectionInput> {
  const fieldErrors: Record<string, string> = {};
  const displayName = trimmedPrintableText(input.displayName);
  const clientId = credentialField(input.clientId, "clientId", fieldErrors);
  const clientSecret = credentialField(input.clientSecret, "clientSecret", fieldErrors);

  if (!displayName || displayName.length > 200) {
    fieldErrors.displayName = "Display name must contain 1 to 200 printable characters.";
  }
  if (Object.keys(fieldErrors).length > 0 || !displayName) return { ok: false, fieldErrors };
  return { ok: true, value: { displayName, clientId, clientSecret } };
}

/** Validates and normalizes the source columns persisted by domo_dataset_sources. */
export function validateDomoDatasetSourceInput(input: Record<string, unknown>): DomoValidationResult<DomoDatasetSourceInput> {
  const fieldErrors: Record<string, string> = {};
  const rawDatasetId = input.datasetId;
  const datasetId = typeof rawDatasetId === "string" && DATASET_ID_PATTERN.test(rawDatasetId)
    ? rawDatasetId.toLowerCase()
    : null;
  const name = trimmedPrintableText(input.name);
  const description = input.description === undefined ? "" : trimmedPrintableText(input.description);
  const reduction = input.reduction;
  const valueColumn = optionalColumn(input.valueColumn);
  const dateColumn = optionalColumn(input.dateColumn);
  const filterColumn = optionalColumn(input.filterColumn);
  const rawFilterValue = input.filterValue;
  const filterValue = rawFilterValue === null || rawFilterValue === undefined || rawFilterValue === ""
    ? null
    : trimmedPrintableText(rawFilterValue);

  if (!datasetId) fieldErrors.datasetId = "Dataset ID must be a canonical Domo dataset GUID.";
  if (!name || name.length > 200) fieldErrors.name = "Name must contain 1 to 200 printable characters.";
  if (description === null || description.length > 500) {
    fieldErrors.description = "Description must contain at most 500 printable characters.";
  }
  if (!isDomoDatasetReduction(reduction)) {
    fieldErrors.reduction = "Choose sum, average, count, or latest.";
  }

  if (reduction === "count") {
    if (valueColumn !== null) fieldErrors.valueColumn = "Count reductions must not declare a value column.";
  } else if (reduction === "sum" || reduction === "average" || reduction === "latest") {
    if (valueColumn === null || valueColumn === undefined) {
      fieldErrors.valueColumn = "This reduction requires a valid value column of at most 120 characters.";
    }
  } else if (valueColumn === undefined) {
    fieldErrors.valueColumn = "Value column must match the Domo column-name format.";
  }
  if (valueColumn === undefined) fieldErrors.valueColumn = "Value column must match the Domo column-name format.";
  if (dateColumn === undefined) fieldErrors.dateColumn = "Date column must match the Domo column-name format.";
  if (reduction === "latest" && (dateColumn === null || dateColumn === undefined)) {
    fieldErrors.dateColumn = "Latest reductions require a valid date column so the selected row is chronologically deterministic.";
  }

  const hasFilterColumn = filterColumn !== null;
  const hasFilterValue = filterValue !== null;
  if (filterColumn === undefined) {
    fieldErrors.filterColumn = "Filter column must match the Domo column-name format.";
  }
  if (hasFilterColumn !== hasFilterValue) {
    if (!hasFilterColumn) fieldErrors.filterColumn = "Filter column and filter value must be provided together.";
    if (!hasFilterValue) fieldErrors.filterValue = "Filter column and filter value must be provided together.";
  }
  if (filterValue !== null && (filterValue === "" || filterValue.length > 200)) {
    fieldErrors.filterValue = "Filter value must contain 1 to 200 printable characters.";
  }

  if (
    Object.keys(fieldErrors).length > 0
    || !datasetId
    || !name
    || description === null
    || !isDomoDatasetReduction(reduction)
    || valueColumn === undefined
    || dateColumn === undefined
    || filterColumn === undefined
  ) {
    return { ok: false, fieldErrors };
  }

  return {
    ok: true,
    value: {
      datasetId,
      name,
      description,
      valueColumn: reduction === "count" ? null : valueColumn,
      reduction,
      dateColumn,
      filterColumn,
      filterValue,
    },
  };
}

/** Validates a complete Domo source plus its governed binding refresh cadence. */
export function validateDomoDatasetConfigurationInput(
  input: Record<string, unknown>,
): DomoValidationResult<DomoDatasetConfigurationInput> {
  const source = validateDomoDatasetSourceInput(input);
  const refreshCadence = input.refreshCadence;
  const fieldErrors: Record<string, string> = source.ok ? {} : { ...source.fieldErrors };
  if (!validateDomoRefreshCadence(refreshCadence)) {
    fieldErrors.refreshCadence = "Choose a 4-hour, 12-hour, or 24-hour refresh cadence.";
  }
  if (!source.ok || !validateDomoRefreshCadence(refreshCadence)) return { ok: false, fieldErrors };
  return { ok: true, value: { ...source.value, refreshCadence } };
}

/** Returns strict plain decimal notation, or null; no Number coercion or exponent syntax is accepted. */
export function parseBoundedDecimal(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > BOUNDED_DECIMAL_MAX_LENGTH
    || !STRICT_DECIMAL_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

export function validateBoundedDecimal(
  value: unknown,
  options: { field?: string; nonNegative?: boolean } = {},
): DomoValidationResult<string> {
  const field = options.field ?? "value";
  const decimal = parseBoundedDecimal(value);
  if (decimal === null || (options.nonNegative === true && decimal.startsWith("-"))) {
    return {
      ok: false,
      fieldErrors: {
        [field]: options.nonNegative
          ? `Enter a nonnegative decimal using at most ${BOUNDED_DECIMAL_MAX_LENGTH} characters.`
          : `Enter a decimal using at most ${BOUNDED_DECIMAL_MAX_LENGTH} characters.`,
      },
    };
  }
  return { ok: true, value: decimal };
}

function canonicalUtcTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(3, "0");
  const canonical = `${match[1]}.${fraction || "000"}Z`;
  const timestamp = Date.parse(canonical);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== canonical) return null;
  return canonical;
}

/**
 * Validates the same completed approval period accepted by the deployed worker/RPC:
 * canonical UTC boundaries, positive duration, start not in the future, and at most
 * five minutes of end-boundary clock skew.
 */
export function validateCompletedPeriod(
  input: Record<string, unknown>,
  now: Date = new Date(),
): DomoValidationResult<CompletedPeriodInput> {
  const fieldErrors: Record<string, string> = {};
  const periodStart = canonicalUtcTimestamp(input.periodStart);
  const periodEnd = canonicalUtcTimestamp(input.periodEnd);
  const nowTime = now.getTime();

  if (!periodStart) fieldErrors.periodStart = "Enter a valid UTC period start timestamp.";
  if (!periodEnd) fieldErrors.periodEnd = "Enter a valid UTC period end timestamp.";
  if (!Number.isFinite(nowTime)) fieldErrors.periodEnd = "The validation clock is unavailable.";

  if (periodStart && periodEnd && Number.isFinite(nowTime)) {
    const startTime = Date.parse(periodStart);
    const endTime = Date.parse(periodEnd);
    if (endTime <= startTime) fieldErrors.periodEnd = "Period end must be later than period start.";
    if (startTime > nowTime) fieldErrors.periodStart = "Period start cannot be in the future.";
    if (endTime > nowTime + COMPLETED_PERIOD_CLOCK_SKEW_MS) {
      fieldErrors.periodEnd = "Period end cannot be more than five minutes in the future.";
    }
  }

  if (Object.keys(fieldErrors).length > 0 || !periodStart || !periodEnd) return { ok: false, fieldErrors };
  return { ok: true, value: { periodStart, periodEnd } };
}
