#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import Decimal from "decimal.js";
import {
  exactSingle,
  fetchReport,
  obtainToken,
  resolveSecret,
  serviceRoleClient,
} from "./ingest-servicetitan-report.mjs";
import {
  WorkerInputError,
  buildReportParameters,
  parsePeriod,
  reduceReportRows,
} from "./lib/servicetitan-report.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function parseApprovalArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--")) throw new WorkerInputError("argument-invalid", `Unexpected argument ${token}.`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new WorkerInputError("argument-missing", `Missing value for ${token}.`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function finiteDecimal(raw, label) {
  if (typeof raw !== "string" || !DECIMAL_PATTERN.test(raw.trim())) {
    throw new WorkerInputError("reconciliation-invalid", `${label} must be a finite decimal.`);
  }
  const value = new Decimal(raw.trim());
  if (!value.isFinite()) throw new WorkerInputError("reconciliation-invalid", `${label} must be finite.`);
  return value.toFixed();
}

function usage() {
  console.log(`Usage:
  NEXT_PUBLIC_SUPABASE_URL='https://PROJECT.supabase.co' \\
  SUPABASE_SERVICE_ROLE_KEY='...' \\
  node scripts/approve-servicetitan-saved-report.mjs \\
    --organization-id ORGANIZATION_UUID \\
    --binding-id BINDING_UUID \\
    --actor-profile-id ACTIVE_OWNER_OR_ADMIN_PROFILE_UUID \\
    --period-start 2026-08-01T00:00:00.000Z \\
    --period-end 2026-08-02T00:00:00.000Z \\
    --reference-value 12345.67 \\
    --tolerance 0.01 \\
    --confirm ORGANIZATION_UUID:BINDING_UUID:2026-08-01T00:00:00.000Z

The command fetches the exact declared ServiceTitan report, validates its ordered schema,
computes the configured KPI reduction, and compares it with an independently sourced
reference. Passing sample and reconciliation evidence are appended before the report and
binding are atomically approved. Credentials and provider response bodies are never printed.`);
}

export function approvalRequestId({ organizationId, bindingId, periodStart, periodEnd, referenceValue, tolerance }) {
  const digest = createHash("sha256")
    .update(JSON.stringify({ organizationId, bindingId, periodStart, periodEnd, referenceValue, tolerance }))
    .digest("hex")
    .slice(0, 40);
  return `saved-report-approval:${digest}`;
}

export async function governSavedReport(args, dependencies = {}) {
  const organizationId = args["organization-id"];
  const bindingId = args["binding-id"];
  const actorProfileId = args["actor-profile-id"];
  if (![organizationId, bindingId, actorProfileId].every((value) => UUID_PATTERN.test(value || ""))) {
    throw new WorkerInputError("identity-invalid", "Organization, binding, and actor profile IDs must be canonical UUIDs.");
  }
  const period = parsePeriod(args["period-start"], args["period-end"]);
  const now = new Date();
  if (period.start > now || period.end.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new WorkerInputError("period-future", "The governance sample period cannot extend materially into the future.");
  }
  const expectedConfirmation = `${organizationId}:${bindingId}:${period.start.toISOString()}`;
  if (args.confirm !== expectedConfirmation) {
    throw new WorkerInputError("confirmation-invalid", "--confirm must exactly match ORGANIZATION_UUID:BINDING_UUID:PERIOD_START_ISO.");
  }
  const referenceValue = finiteDecimal(args["reference-value"], "Reference value");
  const tolerance = finiteDecimal(args.tolerance, "Tolerance");
  if (new Decimal(tolerance).isNegative()) throw new WorkerInputError("reconciliation-invalid", "Tolerance cannot be negative.");

  const supabase = dependencies.supabase ?? serviceRoleClient();
  const binding = await exactSingle(
    supabase.from("custom_kpi_location_bindings")
      .select("id,organization_id,kpi_definition_id,location_id,connection_id,service_titan_tenant_id,source_method,report_source_id,report_reduction,parameter_values,value_field,numerator_field,denominator_field,approval_status")
      .eq("organization_id", organizationId).eq("id", bindingId),
    "binding-unavailable", "The exact KPI binding is unavailable.",
  );
  if (binding.source_method !== "saved_report" || !binding.report_source_id || binding.approval_status === "archived") {
    throw new WorkerInputError("binding-ineligible", "The binding is not an active saved-report binding.");
  }

  const [definition, source, connection, , actor] = await Promise.all([
    exactSingle(supabase.from("custom_kpi_definitions").select("id,type,value_kind,lifecycle").eq("organization_id", organizationId).eq("id", binding.kpi_definition_id), "definition-unavailable", "The KPI definition is unavailable."),
    exactSingle(supabase.from("service_titan_report_sources").select("id,organization_id,connection_id,service_titan_tenant_id,category_id,report_id,fields,parameters,expected_schema_fingerprint,canonical_source_fingerprint,lifecycle,status").eq("organization_id", organizationId).eq("id", binding.report_source_id), "source-unavailable", "The saved-report source is unavailable."),
    exactSingle(supabase.from("service_titan_connections").select("id,organization_id,service_titan_tenant_id,environment,status,secret_reference,configuration_revision").eq("organization_id", organizationId).eq("id", binding.connection_id).eq("service_titan_tenant_id", binding.service_titan_tenant_id), "connection-unavailable", "The exact ServiceTitan connection is unavailable."),
    exactSingle(supabase.from("service_titan_connection_locations").select("connection_id,location_id,revoked_at").eq("organization_id", organizationId).eq("connection_id", binding.connection_id).eq("location_id", binding.location_id).is("revoked_at", null), "assignment-unavailable", "The active connection-to-location assignment is unavailable."),
    exactSingle(supabase.from("organization_memberships").select("profile_id,role,status").eq("organization_id", organizationId).eq("profile_id", actorProfileId).eq("status", "active").in("role", ["owner", "admin"]), "actor-unauthorized", "The approving profile is not an active tenant owner or admin."),
  ]);
  void actor;
  if (definition.type !== "service_titan" || definition.lifecycle !== "published") throw new WorkerInputError("definition-ineligible", "The KPI definition must be a published ServiceTitan KPI.");
  if (source.status !== "active" || source.lifecycle === "archived") throw new WorkerInputError("source-ineligible", "The saved-report source is archived or inactive.");
  if (source.connection_id !== binding.connection_id || source.service_titan_tenant_id !== binding.service_titan_tenant_id) throw new WorkerInputError("source-contract-mismatch", "The source and binding connection identities do not match.");
  if (connection.status !== "ready") throw new WorkerInputError("connection-not-ready", "The ServiceTitan connection must be validated before governance.");
  if (!Array.isArray(source.fields) || source.fields.length === 0) throw new WorkerInputError("source-fields-invalid", "The declared report schema is unavailable.");

  const credentials = await (dependencies.resolveSecret ?? resolveSecret)(connection.secret_reference, supabase, organizationId, connection.id);
  const token = await (dependencies.obtainToken ?? obtainToken)(credentials, connection.environment);
  const parameters = buildReportParameters(binding.parameter_values, period.start, period.end);
  const report = await (dependencies.fetchReport ?? fetchReport)({ credentials, token, connection, source, parameters });
  const reduced = reduceReportRows({
    rows: report.rows,
    fields: report.fields,
    reduction: binding.report_reduction,
    valueField: binding.value_field,
    numeratorField: binding.numerator_field,
    denominatorField: binding.denominator_field,
    valueKind: definition.value_kind,
  });
  const requestId = approvalRequestId({
    organizationId, bindingId,
    periodStart: period.start.toISOString(), periodEnd: period.end.toISOString(),
    referenceValue, tolerance,
  });
  const { data, error } = await supabase.rpc("record_and_approve_service_titan_saved_report", {
    p_organization_id: organizationId,
    p_report_source_id: source.id,
    p_binding_id: bindingId,
    p_actor_profile_id: actorProfileId,
    p_row_count: report.rows.length,
    p_computed_value: reduced.decimalValue,
    p_reference_value: referenceValue,
    p_tolerance: tolerance,
    p_observed_schema_fingerprint: report.observedSchemaFingerprint,
    p_period_start: period.start.toISOString(),
    p_period_end: period.end.toISOString(),
    p_request_id: requestId,
  });
  if (error || !data || typeof data.approved !== "boolean") {
    throw new WorkerInputError("approval-write-failed", "The governed evidence and approval transaction failed.");
  }
  return { approved: data.approved, delta: String(data.delta), tolerance: String(data.tolerance), rowCount: report.rows.length, pageCount: report.pageCount };
}

async function main() {
  const args = parseApprovalArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  const result = await governSavedReport(args);
  if (!result.approved) {
    console.error(`Reconciliation failed: absolute delta ${new Decimal(result.delta).abs().toFixed()} exceeds tolerance ${result.tolerance}. Evidence was recorded; approval was not granted.`);
    process.exitCode = 2;
    return;
  }
  console.log(`Saved report and KPI binding approved: ${result.rowCount} rows across ${result.pageCount} page(s); delta ${result.delta} within tolerance ${result.tolerance}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof WorkerInputError ? error.code : "approval-unexpected";
    console.error(`Saved-report governance failed (${code}).`);
    process.exitCode = 1;
  });
}
