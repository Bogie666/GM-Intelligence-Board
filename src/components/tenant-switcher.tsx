"use client";

import { selectTenantAction } from "@/app/tenant/actions";
import type { TenantAccessOption } from "@/lib/auth";

export function TenantSwitcher({
  tenants,
  selectedOrganizationId,
  nextPath,
}: {
  tenants: TenantAccessOption[];
  selectedOrganizationId?: string;
  nextPath: "/" | "/admin";
}) {
  if (tenants.length < 2) return null;
  return (
    <form action={selectTenantAction} className="tenant-switcher">
      <label>
        <span>Brand</span>
        <select name="organizationId" required defaultValue={selectedOrganizationId ?? ""}>
          {!selectedOrganizationId ? <option value="" disabled>Select brand</option> : null}
          {tenants.map((tenant) => (
            <option key={tenant.organizationId} value={tenant.organizationId}>
              {tenant.name}
            </option>
          ))}
        </select>
      </label>
      <input type="hidden" name="next" value={nextPath} />
      <button className="button secondary" type="submit">Switch brand</button>
    </form>
  );
}
