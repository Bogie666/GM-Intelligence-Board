import Decimal from "decimal.js";
import {
  fetchWithDiscoveryPolicy,
  readBoundedJson,
} from "./servicetitan-business-unit-discovery.mjs";

Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 80 });

const DOMO_API_ORIGIN = "https://api.domo.com";
const DATASET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,119}$/;
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const TOKEN_RESPONSE_LIMIT_BYTES = 64 * 1024;
const METADATA_RESPONSE_LIMIT_BYTES = 256 * 1024;
const EXPORT_RESPONSE_LIMIT_BYTES = 24 * 1024 * 1024;
const MAX_EXPORT_ROWS = 250_000;

export const DOMO_DATASET_REDUCTIONS = Object.freeze(["sum", "average", "count", "latest"]);

export class DomoIngestionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomoIngestionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new DomoIngestionError(code, message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseDomoCredentialPayload(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("domo_credential_invalid", "The managed Domo credential payload is invalid.");
  }
  if (!isRecord(value)) fail("domo_credential_invalid", "The managed Domo credential payload is invalid.");
  const allowed = new Set(["clientId", "clientSecret"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail("domo_credential_invalid", "The managed Domo credential payload is invalid.");
  }
  for (const key of allowed) {
    if (typeof value[key] !== "string" || value[key].trim().length < 8 || value[key].length > 4096
        || value[key] !== value[key].trim() || CONTROL_PATTERN.test(value[key])) {
      fail("domo_credential_invalid", "The managed Domo credential payload is invalid.");
    }
  }
  return { clientId: value.clientId, clientSecret: value.clientSecret };
}

/** Obtains a Domo OAuth client-credentials token scoped to dataset reads. */
export async function obtainDomoToken(credentials, options = {}) {
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`, "utf8").toString("base64");
  const response = await fetchWithDiscoveryPolicy(`${DOMO_API_ORIGIN}/oauth/token?grant_type=client_credentials&scope=data`, {
    method: "GET",
    headers: { authorization: `Basic ${basic}`, accept: "application/json" },
  }, "domo_oauth", options);
  const payload = await readBoundedJson(response, TOKEN_RESPONSE_LIMIT_BYTES, "domo_oauth_response_invalid");
  if (!isRecord(payload) || typeof payload.access_token !== "string" || !payload.access_token
      || payload.access_token.length > 16_384 || CONTROL_PATTERN.test(payload.access_token)) {
    fail("domo_oauth_response_invalid", "Domo OAuth did not return a usable access token.");
  }
  return payload.access_token;
}

export function assertDomoDatasetId(datasetId) {
  if (typeof datasetId !== "string" || !DATASET_ID_PATTERN.test(datasetId)) {
    fail("domo_dataset_id_invalid", "Domo dataset IDs must be canonical dataset GUIDs.");
  }
  return datasetId.toLowerCase();
}

/** Fetches governed dataset metadata (name, row/column counts) for validation evidence. */
export async function fetchDomoDatasetMetadata({ token, datasetId, options = {} }) {
  const id = assertDomoDatasetId(datasetId);
  const response = await fetchWithDiscoveryPolicy(`${DOMO_API_ORIGIN}/v1/datasets/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  }, "domo_dataset_metadata", options);
  const payload = await readBoundedJson(response, METADATA_RESPONSE_LIMIT_BYTES, "domo_dataset_metadata_invalid");
  if (!isRecord(payload) || typeof payload.id !== "string" || payload.id.toLowerCase() !== id
      || typeof payload.name !== "string" || !payload.name.trim()) {
    fail("domo_dataset_metadata_invalid", "Domo returned invalid dataset metadata.");
  }
  return {
    id,
    name: payload.name.trim().slice(0, 200),
    rows: Number.isSafeInteger(payload.rows) && payload.rows >= 0 ? payload.rows : null,
    columns: Number.isSafeInteger(payload.columns) && payload.columns >= 0 ? payload.columns : null,
  };
}

/** RFC-4180-shaped CSV parser bounded for governed Domo exports. */
export function parseDomoCsv(text) {
  if (typeof text !== "string") fail("domo_export_invalid", "Domo export payload is not text.");
  if (CONTROL_PATTERN.test(text.replaceAll("\r", "").replaceAll("\n", ""))) {
    fail("domo_export_invalid", "Domo export contains control characters.");
  }
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ",") { row.push(field); field = ""; continue; }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      if (rows.length > MAX_EXPORT_ROWS) fail("domo_export_too_large", "Domo export exceeded the governed row limit.");
      continue;
    }
    field += char;
  }
  if (inQuotes) fail("domo_export_invalid", "Domo export contains an unterminated quoted field.");
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  if (!rows.length) fail("domo_export_empty", "Domo export contained no header row.");
  const header = rows[0].map((name) => name.trim());
  if (header.some((name) => !name || name.length > 200)) fail("domo_export_invalid", "Domo export header names are invalid.");
  const body = rows.slice(1);
  for (const record of body) {
    if (record.length !== header.length) fail("domo_export_invalid", "A Domo export row does not match the header width.");
  }
  return { header, rows: body };
}

/** Exports an allowlisted Domo dataset as bounded CSV text. */
export async function exportDomoDatasetCsv({ token, datasetId, options = {} }) {
  const id = assertDomoDatasetId(datasetId);
  const response = await fetchWithDiscoveryPolicy(
    `${DOMO_API_ORIGIN}/v1/datasets/${encodeURIComponent(id)}/data?includeHeader=true`,
    { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "text/csv" } },
    "domo_dataset_export",
    options,
  );
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > EXPORT_RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel().catch(() => {});
    fail("domo_export_too_large", "Domo export exceeded the governed byte limit.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > EXPORT_RESPONSE_LIMIT_BYTES) {
    fail("domo_export_too_large", "Domo export exceeded the governed byte limit.");
  }
  return text;
}

function toDecimal(value, label) {
  if (typeof value === "string" && value.trim() !== "" && DECIMAL_PATTERN.test(value.trim())) {
    const parsed = new Decimal(value.trim());
    if (parsed.isFinite()) return parsed;
  }
  fail("domo_value_invalid", `${label} contains a non-numeric value.`);
}

function normalizedPeriodMode(contract) {
  if (contract.periodMode === undefined || contract.periodMode === null || contract.periodMode === "") {
    return contract.dateColumn ? "date" : "none";
  }
  return contract.periodMode;
}

function assertColumn(value, code, message) {
  if (typeof value !== "string" || !COLUMN_PATTERN.test(value)) fail(code, message);
}

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 100 || CONTROL_PATTERN.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function validateDomoDatasetContract(contract) {
  const {
    datasetId, valueColumn, reduction, dateColumn, monthColumn, yearColumn,
    filterColumn, filterValue, expectedPeriodRows,
  } = contract;
  assertDomoDatasetId(datasetId);
  if (!DOMO_DATASET_REDUCTIONS.includes(reduction)) {
    fail("domo_reduction_invalid", `Reduction ${String(reduction)} is not supported for Domo dataset sources.`);
  }
  if (reduction === "count") {
    if (valueColumn) fail("domo_value_column_invalid", "Count reductions must not declare a value column.");
  } else {
    assertColumn(valueColumn, "domo_value_column_invalid", "A bounded value column name is required for this reduction.");
  }

  const periodMode = normalizedPeriodMode(contract);
  if (!["none", "date", "month_year"].includes(periodMode)) {
    fail("domo_period_mode_invalid", "The Domo period mode is invalid.");
  }
  if (periodMode === "none") {
    if (dateColumn || monthColumn || yearColumn) fail("domo_period_contract_invalid", "A no-period source cannot declare date, month, or year columns.");
  } else if (periodMode === "date") {
    assertColumn(dateColumn, "domo_date_column_invalid", "Date period mode requires a valid date column.");
    if (monthColumn || yearColumn) fail("domo_period_contract_invalid", "Date period mode cannot declare month or year columns.");
  } else {
    if (dateColumn) fail("domo_period_contract_invalid", "Month/year period mode cannot declare a date column.");
    assertColumn(monthColumn, "domo_month_column_invalid", "Month/year period mode requires a valid month column.");
    assertColumn(yearColumn, "domo_year_column_invalid", "Month/year period mode requires a valid year column.");
  }
  if (reduction === "latest" && periodMode === "none") {
    fail("domo_date_column_invalid", "Latest reductions require a chronological period contract.");
  }

  const hasFilterColumn = filterColumn !== null && filterColumn !== undefined && filterColumn !== "";
  const hasFilterValue = filterValue !== null && filterValue !== undefined && filterValue !== "";
  if (hasFilterColumn !== hasFilterValue) fail("domo_filter_invalid", "Filter column and filter value must be provided together.");
  if (hasFilterColumn && (!COLUMN_PATTERN.test(String(filterColumn)) || String(filterValue).length > 200
      || CONTROL_PATTERN.test(String(filterValue)))) {
    fail("domo_filter_invalid", "The dataset filter contract is invalid.");
  }
  if (periodMode === "month_year" && !hasFilterColumn) {
    fail("domo_filter_invalid", "Month/year sources require an explicit brand or location filter.");
  }
  if (expectedPeriodRows !== null && expectedPeriodRows !== undefined
      && (!Number.isSafeInteger(expectedPeriodRows) || expectedPeriodRows < 1 || expectedPeriodRows > MAX_EXPORT_ROWS)) {
    fail("domo_expected_rows_invalid", "Expected period rows must be a positive bounded integer.");
  }
  return true;
}

function localParts(instant, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

function localDateKey(parts) {
  return parts.year * 10000 + parts.month * 100 + parts.day;
}

function parseDomoDateValue(rawValue, timeZone) {
  const value = String(rawValue).trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    if (!isValidTimeZone(timeZone)) fail("domo_timezone_invalid", "Date-only Domo values require the binding location timezone.");
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
      fail("domo_period_value_invalid", "A filtered Domo row contains an invalid date value.");
    }
    return { kind: "local-date", order: probe.getTime(), localKey: year * 10000 + month * 100 + day };
  }
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    fail("domo_period_value_invalid", "Domo timestamps must include an explicit UTC or numeric timezone offset.");
  }
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) fail("domo_period_value_invalid", "A filtered Domo row contains an invalid date value.");
  return { kind: "instant", order: timestamp, timestamp };
}

const MONTH_NUMBERS = new Map([
  ["1", 1], ["01", 1], ["jan", 1], ["january", 1],
  ["2", 2], ["02", 2], ["feb", 2], ["february", 2],
  ["3", 3], ["03", 3], ["mar", 3], ["march", 3],
  ["4", 4], ["04", 4], ["apr", 4], ["april", 4],
  ["5", 5], ["05", 5], ["may", 5],
  ["6", 6], ["06", 6], ["jun", 6], ["june", 6],
  ["7", 7], ["07", 7], ["jul", 7], ["july", 7],
  ["8", 8], ["08", 8], ["aug", 8], ["august", 8],
  ["9", 9], ["09", 9], ["sep", 9], ["sept", 9], ["september", 9],
  ["10", 10], ["oct", 10], ["october", 10],
  ["11", 11], ["nov", 11], ["november", 11],
  ["12", 12], ["dec", 12], ["december", 12],
]);

function monthKey(monthValue, yearValue) {
  const month = MONTH_NUMBERS.get(String(monthValue).trim().toLowerCase());
  const yearText = String(yearValue).trim();
  if (!month || !/^\d{4}$/.test(yearText)) fail("domo_period_value_invalid", "A filtered Domo row contains an invalid month or year value.");
  const year = Number(yearText);
  if (!Number.isSafeInteger(year) || year < 1900 || year > 2200) fail("domo_period_value_invalid", "A filtered Domo row contains an invalid month or year value.");
  return year * 12 + month - 1;
}

function monthYearRange(period, timeZone) {
  if (!isValidTimeZone(timeZone)) fail("domo_timezone_invalid", "Month/year period mode requires the binding location timezone.");
  const start = localParts(period.start, timeZone);
  if (start.day !== 1 || start.hour !== 0 || start.minute !== 0 || start.second !== 0) {
    fail("domo_period_alignment_invalid", "Month/year periods must begin at local month start.");
  }
  const last = localParts(new Date(period.end.getTime() - 1), timeZone);
  return { first: start.year * 12 + start.month - 1, last: last.year * 12 + last.month - 1 };
}

function columnIndex(header, name, code) {
  const index = header.indexOf(name);
  if (index < 0) fail(code, `Dataset column ${name} was not present in the export.`);
  return index;
}

/** Reduces a parsed Domo export using the approved dataset-source contract. */
export function reduceDomoRows({ header, rows, contract, period, timeZone }) {
  validateDomoDatasetContract(contract);
  let working = rows;
  if (contract.filterColumn) {
    const filterIdx = columnIndex(header, contract.filterColumn, "domo_filter_column_missing");
    working = working.filter((row) => row[filterIdx].trim() === String(contract.filterValue).trim());
  }

  const periodMode = normalizedPeriodMode(contract);
  let chronology = null;
  if (periodMode === "date") {
    const dateIdx = columnIndex(header, contract.dateColumn, "domo_date_column_missing");
    const effectiveTimeZone = timeZone ?? "UTC";
    if (!isValidTimeZone(effectiveTimeZone)) fail("domo_timezone_invalid", "The Domo binding location timezone is invalid.");
    const firstLocalDate = localDateKey(localParts(period.start, effectiveTimeZone));
    const lastLocalDate = localDateKey(localParts(new Date(period.end.getTime() - 1), effectiveTimeZone));
    const parsedDate = (row) => parseDomoDateValue(row[dateIdx], effectiveTimeZone);
    chronology = (row) => parsedDate(row).order;
    working = working.filter((row) => {
      const parsed = parsedDate(row);
      return parsed.kind === "local-date"
        ? parsed.localKey >= firstLocalDate && parsed.localKey <= lastLocalDate
        : parsed.timestamp >= period.start.getTime() && parsed.timestamp < period.end.getTime();
    });
  } else if (periodMode === "month_year") {
    const monthIdx = columnIndex(header, contract.monthColumn, "domo_month_column_missing");
    const yearIdx = columnIndex(header, contract.yearColumn, "domo_year_column_missing");
    const range = monthYearRange(period, timeZone);
    chronology = (row) => monthKey(row[monthIdx], row[yearIdx]);
    working = working.filter((row) => {
      const key = chronology(row);
      return key >= range.first && key <= range.last;
    });
  }

  if (contract.expectedPeriodRows !== null && contract.expectedPeriodRows !== undefined
      && working.length !== contract.expectedPeriodRows) {
    fail("domo_period_row_count_mismatch", "The approved Domo dataset returned an unexpected number of eligible period rows.");
  }
  if (contract.reduction === "count") {
    return { decimalValue: new Decimal(working.length).toFixed(), decimalNumerator: null, decimalDenominator: null, rowCount: working.length };
  }
  if (!working.length) fail("domo_export_empty", "The approved Domo dataset returned no eligible rows for this period.");
  const valueIdx = columnIndex(header, contract.valueColumn, "domo_value_column_missing");
  if (contract.reduction === "latest") {
    if (!chronology) fail("domo_date_column_invalid", "Latest reductions require a chronological period contract.");
    let latestTimestamp = Number.NEGATIVE_INFINITY;
    let latestValue = null;
    for (const row of working) {
      const timestamp = chronology(row);
      const value = toDecimal(row[valueIdx], `Dataset column ${contract.valueColumn}`);
      if (timestamp > latestTimestamp) {
        latestTimestamp = timestamp;
        latestValue = value;
      } else if (timestamp === latestTimestamp && latestValue && !value.equals(latestValue)) {
        fail("domo_latest_ambiguous", "The latest dataset timestamp contains conflicting KPI values.");
      }
    }
    if (!latestValue) fail("domo_export_empty", "The approved Domo dataset returned no eligible latest value for this period.");
    return { decimalValue: latestValue.toFixed(), decimalNumerator: null, decimalDenominator: null, rowCount: working.length };
  }
  let sum = new Decimal(0);
  for (const row of working) sum = sum.plus(toDecimal(row[valueIdx], `Dataset column ${contract.valueColumn}`));
  const value = contract.reduction === "sum" ? sum : sum.div(new Decimal(working.length));
  return { decimalValue: value.toFixed(), decimalNumerator: null, decimalDenominator: null, rowCount: working.length };
}

/** Executes an approved Domo dataset source for one binding period. */
export async function executeDomoDatasetSource({ credentials, contract, period, timeZone, options = {} }) {
  const token = await obtainDomoToken(credentials, options);
  const csv = await exportDomoDatasetCsv({ token, datasetId: contract.datasetId, options });
  const { header, rows } = parseDomoCsv(csv);
  return reduceDomoRows({ header, rows, contract, period, timeZone });
}
