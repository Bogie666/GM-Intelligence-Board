#!/usr/bin/env node

// Trusted-operator governance for endpoint-recipe, custom-endpoint, and Domo
// dataset bindings. Runs a live sample through the governed execution contract,
// compares the computed value against an independently sourced reference, and
// atomically records evidence + approval through the matching security-definer RPC.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import Decimal from "decimal.js";
import { createClient } from "@supabase/supabase-js";
import {
  executeEndpointRecipe,
  executeCustomEndpointSource,
} from "./lib/servicetitan-endpoint-ingestion.mjs";
import { executeDomoDatasetSource, parseDomoCredentialPayload } from "./lib/domo-dataset.mjs";
import { parseCredentialPayload, parsePeriod, WorkerInputError } from "./lib/servicetitan-report.mjs";
import { deriveObservationPeriod } from "./run-data-source-ingestion.mjs";

Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 80 });

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function usage() {
  console.log(`Usage:
  NEXT_PUBLIC_SUPABASE_URL='https://PROJECT.supabase.co' \\
  SUPABASE_SERVICE_ROLE_KEY='...' \\
  node scripts/approve-data-source-binding.mjs \\
    --organization-id ORGANIZATION_UUID \\
    --binding-id BINDING_UUID \\
    --actor-profile-id ACTIVE_OWNER_OR_ADMIN_PROFILE_UUID \\
    --period-start 2026-08-01T00:00:00.000Z \\
    --period-end 2026-08-02T00:00:00.000Z \\
    --reference-value 12345.67 \\
    --tolerance 0.01 \\
    --confirm ORGANIZATION_UUID:BINDING_UUID:2026-08-01T00:00:00.000Z

Supports bindings with source_method endpoint_recipe, custom_endpoint, or domo_dataset.
The live sample runs through the same execution contract the ingestion worker uses.
Credentials and provider response bodies are never printed.`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--")) throw new WorkerInputError("argument-invalid", `Unexpected argument ${token}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new WorkerInputError("argument-missing", `Missing value for ${token}.`);
    args[token.slice(2)] = value;
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
  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function finiteDecimal(raw, label) {
  if (typeof raw !== "string" || !DECIMAL_PATTERN.test(raw.trim())) {
    throw new WorkerInputError("reconciliation-invalid", `${label} must be a finite decimal.`);
  }
  const value = new Decimal(raw.trim());
  if (!value.isFinite()) throw new WorkerInputError("reconciliation-invalid", `${label} must be finite.`);
  return value.toFixed();
}

export function approvalRequestId(prefix, payload) {
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 40);
  return `${prefix}:${digest}`;
}

async function exactSingle(query, code, message) {
  const { data, error } = await query.maybeSingle();
  if (error || !data) throw new WorkerInputError(code, message);
  return data;
}

export function assertGovernedApprovalPeriod(binding, timeZone, period) {
  let governed;
  try {
    governed = deriveObservationPeriod({
      observation_window: binding.observation_window,
      refresh_interval: binding.refresh_interval,
      location_timezone: timeZone,
    }, period.end);
  } catch {
    throw new WorkerInputError("period-contract-invalid", "The binding observation period contract is invalid.");
  }
  if (governed.start.getTime() !== period.start.getTime()
      || governed.end.getTime() !== period.end.getTime()) {
    throw new WorkerInputError(
      "period-contract-mismatch",
      "The governance sample period must exactly match the binding observation window and location timezone.",
    );
  }
  return governed;
}

async function resolveServiceTitanCredentials(supabase, organizationId, connectionId) {
  const { data, error } = await supabase.rpc("resolve_service_titan_connection_secret", {
    p_organization_id: organizationId,
    p_connection_id: connectionId,
    p_purpose: "ingestion",
  });
  if (error || typeof data !== "string" || !data) {
    throw new WorkerInputError("secret-reference-unresolved", "Supabase Vault could not resolve the ServiceTitan credential.");
  }
  return parseCredentialPayload(data);
}

async function resolveDomoCredentials(supabase, organizationId, connectionId) {
  const { data, error } = await supabase.rpc("resolve_domo_connection_secret", {
    p_organization_id: organizationId,
    p_connection_id: connectionId,
    p_purpose: "ingestion",
  });
  if (error || typeof data !== "string" || !data) {
    throw new WorkerInputError("secret-reference-unresolved", "Supabase Vault could not resolve the Domo credential.");
  }
  return parseDomoCredentialPayload(data);
}

export async function governBinding(args, dependencies = {}) {
  const organizationId = args["organization-id"];
  const bindingId = args["binding-id"];
  const actorProfileId = args["actor-profile-id"];
  if (![organizationId, bindingId, actorProfileId].every((value) => UUID_PATTERN.test(value || ""))) {
    throw new WorkerInputError("identity-invalid", "Organization, binding, and actor profile IDs must be canonical UUIDs.");
  }
  const period = parsePeriod(args["period-start"], args["period-end"]);
  const now = dependencies.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new WorkerInputError("period-invalid", "The governance validation clock is invalid.");
  }
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
      .select("id,organization_id,kpi_definition_id,location_id,connection_id,service_titan_tenant_id,source_method,endpoint_recipe_id,endpoint_recipe_version,custom_endpoint_source_id,domo_connection_id,domo_dataset_source_id,parameter_values,business_unit_mappings,approval_status,observation_window,refresh_interval")
      .eq("organization_id", organizationId).eq("id", bindingId),
    "binding-unavailable", "The exact KPI binding is unavailable.",
  );
  if (binding.approval_status === "archived") throw new WorkerInputError("binding-ineligible", "Archived bindings cannot be governed.");
  if (dependencies.expectedMethod !== undefined) {
    if (!["custom_endpoint", "domo_dataset"].includes(dependencies.expectedMethod)
        || binding.source_method !== dependencies.expectedMethod) {
      throw new WorkerInputError("binding-method-mismatch", "The binding does not use the expected governed source method.");
    }
  }

  await exactSingle(
    supabase.from("organization_memberships").select("profile_id,role,status")
      .eq("organization_id", organizationId).eq("profile_id", actorProfileId)
      .eq("status", "active").in("role", ["owner", "admin"]),
    "actor-unauthorized", "The approving profile is not an active tenant owner or admin.",
  );

  let sample;
  let rpcName;
  let rpcArgs;
  const requestId = approvalRequestId(`${binding.source_method}-approval`, {
    organizationId, bindingId,
    periodStart: period.start.toISOString(), periodEnd: period.end.toISOString(),
    referenceValue, tolerance,
  });

  if (binding.source_method === "endpoint_recipe" || binding.source_method === "custom_endpoint") {
    const connection = await exactSingle(
      supabase.from("service_titan_connections")
        .select("id,organization_id,service_titan_tenant_id,environment,status,secret_reference")
        .eq("organization_id", organizationId).eq("id", binding.connection_id)
        .eq("service_titan_tenant_id", binding.service_titan_tenant_id),
      "connection-unavailable", "The exact ServiceTitan connection is unavailable.",
    );
    if (connection.status !== "ready") throw new WorkerInputError("connection-not-ready", "The ServiceTitan connection must be validated before governance.");
    const credentials = await (dependencies.resolveServiceTitanCredentials ?? resolveServiceTitanCredentials)(supabase, organizationId, connection.id);

    if (binding.source_method === "endpoint_recipe") {
      const location = await exactSingle(
        supabase.from("locations").select("id,organization_id,timezone")
          .eq("organization_id", organizationId).eq("id", binding.location_id),
        "location-unavailable", "The exact binding location timezone is unavailable.",
      );
      assertGovernedApprovalPeriod(binding, location.timezone, period);
      sample = await (dependencies.executeEndpointRecipe ?? executeEndpointRecipe)({
        credentials,
        environment: connection.environment,
        tenantId: connection.service_titan_tenant_id,
        recipeId: binding.endpoint_recipe_id,
        recipeVersion: binding.endpoint_recipe_version,
        businessUnitMappings: binding.business_unit_mappings,
        period,
        options: {
          ...(dependencies.executionOptions ?? {}),
          parameterValues: binding.parameter_values,
          timeZone: location.timezone,
        },
      });
      rpcName = "approve_service_titan_endpoint_binding";
      rpcArgs = {
        p_organization_id: organizationId,
        p_binding_id: bindingId,
        p_actor_profile_id: actorProfileId,
      };
    } else {
      const source = await exactSingle(
        supabase.from("service_titan_custom_endpoint_sources")
          .select("id,category,query_parameters,reduction,value_field,business_unit_field,lifecycle,status")
          .eq("organization_id", organizationId).eq("id", binding.custom_endpoint_source_id)
          .eq("connection_id", binding.connection_id)
          .eq("service_titan_tenant_id", binding.service_titan_tenant_id)
          .eq("status", "active").neq("lifecycle", "archived"),
        "source-unavailable", "The custom endpoint source is unavailable.",
      );
      if (source.status !== "active" || source.lifecycle === "archived") throw new WorkerInputError("source-ineligible", "The custom endpoint source is archived or inactive.");
      sample = await (dependencies.executeCustomEndpointSource ?? executeCustomEndpointSource)({
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
        options: dependencies.executionOptions,
      });
      rpcName = "approve_service_titan_custom_endpoint_binding";
      rpcArgs = {
        p_organization_id: organizationId,
        p_source_id: source.id,
        p_binding_id: bindingId,
        p_actor_profile_id: actorProfileId,
      };
    }
  } else if (binding.source_method === "domo_dataset") {
    const source = await exactSingle(
      supabase.from("domo_dataset_sources")
        .select("id,dataset_id,value_column,reduction,date_column,filter_column,filter_value,lifecycle,status")
        .eq("organization_id", organizationId).eq("id", binding.domo_dataset_source_id)
        .eq("domo_connection_id", binding.domo_connection_id)
        .eq("status", "active").neq("lifecycle", "archived"),
      "source-unavailable", "The Domo dataset source is unavailable.",
    );
    if (source.status !== "active" || source.lifecycle === "archived") throw new WorkerInputError("source-ineligible", "The Domo dataset source is archived or inactive.");
    const domoConnection = await exactSingle(
      supabase.from("domo_connections")
        .select("id,organization_id,status,secret_reference")
        .eq("organization_id", organizationId).eq("id", binding.domo_connection_id)
        .eq("status", "ready"),
      "connection-unavailable", "The exact ready Domo connection is unavailable.",
    );
    if (domoConnection.status !== "ready") throw new WorkerInputError("connection-not-ready", "The Domo connection must be validated before governance.");
    const credentials = await (dependencies.resolveDomoCredentials ?? resolveDomoCredentials)(supabase, organizationId, domoConnection.id);
    sample = await (dependencies.executeDomoDatasetSource ?? executeDomoDatasetSource)({
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
      options: dependencies.executionOptions,
    });
    rpcName = "approve_domo_dataset_binding";
    rpcArgs = {
      p_organization_id: organizationId,
      p_source_id: source.id,
      p_binding_id: bindingId,
      p_actor_profile_id: actorProfileId,
    };
  } else {
    throw new WorkerInputError("binding-ineligible", "The binding does not use a governed provider source method.");
  }

  const { data, error } = await supabase.rpc(rpcName, {
    ...rpcArgs,
    p_row_count: sample.rowCount,
    p_computed_value: sample.decimalValue,
    p_reference_value: referenceValue,
    p_tolerance: tolerance,
    p_period_start: period.start.toISOString(),
    p_period_end: period.end.toISOString(),
    p_request_id: requestId,
  });
  if (error || !data || typeof data.approved !== "boolean") {
    throw new WorkerInputError("approval-write-failed", "The governed evidence and approval transaction failed.");
  }
  return {
    approved: data.approved,
    delta: String(data.delta),
    tolerance: String(data.tolerance),
    rowCount: sample.rowCount,
    method: binding.source_method,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  const result = await governBinding(args);
  if (!result.approved) {
    console.error(`Reconciliation failed: delta ${result.delta} exceeded tolerance ${result.tolerance}. Evidence recorded; binding remains unapproved.`);
    process.exitCode = 1;
    return;
  }
  console.log(`${result.method} binding approved: ${result.rowCount} rows; delta ${result.delta} within tolerance ${result.tolerance}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof WorkerInputError ? error.code : "worker-unexpected";
    console.error(`Data-source binding governance failed (${code}).`);
    process.exitCode = 1;
  });
}
