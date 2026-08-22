const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_PATTERN = /\p{Cc}/u;
const ENDPOINT_PAGE_SIZE = 500;
const MAX_ENDPOINT_PAGES = 200;
const ENDPOINT_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;

import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import {
  DiscoveryError,
  fetchWithDiscoveryPolicy,
  readBoundedJson,
  obtainServiceTitanToken,
} from "./servicetitan-business-unit-discovery.mjs";

Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 80 });

export class EndpointIngestionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EndpointIngestionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new EndpointIngestionError(code, message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toDecimal(value, label) {
  if (typeof value === "number" && Number.isFinite(value)) return new Decimal(value.toString());
  if (typeof value === "string" && value.length <= 120 && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())) {
    const parsed = new Decimal(value.trim());
    if (parsed.isFinite()) return parsed;
  }
  fail("endpoint_value_invalid", `${label} contains a non-numeric value.`);
}

function readPath(record, path) {
  const segments = path.split(".");
  let cursor = record;
  for (const segment of segments) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/**
 * ServiceTitan modular API base paths per governed endpoint category.
 * Every category is a read-only list endpoint returning the standard
 * `{ page, pageSize, hasMore, data: [...] }` envelope.
 */
export const ENDPOINT_CATEGORY_PATHS = Object.freeze({
  jobs: "jpm/v2/tenant/{tenant}/jobs",
  appointments: "jpm/v2/tenant/{tenant}/appointments",
  invoices: "accounting/v2/tenant/{tenant}/invoices",
  estimates: "sales/v2/tenant/{tenant}/estimates",
  memberships: "memberships/v2/tenant/{tenant}/memberships",
  calls: "telecom/v2/tenant/{tenant}/calls",
  customers: "crm/v2/tenant/{tenant}/customers",
});

export const CUSTOM_ENDPOINT_CATEGORIES = Object.freeze(Object.keys(ENDPOINT_CATEGORY_PATHS));
export const CUSTOM_ENDPOINT_REDUCTIONS = Object.freeze(["count", "sum", "average"]);

const QUERY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const RESERVED_QUERY_KEYS = new Set(["page", "pagesize", "includetotal"]);
const PERIOD_PLACEHOLDERS = Object.freeze({
  $periodStartIso: (period) => period.start.toISOString(),
  $periodEndIso: (period) => period.end.toISOString(),
  $periodStartDate: (period) => period.start.toISOString().slice(0, 10),
  $periodEndDate: (period) => period.end.toISOString().slice(0, 10),
});
const PERIOD_START_PLACEHOLDERS = new Set(["$periodStartIso", "$periodStartDate"]);
const PERIOD_END_PLACEHOLDERS = new Set(["$periodEndIso", "$periodEndDate"]);
const PERIOD_START_KEY_PATTERN = /(on(?:or)?after|after|from|start|since)$/i;
const PERIOD_END_KEY_PATTERN = /(on(?:or)?before|before|to|end|until)$/i;

function scalarQueryValue(value, period, key) {
  if (typeof value === "string") {
    if (value.length > 200 || CONTROL_PATTERN.test(value)) fail("endpoint_parameter_invalid", `Query parameter ${key} is malformed.`);
    const resolver = PERIOD_PLACEHOLDERS[value];
    return resolver ? resolver(period) : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  fail("endpoint_parameter_invalid", `Query parameter ${key} must be a bounded scalar.`);
}

/** Validates and resolves governed query parameters into URLSearchParams entries. */
export function buildEndpointQuery(queryParameters, period) {
  if (!isRecord(queryParameters)) fail("endpoint_parameter_invalid", "Endpoint query parameters must be an object.");
  const entries = Object.entries(queryParameters);
  if (entries.length > 24) fail("endpoint_parameter_invalid", "Endpoint sources support at most 24 query parameters.");
  const resolved = [];
  for (const [key, value] of entries) {
    if (!QUERY_KEY_PATTERN.test(key) || RESERVED_QUERY_KEYS.has(key.toLowerCase())) {
      fail("endpoint_parameter_invalid", `Query parameter name ${key} is not permitted.`);
    }
    if (Array.isArray(value)) {
      if (value.length === 0 || value.length > 50) fail("endpoint_parameter_invalid", `Query parameter ${key} has an invalid list size.`);
      resolved.push([key, value.map((item) => scalarQueryValue(item, period, key)).join(",")]);
    } else {
      resolved.push([key, scalarQueryValue(value, period, key)]);
    }
  }
  return resolved.sort(([left], [right]) => left.localeCompare(right));
}

function validateEnvelope(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.data) || typeof payload.hasMore !== "boolean") {
    fail("endpoint_response_invalid", "ServiceTitan returned an invalid list envelope.");
  }
  if (payload.data.length > ENDPOINT_PAGE_SIZE) {
    fail("endpoint_response_invalid", "ServiceTitan returned more rows than the requested page size.");
  }
  return payload;
}

/**
 * Fetches every page of a governed ServiceTitan list endpoint within bounded limits.
 * Returns the raw item records; callers reduce them with governed semantics.
 */
export async function fetchEndpointItems({ credentials, token, environment, tenantId, category, query, options = {} }) {
  const path = ENDPOINT_CATEGORY_PATHS[category];
  if (!path) fail("endpoint_category_invalid", `Endpoint category ${category} is not governed.`);
  const apiOrigin = environment === "integration" ? "https://api-integration.servicetitan.io" : "https://api.servicetitan.io";
  const base = `${apiOrigin}/${path.replace("{tenant}", encodeURIComponent(tenantId))}`;
  const items = [];
  for (let page = 1; page <= MAX_ENDPOINT_PAGES; page += 1) {
    const search = new URLSearchParams(query);
    search.set("page", String(page));
    search.set("pageSize", String(ENDPOINT_PAGE_SIZE));
    const response = await fetchWithDiscoveryPolicy(`${base}?${search.toString()}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, "ST-App-Key": credentials.appKey, accept: "application/json" },
    }, "endpoint_list", options);
    const payload = validateEnvelope(await readBoundedJson(response, ENDPOINT_RESPONSE_LIMIT_BYTES, "endpoint_response_invalid"));
    for (const item of payload.data) {
      if (!isRecord(item)) fail("endpoint_response_invalid", "ServiceTitan returned a malformed list item.");
      items.push(item);
    }
    if (!payload.hasMore) return { items, pageCount: page };
  }
  fail("endpoint_page_limit", `ServiceTitan endpoint ingestion exceeded the ${MAX_ENDPOINT_PAGES * ENDPOINT_PAGE_SIZE} row safety limit.`);
}

function businessUnitIdSet(businessUnitMappings) {
  if (!isRecord(businessUnitMappings)) fail("business_unit_mappings_invalid", "Business-unit mappings must be an object.");
  const raw = businessUnitMappings.includedBusinessUnitIds;
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500) {
    fail("business_unit_mappings_invalid", "includedBusinessUnitIds must be a bounded non-empty array.");
  }
  const ids = new Set();
  for (const value of raw) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ids.add(String(value));
    else if (typeof value === "string" && /^[0-9]{1,18}$/.test(value)) ids.add(value);
    else fail("business_unit_mappings_invalid", "includedBusinessUnitIds must contain numeric business-unit IDs.");
  }
  return ids;
}

function matchesBusinessUnit(item, includedIds, fieldPath) {
  if (!includedIds) return true;
  const value = readPath(item, fieldPath);
  if (typeof value === "number" && Number.isSafeInteger(value)) return includedIds.has(String(value));
  if (typeof value === "string" && /^[0-9]{1,18}$/.test(value)) return includedIds.has(value);
  if (isRecord(value) && (typeof value.id === "number" || typeof value.id === "string")) {
    return includedIds.has(String(value.id));
  }
  return false;
}

function reducedResult(value, numerator = null, denominator = null) {
  return {
    decimalValue: value.toFixed(),
    decimalNumerator: numerator ? numerator.toFixed() : null,
    decimalDenominator: denominator ? denominator.toFixed() : null,
  };
}

function ratioResult(numerator, denominator) {
  if (denominator.isZero()) fail("endpoint_denominator_zero", "The governed ratio denominator is zero for this period.");
  return reducedResult(numerator.div(denominator), numerator, denominator);
}

function statusName(item) {
  if (typeof item.status === "string") return item.status;
  if (isRecord(item.status) && typeof item.status.name === "string") return item.status.name;
  return "";
}

/**
 * Application-owned endpoint recipes. Each entry is a governed, versioned execution
 * contract: fixed provider query semantics plus a fixed reduction. New recipes and
 * versions must be introduced together with a database policy migration.
 */
export const ENDPOINT_RECIPE_EXECUTIONS = Object.freeze({
  "completed-revenue@1": {
    category: "invoices",
    supportsBusinessUnitFilter: true,
    businessUnitField: "businessUnit.id",
    query: (period) => [
      ["invoicedOnOrAfter", period.start.toISOString()],
      ["invoicedOnBefore", period.end.toISOString()],
    ],
    reduce: (items) => {
      let total = new Decimal(0);
      for (const item of items) total = total.plus(toDecimal(item.total ?? "0", "Invoice total"));
      return reducedResult(total);
    },
  },
  "completed-revenue@2": {
    category: "jobs",
    supportsBusinessUnitFilter: true,
    businessUnitField: "businessUnitId",
    query: (period) => [
      ["completedOnOrAfter", period.start.toISOString()],
      ["completedBefore", period.end.toISOString()],
    ],
    reduce: (items) => {
      let total = new Decimal(0);
      for (const item of items) total = total.plus(toDecimal(item.total ?? "0", "Job total"));
      return reducedResult(total);
    },
  },
  "completed-appointments@1": {
    category: "appointments",
    supportsBusinessUnitFilter: false,
    query: (period) => [
      ["startsOnOrAfter", period.start.toISOString()],
      ["startsBefore", period.end.toISOString()],
      ["status", "Done"],
    ],
    reduce: (items) => reducedResult(new Decimal(items.length)),
  },
  "sales-close-rate@1": {
    category: "estimates",
    supportsBusinessUnitFilter: true,
    businessUnitField: "businessUnitId",
    query: (period) => [
      ["createdOnOrAfter", period.start.toISOString()],
      ["createdBefore", period.end.toISOString()],
    ],
    reduce: (items) => {
      const sold = items.filter((item) => statusName(item).toLowerCase() === "sold").length;
      return ratioResult(new Decimal(sold), new Decimal(items.length));
    },
  },
  "sales-close-rate@2": {
    category: "estimates",
    supportsBusinessUnitFilter: true,
    businessUnitField: "businessUnitId",
    query: (period) => [
      ["createdOnOrAfter", period.start.toISOString()],
      ["createdBefore", period.end.toISOString()],
    ],
    reduce: (items, period, options) => {
      // Sold Threshold from binding parameter_values, default $1 (industry standard minimum)
      const threshold = parseFloat(options?.parameterValues?.soldThreshold ?? "1.0");
      if (!Number.isFinite(threshold) || threshold < 0) fail("parameter_invalid", "soldThreshold must be a non-negative number.");
      // Group estimates by jobId — each unique job = one sales opportunity
      const opportunities = new Map();
      for (const item of items) {
        if (!item.jobId) continue;
        if (!opportunities.has(item.jobId)) opportunities.set(item.jobId, []);
        opportunities.get(item.jobId).push(item);
      }
      // Closed = opportunity with at least one Sold estimate exceeding threshold
      let closed = 0;
      for (const [, estimates] of opportunities) {
        const soldAbove = estimates.some((e) =>
          statusName(e).toLowerCase() === "sold" && parseFloat(e.subtotal ?? "0") > threshold
        );
        if (soldAbove) closed++;
      }
      return ratioResult(new Decimal(closed), new Decimal(opportunities.size));
    },
  },
  "active-memberships@1": {
    category: "memberships",
    supportsBusinessUnitFilter: true,
    businessUnitField: "businessUnitId",
    query: () => [["status", "Active"]],
    reduce: (items) => reducedResult(new Decimal(items.length)),
  },
  "inbound-call-booking-rate@1": {
    category: "calls",
    supportsBusinessUnitFilter: false,
    query: (period) => [
      ["createdOnOrAfter", period.start.toISOString()],
      ["createdBefore", period.end.toISOString()],
      ["direction", "Inbound"],
    ],
    reduce: (items) => {
      const booked = items.filter((item) => {
        const type = typeof item.callType === "string" ? item.callType : "";
        return type.toLowerCase() === "booked";
      }).length;
      return ratioResult(new Decimal(booked), new Decimal(items.length));
    },
  },
  // Catalog v2 recipes. Query semantics ported from the proven lexkpi sync
  // modules: /jpm/v2/jobs accepts completedOnOrAfter but silently ignores
  // completedOnOrBefore (the exclusive upper bound is completedBefore), and a
  // booked inbound call is one with a job number attached.
  "completed-jobs-count@1": {
    category: "jobs",
    supportsBusinessUnitFilter: true,
    businessUnitField: "businessUnitId",
    query: (period) => [
      ["completedOnOrAfter", period.start.toISOString()],
      ["completedBefore", period.end.toISOString()],
    ],
    reduce: (items) => reducedResult(new Decimal(items.length)),
  },
  "average-invoice-ticket@1": {
    category: "invoices",
    supportsBusinessUnitFilter: true,
    businessUnitField: "businessUnit.id",
    query: (period) => [
      ["invoicedOnOrAfter", period.start.toISOString()],
      ["invoicedOnBefore", period.end.toISOString()],
    ],
    reduce: (items) => {
      let total = new Decimal(0);
      for (const item of items) total = total.plus(toDecimal(item.total ?? "0", "Invoice total"));
      return ratioResult(total, new Decimal(items.length));
    },
  },
  "average-invoice-ticket@2": {
    category: "jobs",
    supportsBusinessUnitFilter: true,
    businessUnitField: "businessUnitId",
    query: (period) => [
      ["completedOnOrAfter", period.start.toISOString()],
      ["completedBefore", period.end.toISOString()],
    ],
    reduce: (items) => {
      const revenueJobs = items.filter((item) => parseFloat(item.total ?? "0") > 0);
      if (revenueJobs.length === 0) fail("endpoint_denominator_zero", "No jobs with revenue in this period.");
      let total = new Decimal(0);
      for (const item of revenueJobs) total = total.plus(toDecimal(item.total, "Job total"));
      return ratioResult(total, new Decimal(revenueJobs.length));
    },
  },
  "inbound-calls-booked@1": {
    category: "calls",
    supportsBusinessUnitFilter: false,
    query: (period) => [
      ["createdOnOrAfter", period.start.toISOString()],
      ["createdBefore", period.end.toISOString()],
      ["direction", "Inbound"],
    ],
    reduce: (items) => reducedResult(new Decimal(items.filter((item) => hasJobNumber(item)).length)),
  },
  // Tranche-1 recipes (2026-08-21). Query semantics verified against the live
  // tenant: memberships honor createdOnOrAfter/createdBefore; canceled
  // memberships are windowed client-side on cancellationDate because the API
  // has no cancellation-date filter (modifiedOnOrAfter bounds the fetch);
  // estimates honor soldAfter/soldBefore with subtotal + businessUnitId; jobs
  // honor appointmentStartsOnOrAfter/appointmentStartsBefore.
  "inbound-calls-count@1": {
    category: "calls",
    supportsBusinessUnitFilter: false,
    query: (period) => [
      ["createdOnOrAfter", period.start.toISOString()],
      ["createdBefore", period.end.toISOString()],
      ["direction", "Inbound"],
    ],
    reduce: (items) => reducedResult(new Decimal(items.filter((item) => !isAbandonedCall(item)).length)),
  },
  "inbound-call-booking-rate@2": {
    category: "calls",
    supportsBusinessUnitFilter: false,
    query: (period) => [
      ["createdOnOrAfter", period.start.toISOString()],
      ["createdBefore", period.end.toISOString()],
      ["direction", "Inbound"],
    ],
    reduce: (items) => {
      const booked = items.filter((item) => hasJobNumber(item));
      return ratioResult(new Decimal(booked.length), new Decimal(items.length));
    },
  },
  "new-memberships@1": {
    category: "memberships",
    supportsBusinessUnitFilter: true,
    businessUnitField: "businessUnitId",
    query: (period) => [
      ["createdOnOrAfter", period.start.toISOString()],
      ["createdBefore", period.end.toISOString()],
    ],
    reduce: (items) => reducedResult(new Decimal(items.length)),
  },
  "canceled-memberships@1": {
    category: "memberships",
    supportsBusinessUnitFilter: true,
    businessUnitField: "businessUnitId",
    query: (period) => [
      ["modifiedOnOrAfter", period.start.toISOString()],
      ["status", "Canceled"],
    ],
    reduce: (items, period) => reducedResult(new Decimal(
      items.filter((item) => timestampWithinPeriod(item.cancellationDate, period)).length,
    )),
  },
  "membership-net-growth@1": {
    category: "memberships",
    supportsBusinessUnitFilter: true,
    businessUnitField: "businessUnitId",
    query: (period) => [["modifiedOnOrAfter", period.start.toISOString()]],
    reduce: (items, period) => {
      const created = items.filter((item) => timestampWithinPeriod(item.createdOn, period)).length;
      // effectiveEnd = earliest(cancellationDate, expiration "to" date) — matches Lex KPI
      const canceled = items.filter((item) =>
        statusName(item).toLowerCase() === "canceled" && timestampWithinPeriod(effectiveEnd(item), period)).length;
      return reducedResult(new Decimal(created).minus(new Decimal(canceled)));
    },
  },
  "sold-estimates-value@1": {
    category: "estimates",
    supportsBusinessUnitFilter: true,
    businessUnitField: "businessUnitId",
    query: (period) => [
      ["soldAfter", period.start.toISOString()],
      ["soldBefore", period.end.toISOString()],
    ],
    reduce: (items) => {
      let total = new Decimal(0);
      for (const item of items) {
        if (statusName(item).toLowerCase() !== "sold") continue;
        total = total.plus(toDecimal(item.subtotal ?? "0", "Estimate subtotal"));
      }
      return reducedResult(total);
    },
  },
  "jobs-with-appointments-count@1": {
    category: "jobs",
    supportsBusinessUnitFilter: true,
    businessUnitField: "businessUnitId",
    query: (period) => [
      ["appointmentStartsOnOrAfter", period.start.toISOString()],
      ["appointmentStartsBefore", period.end.toISOString()],
    ],
    reduce: (items) => reducedResult(new Decimal(items.length)),
  },
  "inbound-calls-not-booked@1": {
    category: "calls",
    supportsBusinessUnitFilter: false,
    query: (period) => [
      ["createdOnOrAfter", period.start.toISOString()],
      ["createdBefore", period.end.toISOString()],
      ["direction", "Inbound"],
    ],
    reduce: (items) => {
      const notBooked = items.filter((item) => {
        const type = typeof item.callType === "string" ? item.callType.toLowerCase() : "";
        return !hasJobNumber(item) && type !== "abandoned";
      }).length;
      return reducedResult(new Decimal(notBooked));
    },
  },
});

function isAbandonedCall(item) {
  return typeof item.callType === "string" && item.callType.toLowerCase() === "abandoned";
}

/** Earliest end date (cancellation or expiration). null = still open. Matches Lex KPI effectiveEnd. */
function effectiveEnd(item) {
  const cancel = typeof item.cancellationDate === "string" ? item.cancellationDate.trim() : "";
  const expire = typeof item.to === "string" ? item.to.trim() : "";
  if (!cancel && !expire) return "";
  if (!cancel) return expire;
  if (!expire) return cancel;
  return cancel < expire ? cancel : expire;
}

/** True when the ISO-ish timestamp falls inside [period.start, period.end). */
function timestampWithinPeriod(value, period) {
  if (typeof value !== "string" || value.trim() === "") return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  return time >= period.start.getTime() && time < period.end.getTime();
}

function hasJobNumber(item) {
  if (typeof item.jobNumber === "string" && item.jobNumber.trim() !== "") return true;
  if (typeof item.jobNumber === "number" && Number.isFinite(item.jobNumber)) return true;
  return false;
}

export function getEndpointRecipeExecution(recipeId, recipeVersion) {
  const execution = ENDPOINT_RECIPE_EXECUTIONS[`${recipeId}@${recipeVersion}`];
  if (!execution) fail("endpoint_recipe_unknown", `Endpoint recipe ${recipeId} v${recipeVersion} has no governed execution contract.`);
  return execution;
}

/** Executes a governed application-owned endpoint recipe for one binding period. */
export async function executeEndpointRecipe({
  credentials,
  environment,
  tenantId,
  recipeId,
  recipeVersion,
  businessUnitMappings,
  period,
  options = {},
}) {
  const execution = getEndpointRecipeExecution(recipeId, recipeVersion);
  const includedIds = businessUnitIdSet(businessUnitMappings ?? {});
  if (includedIds && !execution.supportsBusinessUnitFilter) {
    fail("business_unit_filter_unsupported", `Endpoint recipe ${recipeId} v${recipeVersion} does not support business-unit filtering.`);
  }
  const token = await obtainServiceTitanToken(credentials, environment, options);
  const { items, pageCount } = await fetchEndpointItems({
    credentials,
    token,
    environment,
    tenantId,
    category: execution.category,
    query: execution.query(period),
    options,
  });
  const filtered = includedIds
    ? items.filter((item) => matchesBusinessUnit(item, includedIds, execution.businessUnitField))
    : items;
  return { ...execution.reduce(filtered, period, options), rowCount: filtered.length, totalRowCount: items.length, pageCount };
}

/** Validates that every custom endpoint observation is bound to its worker period. */
function assertBoundedCustomEndpointPeriod(queryParameters) {
  if (!queryParameters || typeof queryParameters !== "object" || Array.isArray(queryParameters)) {
    fail("endpoint_period_contract_invalid", "Custom endpoint period parameters are invalid.");
  }
  let hasStart = false;
  let hasEnd = false;
  for (const [key, value] of Object.entries(queryParameters)) {
    if (PERIOD_START_KEY_PATTERN.test(key)) {
      if (typeof value !== "string" || !PERIOD_START_PLACEHOLDERS.has(value)) {
        fail("endpoint_period_contract_invalid", `Temporal query parameter ${key} must use an approved period-start placeholder.`);
      }
      hasStart = true;
    } else if (PERIOD_END_KEY_PATTERN.test(key)) {
      if (typeof value !== "string" || !PERIOD_END_PLACEHOLDERS.has(value)) {
        fail("endpoint_period_contract_invalid", `Temporal query parameter ${key} must use an approved period-end placeholder.`);
      }
      hasEnd = true;
    }
  }
  if (!hasStart || !hasEnd) {
    fail("endpoint_period_contract_invalid", "Custom endpoint sources require recognized start and end period placeholders.");
  }
}

/** Validates a tenant-declared custom endpoint source contract. */
export function validateCustomEndpointContract({ category, queryParameters, reduction, valueField }) {
  if (!CUSTOM_ENDPOINT_CATEGORIES.includes(category)) {
    fail("endpoint_category_invalid", `Endpoint category ${String(category)} is not governed.`);
  }
  if (!CUSTOM_ENDPOINT_REDUCTIONS.includes(reduction)) {
    fail("endpoint_reduction_invalid", `Reduction ${String(reduction)} is not supported for custom endpoint sources.`);
  }
  if (reduction === "count") {
    if (valueField !== null && valueField !== undefined && valueField !== "") {
      fail("endpoint_value_field_invalid", "Count reductions must not declare a value field.");
    }
  } else if (typeof valueField !== "string" || !/^[A-Za-z][A-Za-z0-9._]{0,119}$/.test(valueField)) {
    fail("endpoint_value_field_invalid", "Sum and average reductions require a bounded value field path.");
  }
  assertBoundedCustomEndpointPeriod(queryParameters);
  buildEndpointQuery(queryParameters, { start: new Date(0), end: new Date(1) });
  return true;
}

/** Executes an approved tenant-declared custom endpoint source for one binding period. */
export async function executeCustomEndpointSource({
  credentials,
  environment,
  tenantId,
  category,
  queryParameters,
  reduction,
  valueField,
  businessUnitMappings,
  businessUnitField,
  period,
  options = {},
}) {
  validateCustomEndpointContract({ category, queryParameters, reduction, valueField: reduction === "count" ? "" : valueField });
  const includedIds = businessUnitIdSet(businessUnitMappings ?? {});
  if (includedIds && (typeof businessUnitField !== "string" || !/^[A-Za-z][A-Za-z0-9._]{0,119}$/.test(businessUnitField))) {
    fail("business_unit_mappings_invalid", "Business-unit filtering requires a governed business-unit field path.");
  }
  const token = await obtainServiceTitanToken(credentials, environment, options);
  const { items, pageCount } = await fetchEndpointItems({
    credentials,
    token,
    environment,
    tenantId,
    category,
    query: buildEndpointQuery(queryParameters, period),
    options,
  });
  const filtered = includedIds ? items.filter((item) => matchesBusinessUnit(item, includedIds, businessUnitField)) : items;
  if (reduction === "count") {
    return { ...reducedResult(new Decimal(filtered.length)), rowCount: filtered.length, totalRowCount: items.length, pageCount };
  }
  if (!filtered.length) fail("endpoint_empty", "The custom endpoint source returned no rows for this period.");
  let sum = new Decimal(0);
  for (const item of filtered) {
    const raw = readPath(item, valueField);
    sum = sum.plus(toDecimal(raw ?? undefined, `Endpoint field ${valueField}`));
  }
  const value = reduction === "sum" ? sum : sum.div(new Decimal(filtered.length));
  return { ...reducedResult(value), rowCount: filtered.length, totalRowCount: items.length, pageCount };
}

export function makeEndpointObservationIdempotencyKey({ organizationId, bindingId, sourceFingerprint, periodStart, periodEnd }) {
  for (const [label, value] of [["organizationId", organizationId], ["bindingId", bindingId]]) {
    if (!UUID_PATTERN.test(value || "")) fail("identity_invalid", `${label} must be a canonical UUID.`);
  }
  if (typeof sourceFingerprint !== "string" || !sourceFingerprint.trim()) fail("identity_invalid", "A source fingerprint is required.");
  if (!(periodStart instanceof Date) || !(periodEnd instanceof Date)) fail("identity_invalid", "Period boundaries must be dates.");
  const canonical = JSON.stringify({ organizationId, bindingId, sourceFingerprint, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() });
  return createHash("sha256").update(canonical).digest("hex");
}

export { DiscoveryError };
