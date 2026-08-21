#!/usr/bin/env node

// Dedicated ingestion worker: executes every due approved binding across all three
// governed data paths (endpoint recipes, custom endpoint sources, Domo datasets)
// and materializes idempotent observations. Designed for a scheduler (cron/Vercel
// cron/operator loop): each run drains the current due set within bounded budgets.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  EndpointIngestionError,
  executeEndpointRecipe,
  executeCustomEndpointSource,
  makeEndpointObservationIdempotencyKey,
} from "./lib/servicetitan-endpoint-ingestion.mjs";
import {
  DomoIngestionError,
  executeDomoDatasetSource,
  parseDomoCredentialPayload,
} from "./lib/domo-dataset.mjs";
import { parseCredentialPayload } from "./lib/servicetitan-report.mjs";

const execFileAsync = promisify(execFile);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENV_REFERENCE = /^env:\/\/([A-Z][A-Z0-9_]{1,127})$/;
const GCP_REFERENCE = /^gcp-secret:\/\/(projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/secrets\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}\/versions\/(?:latest|[1-9][0-9]*))$/;
const VAULT_REFERENCE = /^supabase-vault:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_BATCH_LIMIT = 25;
const INTERVAL_MS = Object.freeze({
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
});

class WorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkerError";
    this.code = code;
  }
}

function usage() {
  console.log(`Usage:
  NEXT_PUBLIC_SUPABASE_URL='https://PROJECT.supabase.co' \\
  SUPABASE_SERVICE_ROLE_KEY='...' \\
  node scripts/run-data-source-ingestion.mjs [--limit 25] [--dry-run] [--only endpoint|custom|domo]

Drains due approved bindings across ServiceTitan endpoint recipes, tenant custom
endpoint sources, and Domo dataset sources. Observation periods are derived from
the binding cadence; every write is idempotent and fail-closed. Credentials resolve
in-process and are never printed.`);
}

function parseArgs(argv) {
  const args = { limit: DEFAULT_BATCH_LIMIT, dryRun: false, only: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (token === "--dry-run") { args.dryRun = true; continue; }
    if (token === "--limit") {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 200) throw new WorkerError("argument-invalid", "--limit must be 1..200.");
      args.limit = value;
      index += 1;
      continue;
    }
    if (token === "--only") {
      const value = argv[index + 1];
      if (!["endpoint", "custom", "domo"].includes(value)) throw new WorkerError("argument-invalid", "--only must be endpoint, custom, or domo.");
      args.only = value;
      index += 1;
      continue;
    }
    throw new WorkerError("argument-invalid", `Unexpected argument ${token}.`);
  }
  return args;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new WorkerError("environment-missing", `${name} is required.`);
  return value;
}

function serviceRoleClient() {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

async function resolveServiceTitanSecret(supabase, organizationId, connectionId, secretReference) {
  const envMatch = secretReference.match(ENV_REFERENCE);
  if (envMatch) {
    const raw = process.env[envMatch[1]];
    if (!raw) throw new WorkerError("secret-reference-unresolved", "The managed environment reference is unavailable.");
    return parseCredentialPayload(raw);
  }
  const gcpMatch = secretReference.match(GCP_REFERENCE);
  if (gcpMatch) {
    const binary = process.env.GCLOUD_BIN?.trim() || "gcloud";
    let stdout;
    try {
      ({ stdout } = await execFileAsync(binary, ["secrets", "versions", "access", gcpMatch[1]], { timeout: 30_000, maxBuffer: 64 * 1024 }));
    } catch {
      throw new WorkerError("secret-reference-unresolved", "Google Secret Manager could not resolve the approved reference.");
    }
    return parseCredentialPayload(stdout);
  }
  if (VAULT_REFERENCE.test(secretReference)) {
    const { data, error } = await supabase.rpc("resolve_service_titan_connection_secret", {
      p_organization_id: organizationId,
      p_connection_id: connectionId,
      p_purpose: "ingestion",
    });
    if (error || typeof data !== "string" || !data) {
      throw new WorkerError("secret-reference-unresolved", "Supabase Vault could not resolve the approved reference.");
    }
    return parseCredentialPayload(data);
  }
  throw new WorkerError("secret-reference-unsupported", "The connection uses a secret reference unsupported by this worker.");
}

async function resolveDomoSecret(supabase, organizationId, connectionId) {
  const { data, error } = await supabase.rpc("resolve_domo_connection_secret", {
    p_organization_id: organizationId,
    p_connection_id: connectionId,
    p_purpose: "ingestion",
  });
  if (error || typeof data !== "string" || !data) {
    throw new WorkerError("secret-reference-unresolved", "Supabase Vault could not resolve the Domo credential.");
  }
  return parseDomoCredentialPayload(data);
}

/** Derives the observation period for a due binding: the trailing cadence window. */
export function deriveBindingPeriod(refreshInterval, now = new Date()) {
  const intervalMs = INTERVAL_MS[refreshInterval];
  if (!intervalMs) throw new WorkerError("cadence-invalid", `Refresh interval ${refreshInterval} is not supported.`);
  const end = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  return { start: new Date(end.getTime() - intervalMs), end };
}

const OBSERVATION_WINDOWS = Object.freeze(["trailing", "today", "mtd", "ytd"]);

/** Reads a wall-clock component map for an instant in a named IANA timezone. */
function zonedParts(instant, timeZone) {
  let formatted;
  try {
    formatted = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
  } catch {
    throw new WorkerError("timezone-invalid", `Location timezone ${timeZone} is not a valid IANA zone.`);
  }
  const parts = {};
  for (const part of formatted) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts;
}

/** Converts local wall-clock fields in a named timezone to the exact UTC instant. */
function zonedTimeToUtc({ year, month, day }, timeZone) {
  // Initial guess: treat the local wall clock as UTC, then correct by the
  // observed offset. Two iterations converge across every real UTC offset,
  // including DST transitions.
  let guess = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const observed = zonedParts(new Date(guess), timeZone);
    const observedAsUtc = Date.UTC(
      observed.year, observed.month - 1, observed.day,
      observed.hour, observed.minute, observed.second, 0,
    );
    const target = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
    const difference = target - observedAsUtc;
    if (difference === 0) return new Date(guess);
    guess += difference;
  }
  return new Date(guess);
}

/**
 * Derives the governed observation period for a binding: the trailing cadence
 * window (default), or a calendar-aligned window (local day / local
 * month-to-date) anchored to the bound location's timezone.
 */
export function deriveObservationPeriod(binding, now = new Date()) {
  const window = binding.observation_window ?? "trailing";
  if (!OBSERVATION_WINDOWS.includes(window)) {
    throw new WorkerError("observation-window-invalid", `Observation window ${window} is not supported.`);
  }
  if (window === "trailing") return deriveBindingPeriod(binding.refresh_interval, now);
  const timeZone = binding.location_timezone;
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    throw new WorkerError("timezone-unavailable", "Calendar observation windows require the bound location timezone.");
  }
  const end = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const local = zonedParts(end, timeZone);
  const anchor = window === "ytd"
    ? { year: local.year, month: 1, day: 1 }
    : window === "mtd"
      ? { year: local.year, month: local.month, day: 1 }
      : { year: local.year, month: local.month, day: local.day };
  const start = zonedTimeToUtc(anchor, timeZone);
  if (!(start.getTime() < end.getTime())) {
    throw new WorkerError("observation-period-empty", "The calendar observation window is empty at this instant.");
  }
  return { start, end };
}

async function alreadyMaterialized(supabase, organizationId, bindingId, idempotencyKey) {
  const { data, error } = await supabase.from("kpi_observations").select("id")
    .eq("organization_id", organizationId).eq("binding_id", bindingId)
    .eq("idempotency_key", idempotencyKey).maybeSingle();
  if (error) throw new WorkerError("observation-check-failed", "The observation idempotency check failed.");
  return Boolean(data);
}

async function priorValue(supabase, organizationId, bindingId, sourceFingerprint, periodStart) {
  const { data, error } = await supabase.from("kpi_observations").select("value")
    .eq("organization_id", organizationId).eq("binding_id", bindingId)
    .eq("source_fingerprint", sourceFingerprint).eq("status", "valid")
    .lte("period_end", periodStart.toISOString())
    .order("period_end", { ascending: false }).order("observed_at", { ascending: false })
    .order("id", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new WorkerError("prior-observation-query-failed", "The prior observation lookup failed.");
  return data?.value ?? null;
}

async function writeObservation(supabase, { binding, period, reduced, idempotencyKey, method, extraMetadata = {} }) {
  const prior = await priorValue(supabase, binding.organization_id, binding.binding_id, binding.canonical_source_fingerprint, period.start);
  const { error } = await supabase.from("kpi_observations").insert({
    organization_id: binding.organization_id,
    binding_id: binding.binding_id,
    kpi_definition_id: binding.kpi_definition_id,
    location_id: binding.location_id,
    source_fingerprint: binding.canonical_source_fingerprint,
    source_version: 1,
    period_start: period.start.toISOString(),
    period_end: period.end.toISOString(),
    observed_at: new Date().toISOString(),
    value: reduced.decimalValue,
    prior_value: prior,
    numerator: reduced.decimalNumerator,
    denominator: reduced.decimalDenominator,
    status: "valid",
    confidence: "high",
    unmapped_record_count: 0,
    idempotency_key: idempotencyKey,
    metadata: { ingestionMethod: method, rowCount: reduced.rowCount, ...extraMetadata },
  });
  if (error && error.code !== "23505") throw new WorkerError("observation-write-failed", "The governed observation could not be written.");
  return !error;
}

async function openRun(supabase, binding, period) {
  const { data, error } = await supabase.from("service_titan_endpoint_ingestion_runs").insert({
    organization_id: binding.organization_id,
    binding_id: binding.binding_id,
    connection_id: binding.connection_id,
    requested_period_start: period.start.toISOString(),
    requested_period_end: period.end.toISOString(),
  }).select("id").single();
  if (error || !data) throw new WorkerError("run-open-failed", "The ingestion run ledger entry could not be created.");
  return data.id;
}

async function closeRun(supabase, runId, { status, errorCode = null, rowCount = null, pageCount = null }) {
  await supabase.from("service_titan_endpoint_ingestion_runs").update({
    status,
    error_code: errorCode ? String(errorCode).slice(0, 120) : null,
    row_count: rowCount,
    page_count: pageCount,
    completed_at: new Date().toISOString(),
  }).eq("id", runId).eq("status", "running");
}

async function loadServiceTitanConnection(supabase, organizationId, connectionId) {
  const { data, error } = await supabase.from("service_titan_connections")
    .select("id, organization_id, service_titan_tenant_id, environment, status, secret_reference")
    .eq("organization_id", organizationId).eq("id", connectionId).maybeSingle();
  if (error || !data) throw new WorkerError("connection-unavailable", "The exact ServiceTitan connection is unavailable.");
  if (data.status !== "ready") throw new WorkerError("connection-not-ready", "The ServiceTitan connection is not ready.");
  return data;
}

async function processEndpointRecipeBinding(supabase, binding, dryRun) {
  const period = deriveObservationPeriod(binding);
  const idempotencyKey = makeEndpointObservationIdempotencyKey({
    organizationId: binding.organization_id,
    bindingId: binding.binding_id,
    sourceFingerprint: binding.canonical_source_fingerprint,
    periodStart: period.start,
    periodEnd: period.end,
  });
  if (await alreadyMaterialized(supabase, binding.organization_id, binding.binding_id, idempotencyKey)) {
    return { outcome: "skipped-idempotent" };
  }
  const connection = await loadServiceTitanConnection(supabase, binding.organization_id, binding.connection_id);
  const credentials = await resolveServiceTitanSecret(supabase, binding.organization_id, connection.id, connection.secret_reference);
  if (dryRun) return { outcome: "dry-run" };
  const runId = await openRun(supabase, binding, period);
  try {
    const reduced = await executeEndpointRecipe({
      credentials,
      environment: connection.environment,
      tenantId: connection.service_titan_tenant_id,
      recipeId: binding.endpoint_recipe_id,
      recipeVersion: binding.endpoint_recipe_version,
      businessUnitMappings: binding.business_unit_mappings,
      period,
    });
    const written = await writeObservation(supabase, {
      binding,
      period,
      reduced,
      idempotencyKey,
      method: "endpoint-recipe",
      extraMetadata: { recipeId: binding.endpoint_recipe_id, recipeVersion: binding.endpoint_recipe_version, pageCount: reduced.pageCount, totalRowCount: reduced.totalRowCount },
    });
    await closeRun(supabase, runId, { status: "completed", rowCount: reduced.rowCount, pageCount: reduced.pageCount });
    return { outcome: written ? "materialized" : "skipped-concurrent" };
  } catch (error) {
    const code = error instanceof EndpointIngestionError || error instanceof WorkerError ? error.code : "worker-unexpected";
    await closeRun(supabase, runId, { status: "failed", errorCode: code }).catch(() => {});
    throw error;
  }
}

async function processCustomEndpointBinding(supabase, binding, dryRun) {
  const period = deriveObservationPeriod(binding);
  const idempotencyKey = makeEndpointObservationIdempotencyKey({
    organizationId: binding.organization_id,
    bindingId: binding.binding_id,
    sourceFingerprint: binding.canonical_source_fingerprint,
    periodStart: period.start,
    periodEnd: period.end,
  });
  if (await alreadyMaterialized(supabase, binding.organization_id, binding.binding_id, idempotencyKey)) {
    return { outcome: "skipped-idempotent" };
  }
  const { data: source, error: sourceError } = await supabase.from("service_titan_custom_endpoint_sources")
    .select("id, category, query_parameters, reduction, value_field, business_unit_field, lifecycle, status")
    .eq("organization_id", binding.organization_id).eq("id", binding.custom_endpoint_source_id).maybeSingle();
  if (sourceError || !source) throw new WorkerError("source-unavailable", "The exact custom endpoint source is unavailable.");
  if (source.lifecycle !== "approved" || source.status !== "active") throw new WorkerError("source-not-approved", "The custom endpoint source is not approved and active.");
  const connection = await loadServiceTitanConnection(supabase, binding.organization_id, binding.connection_id);
  const credentials = await resolveServiceTitanSecret(supabase, binding.organization_id, connection.id, connection.secret_reference);
  if (dryRun) return { outcome: "dry-run" };
  const runId = await openRun(supabase, binding, period);
  try {
    const reduced = await executeCustomEndpointSource({
      credentials,
      environment: connection.environment,
      tenantId: connection.service_titan_tenant_id,
      category: source.category,
      queryParameters: source.query_parameters,
      reduction: source.reduction,
      valueField: source.value_field,
      businessUnitMappings: binding.business_unit_mappings,
      businessUnitField: source.business_unit_field,
      period,
    });
    const written = await writeObservation(supabase, {
      binding,
      period,
      reduced,
      idempotencyKey,
      method: "custom-endpoint",
      extraMetadata: { customEndpointSourceId: source.id, endpointCategory: source.category, pageCount: reduced.pageCount, totalRowCount: reduced.totalRowCount },
    });
    await closeRun(supabase, runId, { status: "completed", rowCount: reduced.rowCount, pageCount: reduced.pageCount });
    return { outcome: written ? "materialized" : "skipped-concurrent" };
  } catch (error) {
    const code = error instanceof EndpointIngestionError || error instanceof WorkerError ? error.code : "worker-unexpected";
    await closeRun(supabase, runId, { status: "failed", errorCode: code }).catch(() => {});
    throw error;
  }
}

async function processDomoBinding(supabase, binding, dryRun) {
  const period = deriveObservationPeriod(binding);
  const idempotencyKey = makeEndpointObservationIdempotencyKey({
    organizationId: binding.organization_id,
    bindingId: binding.binding_id,
    sourceFingerprint: binding.canonical_source_fingerprint,
    periodStart: period.start,
    periodEnd: period.end,
  });
  if (await alreadyMaterialized(supabase, binding.organization_id, binding.binding_id, idempotencyKey)) {
    return { outcome: "skipped-idempotent" };
  }
  const { data: source, error: sourceError } = await supabase.from("domo_dataset_sources")
    .select("id, dataset_id, value_column, reduction, date_column, filter_column, filter_value, lifecycle, status")
    .eq("organization_id", binding.organization_id).eq("id", binding.domo_dataset_source_id).maybeSingle();
  if (sourceError || !source) throw new WorkerError("source-unavailable", "The exact Domo dataset source is unavailable.");
  if (source.lifecycle !== "approved" || source.status !== "active") throw new WorkerError("source-not-approved", "The Domo dataset source is not approved and active.");
  const credentials = await resolveDomoSecret(supabase, binding.organization_id, binding.domo_connection_id);
  if (dryRun) return { outcome: "dry-run" };
  try {
    const reduced = await executeDomoDatasetSource({
      credentials,
      contract: {
        datasetId: source.dataset_id,
        valueColumn: source.value_column,
        reduction: source.reduction,
        dateColumn: source.date_column,
        filterColumn: source.filter_column,
        filterValue: source.filter_value,
      },
      period,
    });
    const written = await writeObservation(supabase, {
      binding,
      period,
      reduced,
      idempotencyKey,
      method: "domo-dataset",
      extraMetadata: { domoDatasetSourceId: source.id },
    });
    const { error: statusError } = await supabase.rpc("set_domo_connection_status", {
      p_organization_id: binding.organization_id,
      p_connection_id: binding.domo_connection_id,
      p_status: "ready",
      p_error_code: null,
    });
    if (statusError) throw new WorkerError("connection-status-update-failed", "The Domo connection status could not be refreshed after ingestion.");
    return { outcome: written ? "materialized" : "skipped-concurrent" };
  } catch (error) {
    const code = error instanceof DomoIngestionError || error instanceof WorkerError ? error.code : "worker-unexpected";
    if (code.startsWith("domo_oauth") || code === "secret-reference-unresolved") {
      await supabase.rpc("set_domo_connection_status", {
        p_organization_id: binding.organization_id,
        p_connection_id: binding.domo_connection_id,
        p_status: "needs_attention",
        p_error_code: code,
      });
    }
    throw error;
  }
}

async function drainQueue(supabase, { limit, dryRun, only }) {
  const summary = { endpoint: [], custom: [], domo: [] };
  const queues = [
    { key: "endpoint", rpc: "get_due_endpoint_bindings", handler: processEndpointRecipeBinding },
    { key: "custom", rpc: "get_due_custom_endpoint_bindings", handler: processCustomEndpointBinding },
    { key: "domo", rpc: "get_due_domo_bindings", handler: processDomoBinding },
  ];
  for (const queue of queues) {
    if (only && only !== queue.key) continue;
    const { data, error } = await supabase.rpc(queue.rpc, { p_limit: limit });
    if (error) throw new WorkerError("queue-unavailable", `The ${queue.key} scheduling queue is unavailable.`);
    for (const binding of data ?? []) {
      if (!UUID_PATTERN.test(binding.binding_id || "")) continue;
      try {
        const result = await queue.handler(supabase, binding, dryRun);
        summary[queue.key].push({ bindingId: binding.binding_id, ...result });
      } catch (error) {
        const code = error instanceof WorkerError || error instanceof EndpointIngestionError || error instanceof DomoIngestionError
          ? error.code
          : "worker-unexpected";
        summary[queue.key].push({ bindingId: binding.binding_id, outcome: "failed", errorCode: code });
      }
    }
  }
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  const supabase = serviceRoleClient();
  const summary = await drainQueue(supabase, args);
  const counts = Object.fromEntries(Object.entries(summary).map(([key, results]) => [key, {
    total: results.length,
    materialized: results.filter((item) => item.outcome === "materialized").length,
    failed: results.filter((item) => item.outcome === "failed").length,
  }]));
  console.log(JSON.stringify({ dryRun: args.dryRun, counts, results: summary }));
  const failures = Object.values(counts).reduce((total, item) => total + item.failed, 0);
  if (failures > 0) process.exitCode = 1;
}

export { drainQueue, processEndpointRecipeBinding, processCustomEndpointBinding, processDomoBinding, WorkerError };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof WorkerError ? error.code : "worker-unexpected";
    console.error(`Data-source ingestion failed (${code}).`);
    process.exitCode = 1;
  });
}
