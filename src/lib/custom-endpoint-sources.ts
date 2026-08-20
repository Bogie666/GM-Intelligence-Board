export const CUSTOM_ENDPOINT_CATEGORIES = [
  "jobs",
  "appointments",
  "invoices",
  "estimates",
  "memberships",
  "calls",
  "customers",
] as const;

export const CUSTOM_ENDPOINT_REDUCTIONS = ["count", "sum", "average"] as const;

export const CUSTOM_ENDPOINT_QUERY_MAX_BYTES = 32 * 1024;
export const CUSTOM_ENDPOINT_QUERY_MAX_DEPTH = 8;
export const CUSTOM_ENDPOINT_QUERY_MAX_NODES = 1_000;
export const CUSTOM_ENDPOINT_QUERY_MAX_KEYS = 24;
export const CUSTOM_ENDPOINT_QUERY_ARRAY_MAX_ITEMS = 50;
export const CUSTOM_ENDPOINT_QUERY_STRING_MAX_LENGTH = 200;

export type CustomEndpointCategory = (typeof CUSTOM_ENDPOINT_CATEGORIES)[number];
export type CustomEndpointReduction = (typeof CUSTOM_ENDPOINT_REDUCTIONS)[number];
export type CustomEndpointQueryScalar = string | number | boolean;
export type CustomEndpointQueryValue = CustomEndpointQueryScalar | CustomEndpointQueryScalar[];
export type CustomEndpointQueryParameters = Record<string, CustomEndpointQueryValue>;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; fieldErrors: Record<string, string> };

export interface CustomEndpointSourceInput {
  name: string;
  description: string;
  category: CustomEndpointCategory;
  queryParameters: CustomEndpointQueryParameters;
  reduction: CustomEndpointReduction;
  valueField: string | null;
  businessUnitField: string | null;
}

/** Persisted custom endpoint source fields used by the browser Admin Center. */
export interface CustomEndpointSourceRecord {
  id: string;
  organization_id: string;
  connection_id: string;
  service_titan_tenant_id: string;
  name: string;
  description: string;
  category: CustomEndpointCategory;
  query_parameters: CustomEndpointQueryParameters;
  reduction: CustomEndpointReduction;
  value_field: string | null;
  business_unit_field: string | null;
  canonical_source_fingerprint: string;
  lifecycle: "draft" | "inspected" | "approved" | "archived";
  status: "active" | "archived";
  inspected_at: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

const CATEGORY_SET = new Set<string>(CUSTOM_ENDPOINT_CATEGORIES);
const REDUCTION_SET = new Set<string>(CUSTOM_ENDPOINT_REDUCTIONS);
const QUERY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const FIELD_PATH_PATTERN = /^[A-Za-z][A-Za-z0-9._]{0,119}$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const RESERVED_QUERY_KEYS = new Set(["page", "pagesize", "includetotal"]);
const CREDENTIAL_KEY_PATTERN = /(oauth|accesstoken|refreshtoken|clientsecret|clientid|appkey|apikey|password|authorization|bearer|credential|secret)/;
const PERIOD_START_PLACEHOLDERS = new Set(["$periodStartIso", "$periodStartDate"]);
const PERIOD_END_PLACEHOLDERS = new Set(["$periodEndIso", "$periodEndDate"]);
const PERIOD_START_KEY_PATTERN = /(on(?:or)?after|after|from|start|since)$/i;
const PERIOD_END_KEY_PATTERN = /(on(?:or)?before|before|to|end|until)$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function printableText(value: unknown): string | null {
  return typeof value === "string" && !CONTROL_CHARACTER_PATTERN.test(value) ? value.trim() : null;
}

export function isCustomEndpointCategory(value: unknown): value is CustomEndpointCategory {
  return typeof value === "string" && CATEGORY_SET.has(value);
}

export function isCustomEndpointReduction(value: unknown): value is CustomEndpointReduction {
  return typeof value === "string" && REDUCTION_SET.has(value);
}

function normalizedCredentialKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface QueryAnalysis {
  nodeCount: number;
  seen: Set<object>;
}

function analyzeQueryTree(value: unknown, depth: number, analysis: QueryAnalysis): boolean {
  analysis.nodeCount += 1;
  if (analysis.nodeCount > CUSTOM_ENDPOINT_QUERY_MAX_NODES || depth > CUSTOM_ENDPOINT_QUERY_MAX_DEPTH) return false;

  if (value === null || typeof value !== "object") return true;
  if (analysis.seen.has(value)) return false;
  analysis.seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!analyzeQueryTree(item, depth + 1, analysis)) return false;
    }
    return true;
  }
  if (!isPlainObject(value)) return false;

  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY_PATTERN.test(normalizedCredentialKey(key))) return false;
    if (!analyzeQueryTree(child, depth + 1, analysis)) return false;
  }
  return true;
}

function isQueryScalar(value: unknown): value is CustomEndpointQueryScalar {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string"
    && value.length <= CUSTOM_ENDPOINT_QUERY_STRING_MAX_LENGTH
    && !CONTROL_CHARACTER_PATTERN.test(value);
}

export function hasBoundedCustomEndpointPeriod(query: CustomEndpointQueryParameters): boolean {
  let hasStart = false;
  let hasEnd = false;
  for (const [key, value] of Object.entries(query)) {
    if (PERIOD_START_KEY_PATTERN.test(key)) {
      if (typeof value !== "string" || !PERIOD_START_PLACEHOLDERS.has(value)) return false;
      hasStart = true;
    } else if (PERIOD_END_KEY_PATTERN.test(key)) {
      if (typeof value !== "string" || !PERIOD_END_PLACEHOLDERS.has(value)) return false;
      hasEnd = true;
    }
  }
  return hasStart && hasEnd;
}

function parseQueryObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return isPlainObject(value) ? value : null;
  if (new TextEncoder().encode(value).byteLength > CUSTOM_ENDPOINT_QUERY_MAX_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validates the complete credential-free query contract consumed by the endpoint worker.
 * Structural limits are checked before worker-shape validation so hostile or cyclic input
 * fails closed without unbounded recursion or serialization.
 */
export function validateCustomEndpointQueryParameters(value: unknown): ValidationResult<CustomEndpointQueryParameters> {
  const fieldErrors: Record<string, string> = {};
  let query: Record<string, unknown> | null = null;

  try {
    query = parseQueryObject(value);
    if (!query) throw new Error("object required");

    const analysis: QueryAnalysis = { nodeCount: 0, seen: new Set<object>() };
    if (!analyzeQueryTree(query, 1, analysis)) throw new Error("unsafe structure");

    const serialized = JSON.stringify(query);
    if (new TextEncoder().encode(serialized).byteLength > CUSTOM_ENDPOINT_QUERY_MAX_BYTES) {
      throw new Error("byte limit exceeded");
    }

    const entries = Object.entries(query);
    if (entries.length > CUSTOM_ENDPOINT_QUERY_MAX_KEYS) throw new Error("key limit exceeded");
    for (const [key, candidate] of entries) {
      if (!QUERY_KEY_PATTERN.test(key) || RESERVED_QUERY_KEYS.has(key.toLowerCase())) {
        throw new Error("invalid key");
      }
      if (Array.isArray(candidate)) {
        if (
          candidate.length === 0
          || candidate.length > CUSTOM_ENDPOINT_QUERY_ARRAY_MAX_ITEMS
          || !candidate.every(isQueryScalar)
        ) {
          throw new Error("invalid list value");
        }
      } else if (!isQueryScalar(candidate)) {
        throw new Error("invalid scalar value");
      }
    }

    // Produces an own-data-property-only value and prevents mutation of the submitted
    // object from changing the already validated contract.
    const cloned: unknown = JSON.parse(serialized);
    if (!isPlainObject(cloned)) throw new Error("clone invalid");
    return { ok: true, value: cloned as CustomEndpointQueryParameters };
  } catch {
    fieldErrors.queryParameters = "Query parameters must be a credential-free JSON object with at most 24 bounded scalar or scalar-list values.";
    return { ok: false, fieldErrors };
  }
}

/** Validates and normalizes a browser-submitted custom endpoint source contract. */
export function validateCustomEndpointSourceInput(input: Record<string, unknown>): ValidationResult<CustomEndpointSourceInput> {
  const fieldErrors: Record<string, string> = {};
  const name = printableText(input.name);
  const description = input.description === undefined ? "" : printableText(input.description);
  const category = input.category;
  const reduction = input.reduction;
  const rawValueField = input.valueField;
  const rawBusinessUnitField = input.businessUnitField;
  const valueField = rawValueField === null || rawValueField === undefined || rawValueField === ""
    ? null
    : printableText(rawValueField);
  const businessUnitField = rawBusinessUnitField === null || rawBusinessUnitField === undefined || rawBusinessUnitField === ""
    ? null
    : printableText(rawBusinessUnitField);
  const queryValidation = validateCustomEndpointQueryParameters(input.queryParameters);

  if (!name || name.length > 200) {
    fieldErrors.name = "Name must contain 1 to 200 printable characters.";
  }
  if (description === null || description.length > 500) {
    fieldErrors.description = "Description must contain at most 500 printable characters.";
  }
  if (!isCustomEndpointCategory(category)) {
    fieldErrors.category = "Choose a governed ServiceTitan endpoint category.";
  }
  if (!isCustomEndpointReduction(reduction)) {
    fieldErrors.reduction = "Choose count, sum, or average.";
  }
  if (reduction === "count") {
    if (valueField !== null) fieldErrors.valueField = "Count reductions must not declare a value field.";
  } else if ((reduction === "sum" || reduction === "average") && (valueField === null || !FIELD_PATH_PATTERN.test(valueField))) {
    fieldErrors.valueField = "Sum and average reductions require a valid value field path of at most 120 characters.";
  }
  if (valueField !== null && reduction !== "count" && !FIELD_PATH_PATTERN.test(valueField)) {
    fieldErrors.valueField = "Value field must be a valid field path of at most 120 characters.";
  }
  if (businessUnitField !== null && !FIELD_PATH_PATTERN.test(businessUnitField)) {
    fieldErrors.businessUnitField = "Business-unit field must be a valid field path of at most 120 characters.";
  }
  if (!queryValidation.ok) {
    Object.assign(fieldErrors, queryValidation.fieldErrors);
  } else if (!hasBoundedCustomEndpointPeriod(queryValidation.value)) {
    fieldErrors.queryParameters = "Query parameters must include one recognized period-start key using $periodStartIso or $periodStartDate and one recognized period-end key using $periodEndIso or $periodEndDate; literal or unbounded date ranges are not allowed.";
  }

  if (
    Object.keys(fieldErrors).length > 0
    || !name
    || description === null
    || !isCustomEndpointCategory(category)
    || !isCustomEndpointReduction(reduction)
    || !queryValidation.ok
  ) {
    return { ok: false, fieldErrors };
  }

  return {
    ok: true,
    value: {
      name,
      description,
      category,
      queryParameters: queryValidation.value,
      reduction,
      valueField: reduction === "count" ? null : valueField,
      businessUnitField,
    },
  };
}
