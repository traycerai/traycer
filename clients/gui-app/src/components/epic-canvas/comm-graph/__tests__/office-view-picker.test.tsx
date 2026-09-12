/**
 * `OfficeViewPicker` is pure - a `choice`/`autoViewId`/`decision` triple in,
 * a trigger label and a radio group of test-id'd rows out. This suite pins
 * its text contract and that `onChoose` reports exactly what was clicked.
 */
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({
    resolvedTheme: "light" as const,
    themePreset: "default",
  }),
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficeViewPicker } from "@/components/epic-canvas/comm-graph/office/office-view-picker";
import {
  decideOfficeView,
  type OfficeAutoDecision,
} from "@/lib/comm-graph/office/office-auto";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import type {
  OfficeSize,
  OfficeViewId,
} from "@/lib/comm-graph/office/office-types";
import type { OfficePlanInput } from "@/lib/comm-graph/office/views/office-view";
import type { OfficeViewChoice } from "@/stores/epics/canvas/types";

/** The tile's canvas box after chrome, on the recording's own epic. */
const FULL_CANVAS: OfficeSize = { width: 1040, height: 700 };

/**
 * Built the way the scene builds it, matching `office-auto.test.ts`'s own
 * helper of the same purpose - a real `decideOfficeView` result, not a
 * hand-built literal, is what makes the "fits at" case below prove the fix
 * against the actual candidate order rather than an author's assumption of it.
 */
function triageInput(count: number, seed: number): OfficePlanInput {
  const epic = makeTestEpic("triage", count, seed);
  return {
    agents: epic.agents,
    partition: partitionOfficePopulation({
      agents: epic.agents,
      statusById: epic.statusById,
      previous: null,
    }),
    occupancy: new Map<string, string>(),
    needsCapacity: [],
    activityById: new Map<string, number>(),
    viewport: FULL_CANVAS,
    previous: null,
  };
}

function openPicker(): void {
  // Radix opens on pointerdown, not click - a bare click leaves the menu shut
  // and every following query passes vacuously.
  fireEvent.pointerDown(screen.getByTestId("comm-graph-office-view-picker"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

function renderPicker(props: {
  readonly choice: OfficeViewChoice;
  readonly autoViewId: OfficeViewId | null;
  readonly decision: OfficeAutoDecision | null;
  readonly onChoose: (choice: OfficeViewChoice) => void;
}) {
  return render(
    <OfficeViewPicker
      choice={props.choice}
      autoViewId={props.autoViewId}
      decision={props.decision}
      onChoose={props.onChoose}
    />,
  );
}

afterEach(() => cleanup());

describe("OfficeViewPicker", () => {
  it("labels the trigger with Auto's resolved view while choice is auto", () => {
    renderPicker({
      choice: "auto",
      autoViewId: "building",
      decision: null,
      onChoose: vi.fn(),
    });

    expect(
      screen.getByTestId("comm-graph-office-view-picker").textContent,
    ).toBe("Auto · Building");
  });

  it("labels the trigger with the view's own label for a concrete choice", () => {
    renderPicker({
      choice: "towers",
      autoViewId: null,
      decision: null,
      onChoose: vi.fn(),
    });

    expect(
      screen.getByTestId("comm-graph-office-view-picker").textContent,
    ).toBe("Towers");
  });

  it("states Auto's reason in full once it has measured", () => {
    // Neither candidate reaches office detail here (0.12x and 0.68x, both
    // under the 0.7x threshold), so the outcome is the Building FALLBACK -
    // a view in no `fits` entry at all. That is why NEITHER clause below
    // says "fits at": the claim belongs to whichever candidate actually won,
    // and here nothing in `fits` did.
    const decision: OfficeAutoDecision = {
      view: "building",
      fits: [
        { view: "floor", zoom: 0.12 },
        { view: "towers", zoom: 0.68 },
      ],
      agents: 309,
    };
    renderPicker({
      choice: "auto",
      autoViewId: "building",
      decision,
      onChoose: vi.fn(),
    });

    openPicker();

    expect(screen.getByTestId("comm-graph-office-view-auto").textContent).toBe(
      "AutoFloor at 0.12×, Towers at 0.68×; office detail needs 0.7×. Choose Auto again to re-measure.",
    );
  });

  it('attaches "fits at" to the view that actually won, not the first one measured', () => {
    // `decideOfficeView` keeps `fits` in candidate order - Floor, then
    // Towers - and takes the first that reaches office detail, so a
    // decision where TOWERS wins is exactly the case an `index === 0` key
    // gets wrong: the phrase used to land on Floor, the loser, because it
    // measured first. Built through the real function (same fixture as
    // `office-auto.test.ts`'s "picks Towers where it reaches office detail
    // and Floor does not") rather than a hand-built literal, so this proves
    // the fix against the actual candidate order.
    const decision = decideOfficeView(triageInput(40, 1), FULL_CANVAS);
    expect(decision.view).toBe("towers");

    renderPicker({
      choice: "auto",
      autoViewId: decision.view,
      decision,
      onChoose: vi.fn(),
    });

    openPicker();

    const reason = screen.getByTestId(
      "comm-graph-office-view-auto",
    ).textContent;
    expect(reason).toContain("Towers fits at");
    expect(reason).toContain("Floor at");
    expect(reason).not.toContain("Floor fits at");
  });

  it("says it is measuring while the choice is auto and nothing has resolved yet", () => {
    renderPicker({
      choice: "auto",
      autoViewId: null,
      decision: null,
      onChoose: vi.fn(),
    });

    openPicker();

    expect(screen.getByTestId("comm-graph-office-view-auto").textContent).toBe(
      "AutoMeasuring this tile…",
    );
  });

  it("describes Auto generically when the choice is not auto and there is no decision to show", () => {
    renderPicker({
      choice: "floor",
      autoViewId: null,
      decision: null,
      onChoose: vi.fn(),
    });

    openPicker();

    expect(screen.getByTestId("comm-graph-office-view-auto").textContent).toBe(
      "AutoPicks by how much of the office fits this tile.",
    );
  });

  it("reports the chosen id through onChoose", () => {
    const onChoose = vi.fn();
    renderPicker({
      choice: "auto",
      autoViewId: "floor",
      decision: null,
      onChoose,
    });

    openPicker();
    fireEvent.click(screen.getByTestId("comm-graph-office-view-towers"));

    expect(onChoose).toHaveBeenCalledWith("towers");
  });

  it("reports auto through onChoose when the Auto row is chosen", () => {
    const onChoose = vi.fn();
    renderPicker({
      choice: "towers",
      autoViewId: null,
      decision: null,
      onChoose,
    });

    openPicker();
    fireEvent.click(screen.getByTestId("comm-graph-office-view-auto"));

    expect(onChoose).toHaveBeenCalledWith("auto");
  });

  it("reports auto through onChoose when the Auto row is clicked WHILE ALREADY on auto", () => {
    // Auto is a command ("re-measure"), not a value - an epic that has
    // doubled in size since it was last measured is exactly when someone
    // re-picks it. The case above only clicks Auto from a DIFFERENT
    // `choice`, so it cannot catch a regression that suppresses the click
    // Radix's own RadioGroup would ordinarily treat as "no change": this is
    // the click that has to fire `onChoose` even though the group's value
    // does not move.
    const onChoose = vi.fn();
    renderPicker({
      choice: "auto",
      autoViewId: "building",
      decision: null,
      onChoose,
    });

    openPicker();
    fireEvent.click(screen.getByTestId("comm-graph-office-view-auto"));

    expect(onChoose).toHaveBeenCalledWith("auto");
  });
});
