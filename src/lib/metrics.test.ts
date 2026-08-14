import { describe, expect, it } from "vitest";
import { metricAttainment, metricStatus, reorder } from "./metrics";
import type { Metric } from "./types";

const base: Metric = {
  id: "test", section: "executive", title: "Test", actual: 90, goal: 100,
  kind: "number", source: "Custom", subtitle: "", sparkline: [1, 2, 3],
};

describe("metricStatus", () => {
  it("marks a metric good at target", () => expect(metricStatus({ ...base, actual: 100 })).toBe("good"));
  it("marks a metric as watch inside the warning band", () => expect(metricStatus(base)).toBe("watch"));
  it("marks a metric critical below the warning band", () => expect(metricStatus({ ...base, actual: 89 })).toBe("critical"));
  it("handles lower-is-better targets", () => {
    const lower = { ...base, actual: 10, goal: 12, direction: "lower" as const };
    expect(metricStatus(lower)).toBe("good");
    expect(metricAttainment(lower)).toBe(120);
  });
  it("keeps missing targets informational", () => expect(metricStatus({ ...base, goal: undefined })).toBe("neutral"));
});

describe("reorder", () => {
  it("moves one card without mutating input", () => {
    const initial = ["a", "b", "c"];
    expect(reorder(initial, 0, 2)).toEqual(["b", "c", "a"]);
    expect(initial).toEqual(["a", "b", "c"]);
  });
});
