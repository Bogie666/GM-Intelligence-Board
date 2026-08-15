import { describe, expect, it } from "vitest";
import type { Metric } from "./types";
import {
  TARGET_BUDGET_STORAGE_KEY,
  applyPublishedTargets,
  createSeedTargetBudgetStore,
  readTargetBudgetStore,
  resetTargetBudgetStore,
  resolveTargetRule,
  supersedeTargetRulesForPublication,
  validateBudgetRecord,
  validateTargetRule,
  writeTargetBudgetStore,
  type BudgetRecord,
  type TargetBudgetStore,
  type TargetRule,
} from "./targets";

const now = "2026-08-15T12:00:00.000Z";

const metric = (id: string, goal = 1): Metric => ({
  id,
  section: id.includes("revenue") ? "revenue" : "executive",
  title: id,
  actual: 50,
  goal,
  kind: id.includes("revenue") ? "currency" : "percent",
  source: "ServiceTitan",
  subtitle: "",
  warningAt: 95,
  criticalAt: 80,
  sparkline: [40, 50],
});

function target(overrides: Partial<TargetRule> = {}): TargetRule {
  return {
    id: "target-test",
    metricId: "booking-rate",
    locationId: "*",
    trade: "all",
    serviceLine: "all",
    targetValue: 75,
    warningAttainment: 90,
    criticalAttainment: 80,
    effectiveFrom: "2026-01-01",
    version: 1,
    status: "published",
    owner: "Operations",
    note: "Test target",
    updatedAt: now,
    ...overrides,
  };
}

function budget(overrides: Partial<BudgetRecord> = {}): BudgetRecord {
  return {
    id: "budget-test",
    metricId: "revenue-mtd",
    locationId: "sierra-abq",
    trade: "all",
    fiscalMonth: "2026-08",
    amount: 4_000_000,
    version: 1,
    versionName: "Operating plan v1",
    status: "published",
    owner: "Finance",
    updatedAt: now,
    ...overrides,
  };
}

function memoryStorage(values: Record<string, string> = {}, throws = false) {
  const data = new Map(Object.entries(values));
  return {
    getItem(key: string) {
      if (throws) throw new Error("storage unavailable");
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (throws) throw new Error("storage full");
      data.set(key, value);
    },
    removeItem(key: string) { data.delete(key); },
    value(key: string) { return data.get(key); },
  };
}

describe("target and budget seeds", () => {
  it("seeds distinct published location targets and August revenue budgets", () => {
    const store = createSeedTargetBudgetStore();
    expect(store.schemaVersion).toBe(1);
    expect(store.rules).toHaveLength(15);
    expect(store.budgets).toHaveLength(12);
    expect(new Set(store.rules.map((rule) => `${rule.locationId}:${rule.metricId}`)).size).toBe(15);
    expect(new Set(store.rules.filter((rule) => rule.metricId === "booking-rate").map((rule) => rule.targetValue)).size).toBe(3);
    expect(store.rules.every((rule) => rule.status === "published")).toBe(true);
    expect(store.budgets.every((record) => record.status === "published" && record.fiscalMonth === "2026-08")).toBe(true);
  });
});

describe("target resolution", () => {
  it("isolates exact-location targets and falls back to portfolio", () => {
    const rules = [
      target({ id: "portfolio", targetValue: 70 }),
      target({ id: "sierra", locationId: "sierra-abq", targetValue: 72 }),
      target({ id: "asi", locationId: "asi-san-diego", targetValue: 76 }),
    ];
    expect(resolveTargetRule("booking-rate", "sierra-abq", "2026-08-15", rules)?.id).toBe("sierra");
    expect(resolveTargetRule("booking-rate", "asi-san-diego", "2026-08-15", rules)?.id).toBe("asi");
    expect(resolveTargetRule("booking-rate", "swan-denver", "2026-08-15", rules)?.id).toBe("portfolio");
  });

  it("ignores draft, archived, future, and expired rules", () => {
    const rules = [
      target({ id: "draft", status: "draft", targetValue: 99 }),
      target({ id: "archived", status: "archived", targetValue: 98 }),
      target({ id: "future", effectiveFrom: "2026-09-01", targetValue: 97 }),
      target({ id: "expired", effectiveFrom: "2025-01-01", effectiveTo: "2026-07-31", targetValue: 96 }),
      target({ id: "active", targetValue: 75 }),
    ];
    expect(resolveTargetRule("booking-rate", "sierra-abq", "2026-08-15", rules)?.id).toBe("active");
  });

  it("uses location, scope specificity, version, then updatedAt precedence", () => {
    const rules = [
      target({ id: "portfolio-specific", trade: "hvac", serviceLine: "service", version: 20 }),
      target({ id: "location-general", locationId: "sierra-abq", version: 1 }),
      target({ id: "location-trade", locationId: "sierra-abq", trade: "hvac", version: 1 }),
      target({ id: "location-scope-v1", locationId: "sierra-abq", trade: "hvac", serviceLine: "service", version: 1 }),
      target({ id: "location-scope-v2-old", locationId: "sierra-abq", trade: "hvac", serviceLine: "service", version: 2, updatedAt: "2026-08-10T00:00:00.000Z" }),
      target({ id: "location-scope-v2-new", locationId: "sierra-abq", trade: "hvac", serviceLine: "service", version: 2, updatedAt: "2026-08-12T00:00:00.000Z" }),
    ];
    const result = resolveTargetRule("booking-rate", "sierra-abq", "2026-08-15", rules, { trade: "hvac", serviceLine: "service" });
    expect(result?.id).toBe("location-scope-v2-new");
  });

  it("preserves closed history across repeated effective-dated successors", () => {
    const v1 = target({ id: "v1", locationId: "sierra-abq", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", version: 1 });
    const v2 = target({ id: "v2", locationId: "sierra-abq", effectiveFrom: "2026-04-01", effectiveTo: "2026-12-31", version: 2 });
    const afterV2 = [...supersedeTargetRulesForPublication([v1], v2), v2];
    expect(afterV2.find((rule) => rule.id === "v1")?.effectiveTo).toBe("2026-03-31");

    const v3 = target({ id: "v3", locationId: "sierra-abq", effectiveFrom: "2026-07-01", version: 3 });
    const afterV3 = supersedeTargetRulesForPublication(afterV2, v3);
    expect(afterV3.find((rule) => rule.id === "v1")?.effectiveTo).toBe("2026-03-31");
    expect(afterV3.find((rule) => rule.id === "v2")?.effectiveTo).toBe("2026-06-30");
    expect(validateTargetRule(v3, afterV3).map((issue) => issue.code)).not.toContain("duplicate-active-scope");
  });
});

describe("applying targets", () => {
  it("applies an exact budget before a target rule for the same metric", () => {
    const input = [metric("revenue-mtd", 10)];
    const rules = [target({ id: "revenue-rule", metricId: "revenue-mtd", locationId: "sierra-abq", targetValue: 3_000_000 })];
    const budgets = [budget({ amount: 4_250_000 })];
    const output = applyPublishedTargets(input, "sierra-abq", "2026-08-15", rules, budgets, "2026-08");

    expect(output[0].goal).toBe(4_250_000);
    expect(output[0].targetContext).toMatchObject({ source: "budget", budgetId: "budget-test", fiscalMonth: "2026-08", owner: "Finance" });
    expect(output[0]).not.toBe(input[0]);
    expect(input[0].goal).toBe(10);
  });

  it("applies target thresholds and audit lineage while copying every metric", () => {
    const input = [metric("booking-rate"), metric("unmanaged")];
    const output = applyPublishedTargets(input, "sierra-abq", "2026-08-15", [target({ targetValue: 78, warningAttainment: 92, criticalAttainment: 81 })], [], "2026-08");

    expect(output[0]).toMatchObject({ goal: 78, warningAt: 92, criticalAt: 81 });
    expect(output[0].targetContext).toMatchObject({ source: "target-rule", ruleId: "target-test", version: 1, owner: "Operations" });
    expect(output[1]).toEqual(input[1]);
    expect(output[1]).not.toBe(input[1]);
  });

  it("does not leak one location's budget to another location or month", () => {
    const input = [metric("revenue-mtd", 123)];
    expect(applyPublishedTargets(input, "asi-san-diego", "2026-08-15", [], [budget()], "2026-08")[0].goal).toBe(123);
    expect(applyPublishedTargets(input, "sierra-abq", "2026-09-15", [], [budget()], "2026-09")[0].goal).toBe(123);
  });
});

describe("domain validation", () => {
  it("validates target ranges, thresholds, dates, and overlapping active scopes", () => {
    const existing = target({ id: "existing", effectiveFrom: "2026-01-01", effectiveTo: "2026-08-31" });
    const invalid = target({
      id: "candidate",
      targetValue: 101,
      warningAttainment: 70,
      criticalAttainment: 80,
      effectiveFrom: "2026-02-30",
      effectiveTo: "2025-12-31",
    });
    const codes = validateTargetRule(invalid, [existing]).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(["target-range", "attainment-order", "effective-from"]));

    const duplicate = target({ id: "candidate", effectiveFrom: "2026-08-01" });
    expect(validateTargetRule(duplicate, [existing]).map((issue) => issue.code)).toContain("duplicate-active-scope");
    expect(validateTargetRule(duplicate, [{ ...existing, status: "archived" }]).map((issue) => issue.code)).not.toContain("duplicate-active-scope");
  });

  it("validates budget metric, period, amount, trade, and duplicates", () => {
    const invalid = budget({
      id: "invalid",
      metricId: "hvac-revenue",
      trade: "plumbing",
      fiscalMonth: "2026-13",
      amount: Number.NaN,
    });
    expect(validateBudgetRecord(invalid).map((issue) => issue.code)).toEqual(expect.arrayContaining(["budget-trade", "budget-period", "budget-amount"]));

    const existing = budget({ id: "existing" });
    expect(validateBudgetRecord(budget({ id: "duplicate" }), [existing]).map((issue) => issue.code)).toContain("duplicate-budget");
    expect(validateBudgetRecord(budget({ id: "new-version", version: 2, versionName: "Operating plan v2" }), [existing]).map((issue) => issue.code)).not.toContain("duplicate-budget");
  });
});

describe("browser-local store", () => {
  it("recovers from malformed, obsolete, and unavailable storage", () => {
    const malformed = memoryStorage({ [TARGET_BUDGET_STORAGE_KEY]: "{not json" });
    expect(readTargetBudgetStore(malformed).rules).toHaveLength(15);

    const obsolete = memoryStorage({ [TARGET_BUDGET_STORAGE_KEY]: JSON.stringify({ schemaVersion: 0, rules: [], budgets: [] }) });
    expect(readTargetBudgetStore(obsolete).budgets).toHaveLength(12);

    expect(readTargetBudgetStore(memoryStorage({}, true)).rules).toHaveLength(15);
  });

  it("safely writes a valid store, rejects an invalid store, and resets to fresh seeds", () => {
    const storage = memoryStorage();
    const store = createSeedTargetBudgetStore();
    expect(writeTargetBudgetStore(storage, store)).toBe(true);
    expect(JSON.parse(storage.value(TARGET_BUDGET_STORAGE_KEY) ?? "null")).toEqual(store);

    const invalid = { ...store, rules: [{ ...store.rules[0], targetValue: Number.NaN }] } as TargetBudgetStore;
    expect(writeTargetBudgetStore(storage, invalid)).toBe(false);
    expect(writeTargetBudgetStore(memoryStorage({}, true), store)).toBe(false);

    store.rules[0].targetValue = 999;
    const reset = resetTargetBudgetStore(storage);
    expect(reset.rules[0].targetValue).not.toBe(999);
    expect(readTargetBudgetStore(storage)).toEqual(reset);
  });
});
