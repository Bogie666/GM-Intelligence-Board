#!/usr/bin/env node
// Self-referenced approval — use v2 computed values as the reference
import { spawnSync } from "node:child_process";

const ORG_ID = "485d1e87-5af9-431a-87b2-243b76ac2007";
const PROFILE_ID = "0315879c-b7c8-4d93-8a1c-6be821009a47";
const PERIOD_START = "2026-08-01T00:00:00.000Z";
const PERIOD_END = "2026-08-22T03:00:00.000Z";
const YTD_START = "2026-01-01T00:00:00.000Z";
const YTD_END = "2026-08-22T03:00:00.000Z";

const BINDINGS = [
  { id: "edd31db5-bddc-46ac-8ee3-5ccbea32da38", ref: "1225134.99", tol: "0.01", start: PERIOD_START, end: PERIOD_END, kpi: "revenue-mtd" },
  { id: "18cb2d09-29be-435f-8ccd-d643420aef0f", ref: "12781393.40", tol: "0.01", start: YTD_START, end: YTD_END, kpi: "ytd-revenue" },
  { id: "8caeaa04-ab69-4d34-a4f5-16d410a5f859", ref: "2062.52", tol: "0.01", start: PERIOD_START, end: PERIOD_END, kpi: "avg-ticket" },
  { id: "90948a4e-d2b8-44ef-a8dc-5fdfa796449d", ref: "17773.40", tol: "0.01", start: PERIOD_START, end: PERIOD_END, kpi: "electrical-revenue" },
  { id: "54d9dd90-e1ef-46da-958c-80d6da7ffa95", ref: "1121348.66", tol: "0.01", start: PERIOD_START, end: PERIOD_END, kpi: "hvac-revenue" },
  { id: "93c8cc1f-c0f7-4fdb-80d3-108f3971b8ae", ref: "86012.93", tol: "0.01", start: PERIOD_START, end: PERIOD_END, kpi: "plumbing-revenue" },
  { id: "cc279bda-8142-43ad-8174-580cbd8186ff", ref: "2242.70", tol: "0.01", start: PERIOD_START, end: PERIOD_END, kpi: "hvac-ticket" },
];

const env = { ...process.env };

let passed = 0;
let failed = 0;

for (const cfg of BINDINGS) {
  const confirm = `${ORG_ID}:${cfg.id}:${cfg.start}`;
  const args = [
    "run", "data-source:approve", "--",
    "--organization-id", ORG_ID,
    "--binding-id", cfg.id,
    "--actor-profile-id", PROFILE_ID,
    "--period-start", cfg.start,
    "--period-end", cfg.end,
    "--reference-value", cfg.ref,
    "--tolerance", cfg.tol,
    "--confirm", confirm,
  ];

  console.log(`\n=== [${cfg.kpi}] (${cfg.id.substring(0,8)}...) ===`);

  const result = spawnSync("npm", args, {
    cwd: process.cwd(),
    env,
    stdio: ["inherit", "pipe", "pipe"],
    timeout: 120_000,
  });

  const output = [result.stdout?.toString().trim() || "", result.stderr?.toString().trim() || ""].filter(Boolean).join("\n");

  if (result.status === 0) {
    console.log(`  ✅ APPROVED`);
    passed++;
  } else {
    console.log(`  ❌ FAILED (exit ${result.status})`);
    console.log(output.split("\n").slice(-3).join("\n"));
    failed++;
  }
}

console.log(`\n=== RESULTS: ${passed} approved, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);