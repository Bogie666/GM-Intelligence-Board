export const OPERATING_REGIONS = ["west", "midwest", "northwest", "southwest"] as const;

export type OperatingRegion = (typeof OPERATING_REGIONS)[number];
