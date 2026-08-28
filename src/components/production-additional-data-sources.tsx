"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import type { AdminActionState } from "@/app/admin/actions";
import {
  archiveCustomEndpointSourceAction,
  archiveDomoDatasetSourceAction,
  createCustomEndpointSourceAction,
  createDomoDatasetSourceAction,
  disableDomoConnectionAction,
  governCustomEndpointBindingAction,
  governDomoDatasetBindingAction,
  inspectCustomEndpointSourceAction,
  inspectDomoDatasetSourceAction,
  registerDomoConnectionAction,
  saveKpiBindingAction,
  validateDomoConnectionAction,
} from "@/app/admin/settings-actions";
import type {
  ProductionAdminSettingsWorkspace,
  ProductionCustomEndpointSource,
  ProductionDomoConnection,
  ProductionDomoDatasetSource,
  ProductionKpiBinding,
} from "@/lib/production-admin-settings";
import type { ProductionTenantContext } from "@/lib/tenant-context";
import { selectableServiceTitanEndpointRecipes } from "@/lib/service-titan-sources";

const INITIAL: AdminActionState = { status: "idle", message: "" };

function Submit({ children, pendingLabel = "Saving…", className = "button primary", disabled = false }: { children: React.ReactNode; pendingLabel?: string; className?: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return <button className={className} type="submit" disabled={pending || disabled}>{pending ? pendingLabel : children}</button>;
}

function Notice({ state }: { state: AdminActionState }) {
  if (state.status === "idle") return null;
  return <div className={`production-notice ${state.status}`} role={state.status === "error" ? "alert" : "status"}>{state.message}{state.fieldErrors ? <ul>{Object.entries(state.fieldErrors).map(([field, message]) => <li key={field}><strong>{field}:</strong> {message}</li>)}</ul> : null}</div>;
}

function CustomSourceCreate({ tenant }: { tenant: ProductionTenantContext }) {
  const [state, action] = useActionState(createCustomEndpointSourceAction, INITIAL);
  const [connectionId, setConnectionId] = useState("");
  const [reduction, setReduction] = useState("count");
  const connections = tenant.connections.filter((connection) => connection.status === "ready");
  const selected = connections.find((connection) => connection.id === connectionId);
  return <section className="production-panel">
    <div className="production-panel-heading"><div><span>ServiceTitan custom endpoint</span><h2>Declare a bounded source</h2></div></div>
    <p className="production-boundary-note">Only approved list categories and credential-free query parameters are accepted. Creation produces a non-ingestible draft.</p>
    <form action={action} className="production-form-grid">
      <label>Validated connection<select name="connectionId" required value={connectionId} onChange={(event) => setConnectionId(event.target.value)}><option value="" disabled>Choose connection</option>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.display_name} · {connection.service_titan_tenant_id}</option>)}</select></label>
      <input type="hidden" name="serviceTitanTenantId" value={selected?.service_titan_tenant_id ?? ""} />
      <label>Source name<input name="name" required maxLength={200} /></label>
      <label>Category<select name="category" required defaultValue="jobs"><option value="jobs">Jobs</option><option value="appointments">Appointments</option><option value="invoices">Invoices</option><option value="estimates">Estimates</option><option value="memberships">Memberships</option><option value="calls">Calls</option><option value="customers">Customers</option></select></label>
      <label>Reduction<select name="reduction" value={reduction} onChange={(event) => setReduction(event.target.value)}><option value="count">Count rows</option><option value="sum">Sum</option><option value="average">Average</option></select></label>
      <label>Description<input name="description" maxLength={500} /></label>
      <label>Value field path<input name="valueField" maxLength={120} required={reduction !== "count"} disabled={reduction === "count"} placeholder={reduction === "count" ? "Not used for count" : "total.amount"} /></label>
      <label>Business-unit field path<input name="businessUnitField" maxLength={120} placeholder="businessUnit.id (optional)" /></label>
      <label className="span-two">Query parameters (JSON object)<textarea name="queryParameters" rows={4} defaultValue={'{"completedOnOrAfter":"$periodStartIso","completedBefore":"$periodEndIso"}'} spellCheck={false} /><small>Credential-like keys, pagination controls, and unbounded date overrides are rejected.</small></label>
      <div className="production-form-footer"><span>The exact connection and tenant ID are pinned by the database RPC.</span><Submit>Declare custom source</Submit></div>
    </form><Notice state={state} />
  </section>;
}

function CustomSourceRecord({ source, tenant, workspace }: { source: ProductionCustomEndpointSource; tenant: ProductionTenantContext; workspace: ProductionAdminSettingsWorkspace }) {
  const [inspectState, inspectAction, inspectPending] = useActionState(inspectCustomEndpointSourceAction, INITIAL);
  const [archiveState, archiveAction, archivePending] = useActionState(archiveCustomEndpointSourceAction, INITIAL);
  const active = source.status === "active" && source.lifecycle !== "archived";
  const connectionLabel = tenant.connections.find((connection) => connection.id === source.connection_id)?.display_name ?? source.connection_id;
  const dependentBindings = workspace.bindings.filter((binding) => binding.custom_endpoint_source_id === source.id && binding.approval_status !== "archived").length;
  const busy = inspectPending || archivePending;
  return <article className="production-record">
    <div className="production-record-heading"><div><strong>{source.name}</strong><span>{source.category} · {source.reduction} · tenant {source.service_titan_tenant_id}</span></div><span className={`production-status ${source.lifecycle}`}>{source.lifecycle}</span></div>
    <p>{source.description || "No description."}</p>
    <small>Connection: {connectionLabel} · Value: {source.value_field ?? "row count"} · Business unit: {source.business_unit_field ?? "not filtered"} · updated {new Date(source.updated_at).toLocaleString()}</small>
    <details className="production-operator-handoff"><summary>View declared query contract</summary><code>{JSON.stringify(source.query_parameters)}</code></details>
    {active ? <details className="production-operator-handoff"><summary>Inspect or archive</summary>
      <form action={inspectAction} className="production-form-grid compact"><input type="hidden" name="sourceId" value={source.id} /><label>Completed period start (UTC ISO)<input name="periodStart" required placeholder="2026-08-01T00:00:00.000Z" /></label><label>Completed period end (UTC ISO)<input name="periodEnd" required placeholder="2026-08-02T00:00:00.000Z" /></label><div className="production-form-footer"><span>Runs the trusted credentialed worker; raw provider data stays server-side.</span><Submit disabled={busy} pendingLabel="Inspecting…">Inspect live source</Submit></div></form><Notice state={inspectState} />
      <form action={archiveAction} className="production-destructive-row" onSubmit={(event) => { if (!window.confirm(`Archive ${source.name}? This interrupts ${dependentBindings} dependent KPI binding(s) and cannot be undone.`)) event.preventDefault(); }}><input type="hidden" name="sourceId" value={source.id} /><input type="hidden" name="expectedDependentBindings" value={dependentBindings} /><span>Permanent archive; impacts {dependentBindings} dependent binding(s).</span><Submit disabled={busy} className="button production-danger" pendingLabel="Archiving…">Archive source</Submit></form><Notice state={archiveState} />
    </details> : null}
  </article>;
}

function DomoConnectionCreate() {
  const [state, action] = useActionState(registerDomoConnectionAction, INITIAL);
  return <section className="production-panel"><div className="production-panel-heading"><div><span>Vault-managed OAuth</span><h2>Register a Domo connection</h2></div></div>
    <p className="production-boundary-note">Credentials are posted only to the authenticated server action and stored in Supabase Vault. They are never loaded back into the browser.</p>
    <form action={action} className="production-form-grid" autoComplete="off"><label>Display name<input name="displayName" required maxLength={200} /></label><label>OAuth client ID<input name="clientId" required minLength={8} maxLength={4096} autoComplete="off" /></label><label className="span-two">OAuth client secret<input name="clientSecret" type="password" required minLength={8} maxLength={4096} autoComplete="new-password" /></label><div className="production-form-footer"><span>Validation is a separate trusted-worker step.</span><Submit>Register Domo connection</Submit></div></form><Notice state={state} />
  </section>;
}

function DomoConnectionRecord({ connection, workspace }: { connection: ProductionDomoConnection; workspace: ProductionAdminSettingsWorkspace }) {
  const [validateState, validateAction, validatePending] = useActionState(validateDomoConnectionAction, INITIAL);
  const [disableState, disableAction, disablePending] = useActionState(disableDomoConnectionAction, INITIAL);
  const enabled = connection.status !== "disabled" && connection.status !== "archived";
  const busy = validatePending || disablePending;
  const dependentSources = workspace.domoDatasetSources.filter((source) => source.domo_connection_id === connection.id && source.lifecycle !== "archived").length;
  const dependentBindings = workspace.bindings.filter((binding) => binding.domo_connection_id === connection.id && binding.approval_status !== "archived").length;
  return <article className="production-record">
    <div className="production-record-heading"><div><strong>{connection.display_name}</strong><span>Last validated: {connection.last_validated_at ? new Date(connection.last_validated_at).toLocaleString() : "never"}</span></div><span className={`production-status ${connection.status}`}>{connection.status.replaceAll("_", " ")}</span></div>
    {connection.last_error_code ? <small>Stable error code: {connection.last_error_code}</small> : null}
    {enabled ? <div className="production-form-footer">
      <form action={validateAction}><input type="hidden" name="connectionId" value={connection.id} /><Submit disabled={busy} pendingLabel="Validating…">Validate credentials</Submit></form>
      <form action={disableAction} className="production-destructive-row" onSubmit={(event) => { if (!window.confirm(`Disable ${connection.display_name}? This permanently deletes its managed Vault credential and interrupts ${dependentSources} active dataset source(s) and ${dependentBindings} dependent KPI binding(s).`)) event.preventDefault(); }}><input type="hidden" name="connectionId" value={connection.id} /><input type="hidden" name="expectedDependentSources" value={dependentSources} /><input type="hidden" name="expectedDependentBindings" value={dependentBindings} /><span>Permanent credential retirement; impacts {dependentSources} active dataset source(s) and {dependentBindings} binding(s). Re-registration is required to reconnect.</span><Submit disabled={busy} className="button production-danger" pendingLabel="Disabling…">Disable and retire credential</Submit></form>
    </div> : null}
    <Notice state={validateState} /><Notice state={disableState} />
  </article>;
}

function DomoDatasetCreate({ workspace }: { workspace: ProductionAdminSettingsWorkspace }) {
  const [state, action] = useActionState(createDomoDatasetSourceAction, INITIAL);
  const [reduction, setReduction] = useState("sum");
  const [periodMode, setPeriodMode] = useState("none");
  const connections = workspace.domoConnections.filter((connection) => connection.status === "ready");
  return <section className="production-panel"><div className="production-panel-heading"><div><span>Governed Domo contract</span><h2>Declare a dataset source</h2></div></div>
    <p className="production-boundary-note">Declare one organization-owned mapped filter per brand or location. The dataset, period, mapping, reduction, and expected row count are fingerprinted and immutable after approval.</p>
    <form action={action} className="production-form-grid">
      <label>Ready connection<select name="connectionId" required defaultValue=""><option value="" disabled>Choose Domo connection</option>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.display_name}</option>)}</select></label>
      <label>Dataset GUID<input name="datasetId" required pattern="[0-9A-Fa-f-]{36}" /></label>
      <label>Source name<input name="name" required maxLength={200} /></label>
      <label>Reduction<select name="reduction" value={reduction} onChange={(event) => setReduction(event.target.value)}><option value="sum">Sum</option><option value="average">Average</option><option value="count">Count rows</option><option value="latest">Latest</option></select></label>
      <label>Description<input name="description" maxLength={500} /></label>
      <label>Value column<input name="valueColumn" maxLength={120} required={reduction !== "count"} disabled={reduction === "count"} /></label>
      <label>Period contract<select name="periodMode" value={periodMode} onChange={(event) => setPeriodMode(event.target.value)}><option value="none">No period columns</option><option value="date">Single date column</option><option value="month_year">Separate month and year columns</option></select></label>
      {periodMode === "date" ? <label>Date column<input name="dateColumn" maxLength={120} required /><small>Rows are bounded to the observation period.</small></label> : <input type="hidden" name="dateColumn" value="" />}
      {periodMode === "month_year" ? <><label>Month column<input name="monthColumn" maxLength={120} required /></label><label>Year column<input name="yearColumn" maxLength={120} required /></label></> : <><input type="hidden" name="monthColumn" value="" /><input type="hidden" name="yearColumn" value="" /></>}
      <label>Mapped brand/location column<input name="filterColumn" maxLength={120} required={periodMode === "month_year"} /></label>
      <label>Mapped value for this organization<input name="filterValue" maxLength={200} required={periodMode === "month_year"} /></label>
      <label>Expected eligible rows<input name="expectedPeriodRows" type="number" min={1} max={250000} step={1} /><small>Optional fail-closed cardinality after mapping and period filters. Monthly budgets should use 1.</small></label>
      <div className="production-form-footer"><span>Never reuse another brand&apos;s mapped value. Each organization/location binding selects its own governed source.</span><Submit>Declare Domo dataset</Submit></div>
    </form><Notice state={state} />
  </section>;
}

function DomoDatasetRecord({ source, workspace }: { source: ProductionDomoDatasetSource; workspace: ProductionAdminSettingsWorkspace }) {
  const [inspectState, inspectAction, inspectPending] = useActionState(inspectDomoDatasetSourceAction, INITIAL);
  const [archiveState, archiveAction, archivePending] = useActionState(archiveDomoDatasetSourceAction, INITIAL);
  const active = source.status === "active" && source.lifecycle !== "archived";
  const busy = inspectPending || archivePending;
  const connectionLabel = workspace.domoConnections.find((connection) => connection.id === source.domo_connection_id)?.display_name ?? source.domo_connection_id;
  const dependentBindings = workspace.bindings.filter((binding) => binding.domo_dataset_source_id === source.id && binding.approval_status !== "archived").length;
  return <article className="production-record">
    <div className="production-record-heading"><div><strong>{source.name}</strong><span>{source.dataset_id} · {source.reduction}</span></div><span className={`production-status ${source.lifecycle}`}>{source.lifecycle}</span></div>
    <p>{source.description || "No description."}</p><small>Connection: {connectionLabel} · Value: {source.value_column ?? "row count"} · period: {source.period_mode === "date" ? `date ${source.date_column}` : source.period_mode === "month_year" ? `${source.month_column} + ${source.year_column}` : "none"} · mapped filter: {source.filter_column ? `${source.filter_column} = ${source.filter_value}` : "none"} · expected rows: {source.expected_period_rows ?? "not pinned"}</small>
    {active ? <div className="production-form-footer">
      <form action={inspectAction}><input type="hidden" name="sourceId" value={source.id} /><Submit disabled={busy} pendingLabel="Inspecting…">Inspect dataset</Submit></form>
      <form action={archiveAction} className="production-destructive-row" onSubmit={(event) => { if (!window.confirm(`Archive ${source.name}? This interrupts ${dependentBindings} dependent KPI binding(s) and cannot be undone.`)) event.preventDefault(); }}><input type="hidden" name="sourceId" value={source.id} /><input type="hidden" name="expectedDependentBindings" value={dependentBindings} /><span>Permanent archive; impacts {dependentBindings} dependent binding(s).</span><Submit disabled={busy} className="button production-danger" pendingLabel="Archiving…">Archive dataset</Submit></form>
    </div> : null}
    <Notice state={inspectState} /><Notice state={archiveState} />
  </article>;
}

function GovernBinding({ binding, workspace, tenant }: { binding: ProductionKpiBinding; workspace: ProductionAdminSettingsWorkspace; tenant: ProductionTenantContext }) {
  const actionFunction = binding.source_method === "custom_endpoint" ? governCustomEndpointBindingAction : governDomoDatasetBindingAction;
  const [state, action] = useActionState(actionFunction, INITIAL);
  const definition = workspace.kpiDefinitions.find((item) => item.id === binding.kpi_definition_id);
  const location = tenant.locations.find((item) => item.id === binding.location_id);
  const source = binding.source_method === "custom_endpoint"
    ? workspace.customEndpointSources.find((item) => item.id === binding.custom_endpoint_source_id)
    : workspace.domoDatasetSources.find((item) => item.id === binding.domo_dataset_source_id);
  return <article className="production-record">
    <div className="production-record-heading"><div><strong>{definition?.title ?? binding.kpi_definition_id}</strong><span>{location?.display_name ?? binding.location_id} · {source?.name ?? binding.custom_endpoint_source_id ?? binding.domo_dataset_source_id} · {binding.source_method?.replaceAll("_", " ")} · {binding.refresh_interval}</span></div><span className={`production-status ${binding.approval_status}`}>{binding.approval_status}</span></div>
    <small>Binding ID: {binding.id} · Connection: {binding.connection_id ?? binding.domo_connection_id ?? "none"}</small>
    <details className="production-operator-handoff"><summary>Reconcile and approve</summary><form action={action} className="production-form-grid compact"><input type="hidden" name="bindingId" value={binding.id} /><label>Completed period start (UTC ISO)<input name="periodStart" required placeholder="2026-08-01T00:00:00.000Z" /></label><label>Completed period end (UTC ISO)<input name="periodEnd" required placeholder="2026-08-02T00:00:00.000Z" /></label><label>Independent reference value<input name="referenceValue" required inputMode="decimal" /></label><label>Absolute tolerance<input name="tolerance" required inputMode="decimal" defaultValue="0" /></label><div className="production-form-footer"><span>Method identity and actor profile are fixed server-side; mismatches fail closed.</span><Submit pendingLabel="Reconciling…">Run governed reconciliation</Submit></div></form><Notice state={state} /></details>
  </article>;
}

function AdditionalBindingForm({ mode, tenant, workspace }: { mode: "endpoint_recipe" | "custom_endpoint" | "domo_dataset"; tenant: ProductionTenantContext; workspace: ProductionAdminSettingsWorkspace }) {
  const [state, action] = useActionState(saveKpiBindingAction, INITIAL);
  const [kpiId, setKpiId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [recipeKey, setRecipeKey] = useState("");
  const [refreshInterval, setRefreshInterval] = useState(mode === "domo_dataset" ? "24h" : "4h");
  const isDomo = mode === "domo_dataset";
  const assigned = useMemo(() => new Set(tenant.assignments.filter((assignment) => assignment.location_id === locationId && assignment.revoked_at === null).map((assignment) => assignment.connection_id)), [locationId, tenant.assignments]);
  const serviceTitanConnections = tenant.connections.filter((connection) => connection.status === "ready" && assigned.has(connection.id));
  const customSources = workspace.customEndpointSources.filter((source) => source.status === "active" && source.lifecycle !== "archived" && source.connection_id === connectionId);
  const domoConnections = workspace.domoConnections.filter((connection) => connection.status === "ready");
  const domoSources = workspace.domoDatasetSources.filter((source) => source.status === "active" && source.lifecycle !== "archived" && source.domo_connection_id === connectionId);
  const selectableConnections = isDomo
    ? domoConnections.map((connection) => ({ id: connection.id, label: connection.display_name }))
    : serviceTitanConnections.map((connection) => ({ id: connection.id, label: `${connection.display_name} · ${connection.service_titan_tenant_id}` }));
  const selectableRecipeKeys = new Set(selectableServiceTitanEndpointRecipes.map((recipe) => `${recipe.id}|${recipe.version}`));
  const recipeOptions = [...new Map(workspace.endpointRecipes
    .filter((recipe) => selectableRecipeKeys.has(`${recipe.endpoint_recipe_id}|${recipe.endpoint_recipe_version}`))
    .map((recipe) => [`${recipe.endpoint_recipe_id}|${recipe.endpoint_recipe_version}`, recipe])).values()];
  const [recipeId = "", recipeVersion = ""] = recipeKey.split("|");
  const selectedRecipePolicies = workspace.endpointRecipes.filter((policy) => `${policy.endpoint_recipe_id}|${policy.endpoint_recipe_version}` === recipeKey);
  const cadenceOptions = mode === "endpoint_recipe"
    ? selectedRecipePolicies.map((policy) => policy.refresh_interval)
    : mode === "domo_dataset" ? ["24h"] : ["4h", "12h", "24h"];
  const kpis = workspace.kpiDefinitions.filter((definition) => isDomo ? definition.type === "external" && definition.external_source?.provider === "domo" : definition.type === "service_titan");
  const existingBinding = workspace.bindings.find((binding) => binding.kpi_definition_id === kpiId && binding.location_id === locationId && binding.approval_status !== "archived");
  const immutableExisting = existingBinding?.approval_status === "approved";
  const title = mode === "endpoint_recipe" ? "Endpoint recipe binding" : mode === "custom_endpoint" ? "Custom endpoint binding" : "Domo dataset binding";
  return <section className="production-panel">
    <div className="production-panel-heading"><div><span>Exact-location governed method</span><h2>{title}</h2></div></div>
    <p className="production-boundary-note">The cadence configures scheduler eligibility; it does not prove that an external scheduler is currently deployed. Saving creates a non-ingestible draft.</p>
    <form action={action} className="production-form-grid">
      <input type="hidden" name="sourceMethod" value={mode} /><input type="hidden" name="parameterValues" value="{}" /><input type="hidden" name="businessUnitMappings" value="{}" />
      <label>Published KPI<select name="kpiDefinitionId" required value={kpiId} onChange={(event) => setKpiId(event.target.value)}><option value="" disabled>Choose KPI</option>{kpis.map((definition) => <option key={definition.id} value={definition.id}>{definition.title} · {definition.kpi_key}</option>)}</select></label>
      <label>Active location<select name="locationId" required value={locationId} onChange={(event) => { setLocationId(event.target.value); setConnectionId(""); setSourceId(""); }}><option value="" disabled>Choose location</option>{tenant.locations.filter((location) => location.status === "active").map((location) => <option key={location.id} value={location.id}>{location.display_name}</option>)}</select></label>
      <label>{isDomo ? "Ready Domo connection" : "Assigned ServiceTitan connection"}<select name={isDomo ? "domoConnectionId" : "connectionId"} required value={connectionId} disabled={!locationId} onChange={(event) => { setConnectionId(event.target.value); setSourceId(""); }}><option value="">{locationId ? "Choose connection" : "Choose a location first"}</option>{selectableConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.label}</option>)}</select></label>
      {mode === "endpoint_recipe" ? <>
        <label>Approved recipe<select required value={recipeKey} onChange={(event) => { const key = event.target.value; setRecipeKey(key); const first = workspace.endpointRecipes.find((policy) => `${policy.endpoint_recipe_id}|${policy.endpoint_recipe_version}` === key); setRefreshInterval(first?.refresh_interval ?? ""); }}><option value="" disabled>Choose recipe</option>{recipeOptions.map((recipe) => <option key={`${recipe.endpoint_recipe_id}|${recipe.endpoint_recipe_version}`} value={`${recipe.endpoint_recipe_id}|${recipe.endpoint_recipe_version}`}>{recipe.endpoint_recipe_id} v{recipe.endpoint_recipe_version}</option>)}</select></label>
        <input type="hidden" name="endpointRecipeId" value={recipeId} /><input type="hidden" name="endpointRecipeVersion" value={recipeVersion} />
      </> : <label>{isDomo ? "Dataset source" : "Custom endpoint source"}<select name={isDomo ? "domoDatasetSourceId" : "customEndpointSourceId"} required value={sourceId} disabled={!connectionId} onChange={(event) => setSourceId(event.target.value)}><option value="">{connectionId ? "Choose source" : "Choose a connection first"}</option>{(isDomo ? domoSources : customSources).map((source) => <option key={source.id} value={source.id}>{source.name} · {source.lifecycle}</option>)}</select></label>}
      <label>Refresh cadence<select name="refreshInterval" required value={refreshInterval} disabled={mode === "endpoint_recipe" && !recipeKey} onChange={(event) => setRefreshInterval(event.target.value)}><option value="" disabled>{recipeKey ? "Choose cadence" : "Choose a recipe first"}</option>{cadenceOptions.map((value) => <option key={value} value={value}>Every {value.replace("h", " hours")}</option>)}</select></label>
      <label>Observation window<select name="observationWindow" defaultValue="trailing"><option value="trailing">Trailing cadence window</option><option value="today">Location-local day to date</option><option value="mtd">Location-local month to date</option><option value="ytd">Location-local year to date</option></select><small>Calendar windows anchor each observation to the bound location&apos;s timezone; the cadence still controls how often the worker refreshes it.</small></label>
      {existingBinding ? immutableExisting
        ? <div className="production-notice error span-two" role="alert">The existing approved binding is immutable. Archive it from the trusted operator path before creating a replacement draft.</div>
        : <label className="production-checkbox-row span-two"><input type="checkbox" name="confirmReplacement" value="replace" required /><span><strong>Replace existing {existingBinding.approval_status} binding</strong><small>This replaces binding {existingBinding.id} for the same KPI and location with a new draft.</small></span></label>
        : null}
      <div className="production-form-footer"><span>Changing source method resets approval and clears every stale source-family fingerprint. Worker evidence is required before ingestion.</span><Submit disabled={immutableExisting}>Save draft binding</Submit></div>
    </form><Notice state={state} />
  </section>;
}

export function ProductionAdditionalDataSources({ tenant, workspace }: { tenant: ProductionTenantContext; workspace: ProductionAdminSettingsWorkspace }) {
  const governable = workspace.bindings.filter((binding) => (binding.source_method === "custom_endpoint" || binding.source_method === "domo_dataset") && binding.approval_status !== "approved" && binding.approval_status !== "archived");
  return <>
    <CustomSourceCreate tenant={tenant} />
    <section className="production-section"><div className="production-section-title"><div><span>Tenant registry</span><h2>Custom endpoint sources</h2></div><strong>{workspace.customEndpointSources.length}</strong></div><div className="production-record-list">{workspace.customEndpointSources.map((source) => <CustomSourceRecord key={source.id} source={source} tenant={tenant} workspace={workspace} />)}{workspace.customEndpointSources.length === 0 ? <div className="production-empty">No custom endpoint sources are registered.</div> : null}</div></section>
    <DomoConnectionCreate />
    <section className="production-section"><div className="production-section-title"><div><span>Credential-safe registry</span><h2>Domo connections</h2></div><strong>{workspace.domoConnections.length}</strong></div><div className="production-record-list">{workspace.domoConnections.map((connection) => <DomoConnectionRecord key={connection.id} connection={connection} workspace={workspace} />)}{workspace.domoConnections.length === 0 ? <div className="production-empty">No Domo connections are registered.</div> : null}</div></section>
    <DomoDatasetCreate workspace={workspace} />
    <section className="production-section"><div className="production-section-title"><div><span>Governed contracts</span><h2>Domo dataset sources</h2></div><strong>{workspace.domoDatasetSources.length}</strong></div><div className="production-record-list">{workspace.domoDatasetSources.map((source) => <DomoDatasetRecord key={source.id} source={source} workspace={workspace} />)}{workspace.domoDatasetSources.length === 0 ? <div className="production-empty">No Domo dataset sources are registered.</div> : null}</div></section>
    <AdditionalBindingForm mode="endpoint_recipe" tenant={tenant} workspace={workspace} />
    <AdditionalBindingForm mode="custom_endpoint" tenant={tenant} workspace={workspace} />
    <AdditionalBindingForm mode="domo_dataset" tenant={tenant} workspace={workspace} />
    <section className="production-section"><div className="production-section-title"><div><span>Trusted evidence workflow</span><h2>Pending custom and Domo governance</h2></div><strong>{governable.length}</strong></div><p className="production-muted-copy">Reconciliation runs server-side against the method already stored on the exact binding. Browser input cannot switch the governed source method or actor identity.</p><div className="production-record-list">{governable.map((binding) => <GovernBinding key={binding.id} binding={binding} workspace={workspace} tenant={tenant} />)}{governable.length === 0 ? <div className="production-empty">No custom endpoint or Domo binding currently requires governance.</div> : null}</div></section>
  </>;
}

