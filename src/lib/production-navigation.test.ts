import { describe, expect, it } from "vitest";
import { getProductionBrandHref, getProductionNavigationItems, isProductionRouteActive } from "./production-navigation";

describe("production navigation", () => {
  it("keeps the dashboard exact and activates nested application routes safely", () => {
    expect(isProductionRouteActive("/", "/")).toBe(true);
    expect(isProductionRouteActive("/admin", "/")).toBe(false);
    expect(isProductionRouteActive("/admin/sources", "/admin")).toBe(true);
    expect(isProductionRouteActive("/administrator", "/admin")).toBe(false);
    expect(isProductionRouteActive("/portfolio/brands", "/portfolio")).toBe(true);
  });

  it("routes the brand mark only to an authorized landing page", () => {
    expect(getProductionBrandHref({ hasDashboardAccess: true, hasPortfolioAccess: true })).toBe("/");
    expect(getProductionBrandHref({ hasDashboardAccess: false, hasPortfolioAccess: true })).toBe("/portfolio");
    expect(getProductionBrandHref({ hasDashboardAccess: false, hasPortfolioAccess: false })).toBeNull();
  });

  it("shows only destinations authorized by the server-provided context", () => {
    expect(getProductionNavigationItems({ hasDashboardAccess: true, hasPortfolioAccess: false, canAdminister: false })).toEqual([
      { href: "/", label: "Dashboard" },
    ]);
    expect(getProductionNavigationItems({ hasDashboardAccess: true, hasPortfolioAccess: true, canAdminister: true })).toEqual([
      { href: "/", label: "Dashboard" },
      { href: "/portfolio", label: "Portfolio" },
      { href: "/admin", label: "Admin Center" },
    ]);
    expect(getProductionNavigationItems({ hasDashboardAccess: false, hasPortfolioAccess: true, canAdminister: false })).toEqual([
      { href: "/portfolio", label: "Portfolio" },
    ]);
  });
});
