"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import {
  archiveLocationAction,
  createConnectionAction,
  createLocationAction,
  disableConnectionAction,
  rotateConnectionCredentialsAction,
  updateLocationAction,
  updateOrganizationAction,
  type AdminActionState,
} from "@/app/admin/actions";
import type {
  ProductionTenantContext,
  ServiceTitanAssignment,
  ServiceTitanConnection,
  TenantLocation,
} from "@/lib/tenant-context";
import { ChampionsGroupLogo } from "@/components/champions-group-logo";
import { SignOutButton } from "@/components/sign-out-button";
import { TenantSwitcher } from "@/components/tenant-switcher";

const INITIAL_ADMIN_ACTION_STATE: AdminActionState = { status: "idle", message: "" };

const UNITED_STATES_TIMEZONES = [
  { value: "America/New_York", label: "Eastern Time" },
  { value: "America/Chicago", label: "Central Time" },
  { value: "America/Denver", label: "Mountain Time" },
  { value: "America/Phoenix", label: "Mountain Time (Arizona, no DST)" },
  { value: "America/Los_Angeles", label: "Pacific Time" },
  { value: "America/Anchorage", label: "Alaska Time" },
  { value: "Pacific/Honolulu", label: "Hawaii Time" },
] as const;

function TimezoneSelect({ defaultValue = "America/Chicago" }: { defaultValue?: string }) {
  return (
    <select name="timezone" required defaultValue={defaultValue}>
      {UNITED_STATES_TIMEZONES.map((timezone) => (
        <option key={timezone.value} value={timezone.value}>{timezone.label} — {timezone.value}</option>
      ))}
    </select>
  );
}

function SubmitButton({ children, danger = false }: { children: React.ReactNode; danger?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className={`button ${danger ? "production-danger" : "primary"}`} type="submit" disabled={pending}>
      {pending ? "Saving…" : children}
    </button>
  );
}

function ActionNotice({ state }: { state: AdminActionState }) {
  if (state.status === "idle") return null;
  return (
    <div className={`production-notice ${state.status}`} role={state.status === "error" ? "alert" : "status"}>
      {state.message}
      {state.fieldErrors ? (
        <ul>
          {Object.entries(state.fieldErrors).map(([field, message]) => (
            <li key={field}>{message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function OrganizationEditor({ tenant }: { tenant: ProductionTenantContext }) {
  const [state, action] = useActionState(updateOrganizationAction, INITIAL_ADMIN_ACTION_STATE);
  return (
    <section className="production-panel">
      <div className="production-panel-heading">
        <div>
          <span>Portfolio brand identity</span>
          <h2>Brand</h2>
        </div>
        <span className={`production-status ${tenant.organization.status}`}>{tenant.organization.status}</span>
      </div>
      <form action={action} className="production-form-grid">
        <label>
          Brand name
          <input name="name" required maxLength={160} defaultValue={tenant.organization.name} />
        </label>
        <label>
          Brand slug
          <input name="slug" required minLength={3} maxLength={64} pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" defaultValue={tenant.organization.slug} />
        </label>
        <div className="production-form-footer">
          <span>Changes are written through your authenticated brand session and RLS.</span>
          <SubmitButton>Save brand</SubmitButton>
        </div>
      </form>
      <ActionNotice state={state} />
    </section>
  );
}

function CreateLocationForm() {
  const [state, action] = useActionState(createLocationAction, INITIAL_ADMIN_ACTION_STATE);
  return (
    <section className="production-panel">
      <div className="production-panel-heading">
        <div><span>Persisted configuration</span><h2>Add location</h2></div>
      </div>
      <form action={action} className="production-form-grid">
        <label>Location key<input name="locationKey" required minLength={3} maxLength={64} placeholder="denver-west" /></label>
        <label>Brand name<input name="brandName" required maxLength={120} placeholder="Mountain Air" /></label>
        <label>Display name<input name="displayName" required maxLength={160} placeholder="Denver West" /></label>
        <label>United States timezone<TimezoneSelect /></label>
        <div className="production-form-footer">
          <span>Keys are tenant-unique and cannot contain spaces.</span>
          <SubmitButton>Add location</SubmitButton>
        </div>
      </form>
      <ActionNotice state={state} />
    </section>
  );
}

function LocationEditor({ location }: { location: TenantLocation }) {
  const [updateState, updateAction] = useActionState(updateLocationAction, INITIAL_ADMIN_ACTION_STATE);
  const [archiveState, archiveAction] = useActionState(archiveLocationAction, INITIAL_ADMIN_ACTION_STATE);

  if (location.status === "archived") {
    return (
      <article className="production-record is-archived">
        <div><strong>{location.display_name}</strong><span>{location.brand_name} · {location.location_key}</span></div>
        <span className="production-status archived">archived</span>
      </article>
    );
  }

  return (
    <article className="production-record production-location-editor">
      <div className="production-record-heading">
        <div><strong>{location.display_name}</strong><span>{location.timezone}</span></div>
        <span className={`production-status ${location.status}`}>{location.status}</span>
      </div>
      <form action={updateAction} className="production-form-grid compact">
        <input type="hidden" name="locationId" value={location.id} />
        <label>Location key<input name="locationKey" required defaultValue={location.location_key} /></label>
        <label>Brand name<input name="brandName" required defaultValue={location.brand_name} /></label>
        <label>Display name<input name="displayName" required defaultValue={location.display_name} /></label>
        <label>United States timezone<TimezoneSelect defaultValue={location.timezone} /></label>
        <div className="production-form-footer"><span>Tenant row: <code>{location.id}</code></span><SubmitButton>Save location</SubmitButton></div>
      </form>
      <ActionNotice state={updateState} />
      <form action={archiveAction} className="production-destructive-row">
        <input type="hidden" name="locationId" value={location.id} />
        <span>Archiving preserves history and prevents further edits here.</span>
        <SubmitButton danger>Archive location</SubmitButton>
      </form>
      <ActionNotice state={archiveState} />
    </article>
  );
}

function CreateConnectionForm({ locations }: { locations: TenantLocation[] }) {
  const [state, action] = useActionState(createConnectionAction, INITIAL_ADMIN_ACTION_STATE);
  const activeLocations = locations.filter((location) => location.status === "active");
  return (
    <section className="production-panel">
      <div className="production-panel-heading">
        <div><span>Encrypted credential onboarding</span><h2>Add ServiceTitan connection</h2></div>
      </div>
      <p className="production-boundary-note">
        Credentials are encrypted in the managed Supabase Vault when you submit. They are never displayed again or stored in connection and audit records.
      </p>
      <form action={action} className="production-form-grid" autoComplete="off">
        <label>ServiceTitan tenant ID<input name="tenantId" required maxLength={128} autoComplete="off" /></label>
        <label>Display name<input name="displayName" required maxLength={160} placeholder="LEX DFW Production" /></label>
        <label>Environment<select name="environment" defaultValue="production"><option value="production">Production</option><option value="integration">Integration</option></select></label>
        <label>Initial location<select name="locationId" defaultValue=""><option value="">No initial assignment</option>{activeLocations.map((location) => <option key={location.id} value={location.id}>{location.display_name}</option>)}</select></label>
        <label>Client ID<input name="clientId" required maxLength={4096} autoComplete="off" spellCheck={false} /></label>
        <label>Client secret<input name="clientSecret" type="password" required maxLength={4096} autoComplete="new-password" spellCheck={false} /></label>
        <label className="span-two">ST App Key<input name="appKey" type="password" required maxLength={4096} autoComplete="new-password" spellCheck={false} /><small>Use the actual ST App Key from ServiceTitan, not the App ID.</small></label>
        <div className="production-form-footer">
          <span>The connection starts in needs attention until the trusted worker validates OAuth and a read-only tenant request.</span>
          <SubmitButton>Encrypt and add connection</SubmitButton>
        </div>
      </form>
      <ActionNotice state={state} />
    </section>
  );
}

function activeAssignmentNames(
  connection: ServiceTitanConnection,
  assignments: ServiceTitanAssignment[],
  locations: TenantLocation[],
): string[] {
  const names = new Map(locations.map((location) => [location.id, location.display_name]));
  return assignments
    .filter((assignment) => assignment.connection_id === connection.id && assignment.revoked_at === null)
    .map((assignment) => names.get(assignment.location_id) ?? "Unknown tenant location");
}

function ConnectionCredentialRotationForm({ connectionId }: { connectionId: string }) {
  const [state, action] = useActionState(rotateConnectionCredentialsAction, INITIAL_ADMIN_ACTION_STATE);
  return (
    <details>
      <summary>Replace encrypted credentials</summary>
      <form action={action} className="production-form-grid compact" autoComplete="off">
        <input type="hidden" name="connectionId" value={connectionId} />
        <label>Client ID<input name="clientId" required maxLength={4096} autoComplete="off" spellCheck={false} /></label>
        <label>Client secret<input name="clientSecret" type="password" required maxLength={4096} autoComplete="new-password" spellCheck={false} /></label>
        <label>Actual ST App Key<input name="appKey" type="password" required maxLength={4096} autoComplete="new-password" spellCheck={false} /></label>
        <div className="production-form-footer">
          <span>The previous Vault value is replaced atomically. Revalidate before ingestion.</span>
          <SubmitButton>Encrypt replacement</SubmitButton>
        </div>
      </form>
      <ActionNotice state={state} />
    </details>
  );
}

function ConnectionRecord({ connection, assignments, locations }: { connection: ServiceTitanConnection; assignments: ServiceTitanAssignment[]; locations: TenantLocation[] }) {
  const [state, action] = useActionState(disableConnectionAction, INITIAL_ADMIN_ACTION_STATE);
  const assignmentNames = activeAssignmentNames(connection, assignments, locations);
  const canDisable = connection.status !== "disabled" && connection.status !== "archived";
  return (
    <article className={`production-record ${connection.status === "disabled" || connection.status === "archived" ? "is-archived" : ""}`}>
      <div className="production-record-heading">
        <div><strong>{connection.display_name}</strong><span>Tenant {connection.service_titan_tenant_id} · {connection.environment}</span></div>
        <span className={`production-status ${connection.status}`}>{connection.status.replace("_", " ")}</span>
      </div>
      <dl className="production-facts">
        <div><dt>Credentials</dt><dd>Encrypted in managed vault</dd></div>
        <div><dt>Active assignments</dt><dd>{assignmentNames.length ? assignmentNames.join(", ") : "None"}</dd></div>
        <div><dt>Last validated</dt><dd>{connection.last_validated_at ? new Date(connection.last_validated_at).toLocaleString() : "Not validated"}</dd></div>
      </dl>
      {canDisable ? (
        <>
          <ConnectionCredentialRotationForm connectionId={connection.id} />
          <form action={action} className="production-destructive-row">
            <input type="hidden" name="connectionId" value={connection.id} />
            <span>Disabling revokes active assignments and permanently destroys Vault credentials.</span>
            <SubmitButton danger>Disable connection</SubmitButton>
          </form>
        </>
      ) : null}
      <ActionNotice state={state} />
    </article>
  );
}

export function ProductionAdminConsole({ tenant, mode }: { tenant: ProductionTenantContext; mode: "staging" | "production" }) {
  return (
    <main className="production-shell">
      <header className="production-topbar">
        <Link href="/" className="production-brand"><ChampionsGroupLogo priority /><div><strong>GM Intelligence Board</strong><small>{tenant.organization.name}</small></div></Link>
        <div>{tenant.hasPortfolioAccess ? <Link href="/portfolio" className="button secondary">Champions portfolio</Link> : null}<TenantSwitcher tenants={tenant.availableTenants} selectedOrganizationId={tenant.organization.id} nextPath="/admin" /><span className="production-mode">{mode}</span><SignOutButton /></div>
      </header>
      <div className="production-page">
        <div className="production-title-row">
          <div><span>Authenticated brand control plane</span><h1>Production administration</h1><p>Manage persisted brand and location configuration for <strong>{tenant.organization.name}</strong>. Your role is <strong>{tenant.role}</strong>.</p></div>
          <Link href="/" className="button secondary">Back to brand dashboard</Link>
        </div>

        <section className="production-readiness-grid" aria-label="Brand readiness">
          <div><span>Active locations</span><strong>{tenant.readiness.activeLocationCount}</strong></div>
          <div><span>Enabled connections</span><strong>{tenant.readiness.enabledConnectionCount}</strong></div>
          <div><span>Assigned locations</span><strong>{tenant.readiness.assignedActiveLocationCount}</strong></div>
          <div><span>Worker validation</span><strong className="readiness-word">{tenant.readiness.hasValidatedConnection ? "Validated" : "Pending"}</strong></div>
        </section>

        <OrganizationEditor tenant={tenant} />
        <div className="production-two-column"><CreateLocationForm /><CreateConnectionForm locations={tenant.locations} /></div>

        <section className="production-section">
          <div className="production-section-title"><div><span>Database records</span><h2>Locations</h2></div><strong>{tenant.locations.length}</strong></div>
          <div className="production-record-list">
            {tenant.locations.length ? tenant.locations.map((location) => <LocationEditor key={location.id} location={location} />) : <div className="production-empty">No locations have been persisted for this tenant.</div>}
          </div>
        </section>

        <section className="production-section">
          <div className="production-section-title"><div><span>Database records</span><h2>ServiceTitan connections</h2></div><strong>{tenant.connections.length}</strong></div>
          <div className="production-record-list">
            {tenant.connections.length ? tenant.connections.map((connection) => <ConnectionRecord key={connection.id} connection={connection} assignments={tenant.assignments} locations={tenant.locations} />) : <div className="production-empty">No ServiceTitan connection metadata has been persisted for this tenant.</div>}
          </div>
        </section>
      </div>
    </main>
  );
}
