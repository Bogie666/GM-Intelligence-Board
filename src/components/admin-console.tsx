"use client";

import {
  ArrowLeft,
  BarChart3,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Database,
  Eye,
  EyeOff,
  FileSpreadsheet,
  KeyRound,
  LayoutGrid,
  LockKeyhole,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Users,
  Webhook,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { locations } from "@/lib/demo-data";
import type { CustomMetricInput, MetricKind, MetricSection, SourceKey } from "@/lib/types";

type AdminTab = "overview" | "locations" | "servicetitan" | "metrics" | "layouts" | "sources";

const tabs: { id: AdminTab; label: string; icon: typeof Settings2 }[] = [
  { id: "overview", label: "Setup overview", icon: Settings2 },
  { id: "locations", label: "Brands & locations", icon: Building2 },
  { id: "servicetitan", label: "ServiceTitan", icon: Database },
  { id: "metrics", label: "KPI library", icon: SlidersHorizontal },
  { id: "layouts", label: "Layouts & access", icon: LayoutGrid },
  { id: "sources", label: "Data sources", icon: Webhook },
];

const sourceRows = [
  ["Completed revenue", "ServiceTitan", "Available", "Jobs + invoices, filtered by mapped business units"],
  ["Budgets / targets", "CSV or finance system", "Configuration", "Not a dependable standard ServiceTitan API source"],
  ["Appointments & capacity", "ServiceTitan", "Available", "Requires status, business unit, and technician mapping"],
  ["Sales close rate", "ServiceTitan", "Available", "Tenant definition required for opportunity and sold status"],
  ["Memberships", "ServiceTitan", "Available", "Tier names, active statuses, cancels, and renewals vary"],
  ["Inbound calls", "ServiceTitan / phone", "Partial", "Call Center API availability and phone routing vary"],
  ["Digital visits", "GA4", "External", "Requires GA4 property and event mapping"],
  ["Digital bookings", "Website + scheduler", "External", "Requires unified booking event and deduplication"],
  ["Equipment age", "ServiceTitan equipment", "Quality dependent", "Only reliable when install dates and equipment records are maintained"],
  ["Forecast", "Derived", "Available", "App-calculated using actuals, pipeline, seasonality, and remaining workdays"],
];

const defaultMetricForm = { title: "", section: "executive" as MetricSection, source: "Custom" as SourceKey, actual: "", goal: "", kind: "number" as MetricKind, subtitle: "Manually maintained KPI" };

export function AdminConsole() {
  const [tab, setTab] = useState<AdminTab>("overview");
  const [showSecret, setShowSecret] = useState(false);
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const [customMetrics, setCustomMetrics] = useState<CustomMetricInput[]>([]);
  const [metricForm, setMetricForm] = useState(defaultMetricForm);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const hydrate = window.setTimeout(() => {
      try { setCustomMetrics(JSON.parse(localStorage.getItem("gmib.custom-metrics.v1") ?? "[]")); } catch { /* safe default */ }
    }, 0);
    return () => window.clearTimeout(hydrate);
  }, []);

  async function testConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setTestState("testing"); setTestMessage("");
    const form = new FormData(event.currentTarget);
    const body = { provider: "servicetitan", tenantId: form.get("tenantId"), clientId: form.get("clientId"), appKey: form.get("appKey") };
    const response = await fetch("/api/integrations/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    setTestState(response.ok ? "ok" : "error"); setTestMessage(result.message);
  }

  function addMetric(event: FormEvent) {
    event.preventDefault();
    const next: CustomMetricInput = {
      id: `custom-${Date.now()}`,
      title: metricForm.title,
      section: metricForm.section,
      source: metricForm.source,
      actual: Number(metricForm.actual),
      goal: metricForm.goal ? Number(metricForm.goal) : undefined,
      kind: metricForm.kind,
      subtitle: metricForm.subtitle,
    };
    const updated = [...customMetrics, next];
    setCustomMetrics(updated); localStorage.setItem("gmib.custom-metrics.v1", JSON.stringify(updated)); setMetricForm(defaultMetricForm);
  }
  function deleteMetric(id: string) {
    const updated = customMetrics.filter((metric) => metric.id !== id);
    setCustomMetrics(updated); localStorage.setItem("gmib.custom-metrics.v1", JSON.stringify(updated));
  }
  function saveConfig() { setSaved(true); window.setTimeout(() => setSaved(false), 1800); }

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
          {tab === "servicetitan" && <ServiceTitanForm showSecret={showSecret} setShowSecret={setShowSecret} testState={testState} testMessage={testMessage} onSubmit={testConnection} />}
          {tab === "metrics" && <MetricLibrary customMetrics={customMetrics} form={metricForm} setForm={setMetricForm} onAdd={addMetric} onDelete={deleteMetric} />}
          {tab === "layouts" && <Layouts />}
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
    { title: "Budgets & KPI targets", copy: "Upload monthly budgets or connect a finance source.", status: "needed", tab: "metrics" },
    { title: "GM layouts", copy: "Default role templates are available for customization.", status: "complete", tab: "layouts" },
    { title: "External data sources", copy: "GA4 and phone-system connectors remain optional.", status: "demo", tab: "sources" },
  ];
  return <>
    <PageTitle eyebrow="Guided setup" title="Portfolio readiness" copy="A handoff-friendly checklist keeps every tenant configured the same way and makes missing dependencies visible." />
    <div className="readiness-card"><div className="readiness-ring"><strong>33%</strong><span>ready</span></div><div><h2>2 of 6 setup groups complete</h2><p>The prototype is operating on labeled demo data. Complete the tenant connection and mapping steps before treating KPIs as operational actuals.</p><div className="readiness-bar"><span style={{width:"33%"}} /></div></div></div>
    <div className="setup-grid">{steps.map((step) => <button className="setup-step" key={step.title} onClick={() => onNavigate(step.tab)}><span className={`step-icon ${step.status}`}>{step.status === "complete" ? <Check size={16} /> : step.status === "demo" ? <CircleAlert size={16} /> : <span />}</span><div><strong>{step.title}</strong><p>{step.copy}</p></div><span className={`setup-status ${step.status}`}>{step.status === "complete" ? "Complete" : step.status === "demo" ? "Demo only" : "Action needed"}</span><ChevronRight size={17} /></button>)}</div>
    <div className="admin-grid-two"><section className="admin-card"><div className="card-title"><div><span>Operating model</span><h3>Configuration, not custom code</h3></div><Settings2 /></div><ul className="check-list"><li><CheckCircle2 />One deployment and schema across the portfolio</li><li><CheckCircle2 />Tenant-isolated credentials and data</li><li><CheckCircle2 />Per-brand mappings, targets, colors, and layouts</li><li><CheckCircle2 />Metric lineage visible to every GM</li></ul></section><section className="admin-card"><div className="card-title"><div><span>Prototype boundary</span><h3>What persists today</h3></div><LockKeyhole /></div><p className="card-copy">Card order, hidden cards, and custom demo metrics persist in this browser. The production phase moves configuration to Postgres with role-based authentication and an audit log.</p><div className="warning-note"><CircleAlert size={17} />Do not enter production secrets in this test deployment.</div></section></div>
  </>;
}

function Locations({ saved, onSave }: { saved: boolean; onSave: () => void }) {
  return <><PageTitle eyebrow="Tenant administration" title="Brands & locations" copy="A tenant is the ServiceTitan data boundary. Each tenant can contain one or more operating locations with their own timezone, budgets, and presentation." />
    <div className="admin-toolbar"><div><strong>{locations.length} locations</strong><span> across {new Set(locations.map((item) => item.tenantId)).size} tenant configurations</span></div><button className="button primary"><Plus size={16} /> Add location</button></div>
    <div className="location-admin-list">{locations.map((location, index) => <section className="location-admin-card" key={location.id}><div className="location-card-head"><div className="brand-avatar" style={{background: location.accentDark, color: "white"}}>{location.initials}</div><div><h3>{location.brand}</h3><p>{location.location} · {location.timezone}</p></div><span className="connection-badge demo"><CircleAlert size={14} /> Demo data</span></div><div className="form-grid"><label>Display name<input defaultValue={location.brand} /></label><label>Location label<input defaultValue={location.location} /></label><label>ServiceTitan tenant<select defaultValue={location.tenantId}><option value={location.tenantId}>{location.tenantId}</option></select></label><label>Timezone<select defaultValue={location.timezone}><option>{location.timezone}</option><option>America/Chicago</option><option>America/Denver</option><option>America/Los_Angeles</option></select></label><label>Primary color<div className="color-input"><input type="color" defaultValue={location.accentDark} /><input defaultValue={location.accentDark} /></div></label><label>Accent color<div className="color-input"><input type="color" defaultValue={location.accent} /><input defaultValue={location.accent} /></div></label></div>{index === 0 && <div className="mapping-summary"><span><CheckCircle2 size={15} /> 6 reporting divisions</span><span><CircleAlert size={15} /> 2 unmapped business units</span><button onClick={() => undefined}>Review mapping</button></div>}</section>)}</div>
    <div className="sticky-save"><span>{saved ? <><CheckCircle2 size={16} /> Changes saved locally</> : "Unsaved prototype edits are browser-local"}</span><button className="button primary" onClick={onSave}><Save size={16} /> Save changes</button></div>
  </>;
}

function ServiceTitanForm({ showSecret, setShowSecret, testState, testMessage, onSubmit }: { showSecret: boolean; setShowSecret: (value: boolean) => void; testState: string; testMessage: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <><PageTitle eyebrow="Core integration" title="ServiceTitan connections" copy="Keep credentials isolated by tenant. The production connector will sync normalized warehouse tables on a schedule rather than querying ServiceTitan during every dashboard load." />
    <div className="integration-layout"><section className="admin-card integration-form"><div className="card-title"><div><span>Connection profile</span><h3>Sierra Home Services</h3></div><span className="connection-badge demo"><CircleAlert size={14} /> Validation only</span></div><form onSubmit={onSubmit}><div className="form-grid"><label>ServiceTitan tenant ID<input name="tenantId" placeholder="e.g. 1234567890" required /></label><label>Client ID<input name="clientId" placeholder="Application client ID" required /></label><label>App key<input name="appKey" placeholder="Application key" required /></label><label>Client secret<div className="password-input"><input type={showSecret ? "text" : "password"} placeholder="Not persisted in demo" /><button type="button" onClick={() => setShowSecret(!showSecret)}>{showSecret ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label></div><div className="form-help"><LockKeyhole size={16} /><span>In production, the secret is encrypted at rest and write-only after save. This prototype deliberately does not store it.</span></div><div className="form-actions"><button className="button secondary" type="submit" disabled={testState === "testing"}><RefreshCw className={testState === "testing" ? "spin" : ""} size={16} />{testState === "testing" ? "Validating…" : "Validate fields"}</button><button className="button primary" type="button" disabled><KeyRound size={16} /> Save encrypted connection</button></div>{testMessage && <div className={`test-result ${testState}`}>{testState === "ok" ? <CheckCircle2 size={17} /> : <XCircle size={17} />}{testMessage}</div>}</form></section>
    <aside><section className="admin-card"><div className="card-title"><div><span>Required after connection</span><h3>Mapping checklist</h3></div><BarChart3 /></div><div className="mapping-steps"><div><span>1</span><div><strong>Business units → divisions</strong><p>Normalize tenant naming without changing ServiceTitan.</p></div></div><div><span>2</span><div><strong>Job statuses & classes</strong><p>Define completed, canceled, opportunity, and recall.</p></div></div><div><span>3</span><div><strong>Membership tiers</strong><p>Map active, suspended, canceled, and recurring value.</p></div></div><div><span>4</span><div><strong>Employee roles</strong><p>Separate technician, CSR, dispatcher, and salesperson.</p></div></div></div></section><section className="admin-card sync-card"><Database /><div><strong>Recommended sync pattern</strong><p>Incremental API pulls every 15 minutes, nightly reconciliation, and visible freshness/confidence on every KPI.</p></div></section></aside></div>
  </>;
}

function MetricLibrary({ customMetrics, form, setForm, onAdd, onDelete }: { customMetrics: CustomMetricInput[]; form: typeof defaultMetricForm; setForm: (value: typeof defaultMetricForm) => void; onAdd: (event: FormEvent) => void; onDelete: (id: string) => void }) {
  return <><PageTitle eyebrow="Metric governance" title="KPI library" copy="Define each KPI once, then override targets, mappings, and visibility by tenant or location. Custom metrics can be added without deploying code." />
    <div className="admin-grid-two metric-admin-grid"><section className="admin-card"><div className="card-title"><div><span>No-code builder</span><h3>Add a custom KPI</h3></div><Plus /></div><form className="metric-form" onSubmit={onAdd}><label>KPI name<input required value={form.title} onChange={(e) => setForm({...form,title:e.target.value})} placeholder="e.g. 5-star review pace" /></label><div className="form-grid"><label>Dashboard tab<select value={form.section} onChange={(e) => setForm({...form,section:e.target.value as MetricSection})}><option value="executive">Executive</option><option value="revenue">Revenue</option><option value="calls">Calls & Digital</option><option value="appointments">Appointments</option><option value="sales">Sales</option><option value="membership">Membership</option></select></label><label>Format<select value={form.kind} onChange={(e) => setForm({...form,kind:e.target.value as MetricKind})}><option value="number">Number</option><option value="currency">Currency</option><option value="percent">Percent</option><option value="ratio">Ratio</option></select></label><label>Current value<input required type="number" step="any" value={form.actual} onChange={(e) => setForm({...form,actual:e.target.value})} /></label><label>Target (optional)<input type="number" step="any" value={form.goal} onChange={(e) => setForm({...form,goal:e.target.value})} /></label><label>Source<select value={form.source} onChange={(e) => setForm({...form,source:e.target.value as SourceKey})}><option>Custom</option><option>ServiceTitan</option><option>Budget</option><option>GA4</option><option>Call System</option><option>Derived</option></select></label><label>Supporting label<input value={form.subtitle} onChange={(e) => setForm({...form,subtitle:e.target.value})} /></label></div><button className="button primary" type="submit"><Plus size={16} /> Add to dashboard</button></form></section>
    <section className="admin-card"><div className="card-title"><div><span>Custom metrics</span><h3>{customMetrics.length} browser-local KPI{customMetrics.length===1?"":"s"}</h3></div><BarChart3 /></div>{customMetrics.length===0?<div className="small-empty"><SlidersHorizontal /><strong>No custom KPIs yet</strong><p>Add one to see it immediately on the selected dashboard tab.</p></div>:<div className="custom-metric-list">{customMetrics.map((metric)=><div key={metric.id}><span className="metric-source-icon">{metric.source.slice(0,1)}</span><div><strong>{metric.title}</strong><p>{metric.section} · {metric.source} · target {metric.goal ?? "not set"}</p></div><button onClick={()=>onDelete(metric.id)}><Trash2 size={16}/></button></div>)}</div>}</section></div>
    <section className="admin-card library-table"><div className="card-title"><div><span>Governed catalog</span><h3>Core metric definitions</h3></div><span className="count-pill">34 configured</span></div><div className="table-scroll"><table><thead><tr><th>Metric</th><th>Definition owner</th><th>Default source</th><th>Target scope</th><th>Visibility</th></tr></thead><tbody>{[["Revenue MTD","Finance","ServiceTitan","Location + division"],["Projected Month-End","Finance","Derived","Location"],["Call Booking Rate","Call Center","ServiceTitan","Location + department"],["Digital Conversion","Marketing","GA4 + booking events","Brand"],["Sales Close Rate","Sales","ServiceTitan","Division + lead type"],["Membership Net Growth","Operations","ServiceTitan","Location"]].map((row)=><tr key={row[0]}>{row.map((cell,index)=><td key={cell}>{index===0?<strong>{cell}</strong>:cell}</td>)}<td><span className="visibility-chip"><Eye size={13}/>GM default</span></td></tr>)}</tbody></table></div></section>
  </>;
}

function Layouts() {
  return <><PageTitle eyebrow="Presentation & access" title="Layouts & role templates" copy="Start from a governed role template, then let each GM reorder approved cards without changing the metric definition." /><div className="admin-grid-three">{[["GM daily view","8 cards","Revenue, booking, sales, membership, capacity"],["Department leader","12 cards","Trade-specific conversion and productivity"],["Executive portfolio","10 cards","Cross-brand summary and variance ranking"]].map((item,index)=><section className="admin-card role-card" key={item[0]}><div className="role-icon">{index===0?<Building2/>:index===1?<Users/>:<BarChart3/>}</div><span className="template-badge">{index===0?"Default":"Template"}</span><h3>{item[0]}</h3><strong>{item[1]}</strong><p>{item[2]}</p><button className="button secondary">Edit template</button></section>)}</div><section className="admin-card access-card"><div className="card-title"><div><span>Access model</span><h3>Recommended production roles</h3></div><ShieldCheck /></div><div className="access-grid"><div><strong>Portfolio admin</strong><p>All tenants, credentials, mappings, budgets, and users.</p></div><div><strong>Brand executive</strong><p>All locations inside assigned tenant; no credential access.</p></div><div><strong>General manager</strong><p>Assigned locations, approved KPI customization, exports.</p></div><div><strong>Department leader</strong><p>Assigned department views; no target or definition edits.</p></div></div></section></>;
}

function Sources() {
  return <><PageTitle eyebrow="Source coverage" title="Data-source readiness" copy="Not every requested KPI belongs in ServiceTitan. This matrix prevents placeholder data from silently becoming an operational metric." /><div className="source-summary"><div><Database/><span><strong>5</strong> ServiceTitan / derived</span></div><div><CircleAlert/><span><strong>3</strong> partial or quality-dependent</span></div><div><Webhook/><span><strong>2</strong> external integrations</span></div></div><section className="admin-card source-matrix"><div className="table-scroll"><table><thead><tr><th>KPI family</th><th>Primary source</th><th>Readiness</th><th>Implementation note</th></tr></thead><tbody>{sourceRows.map((row)=><tr key={row[0]}><td><strong>{row[0]}</strong></td><td>{row[1]}</td><td><span className={`readiness-tag ${row[2].toLowerCase().replaceAll(" ","-")}`}>{row[2]}</span></td><td>{row[3]}</td></tr>)}</tbody></table></div></section><div className="admin-grid-two"><section className="admin-card"><div className="card-title"><div><span>Budget onboarding</span><h3>CSV template first</h3></div><FileSpreadsheet /></div><p className="card-copy">A governed monthly upload is safer than pretending ServiceTitan contains financial budgets. Later, replace the import with an ERP connector without changing dashboard definitions.</p><button className="button secondary" disabled>Download template · production phase</button></section><section className="admin-card"><div className="card-title"><div><span>Integration contract</span><h3>Every source reports confidence</h3></div><ShieldCheck /></div><ul className="check-list"><li><CheckCircle2 />Freshness timestamp</li><li><CheckCircle2 />Completeness and unmapped-record count</li><li><CheckCircle2 />Last successful reconciliation</li><li><CheckCircle2 />Visible degraded-state messaging</li></ul></section></div></>;
}
