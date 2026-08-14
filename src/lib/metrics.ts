import type { Metric, Status } from "./types";

export function formatMetric(value: number, kind: Metric["kind"]): string {
  if (kind === "currency") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: value >= 1_000_000 ? 1 : value >= 1000 ? 0 : 2,
      notation: value >= 1_000_000 ? "compact" : "standard",
    }).format(value);
  }
  if (kind === "percent") return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
  if (kind === "ratio") return value.toFixed(2);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function metricAttainment(metric: Metric): number | null {
  if (metric.goal === undefined || metric.goal === 0) return null;
  if (metric.direction === "lower") return (metric.goal / Math.max(metric.actual, 0.0001)) * 100;
  return (metric.actual / metric.goal) * 100;
}

export function metricStatus(metric: Metric): Status {
  if (metric.goal === undefined) return "neutral";
  const attainment = metricAttainment(metric) ?? 100;
  if (attainment >= 100) return "good";
  if (attainment >= (metric.warningAt ?? 90)) return "watch";
  return "critical";
}

export function changeFromPrior(metric: Metric): number | null {
  if (metric.prior === undefined || metric.prior === 0) return null;
  return ((metric.actual - metric.prior) / Math.abs(metric.prior)) * 100;
}

export function reorder<T>(items: T[], from: number, to: number): T[] {
  const copy = [...items];
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  return copy;
}
