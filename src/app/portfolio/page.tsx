import Link from "next/link";
import { redirect } from "next/navigation";
import { openPortfolioBrandAction } from "@/app/portfolio/actions";
import { ProductionNavigation } from "@/components/production-navigation";
import { SignOutButton } from "@/components/sign-out-button";
import { getAppConfig } from "@/lib/env";
import { getTenantAuthContext, isAdminRole } from "@/lib/auth";
import { getPortfolioOverview, type PortfolioBrandSummary } from "@/lib/portfolio-context";

export const dynamic = "force-dynamic";

const STAGE_LABELS: Record<PortfolioBrandSummary["stage"], string> = {
  onboarding: "Add location",
  connection: "Connect ServiceTitan",
  validation: "Validate connection",
  "kpi-setup": "Configure KPIs",
  observation: "Start observations",
  operational: "Operational",
};

const STAGE_NOTES: Record<PortfolioBrandSummary["stage"], string> = {
  onboarding: "No active operating locations are configured.",
  connection: "A location exists, but connection coverage is incomplete.",
  validation: "ServiceTitan metadata exists and still requires trusted worker validation.",
  "kpi-setup": "The connection is ready; governed KPI sources still need configuration.",
  observation: "Approved KPI bindings exist and are waiting for complete materialized observations.",
  operational: "Every approved KPI binding has at least one matching governed observation.",
};

export default async function PortfolioPage() {
  const [result, tenantAuth] = await Promise.all([getPortfolioOverview(), getTenantAuthContext()]);
  if (result.ok === false && result.reason === "unauthenticated") redirect("/login?next=%2Fportfolio");
  if (result.ok === false) {
    return (
      <main className="production-shell">
        <div className="production-blocked">
          <span>Portfolio access unavailable</span>
          <h1>Champions Group could not be loaded</h1>
          <p>{result.reason === "unauthorized" ? "This account does not have an active portfolio membership." : "Portfolio authorization and brand coverage could not be verified. No partial data is shown."}</p>
          <div className="production-blocked-actions"><Link className="button secondary" href="/">Return to brand dashboard</Link><SignOutButton /></div>
        </div>
      </main>
    );
  }

  const { portfolio } = result;
  const mode = getAppConfig().mode;
  const availableTenants = tenantAuth.ok ? tenantAuth.availableTenants : tenantAuth.availableTenants ?? [];
  const hasDashboardAccess = availableTenants.length > 0;
  const canAdminister = tenantAuth.ok && isAdminRole(tenantAuth.membership.role);
  return (
    <main className="production-shell">
      <ProductionNavigation
        contextLabel={portfolio.name}
        mode={mode}
        hasDashboardAccess={hasDashboardAccess}
        hasPortfolioAccess
        canAdminister={canAdminister}
      />
      <div className="production-page portfolio-page">
        <div className="production-title-row">
          <div><span>Portfolio executive control plane</span><h1>{portfolio.name}</h1><p>Consolidated onboarding, connection, and KPI coverage across verified portfolio brands. Your role is <strong>{portfolio.role}</strong>.</p></div>
        </div>

        <section className="portfolio-summary-grid" aria-label="Portfolio readiness summary">
          <div><span>Active brands</span><strong>{portfolio.totals.brands}</strong></div>
          <div><span>Active locations</span><strong>{portfolio.totals.activeLocations}</strong></div>
          <div><span>Ready connections</span><strong>{portfolio.totals.readyConnections}<small> / {portfolio.totals.enabledConnections}</small></strong></div>
          <div><span>Location coverage</span><strong>{portfolio.totals.assignedLocations}<small> / {portfolio.totals.activeLocations}</small></strong></div>
          <div><span>Published KPIs</span><strong>{portfolio.totals.publishedKpis}</strong></div>
          <div><span>Observed bindings</span><strong>{portfolio.totals.observedBindings}<small> / {portfolio.totals.approvedBindings}</small></strong></div>
        </section>

        <section className="portfolio-boundary-note">
          <strong>Governed rollup boundary</strong>
          <p>This portfolio view combines additive readiness and coverage counts only. KPI values, targets, percentages, and currency are not combined until each metric has an approved cross-brand aggregation contract.</p>
        </section>

        <section className="production-section">
          <div className="production-section-title"><div><span>Verified portfolio membership</span><h2>Brands</h2></div><strong>{portfolio.brands.length}</strong></div>
          <div className="portfolio-brand-grid">
            {portfolio.brands.map((brand) => (
              <article className="portfolio-brand-card" key={brand.id}>
                <div className="portfolio-brand-heading"><div><span>{brand.slug}</span><h3>{brand.name}</h3></div><span className={`portfolio-stage ${brand.stage}`}>{STAGE_LABELS[brand.stage]}</span></div>
                <p>{STAGE_NOTES[brand.stage]}</p>
                <dl className="portfolio-brand-facts">
                  <div><dt>Locations</dt><dd>{brand.activeLocationCount}</dd></div>
                  <div><dt>Connections ready</dt><dd>{brand.readyConnectionCount} / {brand.enabledConnectionCount}</dd></div>
                  <div><dt>Assigned locations</dt><dd>{brand.assignedLocationCount} / {brand.activeLocationCount}</dd></div>
                  <div><dt>Published KPIs</dt><dd>{brand.publishedKpiCount}</dd></div>
                  <div><dt>Approved bindings</dt><dd>{brand.approvedBindingCount}</dd></div>
                  <div><dt>Observed bindings</dt><dd>{brand.observedBindingCount}</dd></div>
                </dl>
                <form action={openPortfolioBrandAction}>
                  <input type="hidden" name="organizationId" value={brand.id} />
                  <button className="button primary" type="submit">Open brand dashboard</button>
                </form>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
