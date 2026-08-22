import test from "node:test";
import assert from "node:assert/strict";

import { assertGovernedApprovalPeriod } from "./approve-data-source-binding.mjs";

const chicagoMtdBinding = {
  observation_window: "mtd",
  refresh_interval: "1h",
};

test("approval period accepts the exact location-timezone MTD contract", () => {
  const period = {
    start: new Date("2026-08-01T05:00:00.000Z"),
    end: new Date("2026-08-22T19:19:00.000Z"),
  };
  const governed = assertGovernedApprovalPeriod(chicagoMtdBinding, "America/Chicago", period);
  assert.equal(governed.start.toISOString(), period.start.toISOString());
  assert.equal(governed.end.toISOString(), period.end.toISOString());
});

test("approval period rejects a UTC-month boundary that is not local MTD", () => {
  assert.throws(
    () => assertGovernedApprovalPeriod(chicagoMtdBinding, "America/Chicago", {
      start: new Date("2026-08-01T00:00:00.000Z"),
      end: new Date("2026-08-22T19:19:00.000Z"),
    }),
    (error) => error.code === "period-contract-mismatch",
  );
});

test("approval period rejects unaligned ends and invalid timezones", () => {
  assert.throws(
    () => assertGovernedApprovalPeriod(chicagoMtdBinding, "America/Chicago", {
      start: new Date("2026-08-01T05:00:00.000Z"),
      end: new Date("2026-08-22T19:19:30.000Z"),
    }),
    (error) => error.code === "period-contract-mismatch",
  );
  assert.throws(
    () => assertGovernedApprovalPeriod(chicagoMtdBinding, "Not/AZone", {
      start: new Date("2026-08-01T05:00:00.000Z"),
      end: new Date("2026-08-22T19:19:00.000Z"),
    }),
    (error) => error.code === "period-contract-invalid",
  );
});

test("approval period enforces trailing cadence as well as calendar windows", () => {
  assertGovernedApprovalPeriod(
    { observation_window: "trailing", refresh_interval: "1h" },
    "America/Chicago",
    {
      start: new Date("2026-08-22T18:19:00.000Z"),
      end: new Date("2026-08-22T19:19:00.000Z"),
    },
  );
});
