import { describe, expect, it } from "vitest";
import {
  createCsv,
  HIDDEN_METRICS_STORAGE_KEY,
  METRIC_ORDERS_STORAGE_KEY,
  parseHiddenMetricIds,
  parseMetricOrders,
  readHiddenMetricIds,
  readMetricOrders,
  writeDashboardLayoutState,
} from "./demo-dashboard-state";

function memoryStorage(initial: Record<string, string> = {}, failOnceFor?: string): Storage {
  const values = new Map(Object.entries(initial));
  let pendingFailure = failOnceFor;
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => {
      if (pendingFailure === key) {
        pendingFailure = undefined;
        throw new Error("quota exceeded");
      }
      values.set(key, value);
    },
  };
}

describe("demo dashboard local state", () => {
  it("accepts only string arrays for hidden metric IDs", () => {
    expect(parseHiddenMetricIds('["revenue-mtd","revenue-mtd","pace"]')).toEqual(["revenue-mtd", "pace"]);
    expect(parseHiddenMetricIds('{"0":"revenue-mtd"}')).toEqual([]);
    expect(parseHiddenMetricIds('["revenue-mtd",42]')).toEqual([]);
    expect(parseHiddenMetricIds("not-json")).toEqual([]);
  });

  it("fails the entire order map closed when any entry has a malformed shape", () => {
    expect(parseMetricOrders('{"sierra-abq:executive":["pace","pace","revenue-mtd"]}')).toEqual({
      "sierra-abq:executive": ["pace", "revenue-mtd"],
    });
    expect(parseMetricOrders('{"sierra-abq:executive":["pace"],"bad":"not-an-array"}')).toEqual({});
    expect(parseMetricOrders("[]")).toEqual({});
  });

  it("returns safe defaults when browser storage reads throw", () => {
    const blockedStorage = { getItem: () => { throw new Error("blocked"); } };
    expect(readHiddenMetricIds(blockedStorage)).toEqual([]);
    expect(readMetricOrders(blockedStorage)).toEqual({});
  });

  it("writes the layout together and rolls back when the second write fails", () => {
    const storage = memoryStorage({
      [HIDDEN_METRICS_STORAGE_KEY]: '["old-hidden"]',
      [METRIC_ORDERS_STORAGE_KEY]: '{"old:key":["old-order"]}',
    }, METRIC_ORDERS_STORAGE_KEY);

    expect(writeDashboardLayoutState(storage, ["new-hidden"], { "new:key": ["new-order"] })).toBe(false);
    expect(storage.getItem(HIDDEN_METRICS_STORAGE_KEY)).toBe('["old-hidden"]');
    expect(storage.getItem(METRIC_ORDERS_STORAGE_KEY)).toBe('{"old:key":["old-order"]}');
  });

  it("writes valid hidden and order state", () => {
    const storage = memoryStorage();
    expect(writeDashboardLayoutState(storage, ["hidden"], { "location:executive": ["metric"] })).toBe(true);
    expect(readHiddenMetricIds(storage)).toEqual(["hidden"]);
    expect(readMetricOrders(storage)).toEqual({ "location:executive": ["metric"] });
  });
});

describe("CSV export", () => {
  it("quotes delimiters and line breaks and neutralizes spreadsheet formulas", () => {
    expect(createCsv(["KPI", "Source"], [["Revenue, MTD", "ServiceTitan"], ['A "quoted" KPI', "line\nbreak"], ["=HYPERLINK(\"bad\")", 42]])).toBe(
      '"KPI","Source"\r\n"Revenue, MTD","ServiceTitan"\r\n"A ""quoted"" KPI","line\nbreak"\r\n"\'=HYPERLINK(""bad"")","42"',
    );
  });
});
