import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type {
  CommandContext,
  CommandItem,
  CommandSubpage,
} from "@/lib/commands/types";

const spies = vi.hoisted(() => ({
  openTileIntoTargetGroup:
    vi.fn<
      (args: {
        readonly tabId: string | null;
        readonly groupId: string | null;
      }) => void
    >(),
}));

const INNER_SUBPAGE: CommandSubpage = {
  id: "open:cat",
  title: "Category",
  useItems: (): ReadonlyArray<CommandItem> => [
    {
      id: "open:cat:inner",
      label: "Inner Leaf",
      description: null,
      keywords: ["inner"],
      group: "open",
      scope: "actions",
      shortcut: null,
      actionId: null,
      subpage: null,
      run: () => undefined,
    },
  ],
};

vi.mock("@/lib/commands/registry", () => ({
  getOpenerItems: (ctx: CommandContext): ReadonlyArray<CommandItem> => [
    {
      id: "open:leaf",
      label: "Open Leaf",
      description: null,
      keywords: ["leaf"],
      group: "open",
      scope: "actions",
      shortcut: null,
      actionId: null,
      subpage: null,
      run: () =>
        spies.openTileIntoTargetGroup({
          tabId: ctx.activeTabId,
          groupId: ctx.targetGroupId,
        }),
    },
    {
      id: "open:category:cat",
      label: "Category",
      description: null,
      keywords: ["category"],
      group: "open",
      scope: "actions",
      shortcut: null,
      actionId: null,
      subpage: INNER_SUBPAGE,
      run: () => undefined,
    },
  ],
}));

vi.mock("@/components/command-palette/command-palette-context", () => ({
  useCommandPaletteRouter: () => ({
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  }),
}));

import { PaneOpener } from "@/components/epic-canvas/canvas/pane-opener";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PaneOpener", () => {
  it("renders the opener categories inline in the pane", () => {
    render(
      <PaneOpener
        epicId="epic-1"
        tabId="tab-1"
        groupId="group-1"
        active={false}
      />,
    );
    expect(screen.getByTestId("pane-opener")).not.toBeNull();
    expect(screen.getByText("Open Leaf")).not.toBeNull();
    expect(screen.getByText("Category")).not.toBeNull();
  });

  it("focuses the search input when the pane is the active group", () => {
    const { container } = render(
      <PaneOpener epicId="epic-1" tabId="tab-f" groupId="group-f" active />,
    );
    const input = container.querySelector('input[data-slot="command-input"]');
    expect(document.activeElement).toBe(input);
  });

  it("does not steal focus when the pane is not the active group", () => {
    const { container } = render(
      <PaneOpener
        epicId="epic-1"
        tabId="tab-n"
        groupId="group-n"
        active={false}
      />,
    );
    const input = container.querySelector('input[data-slot="command-input"]');
    expect(document.activeElement).not.toBe(input);
  });

  it("selecting a leaf opens into THIS pane's group", () => {
    render(
      <PaneOpener
        epicId="epic-1"
        tabId="tab-9"
        groupId="group-9"
        active={false}
      />,
    );
    fireEvent.click(screen.getByText("Open Leaf"));
    expect(spies.openTileIntoTargetGroup).toHaveBeenCalledWith({
      tabId: "tab-9",
      groupId: "group-9",
    });
  });

  it("back button returns from a sub-page to the opener root", () => {
    render(
      <PaneOpener
        epicId="epic-1"
        tabId="tab-back"
        groupId="group-back"
        active={false}
      />,
    );

    // No back affordance at the root.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

    // Drill into the category sub-page.
    fireEvent.click(screen.getByText("Category"));
    expect(screen.getByText("Inner Leaf")).not.toBeNull();

    // Back button is now visible; clicking it returns to the root list.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByText("Inner Leaf")).toBeNull();
    expect(screen.getByText("Open Leaf")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("two empty panes keep independent sub-page state", () => {
    render(
      <>
        <PaneOpener
          epicId="epic-1"
          tabId="tab-a"
          groupId="group-a"
          active={false}
        />
        <PaneOpener
          epicId="epic-1"
          tabId="tab-b"
          groupId="group-b"
          active={false}
        />
      </>,
    );
    const panes = screen.getAllByTestId("pane-opener");
    const paneA = panes[0];
    const paneB = panes[1];

    // Drill into the category in pane A only.
    fireEvent.click(within(paneA).getByText("Category"));

    // Pane A shows the sub-page; pane B is untouched at its root.
    expect(within(paneA).getByText("Inner Leaf")).not.toBeNull();
    expect(within(paneB).queryByText("Inner Leaf")).toBeNull();
    expect(within(paneB).getByText("Category")).not.toBeNull();
  });
});
