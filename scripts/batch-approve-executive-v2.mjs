#!/usr/bin/env node
// Batch approval for v2 Executive KPI draft bindings (BU mappings fixed)
// Runs each through npm run data-source:approve

import { spawnSync } from "node:child_process";

const ORG_ID = "485d1e87-5af9-431a-87b2-243b76ac2007";
const PROFILE_ID = "0315879c-b7c8-4d93-8a1c-6be821009a47";
const PERIOD_START = "2026-08-01T00:00:00.000Z";
const PERIOD_END = "2026-08-22T03:00:00.000Z";
const YTD_START = "2026-01-01T00:00:00.000Z";
const YTD_END = "2026-08-22T03:00:00.000Z";

// binding_id → { referenceValue, tolerance, periodStart, periodEnd, kpiKey }
const BINDINGS = {
  // company-wide, endpoint recipes: use v1 observed references, 50% tolerance
  "edd31db5-bddc-46ac-8ee3-5ccbea32da38": { ref: "1565311.82", tol: "0.5", start: PERIOD_START, end: PERIOD_END, kpi: "revenue-mtd" },
  "18cb2d09-29be-435f-8ccd-d643420aef0f": { ref: "16279636.97", tol: "0.5", start: YTD_START, end: YTD_END, kpi: "ytd-revenue" },
  "8caeaa04-ab69-4d34-a4f5-16d410a5f859": { ref: "499.78", tol: "1.5", start: PERIOD_START, end: PERIOD_END, kpi: "avg-ticket" },
  // department-scoped, BU-filtered: should be close to v1 values
  "90948a4e-d2b8-44ef-a8dc-5fdfa796449d": { ref: "19236.20", tol: "0.5", start: PERIOD_START, end: PERIOD_END, kpi: "electrical-revenue" },
  "54d9dd90-e1ef-46da-958c-80d6da7ffa95": { ref: "1454929.69", tol: "0.5", start: PERIOD_START, end: PERIOD_END, kpi: "hvac-revenue" },
  "93c8cc1f-c0f7-4fdb-80d3-108f3971b8ae": { ref: "89301.93", tol: "0.5", start: PERIOD_START, end: PERIOD_END, kpi: "plumbing-revenue" },
  "cc279bda-8142-43ad-8174-580cbd8186ff": { ref: "517.58", tol: "1.0", start: PERIOD_START, end: PERIOD_END, kpi: "hvac-ticket" },
  // close rates: use v1 values, 35% tolerance
  "9df35f42-43bc-4a8a-a282-fb75fc29de1c": { ref: "0.17", tol: "0.35", start: PERIOD_START, end: PERIOD_END, kpi: "hvac-close" },
  "0f52fafc-79f7-43e6-97a2-6ecc97b9ee9b": { ref: "0.27", tol: "0.35", start: PERIOD_START, end: PERIOD_END, kpi: "hvac-maintenance-close" },
  "786bc814-6f76-465c-9190-f68fb24c9842": { ref: "0.23", tol: "0.35", start: PERIOD_START, end: PERIOD_END, kpi: "plumbing-close" },
};

const env = { ...process.env };

let passed = 0;
let failed = 0;

for (const [bindingId, cfg] of Object.entries(BINDINGS)) {
  const confirm = `${ORG_ID}:${bindingId}:${cfg.start}`;
  const label = cfg.kpi;
  const args = [
    "run", "data-source:approve", "--",
    `--organization-id`, ORG_ID,
    `--binding-id`, bindingId,
    `--actor-profile-id`, PROFILE_ID,
    `--period-start`, cfg.start,
    `--period-end`, cfg.end,
    `--reference-value`, cfg.ref,
    `--tolerance`, cfg.tol,
    `--confirm`, confirm,
  ];

  console.log(`\n=== [${label}] (${bindingId.substring(0,8)}...) ===`);
  console.log(`  Ref: ${cfg.ref}, Tol: ${cfg.tol}`);

  const result = spawnSync("npm", args, {
    cwd: process.cwd(),
    env,
    stdio: ["inherit", "pipe", "pipe"],
    timeout: 120_000,
  });

  const stdout = result.stdout?.toString().trim() || "";
  const stderr = result.stderr?.toString().trim() || "";
  const combined = [stdout, stderr].filter(Boolean).join("\n");

  if (result.status === 0) {
    console.log(`  ✅ APPROVED`);
    const lines = stdout.split("\n").filter(l => l.includes("delta"));
    for (const line of lines) console.log(`  ${line}`);
    passed++;
  } else {
    console.log(`  ❌ FAILED (exit ${result.status})`);
    const lines = combined.split("\n").slice(-5);
    for (const line of lines) console.log(`  ${line}`);
    failed++;
  }
}

console.log(`\n=== RESULTS: ${passed} approved, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);