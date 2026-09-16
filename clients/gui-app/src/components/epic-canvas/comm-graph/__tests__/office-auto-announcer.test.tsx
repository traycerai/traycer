import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OfficeAutoAnnouncer } from "@/components/epic-canvas/comm-graph/office/office-auto-announcer";
import {
  officeZoomLabel,
  type OfficeAutoDecision,
} from "@/lib/comm-graph/office/office-auto";
import { OFFICE_VIEWS } from "@/lib/comm-graph/office/views/office-view";

afterEach(() => {
  cleanup();
});

/**
 * `OfficeAutoAnnouncer` is React, not canvas, and is tested here directly
 * rather than through the tile: it is `sr-only` and exists purely so
 * assistive tech hears Auto's outcome, which is exactly the kind of thing
 * that can go wrong silently. See `office-overlays.test.tsx` for the same
 * reasoning on the office's other small standalone pieces of chrome.
 */
describe("OfficeAutoAnnouncer", () => {
  it("is a screen-reader-only polite status region", () => {
    render(<OfficeAutoAnnouncer decision={null} restoredView={null} />);

    const region = screen.getByTestId("comm-graph-office-auto-announcer");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    // `sr-only`, not `hidden`: a live region has to stay in the
    // accessibility tree and non-inert for a text change inside it to be
    // announced at all.
    expect(region.className).toContain("sr-only");
    expect(region.hasAttribute("hidden")).toBe(false);
  });

  it("says Auto is still measuring when neither a decision nor a restored view is known", () => {
    render(<OfficeAutoAnnouncer decision={null} restoredView={null} />);

    expect(
      screen.getByTestId("comm-graph-office-auto-announcer").textContent,
    ).toBe("Auto · measuring…");
  });

  it('says the restored sentence when only a restored view is known - a decision that was made and will not be re-made, not "measuring"', () => {
    render(<OfficeAutoAnnouncer decision={null} restoredView="towers" />);

    expect(
      screen.getByTestId("comm-graph-office-auto-announcer").textContent,
    ).toBe(`Auto · ${OFFICE_VIEWS.towers.label} · measured earlier`);
  });

  it("says the full measured sentence, runner-up included, once a decision is in hand", () => {
    const decision: OfficeAutoDecision = {
      view: "floor",
      agents: 42,
      fits: [
        { view: "floor", zoom: 0.62 },
        { view: "towers", zoom: 0.43 },
      ],
    };
    render(<OfficeAutoAnnouncer decision={decision} restoredView={null} />);

    expect(
      screen.getByTestId("comm-graph-office-auto-announcer").textContent,
    ).toBe(
      `Auto · ${OFFICE_VIEWS.floor.label} · measured at 42 agents · ${OFFICE_VIEWS.towers.label} would be ${officeZoomLabel(0.43)}`,
    );
  });

  it("counts a single agent in the singular, and drops the runner-up clause when the chosen view was the only candidate", () => {
    const decision: OfficeAutoDecision = {
      view: "floor",
      agents: 1,
      fits: [{ view: "floor", zoom: 1 }],
    };
    render(<OfficeAutoAnnouncer decision={decision} restoredView={null} />);

    expect(
      screen.getByTestId("comm-graph-office-auto-announcer").textContent,
    ).toBe(`Auto · ${OFFICE_VIEWS.floor.label} · measured at 1 agent`);
  });

  it("prefers a decision in hand over a restored view - the decision is the fresher fact", () => {
    const decision: OfficeAutoDecision = {
      view: "building",
      agents: 5,
      fits: [{ view: "building", zoom: 0.8 }],
    };
    render(<OfficeAutoAnnouncer decision={decision} restoredView="towers" />);

    const text = screen.getByTestId(
      "comm-graph-office-auto-announcer",
    ).textContent;
    expect(text).toContain(OFFICE_VIEWS.building.label);
    expect(text).not.toContain("measured earlier");
  });
});
