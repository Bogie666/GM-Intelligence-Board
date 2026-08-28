"use client";

import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  BriefcaseBusiness,
  CalendarDays,
  ChevronDown,
  CircleDollarSign,
  Download,
  LayoutDashboard,
  Menu,
  PhoneCall,
  RefreshCw,
  Settings,
  ShieldCheck,
  Star,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ExecutiveSourceInsightActions } from "./executive-source-insight-actions";
import { SignOutButton } from "@/components/sign-out-button";
import { TenantSwitcher } from "@/components/tenant-switcher";
import type { TenantAccessOption } from "@/lib/auth";
import {
  createExecutiveScorecardCsv,
  createProductionDashboardCsv,
  executiveSecondarySourceLineage,
  formatProductionPeriod,
  formatProductionValue,
  getProductionFreshness,
  getProductionComparisonValue,
  getProductionPriorTrend,
  getProductionSparklinePoints,
  getSupportedProductionPeriods,
  PRODUCTION_DASHBOARD_SECTIONS,
  PRODUCTION_HEALTH_COPY,
  productionDashboardExportFilename,
  shapeExecutiveScorecard,
  shapeProductionDashboardKpis,
  type ExecutiveScorecardCard,
  type ProductionDashboardKpi,
} from "@/lib/production-dashboard";
import type { ProductionKpiBudget, ProductionKpiStatus, TenantLocation } from "@/lib/tenant-context";

const sectionIcons = {
  executive: LayoutDashboard,
  revenue: CircleDollarSign,
  calls: PhoneCall,
  appointments: CalendarDays,
  sales: BriefcaseBusiness,
  membership: Star,
} as const;

const healthClass: Record<ProductionKpiStatus["health"], "good" | "watch" | "critical"> = {
  current: "good",
  stale: "watch",
  unavailable: "critical",
};

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "GM";
}

function safePresentationColor(presentation: Record<string, unknown>, key: string, fallback: string): string {
  const value = presentation[key];
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function Sparkline({ kpi }: { kpi: ProductionKpiStatus }) {
  const points = getProductionSparklinePoints(kpi);
  if (points === null) return <AlertTriangle className="production-kpi-alert" aria-hidden="true" size={28} />;
  return (
    <svg className={`sparkline sparkline-${healthClass[kpi.health]}`} viewBox="0 0 120 34" aria-label="Current versus prior trend" role="img">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExecutiveScorecardCard({ card, onOpen }: { card: ExecutiveScorecardCard; onOpen: (source: ProductionKpiStatus) => void }) {
  const dataClass = card.dataStatus === "Current" ? "good" : card.dataStatus === "Stale" ? "watch" : "critical";
  const performanceClass = card.performanceStatus === "On Plan" ? "good" : card.performanceStatus === "Watch" ? "watch" : card.performanceStatus === "Off Plan" ? "critical" : "neutral";
  const comparisonDelta = card.value !== null && card.comparisonValue !== null && Number.isFinite(card.value) && Number.isFinite(card.comparisonValue)
    ? card.comparisonValue === 0 ? null : ((card.value - card.comparisonValue) / Math.abs(card.comparisonValue)) * 100
    : null;
  const signedMembershipNet = card.membershipMovement
    ? `${card.membershipMovement.netCount > 0 ? "+" : ""}${formatProductionValue(card.membershipMovement.netCount, "number")}`
    : null;
  const isBudgetComparison = card.comparisonLabel?.toLowerCase().includes("budget") === true;
  const comparisonHeading = isBudgetComparison ? "Budget" : "Prior year";
  const varianceHeading = isBudgetComparison ? "Variance to budget" : "Change vs PY";
  const secondarySourceInsights = card.secondarySourceInsights ?? [];

  return (
    <article className={`metric-card executive-scorecard-card status-${dataClass}`}>
      <div className="metric-card-topline" />
      <div className="metric-head">
        <div><div className="metric-label">{card.title}</div><div className="source-label"><span className="source-dot" />{secondarySourceInsights.length > 0 ? `${secondarySourceInsights.length + 1} governed sources` : card.source.sourceSystem}</div></div>
        <div className="executive-statuses"><span className={`status-pill ${performanceClass}`}>Performance: {card.performanceStatus}</span><span className={`status-pill ${dataClass}`}>Data: {card.dataStatus}</span></div>
      </div>
      <div className="metric-main"><div className="metric-value">{formatProductionValue(card.value, card.valueKind, card.percentValueScale)}</div></div>
      {card.comparisonValue !== null && card.comparisonLabel ? (
        <div className="executive-py-comparison" aria-label={`${card.title} ${isBudgetComparison ? "budget" : "prior-year"} comparison`}>
          <div><span>{comparisonHeading}</span><strong>{formatProductionValue(card.comparisonValue, card.valueKind, card.percentValueScale)}</strong></div>
          <div><span>{varianceHeading}</span><strong className={comparisonDelta !== null && comparisonDelta < 0 ? "negative" : "positive"}>{comparisonDelta === null ? "N/A" : `${comparisonDelta > 0 ? "+" : ""}${comparisonDelta.toFixed(1)}%`}</strong></div>
          <small>{card.comparisonLabel}</small>
        </div>
      ) : null}
      {card.membershipMovement ? (
        <div className="executive-membership-movement" aria-label={`${card.title} selected-period movement`}>
          <div><span>New</span><strong className="positive">{formatProductionValue(card.membershipMovement.newCount, "number")}</strong></div>
          <div><span>Lost</span><strong className="negative">{formatProductionValue(card.membershipMovement.lostCount, "number")}</strong></div>
          <div><span>Net gain/loss</span><strong className={card.membershipMovement.netCount < 0 ? "negative" : card.membershipMovement.netCount > 0 ? "positive" : undefined}>{signedMembershipNet}</strong></div>
          <small>{card.membershipMovement.periodLabel}</small>
        </div>
      ) : null}
      <div className="metric-subtitle">{card.subtitle}</div>
      <div className="executive-facts">{card.facts.map((fact) => <div key={fact.label}><span>{fact.label}</span><strong>{fact.value}</strong></div>)}</div>
      <div className="production-period-label">{card.periodLabel}{card.asOf ? " · local as-of" : ""}</div>
      <p className="executive-data-message">{card.performanceStatus === "Not assessed" && (card.id === "revenue-mtd" || card.id === "run-rate-forecast") && !card.budgetLineage ? "No published budget; performance not assessed. " : ""}{card.dataMessage}</p>
      <ExecutiveSourceInsightActions
        primarySource={card.source}
        primaryLabel={secondarySourceInsights.length > 0 ? "completed revenue" : null}
        secondarySourceInsights={secondarySourceInsights}
        onOpen={onOpen}
      />
    </article>
  );
}

function KpiCard({ kpi, onOpen }: { kpi: ProductionDashboardKpi; onOpen: () => void }) {
  const trend = getProductionPriorTrend(kpi);
  const TrendIcon = trend?.direction === "down" ? ArrowDownRight : ArrowUpRight;
  const status = healthClass[kpi.health];
  return (
    <article
      className={`metric-card status-${status} production-live-kpi`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Open ${kpi.title} insight`}
    >
      <div className="metric-card-topline" />
      <div className="metric-head">
        <div>
          <div className="metric-label">{kpi.title}</div>
          <div className="source-label"><span className="source-dot" />{kpi.sourceSystem}</div>
        </div>
        <span className={`status-pill ${status}`}>{PRODUCTION_HEALTH_COPY[kpi.health]}</span>
      </div>
      <div className="metric-main">
        <div className="metric-value">{formatProductionValue(kpi.value, kpi.valueKind, kpi.percentValueScale)}</div>
        <Sparkline kpi={kpi} />
      </div>
      <div className="metric-subtitle">{kpi.subtitle}</div>
      <div className="metric-footer production-metric-footer">
        <div className="production-period-label">{formatProductionPeriod(kpi.periodEnd)}</div>
        {trend ? <div className={`change ${trend.direction === "down" ? "down" : "up"}`}><TrendIcon size={14} />{trend.changeLabel}</div> : <span className="no-target">No prior observation</span>}
      </div>
      <div className="card-open-hint">View insight <span>→</span></div>
    </article>
  );
}

function InsightDrawer({ kpi, onClose }: { kpi: ProductionKpiStatus | null; onClose: () => void }) {
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!kpi) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = Array.from(document.querySelectorAll<HTMLElement>(
      ".production-dashboard-shell > .side-nav, .production-dashboard-shell > .main-content",
    ));
    const priorOverflow = document.body.style.overflow;
    for (const element of background) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "hidden";

    const drawer = drawerRef.current;
    const focusable = () => Array.from(drawer?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ) ?? []);
    focusable()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        drawer?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = priorOverflow;
      for (const element of background) {
        element.inert = false;
        element.removeAttribute("aria-hidden");
      }
      previouslyFocused?.focus();
    };
  }, [kpi, onClose]);

  if (!kpi) return null;
  const priorValue = getProductionComparisonValue(kpi);
  const hasGovernedPy = kpi.comparisonBasis === "prior_year_to_date" && priorValue !== null;
  const trend = getProductionPriorTrend(kpi);
  const status = healthClass[kpi.health];
  return (
    <div className="drawer-backdrop" onMouseDown={onClose} role="presentation">
      <aside ref={drawerRef} className="insight-drawer" onMouseDown={(event) => event.stopPropagation()} aria-label={`${kpi.title} insight`} aria-modal="true" role="dialog" tabIndex={-1}>
        <div className="drawer-head">
          <div><span className={`status-pill ${status}`}>{PRODUCTION_HEALTH_COPY[kpi.health]}</span><h2>{kpi.title}</h2><p>{kpi.subtitle}</p></div>
          <button className="icon-btn" onClick={onClose} aria-label="Close insight"><X size={20} /></button>
        </div>
        <div className="drawer-kpis">
          <div><span>Actual</span><strong>{formatProductionValue(kpi.value, kpi.valueKind, kpi.percentValueScale)}</strong></div>
          <div><span>{hasGovernedPy ? "Prior year" : "Prior"}</span><strong>{formatProductionValue(priorValue, kpi.valueKind, kpi.percentValueScale)}</strong></div>
          <div><span>Change</span><strong>{trend?.changeLabel ?? "Unavailable"}</strong></div>
        </div>
        <div className="drawer-chart"><div className="drawer-section-label">{hasGovernedPy ? "Current versus prior year" : "Current versus prior"}</div><Sparkline kpi={kpi} /></div>
        <div className="data-definition service-titan-lineage"><ShieldCheck size={18} /><div><strong>Governed data lineage</strong><p>{kpi.sourceSystem} → approved tenant/location binding → materialized observation</p><dl className="lineage-facts"><div><dt>Location</dt><dd>{kpi.locationName}</dd></div><div><dt>Freshness</dt><dd>{getProductionFreshness(kpi)}</dd></div><div><dt>Source</dt><dd>{kpi.sourceStatus}</dd></div></dl></div></div>
      </aside>
    </div>
  );
}

export function ProductionDashboard({
  organization,
  locations,
  kpis,
  budgets,
  userEmail,
  canAdminister,
  hasPortfolioAccess,
  tenants,
}: {
  organization: { id: string; slug: string; name: string };
  locations: TenantLocation[];
  kpis: ProductionKpiStatus[];
  budgets: ProductionKpiBudget[] | null;
  userEmail: string | null;
  canAdminister: boolean;
  hasPortfolioAccess: boolean;
  tenants: TenantAccessOption[];
}) {
  const activeLocations = useMemo(() => locations.filter((location) => location.status === "active"), [locations]);
  const [locationId, setLocationId] = useState<string | null>(activeLocations[0]?.id ?? null);
  const [section, setSection] = useState<ProductionKpiStatus["section"]>("executive");
  const [period, setPeriod] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [selectedKpi, setSelectedKpi] = useState<ProductionKpiStatus | null>(null);
  const [exportError, setExportError] = useState("");
  const closeInsight = useCallback(() => setSelectedKpi(null), []);
  const location = activeLocations.find((item) => item.id === locationId) ?? activeLocations[0] ?? null;
  const periods = useMemo(() => getSupportedProductionPeriods(kpis, locationId, section), [kpis, locationId, section]);
  const visibleKpis = useMemo(() => shapeProductionDashboardKpis({ kpis, locationId, section, period }), [kpis, locationId, section, period]);
  const executiveCards = useMemo(() => shapeExecutiveScorecard({ kpis, budgets: budgets ?? [], locationId, timeZone: location?.timezone ?? "UTC", period }), [kpis, budgets, locationId, location?.timezone, period]);
  const isExecutive = section === "executive";
  const sectionMeta = PRODUCTION_DASHBOARD_SECTIONS.find((item) => item.id === section) ?? PRODUCTION_DASHBOARD_SECTIONS[0];
  const SectionIcon = sectionIcons[section];
  const currentCount = isExecutive ? executiveCards.filter((card) => card.dataStatus === "Current").length : visibleKpis.filter((kpi) => kpi.health === "current").length;
  const staleCount = isExecutive ? executiveCards.filter((card) => card.dataStatus === "Stale").length : visibleKpis.filter((kpi) => kpi.health === "stale").length;
  const unavailableCount = isExecutive ? executiveCards.filter((card) => card.dataStatus === "Unavailable").length : visibleKpis.filter((kpi) => kpi.health === "unavailable").length;
  const style = {
    "--brand-accent": location ? safePresentationColor(location.presentation, "accent", "#315f83") : "#315f83",
    "--brand-dark": location ? safePresentationColor(location.presentation, "accentDark", "#183a5a") : "#183a5a",
  } as CSSProperties;

  function exportScorecard() {
    try {
      const csv = isExecutive ? createExecutiveScorecardCsv(executiveCards) : createProductionDashboardCsv(visibleKpis);
      const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = productionDashboardExportFilename({ organizationSlug: organization.slug, locationKey: location?.location_key ?? "all", section, period });
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url); setExportError("");
    } catch { setExportError("The scorecard could not be exported. No file was downloaded."); }
  }

  return (
    <div className="app-shell production-dashboard-shell" style={style}>
      <aside className={`side-nav ${mobileNav ? "mobile-open" : ""}`}>
        <div className="portfolio-mark"><div className="cg-mark">CG</div><div><strong>Champions Group</strong><span>GM Intelligence</span></div></div>
        <nav aria-label="Dashboard sections">
          <div className="nav-label">Performance</div>
          {PRODUCTION_DASHBOARD_SECTIONS.map(({ id, shortLabel }) => { const Icon = sectionIcons[id]; return <button key={id} className={section === id ? "active" : ""} onClick={() => { setSection(id); setPeriod(null); setSelectedKpi(null); setMobileNav(false); }}><Icon size={18} /><span>{shortLabel}</span>{section === id && <span className="active-dot" />}</button>; })}
          <div className="nav-label admin-label">Management</div>
          {hasPortfolioAccess && <Link href="/portfolio"><ShieldCheck size={18} /><span>Portfolio</span></Link>}
          {canAdminister && <Link href="/admin"><Settings size={18} /><span>Admin Center</span></Link>}
        </nav>
        <div className="dashboard-side-footer"><div className="nav-footer"><ShieldCheck size={17} /><div><strong>Production</strong><span>Tenant-isolated intelligence</span></div></div><SignOutButton className="dashboard-signout" /></div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileNav((value) => !value)} aria-expanded={mobileNav} aria-label="Toggle dashboard navigation"><Menu size={21} /></button>
          <div className="location-switcher">
            <div className="brand-avatar">{initials(location?.brand_name ?? organization.name)}</div>
            <div className="location-select-wrap"><span>Viewing location</span><select aria-label="Location" value={locationId ?? ""} disabled={activeLocations.length === 0} onChange={(event) => { setLocationId(event.target.value || null); setPeriod(null); setSelectedKpi(null); }}>{activeLocations.length === 0 ? <option value="">No active locations</option> : activeLocations.map((item) => <option value={item.id} key={item.id}>{item.brand_name} · {item.display_name}</option>)}</select></div><ChevronDown size={15} />
          </div>
          <div className="topbar-right">
            <div className="sync-state"><RefreshCw size={14} /><span>{currentCount > 0 ? `${currentCount} current` : "Awaiting current data"}</span></div>
            {tenants.length > 1 && <TenantSwitcher tenants={tenants} selectedOrganizationId={organization.id} nextPath="/" />}
            {canAdminister && <Link className="admin-button" href="/admin"><Settings size={16} />Admin</Link>}
            <div className="user-avatar" title={userEmail ?? "Signed-in user"}>{initials(userEmail?.split("@")[0] ?? "GM")}</div>
          </div>
        </header>

        <section className="workspace">
          {exportError && <div className="test-result error" role="alert">{exportError}</div>}
          <div className="page-head"><div><div className="eyebrow"><SectionIcon size={15} /> {location?.display_name ?? organization.name} operating view</div><h1>{sectionMeta.label}</h1><p>{sectionMeta.description}</p></div><div className="page-actions"><div className="period-control"><CalendarDays size={16} /><select aria-label="Reporting period" value={period ?? ""} onChange={(event) => { setPeriod(event.target.value || null); setSelectedKpi(null); }}><option value="">Latest available</option>{periods.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select><ChevronDown size={14} /></div><button className="button secondary" type="button" disabled={isExecutive ? executiveCards.length === 0 : visibleKpis.length === 0} onClick={exportScorecard}><Download size={16} />Export scorecard</button></div></div>

          <div className={`signal-strip ${unavailableCount > 0 ? "has-unavailable-sources" : ""}`} aria-live="polite"><div className="signal-primary"><Activity size={18} /><div><strong>{unavailableCount > 0 ? `${unavailableCount} KPI${unavailableCount === 1 ? " is" : "s are"} unavailable` : staleCount > 0 ? `${staleCount} KPI${staleCount === 1 ? " needs" : "s need"} freshness review` : currentCount > 0 ? "All visible KPI sources are current" : "No governed observations are available"}</strong><span>{currentCount} current · {staleCount} stale · {unavailableCount} unavailable</span></div></div><div className="signal-legend"><span className="legend good" />Current <span className="legend watch" />Stale <span className="legend critical" />Unavailable</div></div>

          <div className="metric-grid">{isExecutive
            ? executiveCards.map((card) => <ExecutiveScorecardCard key={card.id} card={card} onOpen={setSelectedKpi} />)
            : visibleKpis.map((kpi) => <KpiCard key={`${kpi.kpiKey}:${kpi.bindingId ?? "unbound"}`} kpi={kpi} onOpen={() => setSelectedKpi(kpi)} />)}</div>
          {!isExecutive && visibleKpis.length === 0 && <div className="empty-state"><BarChart3 size={28} /><h3>No KPIs available for this view</h3><p>{canAdminister ? "Complete KPI publication and source binding in Admin Center." : "Ask a tenant administrator to configure this dashboard."}</p>{canAdminister && <Link className="button secondary" href="/admin">Open Admin Center</Link>}</div>}

          <section className="detail-panel"><div className="panel-head"><div><span className="eyebrow">Manager detail</span><h2>{sectionMeta.label} scorecard</h2></div><button className="text-button" type="button" disabled={isExecutive ? executiveCards.length === 0 : visibleKpis.length === 0} onClick={exportScorecard}>Export CSV</button></div><div className="table-scroll">{isExecutive ? <table className="score-table"><thead><tr><th>KPI</th><th>Actual</th><th>Comparison</th><th>Period</th><th>Performance</th><th>Data</th></tr></thead><tbody>{executiveCards.map((card) => <tr key={card.id} onClick={() => setSelectedKpi(card.source)}><td><strong>{card.title}</strong><span>{card.subtitle}</span></td><td>{formatProductionValue(card.value, card.valueKind, card.percentValueScale)}</td><td>{card.comparisonValue === null ? "—" : `${formatProductionValue(card.comparisonValue, card.valueKind, card.percentValueScale)} ${card.comparisonLabel ?? ""}`}</td><td>{card.periodLabel}</td><td><span className={`status-pill ${card.performanceStatus === "On Plan" ? "good" : card.performanceStatus === "Watch" ? "watch" : card.performanceStatus === "Off Plan" ? "critical" : "neutral"}`}>{card.performanceStatus}</span></td><td><span className={`status-pill ${card.dataStatus === "Current" ? "good" : card.dataStatus === "Stale" ? "watch" : "critical"}`}>{card.dataStatus}</span>{card.secondarySourceInsights && card.secondarySourceInsights.length > 0 ? <span>{executiveSecondarySourceLineage(card)}</span> : null}</td></tr>)}</tbody></table> : <table className="score-table"><thead><tr><th>KPI</th><th>Actual</th><th>Prior</th><th>Vs prior</th><th>Period</th><th>Source</th><th>Status</th></tr></thead><tbody>{visibleKpis.map((kpi) => { const trend = getProductionPriorTrend(kpi); const status = healthClass[kpi.health]; return <tr key={`${kpi.kpiKey}:${kpi.bindingId ?? "unbound"}`} onClick={() => setSelectedKpi(kpi)}><td><strong>{kpi.title}</strong><span>{kpi.subtitle}</span></td><td>{formatProductionValue(kpi.value, kpi.valueKind, kpi.percentValueScale)}</td><td>{formatProductionValue(getProductionComparisonValue(kpi), kpi.valueKind, kpi.percentValueScale)}</td><td className={trend?.direction === "down" ? "negative" : "positive"}>{trend?.changeLabel ?? "—"}</td><td>{formatProductionPeriod(kpi.periodEnd)}</td><td><span className="table-source"><span className="source-dot" />{kpi.sourceSystem}</span></td><td><span className={`status-pill ${status}`}>{PRODUCTION_HEALTH_COPY[kpi.health]}</span></td></tr>; })}</tbody></table>}</div></section>
          <footer className="page-footer"><span>GM Intelligence Board · Production</span><span>Tenant-scoped observations. Data confidence and freshness are shown by source.</span></footer>
        </section>
      </main>
      <InsightDrawer kpi={selectedKpi} onClose={closeInsight} />
    </div>
  );
}
