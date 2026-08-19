export interface MappingReadinessBusinessUnit {
  connection_id: string;
  discovery_revision: string;
  provider_business_unit_id: string;
  active: boolean;
}

export interface MappingReadinessDivision {
  id: string;
  status: "active" | "archived";
}

export interface MappingReadinessMapping {
  connection_id: string;
  discovery_revision: string;
  provider_business_unit_id: string;
  location_id: string;
  division_id: string;
  revoked_at: string | null;
}

/**
 * Computes exact mapping coverage for active business units from one discovery
 * revision. This module is client-safe so the Admin Center can render persisted
 * readiness without importing the server-only tenant loader.
 */
export function getBusinessUnitMappingReadiness(input: {
  connectionId: string;
  discoveryRevision: string;
  businessUnits: MappingReadinessBusinessUnit[];
  divisions: MappingReadinessDivision[];
  activeAssignedLocationIds: Iterable<string>;
  mappings: MappingReadinessMapping[];
}): {
  activeBusinessUnitCount: number;
  activeDivisionCount: number;
  mappedBusinessUnitCount: number;
  complete: boolean;
} {
  const activeProviderIds = new Set(
    input.businessUnits
      .filter((unit) =>
        unit.connection_id === input.connectionId &&
        unit.discovery_revision === input.discoveryRevision &&
        unit.active,
      )
      .map((unit) => unit.provider_business_unit_id),
  );
  const activeDivisionIds = new Set(
    input.divisions.filter((division) => division.status === "active").map((division) => division.id),
  );
  const activeAssignedLocationIds = new Set(input.activeAssignedLocationIds);
  const counts = new Map<string, number>();

  for (const mapping of input.mappings) {
    if (
      mapping.connection_id !== input.connectionId ||
      mapping.discovery_revision !== input.discoveryRevision ||
      mapping.revoked_at !== null ||
      !activeProviderIds.has(mapping.provider_business_unit_id) ||
      !activeAssignedLocationIds.has(mapping.location_id) ||
      !activeDivisionIds.has(mapping.division_id)
    ) continue;
    counts.set(mapping.provider_business_unit_id, (counts.get(mapping.provider_business_unit_id) ?? 0) + 1);
  }

  const mappedBusinessUnitCount = [...activeProviderIds].filter((providerId) => counts.has(providerId)).length;
  const complete =
    activeProviderIds.size > 0 &&
    activeDivisionIds.size > 0 &&
    mappedBusinessUnitCount === activeProviderIds.size &&
    [...activeProviderIds].every((providerId) => counts.get(providerId) === 1);

  return {
    activeBusinessUnitCount: activeProviderIds.size,
    activeDivisionCount: activeDivisionIds.size,
    mappedBusinessUnitCount,
    complete,
  };
}
