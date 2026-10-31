/**
 * The build without bots (`unreleased-features.ts`): the expanded strip's
 * column holds what it held before voice, so New task keeps its place below
 * Home. With the features on and voice offered, Talk's slot follows the fixed
 * rows and holds Talk. The rows around the slot are stand-ins; the column, the
 * real `TalkControl` and the real voice store are what is read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useVoiceSessionStore,
  type VoiceSessionDriver,
} from "@/stores/voice/voice-session-store";
import { SideStripTopBlock } from "../side-strip-top-block";

const flags = vi.hoisted(() => ({ enabled: false }));

vi.mock("@/unreleased-features", () => ({
  get UNRELEASED_FEATURES_ENABLED() {
    return flags.enabled;
  },
}));

vi.mock("@/components/layout/header/history-nav-buttons", () => ({
  HistoryNavButtons: () => null,
}));

vi.mock("@/components/layout/tabs/side-strip/side-strip-nav-rows", () => ({
  SideStripNavRows: () => <div data-testid="nav-rows" />,
  SideStripNewTask: () => <div data-testid="new-task" />,
  SideStripTasksLabel: () => <div data-testid="tasks-label" />,
}));

vi.mock("@/components/layout/tabs/side-strip/side-home-row", () => ({
  SideHomeRow: () => <div data-testid="home-row" />,
}));

vi.mock("@/components/layout/tabs/side-strip/strip-agents-mode", () => ({
  useLiveAgentsInStrip: () => false,
  useSectionedStrip: () => false,
}));

afterEach(() => {
  cleanup();
  flags.enabled = false;
  useVoiceSessionStore.setState(useVoiceSessionStore.getInitialState(), true);
});

/** The expanded column under the title row, Home drawn and no Tracy entry. */
function renderExpandedColumn(): HTMLElement {
  render(
    <TooltipProvider>
      <SideStripTopBlock
        edge="left"
        variant="expanded"
        ownsTitleBar
        dragClass={undefined}
        homeTabDrawn
        homeIsActive={false}
        onHomeTab={() => undefined}
        tracy={null}
        onNewTab={() => undefined}
        onToggleCollapsed={() => undefined}
        taskCount={0}
      />
    </TooltipProvider>,
  );
  const block = screen.getByTestId("side-strip-top-block");
  const column = block.children.item(1);
  if (!(column instanceof HTMLElement)) throw new Error("no column");
  return column;
}

describe("the side strip's expanded column", () => {
  it("holds the baseline's rows with the features off, and no Talk slot", () => {
    const column = renderExpandedColumn();
    expect(
      Array.from(column.children, (child) => child.getAttribute("data-testid")),
    ).toEqual(["nav-rows", "home-row", "new-task", "tasks-label"]);
  });

  it("puts Talk's slot, holding Talk, after the fixed rows with the features on", () => {
    flags.enabled = true;
    useVoiceSessionStore.setState({
      availability: "live",
      driver: {
        start: vi.fn<VoiceSessionDriver["start"]>(),
        end: vi.fn<VoiceSessionDriver["end"]>(),
        setMuted: vi.fn<VoiceSessionDriver["setMuted"]>(),
      },
    });
    const column = renderExpandedColumn();
    const children = Array.from(column.children);
    expect(children.map((child) => child.getAttribute("data-testid"))).toEqual([
      "nav-rows",
      "home-row",
      null,
      "new-task",
      "tasks-label",
    ]);
    const slot = children[2];
    if (!(slot instanceof HTMLElement)) throw new Error("no slot");
    expect(slot.className).toBe("flex");
    within(slot).getByRole("button", { name: "Talk" });
  });
});
