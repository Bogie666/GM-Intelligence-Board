import type { ExecutiveScorecardSourceInsight } from "../lib/production-dashboard";
import type { ProductionKpiStatus } from "../lib/tenant-context";

export function ExecutiveSourceInsightActions({
  primarySource,
  primaryLabel,
  secondarySourceInsights,
  onOpen,
}: {
  primarySource: ProductionKpiStatus;
  primaryLabel: string | null;
  secondarySourceInsights: ReadonlyArray<ExecutiveScorecardSourceInsight>;
  onOpen: (source: ProductionKpiStatus) => void;
}) {
  return (
    <div className="executive-source-insight-actions" style={{ marginTop: "auto" }}>
      <button
        className="executive-card-action"
        type="button"
        onClick={() => onOpen(primarySource)}
        aria-label={`Open ${primaryLabel ?? primarySource.title} insight`}
      >
        View {primaryLabel ? `${primaryLabel} insight` : "insight"} <span aria-hidden="true">→</span>
      </button>
      {secondarySourceInsights.map((insight) => {
        const inspectableSource = insight.source;
        const canOpen = inspectableSource !== null;
        return (
          <button
            className="executive-card-action"
            type="button"
            key={insight.label}
            disabled={!canOpen}
            title={insight.message}
            onClick={() => { if (inspectableSource) onOpen(inspectableSource); }}
            aria-label={`${canOpen ? "Open" : "Cannot open"} ${insight.label} insight · ${insight.dataStatus}`}
          >
            {canOpen ? `View ${insight.label} insight` : `${insight.label} insight`} · {insight.dataStatus} {canOpen ? <span aria-hidden="true">→</span> : null}
          </button>
        );
      })}
    </div>
  );
}
