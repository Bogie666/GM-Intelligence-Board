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
  createDivisionAction,
  createConnectionAction,
  createLocationAction,
  disableConnectionAction,
  moveDivisionAction,
  runBusinessUnitDiscoveryAction,
  renameDivisionAction,
  replaceBusinessUnitMappingsAction,
  replaceConnectionLocationsAction,
  rotateConnectionCredentialsAction,
  setDivisionStatusAction,
  updateLocationAction,
  updateOrganizationAction,
  validateServiceTitanConnectionAction,
  type AdminActionState,
  type ServiceTitanExecutionActionState,
} from "@/app/admin/actions";
import { ProductionNavigation } from "@/components/production-navigation";
import {
  ProductionDataSourcesSettings,
  ProductionLayoutsAccessSettings,
  ProductionTargetsBudgetsSettings,
} from "@/components/production-admin-settings";
import {
  getAdminSetupMilestones,
  isProductionAdminSection,
  type ProductionAdminSection,
} from "@/lib/admin-navigation";
import type { ProductionAdminSettingsWorkspace } from "@/lib/production-admin-settings";
import { getBusinessUnitMappingReadiness } from "@/lib/business-unit-mapping-readiness";
import {
  type OrganizationDivision,
  type ProductionTenantContext,
  type ServiceTitanAssignment,
  type ServiceTitanBusinessUnit,
  type ServiceTitanBusinessUnitMapping,
  type ServiceTitanConnection,
  type TenantLocation,
} from "@/lib/tenant-context";

const INITIAL_ADMIN_ACTION_STATE: AdminActionState = { status: "idle", message: "" };
const INITIAL_VALIDATION_STATE: ServiceTitanExecutionActionState = { status: "idle", message: "", operation: "validation", phase: "failed", retryable: false };
const INITIAL_DISCOVERY_STATE: ServiceTitanExecutionActionState = { status: "idle", message: "", operation: "business_unit_discovery", phase: "failed", retryable: false };
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
  group: "Get started" | "Manage performance" | "Govern workspace";
  description: string;
}> = [
  { id: "overview", label: "Setup overview", shortLabel: "Overview", group: "Get started", description: "See what is configured and continue from the next incomplete step." },
  { id: "organization", label: "Organization & locations", shortLabel: "Organization", group: "Get started", description: "Manage the organization name and the operating locations shown throughout the workspace." },
  { id: "connections", label: "ServiceTitan setup", shortLabel: "ServiceTitan", group: "Get started", description: "Add secure credentials, review validation, assign locations, and map business units." },
  { id: "kpis", label: "KPI library", shortLabel: "KPI library", group: "Manage performance", description: "Choose which standard KPI definitions are available to this organization." },
  { id: "sources", label: "Data sources", shortLabel: "Data sources", group: "Manage performance", description: "Register governed report sources and bind published KPIs to exact locations." },
  { id: "targets", label: "Targets & budgets", shortLabel: "Targets", group: "Manage performance", description: "Manage effective-dated performance targets and budget-tagged KPI plans." },
  { id: "layouts", label: "Layouts & access", shortLabel: "Layouts", group: "Govern workspace", description: "Review access roles and select approved member dashboard layouts." },
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

type AdminConfiguration = NonNullable<ProductionTenantContext["adminConfiguration"]>;
const MAPPING_UI_MAX_BUSINESS_UNITS = 500;

function latestSuccessfulDiscovery(admin: AdminConfiguration, connectionId: string) {
  return admin.discoveryRuns.find((run) =>
    run.connection_id === connectionId &&
    run.status === "completed" &&
    run.discovery_revision !== null &&
    admin.businessUnits.some((unit) =>
      unit.connection_id === connectionId &&
      unit.discovery_revision === run.discovery_revision &&
      unit.active,
    ),
  );
}

function activeAssignedLocationIds(tenant: ProductionTenantContext, connectionId: string) {
  const activeLocationIds = new Set(
    tenant.locations.filter((location) => location.status === "active").map((location) => location.id),
  );
  return tenant.assignments
    .filter((assignment) =>
      assignment.connection_id === connectionId &&
      assignment.revoked_at === null &&
      activeLocationIds.has(assignment.location_id),
    )
    .map((assignment) => assignment.location_id);
}

function mappingReadinessForConnection(
  admin: AdminConfiguration,
  tenant: ProductionTenantContext,
  connection: ServiceTitanConnection,
) {
  const successfulRun = connection.status === "ready"
    ? latestSuccessfulDiscovery(admin, connection.id)
    : undefined;
  const assignedLocationIds = activeAssignedLocationIds(tenant, connection.id);
  if (!successfulRun?.discovery_revision) {
    return {
      activeBusinessUnitCount: 0,
      activeDivisionCount: admin.divisions.filter((division) => division.status === "active").length,
      mappedBusinessUnitCount: 0,
      complete: false,
    };
  }
  return getBusinessUnitMappingReadiness({
    connectionId: connection.id,
    discoveryRevision: successfulRun.discovery_revision,
    businessUnits: admin.businessUnits,
    divisions: admin.divisions,
    activeAssignedLocationIds: assignedLocationIds,
    mappings: admin.businessUnitMappings,
  });
}

function DivisionOrderButton({
  direction,
  divisionName,
  disabled,
}: {
  direction: "up" | "down";
  divisionName: string;
  disabled: boolean;
}) {
  const { pending } = useFormStatus();
  const directionLabel = direction === "up" ? "up" : "down";
  return (
    <button
      className="button secondary"
      type="submit"
      name="direction"
      value={direction}
      disabled={pending || disabled}
      aria-label={`Move ${divisionName} ${directionLabel}`}
    >
      {pending ? "Moving…" : `Move ${directionLabel}`}
    </button>
  );
}

function DivisionEditor({
  division,
  canMoveUp,
  canMoveDown,
}: {
  division: OrganizationDivision;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const [renameState, renameAction] = useActionState(renameDivisionAction, INITIAL_ADMIN_ACTION_STATE);
  const [statusState, statusAction] = useActionState(setDivisionStatusAction, INITIAL_ADMIN_ACTION_STATE);
  const [moveState, moveAction] = useActionState(moveDivisionAction, INITIAL_ADMIN_ACTION_STATE);
  const prefix = `division-${division.id}`;

  if (division.status === "archived") {
    return (
      <article className="production-record is-archived">
        <div className="production-record-heading">
          <div>
            <strong>{division.name}</strong>
            <span>Archived divisions preserve reporting and mapping history, but cannot be selected for new mappings.</span>
          </div>
          <span className="production-status archived">Archived</span>
        </div>
        <form action={statusAction} className="production-action-row">
          <input type="hidden" name="divisionId" value={division.id} />
          <input type="hidden" name="status" value="active" />
          <span>Restore this division to make it available in business-unit mapping selectors again.</span>
          <SubmitButton pendingLabel="Restoring division…">Restore division</SubmitButton>
        </form>
        <ActionNotice state={statusState} />
      </article>
    );
  }

  return (
    <article className="production-record production-division-record">
      <div className="production-record-heading">
        <div><strong>{division.name}</strong><span>Active division · display position {division.sort_order}</span></div>
        <span className="production-status active">Active</span>
      </div>
      <form action={renameAction} className="production-form-grid compact" noValidate>
        <input type="hidden" name="divisionId" value={division.id} />
        <FormField name="name" label="Division name" state={renameState} prefix={prefix} help="Renaming preserves this division’s stable identity and historical reporting.">
          {(props) => <input {...props} name="name" required maxLength={80} defaultValue={division.name} />}
        </FormField>
        <div className="production-form-footer">
          <span>Use the operating name administrators should see while mapping ServiceTitan business units.</span>
          <SubmitButton pendingLabel="Renaming division…">Save name</SubmitButton>
        </div>
      </form>
      <ActionNotice state={renameState} />
      <div className="production-division-order" role="group" aria-label={`Change display order for ${division.name}`}>
        <span>Display order controls where this division appears in mapping selectors.</span>
        <div>
          <form action={moveAction}>
            <input type="hidden" name="divisionId" value={division.id} />
            <DivisionOrderButton direction="up" divisionName={division.name} disabled={!canMoveUp} />
          </form>
          <form action={moveAction}>
            <input type="hidden" name="divisionId" value={division.id} />
            <DivisionOrderButton direction="down" divisionName={division.name} disabled={!canMoveDown} />
          </form>
        </div>
      </div>
      <ActionNotice state={moveState} />
      <form action={statusAction} className="production-destructive-row">
        <input type="hidden" name="divisionId" value={division.id} />
        <input type="hidden" name="status" value="archived" />
        <span>Archive divisions that are no longer used. Current mappings must be reassigned or removed first.</span>
        <ConfirmAction
          danger
          pendingLabel="Archiving division…"
          title={`Archive ${division.name}?`}
          consequence="The division will no longer be selectable for new mappings. Historical records are preserved, and the division can be restored later. Any current business-unit mappings must be reassigned or removed before archiving."
          confirmLabel="Archive division"
        >Archive division</ConfirmAction>
      </form>
      <ActionNotice state={statusState} />
    </article>
  );
}

function DivisionManager({ tenant }: { tenant: ProductionTenantContext }) {
  const [state, action] = useActionState(createDivisionAction, INITIAL_ADMIN_ACTION_STATE);
  const admin = tenant.adminConfiguration;
  if (!admin) return <div className="production-empty">Division configuration could not be loaded.</div>;
  const divisions = [...admin.divisions].sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name));
  const activeDivisions = divisions.filter((division) => division.status === "active");

  return (
    <section className="production-section production-division-manager" aria-labelledby="division-manager-title">
      <div className="production-section-title">
        <div><span>Step 5</span><h2 id="division-manager-title">Create your divisions</h2></div>
        <strong aria-label={`${activeDivisions.length} active divisions`}>{activeDivisions.length}</strong>
      </div>
      <p className="production-section-intro">Divisions are organization-wide labels used to group discovered ServiceTitan business units. Create at least one active division before mapping.</p>
      <p className="production-boundary-note"><strong>“Not Mapped” is never a division.</strong> It means a business unit currently has no saved mapping. Archived divisions preserve history but are unavailable in new mapping selections until restored.</p>
      <form action={action} className="production-form-grid production-division-create" noValidate>
        <FormField name="name" label="New division name" state={state} prefix="new-division" help="Use 1 to 80 printable characters. Division names must be unique.">
          {(props) => <input {...props} name="name" required maxLength={80} placeholder="Residential HVAC" />}
        </FormField>
        <div className="production-form-footer">
          <span>The new division is active immediately and appears in every connection’s mapping selectors.</span>
          <SubmitButton pendingLabel="Creating division…">Create division</SubmitButton>
        </div>
      </form>
      <ActionNotice state={state} />
      <div className="production-record-list" aria-label="Organization divisions">
        {divisions.length ? divisions.map((division) => {
          const activeIndex = activeDivisions.findIndex((item) => item.id === division.id);
          return (
            <DivisionEditor
              key={division.id}
              division={division}
              canMoveUp={activeIndex > 0}
              canMoveDown={activeIndex >= 0 && activeIndex < activeDivisions.length - 1}
            />
          );
        }) : <div className="production-empty">No divisions have been created. Add the first active division to unlock business-unit mapping.</div>}
      </div>
    </section>
  );
}

function ServiceTitanConnectionConfiguration({ tenant, connection }: { tenant: ProductionTenantContext; connection: ServiceTitanConnection }) {
  const admin = tenant.adminConfiguration;
  const [validationState, validationAction] = useActionState(validateServiceTitanConnectionAction, INITIAL_VALIDATION_STATE);
  const [discoveryState, discoveryAction] = useActionState(runBusinessUnitDiscoveryAction, INITIAL_DISCOVERY_STATE);
  const [assignmentState, assignmentAction] = useActionState(replaceConnectionLocationsAction, INITIAL_ADMIN_ACTION_STATE);
  if (!admin || connection.status === "disabled" || connection.status === "archived") return null;

  const runs = admin.discoveryRuns.filter((run) => run.connection_id === connection.id);
  const latestRun = runs[0];
  const activeAssignments = new Set(tenant.assignments.filter((item) => item.connection_id === connection.id && item.revoked_at === null).map((item) => item.location_id));
  const canDiscover = connection.status === "ready" && Boolean(connection.last_validated_at);
  const activeLocations = tenant.locations.filter((location) => location.status === "active");

  return (
    <section className="production-connection-config" aria-label={`${connection.display_name} location and business unit setup`}>
      <form action={validationAction} className="production-config-step">
        <input type="hidden" name="connectionId" value={connection.id} />
        <div className="production-config-step-heading">
          <span aria-hidden="true">2</span>
          <div><h3>Validate ServiceTitan access</h3><p>Securely verify OAuth credentials and read-only business-unit access.</p></div>
          <b>{canDiscover ? "Ready" : "Required"}</b>
        </div>
        <div className="production-action-row">
          <span>{connection.last_validated_at ? `Last validated ${new Date(connection.last_validated_at).toLocaleString()}` : "Credentials have not been validated."}</span>
          <SubmitButton pendingLabel="Validating ServiceTitan…">{canDiscover ? "Revalidate connection" : "Validate connection"}</SubmitButton>
        </div>
        <p className="production-inline-guidance">Validation runs securely on the server. Credentials and provider responses are never returned to the browser.</p>
        <ActionNotice state={validationState} />
      </form>

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
          <div><h3>Discover business units</h3><p>Run a secure read-only request and save the current ServiceTitan business-unit list.</p></div>
          <b>{latestRun ? formatStatus(latestRun.status) : "Not requested"}</b>
        </div>
        <div className="production-action-row">
          <span>{latestRun ? `Latest discovery: ${formatStatus(latestRun.status)}${latestRun.completed_at ? ` · ${new Date(latestRun.completed_at).toLocaleString()}` : ""}` : "Business-unit discovery has not been run."}</span>
          <SubmitButton pendingLabel="Discovering business units…" disabled={!canDiscover}>{canDiscover ? (latestRun ? "Run discovery again" : "Discover business units") : "Validation required"}</SubmitButton>
        </div>
        {!canDiscover ? <p className="production-inline-guidance">Validate this connection first. Discovery becomes available immediately after successful validation.</p> : null}
        <ActionNotice state={discoveryState} />
      </form>

    </section>
  );
}

function BusinessUnitMappingRow({
  unit,
  mapping,
  locations,
  divisions,
  disabled,
}: {
  unit: ServiceTitanBusinessUnit;
  mapping?: ServiceTitanBusinessUnitMapping;
  locations: TenantLocation[];
  divisions: OrganizationDivision[];
  disabled: boolean;
}) {
  const initialLocationId = mapping?.location_id ?? "";
  const initialDivisionId = mapping?.division_id ?? "";
  const [locationId, setLocationId] = useState(initialLocationId);
  const [divisionId, setDivisionId] = useState(initialDivisionId);
  const guidanceId = useId();
  const partialSelection = Boolean(locationId) !== Boolean(divisionId);

  return (
    <div className={`production-mapping-row${disabled ? " is-disabled" : ""}`}>
      <input type="hidden" name="providerBusinessUnitId" value={unit.provider_business_unit_id} />
      <div><strong>{unit.name}</strong><small>{unit.provider_business_unit_id}</small></div>
      <label>
        <span>Location</span>
        <select
          name="mappedLocationId"
          value={locationId}
          disabled={disabled}
          required={Boolean(divisionId)}
          aria-invalid={partialSelection}
          aria-describedby={partialSelection ? guidanceId : undefined}
          onChange={(event) => {
            const next = event.target.value;
            setLocationId(next);
            if (!next) setDivisionId("");
          }}
        >
          <option value="">Not Mapped</option>
          {locations.map((location) => <option key={location.id} value={location.id}>{location.display_name}</option>)}
        </select>
      </label>
      <label>
        <span>Division</span>
        <select
          name="divisionId"
          value={divisionId}
          disabled={disabled}
          required={Boolean(locationId)}
          aria-invalid={partialSelection}
          aria-describedby={partialSelection ? guidanceId : undefined}
          onChange={(event) => {
            const next = event.target.value;
            setDivisionId(next);
            if (!next) setLocationId("");
          }}
        >
          <option value="">Not Mapped</option>
          {divisions.map((division) => <option key={division.id} value={division.id}>{division.name}</option>)}
        </select>
      </label>
      <small id={guidanceId} className={partialSelection ? "production-field-error" : "sr-only"}>
        {partialSelection ? "Choose both a location and division, or leave both as Not Mapped." : "Location and division are paired."}
      </small>
    </div>
  );
}

function BulkBusinessUnitMappingWorkflow({
  connection,
  revision,
  units,
  locations,
  divisions,
  mappings,
}: {
  connection: ServiceTitanConnection;
  revision: string;
  units: ServiceTitanBusinessUnit[];
  locations: TenantLocation[];
  divisions: OrganizationDivision[];
  mappings: ServiceTitanBusinessUnitMapping[];
}) {
  const [payload, setPayload] = useState("");
  const [fileStatus, setFileStatus] = useState("No completed mapping file loaded.");
  const expectedProviderIds = new Set(units.map((unit) => unit.provider_business_unit_id));
  const mappingByProviderId = new Map(mappings.map((mapping) => [mapping.provider_business_unit_id, mapping]));

  const downloadTemplate = () => {
    const template = {
      format: "gm-intelligence-business-unit-mappings-v1",
      connectionId: connection.id,
      discoveryRevision: revision,
      instructions: "For every row, supply both locationId and divisionId, or leave both empty for Not Mapped. Do not add, remove, or duplicate rows.",
      allowedLocations: locations.map((location) => ({ id: location.id, name: location.display_name })),
      allowedDivisions: divisions.map((division) => ({ id: division.id, name: division.name })),
      mappings: units.map((unit) => {
        const mapping = mappingByProviderId.get(unit.provider_business_unit_id);
        return {
          providerBusinessUnitId: unit.provider_business_unit_id,
          businessUnitName: unit.name,
          locationId: mapping?.location_id ?? "",
          divisionId: mapping?.division_id ?? "",
        };
      }),
    };
    const blob = new Blob([JSON.stringify(template, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${connection.display_name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-business-unit-mappings.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const loadFile = async (file: File | undefined) => {
    setPayload("");
    if (!file) {
      setFileStatus("No completed mapping file loaded.");
      return;
    }
    if (file.size > 8_000_000) {
      setFileStatus("File rejected: the 8 MB safety limit was exceeded.");
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const candidate = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null && "mappings" in parsed
          ? parsed.mappings
          : null;
      if (!Array.isArray(candidate) || candidate.length !== units.length) throw new Error("inventory mismatch");
      const seen = new Set<string>();
      const normalized = candidate.map((item) => {
        if (typeof item !== "object" || item === null) throw new Error("row shape");
        const providerBusinessUnitId = "providerBusinessUnitId" in item ? String(item.providerBusinessUnitId) : "";
        const locationId = "locationId" in item ? String(item.locationId).trim() : "";
        const divisionId = "divisionId" in item ? String(item.divisionId).trim() : "";
        if (!expectedProviderIds.has(providerBusinessUnitId) || seen.has(providerBusinessUnitId)) throw new Error("provider mismatch");
        if (Boolean(locationId) !== Boolean(divisionId)) throw new Error("partial pair");
        seen.add(providerBusinessUnitId);
        return { providerBusinessUnitId, locationId, divisionId };
      });
      if (seen.size !== expectedProviderIds.size) throw new Error("inventory mismatch");
      setPayload(JSON.stringify(normalized));
      setFileStatus(`${normalized.length.toLocaleString()} reviewed rows loaded. Review and confirm to replace the complete mapping set.`);
    } catch {
      setFileStatus("File rejected: use the current downloaded template, preserve every row, and pair every location with a division.");
    }
  };

  return (
    <div className="production-bulk-mapping" role="group" aria-label="Governed bulk business-unit mapping">
      <p>This inventory exceeds the interactive mapper limit. Download the revision-pinned JSON template, complete every row, then upload that same complete inventory.</p>
      <div className="production-action-row">
        <button type="button" className="button ghost" onClick={downloadTemplate}>Download current mapping template</button>
        <label>
          <span>Completed JSON mapping file</span>
          <input type="file" accept="application/json,.json" onChange={(event) => void loadFile(event.target.files?.[0])} />
        </label>
      </div>
      <input type="hidden" name="bulkMappings" value={payload} />
      <p className="production-inline-guidance" role="status">{fileStatus}</p>
      <div className="production-form-footer">
        <span>Saving replaces every current mapping for this connection. Empty pairs remain Not Mapped.</span>
        <ConfirmAction
          pendingLabel="Updating bulk mappings…"
          title={`Replace all ${connection.display_name} business-unit mappings from this file?`}
          consequence="The uploaded revision-pinned inventory will replace every active mapping for this connection. Rows with empty pairs will be Not Mapped."
          confirmLabel="Replace mappings from file"
          disabled={!payload}
        >Review bulk mapping changes</ConfirmAction>
      </div>
    </div>
  );
}

function ServiceTitanMappingConfiguration({ tenant, connection }: { tenant: ProductionTenantContext; connection: ServiceTitanConnection }) {
  const admin = tenant.adminConfiguration;
  const [mappingState, mappingAction] = useActionState(replaceBusinessUnitMappingsAction, INITIAL_ADMIN_ACTION_STATE);
  const guidanceId = useId();
  if (!admin || connection.status === "disabled" || connection.status === "archived") return null;

  const successfulRun = connection.status === "ready" ? latestSuccessfulDiscovery(admin, connection.id) : undefined;
  const revision = successfulRun?.discovery_revision ?? null;
  const units = revision
    ? admin.businessUnits.filter((unit) =>
        unit.connection_id === connection.id &&
        unit.discovery_revision === revision &&
        unit.active,
      )
    : [];
  const activeDivisions = admin.divisions
    .filter((division) => division.status === "active")
    .sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name));
  const activeDivisionIds = new Set(activeDivisions.map((division) => division.id));
  const activeAssignments = new Set(activeAssignedLocationIds(tenant, connection.id));
  const assignedLocations = tenant.locations.filter((location) =>
    location.status === "active" && activeAssignments.has(location.id),
  );
  const assignedLocationIds = new Set(assignedLocations.map((location) => location.id));
  const mappingByProviderId = new Map(
    admin.businessUnitMappings
      .filter((mapping) =>
        mapping.connection_id === connection.id &&
        mapping.discovery_revision === revision &&
        mapping.revoked_at === null,
      )
      .map((mapping) => [mapping.provider_business_unit_id, mapping]),
  );
  const readiness = revision
    ? getBusinessUnitMappingReadiness({
        connectionId: connection.id,
        discoveryRevision: revision,
        businessUnits: admin.businessUnits,
        divisions: admin.divisions,
        activeAssignedLocationIds: assignedLocationIds,
        mappings: admin.businessUnitMappings,
      })
    : mappingReadinessForConnection(admin, tenant, connection);
  const divisionsAvailable = activeDivisions.length > 0;
  const locationsAvailable = assignedLocations.length > 0;
  const mappingUiTooLarge = units.length > MAPPING_UI_MAX_BUSINESS_UNITS;
  const canEditMappings = Boolean(revision && units.length > 0 && !mappingUiTooLarge && divisionsAvailable && locationsAvailable);
  const statusLabel = !divisionsAvailable
    ? "Division required"
    : !revision
      ? "Discovery required"
      : mappingUiTooLarge
      ? "Bulk mapping required"
      : readiness.complete
      ? "Complete"
      : `${readiness.mappedBusinessUnitCount} of ${readiness.activeBusinessUnitCount} mapped`;

  return (
    <section className="production-connection-config" aria-label={`${connection.display_name} business-unit mapping`}>
      <form
        action={mappingAction}
        className={`production-config-step ${!divisionsAvailable ? "is-unavailable" : ""}`}
        aria-disabled={!divisionsAvailable || undefined}
        aria-describedby={!divisionsAvailable ? guidanceId : undefined}
      >
        <input type="hidden" name="connectionId" value={connection.id} />
        <input type="hidden" name="discoveryRevision" value={revision ?? ""} />
        <input type="hidden" name="confirmMappings" value="yes" />
        <div className="production-config-step-heading">
          <span aria-hidden="true">6</span>
          <div>
            <h3>Map {connection.display_name} business units</h3>
            <p>Connect each active business unit from the latest successful discovery to an assigned location and active division.</p>
          </div>
          <b>{statusLabel}</b>
        </div>
        {!divisionsAvailable ? (
          <div id={guidanceId} className="production-empty compact" role="status">
            Mapping is unavailable because this organization has no active divisions. Create or restore a division in step 5; archived divisions preserve history and cannot be selected. “Not Mapped” represents no saved mapping and is never a division.
            {!revision ? " Run business-unit discovery for this connection as well." : ""}
          </div>
        ) : revision && mappingUiTooLarge ? (
        <BulkBusinessUnitMappingWorkflow
          connection={connection}
          revision={revision}
          units={units}
          locations={assignedLocations}
          divisions={activeDivisions}
          mappings={admin.businessUnitMappings.filter((mapping) =>
            mapping.connection_id === connection.id &&
            mapping.discovery_revision === revision &&
            mapping.revoked_at === null,
          )}
        />
      ) : revision && units.length > 0 ? (
          <>
            {!locationsAvailable ? (
              <p className="production-inline-guidance" role="status">Assign at least one active location to this connection in step 3 before saving mappings.</p>
            ) : null}
            <div className="production-mapping-list">
              {units.map((unit) => {
                const mapping = mappingByProviderId.get(unit.provider_business_unit_id);
                const currentMapping = mapping &&
                  assignedLocationIds.has(mapping.location_id) &&
                  activeDivisionIds.has(mapping.division_id)
                  ? mapping
                  : undefined;
                return (
                  <BusinessUnitMappingRow
                    key={`${unit.provider_business_unit_id}:${currentMapping?.id ?? "not-mapped"}:${currentMapping?.location_id ?? ""}:${currentMapping?.division_id ?? ""}`}
                    unit={unit}
                    mapping={currentMapping}
                    locations={assignedLocations}
                    divisions={activeDivisions}
                    disabled={!locationsAvailable}
                  />
                );
              })}
            </div>
            <div className="production-form-footer">
              <span>“Not Mapped” leaves the business unit without a saved location or division mapping. Saving replaces every mapping from this discovery result.</span>
              <ConfirmAction
                pendingLabel="Updating mappings…"
                title={`Replace all ${connection.display_name} business-unit mappings?`}
                consequence="The submitted rows will replace every active mapping for this connection. Rows left Not Mapped will no longer contribute a location or division mapping."
                confirmLabel="Replace mappings"
                disabled={!canEditMappings}
              >Review mapping changes</ConfirmAction>
            </div>
          </>
        ) : (
          <div className="production-empty compact">Run business-unit discovery before mapping. Only active units from the latest successful discovery can be mapped.</div>
        )}
        <ActionNotice state={mappingState} />
      </form>
    </section>
  );
}

function ServiceTitanProcess({ tenant }: { tenant: ProductionTenantContext }) {
  const admin = tenant.adminConfiguration;
  const enabledConnections = tenant.connections.filter((connection) => connection.status !== "disabled" && connection.status !== "archived");
  const activeDivisionCount = admin?.divisions.filter((division) => division.status === "active").length ?? 0;
  const connectionStates = enabledConnections.map((connection) => {
    const readiness = admin ? mappingReadinessForConnection(admin, tenant, connection) : null;
    return {
      validated: connection.status === "ready" && Boolean(connection.last_validated_at),
      assigned: activeAssignedLocationIds(tenant, connection.id).length > 0,
      discovered: (readiness?.activeBusinessUnitCount ?? 0) > 0,
      mapped: readiness?.complete ?? false,
    };
  });
  const total = connectionStates.length;
  const completeCount = (key: "validated" | "assigned" | "discovered" | "mapped") =>
    connectionStates.filter((state) => state[key]).length;
  const allComplete = (key: "validated" | "assigned" | "discovered" | "mapped") =>
    total > 0 && connectionStates.every((state) => state[key]);
  const stages = [
    { number: 1, label: "Add credentials", detail: total ? `${total} enabled connection${total === 1 ? "" : "s"}` : "Available below", complete: total > 0 },
    { number: 2, label: "Validate access", detail: `${completeCount("validated")}/${total} connections`, complete: allComplete("validated") },
    { number: 3, label: "Assign locations", detail: `${completeCount("assigned")}/${total} connections`, complete: allComplete("assigned") },
    { number: 4, label: "Discover business units", detail: `${completeCount("discovered")}/${total} connections`, complete: allComplete("discovered") },
    { number: 5, label: "Create divisions", detail: activeDivisionCount ? `${activeDivisionCount} active organization division${activeDivisionCount === 1 ? "" : "s"}` : "At least one active division required", complete: activeDivisionCount > 0 },
    { number: 6, label: "Map business units", detail: `${completeCount("mapped")}/${total} connections`, complete: allComplete("mapped") },
  ];
  return (
    <section className="production-section production-process" aria-labelledby="servicetitan-process-title">
      <div className="production-section-title"><div><span>Connection process</span><h2 id="servicetitan-process-title">Six clear steps to a mapped connection</h2></div></div>
      <ol>
        {stages.map((stage) => (
          <li key={stage.number} className={stage.complete ? "complete" : "incomplete"}>
            <span aria-hidden="true">{stage.complete ? "✓" : stage.number}</span>
            <div><strong>{stage.label}</strong><small>{stage.detail}</small><span className="sr-only">Status: {stage.complete ? "complete" : "not complete"}</span></div>
            <b>{stage.complete ? "Complete" : "Not complete"}</b>
          </li>
        ))}
      </ol>
      <p className="production-process-note"><strong>Secure by design:</strong> validation and discovery execute on the server. Credentials, access tokens, and raw provider responses never reach the browser.</p>
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
  const enabledConnections = tenant.connections.filter((connection) => connection.status !== "disabled" && connection.status !== "archived");
  const mappingReadiness = admin
    ? enabledConnections.map((connection) => mappingReadinessForConnection(admin, tenant, connection))
    : [];
  const discoveredBusinessUnitCount = mappingReadiness.reduce((total, readiness) => total + readiness.activeBusinessUnitCount, 0);
  const mappedBusinessUnitCount = mappingReadiness.reduce((total, readiness) => total + readiness.mappedBusinessUnitCount, 0);
  const activeDivisionCount = admin?.divisions.filter((division) => division.status === "active").length ?? 0;
  const exactMappingComplete =
    enabledConnections.length > 0 &&
    mappingReadiness.length === enabledConnections.length &&
    mappingReadiness.every((readiness) => readiness.complete);
  const milestones = getAdminSetupMilestones({
    activeLocationCount: tenant.readiness.activeLocationCount,
    enabledConnectionCount: tenant.readiness.enabledConnectionCount,
    hasValidatedConnection: tenant.readiness.hasValidatedConnection,
    assignedActiveLocationCount: tenant.readiness.assignedActiveLocationCount,
    discoveredBusinessUnitCount,
    activeDivisionCount,
    mappedBusinessUnitCount,
  }).map((milestone) => milestone.id === "mappings" ? { ...milestone, complete: exactMappingComplete } : milestone);
  const completeCount = milestones.filter((milestone) => milestone.complete).length;
  const details = [
    { id: "locations", title: "Add an operating location", detail: tenant.readiness.activeLocationCount ? `${tenant.readiness.activeLocationCount} active location${tenant.readiness.activeLocationCount === 1 ? "" : "s"}` : "No active locations", section: "organization" as const },
    { id: "credentials", title: "Add ServiceTitan credentials", detail: tenant.readiness.enabledConnectionCount ? `${tenant.readiness.enabledConnectionCount} enabled connection${tenant.readiness.enabledConnectionCount === 1 ? "" : "s"}` : "No enabled connections", section: "connections" as const },
    { id: "validation", title: "Validate ServiceTitan access", detail: tenant.readiness.hasValidatedConnection ? "A validated connection is ready" : "Run secure validation from ServiceTitan setup", section: "connections" as const },
    { id: "assignments", title: "Assign locations", detail: tenant.readiness.assignedActiveLocationCount ? `${tenant.readiness.assignedActiveLocationCount} assigned active location${tenant.readiness.assignedActiveLocationCount === 1 ? "" : "s"}` : "No active locations assigned", section: "connections" as const },
    { id: "discovery", title: "Discover business units", detail: discoveredBusinessUnitCount ? `${discoveredBusinessUnitCount} active business unit${discoveredBusinessUnitCount === 1 ? "" : "s"} in latest successful discoveries` : "No active business units in a successful discovery", section: "connections" as const },
    { id: "divisions", title: "Create your divisions", detail: activeDivisionCount ? `${activeDivisionCount} active division${activeDivisionCount === 1 ? "" : "s"}` : "At least one active division is required", section: "connections" as const },
    { id: "mappings", title: "Map business units", detail: discoveredBusinessUnitCount ? `${mappedBusinessUnitCount} of ${discoveredBusinessUnitCount} latest-discovery business unit${discoveredBusinessUnitCount === 1 ? "" : "s"} mapped exactly once` : "No current discovery available to map", section: "connections" as const },
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
                  <div><strong>{detail.title}</strong><small>{detail.detail}</small><span className="sr-only">Status: {milestone?.complete ? "complete" : "not complete"}</span></div>
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
  const groups = ["Get started", "Manage performance", "Govern workspace"] as const;
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
  settingsWorkspace,
}: {
  tenant: ProductionTenantContext;
  mode: "staging" | "production";
  initialSection?: ProductionAdminSection;
  settingsWorkspace: ProductionAdminSettingsWorkspace;
}) {
  const [section, navigate] = usePersistedAdminSection(initialSection);
  const selectedSection = PRODUCTION_ADMIN_SECTIONS.find((item) => item.id === section) ?? PRODUCTION_ADMIN_SECTIONS[0];

  return (
    <>
      <a className="skip-link" href="#admin-main">Skip to Admin Center content</a>
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
      <main id="admin-main" className="production-shell production-page production-admin-page">
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
                  <div className="production-section-title"><div><span>Connection records · steps 2–4</span><h2 id="connections-list-title">Manage existing connections</h2></div><strong>{tenant.connections.length}</strong></div>
                  <div className="production-record-list">
                    {tenant.connections.length ? tenant.connections.map((connection) => (
                      <div key={connection.id} className="production-connection-bundle">
                        <ConnectionRecord connection={connection} assignments={tenant.assignments} locations={tenant.locations} />
                        <ServiceTitanConnectionConfiguration tenant={tenant} connection={connection} />
                      </div>
                    )) : <div className="production-empty">No ServiceTitan connections have been added.</div>}
                  </div>
                </section>
                <DivisionManager tenant={tenant} />
                <section className="production-section production-connections-list production-mapping-panels" aria-labelledby="mapping-panels-title">
                  <div className="production-section-title">
                    <div><span>Step 6</span><h2 id="mapping-panels-title">Business-unit mapping by connection</h2></div>
                    <strong>{tenant.connections.filter((connection) => connection.status !== "disabled" && connection.status !== "archived").length}</strong>
                  </div>
                  <p className="production-section-intro">Review the latest successful discovery for each enabled connection. Every active business unit must have exactly one current location-and-division mapping for setup to be complete.</p>
                  <div className="production-record-list">
                    {tenant.connections.some((connection) => connection.status !== "disabled" && connection.status !== "archived")
                      ? tenant.connections
                          .filter((connection) => connection.status !== "disabled" && connection.status !== "archived")
                          .map((connection) => (
                            <div key={connection.id} className="production-connection-bundle">
                              <ServiceTitanMappingConfiguration tenant={tenant} connection={connection} />
                            </div>
                          ))
                      : <div className="production-empty">Add an enabled ServiceTitan connection before mapping business units.</div>}
                  </div>
                </section>
              </>
            ) : null}

            {section === "kpis" ? <OriginalKpiCatalogManager tenant={tenant} /> : null}
            {section === "sources" ? <ProductionDataSourcesSettings tenant={tenant} workspace={settingsWorkspace} /> : null}
            {section === "targets" ? <ProductionTargetsBudgetsSettings tenant={tenant} workspace={settingsWorkspace} /> : null}
            {section === "layouts" ? <ProductionLayoutsAccessSettings tenant={tenant} workspace={settingsWorkspace} /> : null}
          </div>
        </div>
      </main>
    </>
  );
}
