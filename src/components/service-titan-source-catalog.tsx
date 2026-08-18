"use client";

import {
  Archive,
  CheckCircle2,
  CircleAlert,
  FileSpreadsheet,
  FlaskConical,
  GitCompareArrows,
  LockKeyhole,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { readConnectionStore, type DemoServiceTitanConnection } from "@/lib/demo-connections";
import {
  archiveServiceTitanReportSource,
  buildServiceTitanReportSource,
  createSeedServiceTitanSourceStore,
  readServiceTitanSourceStore,
  reportSchemaFingerprint,
  upsertServiceTitanReportSource,
  writeServiceTitanSourceStore,
  type ReportSourceValidationIssue,
  type ServiceTitanEvidenceStatus,
  type ServiceTitanReportField,
  type ServiceTitanReportFieldType,
  type ServiceTitanReportLifecycle,
  type ServiceTitanReportParameter,
  type ServiceTitanReportParameterDataType,
  type ServiceTitanReportSource,
  type ServiceTitanSourceStore,
} from "@/lib/service-titan-sources";

const fieldTypes: ServiceTitanReportFieldType[] = ["number", "string", "date", "boolean"];
const parameterTypes: ServiceTitanReportParameterDataType[] = ["String", "Number", "Boolean", "Date", "Time"];
const lifecycles: ServiceTitanReportLifecycle[] = ["draft", "inspected", "reconciled", "approved"];
const evidenceStatuses: ServiceTitanEvidenceStatus[] = ["pending", "pass", "fail"];

type RegistryFilter = "active" | "all" | "archived";
type IssueField = ReportSourceValidationIssue["field"];

interface ReportDraft {
  connectionId: string;
  categoryId: string;
  reportId: string;
  ownerId: string;
  ownerName: string;
  name: string;
  description: string;
  modifiedOn: string;
  parameters: ServiceTitanReportParameter[];
  expectedFields: ServiceTitanReportField[];
  observedFields: ServiceTitanReportField[];
  lifecycle: ServiceTitanReportLifecycle;
  sampleEnabled: boolean;
  sampleRowCount: string;
  sampleComputedValue: string;
  sampleTime: string;
  sampleStatus: ServiceTitanEvidenceStatus;
  reconciliationEnabled: boolean;
  reconciliationExpected: string;
  reconciliationReference: string;
  reconciliationTolerance: string;
  reconciliationTime: string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toDateTimeLocal(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toTimestamp(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function formatTimestamp(value?: string): string {
  if (!value) return "Not declared";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
    : "Invalid timestamp";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);
}

function emptyField(type: ServiceTitanReportFieldType = "number"): ServiceTitanReportField {
  return { name: "", label: "", type };
}

function emptyParameter(): ServiceTitanReportParameter {
  return { name: "", label: "", dataType: "String", isArray: false, isRequired: false };
}

function newDraft(): ReportDraft {
  const now = toDateTimeLocal(new Date().toISOString());
  return {
    connectionId: "",
    categoryId: "",
    reportId: "",
    ownerId: "",
    ownerName: "",
    name: "",
    description: "",
    modifiedOn: now,
    parameters: [],
    expectedFields: [emptyField()],
    observedFields: [],
    lifecycle: "draft",
    sampleEnabled: false,
    sampleRowCount: "",
    sampleComputedValue: "",
    sampleTime: now,
    sampleStatus: "pending",
    reconciliationEnabled: false,
    reconciliationExpected: "",
    reconciliationReference: "",
    reconciliationTolerance: "0",
    reconciliationTime: now,
  };
}

function draftFromReport(report: ServiceTitanReportSource): ReportDraft {
  const observedCanBeReconstructed = report.observedSchemaFingerprint === report.expectedSchemaFingerprint;
  return {
    connectionId: report.connectionId,
    categoryId: report.categoryId,
    reportId: report.reportId,
    ownerId: report.owner.id,
    ownerName: report.owner.name,
    name: report.name,
    description: report.description,
    modifiedOn: toDateTimeLocal(report.modifiedOn),
    parameters: report.parameters.map((parameter) => ({ ...parameter })),
    expectedFields: report.fields.map((field) => ({ ...field })),
    observedFields: observedCanBeReconstructed ? report.fields.map((field) => ({ ...field })) : [],
    lifecycle: report.lifecycle === "archived" ? "approved" : report.lifecycle,
    sampleEnabled: Boolean(report.sampleEvidence),
    sampleRowCount: report.sampleEvidence ? String(report.sampleEvidence.rowCount) : "",
    sampleComputedValue: report.sampleEvidence ? String(report.sampleEvidence.computedValue) : "",
    sampleTime: toDateTimeLocal(report.sampleEvidence?.sampledAt ?? report.modifiedOn),
    sampleStatus: report.sampleEvidence?.status ?? "pending",
    reconciliationEnabled: Boolean(report.reconciliationEvidence),
    reconciliationExpected: report.reconciliationEvidence ? String(report.reconciliationEvidence.expectedValue) : "",
    reconciliationReference: report.reconciliationEvidence ? String(report.reconciliationEvidence.referenceValue ?? report.reconciliationEvidence.expectedValue) : "",
    reconciliationTolerance: report.reconciliationEvidence ? String(report.reconciliationEvidence.tolerance) : "0",
    reconciliationTime: toDateTimeLocal(report.reconciliationEvidence?.reconciledAt ?? report.modifiedOn),
  };
}

function evidenceTone(status?: ServiceTitanEvidenceStatus): "pass" | "pending" | "fail" {
  return status === "pass" ? "pass" : status === "fail" ? "fail" : "pending";
}

function lifecycleTone(lifecycle: ServiceTitanReportLifecycle): "pass" | "pending" | "fail" {
  if (lifecycle === "approved") return "pass";
  if (lifecycle === "archived") return "fail";
  return "pending";
}

export function ServiceTitanSourceCatalog() {
  const [store, setStore] = useState<ServiceTitanSourceStore>(() => createSeedServiceTitanSourceStore());
  const [connections, setConnections] = useState<DemoServiceTitanConnection[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [editingReport, setEditingReport] = useState<ServiceTitanReportSource | undefined>();
  const [issues, setIssues] = useState<ReportSourceValidationIssue[]>([]);
  const [storageFailure, setStorageFailure] = useState("");
  const [savedNotice, setSavedNotice] = useState("");
  const [filter, setFilter] = useState<RegistryFilter>("active");
  const [archiveTarget, setArchiveTarget] = useState<ServiceTitanReportSource | null>(null);

  useEffect(() => {
    const hydrate = window.setTimeout(() => {
      setConnections(readConnectionStore(localStorage).connections);
      setStore(readServiceTitanSourceStore(localStorage));
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(hydrate);
  }, []);

  const activeConnections = connections.filter((connection) => connection.status !== "archived");
  const reports = useMemo(() => store.reports.filter((report) => {
    if (filter === "all") return true;
    return report.status === filter;
  }), [filter, store.reports]);
  const activeCount = store.reports.filter((report) => report.status === "active").length;
  const approvedCount = store.reports.filter((report) => report.lifecycle === "approved").length;
  const driftCount = store.reports.filter((report) => report.status === "active" && report.observedSchemaFingerprint && report.observedSchemaFingerprint !== report.expectedSchemaFingerprint).length;

  const expectedFingerprint = draft ? reportSchemaFingerprint(draft.expectedFields.filter((field) => field.name.trim())) : "";
  const observedFingerprint = draft && draft.observedFields.length
    ? reportSchemaFingerprint(draft.observedFields.filter((field) => field.name.trim()))
    : undefined;
  const schemaMatches = Boolean(observedFingerprint && observedFingerprint === expectedFingerprint);
  const reconciliationExpected = Number(draft?.reconciliationExpected);
  const reconciliationReference = Number(draft?.reconciliationReference);
  const reconciliationTolerance = Number(draft?.reconciliationTolerance);
  const reconciliationComplete = Boolean(
    draft?.reconciliationExpected.trim()
    && draft.reconciliationReference.trim()
    && draft.reconciliationTolerance.trim()
    && Number.isFinite(reconciliationExpected)
    && Number.isFinite(reconciliationReference)
    && Number.isFinite(reconciliationTolerance)
    && reconciliationTolerance >= 0
  );
  const reconciliationDelta = reconciliationComplete ? reconciliationExpected - reconciliationReference : undefined;
  const reconciliationStatus: ServiceTitanEvidenceStatus = reconciliationDelta === undefined
    ? "pending"
    : Math.abs(reconciliationDelta) <= reconciliationTolerance ? "pass" : "fail";

  function clearIssues(field?: IssueField) {
    setSavedNotice("");
    if (!field) setIssues([]);
    else setIssues((current) => current.filter((issue) => issue.field !== field));
  }

  function issueFor(field: IssueField): boolean {
    return issues.some((issue) => issue.field === field);
  }

  function closeForm() {
    setDraft(null);
    setEditingReport(undefined);
    setIssues([]);
    setStorageFailure("");
  }

  function beginCreate() {
    setEditingReport(undefined);
    setDraft(newDraft());
    setIssues([]);
    setStorageFailure("");
    setSavedNotice("");
  }

  function beginEdit(report: ServiceTitanReportSource) {
    setEditingReport(report);
    setDraft(draftFromReport(report));
    setIssues([]);
    setStorageFailure("");
    setSavedNotice("");
    window.setTimeout(() => document.getElementById("st-report-editor")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function persist(next: ServiceTitanSourceStore, failureMessage: string): boolean {
    if (!writeServiceTitanSourceStore(localStorage, next)) {
      setStorageFailure(failureMessage);
      return false;
    }
    setStore(next);
    setStorageFailure("");
    window.dispatchEvent(new CustomEvent("gmib:servicetitan-sources-updated", { detail: next }));
    return true;
  }

  function resetDemoRegistry() {
    if (!window.confirm("Reset the saved-report registry to its three labeled demo records? Browser-local report changes and archived records will be replaced.")) return;
    const next = createSeedServiceTitanSourceStore();
    if (!persist(next, "Demo registry reset failed because browser storage was unavailable.")) return;
    closeForm();
    setArchiveTarget(null);
    setFilter("active");
    setSavedNotice("Demo registry reset and saved in this browser.");
  }

  function updateParameter(index: number, patch: Partial<ServiceTitanReportParameter>) {
    if (!draft) return;
    setDraft({ ...draft, parameters: draft.parameters.map((parameter, row) => row === index ? { ...parameter, ...patch } : parameter) });
    clearIssues("parameters");
  }

  function updateField(kind: "expected" | "observed", index: number, patch: Partial<ServiceTitanReportField>) {
    if (!draft) return;
    const key = kind === "expected" ? "expectedFields" : "observedFields";
    setDraft({ ...draft, [key]: draft[key].map((field, row) => row === index ? { ...field, ...patch } : field) });
    clearIssues(kind === "expected" ? "fields" : "observedFields");
  }

  function localEvidenceIssues(): ReportSourceValidationIssue[] {
    if (!draft) return [];
    const next: ReportSourceValidationIssue[] = [];
    if (draft.observedFields.length) {
      const observedNames = draft.observedFields.map((field) => field.name.trim()).filter(Boolean);
      if (observedNames.length !== draft.observedFields.length || new Set(observedNames).size !== observedNames.length) {
        next.push({ code: "observed-fields", field: "observedFields", message: "Every simulated observed field needs a unique field name." });
      }
    }
    if (draft.sampleEnabled) {
      const rowCount = Number(draft.sampleRowCount);
      const computedValue = Number(draft.sampleComputedValue);
      if (!draft.sampleRowCount.trim() || !Number.isInteger(rowCount) || rowCount < 0 || !draft.sampleComputedValue.trim() || !Number.isFinite(computedValue) || !toTimestamp(draft.sampleTime)) {
        next.push({ code: "sample-shape", field: "sampleEvidence", message: "Manual sample evidence needs a whole row count of zero or more, a finite computed value, and a valid evidence time." });
      }
    }
    if (draft.reconciliationEnabled && (!reconciliationComplete || !toTimestamp(draft.reconciliationTime))) {
      next.push({ code: "reconciliation-shape", field: "reconciliationEvidence", message: "Manual reconciliation needs finite expected and reference values, a non-negative tolerance, and a valid evidence time." });
    }
    return next;
  }

  function saveReport(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setStorageFailure("");
    setSavedNotice("");
    const connection = connections.find((item) => item.id === draft.connectionId);
    const evidenceIssues = localEvidenceIssues();
    if (evidenceIssues.length) {
      setIssues(evidenceIssues);
      return;
    }
    const sampleTime = toTimestamp(draft.sampleTime);
    const reconciliationTime = toTimestamp(draft.reconciliationTime);
    const result = buildServiceTitanReportSource({
      connectionId: draft.connectionId,
      tenantId: connection?.tenantId ?? "",
      categoryId: draft.categoryId,
      reportId: draft.reportId,
      owner: { id: draft.ownerId, name: draft.ownerName },
      name: draft.name,
      description: draft.description,
      modifiedOn: toTimestamp(draft.modifiedOn) ?? draft.modifiedOn,
      parameters: draft.parameters,
      fields: draft.expectedFields,
      observedFields: draft.observedFields.length ? draft.observedFields : undefined,
      lifecycle: draft.lifecycle,
      sampleEvidence: draft.sampleEnabled && sampleTime ? {
        rowCount: Number(draft.sampleRowCount),
        computedValue: Number(draft.sampleComputedValue),
        sampledAt: sampleTime,
        status: draft.sampleStatus,
      } : undefined,
      reconciliationEvidence: draft.reconciliationEnabled && reconciliationTime && reconciliationDelta !== undefined ? {
        expectedValue: reconciliationExpected,
        referenceValue: reconciliationReference,
        tolerance: reconciliationTolerance,
        delta: reconciliationDelta,
        status: reconciliationStatus,
        reconciledAt: reconciliationTime,
      } : undefined,
    }, connections, store.reports, editingReport);
    if (!result.report) {
      setIssues(result.issues);
      return;
    }
    const next = upsertServiceTitanReportSource(store, result.report);
    if (!persist(next, `“${result.report.name}” was not saved because browser storage rejected the registry write.`)) return;
    closeForm();
    setSavedNotice(`${editingReport ? "Report changes" : "Report declaration"} saved in this browser.`);
  }

  function confirmArchive() {
    if (!archiveTarget) return;
    const next = archiveServiceTitanReportSource(store, archiveTarget.id);
    if (!persist(next, `“${archiveTarget.name}” was not archived because browser storage rejected the registry write.`)) return;
    setArchiveTarget(null);
    setSavedNotice("Report archived. Its metadata is retained for lineage.");
  }

  if (!hydrated) {
    return <section className="admin-card st-source-registry" aria-busy="true"><div className="st-registry-loading">Loading browser-local saved-report registry…</div></section>;
  }

  return <section className="admin-card st-source-registry" aria-labelledby="saved-report-registry-title">
    <div className="custom-kpi-toolbar st-registry-toolbar">
      <div><span>Governed report registry</span><h3 id="saved-report-registry-title">Saved ServiceTitan report declarations</h3><p>Register tenant-bound immutable IDs, expected schema, and manually supplied test evidence before a report can become an approved KPI source.</p></div>
      <div className="st-toolbar-actions">
        <button className="button secondary" type="button" onClick={resetDemoRegistry}><RotateCcw size={15}/>Reset demo registry</button>
        <button className="button primary" type="button" disabled={store.availability === "unavailable"} onClick={beginCreate}><Plus size={16}/>Register report</button>
      </div>
    </div>

    <div className="warning-note st-boundary-note"><CircleAlert size={18}/><span><strong>Public test boundary:</strong> all report metadata and evidence below is manually declared or simulated. This build does not discover, inspect, sample, or reconcile live ServiceTitan reports.</span></div>

    {storageFailure && <div className="st-storage-alert" role="alert"><CircleAlert size={18}/><div><strong>Browser storage failed</strong><p>{storageFailure} Nothing was silently treated as saved. Retry or reset the demo registry after storage is available.</p></div></div>}
    {savedNotice && <div className="st-save-notice" role="status"><CheckCircle2 size={17}/>{savedNotice}</div>}

    {store.availability === "unavailable" ? <div className="st-unavailable-state" role="alert">
      <FileSpreadsheet size={34}/><strong>Saved-report registry unavailable</strong><p>{store.unavailableReason ?? "The browser-local registry could not be read safely."} No stored report metadata is being shown.</p><button className="button primary" type="button" onClick={resetDemoRegistry}><RotateCcw size={15}/>Reset demo registry</button>
    </div> : <>
      <div className="st-registry-summary" aria-label="Registry summary">
        <div><span>Active registrations</span><strong>{activeCount}</strong></div>
        <div><span>Approved lifecycle</span><strong>{approvedCount}</strong></div>
        <div><span>Detected schema drift</span><strong className={driftCount ? "danger-text" : ""}>{driftCount}</strong></div>
        <div><span>Storage</span><strong className="summary-word">Browser-local</strong></div>
      </div>

      {draft && <form id="st-report-editor" className="st-report-form" onSubmit={saveReport} noValidate>
        <div className="template-editor-head">
          <div><span className="editor-kicker">{editingReport ? "Edit declared registration" : "New declared registration"}</span><h2>{editingReport ? editingReport.name : "Register saved report"}</h2><p>No live ServiceTitan request is made. Category and report IDs become immutable after the first save.</p></div>
          <button className="icon-btn" type="button" aria-label="Close saved-report form" onClick={closeForm}><X size={18}/></button>
        </div>

        <fieldset className="st-form-section">
          <legend>Identity and mutable metadata</legend>
          <p className="st-section-help">The connection, tenant, category ID, and report ID establish registry identity. Name and declared modifiedOn can change.</p>
          <div className="form-grid st-identity-grid">
            <label>Tenant connection
              <select value={draft.connectionId} disabled={Boolean(editingReport)} aria-invalid={issueFor("connectionId")} onChange={(event) => { setDraft({ ...draft, connectionId: event.target.value }); clearIssues("connectionId"); }}>
                <option value="">Select active connection</option>{activeConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName} · tenant {connection.tenantId}</option>)}
              </select><span className="input-help">{editingReport ? "Identity locked after registration." : "Manual selection from browser-local connection profiles."}</span>
            </label>
            <label>Display name
              <input value={draft.name} aria-invalid={issueFor("name")} onChange={(event) => { setDraft({ ...draft, name: event.target.value }); clearIssues("name"); }} placeholder="GM Operating Scorecard" />
            </label>
            <label>Immutable category ID
              <input value={draft.categoryId} readOnly={Boolean(editingReport)} aria-invalid={issueFor("categoryId")} onChange={(event) => { setDraft({ ...draft, categoryId: event.target.value }); clearIssues("categoryId"); }} placeholder="operations" />
            </label>
            <label>Immutable report ID
              <input value={draft.reportId} readOnly={Boolean(editingReport)} aria-invalid={issueFor("reportId")} onChange={(event) => { setDraft({ ...draft, reportId: event.target.value }); clearIssues("reportId"); }} placeholder="100101" />
            </label>
            <label>Owner ID
              <input required value={draft.ownerId} aria-invalid={issueFor("owner")} onChange={(event) => { setDraft({ ...draft, ownerId: event.target.value }); clearIssues("owner"); }} placeholder="gm-analytics" />
              <span className="input-help">Immutable ServiceTitan user or team identifier.</span>
            </label>
            <label>Owner name
              <input required value={draft.ownerName} aria-invalid={issueFor("owner")} onChange={(event) => { setDraft({ ...draft, ownerName: event.target.value }); clearIssues("owner"); }} placeholder="GM Analytics" />
            </label>
            <label>Declared modifiedOn
              <input type="datetime-local" value={draft.modifiedOn} aria-invalid={issueFor("modifiedOn")} onChange={(event) => { setDraft({ ...draft, modifiedOn: event.target.value }); clearIssues("modifiedOn"); }} />
              <span className="input-help">Manually copied report metadata; not live-discovered.</span>
            </label>
            <label className="span-two">Description
              <textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Business purpose, grain, exclusions, and owner" />
            </label>
          </div>
        </fieldset>

        <fieldset className="st-form-section">
          <legend className="sr-only">Declared parameters</legend>
          <div className="st-section-heading"><div><h3>Declared parameters</h3><p>Structured metadata only. Values and dynamic sets are not fetched in this public test.</p></div><button className="catalog-action-button" type="button" onClick={() => { setDraft({ ...draft, parameters: [...draft.parameters, emptyParameter()] }); clearIssues("parameters"); }}><Plus size={14}/>Add parameter row</button></div>
          {draft.parameters.length === 0 ? <div className="st-row-empty">No parameters declared. Add a row if the saved report requires input.</div> : <div className="st-repeatable-list">
            <div className="st-parameter-row st-repeatable-head" aria-hidden="true"><span>Name</span><span>Label</span><span>Type</span><span>Array</span><span>Required</span><span>Dynamic set ID</span><span>Remove</span></div>
            {draft.parameters.map((parameter, index) => <div className="st-parameter-row" key={`parameter-${index}`}>
              <label><span className="sr-only">Parameter {index + 1} name</span><input value={parameter.name} aria-invalid={issueFor("parameters")} onChange={(event) => updateParameter(index, { name: event.target.value })} placeholder="From" /></label>
              <label><span className="sr-only">Parameter {index + 1} label</span><input value={parameter.label} onChange={(event) => updateParameter(index, { label: event.target.value })} placeholder="Start date" /></label>
              <label><span className="sr-only">Parameter {index + 1} type</span><select value={parameter.dataType} onChange={(event) => updateParameter(index, { dataType: event.target.value as ServiceTitanReportParameterDataType })}>{parameterTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
              <label className="st-check-cell"><input type="checkbox" checked={parameter.isArray} onChange={(event) => updateParameter(index, { isArray: event.target.checked })}/><span>Array</span></label>
              <label className="st-check-cell"><input type="checkbox" checked={parameter.isRequired} onChange={(event) => updateParameter(index, { isRequired: event.target.checked })}/><span>Required</span></label>
              <label><span className="sr-only">Parameter {index + 1} dynamic set ID</span><input value={parameter.dynamicSetId ?? ""} onChange={(event) => updateParameter(index, { dynamicSetId: event.target.value || undefined })} placeholder="business-units" /></label>
              <button className="st-remove-row" type="button" aria-label={`Remove parameter row ${index + 1}`} onClick={() => { setDraft({ ...draft, parameters: draft.parameters.filter((_, row) => row !== index) }); clearIssues("parameters"); }}><Trash2 size={15}/></button>
            </div>)}
          </div>}
        </fieldset>

        <fieldset className="st-form-section">
          <legend className="sr-only">Expected output schema</legend>
          <div className="st-section-heading"><div><h3>Expected output schema</h3><p>Manually declare each output column. At least one numeric field is required for KPI materialization.</p></div><button className="catalog-action-button" type="button" onClick={() => { setDraft({ ...draft, expectedFields: [...draft.expectedFields, emptyField()] }); clearIssues("fields"); }}><Plus size={14}/>Add expected field</button></div>
          <FieldRows kind="expected" fields={draft.expectedFields} invalid={issueFor("fields")} onChange={updateField} onRemove={(index) => { setDraft({ ...draft, expectedFields: draft.expectedFields.filter((_, row) => row !== index) }); clearIssues("fields"); }} />
          <div className="st-fingerprint-preview"><span>Expected fingerprint</span><code>{expectedFingerprint}</code><span>{draft.expectedFields.filter((field) => field.type === "number" && field.name.trim()).length} numeric field(s)</span></div>
        </fieldset>

        <fieldset className="st-form-section st-simulated-section">
          <legend className="sr-only">Simulated observed schema</legend>
          <div className="st-section-heading"><div><h3>Simulated observed schema</h3><p>Enter a simulated observation for this public test. This does not inspect ServiceTitan.</p></div><div className="st-inline-actions"><button className="catalog-action-button" type="button" onClick={() => { setDraft({ ...draft, observedFields: draft.expectedFields.map((field) => ({ ...field })), lifecycle: draft.lifecycle === "draft" ? "inspected" : draft.lifecycle }); clearIssues("observedFields"); }}><FlaskConical size={14}/>Simulate matching observation</button><button className="catalog-action-button" type="button" onClick={() => { setDraft({ ...draft, observedFields: [...draft.observedFields, emptyField()] }); clearIssues("observedFields"); }}><Plus size={14}/>Add observed field</button></div></div>
          {editingReport?.observedSchemaFingerprint && editingReport.observedSchemaFingerprint !== editingReport.expectedSchemaFingerprint && draft.observedFields.length === 0 && <div className="st-form-note"><CircleAlert size={15}/>The persisted observation shows drift, but v2 stores only its fingerprint. Re-enter simulated observed rows to replace it.</div>}
          {draft.observedFields.length ? <FieldRows kind="observed" fields={draft.observedFields} invalid={issueFor("observedFields")} onChange={updateField} onRemove={(index) => { setDraft({ ...draft, observedFields: draft.observedFields.filter((_, row) => row !== index) }); clearIssues("observedFields"); }} /> : <div className="st-row-empty">No simulated observation. Verification remains declared until observed rows are supplied.</div>}
          <div className={`st-schema-result ${!observedFingerprint ? "pending" : schemaMatches ? "pass" : "fail"}`}>
            <GitCompareArrows size={17}/><div><span>Observed fingerprint</span><code>{observedFingerprint ?? "Not simulated"}</code></div><strong>{!observedFingerprint ? "Not inspected" : schemaMatches ? "Match" : "Drift detected"}</strong>
          </div>
        </fieldset>

        <fieldset className="st-form-section">
          <legend className="sr-only">Manual and simulated evidence</legend>
          <div className="st-section-heading"><div><h3>Manual / simulated evidence</h3><p>Evidence below is declared by an admin for workflow testing; no report rows or live totals are fetched.</p></div></div>
          <div className="st-evidence-toggle"><label><input type="checkbox" checked={draft.sampleEnabled} disabled={Boolean(editingReport?.sampleEvidence)} onChange={(event) => { setDraft({ ...draft, sampleEnabled: event.target.checked }); clearIssues("sampleEvidence"); }}/><span><strong>Include manually declared sample evidence</strong><small>{editingReport?.sampleEvidence ? "Declared evidence is retained for lineage; its values can be revised below." : "Row count, computed value, evidence time, and admin-selected status."}</small></span></label></div>
          {draft.sampleEnabled && <div className="st-evidence-grid">
            <label>Simulated row count<input inputMode="numeric" value={draft.sampleRowCount} aria-invalid={issueFor("sampleEvidence")} onChange={(event) => { setDraft({ ...draft, sampleRowCount: event.target.value }); clearIssues("sampleEvidence"); }} placeholder="25" /></label>
            <label>Simulated computed value<input inputMode="decimal" value={draft.sampleComputedValue} aria-invalid={issueFor("sampleEvidence")} onChange={(event) => { setDraft({ ...draft, sampleComputedValue: event.target.value }); clearIssues("sampleEvidence"); }} placeholder="70" /></label>
            <label>Declared sample time<input type="datetime-local" value={draft.sampleTime} aria-invalid={issueFor("sampleEvidence")} onChange={(event) => { setDraft({ ...draft, sampleTime: event.target.value }); clearIssues("sampleEvidence"); }} /></label>
            <label>Manually assigned sample status<select value={draft.sampleStatus} onChange={(event) => { setDraft({ ...draft, sampleStatus: event.target.value as ServiceTitanEvidenceStatus }); clearIssues("sampleEvidence"); }}>{evidenceStatuses.map((status) => <option key={status}>{status}</option>)}</select></label>
          </div>}
          <div className="st-evidence-toggle"><label><input type="checkbox" checked={draft.reconciliationEnabled} disabled={Boolean(editingReport?.reconciliationEvidence)} onChange={(event) => { setDraft({ ...draft, reconciliationEnabled: event.target.checked }); clearIssues("reconciliationEvidence"); }}/><span><strong>Include manually entered reconciliation</strong><small>{editingReport?.reconciliationEvidence ? "Declared evidence is retained for lineage; its values can be revised below." : "Delta and pass/fail status are calculated locally from declared values and tolerance."}</small></span></label></div>
          {draft.reconciliationEnabled && <>
            <div className="st-evidence-grid">
              <label>Simulated computed / expected value<input inputMode="decimal" value={draft.reconciliationExpected} aria-invalid={issueFor("reconciliationEvidence")} onChange={(event) => { setDraft({ ...draft, reconciliationExpected: event.target.value }); clearIssues("reconciliationEvidence"); }} placeholder="70" /></label>
              <label>Manually declared reference value<input inputMode="decimal" value={draft.reconciliationReference} aria-invalid={issueFor("reconciliationEvidence")} onChange={(event) => { setDraft({ ...draft, reconciliationReference: event.target.value }); clearIssues("reconciliationEvidence"); }} placeholder="70" /></label>
              <label>Absolute tolerance<input inputMode="decimal" value={draft.reconciliationTolerance} aria-invalid={issueFor("reconciliationEvidence")} onChange={(event) => { setDraft({ ...draft, reconciliationTolerance: event.target.value }); clearIssues("reconciliationEvidence"); }} placeholder="0.01" /></label>
              <label>Declared reconciliation time<input type="datetime-local" value={draft.reconciliationTime} aria-invalid={issueFor("reconciliationEvidence")} onChange={(event) => { setDraft({ ...draft, reconciliationTime: event.target.value }); clearIssues("reconciliationEvidence"); }} /></label>
            </div>
            <div className={`st-reconciliation-result ${evidenceTone(reconciliationStatus)}`}><span>Calculated delta <strong>{reconciliationDelta === undefined ? "—" : formatNumber(reconciliationDelta)}</strong></span><span>Calculated status <strong>{reconciliationStatus}</strong></span><small>Rule: |expected − reference| ≤ tolerance.</small></div>
          </>}
        </fieldset>

        <fieldset className="st-form-section st-lifecycle-section">
          <legend>Lifecycle progression</legend>
          <p className="st-section-help">Choose the lifecycle target manually. The domain builder—not a disabled UI shortcut—blocks approval unless observed schema matches and both evidence checks pass.</p>
          <div className="st-lifecycle-grid" role="radiogroup" aria-label="Manual lifecycle target">{lifecycles.map((lifecycle, index) => <label className={draft.lifecycle === lifecycle ? "selected" : ""} key={lifecycle}><input type="radio" name="report-lifecycle" value={lifecycle} checked={draft.lifecycle === lifecycle} onChange={() => { setDraft({ ...draft, lifecycle }); clearIssues(); }}/><span>{index + 1}</span><strong>{lifecycle}</strong><small>{lifecycle === "draft" ? "Metadata declaration" : lifecycle === "inspected" ? "Simulated schema supplied" : lifecycle === "reconciled" ? "Manual evidence reviewed" : "Domain-gated approval"}</small></label>)}</div>
          {draft.lifecycle === "approved" && <div className="st-approval-gate"><ShieldCheck size={17}/><span>Approval attempt will be validated against schema match, passing sample evidence, and passing reconciliation evidence.</span></div>}
        </fieldset>

        {issues.length > 0 && <div className="validation-list compact st-validation-summary" role="alert"><strong>Resolve {issues.length} validation issue{issues.length === 1 ? "" : "s"}</strong>{issues.map((issue, index) => <div className="fail" key={`${issue.code}-${index}`}><CircleAlert size={15}/>{issue.message}</div>)}</div>}
        <div className="st-form-footer"><span><LockKeyhole size={15}/>Manual/simulated metadata · browser-local write</span><div><button className="button secondary" type="button" onClick={() => { if (editingReport) { setDraft(draftFromReport(editingReport)); setIssues([]); setStorageFailure(""); } else { setDraft(newDraft()); setIssues([]); setStorageFailure(""); } }}><RotateCcw size={15}/>Reset form</button><button className="button secondary" type="button" onClick={closeForm}>Cancel</button><button className="button primary" type="submit"><Save size={15}/>{draft.lifecycle === "approved" ? "Attempt domain approval" : "Save declared metadata"}</button></div></div>
      </form>}

      <div className="st-registry-controls">
        <div role="group" aria-label="Filter saved reports">{(["active", "all", "archived"] as RegistryFilter[]).map((option) => <button type="button" className={filter === option ? "active" : ""} aria-pressed={filter === option} key={option} onClick={() => setFilter(option)}>{option}<span>{option === "all" ? store.reports.length : store.reports.filter((report) => report.status === option).length}</span></button>)}</div>
        <span>{reports.length} visible registration{reports.length === 1 ? "" : "s"}</span>
      </div>

      {reports.length === 0 ? <div className="small-empty st-registry-empty"><FileSpreadsheet/><strong>{store.reports.length ? `No ${filter} registrations` : "Registry is empty"}</strong><p>{store.reports.length ? "Choose another registry filter." : "Register a tenant-specific saved report or restore the labeled demo records."}</p>{store.reports.length === 0 && <div className="st-empty-actions"><button className="button primary" type="button" onClick={beginCreate}><Plus size={15}/>Register first report</button><button className="button secondary" type="button" onClick={resetDemoRegistry}><RotateCcw size={15}/>Reset demo registry</button></div>}</div> : <div className="st-report-card-list">
        {reports.map((report) => {
          const connection = connections.find((item) => item.id === report.connectionId);
          const drift = Boolean(report.observedSchemaFingerprint && report.observedSchemaFingerprint !== report.expectedSchemaFingerprint);
          const numericFields = report.fields.filter((field) => field.type === "number");
          return <article className={`st-report-card ${report.status === "archived" ? "archived" : ""}`} key={report.id}>
            <div className="st-report-card-head">
              <div><div className="st-card-kicker"><span className={`validation-chip ${lifecycleTone(report.lifecycle)}`}>{report.lifecycle}</span><span className={`validation-chip ${report.verification === "inspected" ? "pass" : "pending"}`}>{report.verification === "demo" ? "Labeled demo" : report.verification}</span><span className={`validation-chip ${report.status === "active" ? "pass" : "fail"}`}>{report.status}</span></div><h4>{report.name}</h4><p>{report.description || "No description declared."}</p></div>
              {report.status === "active" ? <div className="st-card-actions"><button className="catalog-action-button" type="button" aria-label={`Review and edit ${report.name}`} onClick={() => beginEdit(report)}><Pencil size={14}/>Review / edit</button><button className="catalog-action-button danger" type="button" aria-label={`Begin archive review for ${report.name}`} onClick={() => setArchiveTarget(report)}><Archive size={14}/>Archive…</button></div> : <span className="st-archived-label"><Archive size={14}/>Retained for lineage</span>}
            </div>
            <div className="st-report-facts">
              <div><span>Tenant / connection</span><strong>{report.tenantId}</strong><small>{connection?.displayName ?? `Connection ${report.connectionId} unavailable`}</small></div>
              <div><span>Immutable IDs</span><strong><code>{report.categoryId}</code> / <code>{report.reportId}</code></strong><small>Category / report</small></div>
              <div><span>Mutable metadata</span><strong>{formatTimestamp(report.modifiedOn)}</strong><small>Declared modifiedOn · updated {formatTimestamp(report.updatedAt)}</small></div>
              <div><span>Parameters / numeric fields</span><strong>{report.parameters.length} / {numericFields.length}</strong><small>{numericFields.length ? numericFields.map((field) => field.name).join(", ") : "No numeric outputs"}</small></div>
            </div>
            <div className="st-card-schema">
              <div><span>Expected fingerprint</span><code>{report.expectedSchemaFingerprint}</code><small>{report.fields.length} declared fields</small></div>
              <GitCompareArrows size={18}/>
              <div><span>Observed fingerprint</span><code>{report.observedSchemaFingerprint ?? "Not simulated"}</code><small className={drift ? "danger-text" : ""}>{!report.observedSchemaFingerprint ? "Inspection unavailable" : drift ? "Schema drift" : "Schema match"}</small></div>
            </div>
            <div className="st-card-evidence">
              <div><span>Sample evidence</span>{report.sampleEvidence ? <><strong><span className={`validation-chip ${evidenceTone(report.sampleEvidence.status)}`}>{report.sampleEvidence.status}</span>{report.sampleEvidence.rowCount} rows · {formatNumber(report.sampleEvidence.computedValue)}</strong><small>Manual/simulated · {formatTimestamp(report.sampleEvidence.sampledAt)}</small></> : <><strong>Unavailable</strong><small>No sample evidence declared</small></>}</div>
              <div><span>Reconciliation</span>{report.reconciliationEvidence ? <><strong><span className={`validation-chip ${evidenceTone(report.reconciliationEvidence.status)}`}>{report.reconciliationEvidence.status}</span>Δ {formatNumber(report.reconciliationEvidence.delta)} · tol {formatNumber(report.reconciliationEvidence.tolerance)}</strong><small>Expected {formatNumber(report.reconciliationEvidence.expectedValue)} / reference {formatNumber(report.reconciliationEvidence.referenceValue ?? report.reconciliationEvidence.expectedValue)} · {formatTimestamp(report.reconciliationEvidence.reconciledAt)}</small></> : <><strong>Unavailable</strong><small>No reconciliation declared</small></>}</div>
              <div><span>Dependencies</span><strong>Not evaluated</strong><small>Placeholder: KPI bindings are unavailable in this public test registry.</small></div>
            </div>
          </article>;
        })}
      </div>}

      {archiveTarget && <div className="st-archive-warning" role="alertdialog" aria-labelledby="archive-warning-title" aria-describedby="archive-warning-copy">
        <CircleAlert size={20}/><div><strong id="archive-warning-title">Dependency check unavailable — archive “{archiveTarget.name}”?</strong><p id="archive-warning-copy">This public test cannot enumerate dependent KPI bindings. Archiving changes the source to inactive and may cause published KPI bindings to fail closed until remapped. Metadata remains retained for lineage; this action is not silent.</p></div><div><button className="button secondary" type="button" onClick={() => setArchiveTarget(null)}>Cancel</button><button className="button primary danger-button" type="button" onClick={confirmArchive}><Archive size={15}/>Confirm archive</button></div>
      </div>}
    </>}

    <div className="registry-foot"><CheckCircle2 size={16}/><span>Saved-report refresh is restricted to every 4, 12, or 24 hours. This registry stores declarations only; no scheduled refresh runs in the public test build.</span></div>
  </section>;
}

function FieldRows({ kind, fields, invalid, onChange, onRemove }: {
  kind: "expected" | "observed";
  fields: ServiceTitanReportField[];
  invalid: boolean;
  onChange: (kind: "expected" | "observed", index: number, patch: Partial<ServiceTitanReportField>) => void;
  onRemove: (index: number) => void;
}) {
  return <div className="st-repeatable-list">
    <div className="st-field-row st-repeatable-head" aria-hidden="true"><span>Name</span><span>Label</span><span>Type</span><span>Remove</span></div>
    {fields.map((field, index) => <div className="st-field-row" key={`${kind}-field-${index}`}>
      <label><span className="sr-only">{kind} field {index + 1} name</span><input value={field.name} aria-invalid={invalid} onChange={(event) => onChange(kind, index, { name: event.target.value })} placeholder={kind === "expected" ? "Revenue" : "ObservedColumn"} /></label>
      <label><span className="sr-only">{kind} field {index + 1} label</span><input value={field.label} onChange={(event) => onChange(kind, index, { label: event.target.value })} placeholder="Display label" /></label>
      <label><span className="sr-only">{kind} field {index + 1} type</span><select value={field.type} onChange={(event) => onChange(kind, index, { type: event.target.value as ServiceTitanReportFieldType })}>{fieldTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
      <button className="st-remove-row" type="button" aria-label={`Remove ${kind} field row ${index + 1}`} onClick={() => onRemove(index)}><Trash2 size={15}/></button>
    </div>)}
  </div>;
}
