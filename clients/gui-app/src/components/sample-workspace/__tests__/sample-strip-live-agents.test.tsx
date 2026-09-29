import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { publishLiveAgentsSlot } from "@/components/layout/tabs/side-strip/live-agents-slot-store";
import { SampleStripLiveAgents } from "@/components/sample-workspace/sample-strip-live-agents";
import { SAMPLE_LIVE_AGENTS } from "@/components/sample-workspace/sample-workspace-scene";

/**
 * `SampleStripLiveAgents` (D9): the sample task's own Side tab view picture,
 * portalled into the strip's published slot exactly as an epic surface's real
 * agents are. `SampleLiveAgentItems`'s row content (glyph, title, chip) is
 * `LiveAgentRowView`'s own contract, covered where that component lives; this
 * suite is the portal's own wiring - it draws nothing with no slot, and the
 * three sample agents once one is published.
 */

afterEach(cleanup);

function publishSlot(tabId: string): HTMLElement {
  const slot = document.createElement("div");
  document.body.append(slot);
  act(() => {
    publishLiveAgentsSlot(tabId, slot);
  });
  return slot;
}

describe("<SampleStripLiveAgents />", () => {
  it("draws nothing while the strip has published no slot for this tab", () => {
    render(<SampleStripLiveAgents tabId="unpublished-tab" />);

    expect(screen.queryByTestId("sample-strip-live-agents")).toBeNull();
  });

  it("portals the three sample agents into the published slot, by kind, in order", () => {
    const slot = publishSlot("tab-a");

    render(<SampleStripLiveAgents tabId="tab-a" />);

    const list = screen.getByTestId("sample-strip-live-agents");
    expect(slot.contains(list)).toBe(true);
    const rows = within(list).getAllByRole("button");
    expect(rows.map((row) => row.getAttribute("data-live-kind"))).toEqual([
      "interview",
      "running",
      "failure",
    ]);
    expect(SAMPLE_LIVE_AGENTS.map((agent) => agent.kind)).toEqual([
      "interview",
      "running",
      "failure",
    ]);
  });

  it("gives the first row (waiting on a reply) the Reply chip, and no other row one", () => {
    publishSlot("tab-b");

    render(<SampleStripLiveAgents tabId="tab-b" />);

    const rows = within(
      screen.getByTestId("sample-strip-live-agents"),
    ).getAllByRole("button");
    expect(
      within(rows[0]).getByTestId("strip-live-agent-waiting-chip").textContent,
    ).toBe("Reply");
    for (const row of rows.slice(1)) {
      expect(
        within(row).queryByTestId("strip-live-agent-waiting-chip"),
      ).toBeNull();
    }
  });
});
