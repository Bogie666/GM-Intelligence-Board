import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalRequestId,
  governSavedReport,
  parseApprovalArgs,
} from "./approve-servicetitan-saved-report.mjs";

const ORGANIZATION_ID = "a0000000-0000-4000-8000-000000000001";
const BINDING_ID = "b0000000-0000-4000-8000-000000000001";
const ACTOR_ID = "40000000-0000-4000-8000-000000000001";
const SOURCE_ID = "50000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "60000000-0000-4000-8000-000000000001";
const DEFINITION_ID = "70000000-0000-4000-8000-000000000001";
const LOCATION_ID = "80000000-0000-4000-8000-000000000001";
const START = "2026-08-01T00:00:00.000Z";
const END = "2026-08-02T00:00:00.000Z";

function args(overrides = {}) {
  return {
    "organization-id": ORGANIZATION_ID,
    "binding-id": BINDING_ID,
    "actor-profile-id": ACTOR_ID,
    "period-start": START,
    "period-end": END,
    "reference-value": "30",
    tolerance: "0.01",
    confirm: `${ORGANIZATION_ID}:${BINDING_ID}:${START}`,
    ...overrides,
  };
}

function mockSupabase(rpcResult = { approved: true, delta: 0, tolerance: 0.01 }) {
  const rows = {
    custom_kpi_location_bindings: {
      id: BINDING_ID, organization_id: ORGANIZATION_ID, kpi_definition_id: DEFINITION_ID,
      location_id: LOCATION_ID, connection_id: CONNECTION_ID, service_titan_tenant_id: "123456",
      source_method: "saved_report", report_source_id: SOURCE_ID, report_reduction: "sum",
      parameter_values: { From: "$periodStartDate", To: "$periodEndDate" }, value_field: "Revenue",
      numerator_field: null, denominator_field: null, approval_status: "draft",
    },
    custom_kpi_definitions: { id: DEFINITION_ID, type: "service_titan", value_kind: "currency", lifecycle: "published" },
    service_titan_report_sources: {
      id: SOURCE_ID, organization_id: ORGANIZATION_ID, connection_id: CONNECTION_ID,
      service_titan_tenant_id: "123456", category_id: "operations", report_id: "revenue",
      fields: [{ name: "Revenue", label: "Revenue", type: "number" }], parameters: [],
      expected_schema_fingerprint: "schema-v3.test", canonical_source_fingerprint: "report-source-v1.test",
      lifecycle: "draft", status: "active",
    },
    service_titan_connections: {
      id: CONNECTION_ID, organization_id: ORGANIZATION_ID, service_titan_tenant_id: "123456",
      environment: "production", status: "ready", secret_reference: "supabase-vault://90000000-0000-4000-8000-000000000001", configuration_revision: 1,
    },
    service_titan_connection_locations: { connection_id: CONNECTION_ID, location_id: LOCATION_ID, revoked_at: null },
    organization_memberships: { profile_id: ACTOR_ID, role: "owner", status: "active" },
  };
  const calls = { rpc: null };
  function from(table) {
    const builder = {
      select() { return builder; }, eq() { return builder; }, is() { return builder; }, in() { return builder; },
      async maybeSingle() { return { data: rows[table], error: null }; },
    };
    return builder;
  }
  return {
    calls,
    client: {
      from,
      async rpc(name, payload) { calls.rpc = { name, payload }; return { data: rpcResult, error: null }; },
    },
  };
}

test("approval arguments are strict key/value pairs", () => {
  assert.deepEqual(parseApprovalArgs(["--organization-id", ORGANIZATION_ID, "--tolerance", "1"]), {
    "organization-id": ORGANIZATION_ID,
    tolerance: "1",
  });
  assert.throws(() => parseApprovalArgs(["unexpected"]), /Unexpected argument/);
  assert.throws(() => parseApprovalArgs(["--tolerance"]), /Missing value/);
});

test("approval request IDs are stable and reconciliation-bound", () => {
  const input = { organizationId: ORGANIZATION_ID, bindingId: BINDING_ID, periodStart: START, periodEnd: END, referenceValue: 30, tolerance: 0.01 };
  const first = approvalRequestId(input);
  assert.equal(first, approvalRequestId(input));
  assert.notEqual(first, approvalRequestId({ ...input, referenceValue: 31 }));
  assert.match(first, /^saved-report-approval:[0-9a-f]{40}$/);
});

test("governance samples the exact contract and invokes only the narrow approval RPC", async () => {
  const mock = mockSupabase();
  let resolvedReference;
  const result = await governSavedReport(args(), {
    supabase: mock.client,
    async resolveSecret(reference) { resolvedReference = reference; return { clientId: "client-id", clientSecret: "client-secret", appKey: "app-key-value" }; },
    async obtainToken() { return "provider-access-token-value"; },
    async fetchReport({ parameters }) {
      assert.deepEqual(parameters, [{ name: "From", value: "2026-08-01" }, { name: "To", value: "2026-08-02" }]);
      return { fields: ["Revenue"], observedSchemaFingerprint: "schema-v3.test", rows: [["10"], ["20"]], pageCount: 1 };
    },
  });
  assert.equal(resolvedReference, "supabase-vault://90000000-0000-4000-8000-000000000001");
  assert.deepEqual(result, { approved: true, delta: "0", tolerance: "0.01", rowCount: 2, pageCount: 1 });
  assert.equal(mock.calls.rpc.name, "record_and_approve_service_titan_saved_report");
  assert.equal(mock.calls.rpc.payload.p_organization_id, ORGANIZATION_ID);
  assert.equal(mock.calls.rpc.payload.p_binding_id, BINDING_ID);
  assert.equal(mock.calls.rpc.payload.p_computed_value, "30");
  assert.equal(mock.calls.rpc.payload.p_reference_value, "30");
  assert.equal(mock.calls.rpc.payload.p_observed_schema_fingerprint, "schema-v3.test");
});

test("negative reconciliation tolerance fails before any provider or database work", async () => {
  let touched = false;
  await assert.rejects(
    governSavedReport(args({ tolerance: "-0.01" }), { supabase: { from() { touched = true; } } }),
    /Tolerance cannot be negative/,
  );
  assert.equal(touched, false);
});
