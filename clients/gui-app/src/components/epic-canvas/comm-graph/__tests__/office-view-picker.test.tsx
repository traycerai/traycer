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
import type { OfficeAutoDecision } from "@/lib/comm-graph/office/office-auto";
import type { OfficeViewId } from "@/lib/comm-graph/office/office-types";
import type { OfficeViewChoice } from "@/stores/epics/canvas/types";

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
      "AutoFloor fits at 0.12×, Towers at 0.68×; office detail needs 0.7×. Choose Auto again to re-measure.",
    );
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
});
