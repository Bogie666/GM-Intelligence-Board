"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import type { AdminActionState } from "@/app/admin/actions";
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

const INITIAL: AdminActionState = { status: "idle", message: "" };

function Submit({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return <button className="button primary" type="submit" disabled={pending}>{pending ? "Saving…" : children}</button>;
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

function recipeLabel(policy: EndpointRecipePolicy): string {
  const recipe = serviceTitanEndpointRecipes.find((item) => item.id === policy.endpoint_recipe_id && item.version === policy.endpoint_recipe_version);
  return recipe?.name ?? policy.endpoint_recipe_id;
}

function SourceBindingForm({ tenant, workspace }: { tenant: ProductionTenantContext; workspace: ProductionAdminSettingsWorkspace }) {
  const [state, action] = useActionState(saveKpiBindingAction, INITIAL);
  const [method, setMethod] = useState("endpoint_recipe");
  const [recipeKey, setRecipeKey] = useState(() => {
    const first = workspace.endpointRecipes[0];
    return first ? `${first.endpoint_recipe_id}:${first.endpoint_recipe_version}` : "";
  });
  const recipePolicies = useMemo(() => {
    const grouped = new Map<string, EndpointRecipePolicy[]>();
    for (const policy of workspace.endpointRecipes) {
      const key = `${policy.endpoint_recipe_id}:${policy.endpoint_recipe_version}`;
      grouped.set(key, [...(grouped.get(key) ?? []), policy]);
    }
    return grouped;
  }, [workspace.endpointRecipes]);
  const [recipeId, recipeVersion = ""] = recipeKey.split(":");
  const allowedCadences = recipePolicies.get(recipeKey)?.map((policy) => policy.refresh_interval) ?? [];
  const activeLocations = tenant.locations.filter((location) => location.status === "active");
  const availableConnections = tenant.connections.filter((connection) => connection.status !== "archived" && connection.status !== "disabled");
  const approvedReports = workspace.reportSources.filter((report) => report.lifecycle === "approved");

  return (
    <section className="production-panel">
      <div className="production-panel-heading"><div><span>Exact-location contract</span><h2>Bind a published KPI</h2></div></div>
      <p className="production-boundary-note">Saving creates a draft binding. Approval remains unavailable until trusted sample and reconciliation evidence exist for its exact source fingerprint.</p>
      <form action={action} className="production-form-grid">
        <label>Published ServiceTitan KPI<select name="kpiDefinitionId" required defaultValue=""><option value="" disabled>Choose KPI</option>{workspace.kpiDefinitions.filter((definition) => definition.type === "service_titan").map((definition) => <option key={definition.id} value={definition.id}>{definition.title} · {definition.kpi_key} v{definition.version}</option>)}</select></label>
        <label>Location<select name="locationId" required defaultValue=""><option value="" disabled>Choose location</option>{activeLocations.map((location) => <option key={location.id} value={location.id}>{location.display_name}</option>)}</select></label>
        <label>Connection<select name="connectionId" required defaultValue=""><option value="" disabled>Choose connection</option>{availableConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.display_name} · {connection.service_titan_tenant_id}</option>)}</select></label>
        <label>Source method<select name="sourceMethod" value={method} onChange={(event) => setMethod(event.target.value)}><option value="endpoint_recipe">Approved endpoint recipe</option><option value="saved_report">Approved saved report</option></select></label>
        {method === "endpoint_recipe" ? (
          <>
            <label>Recipe<select value={recipeKey} onChange={(event) => setRecipeKey(event.target.value)} required><option value="" disabled>Choose recipe</option>{[...recipePolicies.entries()].map(([key, policies]) => <option key={key} value={key}>{recipeLabel(policies[0])} · v{policies[0].endpoint_recipe_version}</option>)}</select></label>
            <input type="hidden" name="endpointRecipeId" value={recipeId} /><input type="hidden" name="endpointRecipeVersion" value={recipeVersion} />
            <label>Refresh cadence<select name="refreshInterval" required defaultValue={allowedCadences.includes("1h") ? "1h" : allowedCadences[0]}>{allowedCadences.map((cadence) => <option key={cadence} value={cadence}>{cadence}</option>)}</select></label>
          </>
        ) : (
          <>
            <label>Approved saved report<select name="reportSourceId" required defaultValue=""><option value="" disabled>Choose report</option>{approvedReports.map((report) => <option key={report.id} value={report.id}>{report.name} · {report.service_titan_tenant_id}</option>)}</select></label>
            <label>Refresh cadence<select name="refreshInterval" defaultValue="24h"><option value="4h">4h</option><option value="12h">12h</option><option value="24h">24h</option></select></label>
            <label>Reduction<select name="reportReduction" defaultValue="sum"><option value="sum">Sum</option><option value="average">Average</option><option value="count">Count rows</option><option value="latest">Latest</option><option value="ratio">Ratio</option></select></label>
            <label>Value field<input name="valueField" maxLength={160} placeholder="Revenue" /></label>
            <label>Numerator field<input name="numeratorField" maxLength={160} placeholder="BookedCalls" /></label>
            <label>Denominator field<input name="denominatorField" maxLength={160} placeholder="EligibleCalls" /></label>
          </>
        )}
        <label className="span-two">Parameter values (JSON object)<textarea name="parameterValues" rows={3} defaultValue="{}" spellCheck={false} /></label>
        <label className="span-two">Business-unit mappings (JSON object)<textarea name="businessUnitMappings" rows={3} defaultValue="{}" spellCheck={false} /></label>
        <div className="production-form-footer"><span>Connection/location identity and recipe cadence are revalidated server-side and by database constraints.</span><Submit>Save draft binding</Submit></div>
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

  return (
    <>
      <WorkspaceWarnings workspace={workspace} area={["Endpoint recipes", "Saved report sources", "Published KPI definitions", "KPI bindings"]} />
      <section className="production-section">
        <div className="production-section-title"><div><span>Migration-approved contracts</span><h2>Endpoint recipes</h2></div><strong>{recipeGroups.size}</strong></div>
        <p className="production-muted-copy">Recipes are application-owned and can only be added or versioned by a reviewed migration. Administrators may inspect and select them; this screen cannot invent provider endpoints.</p>
        <div className="production-record-list">{[...recipeGroups.entries()].map(([key, policies]) => {
          const catalog = serviceTitanEndpointRecipes.find((recipe) => recipe.id === policies[0].endpoint_recipe_id && recipe.version === policies[0].endpoint_recipe_version);
          return <article className="production-record" key={key}><div className="production-record-heading"><div><strong>{catalog?.name ?? policies[0].endpoint_recipe_id}</strong><span>{policies[0].endpoint_recipe_id} · version {policies[0].endpoint_recipe_version}</span></div><span className="production-status ready">approved</span></div><p>{catalog?.description ?? "Migration-owned ServiceTitan recipe contract."}</p><small>Allowed cadence: {policies.map((policy) => policy.refresh_interval).join(", ")}</small></article>;
        })}{recipeGroups.size === 0 ? <div className="production-empty">No approved recipe policy was returned.</div> : null}</div>
      </section>
      <ReportSourceForm tenant={tenant} />
      <section className="production-section">
        <div className="production-section-title"><div><span>Tenant registry</span><h2>Saved report sources</h2></div><strong>{workspace.reportSources.length}</strong></div>
        <div className="production-record-list">{workspace.reportSources.map((report) => <article className="production-record" key={report.id}><div className="production-record-heading"><div><strong>{report.name}</strong><span>{report.category_id} / {report.report_id} · {report.owner_display_name}</span></div><span className={`production-status ${report.lifecycle}`}>{report.lifecycle}</span></div><p>{report.description || "No report description."}</p><small>{report.verification} · {report.fields.length} fields · expected schema {report.expected_schema_fingerprint.slice(0, 22)}…</small></article>)}{workspace.reportSources.length === 0 ? <div className="production-empty">No saved report source has been registered for this tenant.</div> : null}</div>
      </section>
      <SourceBindingForm tenant={tenant} workspace={workspace} />
      <section className="production-section">
        <div className="production-section-title"><div><span>Exact-location registry</span><h2>KPI bindings</h2></div><strong>{workspace.bindings.length}</strong></div>
        <div className="production-record-list">{workspace.bindings.map((binding) => <article className="production-record" key={binding.id}><div className="production-record-heading"><div><strong>{definitionName.get(binding.kpi_definition_id) ?? binding.kpi_definition_id}</strong><span>{locationName.get(binding.location_id) ?? binding.location_id} · {binding.source_method ?? "unconfigured"}</span></div><span className={`production-status ${binding.approval_status}`}>{binding.approval_status}</span></div><small>{binding.endpoint_recipe_id ? `${binding.endpoint_recipe_id} v${binding.endpoint_recipe_version}` : binding.report_source_id ?? "No source"} · {binding.refresh_interval ?? "no cadence"}</small></article>)}{workspace.bindings.length === 0 ? <div className="production-empty">No exact-location KPI bindings have been saved.</div> : null}</div>
      </section>
    </>
  );
}

function TargetForm({ tenant, workspace, target }: { tenant: ProductionTenantContext; workspace: ProductionAdminSettingsWorkspace; target?: ProductionKpiTarget }) {
  const [state, action] = useActionState(saveKpiTargetAction, INITIAL);
  const planningType = target?.dimensions?.planning_type === "budget" ? "budget" : "target";
  const note = typeof target?.dimensions?.note === "string" ? target.dimensions.note : "";
  const identityLocked = Boolean(target);
  return (
    <form action={action} className="production-form-grid compact">
      {target ? <input type="hidden" name="targetId" value={target.id} /> : null}
      <label>Plan type<select name="planningType" defaultValue={planningType}><option value="target">KPI target</option><option value="budget">Budget-tagged KPI target</option></select></label>
      <label>Scope<select name="locationId" defaultValue={target?.location_id ?? ""} disabled={identityLocked}><option value="">Organization-wide</option>{tenant.locations.filter((location) => location.status !== "archived").map((location) => <option key={location.id} value={location.id}>{location.display_name}</option>)}</select>{identityLocked ? <input type="hidden" name="locationId" value={target?.location_id ?? ""} /> : null}</label>
      <label>Published KPI<select name="kpiDefinitionId" defaultValue={target?.kpi_definition_id ?? ""} disabled={identityLocked}><option value="">Unlinked metric key</option>{workspace.kpiDefinitions.map((definition) => <option key={definition.id} value={definition.id}>{definition.title} · {definition.kpi_key}</option>)}</select>{identityLocked ? <input type="hidden" name="kpiDefinitionId" value={target?.kpi_definition_id ?? ""} /> : null}</label>
      <label>Metric key<input name="metricKey" required pattern="[a-z0-9][a-z0-9-]{2,80}" defaultValue={target?.metric_key ?? ""} readOnly={identityLocked} /></label>
      <label>Target / budget value<input name="targetValue" type="number" step="any" required defaultValue={target?.target_value ?? ""} /></label>
      <label>Warning value<input name="warningValue" type="number" step="any" defaultValue={target?.warning_value ?? ""} /></label>
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
