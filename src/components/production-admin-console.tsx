"use client";

import Link from "next/link";
import {
  useActionState,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { useFormStatus } from "react-dom";
import {
  activateOriginalKpiCatalogAction,
  archiveLocationAction,
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
import { ProductionNavigation } from "@/components/production-navigation";
import {
  getAdminSetupMilestones,
  isProductionAdminSection,
  type ProductionAdminSection,
} from "@/lib/admin-navigation";
import type {
  ProductionTenantContext,
  ServiceTitanAssignment,
  ServiceTitanConnection,
  TenantLocation,
} from "@/lib/tenant-context";

const INITIAL_ADMIN_ACTION_STATE: AdminActionState = { status: "idle", message: "" };
const ADMIN_SECTION_STORAGE_KEY = "gm-admin-section";

const UNITED_STATES_TIMEZONES = [
  { value: "America/New_York", label: "Eastern Time" },
  { value: "America/Chicago", label: "Central Time" },
  { value: "America/Denver", label: "Mountain Time" },
  { value: "America/Phoenix", label: "Mountain Time (Arizona, no DST)" },
  { value: "America/Los_Angeles", label: "Pacific Time" },
  { value: "America/Anchorage", label: "Alaska Time" },
  { value: "Pacific/Honolulu", label: "Hawaii Time" },
] as const;

const PRODUCTION_ADMIN_SECTIONS: Array<{
  id: ProductionAdminSection;
  label: string;
  shortLabel: string;
  group: "Get started" | "Manage performance" | "Planned controls";
  description: string;
}> = [
  { id: "overview", label: "Setup overview", shortLabel: "Overview", group: "Get started", description: "See what is configured and continue from the next incomplete step." },
  { id: "organization", label: "Organization & locations", shortLabel: "Organization", group: "Get started", description: "Manage the organization name and the operating locations shown throughout the workspace." },
  { id: "connections", label: "ServiceTitan setup", shortLabel: "ServiceTitan", group: "Get started", description: "Add secure credentials, review validation, assign locations, and map business units." },
  { id: "kpis", label: "KPI library", shortLabel: "KPI library", group: "Manage performance", description: "Choose which standard KPI definitions are available to this organization." },
  { id: "sources", label: "Data sources", shortLabel: "Data sources", group: "Planned controls", description: "Review the current boundary for report sources and reconciliation evidence." },
  { id: "targets", label: "Targets & budgets", shortLabel: "Targets", group: "Planned controls", description: "Review what is available now and what still needs an administrative workflow." },
  { id: "layouts", label: "Layouts & access", shortLabel: "Layouts", group: "Planned controls", description: "Review the current boundary for shared layouts and role-based administration." },
];

function formatStatus(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function setSectionInUrl(section: ProductionAdminSection, mode: "push" | "replace") {
  const url = new URL(window.location.href);
  url.searchParams.set("section", section);
  window.history[mode === "push" ? "pushState" : "replaceState"]({}, "", url);
}

function usePersistedAdminSection(initialSection: ProductionAdminSection) {
  const [section, setSection] = useState<ProductionAdminSection>(initialSection);

  useEffect(() => {
    window.localStorage.setItem(ADMIN_SECTION_STORAGE_KEY, initialSection);
    setSectionInUrl(initialSection, "replace");

    const onPopState = () => {
      const next = new URL(window.location.href).searchParams.get("section");
      if (isProductionAdminSection(next)) {
        setSection(next);
        window.localStorage.setItem(ADMIN_SECTION_STORAGE_KEY, next);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [initialSection]);

  const navigate = useCallback((next: ProductionAdminSection) => {
    setSection(next);
    window.localStorage.setItem(ADMIN_SECTION_STORAGE_KEY, next);
    setSectionInUrl(next, "push");
    window.requestAnimationFrame(() => document.getElementById("admin-section-title")?.focus());
  }, []);

  return [section, navigate] as const;
}

function DeferredAdminSection({
  title,
  description,
  available,
  nextStep,
}: {
  title: string;
  description: string;
  available: string[];
  nextStep: string;
}) {
  return (
    <section className="production-section production-deferred-section" aria-labelledby="deferred-section-title">
      <div className="production-section-title">
        <div><span>Current release</span><h2 id="deferred-section-title">{title}</h2></div>
        <span className="production-availability-badge">View only</span>
      </div>
      <p className="production-deferred-description">{description}</p>
      <div className="production-deferred-grid">
        <div>
          <span>Available foundations</span>
          <ul>{available.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
        <div>
          <span>Administrative controls not yet available</span>
          <p>{nextStep}</p>
          <p className="production-honesty-note">No changes can be made from this section in the current release.</p>
        </div>
      </div>
    </section>
  );
}

function TimezoneSelect({ defaultValue = "America/Chicago", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select name="timezone" required defaultValue={defaultValue} {...props}>
      {UNITED_STATES_TIMEZONES.map((timezone) => (
        <option key={timezone.value} value={timezone.value}>{timezone.label} — {timezone.value}</option>
      ))}
    </select>
  );
}

function SubmitButton({
  children,
  pendingLabel,
  danger = false,
  disabled = false,
}: {
  children: ReactNode;
  pendingLabel: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button className={`button ${danger ? "production-danger" : "primary"}`} type="submit" disabled={pending || disabled}>
      {pending ? pendingLabel : children}
    </button>
  );
}

function ConfirmAction({
  children,
  pendingLabel,
  title,
  consequence,
  confirmLabel,
  danger = false,
  disabled = false,
}: {
  children: ReactNode;
  pendingLabel: string;
  title: string;
  consequence: string;
  confirmLabel: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  return (
    <>
      <button
        className={`button ${danger ? "production-danger" : "primary"}`}
        type="button"
        disabled={pending || disabled}
        onClick={() => dialogRef.current?.showModal()}
      >
        {pending ? pendingLabel : children}
      </button>
      <dialog ref={dialogRef} className="production-confirm-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <div className="production-confirm-icon" aria-hidden="true">!</div>
        <div>
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{consequence}</p>
        </div>
        <div className="production-confirm-actions">
          <button className="button secondary" type="button" onClick={() => dialogRef.current?.close()}>Cancel</button>
          <button
            className={`button ${danger ? "production-danger production-danger-solid" : "primary"}`}
            type="submit"
            onClick={() => dialogRef.current?.close()}
          >
            {confirmLabel}
          </button>
        </div>
      </dialog>
    </>
  );
}

function ActionNotice({ state }: { state: AdminActionState }) {
  if (state.status === "idle") return null;
  return (
    <div className={`production-notice ${state.status}`} role={state.status === "error" ? "alert" : "status"} aria-live="polite">
      <strong>{state.status === "success" ? "Saved" : "Action needed"}</strong>
      <span>{state.message}</span>
    </div>
  );
}

type FieldAriaProps = {
  id: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
};

function FormField({
  name,
  label,
  state,
  prefix,
  help,
  className,
  children,
}: {
  name: string;
  label: string;
  state: AdminActionState;
  prefix: string;
  help?: string;
  className?: string;
  children: (props: FieldAriaProps) => ReactNode;
}) {
  const error = state.fieldErrors?.[name];
  const inputId = `${prefix}-${name}`;
  const helpId = help ? `${inputId}-help` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <label htmlFor={inputId} className={className}>
      <span className="production-label-text">{label}</span>
      {children({ id: inputId, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })}
      {help ? <small id={helpId}>{help}</small> : null}
      {error ? <small id={errorId} className="production-field-error">{error}</small> : null}
    </label>
  );
}

function OrganizationEditor({ tenant }: { tenant: ProductionTenantContext }) {
  const [state, action] = useActionState(updateOrganizationAction, INITIAL_ADMIN_ACTION_STATE);
  return (
    <section className="production-panel" aria-labelledby="organization-details-title">
      <div className="production-panel-heading">
        <div><span>Organization details</span><h2 id="organization-details-title">Name and workspace URL</h2></div>
        <span className={`production-status ${tenant.organization.status}`}>{formatStatus(tenant.organization.status)}</span>
      </div>
      <form action={action} className="production-form-grid" noValidate>
        <FormField name="name" label="Organization name" state={state} prefix="organization">
          {(props) => <input {...props} name="name" required maxLength={160} defaultValue={tenant.organization.name} />}
        </FormField>
        <FormField name="slug" label="Workspace URL key" state={state} prefix="organization" help="Use lowercase letters, numbers, and hyphens. Changing this may affect saved links.">
          {(props) => <input {...props} name="slug" required minLength={3} maxLength={64} pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" defaultValue={tenant.organization.slug} />}
        </FormField>
        <div className="production-form-footer">
          <span>These details are shared across this organization&apos;s workspace.</span>
          <SubmitButton pendingLabel="Saving organization…">Save organization</SubmitButton>
        </div>
      </form>
      <ActionNotice state={state} />
    </section>
  );
}

function CreateLocationForm() {
  const [state, action] = useActionState(createLocationAction, INITIAL_ADMIN_ACTION_STATE);
  return (
    <section className="production-panel" aria-labelledby="add-location-title">
      <div className="production-panel-heading"><div><span>New operating location</span><h2 id="add-location-title">Add a location</h2></div></div>
      <form action={action} className="production-form-grid" noValidate>
        <FormField name="locationKey" label="Location key" state={state} prefix="new-location" help="A permanent, unique key such as denver-west.">
          {(props) => <input {...props} name="locationKey" required minLength={3} maxLength={64} placeholder="denver-west" />}
        </FormField>
        <FormField name="brandName" label="Brand name" state={state} prefix="new-location">
          {(props) => <input {...props} name="brandName" required maxLength={120} placeholder="Mountain Air" />}
        </FormField>
        <FormField name="displayName" label="Display name" state={state} prefix="new-location">
          {(props) => <input {...props} name="displayName" required maxLength={160} placeholder="Denver West" />}
        </FormField>
        <FormField name="timezone" label="Time zone" state={state} prefix="new-location">
          {(props) => <TimezoneSelect {...props} />}
        </FormField>
        <div className="production-form-footer">
          <span>Locations can be assigned to ServiceTitan after they are added.</span>
          <SubmitButton pendingLabel="Adding location…">Add location</SubmitButton>
        </div>
      </form>
      <ActionNotice state={state} />
    </section>
  );
}

function LocationEditor({ location }: { location: TenantLocation }) {
  const [updateState, updateAction] = useActionState(updateLocationAction, INITIAL_ADMIN_ACTION_STATE);
  const [archiveState, archiveAction] = useActionState(archiveLocationAction, INITIAL_ADMIN_ACTION_STATE);
  const prefix = `location-${location.id}`;

  if (location.status === "archived") {
    return (
      <article className="production-record is-archived">
        <div><strong>{location.display_name}</strong><span>{location.brand_name} · {location.location_key}</span></div>
        <span className="production-status archived">Archived</span>
      </article>
    );
  }

  return (
    <article className="production-record production-location-editor">
      <div className="production-record-heading">
        <div><strong>{location.display_name}</strong><span>{location.brand_name} · {formatStatus(location.status)}</span></div>
        <span className={`production-status ${location.status}`}>{formatStatus(location.status)}</span>
      </div>
      <form action={updateAction} className="production-form-grid compact" noValidate>
        <input type="hidden" name="locationId" value={location.id} />
        <FormField name="locationKey" label="Location key" state={updateState} prefix={prefix}>
          {(props) => <input {...props} name="locationKey" required defaultValue={location.location_key} />}
        </FormField>
        <FormField name="brandName" label="Brand name" state={updateState} prefix={prefix}>
          {(props) => <input {...props} name="brandName" required defaultValue={location.brand_name} />}
        </FormField>
        <FormField name="displayName" label="Display name" state={updateState} prefix={prefix}>
          {(props) => <input {...props} name="displayName" required defaultValue={location.display_name} />}
        </FormField>
        <FormField name="timezone" label="Time zone" state={updateState} prefix={prefix}>
          {(props) => <TimezoneSelect {...props} defaultValue={location.timezone} />}
        </FormField>
        <div className="production-form-footer"><span>Last saved values remain active until this form succeeds.</span><SubmitButton pendingLabel="Saving location…">Save changes</SubmitButton></div>
      </form>
      <ActionNotice state={updateState} />
      <form action={archiveAction} className="production-destructive-row">
        <input type="hidden" name="locationId" value={location.id} />
        <span>Archive this location when it is no longer part of current operations.</span>
        <ConfirmAction
          danger
          pendingLabel="Archiving location…"
          title={`Archive ${location.display_name}?`}
          consequence="The location will no longer be editable or available for new assignments. Historical records are kept. This action cannot be undone here."
          confirmLabel="Archive location"
        >Archive location</ConfirmAction>
      </form>
      <ActionNotice state={archiveState} />
    </article>
  );
}

function CreateConnectionForm({ locations }: { locations: TenantLocation[] }) {
  const [state, action] = useActionState(createConnectionAction, INITIAL_ADMIN_ACTION_STATE);
  const activeLocations = locations.filter((location) => location.status === "active");
  return (
    <section className="production-panel production-connection-create" aria-labelledby="add-connection-title">
      <div className="production-panel-heading"><div><span>Step 1</span><h2 id="add-connection-title">Add connection credentials</h2></div><span className="production-security-badge">Encrypted</span></div>
      <p className="production-boundary-note">Credentials are encrypted when submitted. They are not shown again in the Admin Center or included in activity records.</p>
      <form action={action} className="production-form-grid" autoComplete="off" noValidate>
        <FormField name="tenantId" label="ServiceTitan tenant ID" state={state} prefix="new-connection">
          {(props) => <input {...props} name="tenantId" required maxLength={128} autoComplete="off" />}
        </FormField>
        <FormField name="displayName" label="Connection name" state={state} prefix="new-connection" help="Choose a recognizable name for administrators.">
          {(props) => <input {...props} name="displayName" required maxLength={160} placeholder="DFW ServiceTitan" />}
        </FormField>
        <FormField name="environment" label="ServiceTitan environment" state={state} prefix="new-connection">
          {(props) => <select {...props} name="environment" defaultValue="production"><option value="production">Production</option><option value="integration">Integration</option></select>}
        </FormField>
        <FormField name="locationId" label="Initial location assignment" state={state} prefix="new-connection" help="Optional. Assign more locations after the connection is added.">
          {(props) => <select {...props} name="locationId" defaultValue=""><option value="">No initial assignment</option>{activeLocations.map((location) => <option key={location.id} value={location.id}>{location.display_name}</option>)}</select>}
        </FormField>
        <FormField name="clientId" label="Client ID" state={state} prefix="new-connection">
          {(props) => <input {...props} name="clientId" required maxLength={4096} autoComplete="off" spellCheck={false} />}
        </FormField>
        <FormField name="clientSecret" label="Client secret" state={state} prefix="new-connection">
          {(props) => <input {...props} name="clientSecret" type="password" required maxLength={4096} autoComplete="new-password" spellCheck={false} />}
        </FormField>
        <FormField name="appKey" label="ServiceTitan app key" state={state} prefix="new-connection" className="span-two" help="Enter the App Key from ServiceTitan, not the App ID.">
          {(props) => <input {...props} name="appKey" type="password" required maxLength={4096} autoComplete="new-password" spellCheck={false} />}
        </FormField>
        <div className="production-form-footer">
          <span>After this is saved, an authorized operator must validate read-only access.</span>
          <SubmitButton pendingLabel="Encrypting and adding connection…">Add secure connection</SubmitButton>
        </div>
      </form>
      <ActionNotice state={state} />
    </section>
  );
}

function activeAssignmentNames(connection: ServiceTitanConnection, assignments: ServiceTitanAssignment[], locations: TenantLocation[]): string[] {
  const names = new Map(locations.map((location) => [location.id, location.display_name]));
  return assignments
    .filter((assignment) => assignment.connection_id === connection.id && assignment.revoked_at === null)
    .map((assignment) => names.get(assignment.location_id) ?? "Unknown location");
}

function ConnectionCredentialRotationForm({ connection }: { connection: ServiceTitanConnection }) {
  const [state, action] = useActionState(rotateConnectionCredentialsAction, INITIAL_ADMIN_ACTION_STATE);
  const prefix = `credentials-${connection.id}`;
  return (
    <details className="production-disclosure">
      <summary>Replace connection credentials</summary>
      <div className="production-disclosure-body">
        <p>Use this only after ServiceTitan issues a complete replacement credential set.</p>
        <form action={action} className="production-form-grid compact" autoComplete="off" noValidate>
          <input type="hidden" name="connectionId" value={connection.id} />
          <FormField name="clientId" label="New client ID" state={state} prefix={prefix}>
            {(props) => <input {...props} name="clientId" required maxLength={4096} autoComplete="off" spellCheck={false} />}
          </FormField>
          <FormField name="clientSecret" label="New client secret" state={state} prefix={prefix}>
            {(props) => <input {...props} name="clientSecret" type="password" required maxLength={4096} autoComplete="new-password" spellCheck={false} />}
          </FormField>
          <FormField name="appKey" label="New ServiceTitan app key" state={state} prefix={prefix} className="span-two">
            {(props) => <input {...props} name="appKey" type="password" required maxLength={4096} autoComplete="new-password" spellCheck={false} />}
          </FormField>
          <div className="production-form-footer">
            <span>The existing credentials will no longer be recoverable.</span>
            <ConfirmAction
              pendingLabel="Replacing credentials…"
              title="Replace the encrypted credentials?"
              consequence="The current credential set will be replaced and cannot be recovered. The connection must be validated again before data can be ingested."
              confirmLabel="Replace credentials"
            >Review and replace</ConfirmAction>
          </div>
        </form>
        <ActionNotice state={state} />
      </div>
    </details>
  );
}

function ConnectionRecord({ connection, assignments, locations }: { connection: ServiceTitanConnection; assignments: ServiceTitanAssignment[]; locations: TenantLocation[] }) {
  const [state, action] = useActionState(disableConnectionAction, INITIAL_ADMIN_ACTION_STATE);
  const assignmentNames = activeAssignmentNames(connection, assignments, locations);
  const canDisable = connection.status !== "disabled" && connection.status !== "archived";
  const validated = connection.status === "ready" && Boolean(connection.last_validated_at);
  return (
    <article className={`production-record production-connection-record ${canDisable ? "" : "is-archived"}`}>
      <div className="production-record-heading">
        <div><strong>{connection.display_name}</strong><span>ServiceTitan tenant {connection.service_titan_tenant_id} · {formatStatus(connection.environment)}</span></div>
        <span className={`production-status ${connection.status}`}>{formatStatus(connection.status)}</span>
      </div>
      <dl className="production-facts">
        <div><dt>Credential storage</dt><dd>Encrypted</dd></div>
        <div><dt>Assigned locations</dt><dd>{assignmentNames.length ? assignmentNames.join(", ") : "None"}</dd></div>
        <div><dt>Access validation</dt><dd>{validated && connection.last_validated_at ? `Validated ${new Date(connection.last_validated_at).toLocaleString()}` : "Not validated"}</dd></div>
      </dl>
      {canDisable ? (
        <>
          <ConnectionCredentialRotationForm connection={connection} />
          <form action={action} className="production-destructive-row">
            <input type="hidden" name="connectionId" value={connection.id} />
            <span>Disable this connection if the organization should no longer access the ServiceTitan tenant.</span>
            <ConfirmAction
              danger
              pendingLabel="Disabling connection…"
              title={`Disable ${connection.display_name}?`}
              consequence="All active location assignments will be revoked and the encrypted credentials will be permanently destroyed. Existing historical data is kept. This cannot be undone here."
              confirmLabel="Disable connection"
            >Disable connection</ConfirmAction>
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
  const activeLocations = tenant.locations.filter((location) => location.status === "active");

  return (
    <section className="production-connection-config" aria-label={`${connection.display_name} location and business unit setup`}>
      <form action={assignmentAction} className="production-config-step">
        <input type="hidden" name="connectionId" value={connection.id} />
        <input type="hidden" name="confirmReplacement" value="yes" />
        <div className="production-config-step-heading">
          <span aria-hidden="true">3</span>
          <div><h3>Assign operating locations</h3><p>Choose every location that uses this ServiceTitan tenant.</p></div>
          <b>{activeAssignments.size} assigned</b>
        </div>
        <fieldset className="production-choice-list">
          <legend className="sr-only">Locations assigned to {connection.display_name}</legend>
          {activeLocations.length ? activeLocations.map((location) => (
            <label key={location.id} className="production-checkbox-row">
              <input type="checkbox" name="locationId" value={location.id} defaultChecked={activeAssignments.has(location.id)} />
              <span>{location.display_name}</span>
            </label>
          )) : <p className="production-empty compact">Add an active location before assigning this connection.</p>}
        </fieldset>
        <div className="production-form-footer">
          <span>Saving replaces the full assignment list. Removed locations also lose their business-unit mappings.</span>
          <ConfirmAction
            pendingLabel="Updating assignments…"
            title="Replace the location assignments?"
            consequence="This selection will replace every active assignment for this connection. Removing a location also revokes its current business-unit mappings."
            confirmLabel="Replace assignments"
            disabled={activeLocations.length === 0}
          >Review assignment changes</ConfirmAction>
        </div>
        <ActionNotice state={assignmentState} />
      </form>

      <form action={discoveryAction} className="production-config-step">
        <input type="hidden" name="connectionId" value={connection.id} />
        <div className="production-config-step-heading">
          <span aria-hidden="true">4</span>
          <div><h3>Request business units</h3><p>Queue a read-only request for the current ServiceTitan business-unit list.</p></div>
          <b>{latestRun ? formatStatus(latestRun.status) : "Not requested"}</b>
        </div>
        <div className="production-action-row">
          <span>{latestRun ? `Latest request: ${formatStatus(latestRun.status)}${latestRun.completed_at ? ` · ${new Date(latestRun.completed_at).toLocaleString()}` : ""}` : "No request has been submitted for this connection."}</span>
          <SubmitButton pendingLabel="Requesting business units…" disabled={!canDiscover}>{canDiscover ? "Request business units" : "Validation required"}</SubmitButton>
        </div>
        {!canDiscover ? <p className="production-inline-guidance">An authorized operator must validate ServiceTitan access before discovery can be requested.</p> : null}
        <ActionNotice state={discoveryState} />
      </form>

      <form action={mappingAction} className="production-config-step">
        <input type="hidden" name="connectionId" value={connection.id} />
        <input type="hidden" name="discoveryRevision" value={revision ?? ""} />
        <input type="hidden" name="confirmMappings" value="yes" />
        <div className="production-config-step-heading">
          <span aria-hidden="true">5</span>
          <div><h3>Map business units</h3><p>Connect each discovered business unit to a location and trade.</p></div>
          <b>{mappingByProviderId.size} of {units.length} mapped</b>
        </div>
        {revision && units.length > 0 ? (
          <>
            <div className="production-mapping-list">
              {units.map((unit) => {
                const mapping = mappingByProviderId.get(unit.provider_business_unit_id);
                return (
                  <div key={unit.provider_business_unit_id} className="production-mapping-row">
                    <input type="hidden" name="providerBusinessUnitId" value={unit.provider_business_unit_id} />
                    <strong>{unit.name}</strong>
                    <label>Location<select name="mappedLocationId" defaultValue={mapping?.location_id ?? ""}><option value="">Not mapped</option>{assignedLocations.map((location) => <option key={location.id} value={location.id}>{location.display_name}</option>)}</select></label>
                    <label>Trade<select name="trade" defaultValue={mapping?.trade ?? ""}><option value="">Not mapped</option><option value="hvac">HVAC</option><option value="plumbing">Plumbing</option><option value="electrical">Electrical</option><option value="other">Other</option></select></label>
                  </div>
                );
              })}
            </div>
            <div className="production-form-footer">
              <span>Unmapped rows remain visible. Saving replaces every mapping from this discovery result.</span>
              <ConfirmAction
                pendingLabel="Updating mappings…"
                title="Replace all business-unit mappings?"
                consequence="The submitted rows will replace every active mapping for this connection. Rows left unmapped will no longer contribute a location or trade mapping."
                confirmLabel="Replace mappings"
              >Review mapping changes</ConfirmAction>
            </div>
          </>
        ) : <div className="production-empty compact">Complete a business-unit request before mapping. Requests are processed by the trusted ServiceTitan worker outside this page.</div>}
        <ActionNotice state={mappingState} />
      </form>
    </section>
  );
}

function ServiceTitanProcess({ tenant }: { tenant: ProductionTenantContext }) {
  const admin = tenant.adminConfiguration;
  const enabledConnections = tenant.connections.filter((connection) => connection.status !== "disabled" && connection.status !== "archived");
  const validated = enabledConnections.some((connection) => connection.status === "ready" && Boolean(connection.last_validated_at));
  const assigned = tenant.readiness.assignedActiveLocationCount > 0;
  const discovered = Boolean(admin?.businessUnits.some((unit) => unit.active));
  const mapped = Boolean(admin?.businessUnitMappings.some((mapping) => mapping.revoked_at === null));
  const stages = [
    { number: 1, label: "Add credentials", detail: "Available below", complete: enabledConnections.length > 0 },
    { number: 2, label: "Validate access", detail: "Completed by an authorized operator", complete: validated },
    { number: 3, label: "Assign locations", detail: "Managed per connection", complete: assigned },
    { number: 4, label: "Request business units", detail: "Available after validation", complete: discovered },
    { number: 5, label: "Map business units", detail: "Managed from discovery results", complete: mapped },
  ];
  return (
    <section className="production-section production-process" aria-labelledby="servicetitan-process-title">
      <div className="production-section-title"><div><span>Connection process</span><h2 id="servicetitan-process-title">Five clear steps to a mapped connection</h2></div></div>
      <ol>
        {stages.map((stage) => (
          <li key={stage.number} className={stage.complete ? "complete" : "incomplete"}>
            <span aria-hidden="true">{stage.complete ? "✓" : stage.number}</span>
            <div><strong>{stage.label}</strong><small>{stage.detail}</small></div>
            <b>{stage.complete ? "Complete" : "Not complete"}</b>
          </li>
        ))}
      </ol>
      <p className="production-process-note"><strong>About validation:</strong> this release displays the persisted validation result. It does not run the trusted validation worker from the browser.</p>
    </section>
  );
}

function OriginalKpiCatalogManager({ tenant }: { tenant: ProductionTenantContext }) {
  const admin = tenant.adminConfiguration;
  const [selectedState, selectedAction] = useActionState(activateOriginalKpiCatalogAction, INITIAL_ADMIN_ACTION_STATE);
  const [allState, allAction] = useActionState(activateOriginalKpiCatalogAction, INITIAL_ADMIN_ACTION_STATE);
  if (!admin) return <div className="production-empty">The KPI library could not be loaded.</div>;
  const enabled = new Set(admin.originalKpiDefinitions.filter((definition) => definition.lifecycle === "published").map((definition) => definition.kpi_key));
  const inactive = admin.originalKpiCatalog.filter((item) => !enabled.has(item.kpi_key));
  const sections = ["executive", "revenue", "calls", "appointments", "sales", "membership"] as const;
  return (
    <section className="production-section production-kpi-library" aria-labelledby="kpi-library-title">
      <div className="production-section-title"><div><span>Standard metric definitions</span><h2 id="kpi-library-title">Original 36 KPI library</h2></div><strong>{enabled.size}/36 active</strong></div>
      <p className="production-section-intro">Activating a KPI makes its definition available. It does not connect data, create targets, or place the KPI on a dashboard.</p>
      <form action={selectedAction} className="production-form-grid">
        <input type="hidden" name="selectionMode" value="selected" />
        <input type="hidden" name="confirmActivation" value="yes" />
        {sections.map((section) => {
          const items = admin.originalKpiCatalog.filter((item) => item.section === section);
          return (
            <fieldset key={section}>
              <legend>{formatStatus(section)}</legend>
              {items.map((item) => (
                <label key={item.kpi_key} className="production-checkbox-row">
                  <input type="checkbox" name="kpiKey" value={item.kpi_key} disabled={enabled.has(item.kpi_key)} />
                  <span><strong>{item.title}</strong><small>{enabled.has(item.kpi_key) ? "Active" : `${item.source_system} · ${item.subtitle}`}</small></span>
                </label>
              ))}
            </fieldset>
          );
        })}
        <div className="production-form-footer">
          <span>{inactive.length} definition{inactive.length === 1 ? "" : "s"} not yet active.</span>
          <ConfirmAction
            pendingLabel="Activating selected KPIs…"
            title="Activate the selected KPI definitions?"
            consequence="The selected definitions will be published for this organization. Their data will remain unavailable until each source and location binding is configured."
            confirmLabel="Activate selected KPIs"
            disabled={inactive.length === 0}
          >Review and activate</ConfirmAction>
        </div>
      </form>
      <ActionNotice state={selectedState} />
      {inactive.length > 0 ? (
        <form action={allAction} className="production-action-row production-enable-all-row">
          <input type="hidden" name="selectionMode" value="all" />
          <input type="hidden" name="confirmActivation" value="yes" />
          <span>Activate every remaining definition in the standard library.</span>
          <ConfirmAction
            pendingLabel="Activating KPI library…"
            title="Activate every remaining KPI definition?"
            consequence="All remaining standard definitions will be published. This does not connect data, create targets, or add dashboard cards."
            confirmLabel="Activate all remaining KPIs"
          >Activate all</ConfirmAction>
        </form>
      ) : null}
      <ActionNotice state={allState} />
    </section>
  );
}

function SetupOverview({ tenant, navigate }: { tenant: ProductionTenantContext; navigate: (section: ProductionAdminSection) => void }) {
  const admin = tenant.adminConfiguration;
  const discoveredBusinessUnitCount = admin?.businessUnits.filter((unit) => unit.active).length ?? 0;
  const mappedBusinessUnitCount = admin?.businessUnitMappings.filter((mapping) => mapping.revoked_at === null).length ?? 0;
  const milestones = getAdminSetupMilestones({
    activeLocationCount: tenant.readiness.activeLocationCount,
    enabledConnectionCount: tenant.readiness.enabledConnectionCount,
    hasValidatedConnection: tenant.readiness.hasValidatedConnection,
    assignedActiveLocationCount: tenant.readiness.assignedActiveLocationCount,
    discoveredBusinessUnitCount,
    mappedBusinessUnitCount,
  });
  const completeCount = milestones.filter((milestone) => milestone.complete).length;
  const details = [
    { id: "locations", title: "Add an operating location", detail: tenant.readiness.activeLocationCount ? `${tenant.readiness.activeLocationCount} active location${tenant.readiness.activeLocationCount === 1 ? "" : "s"}` : "No active locations", section: "organization" as const },
    { id: "credentials", title: "Add ServiceTitan credentials", detail: tenant.readiness.enabledConnectionCount ? `${tenant.readiness.enabledConnectionCount} enabled connection${tenant.readiness.enabledConnectionCount === 1 ? "" : "s"}` : "No enabled connections", section: "connections" as const },
    { id: "validation", title: "Validate ServiceTitan access", detail: tenant.readiness.hasValidatedConnection ? "A validated connection is ready" : "Waiting for authorized operator validation", section: "connections" as const },
    { id: "assignments", title: "Assign locations", detail: tenant.readiness.assignedActiveLocationCount ? `${tenant.readiness.assignedActiveLocationCount} assigned active location${tenant.readiness.assignedActiveLocationCount === 1 ? "" : "s"}` : "No active locations assigned", section: "connections" as const },
    { id: "discovery", title: "Request business units", detail: discoveredBusinessUnitCount ? `${discoveredBusinessUnitCount} active business unit${discoveredBusinessUnitCount === 1 ? "" : "s"} found` : "No business units loaded", section: "connections" as const },
    { id: "mappings", title: "Map business units", detail: mappedBusinessUnitCount ? `${mappedBusinessUnitCount} current mapping${mappedBusinessUnitCount === 1 ? "" : "s"}` : "No current mappings", section: "connections" as const },
  ];

  return (
    <>
      <section className="production-readiness-grid" aria-label="Current organization setup">
        <div><span>Active locations</span><strong>{tenant.readiness.activeLocationCount}</strong><small>Available for assignment</small></div>
        <div><span>Enabled connections</span><strong>{tenant.readiness.enabledConnectionCount}</strong><small>Not disabled or archived</small></div>
        <div><span>Assigned locations</span><strong>{tenant.readiness.assignedActiveLocationCount}</strong><small>Active connection assignments</small></div>
        <div><span>ServiceTitan access</span><strong className="readiness-word">{tenant.readiness.hasValidatedConnection ? "Validated" : "Not validated"}</strong><small>Persisted validation result</small></div>
      </section>
      <section className="production-section production-setup-path" aria-labelledby="guided-setup-title">
        <div className="production-section-title">
          <div><span>Guided setup</span><h2 id="guided-setup-title">Core ServiceTitan setup</h2></div>
          <strong aria-label={`${completeCount} of ${milestones.length} milestones complete`}>{completeCount}/{milestones.length}</strong>
        </div>
        <p>This progress comes from saved organization data. Complete each milestone in order; future data-source, target, and layout controls are not counted.</p>
        <ol>
          {details.map((detail, index) => {
            const milestone = milestones.find((item) => item.id === detail.id);
            return (
              <li key={detail.id}>
                <button type="button" onClick={() => navigate(detail.section)}>
                  <span className={milestone?.complete ? "complete" : "needed"} aria-hidden="true">{milestone?.complete ? "✓" : index + 1}</span>
                  <div><strong>{detail.title}</strong><small>{detail.detail}</small></div>
                  <b>{milestone?.complete ? "Complete" : "Continue"}</b>
                </button>
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}

function AdminSectionNavigation({ section, navigate }: { section: ProductionAdminSection; navigate: (section: ProductionAdminSection) => void }) {
  const groups = ["Get started", "Manage performance", "Planned controls"] as const;
  return (
    <>
      <label className="production-admin-mobile-select">
        <span>Admin section</span>
        <select value={section} onChange={(event) => navigate(event.target.value as ProductionAdminSection)}>
          {PRODUCTION_ADMIN_SECTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <nav className="production-admin-section-nav" aria-label="Admin Center sections">
        {groups.map((group) => (
          <div key={group} className="production-admin-nav-group">
            <p>{group}</p>
            {PRODUCTION_ADMIN_SECTIONS.filter((item) => item.group === group).map((item) => (
              <button
                type="button"
                key={item.id}
                className={section === item.id ? "active" : ""}
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => navigate(item.id)}
              >
                <strong>{item.shortLabel}</strong>
                <span>{item.description}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
    </>
  );
}

export function ProductionAdminConsole({
  tenant,
  mode,
  initialSection = "overview",
}: {
  tenant: ProductionTenantContext;
  mode: "staging" | "production";
  initialSection?: ProductionAdminSection;
}) {
  const [section, navigate] = usePersistedAdminSection(initialSection);
  const selectedSection = PRODUCTION_ADMIN_SECTIONS.find((item) => item.id === section) ?? PRODUCTION_ADMIN_SECTIONS[0];
  const readyConnections = tenant.connections.filter((connection) => connection.status === "ready" && Boolean(connection.last_validated_at)).length;

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
        <div className="production-title-row production-admin-title-row">
          <div><span>Organization administration</span><h1>Admin Center</h1><p>Manage setup and performance configuration for <strong>{tenant.organization.name}</strong>.</p></div>
          <Link href="/" className="button secondary">Return to dashboard</Link>
        </div>

        <div className="production-admin-workspace">
          <aside className="production-admin-sidebar">
            <AdminSectionNavigation section={section} navigate={navigate} />
            <div className="production-admin-access-note"><strong>Signed in as {formatStatus(tenant.role)}</strong><span>Changes are limited to this organization and recorded by the secured server actions.</span></div>
          </aside>

          <div className="production-admin-section-content">
            <header className="production-admin-section-heading">
              <p>Admin Center / {selectedSection.shortLabel}</p>
              <h2 id="admin-section-title" tabIndex={-1}>{selectedSection.label}</h2>
              <span>{selectedSection.description}</span>
            </header>

            {section === "overview" ? <SetupOverview tenant={tenant} navigate={navigate} /> : null}

            {section === "organization" ? (
              <>
                <OrganizationEditor tenant={tenant} />
                <CreateLocationForm />
                <section className="production-section" aria-labelledby="locations-list-title">
                  <div className="production-section-title"><div><span>All locations</span><h2 id="locations-list-title">Location records</h2></div><strong>{tenant.locations.length}</strong></div>
                  <div className="production-record-list">
                    {tenant.locations.length ? tenant.locations.map((location) => <LocationEditor key={location.id} location={location} />) : <div className="production-empty">No locations have been added for this organization.</div>}
                  </div>
                </section>
              </>
            ) : null}

            {section === "connections" ? (
              <>
                <ServiceTitanProcess tenant={tenant} />
                <CreateConnectionForm locations={tenant.locations} />
                <section className="production-section production-connections-list" aria-labelledby="connections-list-title">
                  <div className="production-section-title"><div><span>Connection records</span><h2 id="connections-list-title">Manage existing connections</h2></div><strong>{tenant.connections.length}</strong></div>
                  <div className="production-record-list">
                    {tenant.connections.length ? tenant.connections.map((connection) => (
                      <div key={connection.id} className="production-connection-bundle">
                        <ConnectionRecord connection={connection} assignments={tenant.assignments} locations={tenant.locations} />
                        <ServiceTitanConfiguration tenant={tenant} connection={connection} />
                      </div>
                    )) : <div className="production-empty">No ServiceTitan connections have been added.</div>}
                  </div>
                </section>
              </>
            ) : null}

            {section === "kpis" ? <OriginalKpiCatalogManager tenant={tenant} /> : null}
            {section === "sources" ? <DeferredAdminSection title="Data sources" description={readyConnections > 0 ? "A validated ServiceTitan connection is available. Creating and publishing report sources is not available from this Admin Center release." : "A ServiceTitan connection must be validated before report-source work can begin. Creating and publishing sources is not available from this Admin Center release."} available={[`${readyConnections} validated ServiceTitan connection${readyConnections === 1 ? "" : "s"}`, "Saved-report records and parameter contracts", "Reconciliation evidence records", "Revision-aware ingestion foundations"]} nextStep="A future release must add secured actions for report discovery, evidence review, and source publication before administrators can manage sources here." /> : null}
            {section === "targets" ? <DeferredAdminSection title="Targets & budgets" description="Effective-dated KPI target records are supported, but this release does not provide an administrative editor. Monthly budgets do not yet have a production workflow." available={["Effective-dated KPI target records", "Organization and location scope", "Approval and audit foundations", "Target-aware dashboard foundations"]} nextStep="A future release must add an audited target editor and a versioned monthly budget workflow with approval history." /> : null}
            {section === "layouts" ? <DeferredAdminSection title="Layouts & access" description="Shared layout records and organization roles exist, but this release does not provide self-service layout or access controls." available={["Versioned layout templates", "Profile layout records", "Owner and administrator roles", "Organization membership boundaries"]} nextStep="A future release must add audited role-template actions and user-owned cross-device layout controls before editing can be enabled." /> : null}
          </div>
        </div>
      </div>
    </main>
  );
}
