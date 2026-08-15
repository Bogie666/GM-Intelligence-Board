"use client";

import {
  ArrowLeft,
  ArrowRight,
  Calculator,
  Check,
  CheckCircle2,
  CircleAlert,
  Database,
  FileInput,
  Gauge,
  Layers3,
  Save,
  Send,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { formatMetric } from "@/lib/metrics";
import {
  createCustomKpiDraft,
  createKpiId,
  customKpiToMetric,
  evaluateCustomKpis,
  runCustomKpiValidation,
  slugifyKpiKey,
  validateCustomKpiStep,
  wizardSteps,
  type CustomKpiDefinition,
  type ValidationIssue,
} from "@/lib/custom-kpis";
import { sectionMeta } from "@/lib/demo-data";
import type { LayoutTemplate, LocationConfig, Metric, MetricKind, MetricSection } from "@/lib/types";

const typeOptions: { id: CustomKpiDefinition["type"]; title: string; copy: string; icon: typeof Layers3 }[] = [
  { id: "catalog", title: "Existing KPI variant", copy: "Reuse a governed formula and change its scope, target, or presentation.", icon: Layers3 },
  { id: "derived", title: "Derived KPI", copy: "Calculate a controlled ratio or formula from approved KPI inputs.", icon: Calculator },
  { id: "manual", title: "Manual / CSV KPI", copy: "Maintain a value outside ServiceTitan with ownership and freshness controls.", icon: FileInput },
  { id: "external", title: "External KPI", copy: "Model GA4, GBP, call-system, finance, or another future connector.", icon: Database },
];

const roleOptions = [
  ["general-manager", "General manager"],
  ["department-leader", "Department leader"],
  ["brand-executive", "Brand executive"],
  ["portfolio-admin", "Portfolio admin"],
] as const;

function cloneDefinition(definition: CustomKpiDefinition): CustomKpiDefinition {
  return JSON.parse(JSON.stringify(definition));
}

function numericValue(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function StepIssues({ issues }: { issues: ValidationIssue[] }) {
  if (!issues.length) return null;
  return <div className="wizard-issues" role="alert">{issues.map((issue) => <div className={issue.severity} key={`${issue.step}-${issue.code}`}>
    {issue.severity === "error" ? <XCircle size={16}/> : <CircleAlert size={16}/>}<span>{issue.message}</span>
  </div>)}</div>;
}

export function KpiWizard({
  initial,
  catalog,
  definitions,
  locations,
  templates,
  onSaveDraft,
  onPublish,
  onCancel,
}: {
  initial?: CustomKpiDefinition;
  catalog: Metric[];
  definitions: CustomKpiDefinition[];
  locations: LocationConfig[];
  templates: LayoutTemplate[];
  onSaveDraft: (definition: CustomKpiDefinition) => void;
  onPublish: (definition: CustomKpiDefinition) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<CustomKpiDefinition>(() => cloneDefinition(initial ?? createCustomKpiDraft(createKpiId(), new Date().toISOString())));
  const [stepIndex, setStepIndex] = useState(0);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [saved, setSaved] = useState(false);
  const currentStep = wizardSteps[stepIndex].id;
  const publishedDependencies = definitions.filter((item) => item.status === "published" && item.id !== draft.id);
  const dependencyOptions = [
    ...catalog.map((metric) => ({ id: metric.id, label: metric.title, section: metric.section })),
    ...publishedDependencies.map((metric) => ({ id: metric.id, label: metric.title, section: metric.section })),
  ];
  const evaluation = useMemo(() => evaluateCustomKpis([...definitions.filter((item) => item.id !== draft.id), draft], catalog).get(draft.id), [catalog, definitions, draft]);
  const previewMetric = evaluation ? customKpiToMetric({ ...draft, status: "published" }, evaluation) : null;

  function patch(values: Partial<CustomKpiDefinition>) {
    setDraft((current) => ({ ...current, ...values, validationChecks: [], validatedAt: undefined, updatedAt: new Date().toISOString() }));
    setIssues([]);
    setSaved(false);
  }

  function updateTitle(title: string) {
    setDraft((current) => {
      const previousGenerated = slugifyKpiKey(current.title);
      const shouldUpdateKey = !current.key || current.key === previousGenerated;
      return { ...current, title, key: shouldUpdateKey ? slugifyKpiKey(title) : current.key, validationChecks: [], validatedAt: undefined, updatedAt: new Date().toISOString() };
    });
    setIssues([]);
  }

  function toggleArray(field: "locationIds" | "roles" | "templateIds", value: string) {
    const current = draft[field];
    patch({ [field]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] });
  }

  function goNext() {
    const nextIssues = validateCustomKpiStep(draft, currentStep, catalog, definitions);
    const blocking = nextIssues.filter((issue) => issue.severity === "error");
    setIssues(nextIssues);
    if (blocking.length) return;
    if (stepIndex < wizardSteps.length - 1) setStepIndex(stepIndex + 1);
  }

  function runValidation() {
    const result = runCustomKpiValidation(draft, catalog, definitions);
    const next = { ...draft, validationChecks: result.checks, validatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    setDraft(next);
    setIssues(result.issues);
  }

  function saveDraft() {
    const next = { ...draft, status: "draft" as const, updatedAt: new Date().toISOString() };
    setDraft(next);
    onSaveDraft(next);
    setSaved(true);
  }

  function publish() {
    const technical = runCustomKpiValidation(draft, catalog, definitions);
    const publishIssues = validateCustomKpiStep(draft, "publish", catalog, definitions);
    const combined = [...technical.issues, ...publishIssues];
    setIssues(combined);
    if (combined.some((issue) => issue.severity === "error")) return;
    const now = new Date().toISOString();
    onPublish({ ...draft, status: "published", version: initial?.status === "published" ? initial.version + 1 : draft.version, validationChecks: technical.checks, validatedAt: now, updatedAt: now, publishedAt: now });
  }

  const completed = (index: number) => index < stepIndex;
  return <section className="kpi-wizard" aria-label="Custom KPI builder">
    <header className="wizard-header">
      <div><span>Governed KPI builder</span><h2>{draft.title || "New custom KPI"}</h2><p>Browser-local prototype · no production source credentials are stored.</p></div>
      <div className="wizard-header-actions"><span className={`kpi-status ${draft.status}`}>{draft.status}</span><button className="icon-btn" aria-label="Close KPI builder" onClick={onCancel}><XCircle size={20}/></button></div>
    </header>
    <div className="wizard-stepper" aria-label="KPI builder steps">{wizardSteps.map((step, index) => <button type="button" key={step.id} className={index === stepIndex ? "active" : completed(index) ? "complete" : ""} aria-current={index === stepIndex ? "step" : undefined} onClick={() => index <= stepIndex && setStepIndex(index)}>
      <span>{completed(index) ? <Check size={14}/> : index + 1}</span><strong>{step.label}</strong>
    </button>)}</div>

    <div className="wizard-body">
      <div className="wizard-main">
        {currentStep === "definition" && <div className="wizard-panel"><div className="wizard-panel-title"><span>Step 1</span><h3>Define what this KPI means</h3><p>Choose a governed KPI type and document the business definition before configuring data.</p></div>
          <div className="kpi-type-grid">{typeOptions.map(({id,title,copy,icon:Icon}) => <button type="button" className={draft.type === id ? "selected" : ""} aria-pressed={draft.type === id} key={id} onClick={() => patch({ type:id, catalogMetricId:undefined, leftMetricId:undefined, rightMetricId:undefined, provider:undefined, externalMetricKey:undefined })}><Icon size={20}/><strong>{title}</strong><span>{copy}</span></button>)}</div>
          <div className="wizard-form-grid"><label>KPI name<input value={draft.title} onChange={(event)=>updateTitle(event.target.value)} placeholder="e.g. Plumbing booking rate" aria-invalid={issues.some((i)=>i.code==="title")} /></label><label>Stable KPI key<input value={draft.key} onChange={(event)=>patch({key:slugifyKpiKey(event.target.value)})} placeholder="plumbing-booking-rate" aria-invalid={issues.some((i)=>i.code.includes("key"))} /></label><label className="span-two">Business definition<textarea value={draft.definition} onChange={(event)=>patch({definition:event.target.value})} placeholder="Define the numerator, denominator, exclusions, and operating meaning in plain language." /></label><label>Definition owner<input value={draft.owner} onChange={(event)=>patch({owner:event.target.value})} placeholder="e.g. Call Center" /></label><label>Dashboard tab<select value={draft.section} onChange={(event)=>patch({section:event.target.value as MetricSection})}>{Object.entries(sectionMeta).map(([id,meta])=><option key={id} value={id}>{meta.label}</option>)}</select></label><label>Card format<select value={draft.kind} onChange={(event)=>patch({kind:event.target.value as MetricKind})}><option value="number">Number</option><option value="currency">Currency</option><option value="percent">Percent</option><option value="ratio">Ratio</option></select></label><label>Favorable direction<select value={draft.direction} onChange={(event)=>patch({direction:event.target.value as CustomKpiDefinition["direction"]})}><option value="higher">Higher is better</option><option value="lower">Lower is better</option><option value="informational">Informational only</option></select></label><label className="span-two">Card supporting label<input value={draft.subtitle} onChange={(event)=>patch({subtitle:event.target.value})} placeholder="Short context shown under the current value" /></label></div>
        </div>}

        {currentStep === "scope" && <div className="wizard-panel"><div className="wizard-panel-title"><span>Step 2</span><h3>Set portfolio scope and access</h3><p>Control where the KPI is valid and which operating roles may see it.</p></div>
          <div className="choice-row"><button type="button" className={draft.scopeMode === "portfolio" ? "selected" : ""} onClick={()=>patch({scopeMode:"portfolio",locationIds:[]})}><Layers3/><strong>All current locations</strong><span>Available across the portfolio where source data is ready.</span></button><button type="button" className={draft.scopeMode === "selected-locations" ? "selected" : ""} onClick={()=>patch({scopeMode:"selected-locations"})}><Gauge/><strong>Selected locations</strong><span>Restrict this definition and value to named locations.</span></button></div>
          {draft.scopeMode === "selected-locations" && <div className="selection-card"><strong>Eligible locations</strong>{locations.map((location)=><label key={location.id}><input type="checkbox" checked={draft.locationIds.includes(location.id)} onChange={()=>toggleArray("locationIds",location.id)} /><span><b>{location.brand}</b>{location.location} · {location.timezone}</span></label>)}</div>}
          <div className="selection-card"><strong>Roles allowed to view</strong>{roleOptions.map(([id,label])=><label key={id}><input type="checkbox" checked={draft.roles.includes(id)} onChange={()=>toggleArray("roles",id)} /><span><b>{label}</b>Role-level visibility is still subject to location scope.</span></label>)}</div>
        </div>}

        {currentStep === "source" && <div className="wizard-panel"><div className="wizard-panel-title"><span>Step 3</span><h3>Configure data lineage</h3><p>The selected KPI type controls which source settings are allowed.</p></div>
          {draft.type === "catalog" && <div className="wizard-form-grid"><label className="span-two">Governed KPI to inherit<select value={draft.catalogMetricId ?? ""} onChange={(event)=>{const metric=catalog.find((item)=>item.id===event.target.value);patch({catalogMetricId:event.target.value,kind:metric?.kind??draft.kind,section:metric?.section??draft.section})}}><option value="">Select a core KPI…</option>{catalog.map((metric)=><option value={metric.id} key={metric.id}>{sectionMeta[metric.section].label} · {metric.title}</option>)}</select></label><div className="lineage-note span-two"><ShieldCheck/><div><strong>Formula and source remain governed</strong><p>This variant inherits the selected KPI&apos;s value, period, source, and lineage. Only scope, targets, and presentation can change.</p></div></div></div>}
          {draft.type === "derived" && <div className="lineage-note"><Calculator/><div><strong>Controlled formula source</strong><p>Calculation inputs are limited to governed core KPIs and already-published custom KPIs. Free-form SQL and JavaScript are not allowed.</p></div></div>}
          {draft.type === "manual" && <div className="wizard-form-grid"><label>Update cadence<select value={draft.refreshCadence} onChange={(event)=>patch({refreshCadence:event.target.value as CustomKpiDefinition["refreshCadence"]})}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="ad-hoc">Ad hoc</option></select></label><label>Stale after hours<input type="number" min="1" value={draft.staleAfterHours ?? ""} onChange={(event)=>patch({staleAfterHours:numericValue(event.target.value)})}/></label><div className="lineage-note span-two"><CircleAlert/><div><strong>Manual observation</strong><p>The dashboard will clearly show this as manually maintained with its as-of date and freshness policy.</p></div></div></div>}
          {draft.type === "external" && <div className="wizard-form-grid"><label>External provider<select value={draft.provider ?? ""} onChange={(event)=>patch({provider:event.target.value as CustomKpiDefinition["provider"]})}><option value="">Select provider…</option><option>GA4</option><option>Google Business Profile</option><option>Call System</option><option>Finance</option><option>Other</option></select></label><label>Metric / event key<input value={draft.externalMetricKey ?? ""} onChange={(event)=>patch({externalMetricKey:event.target.value})} placeholder="e.g. reviews.new_5_star" /></label><label>Expected refresh<select value={draft.refreshCadence} onChange={(event)=>patch({refreshCadence:event.target.value as CustomKpiDefinition["refreshCadence"]})}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="ad-hoc">Ad hoc</option></select></label><label>Stale after hours<input type="number" min="1" value={draft.staleAfterHours ?? ""} onChange={(event)=>patch({staleAfterHours:numericValue(event.target.value)})}/></label><div className="lineage-note warning span-two"><CircleAlert/><div><strong>Connector not active in this test build</strong><p>A manual demo snapshot is required for preview and will be labeled as such. Missing external data is never converted to zero.</p></div></div></div>}
        </div>}

        {currentStep === "calculation" && <div className="wizard-panel"><div className="wizard-panel-title"><span>Step 4</span><h3>Configure calculation and targets</h3><p>Only fields applicable to the selected KPI type are available.</p></div>
          {draft.type === "derived" && <div className="formula-builder"><label>First KPI<select value={draft.leftMetricId ?? ""} onChange={(event)=>patch({leftMetricId:event.target.value})}><option value="">Select KPI…</option>{dependencyOptions.map((option)=><option key={option.id} value={option.id}>{option.label}</option>)}</select></label><label>Operation<select value={draft.operation ?? ""} onChange={(event)=>patch({operation:event.target.value as CustomKpiDefinition["operation"],kind:event.target.value === "percent" ? "percent" : draft.kind})}><option value="">Select…</option><option value="add">Add</option><option value="subtract">Subtract</option><option value="multiply">Multiply</option><option value="divide">Divide</option><option value="percent">Percent of</option></select></label><label>Second KPI<select value={draft.rightMetricId ?? ""} onChange={(event)=>patch({rightMetricId:event.target.value})}><option value="">Select KPI…</option>{dependencyOptions.map((option)=><option key={option.id} value={option.id}>{option.label}</option>)}</select></label></div>}
          {(draft.type === "manual" || draft.type === "external") && <div className="wizard-form-grid"><label>Prototype observation<input type="number" step="any" value={draft.manualValue ?? ""} onChange={(event)=>patch({manualValue:numericValue(event.target.value)})} /></label><label>Prior value (optional)<input type="number" step="any" value={draft.priorValue ?? ""} onChange={(event)=>patch({priorValue:numericValue(event.target.value)})} /></label><label>As-of date<input type="date" value={draft.asOf ?? ""} onChange={(event)=>patch({asOf:event.target.value})} /></label></div>}
          {draft.type === "catalog" && <div className="lineage-note"><Layers3/><div><strong>No formula override permitted</strong><p>The selected governed KPI supplies the calculation. Configure only the target and card presentation below.</p></div></div>}
          <div className="wizard-form-grid target-fields"><label>Target (optional)<input type="number" step="any" value={draft.goal ?? ""} onChange={(event)=>patch({goal:numericValue(event.target.value)})}/></label><label>Watch threshold (% attainment)<input type="number" min="1" max="100" value={draft.warningAt ?? ""} onChange={(event)=>patch({warningAt:numericValue(event.target.value)})} placeholder="e.g. 95" /></label></div>
          <div className="formula-preview"><span>Live preview</span><strong>{evaluation?.state === "available" && evaluation.value !== undefined ? formatMetric(evaluation.value,draft.kind) : "Unavailable"}</strong><p>{evaluation?.state === "available" ? `Lineage: ${evaluation.lineage.join(" + ")}` : evaluation?.reason ?? "Complete the calculation to preview this KPI."}</p></div>
        </div>}

        {currentStep === "validate" && <div className="wizard-panel"><div className="wizard-panel-title"><span>Step 5</span><h3>Validate before publication</h3><p>Run governed checks against the definition, scope, source, and calculated preview.</p></div>
          <button type="button" className="button primary run-validation" onClick={runValidation}><ShieldCheck size={16}/>Run validation</button>
          {!draft.validationChecks.length ? <div className="validation-empty"><ShieldCheck/><strong>Validation has not run</strong><p>Publishing remains blocked until all required checks pass. Warnings remain visible in the release summary.</p></div> : <div className="validation-results">{draft.validationChecks.map((check)=><div className={check.status} key={check.id}>{check.status === "pass" ? <CheckCircle2/> : check.status === "warning" ? <CircleAlert/> : <XCircle/>}<div><strong>{check.label}</strong><p>{check.detail}</p></div><span>{check.status}</span></div>)}</div>}
          {previewMetric && <div className="validation-preview"><div><span>Calculated value</span><strong>{formatMetric(previewMetric.actual,previewMetric.kind)}</strong></div><div><span>Target</span><strong>{previewMetric.goal === undefined ? "Not configured" : formatMetric(previewMetric.goal,previewMetric.kind)}</strong></div><div><span>Source lineage</span><strong>{evaluation?.lineage.join(" → ")}</strong></div></div>}
        </div>}

        {currentStep === "publish" && <div className="wizard-panel"><div className="wizard-panel-title"><span>Step 6</span><h3>Assign and publish</h3><p>Choose role templates and record why this KPI is being introduced.</p></div>
          <div className="selection-card"><strong>Role-template assignment</strong>{templates.map((template)=><label key={template.id}><input type="checkbox" checked={draft.templateIds.includes(template.id)} onChange={()=>toggleArray("templateIds",template.id)}/><span><b>{template.name}</b>{template.description}</span></label>)}</div>
          <div className="wizard-form-grid"><label className="span-two">Release note / business reason<textarea value={draft.releaseNote} onChange={(event)=>patch({releaseNote:event.target.value})} placeholder="Why is this KPI being published and who approved the definition?" /></label></div>
          <div className="publish-summary"><div><span>Status</span><strong>Ready for browser-local publication</strong></div><div><span>Scope</span><strong>{draft.scopeMode === "portfolio" ? "All current locations" : `${draft.locationIds.length} selected locations`}</strong></div><div><span>Templates</span><strong>{draft.templateIds.length}</strong></div><div><span>Validation</span><strong>{draft.validationChecks.some((check)=>check.status==="fail") || !draft.validationChecks.length ? "Blocked" : "Passed with disclosed warnings"}</strong></div></div>
          <div className="lineage-note warning"><CircleAlert/><div><strong>Prototype publication boundary</strong><p>Publish writes this governed definition to this browser only. Production will use Postgres, RBAC, audit history, encrypted connection references, and materialized observations.</p></div></div>
        </div>}
        <StepIssues issues={issues}/>
      </div>
      <aside className="wizard-summary"><span>Live definition</span><h3>{draft.title || "Untitled KPI"}</h3><dl><div><dt>Type</dt><dd>{typeOptions.find((item)=>item.id===draft.type)?.title}</dd></div><div><dt>Owner</dt><dd>{draft.owner || "Not assigned"}</dd></div><div><dt>Section</dt><dd>{sectionMeta[draft.section].label}</dd></div><div><dt>Scope</dt><dd>{draft.scopeMode === "portfolio" ? "Portfolio" : `${draft.locationIds.length} locations`}</dd></div><div><dt>Format</dt><dd>{draft.kind}</dd></div><div><dt>Direction</dt><dd>{draft.direction}</dd></div><div><dt>Templates</dt><dd>{draft.templateIds.length}</dd></div></dl><div className={`summary-value ${evaluation?.state}`}><span>Preview</span><strong>{evaluation?.state === "available" && evaluation.value !== undefined ? formatMetric(evaluation.value,draft.kind) : "Unavailable"}</strong><p>{evaluation?.reason ?? evaluation?.warning ?? "Calculation available"}</p></div></aside>
    </div>

    <footer className="wizard-footer"><div>{saved ? <><CheckCircle2 size={16}/>Draft saved locally</> : <><CircleAlert size={16}/>Unsaved browser-local changes</>}</div><div><button type="button" className="button secondary" onClick={onCancel}>Cancel</button><button type="button" className="button secondary" onClick={saveDraft}><Save size={16}/>Save draft</button>{stepIndex > 0 && <button type="button" className="button secondary" onClick={()=>{setIssues([]);setStepIndex(stepIndex-1)}}><ArrowLeft size={16}/>Back</button>}{currentStep !== "publish" ? <button type="button" className="button primary" onClick={goNext}>Continue<ArrowRight size={16}/></button> : <button type="button" className="button primary" onClick={publish}><Send size={16}/>Publish in this browser</button>}</div></footer>
  </section>;
}
