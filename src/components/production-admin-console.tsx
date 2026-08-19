"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import {
  archiveLocationAction,
  activateOriginalKpiCatalogAction,
  createConnectionAction,
  createLocationAction,
  disableConnectionAction,
  replaceBusinessUnitMappingsAction,
  replaceConnectionLocationsAction,
  requestBusinessUnitDiscoveryAction,
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
import { ProductionNavigation } from "@/components/production-navigation";

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

type ProductionAdminSection = "overview" | "organization" | "connections" | "kpis" | "sources" | "targets" | "layouts";

const PRODUCTION_ADMIN_SECTIONS: Array<{ id: ProductionAdminSection; label: string; eyebrow: string }> = [
  { id: "overview", label: "Overview", eyebrow: "Start here" },
  { id: "organization", label: "Brand & Locations", eyebrow: "Tenant structure" },
  { id: "connections", label: "ServiceTitan", eyebrow: "Credentials & validation" },
  { id: "kpis", label: "KPI Library", eyebrow: "Definitions & bindings" },
  { id: "sources", label: "Data Sources", eyebrow: "Reports & evidence" },
  { id: "targets", label: "Targets & Budgets", eyebrow: "Performance plans" },
  { id: "layouts", label: "Layouts & Access", eyebrow: "Roles & presentation" },
];

function DeferredAdminSection({ title, description, supported, nextStep }: { title: string; description: string; supported: string[]; nextStep: string }) {
  return (
    <section className="production-section production-deferred-section">
      <div className="production-section-title"><div><span>Production restoration</span><h2>{title}</h2></div><strong aria-label="Not yet available">—</strong></div>
      <p className="production-deferred-description">{description}</p>
      <div className="production-deferred-grid">
        <div><span>Governed backend already available</span><ul>{supported.map((item) => <li key={item}>{item}</li>)}</ul></div>
        <div><span>Next production milestone</span><p>{nextStep}</p><button className="button secondary" type="button" disabled>Editor being restored</button></div>
      </div>
    </section>
  );
}

function TimezoneSelect({ defaultValue = "America/Chicago" }: { defaultValue?: string }) {
  return (
    <select name="timezone" required defaultValue={defaultValue}>
      {UNITED_STATES_TIMEZONES.map((timezone) => (
        <option key={timezone.value} value={timezone.value}>{timezone.label} — {timezone.value}</option>
      ))}
    </select>
  );
}

function SubmitButton({ children, danger = false, disabled = false }: { children: React.ReactNode; danger?: boolean; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className={`button ${danger ? "production-danger" : "primary"}`} type="submit" disabled={pending || disabled}>
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

function ServiceTitanConfiguration({ tenant, connection }: { tenant: ProductionTenantContext; connection: ServiceTitanConnection }) {
  const admin = tenant.adminConfiguration;
  const [discoveryState, discoveryAction] = useActionState(requestBusinessUnitDiscoveryAction, INITIAL_ADMIN_ACTION_STATE);
  const [assignmentState, assignmentAction] = useActionState(replaceConnectionLocationsAction, INITIAL_ADMIN_ACTION_STATE);
  const [mappingState, mappingAction] = useActionState(replaceBusinessUnitMappingsAction, INITIAL_ADMIN_ACTION_STATE);
  if (!admin || connection.status === "disabled" || connection.status === "archived") return null;
  const runs = admin.discoveryRuns.filter((run) => run.connection_id === connection.id);
  const latestRun = runs[0];
  const units = admin.businessUnits.filter((unit) => unit.connection_id === connection.id && unit.active);
  const revision = units[0]?.discovery_revision ?? latestRun?.discovery_revision ?? null;
  const activeAssignments = new Set(tenant.assignments.filter((item) => item.connection_id === connection.id && item.revoked_at === null).map((item) => item.location_id));
  const mappingByProviderId = new Map(admin.businessUnitMappings.filter((item) => item.connection_id === connection.id && item.revoked_at === null).map((item) => [item.provider_business_unit_id, item]));
  const assignedLocations = tenant.locations.filter((location) => location.status === "active" && activeAssignments.has(location.id));
  const canDiscover = connection.status === "ready" && Boolean(connection.last_validated_at);

  return (
    <section className="production-section" aria-label={`${connection.display_name} discovery and mapping`}>
      <div className="production-section-title">
        <div><span>Governed tenant mapping</span><h3>Locations & business units</h3></div>
        <strong>{units.length} units</strong>
      </div>
      <form action={assignmentAction} className="production-form-grid">
        <input type="hidden" name="connectionId" value={connection.id} />
        <input type="hidden" name="confirmReplacement" value="yes" />
        <fieldset>
          <legend>Assigned operating locations</legend>
          {tenant.locations.filter((location) => location.status === "active").map((location) => (
            <label key={location.id} className="production-checkbox-row">
              <input type="checkbox" name="locationId" value={location.id} defaultChecked={activeAssignments.has(location.id)} />
              <span>{location.display_name}</span>
            </label>
          ))}
        </fieldset>
        <div className="production-form-footer"><span>Saving replaces the complete active assignment set and revokes mappings for removed locations.</span><SubmitButton>Save assignments</SubmitButton></div>
      </form>
      <ActionNotice state={assignmentState} />

      <form action={discoveryAction} className="production-destructive-row">
        <input type="hidden" name="connectionId" value={connection.id} />
        <span>{latestRun ? `Latest discovery: ${latestRun.status}${latestRun.completed_at ? ` · ${new Date(latestRun.completed_at).toLocaleString()}` : ""}` : "No business-unit discovery has been requested."}</span>
        <SubmitButton disabled={!canDiscover}>{canDiscover ? "Discover business units" : "Validation required"}</SubmitButton>
      </form>
      <ActionNotice state={discoveryState} />

      {revision && units.length > 0 ? (
        <form action={mappingAction} className="production-form-grid">
          <input type="hidden" name="connectionId" value={connection.id} />
          <input type="hidden" name="discoveryRevision" value={revision} />
          <input type="hidden" name="confirmMappings" value="yes" />
          <div className="production-record-list">
            {units.map((unit) => {
              const mapping = mappingByProviderId.get(unit.provider_business_unit_id);
              return (
                <div key={unit.provider_business_unit_id}>
                  <input type="hidden" name="providerBusinessUnitId" value={unit.provider_business_unit_id} />
                  <strong>{unit.name}</strong>
                  <label>Location<select name="mappedLocationId" defaultValue={mapping?.location_id ?? ""}><option value="">Not mapped</option>{assignedLocations.map((location) => <option key={location.id} value={location.id}>{location.display_name}</option>)}</select></label>
                  <label>Trade<select name="trade" defaultValue={mapping?.trade ?? ""}><option value="">Not mapped</option><option value="hvac">HVAC</option><option value="plumbing">Plumbing</option><option value="electrical">Electrical</option><option value="other">Other</option></select></label>
                </div>
              );
            })}
          </div>
          <div className="production-form-footer"><span>Unmapped rows remain visible. Saving replaces every current mapping at revision {revision.slice(0, 8)}.</span><SubmitButton>Save mappings</SubmitButton></div>
        </form>
      ) : <div className="production-empty">Run the trusted discovery worker after validation to load the current ServiceTitan business-unit inventory.</div>}
      <ActionNotice state={mappingState} />
    </section>
  );
}

function OriginalKpiCatalogManager({ tenant }: { tenant: ProductionTenantContext }) {
  const admin = tenant.adminConfiguration;
  const [state, action] = useActionState(activateOriginalKpiCatalogAction, INITIAL_ADMIN_ACTION_STATE);
  if (!admin) return <div className="production-empty">The governed KPI catalog could not be loaded.</div>;
  const enabled = new Set(admin.originalKpiDefinitions.filter((definition) => definition.lifecycle === "published").map((definition) => definition.kpi_key));
  const inactive = admin.originalKpiCatalog.filter((item) => !enabled.has(item.kpi_key));
  const sections = ["executive", "revenue", "calls", "appointments", "sales", "membership"] as const;
  return (
    <section className="production-section">
      <div className="production-section-title"><div><span>Migration-owned catalog v1</span><h2>Original 36 KPI library</h2></div><strong>{enabled.size}/36 enabled</strong></div>
      <p>Activation publishes definitions only. Sources, location bindings, targets, and observations remain unavailable until separately configured and reconciled.</p>
      <form action={action} className="production-form-grid">
        <input type="hidden" name="selectionMode" value="selected" />
        <input type="hidden" name="confirmActivation" value="yes" />
        {sections.map((section) => {
          const items = admin.originalKpiCatalog.filter((item) => item.section === section);
          return <fieldset key={section}><legend>{section}</legend>{items.map((item) => <label key={item.kpi_key} className="production-checkbox-row"><input type="checkbox" name="kpiKey" value={item.kpi_key} disabled={enabled.has(item.kpi_key)} /><span><strong>{item.title}</strong><small>{enabled.has(item.kpi_key) ? "Enabled" : `${item.source_system} · ${item.subtitle}`}</small></span></label>)}</fieldset>;
        })}
        <div className="production-form-footer"><span>{inactive.length} catalog definition{inactive.length === 1 ? "" : "s"} remain inactive.</span><SubmitButton>Enable selected KPIs</SubmitButton></div>
      </form>
      <ActionNotice state={state} />
      {inactive.length > 0 ? <form action={action} className="production-destructive-row"><input type="hidden" name="selectionMode" value="all" /><input type="hidden" name="confirmActivation" value="yes" /><span>Publish every missing original definition in one idempotent transaction.</span><SubmitButton>Enable all 36</SubmitButton></form> : null}
    </section>
  );
}

export function ProductionAdminConsole({ tenant, mode }: { tenant: ProductionTenantContext; mode: "staging" | "production" }) {
  const [section, setSection] = useState<ProductionAdminSection>("overview");
  const selectedSection = PRODUCTION_ADMIN_SECTIONS.find((item) => item.id === section) ?? PRODUCTION_ADMIN_SECTIONS[0];
  const readyConnections = tenant.connections.filter((connection) => connection.status === "ready" && Boolean(connection.last_validated_at)).length;
  const completedSetupSteps = Number(tenant.readiness.activeLocationCount > 0) + Number(readyConnections > 0);

  return (
    <main className="production-shell">
      <ProductionNavigation
        contextLabel={tenant.organization.name}
        mode={mode}
        hasDashboardAccess
        hasPortfolioAccess={tenant.hasPortfolioAccess}
        canAdminister
        tenants={tenant.availableTenants}
        selectedOrganizationId={tenant.organization.id}
        nextPath="/admin"
      />
      <div className="production-page production-admin-page">
        <div className="production-title-row">
          <div><span>Authenticated brand control plane</span><h1>Admin Center</h1><p>Configure the governed production workspace for <strong>{tenant.organization.name}</strong>. Your role is <strong>{tenant.role}</strong>.</p></div>
          <Link href="/" className="button secondary">Back to dashboard</Link>
        </div>

        <div className="production-admin-workspace">
          <nav className="production-admin-section-nav" aria-label="Admin Center sections">
            {PRODUCTION_ADMIN_SECTIONS.map((item) => (
              <button
                type="button"
                key={item.id}
                className={section === item.id ? "active" : ""}
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => setSection(item.id)}
              >
                <span>{item.eyebrow}</span>
                <strong>{item.label}</strong>
              </button>
            ))}
          </nav>

          <div className="production-admin-section-content">
            <header className="production-admin-section-heading">
              <span>{selectedSection.eyebrow}</span>
              <h2>{selectedSection.label}</h2>
            </header>

            {section === "overview" ? (
              <>
                <section className="production-readiness-grid" aria-label="Brand readiness">
                  <div><span>Active locations</span><strong>{tenant.readiness.activeLocationCount}</strong></div>
                  <div><span>Enabled connections</span><strong>{tenant.readiness.enabledConnectionCount}</strong></div>
                  <div><span>Assigned locations</span><strong>{tenant.readiness.assignedActiveLocationCount}</strong></div>
                  <div><span>Worker validation</span><strong className="readiness-word">{tenant.readiness.hasValidatedConnection ? "Validated" : "Pending"}</strong></div>
                </section>
                <section className="production-section production-setup-path">
                  <div className="production-section-title"><div><span>Guided setup</span><h2>Production onboarding path</h2></div><strong>{completedSetupSteps}/4</strong></div>
                  <p>Move through these steps in order. Completed infrastructure remains visible, and unfinished product areas are never hidden.</p>
                  <div>
                    <button type="button" onClick={() => setSection("organization")}><span className={tenant.readiness.activeLocationCount > 0 ? "complete" : "needed"}>1</span><div><strong>Brand and locations</strong><small>{tenant.readiness.activeLocationCount > 0 ? `${tenant.readiness.activeLocationCount} active location configured` : "Add the first operating location"}</small></div><b>{tenant.readiness.activeLocationCount > 0 ? "Complete" : "Required"}</b></button>
                    <button type="button" onClick={() => setSection("connections")}><span className={readyConnections > 0 ? "complete" : "needed"}>2</span><div><strong>ServiceTitan connection</strong><small>{readyConnections > 0 ? `${readyConnections} validated connection ready` : "Register and validate credentials"}</small></div><b>{readyConnections > 0 ? "Complete" : "Required"}</b></button>
                    <button type="button" onClick={() => setSection("sources")}><span className="needed">3</span><div><strong>Data source and evidence</strong><small>Register a saved report or approved endpoint recipe</small></div><b>Next</b></button>
                    <button type="button" onClick={() => setSection("kpis")}><span className="needed">4</span><div><strong>KPI, target, and layout</strong><small>Publish the first reconciled metric and place it on the dashboard</small></div><b>Pending</b></button>
                  </div>
                </section>
              </>
            ) : null}

            {section === "organization" ? (
              <>
                <OrganizationEditor tenant={tenant} />
                <section className="production-section">
                  <div className="production-section-title"><div><span>Tenant structure</span><h2>Add location</h2></div><strong>+</strong></div>
                  <CreateLocationForm />
                </section>
                <section className="production-section">
                  <div className="production-section-title"><div><span>Database records</span><h2>Locations</h2></div><strong>{tenant.locations.length}</strong></div>
                  <div className="production-record-list">
                    {tenant.locations.length ? tenant.locations.map((location) => <LocationEditor key={location.id} location={location} />) : <div className="production-empty">No locations have been persisted for this tenant.</div>}
                  </div>
                </section>
              </>
            ) : null}

            {section === "connections" ? (
              <>
                <section className="production-section">
                  <div className="production-section-title"><div><span>Vault-backed registration</span><h2>Add ServiceTitan connection</h2></div><strong>+</strong></div>
                  <CreateConnectionForm locations={tenant.locations} />
                </section>
                <section className="production-section">
                  <div className="production-section-title"><div><span>Database records</span><h2>ServiceTitan connections</h2></div><strong>{tenant.connections.length}</strong></div>
                  <div className="production-record-list">
                    {tenant.connections.length ? tenant.connections.map((connection) => <div key={connection.id}><ConnectionRecord connection={connection} assignments={tenant.assignments} locations={tenant.locations} /><ServiceTitanConfiguration tenant={tenant} connection={connection} /></div>) : <div className="production-empty">No ServiceTitan connection metadata has been persisted for this tenant.</div>}
                  </div>
                </section>
              </>
            ) : null}

            {section === "kpis" ? <OriginalKpiCatalogManager tenant={tenant} /> : null}
            {section === "sources" ? <DeferredAdminSection title="Data Sources" description={readyConnections > 0 ? "ServiceTitan credentials are live and validated. The saved-report/source catalog from the original interface still needs production server actions before an administrator can safely create or publish a source here." : "No ServiceTitan connection has completed trusted worker validation yet. Validate a connection first; then restore the saved-report/source catalog through production server actions."} supported={[`${readyConnections} validated ServiceTitan connection${readyConnections === 1 ? "" : "s"}`, "Saved-report source registry and parameter contracts", "Sample, reconciliation, and publication evidence", "Revision-aware ingestion worker"]} nextStep="Expose the governed source registry, run a read-only report discovery, capture reconciliation evidence, and publish the first source binding." /> : null}
            {section === "targets" ? <DeferredAdminSection title="Targets & Budgets" description="The old target and budget screens saved configuration in the browser. Production has governed effective-dated KPI targets, but the monthly budget workflow still needs a first-class versioned model." supported={["Effective-dated KPI targets", "Location and organization scope", "Approval and audit foundations", "Target-aware production read model foundation"]} nextStep="Restore target administration first, then add a versioned monthly budget model with overlap protection and approval history." /> : null}
            {section === "layouts" ? <DeferredAdminSection title="Layouts & Access" description="The original role layouts and personal dashboard arrangements were local browser preferences. Production has layout tables and organization roles, but needs constrained self-service actions before those controls can return." supported={["Versioned layout templates", "Profile layout overrides", "Owner and administrator authorization", "Portfolio and tenant membership boundaries"]} nextStep="Add audited role-template actions, a user-owned profile-layout policy, and cross-device persistence before enabling drag, hide, and restore controls." /> : null}
          </div>
        </div>
      </div>
    </main>
  );
}
