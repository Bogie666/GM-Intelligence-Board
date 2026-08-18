import { redirect } from "next/navigation";
import Link from "next/link";
import { AdminConsole } from "@/components/admin-console";
import { ProductionAdminConsole } from "@/components/production-admin-console";
import { SignOutButton } from "@/components/sign-out-button";
import { isAdminRole } from "@/lib/auth";
import { getAppConfig } from "@/lib/env";
import { getProductionTenantContext } from "@/lib/tenant-context";

export default async function AdminPage() {
  const config = getAppConfig();
  if (config.isDemo) return <AdminConsole />;

  const result = await getProductionTenantContext();
  if (!result.ok) {
    if (result.reason === "unauthenticated") redirect("/login?next=/admin");
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
  return <ProductionAdminConsole tenant={result.tenant} mode={config.mode} />;
}
