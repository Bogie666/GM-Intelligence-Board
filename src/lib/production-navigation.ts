export interface ProductionNavigationItem {
  href: "/" | "/portfolio" | "/admin";
  label: "Dashboard" | "Portfolio" | "Admin Center";
}

export function isProductionRouteActive(pathname: string, href: ProductionNavigationItem["href"]): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function getProductionBrandHref({
  hasDashboardAccess,
  hasPortfolioAccess,
}: {
  hasDashboardAccess: boolean;
  hasPortfolioAccess: boolean;
}): "/" | "/portfolio" | null {
  if (hasDashboardAccess) return "/";
  if (hasPortfolioAccess) return "/portfolio";
  return null;
}

export function getProductionNavigationItems({
  hasDashboardAccess,
  hasPortfolioAccess,
  canAdminister,
}: {
  hasDashboardAccess: boolean;
  hasPortfolioAccess: boolean;
  canAdminister: boolean;
}): ProductionNavigationItem[] {
  const items: ProductionNavigationItem[] = [];
  if (hasDashboardAccess) items.push({ href: "/", label: "Dashboard" });
  if (hasPortfolioAccess) items.push({ href: "/portfolio", label: "Portfolio" });
  if (canAdminister) items.push({ href: "/admin", label: "Admin Center" });
  return items;
}
