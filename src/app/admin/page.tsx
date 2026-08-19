import { redirect } from "next/navigation";
import Link from "next/link";
import { AdminConsole } from "@/components/admin-console";
import { ProductionAdminConsole } from "@/components/production-admin-console";
import { SignOutButton } from "@/components/sign-out-button";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { isAdminRole } from "@/lib/auth";
import { parseProductionAdminSection } from "@/lib/admin-navigation";
import { getAppConfig } from "@/lib/env";
import { getProductionTenantContext } from "@/lib/tenant-context";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string | string[] }>;
}) {
  const config = getAppConfig();
  if (config.isDemo) return <AdminConsole />;

  const initialSection = parseProductionAdminSection((await searchParams).section);

  const result = await getProductionTenantContext({ includeAdminConfiguration: true });
  if (!result.ok) {
    if (result.reason === "unauthenticated") redirect("/login?next=/admin");
    if (result.reason === "tenant-selection-required" && result.availableTenants) {
      return (
        <main className="production-state-page">
          <section className="production-state-card">
            <span className="production-state-mark">CG</span>
            <p className="production-kicker">Platform administration</p>
            <h1>Select a tenant</h1>
            <p>Choose the organization you want to configure.</p>
            <TenantSwitcher tenants={result.availableTenants} nextPath="/admin" />
            <SignOutButton />
          </section>
        </main>
      );
    }
    return (
      <main className="production-state-page">
        <section className="production-state-card" role="alert">
          <span className="production-state-mark">CG</span>
          <p className="production-kicker">Administration blocked</p>
          <h1>Tenant access could not be verified</h1>
          <p>{result.message}</p>
          <div className="production-hero-actions"><Link className="button secondary" href="/">Return home</Link><SignOutButton /></div>
        </section>
      </main>
    );
  }

  if (!isAdminRole(result.tenant.role)) redirect("/");
  return <ProductionAdminConsole tenant={result.tenant} mode={config.mode} initialSection={initialSection} />;
}
