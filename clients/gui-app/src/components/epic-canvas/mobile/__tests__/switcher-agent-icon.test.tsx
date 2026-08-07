import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwitcherAgentIcon } from "@/components/epic-canvas/mobile/switcher-agent-icon";

// Drive the three epic-selector reads the icon depends on. `tui` non-null +
// type "terminal-agent" reaches the TUI badge branch.
const state = vi.hoisted(
  (): { active: boolean; gui: string | null; tui: string | null } => ({
    active: false,
    gui: null,
    tui: null,
  }),
);
vi.mock("@/lib/epic-selectors", () => ({
  useEpicActiveAgentIds: () =>
    state.active ? new Set<string>(["n1"]) : new Set<string>(),
  useEpicChatHarnessId: () => state.gui,
  useMaybeEpicTuiAgentHarnessId: () => state.tui,
}));

afterEach(() => {
  cleanup();
  state.active = false;
  state.gui = null;
  state.tui = null;
});

describe("<SwitcherAgentIcon />", () => {
  it("marks a TUI agent with a high-contrast terminal badge chip (solid disc + ring cutout)", () => {
    state.tui = "claude";
    render(<SwitcherAgentIcon nodeId="n1" type="terminal-agent" />);
    const badge = screen.getByTestId("switcher-tui-badge-n1");
    // A solid accent disc ring-cut against the sheet surface - not the bare
    // muted glyph that vanished at phone size (the live-review defect).
    expect(badge.className).toContain("rounded-full");
    expect(badge.className).toContain("bg-primary");
    expect(badge.className).toContain("ring-popover");
    // Still carries a terminal glyph, now legibly sized inside the disc.
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("shows no TUI badge for a plain GUI chat", () => {
    state.gui = "claude";
    render(<SwitcherAgentIcon nodeId="n1" type="chat" />);
    expect(screen.queryByTestId("switcher-tui-badge-n1")).toBeNull();
  });
});
