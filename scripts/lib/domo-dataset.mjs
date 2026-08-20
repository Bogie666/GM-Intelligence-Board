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

export function validateDomoDatasetContract({ datasetId, valueColumn, reduction, dateColumn, filterColumn, filterValue }) {
  assertDomoDatasetId(datasetId);
  if (!DOMO_DATASET_REDUCTIONS.includes(reduction)) {
    fail("domo_reduction_invalid", `Reduction ${String(reduction)} is not supported for Domo dataset sources.`);
  }
  if (reduction === "count") {
    if (valueColumn) fail("domo_value_column_invalid", "Count reductions must not declare a value column.");
  } else if (typeof valueColumn !== "string" || !COLUMN_PATTERN.test(valueColumn)) {
    fail("domo_value_column_invalid", "A bounded value column name is required for this reduction.");
  }
  if (dateColumn !== null && dateColumn !== undefined && dateColumn !== "" && !COLUMN_PATTERN.test(String(dateColumn))) {
    fail("domo_date_column_invalid", "The optional date column name is invalid.");
  }
  if (reduction === "latest" && (typeof dateColumn !== "string" || !COLUMN_PATTERN.test(dateColumn))) {
    fail("domo_date_column_invalid", "Latest reductions require a valid date column.");
  }
  const hasFilterColumn = filterColumn !== null && filterColumn !== undefined && filterColumn !== "";
  const hasFilterValue = filterValue !== null && filterValue !== undefined && filterValue !== "";
  if (hasFilterColumn !== hasFilterValue) {
    fail("domo_filter_invalid", "Filter column and filter value must be provided together.");
  }
  if (hasFilterColumn && (!COLUMN_PATTERN.test(String(filterColumn)) || String(filterValue).length > 200
      || CONTROL_PATTERN.test(String(filterValue)))) {
    fail("domo_filter_invalid", "The dataset filter contract is invalid.");
  }
  return true;
}

function columnIndex(header, name, code) {
  const index = header.indexOf(name);
  if (index < 0) fail(code, `Dataset column ${name} was not present in the export.`);
  return index;
}

/** Reduces a parsed Domo export using the approved dataset-source contract. */
export function reduceDomoRows({ header, rows, contract, period }) {
  validateDomoDatasetContract(contract);
  let working = rows;
  if (contract.filterColumn) {
    const filterIdx = columnIndex(header, contract.filterColumn, "domo_filter_column_missing");
    working = working.filter((row) => row[filterIdx].trim() === String(contract.filterValue).trim());
  }
  let dateIdx = null;
  if (contract.dateColumn) {
    dateIdx = columnIndex(header, contract.dateColumn, "domo_date_column_missing");
    working = working.filter((row) => {
      const parsed = new Date(row[dateIdx].trim());
      return Number.isFinite(parsed.getTime()) && parsed >= period.start && parsed < period.end;
    });
  }
  if (contract.reduction === "count") {
    return { decimalValue: new Decimal(working.length).toFixed(), decimalNumerator: null, decimalDenominator: null, rowCount: working.length };
  }
  if (!working.length) fail("domo_export_empty", "The approved Domo dataset returned no eligible rows for this period.");
  const valueIdx = columnIndex(header, contract.valueColumn, "domo_value_column_missing");
  if (contract.reduction === "latest") {
    if (dateIdx === null) fail("domo_date_column_invalid", "Latest reductions require a valid date column.");
    let latestTimestamp = Number.NEGATIVE_INFINITY;
    let latestValue = null;
    for (const row of working) {
      const timestamp = new Date(row[dateIdx].trim()).getTime();
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
export async function executeDomoDatasetSource({ credentials, contract, period, options = {} }) {
  const token = await obtainDomoToken(credentials, options);
  const csv = await exportDomoDatasetCsv({ token, datasetId: contract.datasetId, options });
  const { header, rows } = parseDomoCsv(csv);
  return reduceDomoRows({ header, rows, contract, period });
}
