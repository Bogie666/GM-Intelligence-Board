import { describe, expect, it } from "vitest";
import {
  BOUNDED_DECIMAL_MAX_LENGTH,
  DOMO_DATASET_REDUCTIONS,
  DOMO_REFRESH_CADENCES,
  parseBoundedDecimal,
  validateBoundedDecimal,
  validateCompletedPeriod,
  validateDomoConnectionInput,
  validateDomoDatasetConfigurationInput,
  validateDomoDatasetSourceInput,
  validateDomoRefreshCadence,
} from "./domo-admin";

const DATASET_ID = "123e4567-e89b-12d3-a456-426614174000";
const validDataset = {
  datasetId: DATASET_ID,
  name: "Historical revenue",
  description: "Daily financial actuals from Domo.",
  reduction: "sum",
  valueColumn: "Net Revenue",
  dateColumn: "Posted-Date",
  filterColumn: "Location Name",
  filterValue: "Phoenix Main",
};

function expectSourceError(result: ReturnType<typeof validateDomoDatasetSourceInput>, field: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.fieldErrors).toHaveProperty(field);
}

describe("Domo connection validation", () => {
  it("accepts exactly trimmed printable 8-4096 character credentials", () => {
    expect(validateDomoConnectionInput({
      displayName: "  Production Domo  ",
      clientId: "12345678",
      clientSecret: "s".repeat(4096),
    })).toEqual({
      ok: true,
      value: { displayName: "Production Domo", clientId: "12345678", clientSecret: "s".repeat(4096) },
    });
  });

  it.each([
    ["clientId", "1234567"],
    ["clientId", `x${"y".repeat(4096)}`],
    ["clientId", " 12345678"],
    ["clientId", "12345678 "],
    ["clientId", "1234\n5678"],
    ["clientSecret", "1234567"],
    ["clientSecret", "1234\u007f5678"],
    ["clientSecret", 12345678],
  ])("rejects invalid %s credentials", (field, candidate) => {
    const result = validateDomoConnectionInput({
      displayName: "Domo",
      clientId: "client-id",
      clientSecret: "client-secret",
      [field]: candidate,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors).toHaveProperty(field);
  });

  it("enforces the database display-name bound", () => {
    expect(validateDomoConnectionInput({ displayName: "n".repeat(200), clientId: "client-id", clientSecret: "client-secret" }).ok).toBe(true);
    for (const displayName of ["", "  ", `n${"x".repeat(200)}`, "bad\u0000name", null]) {
      const result = validateDomoConnectionInput({ displayName, clientId: "client-id", clientSecret: "client-secret" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.fieldErrors).toHaveProperty("displayName");
    }
  });
});

describe("Domo dataset source validation", () => {
  it("exposes the worker/database reductions and binding cadences", () => {
    expect(DOMO_DATASET_REDUCTIONS).toEqual(["sum", "average", "count", "latest"]);
    expect(DOMO_REFRESH_CADENCES).toEqual(["4h", "12h", "24h"]);
  });

  it("canonicalizes a valid dataset GUID to lowercase", () => {
    const result = validateDomoDatasetSourceInput({
      ...validDataset,
      datasetId: DATASET_ID.toUpperCase(),
      name: "  Historical revenue  ",
      description: "  Daily actuals.  ",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { datasetId: DATASET_ID, name: "Historical revenue", description: "Daily actuals." },
    });
  });

  it.each([
    "123e4567-e89b-12d3-a456-42661417400",
    "{123e4567-e89b-12d3-a456-426614174000}",
    "123e4567e89b12d3a456426614174000",
    "not-a-guid",
    " 123e4567-e89b-12d3-a456-426614174000",
    null,
  ])("rejects noncanonical dataset ID %j", (datasetId) => {
    expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, datasetId }), "datasetId");
  });

  it("enforces count/null and non-count/value-column relationships", () => {
    expect(validateDomoDatasetSourceInput({ ...validDataset, reduction: "count", valueColumn: "" })).toMatchObject({
      ok: true,
      value: { reduction: "count", valueColumn: null },
    });
    expect(validateDomoDatasetSourceInput({ ...validDataset, reduction: "count", valueColumn: null }).ok).toBe(true);
    expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, reduction: "count", valueColumn: "Rows" }), "valueColumn");
    for (const reduction of ["sum", "average", "latest"]) {
      expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, reduction, valueColumn: "" }), "valueColumn");
    }
    expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, reduction: "median" }), "reduction");
  });

  it("requires a date column for deterministic latest reductions", () => {
    expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, reduction: "latest", dateColumn: "" }), "dateColumn");
    expect(validateDomoDatasetSourceInput({ ...validDataset, reduction: "latest", dateColumn: "Posted-Date" }).ok).toBe(true);
  });

  it("supports portfolio-safe separate month/year contracts", () => {
    const result = validateDomoDatasetSourceInput({
      ...validDataset,
      periodMode: "month_year",
      dateColumn: "",
      monthColumn: "Month",
      yearColumn: "Year",
      filterColumn: "Master Location",
      filterValue: "Lex",
      expectedPeriodRows: "1",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        periodMode: "month_year",
        monthColumn: "Month",
        yearColumn: "Year",
        filterColumn: "Master Location",
        filterValue: "Lex",
        expectedPeriodRows: 1,
      },
    });
    expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, periodMode: "month_year", dateColumn: "", monthColumn: "Month", yearColumn: "Year", filterColumn: "", filterValue: "" }), "filterColumn");
    expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, periodMode: "month_year", dateColumn: "", monthColumn: "", yearColumn: "Year" }), "monthColumn");
    expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, expectedPeriodRows: "0" }), "expectedPeriodRows");
  });

  it("uses the deployed Domo column grammar for value, date, and filter columns", () => {
    const longest = `A${"b".repeat(119)}`;
    expect(validateDomoDatasetSourceInput({
      ...validDataset,
      valueColumn: longest,
      dateColumn: "Posted date-UTC_1.0",
      filterColumn: longest,
    }).ok).toBe(true);

    for (const candidate of ["-Revenue", "_Revenue", " Revenue", "Revenue/Net", "Revenue$", `A${"b".repeat(120)}`]) {
      expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, valueColumn: candidate }), "valueColumn");
      expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, dateColumn: candidate }), "dateColumn");
      expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, filterColumn: candidate }), "filterColumn");
    }
    expect(validateDomoDatasetSourceInput({ ...validDataset, dateColumn: "", filterColumn: "", filterValue: "" })).toMatchObject({
      ok: true,
      value: { dateColumn: null, filterColumn: null, filterValue: null },
    });
  });

  it("requires filter column and a printable nonempty filter value together", () => {
    expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, filterColumn: "", filterValue: "Phoenix" }), "filterColumn");
    expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, filterColumn: "Location", filterValue: "" }), "filterValue");
    expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, filterColumn: "Location", filterValue: "   " }), "filterValue");
    expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, filterColumn: "Location", filterValue: "bad\nvalue" }), "filterValue");
    expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, filterColumn: "Location", filterValue: "x".repeat(201) }), "filterValue");
    expect(validateDomoDatasetSourceInput({ ...validDataset, filterValue: "  Phoenix Main  " })).toMatchObject({
      ok: true,
      value: { filterValue: "Phoenix Main" },
    });
  });

  it("bounds source names and descriptions", () => {
    expect(validateDomoDatasetSourceInput({ ...validDataset, name: "n".repeat(200), description: "d".repeat(500) }).ok).toBe(true);
    for (const name of ["", " ", `n${"x".repeat(200)}`, "bad\u0000name", null]) {
      expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, name }), "name");
    }
    for (const description of [`d${"x".repeat(500)}`, "bad\u007fdescription", null]) {
      expectSourceError(validateDomoDatasetSourceInput({ ...validDataset, description }), "description");
    }
  });

  it("validates cadence independently and in a complete dataset configuration", () => {
    expect(validateDomoRefreshCadence("4h")).toBe(true);
    expect(validateDomoRefreshCadence("12h")).toBe(true);
    expect(validateDomoRefreshCadence("24h")).toBe(true);
    for (const value of ["1h", "6h", "24H", "", null]) expect(validateDomoRefreshCadence(value)).toBe(false);

    expect(validateDomoDatasetConfigurationInput({ ...validDataset, refreshCadence: "12h" })).toMatchObject({
      ok: true,
      value: { refreshCadence: "12h" },
    });
    const invalid = validateDomoDatasetConfigurationInput({ ...validDataset, refreshCadence: "1h" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.fieldErrors).toHaveProperty("refreshCadence");
  });
});

describe("approval input primitives", () => {
  it("accepts strict ordinary decimal notation without coercion or trimming", () => {
    for (const value of ["0", "-0", "12", "-12.50", "0.0001"]) {
      expect(parseBoundedDecimal(value)).toBe(value);
      expect(validateBoundedDecimal(value)).toEqual({ ok: true, value });
    }
  });

  it("rejects ambiguous, non-finite, exponential, and oversized decimals", () => {
    expect(BOUNDED_DECIMAL_MAX_LENGTH).toBe(120);
    for (const value of [
      "",
      " 1",
      "1 ",
      "+1",
      ".5",
      "1.",
      "01",
      "-01.2",
      "1e3",
      "NaN",
      "Infinity",
      "--1",
      1,
      null,
      "9".repeat(BOUNDED_DECIMAL_MAX_LENGTH + 1),
    ]) {
      expect(parseBoundedDecimal(value)).toBeNull();
      expect(validateBoundedDecimal(value).ok).toBe(false);
    }
  });

  it("supports a reusable nonnegative constraint for tolerances", () => {
    expect(validateBoundedDecimal("0.01", { nonNegative: true }).ok).toBe(true);
    expect(validateBoundedDecimal("-0.01", { nonNegative: true })).toMatchObject({ ok: false });
  });

  it("validates increasing completed UTC periods with the deployed five-minute clock-skew allowance", () => {
    const now = new Date("2026-08-20T12:00:00.000Z");
    expect(validateCompletedPeriod({
      periodStart: "2026-08-01T00:00:00Z",
      periodEnd: "2026-08-20T12:05:00.000Z",
    }, now)).toEqual({
      ok: true,
      value: {
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-20T12:05:00.000Z",
      },
    });
  });

  it("rejects invalid, noncanonical, non-increasing, and future sample periods", () => {
    const now = new Date("2026-08-20T12:00:00.000Z");
    const invalidPeriods = [
      { periodStart: "not-a-date", periodEnd: "2026-08-20T00:00:00.000Z" },
      { periodStart: "2026-02-30T00:00:00.000Z", periodEnd: "2026-03-02T00:00:00.000Z" },
      { periodStart: "2026-08-20", periodEnd: "2026-08-21" },
      { periodStart: "2026-08-20T00:00:00", periodEnd: "2026-08-20T01:00:00" },
      { periodStart: "2026-08-20T02:00:00.000Z", periodEnd: "2026-08-20T01:00:00.000Z" },
      { periodStart: "2026-08-20T01:00:00.000Z", periodEnd: "2026-08-20T01:00:00.000Z" },
      { periodStart: "2026-08-20T12:01:00.000Z", periodEnd: "2026-08-20T12:02:00.000Z" },
      { periodStart: "2026-08-20T11:00:00.000Z", periodEnd: "2026-08-20T12:05:00.001Z" },
      { periodStart: null, periodEnd: "2026-08-20T00:00:00.000Z" },
    ];
    for (const period of invalidPeriods) expect(validateCompletedPeriod(period, now).ok).toBe(false);
  });

  it("fails closed when the supplied validation clock is invalid", () => {
    expect(validateCompletedPeriod({
      periodStart: "2026-08-20T00:00:00.000Z",
      periodEnd: "2026-08-20T01:00:00.000Z",
    }, new Date(Number.NaN)).ok).toBe(false);
  });
});
