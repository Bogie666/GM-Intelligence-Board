"use client";

import {
  Archive,
  CheckCircle2,
  CircleAlert,
  Copy,
  DollarSign,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Target,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { locations } from "@/lib/demo-data";
import {
  createBudgetRecordId,
  createSeedTargetBudgetStore,
  createTargetRuleId,
  DEMO_AS_OF_DATE,
  DEMO_FISCAL_MONTH,
  readTargetBudgetStore,
  resetTargetBudgetStore,
  supersedeTargetRulesForPublication,
  TARGET_METRIC_SCOPES,
  validateBudgetRecord,
  validateTargetRule,
  writeTargetBudgetStore,
  type BudgetRecord,

  type RevenueMetricId,
  type TargetBudgetStore,
  type TargetRule,
  type TargetTrade,
  type TargetValidationIssue,
} from "@/lib/targets";

type Mode = "targets" | "budgets";
type LocationFilter = "all" | string;

type TargetFormState = Omit<TargetRule, "targetValue" | "warningAttainment" | "criticalAttainment" | "version"> & {
  targetValue: string;
  warningAttainment: string;
  criticalAttainment: string;
  version: string;
};

type BudgetFormState = Omit<BudgetRecord, "amount" | "version"> & { amount: string; version: string };

const targetMetrics = [
  { id: "booking-rate", label: "Call Booking Rate" },
  { id: "hvac-close", label: "HVAC Replacement Close Rate" },
  { id: "hvac-maintenance-close", label: "HVAC Maintenance Close Rate" },
  { id: "plumbing-close", label: "Plumbing Service Close Rate" },
  { id: "club-conversion", label: "Club Conversion" },
] as const;

const revenueMetrics: { id: RevenueMetricId; label: string; trade: TargetTrade }[] = [
  { id: "revenue-mtd", label: "Revenue MTD", trade: "all" },
  { id: "hvac-revenue", label: "HVAC Revenue", trade: "hvac" },
  { id: "plumbing-revenue", label: "Plumbing Revenue", trade: "plumbing" },
  { id: "electrical-revenue", label: "Electrical Revenue", trade: "electrical" },
];


const metricLabels = new Map<string, string>([
  ...targetMetrics.map((metric) => [metric.id, metric.label] as const),
  ...revenueMetrics.map((metric) => [metric.id, metric.label] as const),
]);
const locationLabels = new Map(locations.map((location) => [location.id, `${location.brand} · ${location.location}`]));
const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const currencyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function nextTargetForm(store: TargetBudgetStore): TargetFormState {
  const metricId = targetMetrics[0].id;
  const scope = TARGET_METRIC_SCOPES[metricId];
  const maxVersion = store.rules.filter((rule) => rule.metricId === metricId).reduce((max, rule) => Math.max(max, rule.version), 0);
  return {
    id: createTargetRuleId(),
    metricId,
    locationId: "*",
    trade: scope.trade,
    serviceLine: scope.serviceLine,
    targetValue: "",
    warningAttainment: "90",
    criticalAttainment: "80",
    effectiveFrom: DEMO_AS_OF_DATE,
    effectiveTo: undefined,
    version: String(maxVersion + 1),
    status: "draft",
    owner: "",
    note: "",
    updatedAt: new Date().toISOString(),
  };
}

function targetToForm(rule: TargetRule): TargetFormState {
  return {
    ...rule,
    targetValue: String(rule.targetValue),
    warningAttainment: String(rule.warningAttainment),
    criticalAttainment: String(rule.criticalAttainment),
    version: String(rule.version),
  };
}

function nextBudgetForm(store: TargetBudgetStore): BudgetFormState {
  const version = store.budgets.filter((item) => item.metricId === "revenue-mtd" && item.locationId === (locations[0]?.id ?? "") && item.fiscalMonth === DEMO_FISCAL_MONTH).reduce((max, item) => Math.max(max, item.version), 0) + 1;
  return {
    id: createBudgetRecordId(),
    metricId: "revenue-mtd",
    locationId: locations[0]?.id ?? "",
    trade: "all",
    fiscalMonth: DEMO_FISCAL_MONTH,
    amount: "",
    version: String(version),
    versionName: `FY2026 operating plan v${version}`,
    status: "draft",
    owner: "Finance",
    updatedAt: new Date().toISOString(),
  };
}

function budgetToForm(record: BudgetRecord): BudgetFormState {
  return { ...record, amount: String(record.amount), version: String(record.version) };
}

function displayLocation(id: string): string {
  return id === "*" || id === "portfolio" ? "Portfolio default" : locationLabels.get(id) ?? id;
}

function issueFor(issues: TargetValidationIssue[], field: TargetValidationIssue["field"]): string | undefined {
  return issues.find((issue) => issue.field === field)?.message;
}

function FieldIssue({ issues, field }: { issues: TargetValidationIssue[]; field: TargetValidationIssue["field"] }) {
  const message = issueFor(issues, field);
  return message ? <span role="alert" style={{ display: "block", marginTop: 4, color: "var(--red)", fontSize: 9 }}>{message}</span> : null;
}

function SummaryCard({ label, value, copy }: { label: string; value: number; copy: string }) {
  return <div><span>{label}</span><strong>{value}</strong><p>{copy}</p></div>;
}

export function TargetsAndBudgets() {
  const [store, setStore] = useState<TargetBudgetStore>(() => createSeedTargetBudgetStore());
  const [hydrated, setHydrated] = useState(false);
  const [mode, setMode] = useState<Mode>("targets");
  const [targetLocation, setTargetLocation] = useState<LocationFilter>("all");
  const [budgetLocation, setBudgetLocation] = useState<LocationFilter>("all");
  const [targetForm, setTargetForm] = useState<TargetFormState | null>(null);
  const [budgetForm, setBudgetForm] = useState<BudgetFormState | null>(null);
  const [targetIssues, setTargetIssues] = useState<TargetValidationIssue[]>([]);
  const [budgetIssues, setBudgetIssues] = useState<TargetValidationIssue[]>([]);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setStore(readTargetBudgetStore(window.localStorage));
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const targetCounts = useMemo(() => ({
    published: store.rules.filter((rule) => rule.status === "published").length,
    draft: store.rules.filter((rule) => rule.status === "draft").length,
    archived: store.rules.filter((rule) => rule.status === "archived").length,
    portfolio: store.rules.filter((rule) => rule.locationId === "*" || rule.locationId === "portfolio").length,
  }), [store.rules]);

  const budgetCounts = useMemo(() => ({
    published: store.budgets.filter((budget) => budget.status === "published").length,
    draft: store.budgets.filter((budget) => budget.status === "draft").length,
    archived: store.budgets.filter((budget) => budget.status === "archived").length,
    months: new Set(store.budgets.filter((budget) => budget.status !== "archived").map((budget) => budget.fiscalMonth)).size,
  }), [store.budgets]);

  const filteredTargets = useMemo(
    () => store.rules.filter((rule) => targetLocation === "all" || rule.locationId === targetLocation),
    [store.rules, targetLocation],
  );
  const filteredBudgets = useMemo(
    () => store.budgets.filter((budget) => budgetLocation === "all" || budget.locationId === budgetLocation),
    [store.budgets, budgetLocation],
  );

  function persist(next: TargetBudgetStore, successMessage: string) {
    setStore(next);
    const stored = writeTargetBudgetStore(next, window.localStorage);
    setNotice(stored ? successMessage : `${successMessage} Browser storage was unavailable, so this change only lasts for this session.`);
  }

  function updateTarget(patch: Partial<TargetFormState>) {
    setTargetForm((current) => current ? { ...current, ...patch } : current);
    setTargetIssues([]);
    setNotice("");
  }

  function updateBudget(patch: Partial<BudgetFormState>) {
    setBudgetForm((current) => current ? { ...current, ...patch } : current);
    setBudgetIssues([]);
    setNotice("");
  }

  function saveTarget(status: "draft" | "published") {
    if (!targetForm) return;
    const rule: TargetRule = {
      ...targetForm,
      targetValue: Number.parseFloat(targetForm.targetValue),
      warningAttainment: Number.parseFloat(targetForm.warningAttainment),
      criticalAttainment: Number.parseFloat(targetForm.criticalAttainment),
      version: Number.parseInt(targetForm.version, 10),
      effectiveTo: targetForm.effectiveTo?.trim() || undefined,
      owner: targetForm.owner.trim(),
      note: targetForm.note.trim(),
      status,
      updatedAt: new Date().toISOString(),
    };
    let comparisonRules = store.rules;
    if (status === "published") {
      comparisonRules = supersedeTargetRulesForPublication(store.rules, rule);
    }
    const issues = validateTargetRule(rule, comparisonRules);
    setTargetIssues(issues);
    if (issues.length) return;
    const rules = comparisonRules.some((item) => item.id === rule.id)
      ? comparisonRules.map((item) => item.id === rule.id ? rule : item)
      : [...comparisonRules, rule];
    persist({ ...store, rules }, status === "published" ? "Target published; prior published lineage was preserved." : "Target draft saved.");
    setTargetForm(null);
  }

  function archiveTarget(id: string) {
    const rules = store.rules.map((rule) => rule.id === id ? { ...rule, status: "archived" as const, updatedAt: new Date().toISOString() } : rule);
    persist({ ...store, rules }, "Target archived and retained for lineage.");
    if (targetForm?.id === id) setTargetForm(null);
  }

  function duplicateTarget(rule: TargetRule) {
    setTargetForm({
      ...targetToForm(rule),
      id: createTargetRuleId(),
      version: String(rule.version + 1),
      status: "draft",
      note: rule.note ? `${rule.note} (new version)` : "New draft version",
      updatedAt: new Date().toISOString(),
    });
    setTargetIssues([]);
    setNotice("Immutable successor draft prepared. Publishing will preserve and end-date or archive the prior version.");
  }

  function editTarget(rule: TargetRule) {
    if (rule.status === "draft") {
      setTargetForm(targetToForm(rule));
      setTargetIssues([]);
      setNotice("");
      return;
    }
    duplicateTarget(rule);
  }

  function saveBudget(status: "draft" | "published") {
    if (!budgetForm) return;
    const record: BudgetRecord = {
      ...budgetForm,
      amount: Number.parseFloat(budgetForm.amount),
      version: Number.parseInt(budgetForm.version, 10),
      versionName: budgetForm.versionName.trim(),
      owner: budgetForm.owner.trim(),
      status,
      updatedAt: new Date().toISOString(),
    };
    const issues = validateBudgetRecord(record, store.budgets);
    setBudgetIssues(issues);
    if (issues.length) return;
    const budgets = store.budgets.some((item) => item.id === record.id)
      ? store.budgets.map((item) => item.id === record.id ? record : item)
      : [...store.budgets, record];
    persist({ ...store, budgets }, status === "published" ? "Revenue budget published." : "Revenue budget draft saved.");
    setBudgetForm(null);
  }

  function editBudget(record: BudgetRecord) {
    if (record.status === "draft") {
      setBudgetForm(budgetToForm(record));
      setBudgetIssues([]);
      setNotice("");
      return;
    }
    setBudgetForm({
      ...budgetToForm(record),
      id: createBudgetRecordId(),
      version: String(record.version + 1),
      versionName: `${record.versionName.replace(/v\d+$/i, "").trim()} v${record.version + 1}`,
      status: "draft",
      updatedAt: new Date().toISOString(),
    });
    setBudgetIssues([]);
    setNotice("Immutable finance successor prepared. The published version remains unchanged until this version is approved.");
  }

  function archiveBudget(id: string) {
    const budgets = store.budgets.map((budget) => budget.id === id ? { ...budget, status: "archived" as const, updatedAt: new Date().toISOString() } : budget);
    persist({ ...store, budgets }, "Revenue budget archived and retained for lineage.");
    if (budgetForm?.id === id) setBudgetForm(null);
  }

  function resetDemo() {
    if (!window.confirm("Reset all KPI targets and revenue budgets to the production-shaped demo defaults? Browser-local changes will be replaced.")) return;
    const seeded = resetTargetBudgetStore(window.localStorage);
    setStore(seeded);
    setTargetForm(null);
    setBudgetForm(null);
    setTargetIssues([]);
    setBudgetIssues([]);
    setNotice("Demo targets and budgets restored.");
  }

  const targetStoreIssue = issueFor(targetIssues, "store");
  const budgetStoreIssue = issueFor(budgetIssues, "store");

  return <section aria-labelledby="targets-budgets-title">
    <div className="admin-page-title">
      <span>Performance governance</span>
      <h1 id="targets-budgets-title">Targets &amp; revenue budgets</h1>
      <p>Administer effective-dated KPI goals and monthly financial plans for the pinned demo reporting date {DEMO_AS_OF_DATE}. This prototype persists governed records in this browser; production can move the same ids, versions, owners, statuses, and dates into an audited service.</p>
    </div>

    <div className="template-section-tabs" role="tablist" aria-label="Target administration mode">
      <button type="button" role="tab" aria-selected={mode === "targets"} className={mode === "targets" ? "active" : ""} onClick={() => setMode("targets")}><Target size={15} />KPI Targets<span>{store.rules.length}</span></button>
      <button type="button" role="tab" aria-selected={mode === "budgets"} className={mode === "budgets" ? "active" : ""} onClick={() => setMode("budgets")}><DollarSign size={15} />Revenue Budgets<span>{store.budgets.length}</span></button>
    </div>

    <div className="lineage-note" role="note">
      <CircleAlert />
      <div>
        <strong>How location-specific resolution works</strong>
        <p>KPI resolution first prefers a published rule for the exact location, then falls back to the Portfolio default. Within that location tier, a trade or service-line-specific rule beats an “All” scope, followed by the newest version. Revenue budgets never fall back: they require an exact location, revenue metric, and fiscal month.</p>
      </div>
    </div>

    {notice && <div className="test-result ok" role="status"><CheckCircle2 size={17} />{notice}</div>}
    {!hydrated && <p role="status" style={{ color: "var(--muted)", fontSize: 9 }}>Hydrating browser-local targets and budgets…</p>}

    {mode === "targets" ? <>
      <div className="kpi-library-summary">
        <SummaryCard label="Published" value={targetCounts.published} copy="Eligible for KPI resolution" />
        <SummaryCard label="Drafts" value={targetCounts.draft} copy="Not visible on dashboards" />
        <SummaryCard label="Portfolio rules" value={targetCounts.portfolio} copy="Fallback target scopes" />
        <SummaryCard label="Archived" value={targetCounts.archived} copy="Retained for lineage" />
      </div>

      {targetForm && <section className="admin-card" aria-label={store.rules.some((rule) => rule.id === targetForm.id) ? "Edit KPI target" : "Add KPI target"} style={{ marginBottom: 14 }}>
        <div className="card-title"><div><span>Effective-dated target rule</span><h3>{store.rules.some((rule) => rule.id === targetForm.id) ? "Edit KPI target" : "Add KPI target"}</h3></div><button type="button" className="icon-btn" aria-label="Close target form" onClick={() => setTargetForm(null)}><X size={17} /></button></div>
        <div className="wizard-form-grid">
          <label>Metric<select aria-invalid={Boolean(issueFor(targetIssues, "metricId"))} value={targetForm.metricId} onChange={(event) => { const metricId = event.target.value; const scope = TARGET_METRIC_SCOPES[metricId]; updateTarget({ metricId, trade: scope.trade, serviceLine: scope.serviceLine }); }}>{targetMetrics.map((metric) => <option key={metric.id} value={metric.id}>{metric.label} ({metric.id})</option>)}</select><FieldIssue issues={targetIssues} field="metricId" /></label>
          <label>Location / portfolio<select aria-invalid={Boolean(issueFor(targetIssues, "locationId"))} value={targetForm.locationId} onChange={(event) => updateTarget({ locationId: event.target.value })}><option value="*">Portfolio default</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.brand} · {location.location}</option>)}</select><FieldIssue issues={targetIssues} field="locationId" /></label>
          <label>Trade (metric grain)<input readOnly aria-readonly="true" value={targetForm.trade} /><FieldIssue issues={targetIssues} field="trade" /></label>
          <label>Service line (metric grain)<input readOnly aria-readonly="true" value={targetForm.serviceLine} /><FieldIssue issues={targetIssues} field="serviceLine" /></label>
          <label>Target<input type="number" min="0" step="0.1" aria-invalid={Boolean(issueFor(targetIssues, "targetValue"))} value={targetForm.targetValue} onChange={(event) => updateTarget({ targetValue: event.target.value })} /><FieldIssue issues={targetIssues} field="targetValue" /></label>
          <label>Version<input type="number" min="1" step="1" aria-invalid={Boolean(issueFor(targetIssues, "version"))} value={targetForm.version} onChange={(event) => updateTarget({ version: event.target.value })} /><FieldIssue issues={targetIssues} field="version" /></label>
          <label>Warning attainment (%)<input type="number" min="0" max="100" step="0.1" aria-invalid={Boolean(issueFor(targetIssues, "warningAttainment"))} value={targetForm.warningAttainment} onChange={(event) => updateTarget({ warningAttainment: event.target.value })} /><FieldIssue issues={targetIssues} field="warningAttainment" /></label>
          <label>Critical attainment (%)<input type="number" min="0" max="100" step="0.1" aria-invalid={Boolean(issueFor(targetIssues, "criticalAttainment"))} value={targetForm.criticalAttainment} onChange={(event) => updateTarget({ criticalAttainment: event.target.value })} /><FieldIssue issues={targetIssues} field="criticalAttainment" /></label>
          <label>Effective from<input type="date" aria-invalid={Boolean(issueFor(targetIssues, "effectiveFrom"))} value={targetForm.effectiveFrom} onChange={(event) => updateTarget({ effectiveFrom: event.target.value })} /><FieldIssue issues={targetIssues} field="effectiveFrom" /></label>
          <label>Effective to (optional)<input type="date" aria-invalid={Boolean(issueFor(targetIssues, "effectiveTo"))} value={targetForm.effectiveTo ?? ""} onChange={(event) => updateTarget({ effectiveTo: event.target.value || undefined })} /><FieldIssue issues={targetIssues} field="effectiveTo" /></label>
          <label>Owner<input aria-invalid={Boolean(issueFor(targetIssues, "owner"))} value={targetForm.owner} onChange={(event) => updateTarget({ owner: event.target.value })} /><FieldIssue issues={targetIssues} field="owner" /></label>
          <label className="span-two">Note<textarea aria-invalid={Boolean(issueFor(targetIssues, "note"))} value={targetForm.note} onChange={(event) => updateTarget({ note: event.target.value })} placeholder="Planning rationale, approval context, or source" /><FieldIssue issues={targetIssues} field="note" /></label>
        </div>
        {targetStoreIssue && <div className="test-result error" role="alert"><CircleAlert size={17} />{targetStoreIssue}</div>}
        <div className="form-actions" style={{ marginTop: 16 }}><button type="button" className="button secondary" onClick={() => saveTarget("draft")}><Save size={15} />Save draft</button><button type="button" className="button primary" onClick={() => saveTarget("published")}><CheckCircle2 size={15} />Publish target</button>{store.rules.some((rule) => rule.id === targetForm.id && rule.status !== "archived") && <button type="button" className="button secondary" onClick={() => archiveTarget(targetForm.id)}><Archive size={15} />Archive target</button>}</div>
      </section>}

      <section className="admin-card custom-kpi-catalog" aria-label="KPI target rules">
        <div className="custom-kpi-toolbar"><div><span>Governed target catalog</span><h3>KPI target rules</h3></div><button type="button" className="button primary" onClick={() => { setTargetForm(nextTargetForm(store)); setTargetIssues([]); setNotice(""); }}><Plus size={16} />Add target</button></div>
        <div className="catalog-filters"><label>Filter targets by location<select aria-label="Filter targets by location" value={targetLocation} onChange={(event) => setTargetLocation(event.target.value)}><option value="all">All locations and portfolio</option><option value="*">Portfolio default</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.brand} · {location.location}</option>)}</select></label><span>{filteredTargets.length} target{filteredTargets.length === 1 ? "" : "s"}</span><button type="button" className="button secondary" onClick={resetDemo}><RotateCcw size={15} />Reset demo config</button></div>
        <div className="table-scroll"><table className="custom-kpi-table"><thead><tr><th>Metric / scope</th><th>Target</th><th>Attainment bands</th><th>Effective period</th><th>Status / owner</th><th>Actions</th></tr></thead><tbody>{filteredTargets.map((rule) => <tr key={rule.id}><td><strong>{metricLabels.get(rule.metricId) ?? rule.metricId}</strong><span>{displayLocation(rule.locationId)} · {rule.trade} · {rule.serviceLine} · v{rule.version}</span></td><td>{numberFormatter.format(rule.targetValue)}%</td><td>Warning {rule.warningAttainment}%<span>Critical {rule.criticalAttainment}%</span></td><td>{rule.effectiveFrom}<span>through {rule.effectiveTo ?? "open-ended"}</span></td><td><span className={`kpi-status ${rule.status}`}>{rule.status}</span><span>{rule.owner}</span></td><td><div className="catalog-actions"><button type="button" aria-label={`${rule.status === "draft" ? "Edit" : "Create successor for"} ${metricLabels.get(rule.metricId) ?? rule.metricId} target for ${displayLocation(rule.locationId)}`} onClick={() => editTarget(rule)}><Pencil size={14} />{rule.status === "draft" ? "Edit" : "Successor"}</button><button type="button" aria-label={`Duplicate ${metricLabels.get(rule.metricId) ?? rule.metricId} target as new draft version`} onClick={() => duplicateTarget(rule)}><Copy size={14} />Duplicate</button>{rule.status !== "archived" && <button type="button" className="danger" aria-label={`Archive ${metricLabels.get(rule.metricId) ?? rule.metricId} target for ${displayLocation(rule.locationId)}`} onClick={() => archiveTarget(rule.id)}><Archive size={14} />Archive</button>}</div></td></tr>)}</tbody></table></div>
        {filteredTargets.length === 0 && <div className="small-empty"><Target /><strong>No targets match this location</strong><p>Choose another location or add a governed target rule.</p></div>}
      </section>
    </> : <>
      <div className="kpi-library-summary">
        <SummaryCard label="Published" value={budgetCounts.published} copy="Eligible for revenue cards" />
        <SummaryCard label="Drafts" value={budgetCounts.draft} copy="Awaiting finance approval" />
        <SummaryCard label="Fiscal months" value={budgetCounts.months} copy="Active periods configured" />
        <SummaryCard label="Archived" value={budgetCounts.archived} copy="Retained for lineage" />
      </div>

      {budgetForm && <section className="admin-card" aria-label={store.budgets.some((budget) => budget.id === budgetForm.id) ? "Edit revenue budget" : "Add revenue budget"} style={{ marginBottom: 14 }}>
        <div className="card-title"><div><span>Monthly financial target</span><h3>{store.budgets.some((budget) => budget.id === budgetForm.id) ? "Edit revenue budget" : "Add revenue budget"}</h3></div><button type="button" className="icon-btn" aria-label="Close budget form" onClick={() => setBudgetForm(null)}><X size={17} /></button></div>
        <div className="wizard-form-grid">
          <label>Metric<select aria-invalid={Boolean(issueFor(budgetIssues, "metricId"))} value={budgetForm.metricId} onChange={(event) => { const metricId = event.target.value as RevenueMetricId; const trade = revenueMetrics.find((metric) => metric.id === metricId)?.trade ?? "all"; updateBudget({ metricId, trade }); }}>{revenueMetrics.map((metric) => <option key={metric.id} value={metric.id}>{metric.label} ({metric.id})</option>)}</select><FieldIssue issues={budgetIssues} field="metricId" /></label>
          <label>Location<select aria-invalid={Boolean(issueFor(budgetIssues, "locationId"))} value={budgetForm.locationId} onChange={(event) => updateBudget({ locationId: event.target.value })}>{locations.map((location) => <option key={location.id} value={location.id}>{location.brand} · {location.location}</option>)}</select><FieldIssue issues={budgetIssues} field="locationId" /></label>
          <label>Trade (auto-matched)<input readOnly aria-readonly="true" aria-invalid={Boolean(issueFor(budgetIssues, "trade"))} value={budgetForm.trade} /><FieldIssue issues={budgetIssues} field="trade" /></label>
          <label>Fiscal month<input type="month" aria-invalid={Boolean(issueFor(budgetIssues, "fiscalMonth"))} value={budgetForm.fiscalMonth} onChange={(event) => updateBudget({ fiscalMonth: event.target.value })} /><FieldIssue issues={budgetIssues} field="fiscalMonth" /></label>
          <label>Amount<input type="number" min="0" step="1" aria-invalid={Boolean(issueFor(budgetIssues, "amount"))} value={budgetForm.amount} onChange={(event) => updateBudget({ amount: event.target.value })} /><FieldIssue issues={budgetIssues} field="amount" /></label>
          <label>Version<input type="number" min="1" step="1" aria-invalid={Boolean(issueFor(budgetIssues, "version"))} value={budgetForm.version} onChange={(event) => updateBudget({ version: event.target.value })} /><FieldIssue issues={budgetIssues} field="version" /></label>
          <label>Version name<input aria-invalid={Boolean(issueFor(budgetIssues, "versionName"))} value={budgetForm.versionName} onChange={(event) => updateBudget({ versionName: event.target.value })} placeholder="e.g. FY2027 board plan v2" /><FieldIssue issues={budgetIssues} field="versionName" /></label>
          <label>Owner<input aria-invalid={Boolean(issueFor(budgetIssues, "owner"))} value={budgetForm.owner} onChange={(event) => updateBudget({ owner: event.target.value })} /><FieldIssue issues={budgetIssues} field="owner" /></label>

        </div>
        {budgetStoreIssue && <div className="test-result error" role="alert"><CircleAlert size={17} />{budgetStoreIssue}</div>}
        <div className="form-actions" style={{ marginTop: 16 }}><button type="button" className="button secondary" onClick={() => saveBudget("draft")}><Save size={15} />Save draft</button><button type="button" className="button primary" onClick={() => saveBudget("published")}><CheckCircle2 size={15} />Publish budget</button>{store.budgets.some((budget) => budget.id === budgetForm.id && budget.status !== "archived") && <button type="button" className="button secondary" onClick={() => archiveBudget(budgetForm.id)}><Archive size={15} />Archive budget</button>}</div>
      </section>}

      <section className="admin-card custom-kpi-catalog" aria-label="Revenue budget records">
        <div className="custom-kpi-toolbar"><div><span>Finance-owned planning catalog</span><h3>Monthly revenue budgets</h3></div><button type="button" className="button primary" onClick={() => { setBudgetForm(nextBudgetForm(store)); setBudgetIssues([]); setNotice(""); }}><Plus size={16} />Add budget</button></div>
        <div className="catalog-filters"><label>Filter budgets by location<select aria-label="Filter budgets by location" value={budgetLocation} onChange={(event) => setBudgetLocation(event.target.value)}><option value="all">All locations</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.brand} · {location.location}</option>)}</select></label><span>{filteredBudgets.length} budget{filteredBudgets.length === 1 ? "" : "s"}</span><button type="button" className="button secondary" onClick={resetDemo}><RotateCcw size={15} />Reset demo config</button></div>
        <div className="table-scroll"><table className="custom-kpi-table"><thead><tr><th>Metric / location</th><th>Fiscal month</th><th>Amount</th><th>Version</th><th>Status / owner</th><th>Actions</th></tr></thead><tbody>{filteredBudgets.map((budget) => <tr key={budget.id}><td><strong>{metricLabels.get(budget.metricId) ?? budget.metricId}</strong><span>{displayLocation(budget.locationId)} · {budget.trade}</span></td><td>{budget.fiscalMonth}</td><td>{currencyFormatter.format(budget.amount)}</td><td>v{budget.version}<span>{budget.versionName}</span></td><td><span className={`kpi-status ${budget.status}`}>{budget.status}</span><span>{budget.owner}</span></td><td><div className="catalog-actions"><button type="button" aria-label={`${budget.status === "draft" ? "Edit" : "Create successor for"} ${metricLabels.get(budget.metricId) ?? budget.metricId} budget for ${displayLocation(budget.locationId)}`} onClick={() => editBudget(budget)}><Pencil size={14} />{budget.status === "draft" ? "Edit" : "Successor"}</button>{budget.status !== "archived" && <button type="button" className="danger" aria-label={`Archive ${metricLabels.get(budget.metricId) ?? budget.metricId} budget for ${displayLocation(budget.locationId)}`} onClick={() => archiveBudget(budget.id)}><Archive size={14} />Archive</button>}</div></td></tr>)}</tbody></table></div>
        {filteredBudgets.length === 0 && <div className="small-empty"><DollarSign /><strong>No budgets match this location</strong><p>Choose another location or add an exact-location monthly budget.</p></div>}
      </section>
    </>}
  </section>;
}
