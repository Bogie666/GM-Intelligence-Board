#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  WorkerInputError,
  buildReportParameters,
  makeObservationIdempotencyKey,
  parseCredentialPayload,
  parsePeriod,
  parseReportDataResponse,
  reduceReportRows,
} from "./lib/servicetitan-report.mjs";

const execFileAsync = promisify(execFile);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GCP_REFERENCE = /^gcp-secret:\/\/(projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/secrets\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}\/versions\/(?:latest|[1-9][0-9]*))$/;
const ENV_REFERENCE = /^env:\/\/([A-Z][A-Z0-9_]{1,127})$/;
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

function usage() {
  console.log(`Usage:
  NEXT_PUBLIC_SUPABASE_URL='https://PROJECT.supabase.co' \\
  SUPABASE_SERVICE_ROLE_KEY='...' \\
  node scripts/ingest-servicetitan-report.mjs \\
    --organization-id ORGANIZATION_UUID \\
    --binding-id BINDING_UUID \\
    --period-start 2026-08-17T00:00:00.000Z \\
    --period-end 2026-08-18T00:00:00.000Z \\
    --confirm ORGANIZATION_UUID:BINDING_UUID:2026-08-17T00:00:00.000Z

Options:
  --dry-run   Fetch, validate, and reduce the report without inserting an observation.

This service-role worker supports approved saved-report bindings only. It resolves the managed
secret in the worker process, never prints credentials or provider response bodies, verifies the
exact tenant/location/source contract, and writes an idempotent materialized observation.`);
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (token === "--dry-run") { args.dryRun = true; continue; }
    if (!token.startsWith("--")) throw new WorkerInputError("argument-invalid", `Unexpected argument ${token}.`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new WorkerInputError("argument-missing", `Missing value for ${token}.`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new WorkerInputError("environment-missing", `${name} is required.`);
  return value;
}

function serviceRoleClient() {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

async function resolveSecret(reference) {
  const envMatch = reference.match(ENV_REFERENCE);
  if (envMatch) {
    const raw = process.env[envMatch[1]];
    if (!raw) throw new WorkerInputError("secret-reference-unresolved", "The managed environment reference is unavailable.");
    return parseCredentialPayload(raw);
  }
  const gcpMatch = reference.match(GCP_REFERENCE);
  if (gcpMatch) {
    const binary = process.env.GCLOUD_BIN?.trim() || "gcloud";
    let stdout;
    try {
      ({ stdout } = await execFileAsync(binary, ["secrets", "versions", "access", gcpMatch[1]], { timeout: 30_000, maxBuffer: 64 * 1024 }));
    } catch {
      throw new WorkerInputError("secret-reference-unresolved", "Google Secret Manager could not resolve the approved reference.");
    }
    return parseCredentialPayload(stdout);
  }
  throw new WorkerInputError("secret-reference-unsupported", "The connection uses a secret reference unsupported by this worker.");
}

export async function fetchWithPolicy(url, init, operation) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response;
    try {
      response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    } catch {
      if (attempt === 3) throw new WorkerInputError(`${operation}-network`, `${operation} failed after bounded network retries.`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      continue;
    } finally {
      clearTimeout(timeout);
    }
    if (response.ok) return response;
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : attempt * 1000;
      await response.body?.cancel().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    await response.body?.cancel().catch(() => {});
    throw new WorkerInputError(`${operation}-http-${response.status}`, `${operation} returned HTTP ${response.status}.`);
  }
  throw new WorkerInputError(`${operation}-failed`, `${operation} failed.`);
}

async function obtainToken(credentials, environment) {
  const authBase = environment === "integration" ? "https://auth-integration.servicetitan.io" : "https://auth.servicetitan.io";
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: credentials.clientId, client_secret: credentials.clientSecret });
  const response = await fetchWithPolicy(`${authBase}/connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body }, "oauth");
  let payload;
  try { payload = await response.json(); } catch { throw new WorkerInputError("oauth-response-invalid", "ServiceTitan OAuth returned invalid JSON."); }
  if (!payload || typeof payload.access_token !== "string" || payload.access_token.length < 20) {
    throw new WorkerInputError("oauth-response-invalid", "ServiceTitan OAuth did not return a usable access token.");
  }
  return payload.access_token;
}

async function fetchReport({ credentials, token, connection, source, parameters }) {
  const apiBase = connection.environment === "integration" ? "https://api-integration.servicetitan.io" : "https://api.servicetitan.io";
  const encodedTenant = encodeURIComponent(connection.service_titan_tenant_id);
  const encodedCategory = encodeURIComponent(source.category_id);
  const encodedReport = encodeURIComponent(source.report_id);
  const allRows = [];
  let observedFields;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${apiBase}/reporting/v2/tenant/${encodedTenant}/report-category/${encodedCategory}/reports/${encodedReport}/data?page=${page}&pageSize=${PAGE_SIZE}&includeTotal=false`;
    const response = await fetchWithPolicy(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "ST-App-Key": credentials.appKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ parameters }),
    }, "report-data");
    let payload;
    try { payload = await response.json(); } catch { throw new WorkerInputError("report-response-invalid", "ServiceTitan report data returned invalid JSON."); }
    const parsed = parseReportDataResponse(payload, source.fields);
    if (!observedFields) observedFields = parsed.fields;
    allRows.push(...parsed.rows);
    if (!parsed.hasMore) return { fields: observedFields, rows: allRows, pageCount: page };
  }
  throw new WorkerInputError("report-page-limit", `ServiceTitan report exceeded the ${MAX_PAGES * PAGE_SIZE} row safety limit.`);
}

async function exactSingle(query, code, message) {
  const { data, error } = await query.maybeSingle();
  if (error || !data) throw new WorkerInputError(code, message);
  return data;
}

async function loadGovernedBinding(supabase, organizationId, bindingId) {
  const binding = await exactSingle(supabase.from("custom_kpi_location_bindings").select("id,organization_id,kpi_definition_id,location_id,connection_id,service_titan_tenant_id,source_method,report_source_id,report_reduction,parameter_values,value_field,numerator_field,denominator_field,approval_status,canonical_source_fingerprint,approved_report_source_fingerprint").eq("organization_id", organizationId).eq("id", bindingId), "binding-unavailable", "The exact KPI binding is unavailable.");
  if (binding.source_method !== "saved_report" || binding.approval_status !== "approved" || !binding.canonical_source_fingerprint) throw new WorkerInputError("binding-not-approved", "The binding is not an approved saved-report binding.");
  const [definition, location, connection, , source] = await Promise.all([
    exactSingle(supabase.from("custom_kpi_definitions").select("id,lifecycle,type,value_kind").eq("organization_id", organizationId).eq("id", binding.kpi_definition_id), "definition-unavailable", "The KPI definition is unavailable."),
    exactSingle(supabase.from("locations").select("id,status").eq("organization_id", organizationId).eq("id", binding.location_id), "location-unavailable", "The exact location is unavailable."),
    exactSingle(supabase.from("service_titan_connections").select("id,organization_id,service_titan_tenant_id,environment,status,secret_reference").eq("organization_id", organizationId).eq("id", binding.connection_id).eq("service_titan_tenant_id", binding.service_titan_tenant_id), "connection-unavailable", "The exact ServiceTitan connection is unavailable."),
    exactSingle(supabase.from("service_titan_connection_locations").select("connection_id,location_id,revoked_at").eq("organization_id", organizationId).eq("connection_id", binding.connection_id).eq("location_id", binding.location_id).is("revoked_at", null), "assignment-unavailable", "The exact active connection-to-location assignment is unavailable."),
    exactSingle(supabase.from("service_titan_report_sources").select("id,organization_id,connection_id,service_titan_tenant_id,category_id,report_id,fields,canonical_source_fingerprint,lifecycle,status").eq("organization_id", organizationId).eq("id", binding.report_source_id).eq("connection_id", binding.connection_id).eq("service_titan_tenant_id", binding.service_titan_tenant_id), "source-unavailable", "The exact saved-report source is unavailable."),
  ]);
  if (definition.lifecycle !== "published" || definition.type !== "service_titan") throw new WorkerInputError("definition-not-published", "The KPI definition is not a published ServiceTitan KPI.");
  if (location.status !== "active") throw new WorkerInputError("location-inactive", "The bound location is inactive.");
  if (connection.status !== "ready") throw new WorkerInputError("connection-not-ready", "The ServiceTitan connection is not validated and ready.");
  if (source.lifecycle !== "approved" || source.status !== "active") throw new WorkerInputError("source-not-approved", "The saved-report source is not approved and active.");
  if (!binding.approved_report_source_fingerprint || binding.approved_report_source_fingerprint !== source.canonical_source_fingerprint) {
    throw new WorkerInputError("source-contract-drift", "The current report source no longer matches the fingerprint pinned to the approved binding.");
  }
  if (!Array.isArray(source.fields) || !source.fields.length || source.fields.some((field) => !field || typeof field.name !== "string")) throw new WorkerInputError("source-fields-invalid", "The approved report source fields are invalid.");
  const { data: evidence, error: evidenceError } = await supabase.from("custom_kpi_binding_evidence").select("evidence_type,status,source_fingerprint").eq("organization_id", organizationId).eq("binding_id", bindingId).eq("source_fingerprint", binding.canonical_source_fingerprint).eq("status", "pass");
  if (evidenceError) throw new WorkerInputError("evidence-unavailable", "Binding evidence could not be verified.");
  const passed = new Set((evidence || []).map((item) => item.evidence_type));
  if (!passed.has("sample") || !passed.has("reconciliation")) throw new WorkerInputError("evidence-incomplete", "Current passing sample and reconciliation evidence are required.");
  return { binding, definition, connection, source };
}

async function markConnectionAttention(supabase, connectionId, organizationId, code) {
  if (!connectionId || !organizationId) return;
  await supabase.from("service_titan_connections").update({ status: "needs_attention", last_error_code: code.slice(0, 120) }).eq("id", connectionId).eq("organization_id", organizationId).not("status", "in", "(disabled,archived)");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  const organizationId = args["organization-id"];
  const bindingId = args["binding-id"];
  if (!UUID_PATTERN.test(organizationId || "") || !UUID_PATTERN.test(bindingId || "")) throw new WorkerInputError("identity-invalid", "Organization and binding IDs must be canonical UUIDs.");
  const period = parsePeriod(args["period-start"], args["period-end"]);
  const now = new Date();
  if (period.start > now || period.end.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new WorkerInputError("period-future", "The ingestion period cannot extend materially into the future.");
  }
  const expectedConfirmation = `${organizationId}:${bindingId}:${period.start.toISOString()}`;
  if (args.confirm !== expectedConfirmation) throw new WorkerInputError("confirmation-invalid", "--confirm must exactly match ORGANIZATION_UUID:BINDING_UUID:PERIOD_START_ISO.");

  const supabase = serviceRoleClient();
  let connectionId;
  try {
    const governed = await loadGovernedBinding(supabase, organizationId, bindingId);
    connectionId = governed.connection.id;
    const idempotencyKey = makeObservationIdempotencyKey({ organizationId, bindingId, sourceFingerprint: governed.binding.canonical_source_fingerprint, periodStart: period.start, periodEnd: period.end });
    const { data: existing, error: existingError } = await supabase.from("kpi_observations").select("id").eq("organization_id", organizationId).eq("binding_id", bindingId).eq("idempotency_key", idempotencyKey).maybeSingle();
    if (existingError) throw new WorkerInputError("observation-check-failed", "The observation idempotency check failed.");
    if (existing) { console.log("Observation already materialized; no ServiceTitan request was made."); return; }

    const credentials = await resolveSecret(governed.connection.secret_reference);
    const token = await obtainToken(credentials, governed.connection.environment);
    const parameters = buildReportParameters(governed.binding.parameter_values, period.start, period.end);
    const report = await fetchReport({ credentials, token, connection: governed.connection, source: governed.source, parameters });
    const reduced = reduceReportRows({ rows: report.rows, fields: report.fields, reduction: governed.binding.report_reduction, valueField: governed.binding.value_field, numeratorField: governed.binding.numerator_field, denominatorField: governed.binding.denominator_field, valueKind: governed.definition.value_kind });
    if (args.dryRun) { console.log(`Dry run passed: ${report.rows.length} rows across ${report.pageCount} page(s); observation not written.`); return; }

    const { data: prior, error: priorError } = await supabase.from("kpi_observations").select("value").eq("organization_id", organizationId).eq("binding_id", bindingId).eq("source_fingerprint", governed.binding.canonical_source_fingerprint).eq("status", "valid").lte("period_end", period.start.toISOString()).order("period_end", { ascending: false }).order("observed_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
    if (priorError) throw new WorkerInputError("prior-observation-query-failed", "The prior observation lookup failed.");
    const observedAt = new Date();
    const { error: insertError } = await supabase.from("kpi_observations").insert({
      organization_id: organizationId,
      binding_id: bindingId,
      kpi_definition_id: governed.binding.kpi_definition_id,
      location_id: governed.binding.location_id,
      source_fingerprint: governed.binding.canonical_source_fingerprint,
      // Saved-report source contracts are fingerprint-pinned. Their numeric source
      // version is 1; endpoint recipes use their governed recipe version.
      source_version: 1,
      period_start: period.start.toISOString(),
      period_end: period.end.toISOString(),
      observed_at: observedAt.toISOString(),
      value: reduced.value,
      prior_value: prior?.value ?? null,
      numerator: reduced.numerator,
      denominator: reduced.denominator,
      status: "valid",
      confidence: "high",
      unmapped_record_count: 0,
      idempotency_key: idempotencyKey,
      metadata: { ingestionMethod: "saved-report", rowCount: report.rows.length, pageCount: report.pageCount, observedFieldNames: report.fields },
    });
    if (insertError && insertError.code !== "23505") throw new WorkerInputError("observation-write-failed", "The governed observation could not be written.");
    console.log(insertError?.code === "23505" ? "Observation was concurrently materialized; duplicate write suppressed." : "ServiceTitan report observation materialized successfully.");
  } catch (error) {
    const code = error instanceof WorkerInputError ? error.code : "worker-unexpected";
    await markConnectionAttention(supabase, connectionId, organizationId, code).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof WorkerInputError ? error.code : "worker-unexpected";
    console.error(`ServiceTitan report ingestion failed (${code}).`);
    process.exitCode = 1;
  });
}
