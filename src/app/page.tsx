import { redirect } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { ProductionNavigation } from "@/components/production-navigation";
import { SignOutButton } from "@/components/sign-out-button";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { isAdminRole } from "@/lib/auth";
import { getAppConfig } from "@/lib/env";
import { getProductionTenantContext } from "@/lib/tenant-context";

function formatProductionValue(value: number | null, kind: "currency" | "number" | "percent" | "ratio") {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  if (kind === "currency") return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  if (kind === "percent") return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)}%`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

export default async function Home() {
  const config = getAppConfig();
  if (config.isDemo) return <Dashboard />;

  const result = await getProductionTenantContext();
  if (!result.ok) {
    if (result.reason === "unauthenticated") redirect("/login?next=/");
    if (result.reason === "tenant-selection-required" && result.availableTenants) {
      return (
        <main className="production-state-page">
          <section className="production-state-card">
            <span className="production-state-mark">CG</span>
            <p className="production-kicker">Platform access</p>
            <h1>Select a brand</h1>
            <p>Choose the portfolio brand you want to view. Every selection is revalidated against your active database memberships.</p>
            <TenantSwitcher tenants={result.availableTenants} nextPath="/" />
            <SignOutButton />
          </section>
        </main>
      );
    }
    return (
      <main className="production-state-page">
        <section className="production-state-card" role="alert">
          <span className="production-state-mark">CG</span>
          <p className="production-kicker">Authenticated access blocked</p>
          <h1>Brand readiness is unavailable</h1>
          <p>{result.message}</p>
          <SignOutButton />
        </section>
      </main>
    );
  }

  const { tenant } = result;
  const readiness = tenant.readiness;
  return (
    <main className="production-shell">
      <ProductionNavigation
        contextLabel={tenant.organization.name}
        mode={config.mode}
        hasDashboardAccess
        hasPortfolioAccess={tenant.hasPortfolioAccess}
        canAdminister={isAdminRole(tenant.role)}
        tenants={tenant.availableTenants}
        selectedOrganizationId={tenant.organization.id}
      />
      <div className="production-home">
        <section className="production-hero">
          <p className="production-kicker">Authenticated brand readiness</p>
          <h1>{tenant.organization.name}</h1>
          <p>
            This page reports only configuration persisted for brand <code>{tenant.organization.slug}</code>.
            No demo metrics or fabricated KPI values are shown in {config.mode} mode.
          </p>
          <div className="production-hero-actions">
            {isAdminRole(tenant.role) ? <a className="button primary" href="/admin">Open brand administration</a> : null}
            <span>Signed in as {tenant.user.email ?? tenant.user.id} · {tenant.role}</span>
          </div>
        </section>

        <section className="production-readiness-grid" aria-label="Persisted brand readiness">
          <div><span>Active locations</span><strong>{readiness.activeLocationCount}</strong><small>Persisted active location rows</small></div>
          <div><span>Enabled connections</span><strong>{readiness.enabledConnectionCount}</strong><small>Not disabled or archived</small></div>
          <div><span>Assigned locations</span><strong>{readiness.assignedActiveLocationCount}</strong><small>Active assignments to enabled connections</small></div>
          <div><span>Worker validation</span><strong className="readiness-word">{readiness.hasValidatedConnection ? "Validated" : "Pending"}</strong><small>Requires ready status and validation timestamp</small></div>
        </section>

        <section className="production-panel" aria-labelledby="live-kpi-heading">
          <div className="production-panel-heading">
            <div><span>Governed observations</span><h2 id="live-kpi-heading">Live KPI intelligence</h2></div>
            <span className={`production-status ${tenant.kpis.some((kpi) => kpi.health === "current") ? "ready" : "needs_attention"}`}>
              {tenant.kpis.filter((kpi) => kpi.health === "current").length} current
            </span>
          </div>
          {tenant.kpis.length === 0 ? (
            <div className="production-empty">No approved KPI bindings are available. Demo values are never substituted.</div>
          ) : (
            <div className="production-kpi-grid">
              {tenant.kpis.map((kpi) => (
                <article className={`production-kpi-card ${kpi.health}`} key={kpi.bindingId}>
                  <div><span>{kpi.locationName}</span><strong className={`production-status ${kpi.health === "current" ? "ready" : kpi.health}`}>{kpi.health}</strong></div>
                  <h3>{kpi.title}</h3>
                  <p>{formatProductionValue(kpi.value, kpi.valueKind)}</p>
                  <small>
                    {kpi.observedAt && kpi.periodEnd
                      ? `Period ended ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(kpi.periodEnd))} UTC · observed ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(kpi.observedAt))} UTC · ${kpi.confidence} confidence`
                      : "Awaiting the first governed ingestion observation"}
                  </small>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className={`production-readiness-summary ${readiness.isConfigured ? "configured" : "incomplete"}`}>
          <div>
            <p className="production-kicker">Control-plane status</p>
            <h2>{readiness.isConfigured ? "Brand configuration is connected" : "Brand configuration is incomplete"}</h2>
            <p>
              {readiness.isConfigured
                ? "At least one active location has an active assignment to enabled ServiceTitan connection metadata. Data availability still depends on trusted worker validation and ingestion."
                : "Add an active location, enabled ServiceTitan connection metadata, and an active location assignment before the brand is considered configured."}
            </p>
          </div>
          <span className={`production-status ${readiness.isConfigured ? "ready" : "needs_attention"}`}>
            {readiness.isConfigured ? "configured" : "needs attention"}
          </span>
        </section>

        <section className="production-panel">
          <div className="production-panel-heading"><div><span>Persisted records</span><h2>Configuration inventory</h2></div></div>
          <div className="production-inventory-list">
            <div><strong>Brand</strong><span>{tenant.organization.name}</span><small>{tenant.organization.status}</small></div>
            <div><strong>Locations</strong><span>{tenant.locations.length} total record{tenant.locations.length === 1 ? "" : "s"}</span><small>{readiness.activeLocationCount} active</small></div>
            <div><strong>ServiceTitan</strong><span>{tenant.connections.length} metadata record{tenant.connections.length === 1 ? "" : "s"}</span><small>{readiness.enabledConnectionCount} enabled</small></div>
          </div>
        </section>
      </div>
    </main>
  );
}
