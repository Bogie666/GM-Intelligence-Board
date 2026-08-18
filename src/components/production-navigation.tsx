"use client";

import { LayoutDashboard, Menu, Settings, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChampionsGroupLogo } from "@/components/champions-group-logo";
import { SignOutButton } from "@/components/sign-out-button";
import { TenantSwitcher } from "@/components/tenant-switcher";
import type { TenantAccessOption } from "@/lib/auth";
import { getProductionBrandHref, getProductionNavigationItems, isProductionRouteActive } from "@/lib/production-navigation";

const ICONS = {
  "/": LayoutDashboard,
  "/portfolio": ShieldCheck,
  "/admin": Settings,
} as const;

export function ProductionNavigation({
  contextLabel,
  mode,
  hasDashboardAccess,
  hasPortfolioAccess,
  canAdminister,
  tenants,
  selectedOrganizationId,
  nextPath = "/",
}: {
  contextLabel: string;
  mode: "demo" | "staging" | "production";
  hasDashboardAccess: boolean;
  hasPortfolioAccess: boolean;
  canAdminister: boolean;
  tenants?: TenantAccessOption[];
  selectedOrganizationId?: string;
  nextPath?: "/" | "/admin";
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuId = "production-navigation-menu";
  const items = getProductionNavigationItems({ hasDashboardAccess, hasPortfolioAccess, canAdminister });
  const brandHref = getProductionBrandHref({ hasDashboardAccess, hasPortfolioAccess });
  const brandContent = <><ChampionsGroupLogo priority /><div><strong>GM Intelligence Board</strong><small>{contextLabel}</small></div></>;

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      menuButton.current?.focus();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <header className="production-navigation">
      <div className="production-navigation-bar">
        {brandHref ? (
          <Link href={brandHref} className="production-brand" onClick={() => setOpen(false)}>{brandContent}</Link>
        ) : (
          <div className="production-brand">{brandContent}</div>
        )}
        <button
          ref={menuButton}
          className="production-nav-menu-button"
          type="button"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={open ? "Close navigation menu" : "Open navigation menu"}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <X aria-hidden="true" size={22} /> : <Menu aria-hidden="true" size={22} />}
        </button>
        <div className={`production-navigation-menu ${open ? "is-open" : ""}`} id={menuId}>
          <nav className="production-primary-nav" aria-label="Primary navigation">
            {items.map((item) => {
              const Icon = ICONS[item.href];
              const active = isProductionRouteActive(pathname, item.href);
              return (
                <Link
                  className="production-nav-link"
                  href={item.href}
                  key={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setOpen(false)}
                >
                  <Icon aria-hidden="true" size={16} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="production-navigation-utilities">
            {tenants ? <TenantSwitcher tenants={tenants} selectedOrganizationId={selectedOrganizationId} nextPath={nextPath} /> : null}
            <span className="production-mode">{mode}</span>
            <SignOutButton />
          </div>
        </div>
      </div>
    </header>
  );
}
