export const ADMIN_SECTION_IDS = [
  "overview",
  "organization",
  "connections",
  "kpis",
  "sources",
  "targets",
  "layouts",
] as const;

export type ProductionAdminSection = (typeof ADMIN_SECTION_IDS)[number];

export function isProductionAdminSection(value: unknown): value is ProductionAdminSection {
  return typeof value === "string" && ADMIN_SECTION_IDS.includes(value as ProductionAdminSection);
}

export function parseProductionAdminSection(
  value: string | string[] | undefined,
  fallback: ProductionAdminSection = "overview",
): ProductionAdminSection {
  const candidate = Array.isArray(value) ? value[0] : value;
  return isProductionAdminSection(candidate) ? candidate : fallback;
}

export interface AdminSetupSignals {
  activeLocationCount: number;
  enabledConnectionCount: number;
  hasValidatedConnection: boolean;
  assignedActiveLocationCount: number;
  discoveredBusinessUnitCount: number;
  mappedBusinessUnitCount: number;
}

export interface AdminSetupMilestone {
  id: "locations" | "credentials" | "validation" | "assignments" | "discovery" | "mappings";
  complete: boolean;
}

/**
 * Setup progress is derived only from configuration that was loaded from the
 * tenant database. It intentionally does not infer completion for future UI.
 */
export function getAdminSetupMilestones(signals: AdminSetupSignals): AdminSetupMilestone[] {
  return [
    { id: "locations", complete: signals.activeLocationCount > 0 },
    { id: "credentials", complete: signals.enabledConnectionCount > 0 },
    { id: "validation", complete: signals.hasValidatedConnection },
    { id: "assignments", complete: signals.assignedActiveLocationCount > 0 },
    { id: "discovery", complete: signals.discoveredBusinessUnitCount > 0 },
    { id: "mappings", complete: signals.mappedBusinessUnitCount > 0 },
  ];
}
