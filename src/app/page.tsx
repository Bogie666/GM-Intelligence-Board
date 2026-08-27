import { redirect } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { ProductionDashboard } from "@/components/production-dashboard";
import { SignOutButton } from "@/components/sign-out-button";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { isAdminRole } from "@/lib/auth";
import { getAppConfig } from "@/lib/env";
import { getProductionTenantContext } from "@/lib/tenant-context";

export const dynamic = "force-dynamic";

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
          <h1>Brand intelligence is unavailable</h1>
          <p>{result.message}</p>
          <SignOutButton />
        </section>
      </main>
    );
  }

  const { tenant } = result;
  return (
    <ProductionDashboard
      organization={tenant.organization}
      locations={tenant.locations}
      kpis={tenant.kpis}
      budgets={tenant.budgets}
      userEmail={tenant.user.email}
      canAdminister={isAdminRole(tenant.role)}
      hasPortfolioAccess={tenant.hasPortfolioAccess}
      tenants={tenant.availableTenants}
    />
  );
}
