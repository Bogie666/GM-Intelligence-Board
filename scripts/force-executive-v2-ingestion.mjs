#!/usr/bin/env node
// Force-run ingestion for Executive v2 bindings (bypass scheduler timing)
// Directly calls executeEndpointRecipe for each approved v2 binding

import { createClient } from "@supabase/supabase-js";
import { executeEndpointRecipe, makeEndpointObservationIdempotencyKey } from "./lib/servicetitan-endpoint-ingestion.mjs";
import { parseCredentialPayload, parsePeriod, WorkerInputError } from "./lib/servicetitan-report.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing Supabase credentials");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

async function main() {
  // Fetch all approved v2 bindings
  const { data: bindings, error } = await supabase
    .from("custom_kpi_location_bindings")
    .select(`
      id, organization_id, kpi_definition_id, location_id, connection_id,
      service_titan_tenant_id, endpoint_recipe_id, endpoint_recipe_version,
      refresh_interval, observation_window, canonical_source_fingerprint,
      business_unit_mappings, parameter_values
    `)
    .eq("approval_status", "approved")
    .eq("source_method", "endpoint_recipe")
    .in("endpoint_recipe_id", ["completed-revenue", "average-invoice-ticket", "sales-close-rate"])
    .gte("endpoint_recipe_version", 2);

  if (error) { console.error("Fetch error:", error); process.exit(1); }
  if (!bindings?.length) { console.log("No v2 bindings found"); process.exit(0); }

  console.log(`Found ${bindings.length} v2 bindings to process`);

  for (const binding of bindings) {
    // Resolve credentials
    const { data: conn, error: connErr } = await supabase
      .from("service_titan_connections")
      .select("id, organization_id, service_titan_tenant_id, credential_payload, environment")
      .eq("id", binding.connection_id)
      .eq("organization_id", binding.organization_id)
      .single();

    if (connErr || !conn) {
      console.error(`  [${binding.id.slice(0,8)}] Connection error:`, connErr);
      continue;
    }

    const credentials = parseCredentialPayload(conn.credential_payload);
    if (!credentials) {
      console.error(`  [${binding.id.slice(0,8)}] Invalid credentials`);
      continue;
    }

    // Determine period based on observation_window and timezone
    const { data: loc } = await supabase
      .from("locations")
      .select("timezone")
      .eq("id", binding.location_id)
      .single();

    const tz = loc?.timezone || "America/Chicago";
    const now = new Date();
    const start = new Date(now);

    let period;
    if (binding.observation_window === "mtd") {
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);
      period = { start, end: now };
    } else if (binding.observation_window === "today") {
      start.setUTCHours(0, 0, 0, 0);
      period = { start, end: now };
    } else if (binding.observation_window === "ytd") {
      start.setUTCMonth(0, 1);
      start.setUTCHours(0, 0, 0, 0);
      period = { start, end: now };
    } else {
      // trailing = last refresh_interval
      const interval = parseInt(binding.refresh_interval) * (binding.refresh_interval.includes("h") ? 3600000 : 60000);
      period = { start: new Date(now.getTime() - interval), end: now };
    }

    try {
      const options = {
        parameterValues: binding.parameter_values || {},
      };

      console.log(`  Running [${binding.endpoint_recipe_id}@${binding.endpoint_recipe_version}] ${binding.id.slice(0,8)}...`);

      const result = await executeEndpointRecipe({
        credentials,
        environment: conn.environment,
        tenantId: binding.service_titan_tenant_id,
        recipeId: binding.endpoint_recipe_id,
        recipeVersion: binding.endpoint_recipe_version,
        businessUnitMappings: binding.business_unit_mappings || {},
        period,
        options,
      });

      const idempotencyKey = makeEndpointObservationIdempotencyKey({
        organizationId: binding.organization_id,
        bindingId: binding.id,
        sourceFingerprint: binding.canonical_source_fingerprint,
        periodStart: period.start,
        periodEnd: period.end,
      });

      // Write observation
      const { error: insertErr } = await supabase.from("kpi_observations").insert({
        organization_id: binding.organization_id,
        binding_id: binding.id,
        kpi_definition_id: binding.kpi_definition_id,
        location_id: binding.location_id,
        source_fingerprint: binding.canonical_source_fingerprint,
        source_version: 1,
        period_start: period.start.toISOString(),
        period_end: period.end.toISOString(),
        observed_at: now.toISOString(),
        value: result.decimalValue,
        numerator: result.numerator || result.decimalValue,
        denominator: result.denominator || null,
        status: "valid",
        confidence: "high",
        unmapped_record_count: 0,
        idempotency_key: idempotencyKey,
        metadata: {
          recipeId: binding.endpoint_recipe_id,
          recipeVersion: binding.endpoint_recipe_version,
          rowCount: result.rowCount,
          source: "direct-force-ingestion",
        },
      });

      if (insertErr) {
        console.error(`  Insert error:`, insertErr.message);
      } else {
        console.log(`  ✅ Value: ${result.decimalValue} (${result.rowCount} rows)`);
      }
    } catch (err) {
      console.error(`  ❌ Error:`, err.message || err);
    }
  }

  console.log("\nDone. Refresh the Executive page.");
}

main().catch(console.error);