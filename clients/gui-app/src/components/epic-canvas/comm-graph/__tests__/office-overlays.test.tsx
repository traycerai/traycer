import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OfficeHoverSupplement } from "@/components/epic-canvas/comm-graph/office/office-hover-supplement";
import { OfficeLegend } from "@/components/epic-canvas/comm-graph/office/office-legend";

afterEach(() => {
  cleanup();
});

/**
 * Both overlays are React, not canvas, and are tested here rather than through
 * the office canvas for one reason: jsdom has no 2d context, so the floor never
 * produces a frame and therefore never produces a hit region to hover. What
 * they SAY is the part that can go wrong silently, and it is asserted directly.
 */
/**
 * The office no longer draws its own agent card: the hover is
 * `AgentHoverTooltip`, the same component the sidebar and the graph use. What
 * is left here is the FLOOR's own addition under it - the posture it drew and
 * the size class it drew the desk at. Harness and model are deliberately
 * absent: the shared card resolves those from the host, and a second-hand copy
 * beside it is how the two would come to disagree.
 */
describe("OfficeHoverSupplement", () => {
  it("names the posture and the model size the desk was drawn at", () => {
    render(<OfficeHoverSupplement status="working" modelTier="large" />);

    expect(
      screen.getByTestId("comm-graph-office-hover-supplement").textContent,
    ).toBe("Working · large model");
  });

  it("gives every status a word rather than leaking the internal name", () => {
    for (const [status, word] of [
      ["failure", "Crashed"],
      ["attention", "Needs attention"],
      ["awaiting", "Waiting for reply"],
      ["background", "In background"],
      ["idle", "Idle"],
      ["archived", "Archived"],
    ] as const) {
      cleanup();
      render(<OfficeHoverSupplement status={status} modelTier="medium" />);
      expect(
        screen.getByTestId("comm-graph-office-hover-supplement").textContent,
      ).toContain(word);
    }
  });

  it("does not repeat the harness or the model the shared card resolves", () => {
    render(<OfficeHoverSupplement status="idle" modelTier="small" />);

    const text = screen.getByTestId(
      "comm-graph-office-hover-supplement",
    ).textContent;
    // The office reads a chat's model from the epic doc, which the host's own
    // run settings supersede; printing it here would put a stale value beside
    // the authoritative one.
    expect(text).not.toContain("claude");
    expect(text).not.toContain("opus");
  });
});

describe("OfficeLegend", () => {
  it("starts collapsed, so the key never covers the floor unasked", () => {
    render(<OfficeLegend />);

    expect(screen.queryByTestId("comm-graph-office-legend-card")).toBeNull();
    expect(
      screen
        .getByTestId("comm-graph-office-legend-toggle")
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("opens on demand and explains the postures and the envelopes", () => {
    render(<OfficeLegend />);

    fireEvent.click(screen.getByTestId("comm-graph-office-legend-toggle"));

    const card = screen.getByTestId("comm-graph-office-legend-card");
    // Grouped by where you look, and complete: a key that documents only the
    // newest additions leaves the reader unable to tell which of the things in
    // front of them it covers.
    for (const section of ["People", "Desks", "Room"]) {
      expect(card.textContent).toContain(section);
    }
    // Idle wandering is the floor's most eye-catching motion and the easiest
    // to misread as work, so the key names every place a character goes.
    expect(card.textContent).toContain(
      "Cafeteria, cooler, window, sofa, paper toss, watering plants, peeking, strolling",
    );
    for (const meaning of [
      "waiting for a reply",
      "needs you",
      "queued for you",
      "archived",
      "a turn failed",
      "model size",
      "harness",
      "unanswered requests",
      "one per root agent",
      "a sub-team inside its lead's cabin; outline style and floor tint change per level",
      "one per host",
      "the time being shown",
      "break room; agents chat at the cooler and tables",
      "ping-pong and arcade for idle agents",
      "Envelope: reply",
      "Envelope: notice",
    ]) {
      expect(card.textContent).toContain(meaning);
    }
  });

  it("closes again on a second press", () => {
    render(<OfficeLegend />);
    const toggle = screen.getByTestId("comm-graph-office-legend-toggle");

    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(screen.queryByTestId("comm-graph-office-legend-card")).toBeNull();
  });
});
