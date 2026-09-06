import assert from "node:assert/strict";
import test from "node:test";
import {
  DomoIngestionError,
  assertDomoDatasetId,
  executeDomoDatasetSource,
  parseDomoCredentialPayload,
  parseDomoCsv,
  reduceDomoRows,
  validateDomoDatasetContract,
} from "./lib/domo-dataset.mjs";

const PERIOD = {
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-09-01T00:00:00.000Z"),
};
const DATASET = "11111111-2222-3333-4444-555555555555";

test("Domo credential parser enforces the exact two-field contract", () => {
  assert.deepEqual(
    parseDomoCredentialPayload(JSON.stringify({ clientId: "domo-client-1", clientSecret: "domo-secret-1" })),
    { clientId: "domo-client-1", clientSecret: "domo-secret-1" },
  );
  assert.throws(() => parseDomoCredentialPayload(JSON.stringify({ clientId: "domo-client-1" })), DomoIngestionError);
  assert.throws(() => parseDomoCredentialPayload(JSON.stringify({ clientId: "domo-client-1", clientSecret: "domo-secret-1", appKey: "extra" })), DomoIngestionError);
  assert.throws(() => parseDomoCredentialPayload("not-json"), DomoIngestionError);
  assert.throws(() => parseDomoCredentialPayload(JSON.stringify({ clientId: "short", clientSecret: "domo-secret-1" })), DomoIngestionError);
});

test("dataset ID validation requires canonical GUIDs", () => {
  assert.equal(assertDomoDatasetId(DATASET.toUpperCase()), DATASET);
  assert.throws(() => assertDomoDatasetId("11111111-2222-333-4444-555555555555"), DomoIngestionError);
  assert.throws(() => assertDomoDatasetId("select * from datasets"), DomoIngestionError);
});

test("CSV parser handles quotes, escapes, and CRLF and enforces header/rectangle shape", () => {
  const parsed = parseDomoCsv('Center,Amount,Date\r\n"Dallas, TX","1000.50",2026-08-05\r\n"Quote ""Q""",2,2026-08-06\r\n');
  assert.deepEqual(parsed.header, ["Center", "Amount", "Date"]);
  assert.deepEqual(parsed.rows, [["Dallas, TX", "1000.50", "2026-08-05"], ['Quote "Q"', "2", "2026-08-06"]]);
  assert.throws(() => parseDomoCsv('A,B\n1\n'), DomoIngestionError);
  assert.throws(() => parseDomoCsv('A,B\n"open,1\n'), DomoIngestionError);
  assert.throws(
    () => parseDomoCsv('A,B\nvalue"quoted",1\n'),
    (error) => error instanceof DomoIngestionError && error.code === "domo_export_invalid",
  );
  assert.throws(
    () => parseDomoCsv('A,B\n"value"suffix,1\n'),
    (error) => error instanceof DomoIngestionError && error.code === "domo_export_invalid",
  );
  assert.throws(
    () => parseDomoCsv("Amount, Amount\n100,900\n"),
    (error) => error instanceof DomoIngestionError && error.code === "domo_export_duplicate_header",
  );
  assert.throws(() => parseDomoCsv(""), DomoIngestionError);
});

test("CSV parser enforces the governed data-row limit without requiring a trailing newline", () => {
  const oversized = `Amount\n${"1\n".repeat(250_000)}1`;
  assert.throws(
    () => parseDomoCsv(oversized),
    (error) => error instanceof DomoIngestionError && error.code === "domo_export_too_large",
  );
});

test("dataset contract validation is fail-closed", () => {
  assert.ok(validateDomoDatasetContract({ datasetId: DATASET, valueColumn: "Amount", reduction: "sum", dateColumn: "Date", filterColumn: null, filterValue: null }));
  assert.throws(() => validateDomoDatasetContract({ datasetId: DATASET, valueColumn: "Amount", reduction: "median" }), DomoIngestionError);
  assert.throws(() => validateDomoDatasetContract({ datasetId: DATASET, valueColumn: "Amount", reduction: "count" }), DomoIngestionError);
  assert.throws(() => validateDomoDatasetContract({ datasetId: DATASET, valueColumn: "", reduction: "sum" }), DomoIngestionError);
  assert.throws(() => validateDomoDatasetContract({ datasetId: DATASET, valueColumn: "Amount", reduction: "sum", filterColumn: "Center", filterValue: null }), DomoIngestionError);
});

const HEADER = ["Center", "Amount", "Date"];
const ROWS = [
  ["Dallas", "100.10", "2026-08-05"],
  ["Dallas", "0.15", "2026-08-20"],
  ["Tyler", "50", "2026-08-10"],
  ["Dallas", "999", "2026-07-01"],
];

test("Domo reduction applies filter, period window, and Decimal math", () => {
  const sum = reduceDomoRows({
    header: HEADER,
    rows: ROWS,
    contract: { datasetId: DATASET, valueColumn: "Amount", reduction: "sum", dateColumn: "Date", filterColumn: "Center", filterValue: "Dallas" },
    period: PERIOD,
  });
  assert.equal(sum.decimalValue, "100.25");
  assert.equal(sum.rowCount, 2);

  const count = reduceDomoRows({
    header: HEADER,
    rows: ROWS,
    contract: { datasetId: DATASET, valueColumn: null, reduction: "count", dateColumn: "Date", filterColumn: null, filterValue: null },
    period: PERIOD,
  });
  assert.equal(count.decimalValue, "3");

  const average = reduceDomoRows({
    header: HEADER,
    rows: ROWS,
    contract: { datasetId: DATASET, valueColumn: "Amount", reduction: "average", dateColumn: "Date", filterColumn: "Center", filterValue: "Dallas" },
    period: PERIOD,
  });
  assert.equal(average.decimalValue, "50.125");

  const latest = reduceDomoRows({
    header: HEADER,
    rows: [ROWS[1], ROWS[0], ROWS[3], ROWS[2]],
    contract: { datasetId: DATASET, valueColumn: "Amount", reduction: "latest", dateColumn: "Date", filterColumn: "Center", filterValue: "Dallas" },
    period: PERIOD,
  });
  assert.equal(latest.decimalValue, "0.15");
});

test("Domo date-only rows use the binding location timezone and ambiguous timestamps fail closed", () => {
  const period = { start: new Date("2026-08-01T05:00:00.000Z"), end: new Date("2026-08-02T05:00:00.000Z") };
  const contract = { datasetId: DATASET, valueColumn: "Amount", reduction: "sum", dateColumn: "Date", filterColumn: "Center", filterValue: "Dallas" };
  const reduced = reduceDomoRows({
    header: HEADER,
    rows: [
      ["Dallas", "10", "2026-07-31"],
      ["Dallas", "20", "2026-08-01"],
      ["Dallas", "30", "2026-08-02"],
      ["Dallas", "5", "2026-08-01T00:30:00-05:00"],
    ],
    contract,
    period,
    timeZone: "America/Chicago",
  });
  assert.equal(reduced.decimalValue, "25");
  assert.equal(reduced.rowCount, 2);
  assert.throws(() => reduceDomoRows({
    header: HEADER,
    rows: [["Dallas", "20", "2026-08-01T12:00:00"]],
    contract,
    period,
    timeZone: "America/Chicago",
  }), (error) => error.code === "domo_period_value_invalid");
});

test("Domo month/year periods isolate mapped brands and enforce approved row cardinality", () => {
  const header = ["Master Location", "Month", "Year", "Budget"];
  const rows = [
    ["Lex", "Aug", "2026", "2486921.00"],
    ["Lyons", "August", "2026", "875000.00"],
    ["Lex", "Jul", "2026", "2100000.00"],
    ["Lex", "Aug", "2025", "1900000.00"],
  ];
  const period = { start: new Date("2026-08-01T05:00:00.000Z"), end: new Date("2026-08-29T01:00:00.000Z") };
  const source = (filterValue) => ({
    datasetId: DATASET,
    valueColumn: "Budget",
    reduction: "sum",
    periodMode: "month_year",
    dateColumn: null,
    monthColumn: "Month",
    yearColumn: "Year",
    filterColumn: "Master Location",
    filterValue,
    expectedPeriodRows: 1,
  });
  const lex = reduceDomoRows({ header, rows, contract: source("Lex"), period, timeZone: "America/Chicago" });
  const lyons = reduceDomoRows({ header, rows, contract: source("Lyons"), period, timeZone: "America/Chicago" });
  assert.deepEqual(lex, { decimalValue: "2486921", decimalNumerator: null, decimalDenominator: null, rowCount: 1 });
  assert.equal(lyons.decimalValue, "875000");
  assert.throws(() => reduceDomoRows({
    header,
    rows: [...rows, ["Lex", "08", "2026", "1"]],
    contract: source("Lex"), period, timeZone: "America/Chicago",
  }), (error) => error.code === "domo_period_row_count_mismatch");
});

test("Domo month/year periods fail closed on malformed contracts and calendar values", () => {
  const valid = {
    datasetId: DATASET, valueColumn: "Budget", reduction: "sum", periodMode: "month_year",
    dateColumn: null, monthColumn: "Month", yearColumn: "Year",
    filterColumn: "Master Location", filterValue: "Lex", expectedPeriodRows: 1,
  };
  assert.throws(() => validateDomoDatasetContract({ ...valid, filterColumn: null, filterValue: null }), (error) => error.code === "domo_filter_invalid");
  assert.throws(() => validateDomoDatasetContract({ ...valid, dateColumn: "Date" }), (error) => error.code === "domo_period_contract_invalid");
  assert.throws(() => validateDomoDatasetContract({ ...valid, monthColumn: null }), (error) => error.code === "domo_month_column_invalid");
  assert.throws(() => validateDomoDatasetContract({ ...valid, expectedPeriodRows: 0 }), (error) => error.code === "domo_expected_rows_invalid");
  const args = {
    header: ["Master Location", "Month", "Year", "Budget"],
    contract: valid,
    period: { start: new Date("2026-08-01T05:00:00.000Z"), end: new Date("2026-08-29T01:00:00.000Z") },
    timeZone: "America/Chicago",
  };
  assert.throws(() => reduceDomoRows({ ...args, rows: [["Lex", "Smarch", "2026", "1"]] }), (error) => error.code === "domo_period_value_invalid");
  assert.throws(() => reduceDomoRows({ ...args, rows: [["Lex", "Aug", "20X6", "1"]] }), (error) => error.code === "domo_period_value_invalid");
  assert.throws(() => reduceDomoRows({ ...args, rows: [["Lex", "Aug", "2026", "1"]], timeZone: undefined }), (error) => error.code === "domo_timezone_invalid");
  assert.throws(() => reduceDomoRows({
    ...args,
    rows: [["Lex", "Aug", "2026", "1"]],
    period: { start: new Date("2026-08-02T05:00:00.000Z"), end: new Date("2026-08-29T01:00:00.000Z") },
  }), (error) => error.code === "domo_period_alignment_invalid");
  assert.throws(() => reduceDomoRows({ ...args, header: ["Master Location", "Year", "Budget"], rows: [["Lex", "2026", "1"]] }), (error) => error.code === "domo_month_column_missing");
});

test("latest reduction requires chronological identity and rejects conflicting ties", () => {
  assert.throws(() => validateDomoDatasetContract({ datasetId: DATASET, valueColumn: "Amount", reduction: "latest", dateColumn: null, filterColumn: null, filterValue: null }), (error) => error.code === "domo_date_column_invalid");
  assert.throws(() => reduceDomoRows({
    header: HEADER,
    rows: [["Dallas", "10", "2026-08-20"], ["Dallas", "11", "2026-08-20"]],
    contract: { datasetId: DATASET, valueColumn: "Amount", reduction: "latest", dateColumn: "Date", filterColumn: null, filterValue: null },
    period: PERIOD,
  }), (error) => error.code === "domo_latest_ambiguous");
});

test("Domo reduction fails closed on missing columns, empty windows, and bad numerics", () => {
  assert.throws(() => reduceDomoRows({
    header: HEADER,
    rows: ROWS,
    contract: { datasetId: DATASET, valueColumn: "Missing", reduction: "sum", dateColumn: "Date", filterColumn: null, filterValue: null },
    period: PERIOD,
  }), (error) => error.code === "domo_value_column_missing");
  assert.throws(() => reduceDomoRows({
    header: HEADER,
    rows: ROWS,
    contract: { datasetId: DATASET, valueColumn: "Amount", reduction: "sum", dateColumn: "Date", filterColumn: "Center", filterValue: "Rockwall" },
    period: PERIOD,
  }), (error) => error.code === "domo_export_empty");
  assert.throws(() => reduceDomoRows({
    header: HEADER,
    rows: [["Dallas", "not-a-number", "2026-08-05"]],
    contract: { datasetId: DATASET, valueColumn: "Amount", reduction: "sum", dateColumn: "Date", filterColumn: null, filterValue: null },
    period: PERIOD,
  }), (error) => error.code === "domo_value_invalid");
});

test("end-to-end Domo execution authenticates, exports, and reduces via stubbed fetch", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const asString = String(url);
    if (asString.includes("/oauth/token")) {
      assert.equal(init.method, "GET");
      assert.match(init.headers.authorization, /^Basic /);
      return new Response(JSON.stringify({ access_token: "t".repeat(40) }), { status: 200 });
    }
    if (asString.includes(`/v1/datasets/${DATASET}/data`)) {
      assert.equal(init.headers.authorization, `Bearer ${"t".repeat(40)}`);
      return new Response("Center,Amount,Date\nDallas,10.25,2026-08-05\nDallas,4.75,2026-08-09\n", { status: 200 });
    }
    throw new Error(`Unexpected URL: ${asString}`);
  };
  const result = await executeDomoDatasetSource({
    credentials: { clientId: "domo-client-1", clientSecret: "domo-secret-1" },
    contract: { datasetId: DATASET, valueColumn: "Amount", reduction: "sum", dateColumn: "Date", filterColumn: null, filterValue: null },
    period: PERIOD,
    options: { fetchImpl },
  });
  assert.equal(result.decimalValue, "15");
  assert.equal(result.rowCount, 2);
  assert.equal(calls.length, 2);
});
