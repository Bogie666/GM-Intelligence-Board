"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import type { AdminActionState } from "@/app/admin/actions";
import { generateCatalogBindingsAction } from "@/app/admin/actions";
import {
  assignProfileLayoutAction,
  registerReportSourceAction,
  saveKpiBindingAction,
  saveKpiTargetAction,
} from "@/app/admin/settings-actions";
import type { ProductionTenantContext } from "@/lib/tenant-context";
import {
  profileDisplayName,
  type EndpointRecipePolicy,
  type ProductionAdminSettingsWorkspace,
  type ProductionKpiTarget,
} from "@/lib/production-admin-settings";
import { serviceTitanEndpointRecipes } from "@/lib/service-titan-sources";
import { ProductionAdditionalDataSources } from "@/components/production-additional-data-sources";


const INITIAL: AdminActionState = { status: "idle", message: "" };

function Submit({ children, disabled = false }: { children: React.ReactNode; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return <button className="button primary" type="submit" disabled={pending || disabled}>{pending ? "Saving…" : children}</button>;
}

function Notice({ state }: { state: AdminActionState }) {
  if (state.status === "idle") return null;
  return (
    <div className={`production-notice ${state.status}`} role={state.status === "error" ? "alert" : "status"}>
      {state.message}
      {state.fieldErrors ? <ul>{Object.entries(state.fieldErrors).map(([field, message]) => <li key={field}><strong>{field}:</strong> {message}</li>)}</ul> : null}
    </div>
  );
}

function WorkspaceWarnings({ workspace, area }: { workspace: ProductionAdminSettingsWorkspace; area: string[] }) {
  const warnings = workspace.warnings.filter((warning) => area.includes(warning.area));
  return warnings.length ? (
    <div className="production-notice error" role="alert">
      Some records are unavailable. Empty lists below must not be interpreted as proof that no records exist.
      <ul>{warnings.map((warning) => <li key={warning.area}>{warning.message}</li>)}</ul>
    </div>
  ) : null;
}


function CatalogBindingGenerator({ workspace }: { workspace: ProductionAdminSettingsWorkspace }) {
  const [state, action] = useActionState(generateCatalogBindingsAction, INITIAL);
  const wiredRecipeIds = new Set(serviceTitanEndpointRecipes.map((recipe) => recipe.id));
  const wiredKpiCount = workspace.kpiDefinitions.filter((definition) => {
    const recipeId = definition.external_source?.endpointRecipeId;
    return typeof recipeId === "string" && wiredRecipeIds.has(recipeId);
  }).length;
  return (
    <section className="production-section">
      <div className="production-section-title"><div><span>One-click draft coverage</span><h2>Generate bindings for enabled KPIs</h2></div><strong>{wiredKpiCount}</strong></div>
      <p className="production-muted-copy">
        Creates a draft endpoint-recipe binding for every enabled original-catalog KPI that has a wired recipe, across every active
        location assigned to a validated connection. Existing bindings are never modified. Drafts remain non-ingestible until a trusted
        operator approves each one with a live sample (<code>npm run data-source:approve</code>).
      </p>
      <form action={action} className="production-form-grid">
        <input type="hidden" name="confirmGeneration" value="yes" />
        <div className="production-form-footer">
          <span>{wiredKpiCount === 0 ? "No enabled KPI currently carries a wired endpoint recipe. Enable catalog KPIs first." : `${wiredKpiCount} enabled KPI${wiredKpiCount === 1 ? " carries" : "s carry"} a wired endpoint recipe.`}</span>
          <Submit disabled={wiredKpiCount === 0}>Generate draft bindings</Submit>
        </div>
      </form>
      <Notice state={state} />
    </section>
  );
}

function SourceBindingForm({ tenant, workspace }: { tenant: ProductionTenantContext; workspace: ProductionAdminSettingsWorkspace }) {
  const [state, action] = useActionState(saveKpiBindingAction, INITIAL);
  const [kpiId, setKpiId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [reportId, setReportId] = useState("");
  const [reduction, setReduction] = useState("sum");
  const activeLocations = tenant.locations.filter((location) => location.status === "active");
  const assignedConnectionIds = new Set(tenant.assignments
    .filter((assignment) => assignment.location_id === locationId && assignment.revoked_at === null)
    .map((assignment) => assignment.connection_id));
  const availableConnections = tenant.connections.filter((connection) =>
    connection.status === "ready" && assignedConnectionIds.has(connection.id));
  const eligibleReports = workspace.reportSources.filter((report) =>
    report.status === "active" && report.lifecycle !== "archived" && report.connection_id === connectionId);
  const selectedReport = eligibleReports.find((report) => report.id === reportId);
  const numericFields = (selectedReport?.fields ?? []).flatMap((field) => {
    if (!field || typeof field !== "object") return [];
    const value = field as Record<string, unknown>;
    return value.type === "number" && typeof value.name === "string" ? [value.name] : [];
  });
  const requiredParameters = (selectedReport?.parameters ?? []).flatMap((parameter) => {
    if (!parameter || typeof parameter !== "object") return [];
    const value = parameter as Record<string, unknown>;
    return value.isRequired === true && typeof value.name === "string" ? [value.name] : [];
  });
  const defaultParameters = Object.fromEntries(requiredParameters.map((name) => [name,
    /(^|\b)(to|end)/i.test(name) ? "$periodEndDate" : "$periodStartDate"]));
  const existingBinding = workspace.bindings.find((binding) => binding.kpi_definition_id === kpiId && binding.location_id === locationId);
  const immutableExisting = existingBinding?.approval_status === "approved" || existingBinding?.approval_status === "archived";

  return (
    <section className="production-panel">
      <div className="production-panel-heading"><div><span>Exact-location contract</span><h2>Create a draft report binding</h2></div></div>
      <p className="production-boundary-note">Active declared, inspected, or approved reports can be configured as draft bindings. Ingestion remains impossible until the trusted sample and reconciliation workflow atomically approves both contracts.</p>
      <form action={action} className="production-form-grid">
        <input type="hidden" name="sourceMethod" value="saved_report" />
        <label>Published ServiceTitan KPI<select name="kpiDefinitionId" required value={kpiId} onChange={(event) => setKpiId(event.target.value)}><option value="" disabled>Choose KPI</option>{workspace.kpiDefinitions.filter((definition) => definition.type === "service_titan").map((definition) => <option key={definition.id} value={definition.id}>{definition.title} · {definition.kpi_key} v{definition.version}</option>)}</select></label>
        <label>Active location<select name="locationId" required value={locationId} onChange={(event) => { setLocationId(event.target.value); setConnectionId(""); setReportId(""); }}><option value="" disabled>Choose location</option>{activeLocations.map((location) => <option key={location.id} value={location.id}>{location.display_name}</option>)}</select></label>
        <label>Validated assigned connection<select name="connectionId" required value={connectionId} onChange={(event) => { setConnectionId(event.target.value); setReportId(""); }} disabled={!locationId}><option value="">{locationId ? "Choose connection" : "Choose a location first"}</option>{availableConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.display_name} · {connection.service_titan_tenant_id}</option>)}</select></label>
        <label>Active saved report<select name="reportSourceId" required value={reportId} onChange={(event) => setReportId(event.target.value)} disabled={!connectionId}><option value="">{connectionId ? "Choose report" : "Choose a connection first"}</option>{eligibleReports.map((report) => <option key={report.id} value={report.id}>{report.name} · {report.lifecycle}</option>)}</select></label>
        <label>Refresh cadence<select name="refreshInterval" defaultValue="24h"><option value="4h">Every 4 hours</option><option value="12h">Every 12 hours</option><option value="24h">Every 24 hours</option></select></label>
        <label>Reduction<select name="reportReduction" value={reduction} onChange={(event) => setReduction(event.target.value)}><option value="sum">Sum</option><option value="average">Average</option><option value="count">Count rows</option><option value="ratio">Ratio</option></select></label>
        {reduction !== "count" && reduction !== "ratio" ? <label>Numeric value field<select key={`${reportId}:${reduction}`} name="valueField" required defaultValue=""><option value="" disabled>Choose field</option>{numericFields.map((field) => <option key={field} value={field}>{field}</option>)}</select></label> : <input type="hidden" name="valueField" value="" />}
        {reduction === "ratio" ? <><label>Numerator field<select name="numeratorField" required defaultValue=""><option value="" disabled>Choose numerator</option>{numericFields.map((field) => <option key={field} value={field}>{field}</option>)}</select></label><label>Denominator field<select name="denominatorField" required defaultValue=""><option value="" disabled>Choose denominator</option>{numericFields.map((field) => <option key={field} value={field}>{field}</option>)}</select></label></> : <><input type="hidden" name="numeratorField" value="" /><input type="hidden" name="denominatorField" value="" /></>}
        <label className="span-two">Required report parameters (JSON object)<textarea key={reportId} name="parameterValues" rows={3} defaultValue={JSON.stringify(defaultParameters, null, 2)} spellCheck={false} aria-describedby="binding-parameter-help" /></label>
        <p id="binding-parameter-help" className="production-inline-guidance span-two">Required names are populated from the declared report contract. Period placeholders are resolved by the worker at governance and ingestion time.</p>
        <input type="hidden" name="businessUnitMappings" value="{}" />
        {existingBinding ? immutableExisting
          ? <div className="production-notice error span-two" role="alert">The existing {existingBinding.approval_status} binding is immutable. Choose another KPI or location; it cannot be replaced with a draft.</div>
          : <label className="production-checkbox-row span-two"><input type="checkbox" name="confirmReplacement" value="replace" required /><span><strong>Replace existing {existingBinding.approval_status} binding</strong><small>This replaces binding {existingBinding.id} for the same KPI and location with a new draft.</small></span></label>
          : null}
        <div className="production-form-footer"><span>Saving creates a draft exact-location binding. A governed evidence review is required before ingestion.</span><Submit disabled={immutableExisting}>Save draft binding</Submit></div>
      </form>
      <Notice state={state} />
    </section>
  );
}

function ReportSourceForm({ tenant }: { tenant: ProductionTenantContext }) {
  const [state, action] = useActionState(registerReportSourceAction, INITIAL);
  const connections = tenant.connections.filter((connection) => connection.status !== "archived" && connection.status !== "disabled");
  return (
    <section className="production-panel">
      <div className="production-panel-heading"><div><span>Credential-free declaration</span><h2>Register a saved report</h2></div></div>
      <p className="production-boundary-note">This action registers provider identity and schema only. Never paste credentials in report fields or parameters. Inspection, evidence capture, reconciliation, and approval are trusted-worker steps.</p>
      <form action={action} className="production-form-grid">
        <label>Connection<select name="connectionId" required defaultValue=""><option value="" disabled>Choose connection</option>{connections.map((connection) => <option value={connection.id} key={connection.id}>{connection.display_name} · {connection.service_titan_tenant_id}</option>)}</select></label>
        <label>Category ID<input name="categoryId" required maxLength={128} /></label>
        <label>Report ID<input name="reportId" required maxLength={128} /></label>
        <label>Provider owner ID<input name="ownerExternalId" required maxLength={160} /></label>
        <label>Owner display name<input name="ownerDisplayName" required maxLength={160} /></label>
        <label>Report name<input name="name" required maxLength={200} /></label>
        <label>Provider modified at<input name="providerModifiedAt" type="datetime-local" required /></label>
        <label>Description<input name="description" maxLength={500} /></label>
        <label className="span-two">Parameters (JSON array)<textarea name="parameters" rows={4} defaultValue={'[{"name":"From","label":"From","dataType":"Date","isArray":false,"isRequired":true},{"name":"To","label":"To","dataType":"Date","isArray":false,"isRequired":true}]'} spellCheck={false} /></label>
        <label className="span-two">Fields (JSON array)<textarea name="fields" rows={4} defaultValue={'[{"name":"Value","label":"Value","type":"number"}]'} spellCheck={false} /></label>
        <div className="production-form-footer"><span>The canonical source fingerprint is generated by a database trigger from this contract.</span><Submit>Register declared source</Submit></div>
      </form>
      <Notice state={state} />
    </section>
  );
}

export function ProductionDataSourcesSettings({ tenant, workspace }: { tenant: ProductionTenantContext; workspace: ProductionAdminSettingsWorkspace }) {
  const recipeGroups = new Map<string, EndpointRecipePolicy[]>();
  workspace.endpointRecipes.forEach((policy) => {
    const key = `${policy.endpoint_recipe_id}:${policy.endpoint_recipe_version}`;
    recipeGroups.set(key, [...(recipeGroups.get(key) ?? []), policy]);
  });
  const definitionName = new Map(workspace.kpiDefinitions.map((definition) => [definition.id, definition.title]));
  const locationName = new Map(tenant.locations.map((location) => [location.id, location.display_name]));
  const dataSourceAreas = new Set(["Endpoint recipes", "Saved report sources", "Custom endpoint sources", "Domo connections", "Domo dataset sources", "Published KPI definitions", "KPI bindings"]);
  const dataSourceControlsUnavailable = workspace.warnings.some((warning) => dataSourceAreas.has(warning.area));

  return (
    <>
      <WorkspaceWarnings workspace={workspace} area={["Endpoint recipes", "Saved report sources", "Custom endpoint sources", "Domo connections", "Domo dataset sources", "Published KPI definitions", "KPI bindings"]} />
      <section className="production-section">
        <div className="production-section-title"><div><span>Migration-approved contracts</span><h2>Endpoint recipes</h2></div><strong>{recipeGroups.size}</strong></div>
        <p className="production-muted-copy">Recipes are application-owned and can only be added or versioned by a reviewed migration. They remain visible as the governed catalog and are eligible for exact-location draft bindings only at a migration-approved refresh cadence.</p>
        <div className="production-record-list">{[...recipeGroups.entries()].map(([key, policies]) => {
          const catalog = serviceTitanEndpointRecipes.find((recipe) => recipe.id === policies[0].endpoint_recipe_id && recipe.version === policies[0].endpoint_recipe_version);
          return <article className="production-record" key={key}><div className="production-record-heading"><div><strong>{catalog?.name ?? policies[0].endpoint_recipe_id}</strong><span>{policies[0].endpoint_recipe_id} · version {policies[0].endpoint_recipe_version}</span></div><span className="production-status ready">approved</span></div><p>{catalog?.description ?? "Migration-owned ServiceTitan recipe contract."}</p><small>Allowed cadence: {policies.map((policy) => policy.refresh_interval).join(", ")}</small></article>;
        })}{recipeGroups.size === 0 ? <div className="production-empty">No approved recipe policy was returned.</div> : null}</div>
      </section>
      {dataSourceControlsUnavailable ? (
        <section className="production-section"><div className="production-notice error" role="alert"><strong>Data-source mutations are temporarily unavailable.</strong><p>At least one governed registry failed to load. Creation, replacement, validation, archive, disable, and approval controls are hidden until the complete tenant workspace can be reloaded.</p></div></section>
      ) : <ReportSourceForm tenant={tenant} />}
      <section className="production-section">
        <div className="production-section-title"><div><span>Tenant registry</span><h2>Saved report sources</h2></div><strong>{workspace.reportSources.length}</strong></div>
        <p className="production-muted-copy">Registration creates a governed declaration. Approval requires a live sample plus reconciliation to an independently sourced reference value; the trusted operator command records both proofs without exposing credentials to the browser.</p>
        <div className="production-record-list">
          {workspace.reportSources.map((report) => (
            <article className="production-record" key={report.id}>
              <div className="production-record-heading"><div><strong>{report.name}</strong><span>{report.category_id} / {report.report_id} · {report.owner_display_name}</span></div><span className={`production-status ${report.lifecycle}`}>{report.lifecycle}</span></div>
              <p>{report.description || "No report description."}</p>
              <small>{report.verification} · {report.fields.length} fields · expected schema {report.expected_schema_fingerprint.slice(0, 22)}…</small>
              {report.lifecycle !== "approved" ? <small>Governance pending · source ID <code>{report.id}</code></small> : <small>Sample and reconciliation evidence approved for the exact current fingerprint.</small>}
            </article>
          ))}
          {workspace.reportSources.length === 0 ? <div className="production-empty">No saved report source has been registered for this tenant.</div> : null}
        </div>
      </section>
      {!dataSourceControlsUnavailable ? <><CatalogBindingGenerator workspace={workspace} /><ProductionAdditionalDataSources tenant={tenant} workspace={workspace} /><SourceBindingForm tenant={tenant} workspace={workspace} /></> : null}
      <section className="production-section">
        <div className="production-section-title"><div><span>Exact-location registry</span><h2>KPI bindings</h2></div><strong>{workspace.bindings.length}</strong></div>
        <p className="production-muted-copy">Draft bindings are intentionally non-ingestible. Saved reports and endpoint recipes expose trusted operator handoffs; custom endpoint and Domo bindings use authenticated server-side reconciliation. Configured cadence indicates scheduler eligibility, not proof that an external scheduler is deployed.</p>
        <div className="production-record-list">
          {workspace.bindings.map((binding) => (
            <article className="production-record" key={binding.id}>
              <div className="production-record-heading"><div><strong>{definitionName.get(binding.kpi_definition_id) ?? binding.kpi_definition_id}</strong><span>{locationName.get(binding.location_id) ?? binding.location_id} · {binding.source_method ?? "unconfigured"}</span></div><span className={`production-status ${binding.approval_status}`}>{binding.approval_status}</span></div>
              <small>{binding.endpoint_recipe_id ? `${binding.endpoint_recipe_id} v${binding.endpoint_recipe_version}` : binding.report_source_id ?? binding.custom_endpoint_source_id ?? binding.domo_dataset_source_id ?? "No source"} · {binding.refresh_interval ?? "no cadence"}</small>
              {binding.source_method === "endpoint_recipe" && binding.approval_status !== "approved" && binding.approval_status !== "archived" ? (
                <details className="production-operator-handoff"><summary>Trusted endpoint-recipe approval command</summary><p>Run after obtaining an independent ServiceTitan reference value for one completed period. This executes the same governed recipe contract used by ingestion.</p><code>{`npm run data-source:approve -- --organization-id ${tenant.organization.id} --binding-id ${binding.id} --actor-profile-id ${tenant.user.id} --period-start PERIOD_START_ISO --period-end PERIOD_END_ISO --reference-value REFERENCE_VALUE --tolerance TOLERANCE --confirm ${tenant.organization.id}:${binding.id}:PERIOD_START_ISO`}</code></details>
              ) : null}
              {binding.source_method === "saved_report" && binding.approval_status !== "approved" && binding.approval_status !== "archived" ? (
                <details className="production-operator-handoff"><summary>Trusted approval command</summary><p>Run after obtaining an independent ServiceTitan reference value for one completed period.</p><code>{`npm run servicetitan:approve-report -- --organization-id ${tenant.organization.id} --binding-id ${binding.id} --actor-profile-id ${tenant.user.id} --period-start PERIOD_START_ISO --period-end PERIOD_END_ISO --reference-value REFERENCE_VALUE --tolerance TOLERANCE --confirm ${tenant.organization.id}:${binding.id}:PERIOD_START_ISO`}</code></details>
              ) : null}
            </article>
          ))}
          {workspace.bindings.length === 0 ? <div className="production-empty">No exact-location KPI bindings have been saved.</div> : null}
        </div>
      </section>
    </>
  );
}

function TargetForm({ tenant, workspace, target }: { tenant: ProductionTenantContext; workspace: ProductionAdminSettingsWorkspace; target?: ProductionKpiTarget }) {
  const [state, action] = useActionState(saveKpiTargetAction, INITIAL);
  const [selectedKpiId, setSelectedKpiId] = useState(target?.kpi_definition_id ?? "");
  const planningType = target?.dimensions?.planning_type === "budget" ? "budget" : "target";
  const note = typeof target?.dimensions?.note === "string" ? target.dimensions.note : "";
  const identityLocked = Boolean(target);
  const selectedDefinition = workspace.kpiDefinitions.find((definition) => definition.id === selectedKpiId);
  const valueKind = selectedDefinition?.value_kind?.replaceAll("_", " ") ?? "numeric";
  return (
    <form action={action} className="production-form-grid compact">
      {target ? <input type="hidden" name="targetId" value={target.id} /> : null}
      <label>Plan type<select name="planningType" defaultValue={planningType}><option value="target">KPI target</option><option value="budget">Budget-tagged KPI target</option></select></label>
      <label>Scope<select name="locationId" defaultValue={target?.location_id ?? ""} disabled={identityLocked}><option value="">Organization-wide</option>{tenant.locations.filter((location) => location.status === "active").map((location) => <option key={location.id} value={location.id}>{location.display_name}</option>)}</select>{identityLocked ? <input type="hidden" name="locationId" value={target?.location_id ?? ""} /> : null}</label>
      <label>Published KPI<select name="kpiDefinitionId" required value={selectedKpiId} disabled={identityLocked} onChange={(event) => setSelectedKpiId(event.target.value)}><option value="" disabled>Choose KPI</option>{workspace.kpiDefinitions.map((definition) => <option key={definition.id} value={definition.id}>{definition.title} · {definition.kpi_key}</option>)}</select>{identityLocked ? <input type="hidden" name="kpiDefinitionId" value={selectedKpiId} /> : null}</label>
      <label>Metric key<input name="metricKey" required value={selectedDefinition?.kpi_key ?? target?.metric_key ?? ""} readOnly aria-describedby="target-metric-help" /><small id="target-metric-help">Automatically set by the selected KPI definition.</small></label>
      <label>Target / budget value ({valueKind})<input name="targetValue" type="number" step="any" required defaultValue={target?.target_value ?? ""} /></label>
      <label>Warning threshold ({valueKind})<input name="warningValue" type="number" step="any" defaultValue={target?.warning_value ?? ""} /></label>
      <label>Effective from<input name="effectiveFrom" type="date" required defaultValue={target?.effective_from ?? ""} readOnly={identityLocked} /></label>
      <label>Effective to<input name="effectiveTo" type="date" defaultValue={target?.effective_to ?? ""} /></label>
      <label>Lifecycle<select name="lifecycle" defaultValue={target?.lifecycle === "published" ? "published" : "draft"}><option value="draft">Draft</option><option value="published">Published</option></select></label>
      <label>Planning note<input name="note" maxLength={500} defaultValue={note} /></label>
      <div className="production-form-footer"><span>{target?.lifecycle === "published" ? "Published rows are immutable; saving creates a new governed version." : "Publishing records the authenticated owner/admin as approver."}</span><Submit>{target ? "Save entry" : "Create entry"}</Submit></div>
      <div className="span-two"><Notice state={state} /></div>
    </form>
  );
}

export function ProductionTargetsBudgetsSettings({ tenant, workspace }: { tenant: ProductionTenantContext; workspace: ProductionAdminSettingsWorkspace }) {
  const locationName = new Map(tenant.locations.map((location) => [location.id, location.display_name]));
  return (
    <>
      <WorkspaceWarnings workspace={workspace} area={["Targets and budgets", "Published KPI definitions"]} />
      <section className="production-panel">
        <div className="production-panel-heading"><div><span>Effective-dated configuration</span><h2>Create target or budget entry</h2></div></div>
        <p className="production-boundary-note">The current schema stores both as governed KPI target rows. “Budget” is an explicit planning-type dimension, not a separate monthly budget model. No overlap prevention or budget approval capability beyond the target governance schema is claimed.</p>
        <TargetForm tenant={tenant} workspace={workspace} />
      </section>
      <section className="production-section">
        <div className="production-section-title"><div><span>Versioned tenant plan</span><h2>Targets & budget-tagged rows</h2></div><strong>{workspace.targets.length}</strong></div>
        <div className="production-record-list">{workspace.targets.map((target) => <article className="production-record" key={target.id}><div className="production-record-heading"><div><strong>{target.metric_key} · {target.target_value.toLocaleString()}</strong><span>{locationName.get(target.location_id ?? "") ?? "Organization-wide"} · {target.effective_from} to {target.effective_to ?? "open"} · v{target.version}</span></div><span className={`production-status ${target.lifecycle}`}>{target.lifecycle}</span></div><small>{target.dimensions?.planning_type === "budget" ? "Budget-tagged target" : "KPI target"}</small><details><summary>{target.lifecycle === "published" ? "Create successor version" : "Edit draft"}</summary><TargetForm tenant={tenant} workspace={workspace} target={target} /></details></article>)}{workspace.targets.length === 0 ? <div className="production-empty">No effective-dated target rows exist for this tenant.</div> : null}</div>
      </section>
    </>
  );
}

function LayoutAssignmentForm({ tenant, workspace }: { tenant: ProductionTenantContext; workspace: ProductionAdminSettingsWorkspace }) {
  const [state, action] = useActionState(assignProfileLayoutAction, INITIAL);
  const activeMembers = workspace.memberships.filter((membership) => membership.status === "active");
  const publishedTemplates = workspace.layoutTemplates.filter((template) => template.lifecycle === "published");
  return (
    <section className="production-panel">
      <div className="production-panel-heading"><div><span>Role-matched governed selection</span><h2>Select member layout</h2></div></div>
      <p className="production-boundary-note">This workflow selects an already-published template for an active member at one location. It cannot create roles, grant access, promote an administrator, or edit template JSON.</p>
      <form action={action} className="production-form-grid">
        <label>Active member<select name="profileId" required defaultValue=""><option value="" disabled>Choose member</option>{activeMembers.map((membership) => <option key={membership.id} value={membership.profile_id}>{profileDisplayName(membership)} · {membership.role.replaceAll("_", " ")}</option>)}</select></label>
        <label>Active location<select name="locationId" required defaultValue=""><option value="" disabled>Choose location</option>{tenant.locations.filter((location) => location.status === "active").map((location) => <option key={location.id} value={location.id}>{location.display_name}</option>)}</select></label>
        <label className="span-two">Published template<select name="templateId" required defaultValue=""><option value="" disabled>Choose role-matched template</option>{publishedTemplates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.audience_role.replaceAll("_", " ")} · v{template.version}</option>)}</select></label>
        <div className="production-form-footer"><span>The server rejects role/template mismatches; RLS and membership triggers recheck tenant identity.</span><Submit>Select layout</Submit></div>
      </form>
      <Notice state={state} />
    </section>
  );
}

export function ProductionLayoutsAccessSettings({ tenant, workspace }: { tenant: ProductionTenantContext; workspace: ProductionAdminSettingsWorkspace }) {
  const memberName = new Map(workspace.memberships.map((membership) => [membership.profile_id, profileDisplayName(membership)]));
  const locationName = new Map(tenant.locations.map((location) => [location.id, location.display_name]));
  const templateName = new Map(workspace.layoutTemplates.map((template) => [template.id, template.name]));
  return (
    <>
      <WorkspaceWarnings workspace={workspace} area={["Layout templates", "Profile layouts", "Access roles"]} />
      <section className="production-section">
        <div className="production-section-title"><div><span>Read-only authorization inventory</span><h2>Access roles</h2></div><strong>{workspace.memberships.length}</strong></div>
        <p className="production-muted-copy">Roles are displayed from tenant memberships. Role mutation is intentionally not exposed in this layout workflow, preventing it from becoming an access-escalation path.</p>
        <div className="production-record-list">{workspace.memberships.map((membership) => <article className="production-record" key={membership.id}><div className="production-record-heading"><div><strong>{profileDisplayName(membership)}</strong><span>{membership.profile_id}</span></div><span className={`production-status ${membership.status}`}>{membership.role.replaceAll("_", " ")} · {membership.status}</span></div></article>)}{workspace.memberships.length === 0 ? <div className="production-empty">No tenant membership records were returned.</div> : null}</div>
      </section>
      <section className="production-section">
        <div className="production-section-title"><div><span>Versioned presentation contracts</span><h2>Layout templates</h2></div><strong>{workspace.layoutTemplates.length}</strong></div>
        <div className="production-record-list">{workspace.layoutTemplates.map((template) => <article className="production-record" key={template.id}><div className="production-record-heading"><div><strong>{template.name}</strong><span>{template.template_key} · {template.audience_role.replaceAll("_", " ")} · v{template.version}</span></div><span className={`production-status ${template.lifecycle}`}>{template.lifecycle}</span></div><small>{Object.keys(template.layout).length} top-level layout properties</small></article>)}{workspace.layoutTemplates.length === 0 ? <div className="production-empty">No governed layout templates have been created.</div> : null}</div>
      </section>
      <LayoutAssignmentForm tenant={tenant} workspace={workspace} />
      <section className="production-section">
        <div className="production-section-title"><div><span>Cross-device selection</span><h2>Profile layouts</h2></div><strong>{workspace.profileLayouts.length}</strong></div>
        <div className="production-record-list">{workspace.profileLayouts.map((layout) => <article className="production-record" key={layout.id}><div className="production-record-heading"><div><strong>{memberName.get(layout.profile_id) ?? layout.profile_id}</strong><span>{locationName.get(layout.location_id) ?? layout.location_id}</span></div><span className="production-status ready">{templateName.get(layout.template_id) ?? layout.template_id}</span></div></article>)}{workspace.profileLayouts.length === 0 ? <div className="production-empty">No member/location layout selections exist.</div> : null}</div>
      </section>
    </>
  );
}
