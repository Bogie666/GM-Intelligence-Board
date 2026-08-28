import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ExecutiveSourceInsightActions } from "./executive-source-insight-actions";
import type { ExecutiveScorecardCard as ExecutiveScorecardCardViewModel } from "@/lib/production-dashboard";
import type { ProductionKpiStatus } from "@/lib/tenant-context";

function source(overrides: Partial<ProductionKpiStatus> = {}): ProductionKpiStatus {
  return {
    bindingId: "revenue-binding",
    definitionId: "revenue-definition",
    kpiKey: "revenue-mtd",
    title: "Completed revenue MTD",
    section: "executive",
    valueKind: "currency",
    percentValueScale: "whole",
    subtitle: "Completed revenue.",
    sourceSystem: "ServiceTitan",
    locationId: "location-1",
    locationName: "Dallas",
    sourceStatus: "Approved governed source",
    value: 1000,
    priorValue: null,
    periodEnd: "2026-08-18T23:59:59.000Z",
    observedAt: "2026-08-19T01:00:00.000Z",
    confidence: "high",
    health: "current",
    ...overrides,
  };
}

function outlookCard(pipelineStatus: "Current" | "Stale" | "Unavailable"): ExecutiveScorecardCardViewModel {
  const pipeline = pipelineStatus === "Unavailable" ? null : source({
    bindingId: "pipeline-binding",
    definitionId: "pipeline-definition",
    kpiKey: "pipeline",
    title: "Sold + scheduled pipeline",
    value: 600,
    health: pipelineStatus === "Current" ? "current" : "stale",
    endpointRecipeId: "sold-estimates-value",
    endpointRecipeVersion: 2,
  });
  return {
    id: "run-rate-forecast",
    title: "Month-End Revenue Outlook vs Budget",
    subtitle: "Pace forecast and committed revenue are shown separately.",
    value: 1738,
    valueKind: "currency",
    percentValueScale: "whole",
    comparisonValue: 2000,
    comparisonLabel: "monthly budget",
    performanceStatus: "Off Plan",
    dataStatus: "Current",
    dataMessage: "Approved completed revenue source.",
    periodLabel: "Aug 18, 2026",
    asOf: "2026-08-19T01:00:00.000Z",
    budgetLineage: "budget-1",
    facts: [
      { label: "Committed revenue", value: pipelineStatus === "Current" ? "$1,600" : "Unavailable" },
    ],
    membershipMovement: null,
    source: source(),
    secondarySourceInsights: [{
      label: "sold + scheduled pipeline",
      dataStatus: pipelineStatus,
      message: pipelineStatus === "Unavailable" ? "The required governed source sold-estimates-value v2 is unavailable." : "Approved governed source",
      source: pipeline,
    }],
  };
}

interface ButtonProps {
  children?: ReactNode;
  "aria-label"?: string;
  disabled?: boolean;
  onClick: () => void;
}

function elementsOfType(node: ReactNode, type: string): ReactElement<ButtonProps>[] {
  if (Array.isArray(node)) return node.flatMap((child) => elementsOfType(child, type));
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [
    ...(element.type === type ? [element as unknown as ReactElement<ButtonProps>] : []),
    ...elementsOfType(element.props.children, type),
  ];
}

describe("ExecutiveScorecardCard composite source lineage", () => {
  it("opens completed-revenue and exact-v2 pipeline insights independently when both are current", () => {
    const onOpen = vi.fn();
    const card = outlookCard("Current");
    const view = ExecutiveSourceInsightActions({
      primarySource: card.source,
      primaryLabel: "completed revenue",
      secondarySourceInsights: card.secondarySourceInsights ?? [],
      onOpen,
    });
    const buttons = elementsOfType(view, "button");

    expect(buttons).toHaveLength(2);
    expect(buttons.map((button) => button.props["aria-label"])).toEqual([
      "Open completed revenue insight",
      "Open sold + scheduled pipeline insight · Current",
    ]);
    expect(buttons[1].props.disabled).toBe(false);

    buttons[0].props.onClick();
    buttons[1].props.onClick();
    expect(onOpen.mock.calls.map(([opened]) => [opened.kpiKey, opened.endpointRecipeVersion ?? null])).toEqual([
      ["revenue-mtd", null],
      ["pipeline", 2],
    ]);
  });

  it("keeps stale pipeline lineage inspectable while withholding committed arithmetic", () => {
    const onOpen = vi.fn();
    const card = outlookCard("Stale");
    const view = ExecutiveSourceInsightActions({
      primarySource: card.source,
      primaryLabel: "completed revenue",
      secondarySourceInsights: card.secondarySourceInsights ?? [],
      onOpen,
    });
    const buttons = elementsOfType(view, "button");

    expect(buttons[1].props["aria-label"]).toBe("Open sold + scheduled pipeline insight · Stale");
    expect(buttons[1].props.disabled).toBe(false);
    buttons[1].props.onClick();
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({
      kpiKey: "pipeline",
      endpointRecipeId: "sold-estimates-value",
      endpointRecipeVersion: 2,
    }));
    expect(card.facts).toContainEqual({ label: "Committed revenue", value: "Unavailable" });
  });

  it("shows unavailable pipeline lineage without fabricating an inspectable source", () => {
    const onOpen = vi.fn();
    const card = outlookCard("Unavailable");
    const view = ExecutiveSourceInsightActions({
      primarySource: card.source,
      primaryLabel: "completed revenue",
      secondarySourceInsights: card.secondarySourceInsights ?? [],
      onOpen,
    });
    const buttons = elementsOfType(view, "button");

    expect(buttons[1].props["aria-label"]).toBe("Cannot open sold + scheduled pipeline insight · Unavailable");
    expect(buttons[1].props.disabled).toBe(true);
    buttons[1].props.onClick();
    expect(onOpen).not.toHaveBeenCalled();
    expect(card.facts).toContainEqual({ label: "Committed revenue", value: "Unavailable" });
  });
});
