"use client";

import {
  Archive,
  Building2,
  CheckCircle2,
  CircleAlert,
  Database,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  buildDemoConnection,
  createSeedConnectionStore,
  readConnectionStore,
  resetConnectionStore,
  setDemoConnectionStatus,
  upsertDemoConnection,
  writeConnectionStore,
  type ConnectionValidationIssue,
  type DemoConnectionStore,
  type DemoServiceTitanConnection,
  type DemoServiceTitanConnectionInput,
  type ServiceTitanEnvironment,
} from "@/lib/demo-connections";
import { locations } from "@/lib/demo-data";

type FormDraft = {
  displayName: string;
  tenantId: string;
  environment: ServiceTitanEnvironment;
  locationIds: string[];
  clientId: string;
  appKey: string;
  clientSecret: string;
};

type Notice = { kind: "ok" | "error"; message: string } | null;

const emptyDraft: FormDraft = {
  displayName: "",
  tenantId: "",
  environment: "production",
  locationIds: [],
  clientId: "",
  appKey: "",
  clientSecret: "",
};

function connectionInput(draft: FormDraft, id?: string): DemoServiceTitanConnectionInput {
  return {
    id,
    displayName: draft.displayName,
    tenantId: draft.tenantId,
    environment: draft.environment,
    locationIds: draft.locationIds,
    clientId: draft.clientId,
    appKey: draft.appKey,
    clientSecret: draft.clientSecret,
  };
}

function formatUpdatedAt(value?: string) {
  if (!value) return "Not validated";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not validated";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function statusLabel(connection: DemoServiceTitanConnection) {
  if (connection.status === "archived") return "Archived";
  return connection.status === "ready" ? "Configured · unverified" : "Needs attention";
}

function statusClass(connection: DemoServiceTitanConnection) {
  if (connection.status === "archived") return "archived";
  return connection.status === "ready" ? "published" : "draft";
}

export function ServiceTitanConnections() {
  const [store, setStore] = useState<DemoConnectionStore>(() => createSeedConnectionStore());
  const [hydrated, setHydrated] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<FormDraft>(emptyDraft);
  const [issues, setIssues] = useState<ConnectionValidationIssue[]>([]);
  const [formNotice, setFormNotice] = useState<Notice>(null);
  const [pageNotice, setPageNotice] = useState<Notice>(null);

  useEffect(() => {
    const hydration = window.setTimeout(() => {
      setStore(readConnectionStore(window.localStorage));
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(hydration);
  }, []);

  const activeConnections = useMemo(
    () => store.connections.filter((connection) => connection.status !== "archived"),
    [store.connections],
  );
  const archivedConnections = useMemo(
    () => store.connections.filter((connection) => connection.status === "archived"),
    [store.connections],
  );
  const editing = editingId
    ? store.connections.find((connection) => connection.id === editingId)
    : undefined;
  const assignedLocationOwner = useMemo(() => {
    const owners = new Map<string, DemoServiceTitanConnection>();
    for (const connection of activeConnections) {
      if (connection.id === editingId) continue;
      for (const locationId of connection.locationIds) owners.set(locationId, connection);
    }
    return owners;
  }, [activeConnections, editingId]);

  const counts = {
    active: activeConnections.length,
    ready: activeConnections.filter((connection) => connection.status === "ready").length,
    attention: activeConnections.filter((connection) => connection.status === "needs-attention").length,
    archived: archivedConnections.length,
  };

  function clearFeedback() {
    setIssues([]);
    setFormNotice(null);
  }

  function beginAdd() {
    setEditingId(null);
    setDraft({ ...emptyDraft, locationIds: [] });
    clearFeedback();
    setPageNotice(null);
    setFormOpen(true);
  }

  function beginEdit(connection: DemoServiceTitanConnection) {
    setEditingId(connection.id);
    setDraft({
      displayName: connection.displayName,
      tenantId: connection.tenantId,
      environment: connection.environment,
      locationIds: [...connection.locationIds],
      clientId: "",
      appKey: "",
      clientSecret: "",
    });
    clearFeedback();
    setPageNotice(null);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    setDraft({ ...emptyDraft, locationIds: [] });
    clearFeedback();
  }

  function setField<Key extends keyof FormDraft>(field: Key, value: FormDraft[Key]) {
    setDraft((current) => ({ ...current, [field]: value }));
    clearFeedback();
  }

  function toggleLocation(locationId: string) {
    setField(
      "locationIds",
      draft.locationIds.includes(locationId)
        ? draft.locationIds.filter((id) => id !== locationId)
        : [...draft.locationIds, locationId],
    );
  }

  function validateDraft() {
    const result = buildDemoConnection(
      connectionInput(draft, editing?.id),
      store.connections,
      editing,
    );
    setIssues(result.issues);
    setFormNotice(
      result.issues.length
        ? {
            kind: "error",
            message: `Demo validation found ${result.issues.length} issue${result.issues.length === 1 ? "" : "s"}. No API call was made.`,
          }
        : {
            kind: "ok",
            message: "Demo validation passed. Form shape and tenant/location ownership were checked locally. No API call was made.",
          },
    );
  }

  function saveConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = buildDemoConnection(
      connectionInput(draft, editing?.id),
      store.connections,
      editing,
    );
    setIssues(result.issues);
    if (!result.connection) {
      setFormNotice({
        kind: "error",
        message: `Fix ${result.issues.length} validation issue${result.issues.length === 1 ? "" : "s"} before saving. No API call was made.`,
      });
      return;
    }

    const nextStore = upsertDemoConnection(store, result.connection);
    if (!writeConnectionStore(nextStore, window.localStorage)) {
      setFormNotice({ kind: "error", message: "The browser-local profile could not be saved. Check browser storage access and try again." });
      return;
    }

    setStore(nextStore);
    closeForm();
    setPageNotice({
      kind: "ok",
      message: `${result.connection.displayName} was saved in this browser. Only masked credential metadata was persisted.`,
    });
  }

  function archiveConnection(connection: DemoServiceTitanConnection) {
    if (!window.confirm(`Archive ${connection.displayName}? Its tenant and locations will become available to another active profile.`)) return;
    const nextStore = setDemoConnectionStatus(store, connection.id, "archived");
    if (!writeConnectionStore(nextStore, window.localStorage)) {
      setPageNotice({ kind: "error", message: `${connection.displayName} could not be archived because browser storage is unavailable.` });
      return;
    }
    setStore(nextStore);
    if (editingId === connection.id) closeForm();
    setPageNotice({ kind: "ok", message: `${connection.displayName} was archived. Its masked profile remains browser-local.` });
  }

  function restoreConnection(connection: DemoServiceTitanConnection) {
    const result = buildDemoConnection(
      {
        id: connection.id,
        displayName: connection.displayName,
        tenantId: connection.tenantId,
        environment: connection.environment,
        locationIds: connection.locationIds,
        clientId: "",
        appKey: "",
        clientSecret: "",
      },
      store.connections,
      connection,
    );

    if (!result.connection) {
      setPageNotice({
        kind: "error",
        message: `Cannot restore ${connection.displayName}: ${result.issues.map((issue) => issue.message).join(" ")}`,
      });
      return;
    }

    const nextStore = upsertDemoConnection(store, result.connection);
    if (!writeConnectionStore(nextStore, window.localStorage)) {
      setPageNotice({ kind: "error", message: `${connection.displayName} could not be restored because browser storage is unavailable.` });
      return;
    }
    setStore(nextStore);
    setPageNotice({ kind: "ok", message: `${connection.displayName} was restored as an active profile.` });
  }

  function resetProfiles() {
    if (!window.confirm("Reset all ServiceTitan connection profiles to the three demo defaults? Browser-local changes will be replaced.")) return;
    const seeded = resetConnectionStore(window.localStorage);
    setStore(seeded);
    closeForm();
    setPageNotice({ kind: "ok", message: "ServiceTitan profiles were reset to the demo defaults." });
  }

  function issuesFor(field: ConnectionValidationIssue["field"]) {
    return issues.filter((issue) => issue.field === field);
  }

  if (!hydrated) {
    return (
      <section className="admin-card small-empty" aria-live="polite">
        <RefreshCw className="spin" aria-hidden="true" />
        <strong>Loading ServiceTitan profiles</strong>
        <p>Hydrating the browser-local demo connection store.</p>
      </section>
    );
  }

  return (
    <>
      <div className="admin-page-title">
        <span>Core integration</span>
        <h1>ServiceTitan connections</h1>
        <p>Manage isolated connection profiles by tenant and assign one or more operating locations. This browser-local demo stores masked metadata only and never contacts ServiceTitan.</p>
      </div>

      <div className="warning-note" role="note">
        <CircleAlert size={17} aria-hidden="true" />
        <strong>Demo environment:</strong> Do not enter production credentials. Validation is local only; no ServiceTitan API call is made.
      </div>

      <div className="kpi-library-summary" aria-label="Connection summary">
        <div><span>Active profiles</span><strong>{counts.active}</strong><p>Tenant-isolated connections</p></div>
        <div><span>Configured</span><strong>{counts.ready}</strong><p>Masked metadata · not live-tested</p></div>
        <div><span>Needs attention</span><strong>{counts.attention}</strong><p>Missing credential metadata</p></div>
        <div><span>Archived</span><strong>{counts.archived}</strong><p>Retained browser-locally</p></div>
      </div>

      <div className="admin-toolbar">
        <div><strong>{activeConnections.length} active connection{activeConnections.length === 1 ? "" : "s"}</strong><span> across {new Set(activeConnections.flatMap((connection) => connection.locationIds)).size} assigned location{new Set(activeConnections.flatMap((connection) => connection.locationIds)).size === 1 ? "" : "s"}</span></div>
        <div className="form-actions">
          <button className="button secondary" type="button" onClick={resetProfiles} aria-label="Reset demo profiles">
            <RotateCcw size={16} aria-hidden="true" /> Reset demo profiles
          </button>
          <button className="button primary" type="button" onClick={beginAdd} aria-label="Add connection">
            <Plus size={16} aria-hidden="true" /> Add connection
          </button>
        </div>
      </div>

      {pageNotice && (
        <div className={`test-result ${pageNotice.kind}`} role={pageNotice.kind === "error" ? "alert" : "status"} aria-live="polite">
          {pageNotice.kind === "ok" ? <CheckCircle2 size={17} aria-hidden="true" /> : <CircleAlert size={17} aria-hidden="true" />}
          {pageNotice.message}
        </div>
      )}

      {formOpen && (
        <section className="admin-card template-editor" aria-label={editing ? `Edit ${editing.displayName} connection profile` : "Add ServiceTitan connection profile"}>
          <div className="template-editor-head">
            <div>
              <span className="editor-kicker">{editing ? "Edit connection profile" : "New connection profile"}</span>
              <h2>{editing ? editing.displayName : "Add ServiceTitan connection"}</h2>
              <p>{editing ? "Leave credential fields blank to retain the masked stored values." : "Create an isolated browser-local profile and assign its operating locations."}</p>
            </div>
            <button className="icon-btn" type="button" onClick={closeForm} aria-label="Close connection form"><X size={19} aria-hidden="true" /></button>
          </div>

          <form onSubmit={saveConnection} noValidate>
            <div className="wizard-main">
              <div className="form-grid">
                <label htmlFor="st-display-name">
                  Display name
                  <input
                    id="st-display-name"
                    name="displayName"
                    value={draft.displayName}
                    onChange={(event) => setField("displayName", event.target.value)}
                    placeholder="e.g. Sierra Home Services"
                    aria-invalid={issuesFor("displayName").length > 0}
                    aria-describedby={issuesFor("displayName").length ? "st-display-name-error" : undefined}
                  />
                  {issuesFor("displayName").map((issue) => <span id="st-display-name-error" key={issue.code}>{issue.message}</span>)}
                </label>
                <label htmlFor="st-tenant-id">
                  Tenant ID
                  <input
                    id="st-tenant-id"
                    name="tenantId"
                    value={draft.tenantId}
                    onChange={(event) => setField("tenantId", event.target.value)}
                    placeholder="ServiceTitan tenant ID"
                    autoComplete="off"
                    aria-invalid={issuesFor("tenantId").length > 0}
                    aria-describedby={issuesFor("tenantId").length ? "st-tenant-id-error" : undefined}
                  />
                  {issuesFor("tenantId").map((issue) => <span id="st-tenant-id-error" key={issue.code}>{issue.message}</span>)}
                </label>
                <label htmlFor="st-environment">
                  Environment
                  <select id="st-environment" name="environment" value={draft.environment} onChange={(event) => setField("environment", event.target.value as ServiceTitanEnvironment)}>
                    <option value="production">Production</option>
                    <option value="integration">Integration</option>
                  </select>
                </label>
                <div />
                <label htmlFor="st-client-id">
                  Client ID
                  <input
                    id="st-client-id"
                    name="clientId"
                    value={draft.clientId}
                    onChange={(event) => setField("clientId", event.target.value)}
                    placeholder={editing?.maskedClientId ? `Stored: ${editing.maskedClientId} · leave blank to retain` : "Application client ID"}
                    autoComplete="off"
                    aria-invalid={issuesFor("clientId").length > 0}
                    aria-describedby={issuesFor("clientId").length ? "st-client-id-error" : editing ? "st-client-id-stored" : undefined}
                  />
                  {editing && <span id="st-client-id-stored">Stored value: {editing.maskedClientId || "not configured"}. Leave blank to retain.</span>}
                  {issuesFor("clientId").map((issue) => <span id="st-client-id-error" key={issue.code}>{issue.message}</span>)}
                </label>
                <label htmlFor="st-app-key">
                  App key
                  <input
                    id="st-app-key"
                    name="appKey"
                    value={draft.appKey}
                    onChange={(event) => setField("appKey", event.target.value)}
                    placeholder={editing?.maskedAppKey ? `Stored: ${editing.maskedAppKey} · leave blank to retain` : "Application key"}
                    autoComplete="off"
                    aria-invalid={issuesFor("appKey").length > 0}
                    aria-describedby={issuesFor("appKey").length ? "st-app-key-error" : editing ? "st-app-key-stored" : undefined}
                  />
                  {editing && <span id="st-app-key-stored">Stored value: {editing.maskedAppKey || "not configured"}. Leave blank to retain.</span>}
                  {issuesFor("appKey").map((issue) => <span id="st-app-key-error" key={issue.code}>{issue.message}</span>)}
                </label>
                <label htmlFor="st-client-secret">
                  Client secret
                  <input
                    id="st-client-secret"
                    name="clientSecret"
                    type="password"
                    value={draft.clientSecret}
                    onChange={(event) => setField("clientSecret", event.target.value)}
                    placeholder={editing ? "Leave blank to retain stored secret" : "Demo value only"}
                    autoComplete="new-password"
                    aria-invalid={issuesFor("clientSecret").length > 0}
                    aria-describedby={issuesFor("clientSecret").length ? "st-client-secret-error" : editing ? "st-client-secret-stored" : undefined}
                  />
                  {editing && <span id="st-client-secret-stored">Stored secret: {editing.secretConfigured ? "•••••••• (configured)" : "not configured"}. It is never prefilled.</span>}
                  {issuesFor("clientSecret").map((issue) => <span id="st-client-secret-error" key={issue.code}>{issue.message}</span>)}
                </label>
              </div>

              <div className="selection-card" role="group" aria-labelledby="st-locations-label" aria-describedby={issuesFor("locationIds").length ? "st-locations-error" : undefined}>
                <strong id="st-locations-label">Operating locations</strong>
                {locations.map((location) => {
                  const owner = assignedLocationOwner.get(location.id);
                  const disabled = Boolean(owner);
                  return (
                    <label key={location.id}>
                      <input
                        type="checkbox"
                        name="locationIds"
                        value={location.id}
                        checked={draft.locationIds.includes(location.id)}
                        disabled={disabled}
                        onChange={() => toggleLocation(location.id)}
                        aria-label={`${location.brand} — ${location.location}${owner ? `, assigned to ${owner.displayName}` : ""}`}
                      />
                      <span><b>{location.brand} — {location.location}</b>{owner ? `Assigned to ${owner.displayName}` : `${location.timezone} · Available`}</span>
                    </label>
                  );
                })}
                {issuesFor("locationIds").map((issue) => <span id="st-locations-error" key={issue.code}>{issue.message}</span>)}
              </div>

              <div className="form-help">
                <ShieldCheck size={16} aria-hidden="true" />
                <span>This prototype persists the tenant, location assignments, status, and masked credential metadata only. Raw credential values and the client secret are never written to browser storage.</span>
              </div>

              {formNotice && (
                <div className={`test-result ${formNotice.kind}`} role={formNotice.kind === "error" ? "alert" : "status"} aria-live="polite">
                  {formNotice.kind === "ok" ? <CheckCircle2 size={17} aria-hidden="true" /> : <CircleAlert size={17} aria-hidden="true" />}
                  {formNotice.message}
                </div>
              )}
            </div>

            <div className="template-editor-footer">
              <span><KeyRound size={15} aria-hidden="true" />Browser-local masked demo profile</span>
              <div>
                <button className="button secondary" type="button" onClick={closeForm}>Cancel</button>
                <button className="button secondary" type="button" onClick={validateDraft} aria-label="Validate demo">
                  <RefreshCw size={15} aria-hidden="true" /> Validate demo
                </button>
                <button className="button primary" type="submit" aria-label={editing ? "Save changes" : "Save connection"}>
                  <Save size={15} aria-hidden="true" /> {editing ? "Save changes" : "Save connection"}
                </button>
              </div>
            </div>
          </form>
        </section>
      )}

      <ConnectionTable
        title="Active profiles"
        eyebrow="Tenant connections"
        connections={activeConnections}
        emptyMessage="No active ServiceTitan connections. Add a profile or restore an archived profile."
        onEdit={beginEdit}
        onArchive={archiveConnection}
        onRestore={restoreConnection}
      />

      <ConnectionTable
        title="Archived profiles"
        eyebrow="Retained configuration"
        connections={archivedConnections}
        emptyMessage="No archived connection profiles."
        onEdit={beginEdit}
        onArchive={archiveConnection}
        onRestore={restoreConnection}
      />

      <div className="admin-grid-two">
        <section className="admin-card">
          <div className="card-title"><div><span>Production boundary</span><h3>Server-side secret custody</h3></div><ShieldCheck aria-hidden="true" /></div>
          <p className="card-copy">A production connector should encrypt credentials in server storage, isolate access by tenant, rotate secrets, and record every profile change in an audit log. Browser state is not a production credential store.</p>
        </section>
        <section className="admin-card sync-card">
          <Database aria-hidden="true" />
          <div><strong>Recommended sync pattern</strong><p>Incremental tenant-scoped API pulls every 15 minutes, nightly reconciliation, and visible freshness and confidence on every KPI.</p></div>
        </section>
      </div>
    </>
  );
}

function ConnectionTable({
  title,
  eyebrow,
  connections,
  emptyMessage,
  onEdit,
  onArchive,
  onRestore,
}: {
  title: string;
  eyebrow: string;
  connections: DemoServiceTitanConnection[];
  emptyMessage: string;
  onEdit: (connection: DemoServiceTitanConnection) => void;
  onArchive: (connection: DemoServiceTitanConnection) => void;
  onRestore: (connection: DemoServiceTitanConnection) => void;
}) {
  return (
    <section className="admin-card library-table">
      <div className="card-title">
        <div><span>{eyebrow}</span><h3>{title}</h3></div>
        <span className="count-pill">{connections.length} profile{connections.length === 1 ? "" : "s"}</span>
      </div>
      {connections.length === 0 ? (
        <div className="small-empty">
          <Building2 aria-hidden="true" />
          <strong>{emptyMessage}</strong>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="custom-kpi-table">
            <thead><tr><th>Profile</th><th>Status</th><th>Environment</th><th>Locations</th><th>Stored credentials</th><th>Last local check</th><th>Actions</th></tr></thead>
            <tbody>
              {connections.map((connection) => (
                <tr key={connection.id}>
                  <td><strong>{connection.displayName}</strong><span>Tenant {connection.tenantId}</span></td>
                  <td><span className={`kpi-status ${statusClass(connection)}`}>{statusLabel(connection)}</span></td>
                  <td>{connection.environment === "production" ? "Production" : "Integration"}</td>
                  <td>{connection.locationIds.map((locationId) => locations.find((location) => location.id === locationId)?.location ?? locationId).join(", ")}<span>{connection.locationIds.length} assigned</span></td>
                  <td><strong>{connection.maskedClientId || "Client ID missing"}</strong><span>{connection.maskedAppKey || "App key missing"} · Secret {connection.secretConfigured ? "configured" : "missing"}</span></td>
                  <td>{formatUpdatedAt(connection.lastValidatedAt)}</td>
                  <td>
                    <div className="catalog-actions">
                      {connection.status === "archived" ? (
                        <button type="button" onClick={() => onRestore(connection)} aria-label={`Restore ${connection.displayName}`}><RotateCcw size={15} aria-hidden="true" />Restore</button>
                      ) : (
                        <>
                          <button type="button" onClick={() => onEdit(connection)} aria-label={`Edit ${connection.displayName}`}><Pencil size={15} aria-hidden="true" />Edit</button>
                          <button className="danger" type="button" onClick={() => onArchive(connection)} aria-label={`Archive ${connection.displayName}`}><Archive size={15} aria-hidden="true" />Archive</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
