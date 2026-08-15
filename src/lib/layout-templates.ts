import { getMetrics, locations } from "./demo-data";
import type { LayoutTemplate, MetricSection } from "./types";

export const ROLE_TEMPLATE_STORAGE_KEY = "gmib.role-templates.v1";

export const metricSections: MetricSection[] = [
  "executive",
  "revenue",
  "calls",
  "appointments",
  "sales",
  "membership",
];

const metricIdsBySection = metricSections.reduce((result, section) => {
  result[section] = getMetrics(locations[0])
    .filter((metric) => metric.section === section)
    .map((metric) => metric.id);
  return result;
}, {} as Record<MetricSection, string[]>);

function cloneSections(): Record<MetricSection, string[]> {
  return metricSections.reduce((result, section) => {
    result[section] = [...metricIdsBySection[section]];
    return result;
  }, {} as Record<MetricSection, string[]>);
}

export const defaultRoleTemplates: LayoutTemplate[] = [
  {
    id: "gm-daily",
    name: "GM daily view",
    role: "General manager",
    description: "Location-level operating KPIs with approved personal reordering.",
    sections: cloneSections(),
  },
  {
    id: "department-leader",
    name: "Department leader",
    role: "Department leader",
    description: "Trade-specific conversion, productivity, capacity, and follow-up KPIs.",
    sections: cloneSections(),
  },
  {
    id: "executive-portfolio",
    name: "Executive portfolio",
    role: "Brand executive",
    description: "Cross-brand financial, forecast, growth, and variance KPIs.",
    sections: cloneSections(),
  },
];

export function normalizeRoleTemplates(value: unknown, customMetricIds: string[] = []): LayoutTemplate[] {
  if (!Array.isArray(value)) return defaultRoleTemplates.map(cloneTemplate);
  return defaultRoleTemplates.map((fallback) => {
    const saved = value.find((item) => item && typeof item === "object" && "id" in item && item.id === fallback.id) as Partial<LayoutTemplate> | undefined;
    const sections = metricSections.reduce((result, section) => {
      const savedIds = saved?.sections?.[section];
      const validIds = [...metricIdsBySection[section], ...customMetricIds];
      result[section] = Array.isArray(savedIds)
        ? savedIds.filter((id): id is string => typeof id === "string" && validIds.includes(id))
        : [...fallback.sections[section]];
      return result;
    }, {} as Record<MetricSection, string[]>);
    return {
      ...fallback,
      name: typeof saved?.name === "string" && saved.name.trim() ? saved.name : fallback.name,
      description: typeof saved?.description === "string" ? saved.description : fallback.description,
      updatedAt: typeof saved?.updatedAt === "string" ? saved.updatedAt : undefined,
      sections,
    };
  });
}

export function cloneTemplate(template: LayoutTemplate): LayoutTemplate {
  return {
    ...template,
    sections: metricSections.reduce((result, section) => {
      result[section] = [...template.sections[section]];
      return result;
    }, {} as Record<MetricSection, string[]>),
  };
}

export function moveTemplateMetric(ids: string[], metricId: string, direction: -1 | 1): string[] {
  const from = ids.indexOf(metricId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
