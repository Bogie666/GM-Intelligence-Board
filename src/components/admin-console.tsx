"use client";

import {
  Archive,
  ArrowLeft,
  BarChart3,
  Copy,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Database,
  Eye,
  FileSpreadsheet,
  KeyRound,
  LayoutGrid,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  Trash2,
  Users,
  Webhook,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getMetrics, locations, sectionMeta } from "@/lib/demo-data";
import { cloneTemplate, defaultRoleTemplates, metricSections, moveTemplateMetric, normalizeRoleTemplates, ROLE_TEMPLATE_STORAGE_KEY } from "@/lib/layout-templates";
import { createKpiId, customKpiToMetric, duplicateCustomKpiDefinition, evaluateCustomKpis, readCustomKpiStore, writeCustomKpiStore, type CustomKpiDefinition, type CustomKpiStore } from "@/lib/custom-kpis";
import { KpiWizard } from "@/components/kpi-wizard";
import { ServiceTitanConnections } from "@/components/service-titan-connections";
import { TargetsAndBudgets } from "@/components/targets-and-budgets";
import type { LayoutTemplate, Metric, MetricSection } from "@/lib/types";

type AdminTab = "overview" | "locations" | "servicetitan" | "targets" | "domo" | "metrics" | "layouts" | "sources";
type TestState = "idle" | "testing" | "ok" | "error";

const tabs: { id: AdminTab; label: string; icon: typeof Settings2 }[] = [
  { id: "overview", label: "Setup overview", icon: Settings2 },
  { id: "locations", label: "Brands & locations", icon: Building2 },
  { id: "servicetitan", label: "ServiceTitan", icon: Database },
  { id: "targets", label: "Targets & budgets", icon: Target },
  { id: "domo", label: "Domo", icon: FileSpreadsheet },
  { id: "metrics", label: "KPI library", icon: SlidersHorizontal },
  { id: "layouts", label: "Layouts & access", icon: LayoutGrid },
  { id: "sources", label: "Data sources", icon: Webhook },
];

const sourceRows = [
  ["Completed revenue", "ServiceTitan", "Available", "Jobs + invoices, filtered by mapped business units"],
  ["Historical financial actuals", "Domo", "Framework ready", "OAuth client, dataset metadata, allowlisting, and CSV export are scaffolded"],
  ["Budgets / targets", "Domo, CSV, or finance system", "Configuration", "Not a dependable standard ServiceTitan API source"],
  ["Appointments & capacity", "ServiceTitan", "Available", "Requires status, business unit, and technician mapping"],
  ["Sales close rate", "ServiceTitan", "Available", "Tenant definition required for opportunity and sold status"],
  ["Memberships", "ServiceTitan", "Available", "Tier names, active statuses, cancels, and renewals vary"],
  ["Inbound calls", "ServiceTitan / phone", "Partial", "Call Center API availability and phone routing vary"],
  ["Digital visits", "GA4", "External", "Requires GA4 property and event mapping"],
  ["Digital bookings", "Website + scheduler", "External", "Requires unified booking event and deduplication"],
  ["Equipment age", "ServiceTitan equipment", "Quality dependent", "Only reliable when install dates and equipment records are maintained"],
  ["Forecast", "Derived", "Available", "App-calculated using actuals, pipeline, seasonality, and remaining workdays"],
];

export function AdminConsole() {
  const [tab, setTab] = useState<AdminTab>("overview");
  const [domoTestState, setDomoTestState] = useState<TestState>("idle");
  const [domoTestMessage, setDomoTestMessage] = useState("");
  const [customKpiStore, setCustomKpiStore] = useState<CustomKpiStore>({ schemaVersion: 2, definitions: [] });
  const [editingKpi, setEditingKpi] = useState<CustomKpiDefinition | undefined>();
  const [showKpiWizard, setShowKpiWizard] = useState(false);
  const [roleTemplates, setRoleTemplates] = useState<LayoutTemplate[]>(defaultRoleTemplates);
  const [saved, setSaved] = useState(false);
  const [templateSaved, setTemplateSaved] = useState(false);

  useEffect(() => {
    const hydrate = window.setTimeout(() => {
      const store = readCustomKpiStore(localStorage, new Date().toISOString());
      setCustomKpiStore(store);
      const customIds = store.definitions.filter((item) => item.status === "published").map((item) => item.id);
      try { setRoleTemplates(normalizeRoleTemplates(JSON.parse(localStorage.getItem(ROLE_TEMPLATE_STORAGE_KEY) ?? "[]"), customIds)); } catch { setRoleTemplates(normalizeRoleTemplates([], customIds)); }
    }, 0);
    return () => window.clearTimeout(hydrate);
  }, []);


  async function testDomoConnection() {
    setDomoTestState("testing");
    setDomoTestMessage("");
    try {
      const response = await fetch("/api/integrations/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "domo" }),
      });
      const result = await response.json();
      setDomoTestState(result.ok ? "ok" : "error");
      setDomoTestMessage(result.message ?? "Domo validation returned no message.");
    } catch {
      setDomoTestState("error");
      setDomoTestMessage("Domo validation endpoint could not be reached.");
    }
  }

  function persistCustomDefinitions(definitions: CustomKpiDefinition[]) {
    const next = { ...customKpiStore, schemaVersion: 2 as const, definitions };
    setCustomKpiStore(next);
    writeCustomKpiStore(localStorage, next);
  }
  function saveCustomKpi(definition: CustomKpiDefinition) {
    const definitions = customKpiStore.definitions.some((item) => item.id === definition.id)
      ? customKpiStore.definitions.map((item) => item.id === definition.id ? definition : item)
      : [...customKpiStore.definitions, definition];
    persistCustomDefinitions(definitions);
    if (definition.status === "published") {
      const updatedTemplates = roleTemplates.map((template) => {
        const sections = Object.fromEntries(metricSections.map((section) => [section, template.sections[section].filter((id) => id !== definition.id)])) as LayoutTemplate["sections"];
        if (definition.templateIds.includes(template.id)) sections[definition.section] = [...sections[definition.section], definition.id];
        return { ...template, sections, updatedAt: new Date().toISOString() };
      });
      setRoleTemplates(updatedTemplates);
      localStorage.setItem(ROLE_TEMPLATE_STORAGE_KEY, JSON.stringify(updatedTemplates));
    }
    setEditingKpi(undefined);
    setShowKpiWizard(false);
  }
  function archiveCustomKpi(id: string) {
    if (!window.confirm("Archive this KPI? It will be removed from assigned dashboards but retained in the browser-local catalog.")) return;
    const definitions = customKpiStore.definitions.map((item) => item.id === id ? { ...item, status: "archived" as const, updatedAt: new Date().toISOString() } : item);
    persistCustomDefinitions(definitions);
    const updatedTemplates = roleTemplates.map((template) => ({ ...template, sections: Object.fromEntries(metricSections.map((section) => [section, template.sections[section].filter((metricId) => metricId !== id)])) as LayoutTemplate["sections"] }));
    setRoleTemplates(updatedTemplates);
    localStorage.setItem(ROLE_TEMPLATE_STORAGE_KEY, JSON.stringify(updatedTemplates));
  }
  function deleteDraftKpi(id: string) {
    if (!window.confirm("Delete this unpublished draft? This cannot be undone.")) return;
    persistCustomDefinitions(customKpiStore.definitions.filter((item) => item.id !== id));
  }
  function duplicateCustomKpi(definition: CustomKpiDefinition) {
    const now = new Date().toISOString();
    setEditingKpi(duplicateCustomKpiDefinition(definition, createKpiId(), now));
    setShowKpiWizard(true);
  }
  function saveConfig() { setSaved(true); window.setTimeout(() => setSaved(false), 1800); }
  function saveRoleTemplate(template: LayoutTemplate) {
    const updated = roleTemplates.map((item) => item.id === template.id ? { ...cloneTemplate(template), updatedAt: new Date().toISOString() } : item);
    setRoleTemplates(updated);
    localStorage.setItem(ROLE_TEMPLATE_STORAGE_KEY, JSON.stringify(updated));
    setTemplateSaved(true);
    window.setTimeout(() => setTemplateSaved(false), 2200);
  }

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand"><div className="cg-mark">CG</div><div><strong>GM Intelligence</strong><span>Admin Center</span></div></div>
        <Link className="back-link" href="/"><ArrowLeft size={16} /> Back to dashboard</Link>
        <nav>{tabs.map(({ id, label, icon: Icon }) => <button className={tab === id ? "active" : ""} key={id} onClick={() => setTab(id)}><Icon size={18} />{label}<ChevronRight size={15} /></button>)}</nav>
        <div className="admin-security"><ShieldCheck size={18} /><div><strong>Configuration boundary</strong><span>Production secrets belong in encrypted server storage, never browser state.</span></div></div>
      </aside>

      <main className="admin-main">
        <header className="admin-topbar"><div><span>Champions Group portfolio</span><strong>Configuration workspace</strong></div><div><span className="environment-pill">Test environment</span><div className="user-avatar">RM</div></div></header>
        <div className="admin-content">
          {tab === "overview" && <Overview onNavigate={setTab} />}
          {tab === "locations" && <Locations saved={saved} onSave={saveConfig} />}
          {tab === "servicetitan" && <ServiceTitanConnections />}
          {tab === "targets" && <TargetsAndBudgets />}
          {tab === "domo" && <DomoIntegration testState={domoTestState} testMessage={domoTestMessage} onTest={testDomoConnection} />}
          {tab === "metrics" && <MetricLibrary definitions={customKpiStore.definitions} templates={roleTemplates} editing={editingKpi} showWizard={showKpiWizard} onCreate={() => { setEditingKpi(undefined); setShowKpiWizard(true); }} onEdit={(definition) => { setEditingKpi(definition); setShowKpiWizard(true); }} onCancel={() => { setEditingKpi(undefined); setShowKpiWizard(false); }} onSave={saveCustomKpi} onArchive={archiveCustomKpi} onDelete={deleteDraftKpi} onDuplicate={duplicateCustomKpi} />}
          {tab === "layouts" && <Layouts templates={roleTemplates} customDefinitions={customKpiStore.definitions} saved={templateSaved} onSave={saveRoleTemplate} />}
          {tab === "sources" && <Sources />}
        </div>
      </main>
    </div>
  );
}

function PageTitle({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) {
  return <div className="admin-page-title"><span>{eyebrow}</span><h1>{title}</h1><p>{copy}</p></div>;
}

function Overview({ onNavigate }: { onNavigate: (tab: AdminTab) => void }) {
  const steps: { title: string; copy: string; status: "complete" | "demo" | "needed"; tab: AdminTab }[] = [
    { title: "Portfolio structure", copy: "3 demo brands and locations are configured.", status: "complete", tab: "locations" },
    { title: "ServiceTitan credentials", copy: "Add one isolated connection per tenant.", status: "demo", tab: "servicetitan" },
    { title: "Business-unit mapping", copy: "Map every ServiceTitan unit to a reporting division.", status: "needed", tab: "servicetitan" },
    { title: "Targets & revenue budgets", copy: "Publish location, trade, and service-line goals with effective dates.", status: "demo", tab: "targets" },
    { title: "Governed KPI definitions", copy: "Confirm formulas, denominators, exclusions, owners, and lineage.", status: "needed", tab: "metrics" },
    { title: "GM layouts", copy: "Default role templates are available for customization.", status: "complete", tab: "layouts" },
    { title: "External data sources", copy: "Domo framework is ready; GA4 and phone connectors remain optional.", status: "demo", tab: "sources" },
  ];
  return <>
    <PageTitle eyebrow="Guided setup" title="Portfolio readiness" copy="A handoff-friendly checklist keeps every tenant configured the same way and makes missing dependencies visible." />
    <div className="readiness-card"><div className="readiness-ring"><strong>29%</strong><span>ready</span></div><div><h2>2 of 7 setup groups complete</h2><p>The prototype is operating on labeled demo data. Complete the tenant connection, mappings, targets, and budget steps before treating KPIs as operational actuals.</p><div className="readiness-bar"><span style={{width:"29%"}} /></div></div></div>
    <div className="setup-grid">{steps.map((step) => <button className="setup-step" key={step.title} onClick={() => onNavigate(step.tab)}><span className={`step-icon ${step.status}`}>{step.status === "complete" ? <Check size={16} /> : step.status === "demo" ? <CircleAlert size={16} /> : <span />}</span><div><strong>{step.title}</strong><p>{step.copy}</p></div><span className={`setup-status ${step.status}`}>{step.status === "complete" ? "Complete" : step.status === "demo" ? "Demo only" : "Action needed"}</span><ChevronRight size={17} /></button>)}</div>
    <div className="admin-grid-two"><section className="admin-card"><div className="card-title"><div><span>Operating model</span><h3>Configuration, not custom code</h3></div><Settings2 /></div><ul className="check-list"><li><CheckCircle2 />One deployment and schema across the portfolio</li><li><CheckCircle2 />Tenant-isolated credentials and data</li><li><CheckCircle2 />Per-brand mappings, targets, colors, and layouts</li><li><CheckCircle2 />Metric lineage visible to every GM</li></ul></section><section className="admin-card"><div className="card-title"><div><span>Prototype boundary</span><h3>What persists today</h3></div><LockKeyhole /></div><p className="card-copy">Connection profiles, target rules, revenue budgets, card layouts, and custom demo metrics persist in this browser. Raw secrets are discarded. Production moves the same configuration concepts to Postgres with RBAC, encryption, and an audit log.</p><div className="warning-note"><CircleAlert size={17} />Do not enter production secrets in this test deployment.</div></section></div>
  </>;
}

function Locations({ saved, onSave }: { saved: boolean; onSave: () => void }) {
  return <><PageTitle eyebrow="Tenant administration" title="Brands & locations" copy="A tenant is the ServiceTitan data boundary. Each tenant can contain one or more operating locations with their own timezone, budgets, and presentation." />
    <div className="admin-toolbar"><div><strong>{locations.length} locations</strong><span> across {new Set(locations.map((item) => item.tenantId)).size} tenant configurations</span></div><button className="button primary"><Plus size={16} /> Add location</button></div>
    <div className="location-admin-list">{locations.map((location, index) => <section className="location-admin-card" key={location.id}><div className="location-card-head"><div className="brand-avatar" style={{background: location.accentDark, color: "white"}}>{location.initials}</div><div><h3>{location.brand}</h3><p>{location.location} · {location.timezone}</p></div><span className="connection-badge demo"><CircleAlert size={14} /> Demo data</span></div><div className="form-grid"><label>Display name<input defaultValue={location.brand} /></label><label>Location label<input defaultValue={location.location} /></label><label>ServiceTitan tenant<select defaultValue={location.tenantId}><option value={location.tenantId}>{location.tenantId}</option></select></label><label>Timezone<select defaultValue={location.timezone}><option>{location.timezone}</option><option>America/Chicago</option><option>America/Denver</option><option>America/Los_Angeles</option></select></label><label>Primary color<div className="color-input"><input type="color" defaultValue={location.accentDark} /><input defaultValue={location.accentDark} /></div></label><label>Accent color<div className="color-input"><input type="color" defaultValue={location.accent} /><input defaultValue={location.accent} /></div></label></div>{index === 0 && <div className="mapping-summary"><span><CheckCircle2 size={15} /> 6 reporting divisions</span><span><CircleAlert size={15} /> 2 unmapped business units</span><button onClick={() => undefined}>Review mapping</button></div>}</section>)}</div>
    <div className="sticky-save"><span>{saved ? <><CheckCircle2 size={16} /> Changes saved locally</> : "Unsaved prototype edits are browser-local"}</span><button className="button primary" onClick={onSave}><Save size={16} /> Save changes</button></div>
  </>;
}

function DomoIntegration({ testState, testMessage, onTest }: { testState: TestState; testMessage: string; onTest: () => void }) {
  return <>
    <PageTitle eyebrow="Financial data integration" title="Domo datasets" copy="Use Domo as a governed historical and financial source without exposing OAuth credentials or querying Domo during every dashboard load." />
    <div className="integration-layout">
      <section className="admin-card integration-form">
        <div className="card-title"><div><span>Server-side connector</span><h3>Domo DataSet API</h3></div><span className="connection-badge ready"><CheckCircle2 size={14} /> Framework ready</span></div>
        <div className="form-grid">
          <label>API base URL<input readOnly value="https://api.domo.com" /></label>
          <label>OAuth grant<input readOnly value="Client credentials · data scope" /></label>
          <label>Dataset access<input readOnly value="Explicit server-side allowlist" /></label>
          <label>Initial extraction<input readOnly value="Metadata + CSV export" /></label>
        </div>
        <div className="form-help"><LockKeyhole size={16} /><span>The browser never receives the Domo client secret or access token. Dataset reads are denied unless the ID appears in <code>DOMO_ALLOWED_DATASET_IDS</code>.</span></div>
        <div className="form-actions"><button className="button secondary" type="button" disabled={testState === "testing"} onClick={onTest}><RefreshCw className={testState === "testing" ? "spin" : ""} size={16} />{testState === "testing" ? "Checking…" : "Check server configuration"}</button></div>
        {testMessage && <div className={`test-result ${testState}`}>{testState === "ok" ? <CheckCircle2 size={17} /> : <XCircle size={17} />}{testMessage}</div>}
      </section>
      <aside>
        <section className="admin-card"><div className="card-title"><div><span>Required environment</span><h3>OAuth and data boundary</h3></div><KeyRound /></div><ul className="env-list"><li><code>DOMO_CLIENT_ID</code><span>OAuth client ID with the Domo data scope</span></li><li><code>DOMO_CLIENT_SECRET</code><span>Server-only OAuth secret</span></li><li><code>DOMO_ALLOWED_DATASET_IDS</code><span>Comma-separated dataset IDs approved for this app</span></li><li><code>Authenticated admin RBAC</code><span>Required before any live connection-test or dataset-discovery endpoint is enabled</span></li></ul></section>
        <section className="admin-card sync-card"><FileSpreadsheet /><div><strong>Recommended Domo pattern</strong><p>Pull allowlisted datasets on a schedule, normalize center/date/account dimensions, reconcile row counts and totals, then materialize KPI snapshots with source freshness.</p></div></section>
      </aside>
    </div>
    <div className="domo-capability-grid">
      <section className="admin-card"><Database /><div><strong>Dataset catalog</strong><p>List and inspect Domo dataset metadata through OAuth.</p></div></section>
      <section className="admin-card"><FileSpreadsheet /><div><strong>Historical extracts</strong><p>Export allowlisted dataset rows as CSV for controlled ingestion.</p></div></section>
      <section className="admin-card"><ShieldCheck /><div><strong>Least privilege</strong><p>Deny dataset reads unless the dataset ID is explicitly approved.</p></div></section>
      <section className="admin-card"><RefreshCw /><div><strong>Future sync worker</strong><p>Designed for scheduled snapshots, reconciliation, and stale-source alerts.</p></div></section>
    </div>
  </>;
}

function MetricLibrary({ definitions, templates, editing, showWizard, onCreate, onEdit, onCancel, onSave, onArchive, onDelete, onDuplicate }: { definitions: CustomKpiDefinition[]; templates: LayoutTemplate[]; editing?: CustomKpiDefinition; showWizard: boolean; onCreate: () => void; onEdit: (definition: CustomKpiDefinition) => void; onCancel: () => void; onSave: (definition: CustomKpiDefinition) => void; onArchive: (id: string) => void; onDelete: (id: string) => void; onDuplicate: (definition: CustomKpiDefinition) => void }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | CustomKpiDefinition["status"]>("all");
  const catalog = getMetrics(locations[0]);
  const evaluations = useMemo(() => evaluateCustomKpis(definitions, catalog), [definitions, catalog]);
  const filtered = definitions.filter((definition) => (statusFilter === "all" || definition.status === statusFilter) && `${definition.title} ${definition.key} ${definition.owner}`.toLowerCase().includes(query.toLowerCase()));
  const counts = { draft: definitions.filter((item) => item.status === "draft").length, published: definitions.filter((item) => item.status === "published").length, archived: definitions.filter((item) => item.status === "archived").length };

  if (showWizard) return <><PageTitle eyebrow="Metric governance" title="KPI builder" copy="Create a governed KPI definition, validate its source and calculation, assign role templates, and publish it to this browser-local test environment." /><KpiWizard initial={editing} catalog={catalog} definitions={definitions} locations={locations} templates={templates} onSaveDraft={onSave} onPublish={onSave} onCancel={onCancel} /></>;

  return <><PageTitle eyebrow="Metric governance" title="KPI library" copy="Core definitions stay governed. New KPIs move through definition, scope, source, calculation, validation, and publication before they can reach a dashboard." />
    <div className="kpi-library-summary"><div><span>Core catalog</span><strong>{catalog.length}</strong><p>Governed definitions</p></div><div><span>Published custom</span><strong>{counts.published}</strong><p>Available to assigned templates</p></div><div><span>Drafts</span><strong>{counts.draft}</strong><p>Not visible on dashboards</p></div><div><span>Archived</span><strong>{counts.archived}</strong><p>Retained for lineage</p></div></div>
    <section className="admin-card custom-kpi-catalog"><div className="custom-kpi-toolbar"><div><span>Custom KPI catalog</span><h3>Governed browser-local definitions</h3></div><button className="button primary" onClick={onCreate}><Plus size={16}/>Create KPI</button></div>
      <div className="catalog-filters"><label>Search<input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Name, key, or owner" /></label><label>Status<select value={statusFilter} onChange={(event)=>setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">All statuses</option><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></label><span>{filtered.length} result{filtered.length===1?"":"s"}</span></div>
      {filtered.length === 0 ? <div className="small-empty"><SlidersHorizontal/><strong>{definitions.length ? "No KPIs match these filters" : "No custom KPIs yet"}</strong><p>{definitions.length ? "Adjust the search or status filter." : "Start with a governed variant, derived formula, manual KPI, or external-source definition."}</p>{!definitions.length && <button className="button primary" onClick={onCreate}><Plus size={15}/>Create first KPI</button>}</div> : <div className="table-scroll"><table className="custom-kpi-table"><thead><tr><th>KPI</th><th>Status</th><th>Type / owner</th><th>Scope</th><th>Validation</th><th>Templates</th><th>Actions</th></tr></thead><tbody>{filtered.map((definition)=>{const evaluation=evaluations.get(definition.id);const validationFailed=definition.validationChecks.some((check)=>check.status==="fail");return <tr key={definition.id}><td><strong>{definition.title}</strong><span>{definition.key} · v{definition.version}</span></td><td><span className={`kpi-status ${definition.status}`}>{definition.status}</span></td><td>{definition.type}<span>{definition.owner || "Owner not assigned"}</span></td><td>{definition.scopeMode === "portfolio" ? "Portfolio" : `${definition.locationIds.length} locations`}</td><td><span className={`validation-chip ${validationFailed ? "fail" : definition.validatedAt ? "pass" : "pending"}`}>{validationFailed ? "Failed" : definition.validatedAt ? "Validated" : "Not run"}</span><span>{evaluation?.state === "unavailable" ? evaluation.reason : "Preview available"}</span></td><td>{definition.templateIds.length}</td><td><div className="catalog-actions"><button aria-label={`Edit ${definition.title}`} onClick={()=>onEdit(definition)}><Pencil size={15}/>Edit</button><button aria-label={`Duplicate ${definition.title}`} onClick={()=>onDuplicate(definition)}><Copy size={15}/>Duplicate</button>{definition.status === "draft" ? <button className="danger" aria-label={`Delete ${definition.title}`} onClick={()=>onDelete(definition.id)}><Trash2 size={15}/>Delete</button> : definition.status === "published" ? <button className="danger" aria-label={`Archive ${definition.title}`} onClick={()=>onArchive(definition.id)}><Archive size={15}/>Archive</button> : null}</div></td></tr>})}</tbody></table></div>}
    </section>
    <section className="admin-card library-table"><div className="card-title"><div><span>Governed catalog</span><h3>Core metric definitions</h3></div><span className="count-pill">{catalog.length} configured</span></div><div className="table-scroll"><table><thead><tr><th>Metric</th><th>Definition owner</th><th>Default source</th><th>Target scope</th><th>Visibility</th></tr></thead><tbody>{[["Revenue MTD","Finance","ServiceTitan","Location + division"],["Projected Month-End","Finance","Derived","Location"],["Call Booking Rate","Call Center","ServiceTitan","Location + department"],["Digital Conversion","Marketing","GA4 + booking events","Brand"],["Sales Close Rate","Sales","ServiceTitan","Division + lead type"],["Membership Net Growth","Operations","ServiceTitan","Location"]].map((row)=><tr key={row[0]}>{row.map((cell,index)=><td key={cell}>{index===0?<strong>{cell}</strong>:cell}</td>)}<td><span className="visibility-chip"><Eye size={13}/>GM default</span></td></tr>)}</tbody></table></div></section>
  </>;
}

function Layouts({ templates, customDefinitions, saved, onSave }: { templates: LayoutTemplate[]; customDefinitions: CustomKpiDefinition[]; saved: boolean; onSave: (template: LayoutTemplate) => void }) {
  const [editingId, setEditingId] = useState<LayoutTemplate["id"] | null>(null);
  const [selectedSection, setSelectedSection] = useState<MetricSection>("executive");
  const [draft, setDraft] = useState<LayoutTemplate | null>(null);
  const coreCatalog = getMetrics(locations[0]);
  const evaluations = evaluateCustomKpis(customDefinitions, coreCatalog);
  const customCatalog = customDefinitions.map((definition) => customKpiToMetric(definition, evaluations.get(definition.id) ?? { state: "unavailable", sparkline: [], source: "Custom", lineage: [], reason: "Unavailable" })).filter((metric): metric is Metric => Boolean(metric));
  const catalog = [...coreCatalog, ...customCatalog];

  function beginEdit(template: LayoutTemplate) {
    setDraft(cloneTemplate(template));
    setSelectedSection("executive");
    setEditingId(template.id);
  }

  function toggleMetric(metricId: string) {
    if (!draft) return;
    const current = draft.sections[selectedSection];
    const next = current.includes(metricId) ? current.filter((id) => id !== metricId) : [...current, metricId];
    setDraft({ ...draft, sections: { ...draft.sections, [selectedSection]: next } });
  }

  function moveMetric(metricId: string, direction: -1 | 1) {
    if (!draft) return;
    setDraft({
      ...draft,
      sections: {
        ...draft.sections,
        [selectedSection]: moveTemplateMetric(draft.sections[selectedSection], metricId, direction),
      },
    });
  }

  function resetSection() {
    if (!draft) return;
    const fallback = defaultRoleTemplates.find((template) => template.id === draft.id);
    if (!fallback) return;
    setDraft({ ...draft, sections: { ...draft.sections, [selectedSection]: [...fallback.sections[selectedSection]] } });
  }

  const selectedIds = draft?.sections[selectedSection] ?? [];
  const sectionCatalog = catalog.filter((metric) => metric.section === selectedSection);
  const orderedCatalog = [
    ...selectedIds.map((id) => sectionCatalog.find((metric) => metric.id === id)).filter((metric): metric is Metric => Boolean(metric)),
    ...sectionCatalog.filter((metric) => !selectedIds.includes(metric.id)),
  ];

  return <>
    <PageTitle eyebrow="Presentation & access" title="Layouts & role templates" copy="Edit the governed role template, choose the KPIs each dashboard tab should contain, and set their default order. GMs can still make approved personal layout changes." />
    <div className="admin-grid-three">{templates.map((template,index)=>{
      const total = metricSections.reduce((sum, section) => sum + template.sections[section].length, 0);
      return <section className={`admin-card role-card ${editingId === template.id ? "selected" : ""}`} key={template.id}>
        <div className="role-icon">{index===0?<Building2/>:index===1?<Users/>:<BarChart3/>}</div>
        <span className="template-badge">{index===0?"GM default":"Role template"}</span>
        <h3>{template.name}</h3><strong>{total} KPI placements</strong><p>{template.description}</p>
        <button className="button secondary" onClick={() => beginEdit(template)}>Edit template</button>
      </section>;
    })}</div>

    {draft && <section className="admin-card template-editor" aria-label={`Edit ${draft.name}`}>
      <div className="template-editor-head">
        <div><span className="editor-kicker">Editing role template</span><h2>{draft.name}</h2><p>Changes become the browser-local default for this role after you save.</p></div>
        <button className="icon-btn" aria-label="Close template editor" onClick={() => { setDraft(null); setEditingId(null); }}><XCircle size={19} /></button>
      </div>
      <div className="template-editor-fields">
        <label>Template name<input value={draft.name} onChange={(event) => setDraft({...draft,name:event.target.value})} /></label>
        <label>Description<input value={draft.description} onChange={(event) => setDraft({...draft,description:event.target.value})} /></label>
      </div>
      <div className="template-section-tabs" role="tablist">{metricSections.map((section) => <button role="tab" aria-selected={selectedSection === section} className={selectedSection === section ? "active" : ""} key={section} onClick={() => setSelectedSection(section)}>{sectionMeta[section].label}<span>{draft.sections[section].length}</span></button>)}</div>
      <div className="template-editor-toolbar"><div><strong>{sectionMeta[selectedSection].label}</strong><span>{selectedIds.length} of {sectionCatalog.length} KPIs enabled</span></div><button onClick={resetSection}><RotateCcw size={14}/>Reset this tab</button></div>
      <div className="template-metric-list">{orderedCatalog.map((metric) => {
        const enabled = selectedIds.includes(metric.id);
        const position = selectedIds.indexOf(metric.id);
        return <div className={enabled ? "enabled" : ""} key={metric.id}>
          <button className={`metric-toggle ${enabled ? "checked" : ""}`} aria-label={`${enabled ? "Remove" : "Add"} ${metric.title}`} aria-pressed={enabled} onClick={() => toggleMetric(metric.id)}>{enabled && <Check size={14}/>}</button>
          <div className="template-metric-copy"><strong>{metric.title}</strong><span>{metric.source} · {metric.subtitle}</span></div>
          <span className="template-order">{enabled ? `#${position + 1}` : "Hidden"}</span>
          <div className="template-move-actions"><button aria-label={`Move ${metric.title} up`} disabled={!enabled || position === 0} onClick={() => moveMetric(metric.id,-1)}><ChevronUp size={15}/></button><button aria-label={`Move ${metric.title} down`} disabled={!enabled || position === selectedIds.length - 1} onClick={() => moveMetric(metric.id,1)}><ChevronDown size={15}/></button></div>
        </div>;
      })}</div>
      <div className="template-editor-footer"><span>{saved ? <><CheckCircle2 size={15}/>Template saved. Dashboard defaults updated.</> : "Unsaved template changes"}</span><div><button className="button secondary" onClick={() => { setDraft(null); setEditingId(null); }}>Cancel</button><button className="button primary" onClick={() => onSave(draft)}><Save size={15}/>Save template</button></div></div>
    </section>}

    <section className="admin-card access-card"><div className="card-title"><div><span>Access model</span><h3>Recommended production roles</h3></div><ShieldCheck /></div><div className="access-grid"><div><strong>Portfolio admin</strong><p>All tenants, credentials, mappings, budgets, and users.</p></div><div><strong>Brand executive</strong><p>All locations inside assigned tenant; no credential access.</p></div><div><strong>General manager</strong><p>Assigned locations, approved KPI customization, exports.</p></div><div><strong>Department leader</strong><p>Assigned department views; no target or definition edits.</p></div></div></section>
  </>;
}

function Sources() {
  return <><PageTitle eyebrow="Source coverage" title="Data-source readiness" copy="Not every requested KPI belongs in ServiceTitan. This matrix prevents placeholder data from silently becoming an operational metric." /><div className="source-summary"><div><Database/><span><strong>5</strong> ServiceTitan / derived</span></div><div><CircleAlert/><span><strong>3</strong> partial or quality-dependent</span></div><div><Webhook/><span><strong>3</strong> external or framework</span></div></div><section className="admin-card source-matrix"><div className="table-scroll"><table><thead><tr><th>KPI family</th><th>Primary source</th><th>Readiness</th><th>Implementation note</th></tr></thead><tbody>{sourceRows.map((row)=><tr key={row[0]}><td><strong>{row[0]}</strong></td><td>{row[1]}</td><td><span className={`readiness-tag ${row[2].toLowerCase().replaceAll(" ","-")}`}>{row[2]}</span></td><td>{row[3]}</td></tr>)}</tbody></table></div></section><div className="admin-grid-two"><section className="admin-card"><div className="card-title"><div><span>Financial onboarding</span><h3>Domo dataset or governed CSV</h3></div><FileSpreadsheet /></div><p className="card-copy">Use Domo for approved historical and financial datasets when available. Keep CSV as a controlled fallback, with the same center/date/account mapping so dashboard definitions do not change with the transport.</p><button className="button secondary" disabled>Configure Domo mapping · production phase</button></section><section className="admin-card"><div className="card-title"><div><span>Integration contract</span><h3>Every source reports confidence</h3></div><ShieldCheck /></div><ul className="check-list"><li><CheckCircle2 />Freshness timestamp</li><li><CheckCircle2 />Completeness and unmapped-record count</li><li><CheckCircle2 />Last successful reconciliation</li><li><CheckCircle2 />Visible degraded-state messaging</li></ul></section></div></>;
}
