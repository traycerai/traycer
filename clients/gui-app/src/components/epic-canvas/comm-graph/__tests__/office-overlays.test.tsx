import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OfficeHoverCard } from "@/components/epic-canvas/comm-graph/office/office-hover-card";
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
describe("OfficeHoverCard", () => {
  it("names the agent, its harness and model, and what it is doing", () => {
    render(
      <OfficeHoverCard
        name="Reviewer"
        harnessId="claude"
        model="opus"
        modelTier="large"
        status="working"
        left={100}
        top={40}
      />,
    );

    expect(screen.getByText("Reviewer")).toBeDefined();
    expect(screen.getByText("claude · opus · large")).toBeDefined();
    expect(screen.getByText("Working")).toBeDefined();
  });

  it("omits the detail line for a chat that has no run settings yet", () => {
    render(
      <OfficeHoverCard
        name="Orchestrator"
        harnessId={null}
        model={null}
        modelTier="medium"
        status="idle"
        left={0}
        top={0}
      />,
    );

    // A line reading only a separator would be worse than no line at all.
    expect(screen.queryByText("·")).toBeNull();
    expect(screen.getByText("Idle")).toBeDefined();
  });

  it("still names the harness when the record carries no model", () => {
    render(
      <OfficeHoverCard
        name="Runner"
        harnessId="codex"
        model={null}
        modelTier="medium"
        status="awaiting"
        left={0}
        top={0}
      />,
    );

    expect(screen.getByText("codex")).toBeDefined();
    expect(screen.getByText("Waiting for reply")).toBeDefined();
  });

  it("gives every status a word rather than leaking the internal name", () => {
    render(
      <OfficeHoverCard
        name="Ghost"
        harnessId={null}
        model={null}
        modelTier="medium"
        status="archived"
        left={0}
        top={0}
      />,
    );

    expect(screen.getByText("Archived")).toBeDefined();
  });

  it("cannot take the pointer it is following", () => {
    render(
      <OfficeHoverCard
        name="Reviewer"
        harnessId={null}
        model={null}
        modelTier="medium"
        status="idle"
        left={0}
        top={0}
      />,
    );

    // Becoming the pointer's target would make hovering a character flicker
    // between the character and the card describing it.
    expect(
      screen
        .getByTestId("comm-graph-office-hover-card")
        .className.includes("pointer-events-none"),
    ).toBe(true);
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
      "Cafeteria, water cooler, window and corridor trips, desk stretches",
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
      "one per host",
      "the time being shown",
      "break room; agents chat at the cooler and tables",
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
