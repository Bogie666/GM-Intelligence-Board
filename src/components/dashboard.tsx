"use client";

import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  BriefcaseBusiness,
  CalendarDays,
  ChevronDown,
  CircleDollarSign,
  GripVertical,
  LayoutDashboard,
  Menu,
  PhoneCall,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getMetrics, locations, sectionMeta } from "@/lib/demo-data";
import { createSeedConnectionStore, DEMO_CONNECTION_STORAGE_KEY, readConnectionStore, type DemoServiceTitanConnection } from "@/lib/demo-connections";
import { createCsv, readHiddenMetricIds, readMetricOrders, writeDashboardLayoutState } from "@/lib/demo-dashboard-state";
import { defaultRoleTemplates, normalizeRoleTemplates, ROLE_TEMPLATE_STORAGE_KEY } from "@/lib/layout-templates";
import { CUSTOM_KPI_STORAGE_KEY, customKpiToMetric, evaluateCustomKpis, readCustomKpiStore, serviceTitanObservationFingerprint, type CustomKpiDefinition, type EvaluatedCustomKpi } from "@/lib/custom-kpis";
import { changeFromPrior, formatMetric, metricAttainment, metricStatus, reorder } from "@/lib/metrics";
import { applyPublishedTargets, createSeedTargetBudgetStore, DEMO_AS_OF_DATE, DEMO_FISCAL_MONTH, readTargetBudgetStore, type TargetBudgetStore, type TargetContext, type TargetedMetric } from "@/lib/targets";
import { createSeedServiceTitanSourceStore, readServiceTitanSourceStore, SERVICE_TITAN_SOURCE_STORAGE_KEY, type ServiceTitanReportSource } from "@/lib/service-titan-sources";
import type { LayoutTemplate, Metric, MetricSection, Status } from "@/lib/types";

const sections: { id: MetricSection; icon: typeof Activity; short: string }[] = [
  { id: "executive", icon: LayoutDashboard, short: "Executive" },
  { id: "revenue", icon: CircleDollarSign, short: "Revenue" },
  { id: "calls", icon: PhoneCall, short: "Calls & Digital" },
  { id: "appointments", icon: CalendarDays, short: "Appointments" },
  { id: "sales", icon: BriefcaseBusiness, short: "Sales" },
  { id: "membership", icon: Star, short: "Membership" },
];

const periods = ["Today", "Yesterday", "MTD", "QTD", "YTD", "Last 30 Days"];
const statusCopy: Record<Status, string> = {
  good: "On target",
  watch: "Watch",
  critical: "Off track",
  neutral: "Informational",
};

interface ServiceTitanInsightLineage {
  path: string[];
  tenantId: string;
  locationLabel: string;
  observationAsOf?: string;
  sourceFingerprint?: string;
  sourceVersion?: number;
}

function formatObservationTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

function Sparkline({ values, status }: { values: number[]; status: Status }) {
  const width = 120;
  const height = 34;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const points = values.map((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * width;
    const y = height - ((value - min) / range) * (height - 5) - 2;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg className={`sparkline sparkline-${status}`} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function targetSourceLabel(context: TargetContext): string {
  if (context.source === "budget") return `Revenue budget · v${context.version} · ${context.versionName}`;
  const grain = [context.trade, context.serviceLine].filter((value) => value && value !== "all").join(" / ");
  return `${context.locationId === "*" || context.locationId === "portfolio" ? "Portfolio fallback" : "Location target"}${grain ? ` · ${grain}` : ""} · v${context.version}`;
}

function MetricCard({
  metric,
  editable,
  onOpen,
  onHide,
  onDragStart,
  onDrop,
}: {
  metric: TargetedMetric;
  editable: boolean;
  onOpen: () => void;
  onHide: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const status = metricStatus(metric);
  const attainment = metricAttainment(metric);
  const change = changeFromPrior(metric);
  const favorableChange = change !== null && (metric.direction === "lower" ? change <= 0 : change >= 0);
  const TrendIcon = change !== null && change < 0 ? ArrowDownRight : ArrowUpRight;
  return (
    <article
      className={`metric-card status-${status} ${editable ? "is-editable" : ""}`}
      draggable={editable}
      onDragStart={onDragStart}
      onDragOver={(event) => editable && event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); onDrop(); }}
      onClick={() => !editable && onOpen()}
    >
      <div className="metric-card-topline" />
      <div className="metric-head">
        <div>
          <div className="metric-label">{metric.title}</div>
          <div className="source-label"><span className="source-dot" />{metric.source}</div>
        </div>
        {editable ? (
          <div className="edit-actions">
            <GripVertical size={18} aria-label="Drag to reorder" />
            <button onClick={(event) => { event.stopPropagation(); onHide(); }} aria-label={`Hide ${metric.title}`}><X size={15} /></button>
          </div>
        ) : <span className={`status-pill ${status}`}>{statusCopy[status]}</span>}
      </div>
      <div className="metric-main">
        <div className="metric-value">{formatMetric(metric.actual, metric.kind)}</div>
        <Sparkline values={metric.sparkline} status={status} />
      </div>
      <div className="metric-subtitle">{metric.subtitle}</div>
      {metric.targetContext && <div className="target-source-label">{targetSourceLabel(metric.targetContext)}</div>}
      <div className="metric-footer">
        {attainment !== null ? (
          <div className="attainment">
            <div className="attainment-copy"><span>{Math.round(attainment)}% of target</span><strong>{formatMetric(metric.goal ?? 0, metric.kind)}</strong></div>
            <div className="progress-track"><span style={{ width: `${Math.min(Math.max(attainment, 0), 100)}%` }} /></div>
          </div>
        ) : <span className="no-target">No target configured</span>}
        {change !== null && (
          <div className={`change ${favorableChange ? "up" : "down"}`}><TrendIcon size={14} />{Math.abs(change).toFixed(1)}%</div>
        )}
      </div>
      {!editable && <div className="card-open-hint">View insight <span>→</span></div>}
    </article>
  );
}

function UnavailableServiceTitanCard({
  definition,
  evaluation,
  tenantId,
  locationLabel,
}: {
  definition: CustomKpiDefinition;
  evaluation: EvaluatedCustomKpi;
  tenantId: string;
  locationLabel: string;
}) {
  const titleId = `unavailable-${definition.id}`;
  const observation = evaluation.lastValidObservation;
  return (
    <article className="metric-card unavailable-kpi-card" aria-labelledby={titleId} aria-describedby={`${titleId}-reason`}>
      <div className="metric-card-topline" />
      <div className="metric-head">
        <div>
          <div className="metric-label" id={titleId}>{definition.title}</div>
          <div className="source-label"><span className="source-dot" />ServiceTitan · source health</div>
        </div>
        <span className="status-pill unavailable"><AlertTriangle size={11} aria-hidden="true" />Unavailable</span>
      </div>
      <div className="unavailable-scope">
        <span>Tenant <strong>{tenantId}</strong></span>
        <span>Location <strong>{locationLabel}</strong></span>
      </div>
      {observation ? (
        <div className="last-valid-observation">
          <span>Last valid · not current</span>
          <strong>{formatMetric(observation.value, definition.kind)}</strong>
          <small>As of {formatObservationTime(observation.asOf)}</small>
        </div>
      ) : (
        <div className="no-current-observation">No trusted current observation is available.</div>
      )}
      <p className="unavailable-reason" id={`${titleId}-reason`}>{evaluation.reason ?? "The governed ServiceTitan source is unavailable."}</p>
      <Link className="unavailable-action" href="/admin">Review source in Admin <span aria-hidden="true">→</span></Link>
    </article>
  );
}

function InsightDrawer({ metric, lineage, onClose }: { metric: TargetedMetric | null; lineage?: ServiceTitanInsightLineage; onClose: () => void }) {
  if (!metric) return null;
  const status = metricStatus(metric);
  const attainment = metricAttainment(metric);
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="insight-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <span className={`status-pill ${status}`}>{statusCopy[status]}</span>
            <h2>{metric.title}</h2>
            <p>{metric.subtitle}</p>
          </div>
          <button className="icon-btn" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="drawer-kpis">
          <div><span>Actual</span><strong>{formatMetric(metric.actual, metric.kind)}</strong></div>
          <div><span>Target</span><strong>{metric.goal === undefined ? "Not set" : formatMetric(metric.goal, metric.kind)}</strong></div>
          <div><span>Attainment</span><strong>{attainment === null ? "—" : `${Math.round(attainment)}%`}</strong></div>
        </div>
        <div className="drawer-chart">
          <div className="drawer-section-label">7-period trend</div>
          <Sparkline values={metric.sparkline} status={status} />
        </div>
        <div className="drawer-section-label">GM playbook</div>
        <div className="playbook-list">
          {(metric.playbook ?? [
            { title: "Validate the signal", detail: "Confirm mapping, exclusions, and the operational denominator before coaching to this KPI." },
            { title: "Assign an owner", detail: "Choose one accountable leader and one measurable action for the next operating huddle." },
          ]).map((step, index) => (
            <div className="playbook-step" key={step.title}>
              <span>{status === "good" ? <Sparkles size={15} /> : index + 1}</span>
              <div><strong>{step.title}</strong><p>{step.detail}</p></div>
            </div>
          ))}
        </div>
        <div className={`data-definition ${lineage ? "service-titan-lineage" : ""}`}>
          <ShieldCheck size={18} />
          {lineage ? (
            <div>
              <strong>Materialized ServiceTitan lineage</strong>
              <p>{lineage.path.join(" → ")}</p>
              <dl className="lineage-facts">
                <div><dt>Scope</dt><dd>Tenant {lineage.tenantId} · {lineage.locationLabel}</dd></div>
                <div><dt>Observation</dt><dd>{lineage.observationAsOf ? `As of ${formatObservationTime(lineage.observationAsOf)}` : "Materialized observation"}</dd></div>
                {lineage.sourceFingerprint && <div><dt>Source identity</dt><dd>{lineage.sourceFingerprint}{lineage.sourceVersion ? ` · v${lineage.sourceVersion}` : ""}</dd></div>}
              </dl>
            </div>
          ) : <div><strong>Data lineage</strong><p>Primary source: {metric.source}. Metric definitions and tenant-specific exclusions are managed in Admin → KPI Library.</p></div>}
        </div>
        {metric.targetContext && (
          <div className="data-definition target-lineage">
            <CircleDollarSign size={18} />
            <div><strong>Target lineage</strong><p>{targetSourceLabel(metric.targetContext)} · Owner: {metric.targetContext.owner} · Scope: {metric.targetContext.locationId}{metric.targetContext.fiscalMonth ? ` · Period: ${metric.targetContext.fiscalMonth}` : ` · Effective: ${metric.targetContext.effectiveFrom} through ${metric.targetContext.effectiveTo ?? "open-ended"}`}.</p></div>
          </div>
        )}
      </aside>
    </div>
  );
}

export function Dashboard() {
  const [locationId, setLocationId] = useState(locations[0].id);
  const [section, setSection] = useState<MetricSection>("executive");
  const [period, setPeriod] = useState("MTD");
  const [editMode, setEditMode] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [selectedMetric, setSelectedMetric] = useState<TargetedMetric | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [orders, setOrders] = useState<Record<string, string[]>>({});
  const [customDefinitions, setCustomDefinitions] = useState<CustomKpiDefinition[]>([]);
  const [serviceTitanConnections, setServiceTitanConnections] = useState<DemoServiceTitanConnection[]>(() => createSeedConnectionStore().connections);
  const [serviceTitanReports, setServiceTitanReports] = useState<ServiceTitanReportSource[]>(() => createSeedServiceTitanSourceStore().reports);
  const [contextNow, setContextNow] = useState("");
  const [targetBudgetStore, setTargetBudgetStore] = useState<TargetBudgetStore>(() => createSeedTargetBudgetStore());
  const [roleTemplates, setRoleTemplates] = useState<LayoutTemplate[]>(defaultRoleTemplates);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [showDemoBanner, setShowDemoBanner] = useState(true);
  const [dashboardActionError, setDashboardActionError] = useState("");

  useEffect(() => {
    const refreshDefinitions = () => {
      const now = new Date().toISOString();
      const store = readCustomKpiStore(localStorage, now);
      setCustomDefinitions(store.definitions);
      const publishedIds = store.definitions.filter((item) => item.status === "published").map((item) => item.id);
      try { setRoleTemplates(normalizeRoleTemplates(JSON.parse(localStorage.getItem(ROLE_TEMPLATE_STORAGE_KEY) ?? "[]"), publishedIds)); } catch { setRoleTemplates(normalizeRoleTemplates([], publishedIds)); }
      setContextNow(now);
    };
    const refreshServiceTitanContext = () => {
      setServiceTitanConnections(readConnectionStore(localStorage).connections);
      setServiceTitanReports(readServiceTitanSourceStore(localStorage).reports);
      setContextNow(new Date().toISOString());
    };
    const hydrate = window.setTimeout(() => {
      setHidden(readHiddenMetricIds(localStorage));
      setOrders(readMetricOrders(localStorage));
      refreshDefinitions();
      refreshServiceTitanContext();
      setTargetBudgetStore(readTargetBudgetStore(localStorage));
      setMounted(true);
    }, 0);
    const sourceUpdated = () => refreshServiceTitanContext();
    const storageUpdated = (event: StorageEvent) => {
      if (event.key === null || event.key === SERVICE_TITAN_SOURCE_STORAGE_KEY || event.key === DEMO_CONNECTION_STORAGE_KEY) refreshServiceTitanContext();
      if (event.key === null || event.key === CUSTOM_KPI_STORAGE_KEY || event.key === ROLE_TEMPLATE_STORAGE_KEY) refreshDefinitions();
    };
    const refreshOnFocus = () => refreshServiceTitanContext();
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") refreshServiceTitanContext(); };
    const clock = window.setInterval(() => setContextNow(new Date().toISOString()), 60_000);
    window.addEventListener("gmib:servicetitan-sources-updated", sourceUpdated);
    window.addEventListener("storage", storageUpdated);
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearTimeout(hydrate);
      window.clearInterval(clock);
      window.removeEventListener("gmib:servicetitan-sources-updated", sourceUpdated);
      window.removeEventListener("storage", storageUpdated);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  const location = locations.find((item) => item.id === locationId) ?? locations[0];
  const coreMetrics = useMemo(() => getMetrics(location), [location]);
  const scopedPublishedDefinitions = useMemo(() => customDefinitions.filter((definition) =>
    definition.status === "published" && (definition.scopeMode === "portfolio" || definition.locationIds.includes(location.id))), [customDefinitions, location.id]);
  const customEvaluations = useMemo(() => evaluateCustomKpis(customDefinitions, coreMetrics, {
    tenantId: location.tenantId,
    locationId: location.id,
    locations,
    connections: serviceTitanConnections,
    serviceTitanReports,
    now: contextNow,
  }), [customDefinitions, coreMetrics, location.tenantId, location.id, serviceTitanConnections, serviceTitanReports, contextNow]);
  const allMetrics = useMemo(() => {
    const custom = scopedPublishedDefinitions
      .map((definition) => customKpiToMetric(definition, customEvaluations.get(definition.id) ?? { state: "unavailable", sparkline: [], source: "Custom", lineage: [], reason: "Unavailable" }))
      .filter((metric): metric is Metric => Boolean(metric));
    return applyPublishedTargets([...coreMetrics, ...custom], location.id, DEMO_AS_OF_DATE, targetBudgetStore.rules, targetBudgetStore.budgets, DEMO_FISCAL_MONTH);
  }, [coreMetrics, scopedPublishedDefinitions, customEvaluations, location.id, targetBudgetStore]);
  const serviceTitanLineage = useMemo(() => {
    const result = new Map<string, ServiceTitanInsightLineage>();
    scopedPublishedDefinitions.filter((definition) => definition.type === "service-titan").forEach((definition) => {
      const evaluation = customEvaluations.get(definition.id);
      const source = definition.serviceTitanSource;
      if (evaluation?.state !== "available" || !source) return;
      const binding = source.tenantBindings.find((item) => item.tenantId === location.tenantId
        && item.locationIds?.length === 1 && item.locationIds[0] === location.id);
      if (!binding) return;
      const observation = binding.observation;
      const report = serviceTitanReports.find((item) => item.id === binding.reportSourceId);
      result.set(definition.id, {
        path: evaluation.lineage,
        tenantId: location.tenantId,
        locationLabel: `${location.brand} · ${location.location}`,
        observationAsOf: observation?.asOf ?? binding.prototypeAsOf,
        sourceFingerprint: observation?.sourceFingerprint ?? serviceTitanObservationFingerprint(source, binding, report),
        sourceVersion: observation?.sourceVersion ?? (source.method === "endpoint-recipe" ? source.endpointRecipeVersion : definition.version),
      });
    });
    return result;
  }, [scopedPublishedDefinitions, customEvaluations, location, serviceTitanReports]);
  const gmTemplate = roleTemplates.find((template) => template.id === "gm-daily") ?? defaultRoleTemplates[0];
  const sectionMetrics = useMemo(() => {
    const inSection = allMetrics.filter((metric) => metric.section === section);
    const metricById = new Map(inSection.map((metric) => [metric.id, metric]));
    const assignedCustomIds = customDefinitions
      .filter((definition) => definition.status === "published" && definition.section === section && definition.templateIds.includes("gm-daily"))
      .map((definition) => definition.id);
    const assignedIds = [...gmTemplate.sections[section], ...assignedCustomIds.filter((id) => !gmTemplate.sections[section].includes(id))];
    return assignedIds.map((id) => metricById.get(id)).filter((metric): metric is TargetedMetric => Boolean(metric));
  }, [allMetrics, section, customDefinitions, gmTemplate]);
  const unavailableServiceTitanKpis = useMemo(() => scopedPublishedDefinitions
    .filter((definition) => definition.type === "service-titan" && definition.section === section && definition.templateIds.includes("gm-daily"))
    .map((definition) => ({ definition, evaluation: customEvaluations.get(definition.id) }))
    .filter((item): item is { definition: CustomKpiDefinition; evaluation: EvaluatedCustomKpi } => item.evaluation?.state === "unavailable"),
  [scopedPublishedDefinitions, customEvaluations, section]);
  const currentSelectedMetric = selectedMetric ? allMetrics.find((metric) => metric.id === selectedMetric.id) ?? null : null;
  const orderKey = `${locationId}:${section}`;
  const orderedMetrics = useMemo(() => {
    const ids = orders[orderKey] ?? [];
    return [...sectionMetrics].sort((a, b) => {
      const ai = ids.indexOf(a.id); const bi = ids.indexOf(b.id);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1; if (bi === -1) return -1;
      return ai - bi;
    });
  }, [sectionMetrics, orders, orderKey]);
  const visibleMetrics = orderedMetrics.filter((metric) => !hidden.includes(metric.id));
  const hiddenInSection = orderedMetrics.filter((metric) => hidden.includes(metric.id));
  const statuses = visibleMetrics.reduce((acc, metric) => {
    const status = metricStatus(metric);
    acc[status] += 1;
    return acc;
  }, { good: 0, watch: 0, critical: 0, neutral: 0 });

  function persistHidden(next: string[]) {
    if (!writeDashboardLayoutState(localStorage, next, orders)) {
      setDashboardActionError("The layout change could not be saved in this browser. Your previous layout is still active.");
      return;
    }
    setHidden(next);
    setDashboardActionError("");
  }
  function persistOrders(next: Record<string, string[]>) {
    if (!writeDashboardLayoutState(localStorage, hidden, next)) {
      setDashboardActionError("The layout change could not be saved in this browser. Your previous layout is still active.");
      return false;
    }
    setOrders(next);
    setDashboardActionError("");
    return true;
  }
  function moveCard(targetId: string) {
    if (!draggedId || draggedId === targetId) return;
    const ids = visibleMetrics.map((metric) => metric.id);
    const next = reorder(ids, ids.indexOf(draggedId), ids.indexOf(targetId));
    const nextOrders = { ...orders, [orderKey]: next };
    persistOrders(nextOrders);
    setDraggedId(null);
  }
  function resetLayout() {
    const next = { ...orders };
    delete next[orderKey];
    const nextHidden = hidden.filter((id) => !sectionMetrics.some((metric) => metric.id === id));
    if (!writeDashboardLayoutState(localStorage, nextHidden, next)) {
      setDashboardActionError("The layout reset could not be saved in this browser. Your previous layout is still active.");
      return;
    }
    setOrders(next);
    setHidden(nextHidden);
    setDashboardActionError("");
  }
  function exportScorecard() {
    try {
      const csv = createCsv(
        ["KPI", "Actual", "Target", "Attainment", "Vs prior", "Source", "Status"],
        visibleMetrics.map((metric) => {
          const status = metricStatus(metric);
          const attainment = metricAttainment(metric);
          const change = changeFromPrior(metric);
          return [
            metric.title,
            formatMetric(metric.actual, metric.kind),
            metric.goal === undefined ? "" : formatMetric(metric.goal, metric.kind),
            attainment === null ? "" : `${Math.round(attainment)}%`,
            change === null ? "" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`,
            metric.source,
            statusCopy[status],
          ];
        }),
      );
      const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `gm-intelligence-${location.id}-${section}-${period.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setDashboardActionError("");
    } catch {
      setDashboardActionError("The CSV export could not be created in this browser. No file was downloaded.");
    }
  }

  if (!mounted) return <div className="loading-screen"><Activity className="spin" /> Loading intelligence board…</div>;

  const CurrentIcon = sections.find((item) => item.id === section)?.icon ?? LayoutDashboard;
  return (
    <div className="app-shell" style={{ "--brand-accent": location.accent, "--brand-dark": location.accentDark } as React.CSSProperties}>
      <aside className={`side-nav ${mobileNav ? "mobile-open" : ""}`}>
        <div className="portfolio-mark"><div className="cg-mark">CG</div><div><strong>Champions Group</strong><span>GM Intelligence</span></div></div>
        <nav>
          <div className="nav-label">Performance</div>
          {sections.map(({ id, icon: Icon, short }) => (
            <button key={id} className={section === id ? "active" : ""} onClick={() => { setSection(id); setMobileNav(false); }}><Icon size={18} /><span>{short}</span>{section === id && <span className="active-dot" />}</button>
          ))}
          <div className="nav-label admin-label">Management</div>
          <Link href="/admin"><Settings size={18} /><span>Admin Center</span></Link>
        </nav>
        <div className="nav-footer"><ShieldCheck size={17} /><div><strong>Portfolio-ready</strong><span>Tenant-isolated configuration</span></div></div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileNav(!mobileNav)}><Menu size={21} /></button>
          <div className="location-switcher">
            <div className="brand-avatar">{location.initials}</div>
            <div className="location-select-wrap"><span>Viewing location</span><select value={locationId} onChange={(event) => setLocationId(event.target.value)}>{locations.map((item) => <option value={item.id} key={item.id}>{item.brand} · {item.location}</option>)}</select></div>
            <ChevronDown size={15} />
          </div>
          <div className="topbar-right">
            <div className="sync-state"><RefreshCw size={14} /><span>{location.syncLabel}</span></div>
            <Link className="admin-button" href="/admin"><Settings size={16} />Admin</Link>
            <div className="user-avatar">RM</div>
          </div>
        </header>

        <section className="workspace">
          {showDemoBanner && <div className="demo-banner"><span>TEST ENVIRONMENT</span><p>Illustrative data only. Source availability and tenant mapping requirements are labeled in Admin.</p><button type="button" aria-label="Dismiss test environment notice" onClick={() => setShowDemoBanner(false)}><X size={14} /></button></div>}
          {dashboardActionError && <div className="test-result error" role="alert">{dashboardActionError}</div>}
          <div className="page-head">
            <div><div className="eyebrow"><CurrentIcon size={15} /> {location.location} operating view</div><h1>{sectionMeta[section].label}</h1><p>{sectionMeta[section].description}</p></div>
            <div className="page-actions">
              <div className="period-control"><CalendarDays size={16} /><select value={period} onChange={(event) => setPeriod(event.target.value)}>{periods.map((item) => <option key={item}>{item}</option>)}</select><ChevronDown size={14} /></div>
              <button className={editMode ? "button primary" : "button secondary"} onClick={() => setEditMode(!editMode)}><GripVertical size={16} />{editMode ? "Done editing" : "Customize view"}</button>
            </div>
          </div>

          <div className={`signal-strip ${unavailableServiceTitanKpis.length > 0 ? "has-unavailable-sources" : ""}`} aria-live="polite">
            <div className="signal-primary"><Activity size={18} /><div><strong>{statuses.critical > 0 ? `${statuses.critical} KPIs need GM attention` : unavailableServiceTitanKpis.length > 0 ? `${unavailableServiceTitanKpis.length} KPI source${unavailableServiceTitanKpis.length === 1 ? " is" : "s are"} unavailable` : "All visible KPIs are controlled"}</strong><span>{statuses.watch} watch item{statuses.watch === 1 ? "" : "s"} · {statuses.good} on target{unavailableServiceTitanKpis.length > 0 ? ` · ${unavailableServiceTitanKpis.length} unavailable (excluded from status)` : ""} · {period}</span></div></div>
            <div className="signal-legend"><span className="legend critical" />Off track <span className="legend watch" />Watch <span className="legend good" />On target</div>
          </div>

          {editMode && (
            <div className="layout-toolbar">
              <div><GripVertical size={18} /><span><strong>Layout edit mode</strong> — drag cards to reorder. Changes save automatically to this browser.</span></div>
              <div>{hiddenInSection.length > 0 && <button onClick={() => persistHidden(hidden.filter((id) => !hiddenInSection.some((metric) => metric.id === id)))}><Plus size={15} /> Restore {hiddenInSection.length} hidden</button>}<button onClick={resetLayout}>Reset tab</button></div>
            </div>
          )}

          <div className="metric-grid">
            {visibleMetrics.map((metric) => (
              <MetricCard key={metric.id} metric={metric} editable={editMode} onOpen={() => setSelectedMetric(metric)} onHide={() => persistHidden([...hidden, metric.id])} onDragStart={() => setDraggedId(metric.id)} onDrop={() => moveCard(metric.id)} />
            ))}
            {unavailableServiceTitanKpis.map(({ definition, evaluation }) => (
              <UnavailableServiceTitanCard
                key={`unavailable-${definition.id}`}
                definition={definition}
                evaluation={evaluation}
                tenantId={location.tenantId}
                locationLabel={`${location.brand} · ${location.location}`}
              />
            ))}
          </div>
          {visibleMetrics.length === 0 && unavailableServiceTitanKpis.length === 0 && <div className="empty-state"><BarChart3 size={28} /><h3>No visible cards</h3><p>Restore hidden cards or add KPIs from the Admin Center.</p><button className="button secondary" onClick={resetLayout}>Restore default layout</button></div>}

          <section className="detail-panel">
            <div className="panel-head"><div><span className="eyebrow">Manager detail</span><h2>{sectionMeta[section].label} scorecard</h2></div><button className="text-button" type="button" disabled={visibleMetrics.length === 0} onClick={exportScorecard}>Export CSV</button></div>
            <div className="table-scroll"><table className="score-table"><thead><tr><th>KPI</th><th>Actual</th><th>Target</th><th>Attainment</th><th>Vs prior</th><th>Source</th><th>Status</th></tr></thead><tbody>{visibleMetrics.map((metric) => { const status=metricStatus(metric); const att=metricAttainment(metric); const ch=changeFromPrior(metric); const favorable=ch!==null&&(metric.direction==="lower"?ch<=0:ch>=0); return <tr key={metric.id} onClick={() => setSelectedMetric(metric)}><td><strong>{metric.title}</strong><span>{metric.subtitle}</span></td><td>{formatMetric(metric.actual,metric.kind)}</td><td>{metric.goal===undefined?"—":<>{formatMetric(metric.goal,metric.kind)}{metric.targetContext&&<span className="table-target-source">{targetSourceLabel(metric.targetContext)}</span>}</>}</td><td>{att===null?"—":`${Math.round(att)}%`}</td><td className={favorable?"positive":"negative"}>{ch===null?"—":`${ch>=0?"+":""}${ch.toFixed(1)}%`}</td><td><span className="table-source"><span className="source-dot" />{metric.source}</span></td><td><span className={`status-pill ${status}`}>{statusCopy[status]}</span></td></tr>; })}</tbody></table></div>
          </section>
          <footer className="page-footer"><span>GM Intelligence Board · Test Build</span><span>Definitions are tenant-configurable. Data confidence is shown by source.</span></footer>
        </section>
      </main>
      <InsightDrawer metric={currentSelectedMetric} lineage={currentSelectedMetric ? serviceTitanLineage.get(currentSelectedMetric.id) : undefined} onClose={() => setSelectedMetric(null)} />
    </div>
  );
}
