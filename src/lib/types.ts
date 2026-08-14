export type Status = "good" | "watch" | "critical" | "neutral";
export type MetricKind = "currency" | "number" | "percent" | "ratio";
export type MetricSection = "executive" | "revenue" | "calls" | "appointments" | "sales" | "membership";
export type SourceKey = "ServiceTitan" | "Budget" | "GA4" | "Call System" | "Derived" | "Custom";

export interface PlaybookStep {
  title: string;
  detail: string;
}

export interface Metric {
  id: string;
  section: MetricSection;
  title: string;
  actual: number;
  goal?: number;
  prior?: number;
  kind: MetricKind;
  source: SourceKey;
  subtitle: string;
  direction?: "higher" | "lower";
  warningAt?: number;
  criticalAt?: number;
  sparkline: number[];
  playbook?: PlaybookStep[];
}

export interface LocationConfig {
  id: string;
  tenantId: string;
  brand: string;
  location: string;
  timezone: string;
  accent: string;
  accentDark: string;
  initials: string;
  syncLabel: string;
  serviceTitanStatus: "demo" | "connected" | "needs-attention";
  metricScale: number;
}

export interface LayoutTemplate {
  id: "gm-daily" | "department-leader" | "executive-portfolio";
  name: string;
  role: string;
  description: string;
  sections: Record<MetricSection, string[]>;
  updatedAt?: string;
}

export interface CustomMetricInput {
  id: string;
  title: string;
  section: MetricSection;
  source: SourceKey;
  actual: number;
  goal?: number;
  kind: MetricKind;
  subtitle: string;
}
