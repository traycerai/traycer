import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  CommandContext,
  CommandItem,
  CommandSubpage,
} from "@/lib/commands/types";

const spies = vi.hoisted(() => ({
  deletedArtifactsAvailable: false,
  openTileIntoTargetGroup:
    vi.fn<
      (args: {
        readonly tabId: string | null;
        readonly groupId: string | null;
      }) => void
    >(),
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "host-1",
}));

vi.mock("@/hooks/epic/use-deleted-artifacts-available", () => ({
  useDeletedArtifactsAvailable: () => spies.deletedArtifactsAvailable,
}));

const DEEPEST_SUBPAGE: CommandSubpage = {
  id: "open:cat:nested",
  title: "Nested",
  useItems: (ctx: CommandContext): ReadonlyArray<CommandItem> => [
    {
      id: "open:cat:nested:create",
      label: "Deep Create Leaf",
      description: null,
      keywords: ["create"],
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
  ],
};

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
    {
      id: "open:cat:badged",
      label: "Badged Leaf",
      description: null,
      keywords: ["badged"],
      group: "open",
      scope: "actions",
      shortcut: null,
      actionId: null,
      subpage: null,
      run: () => undefined,
      hostBadge: "Remote Box",
    },
    {
      id: "open:cat:status",
      label: "Unavailable Leaf",
      description: null,
      keywords: ["unavailable"],
      group: "open",
      scope: "actions",
      shortcut: null,
      actionId: null,
      subpage: null,
      run: () => undefined,
      statusBadge: "Unavailable: Remote Box",
    },
    {
      id: "open:cat:nested",
      label: "Nested",
      description: null,
      keywords: ["nested"],
      group: "open",
      scope: "actions",
      shortcut: null,
      actionId: null,
      subpage: DEEPEST_SUBPAGE,
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
import {
  requestPaneOpenerFocus,
  resetPaneOpenerFocusForTests,
} from "@/lib/canvas/focus-pane-opener";

afterEach(() => {
  cleanup();
  resetPaneOpenerFocusForTests();
  stubCoarsePointer(false);
  vi.useRealTimers();
  vi.clearAllMocks();
  spies.deletedArtifactsAvailable = false;
});

/**
 * The opener's search box. cmdk renders its input as a combobox (same accessor
 * shape the modal palette's tests use), named by the `aria-label` the opener
 * sets.
 */
function searchInput(): HTMLElement {
  return screen.getByRole("combobox", { name: "Open into pane" });
}

/** Keep the global media-query shim deterministic across focus tests. */
function stubCoarsePointer(coarse: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

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

  it("fuzzy-finds deleted artifacts when recovery is available", () => {
    spies.deletedArtifactsAvailable = true;
    render(
      <PaneOpener
        epicId="epic-1"
        tabId="tab-deleted"
        groupId="group-deleted"
        active={false}
      />,
    );

    fireEvent.change(searchInput(), { target: { value: "restore" } });

    expect(
      screen.getByRole("option", { name: "Deleted artifacts" }),
    ).not.toBeNull();
    expect(screen.queryByRole("option", { name: "Open Leaf" })).toBeNull();
  });

  it("hides deleted artifacts when the epic host lacks recovery RPCs", () => {
    render(
      <PaneOpener
        epicId="epic-1"
        tabId="tab-no-deleted"
        groupId="group-no-deleted"
        active={false}
      />,
    );

    fireEvent.change(searchInput(), { target: { value: "restore" } });

    expect(
      screen.queryByRole("option", { name: "Deleted artifacts" }),
    ).toBeNull();
  });

  it("focuses the search input when the pane is the active group", () => {
    const { container } = render(
      <PaneOpener epicId="epic-1" tabId="tab-f" groupId="group-f" active />,
    );
    const input = container.querySelector('input[data-slot="command-input"]');
    expect(document.activeElement).toBe(input);
  });

  // Opening an empty pane on a touch device is a tap on a layout, not a
  // request to type: focusing the opener's search would raise a software
  // keyboard over the very list of things to open. The INPUT decides, not the
  // width - a desktop window snapped narrow still types with hardware.
  it("leaves the search alone on a coarse pointer", () => {
    stubCoarsePointer(true);
    render(
      <PaneOpener epicId="epic-1" tabId="tab-c" groupId="group-c" active />,
    );
    stubCoarsePointer(false);

    expect(document.activeElement).not.toBe(searchInput());
    // The opener is inline chrome, not a Radix layer, so nothing was going to
    // be focused on its behalf and focus is left exactly where it was.
    expect(document.activeElement).toBe(document.body);
  });

  it("explicitly refocuses an already-mounted active picker, including on coarse pointers", () => {
    stubCoarsePointer(true);
    render(
      <>
        <button type="button" data-testid="focus-anchor">
          Focus anchor
        </button>
        <PaneOpener
          epicId="epic-1"
          tabId="tab-mounted"
          groupId="pane-mounted"
          active
        />
      </>,
    );
    const anchor = screen.getByTestId("focus-anchor");
    anchor.focus();

    requestPaneOpenerFocus("tab-mounted", "pane-mounted");

    expect(document.activeElement).toBe(searchInput());
  });

  it("keeps a request pending until an active picker mounts later", async () => {
    stubCoarsePointer(true);
    const rendered = render(
      <button type="button" data-testid="focus-anchor">
        Focus anchor
      </button>,
    );
    const anchor = screen.getByTestId("focus-anchor");
    anchor.focus();
    vi.useFakeTimers();
    requestPaneOpenerFocus("tab-delayed", "pane-delayed");

    // Mount after the old ten-frame retry window would have expired.
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    rendered.rerender(
      <>
        <button type="button" data-testid="focus-anchor">
          Focus anchor
        </button>
        <PaneOpener
          epicId="epic-1"
          tabId="tab-delayed"
          groupId="pane-delayed"
          active
        />
      </>,
    );

    expect(document.activeElement).toBe(searchInput());
  });

  it("does not consume a request for the same pane id in another task", () => {
    stubCoarsePointer(true);
    const rendered = render(
      <>
        <button type="button" data-testid="focus-anchor">
          Focus anchor
        </button>
        <PaneOpener
          epicId="epic-1"
          tabId="tab-a"
          groupId="shared-pane"
          active={false}
        />
        <PaneOpener
          epicId="epic-2"
          tabId="tab-b"
          groupId="shared-pane"
          active={false}
        />
      </>,
    );
    const anchor = screen.getByTestId("focus-anchor");
    anchor.focus();
    requestPaneOpenerFocus("tab-a", "shared-pane");

    rendered.rerender(
      <>
        <button type="button" data-testid="focus-anchor">
          Focus anchor
        </button>
        <PaneOpener
          epicId="epic-1"
          tabId="tab-a"
          groupId="shared-pane"
          active={false}
        />
        <PaneOpener
          epicId="epic-2"
          tabId="tab-b"
          groupId="shared-pane"
          active
        />
      </>,
    );

    // A mounted picker with the same pane id in another task must not consume
    // the request. It also must not run normal autofocus while the request is
    // still targeted at tab-a.
    expect(document.activeElement).toBe(anchor);

    rendered.rerender(
      <>
        <button type="button" data-testid="focus-anchor">
          Focus anchor
        </button>
        <PaneOpener
          epicId="epic-1"
          tabId="tab-a"
          groupId="shared-pane"
          active
        />
        <PaneOpener
          epicId="epic-2"
          tabId="tab-b"
          groupId="shared-pane"
          active={false}
        />
      </>,
    );

    const panes = screen.getAllByTestId("pane-opener");
    expect(within(panes[0]).getByRole("combobox")).toBe(document.activeElement);
    expect(within(panes[1]).getByRole("combobox")).not.toBe(
      document.activeElement,
    );
  });

  it.each([
    ["pointerdown", (element: HTMLElement) => fireEvent.pointerDown(element)],
    [
      "keydown",
      (element: HTMLElement) =>
        fireEvent.keyDown(element, { key: "ArrowRight" }),
    ],
    ["focusin", (element: HTMLElement) => fireEvent.focusIn(element)],
    [
      "window blur",
      (_element: HTMLElement) => window.dispatchEvent(new Event("blur")),
    ],
  ] as const)(
    "cancels a pending request on %s before mount",
    (_name, cancel) => {
      stubCoarsePointer(false);
      const rendered = render(
        <button type="button" data-testid="focus-anchor">
          Focus anchor
        </button>,
      );
      const anchor = screen.getByTestId("focus-anchor");
      anchor.focus();
      requestPaneOpenerFocus("tab-cancel", "pane-cancel");
      cancel(anchor);

      rendered.rerender(
        <>
          <button type="button" data-testid="focus-anchor">
            Focus anchor
          </button>
          <PaneOpener
            epicId="epic-1"
            tabId="tab-cancel"
            groupId="pane-cancel"
            active
          />
        </>,
      );

      expect(document.activeElement).toBe(screen.getByTestId("focus-anchor"));
    },
  );

  it("lets the newer request supersede an older request", () => {
    stubCoarsePointer(true);
    const rendered = render(
      <>
        <button type="button" data-testid="focus-anchor">
          Focus anchor
        </button>
        <PaneOpener
          epicId="epic-1"
          tabId="tab-old"
          groupId="pane-old"
          active={false}
        />
        <PaneOpener
          epicId="epic-1"
          tabId="tab-new"
          groupId="pane-new"
          active={false}
        />
      </>,
    );
    const anchor = screen.getByTestId("focus-anchor");
    anchor.focus();
    requestPaneOpenerFocus("tab-old", "pane-old");
    requestPaneOpenerFocus("tab-new", "pane-new");

    rendered.rerender(
      <>
        <button type="button" data-testid="focus-anchor">
          Focus anchor
        </button>
        <PaneOpener epicId="epic-1" tabId="tab-old" groupId="pane-old" active />
        <PaneOpener
          epicId="epic-1"
          tabId="tab-new"
          groupId="pane-new"
          active={false}
        />
      </>,
    );
    expect(document.activeElement).toBe(anchor);

    rendered.rerender(
      <>
        <button type="button" data-testid="focus-anchor">
          Focus anchor
        </button>
        <PaneOpener
          epicId="epic-1"
          tabId="tab-old"
          groupId="pane-old"
          active={false}
        />
        <PaneOpener epicId="epic-1" tabId="tab-new" groupId="pane-new" active />
      </>,
    );
    expect(document.activeElement).toBe(
      within(screen.getAllByTestId("pane-opener")[1]).getByRole("combobox"),
    );
  });

  it("does not steal focus when a canceled mount replays under StrictMode", () => {
    stubCoarsePointer(false);
    const rendered = render(
      <button type="button" data-testid="focus-anchor">
        Focus anchor
      </button>,
    );
    const anchor = screen.getByTestId("focus-anchor");
    anchor.focus();
    requestPaneOpenerFocus("tab-strict", "pane-strict");
    fireEvent.pointerDown(anchor);

    rendered.rerender(
      <>
        <button type="button" data-testid="focus-anchor">
          Focus anchor
        </button>
        <StrictMode>
          <PaneOpener
            epicId="epic-1"
            tabId="tab-strict"
            groupId="pane-strict"
            active
          />
        </StrictMode>
      </>,
    );

    expect(document.activeElement).toBe(screen.getByTestId("focus-anchor"));
  });

  it("waits to focus an inactive picker until it becomes active", () => {
    stubCoarsePointer(true);
    const rendered = render(
      <>
        <button type="button" data-testid="focus-anchor">
          Focus anchor
        </button>
        <PaneOpener
          epicId="epic-1"
          tabId="tab-inactive"
          groupId="pane-inactive"
          active={false}
        />
      </>,
    );
    const anchor = screen.getByTestId("focus-anchor");
    anchor.focus();
    requestPaneOpenerFocus("tab-inactive", "pane-inactive");

    expect(document.activeElement).toBe(anchor);

    rendered.rerender(
      <>
        <button type="button" data-testid="focus-anchor">
          Focus anchor
        </button>
        <PaneOpener
          epicId="epic-1"
          tabId="tab-inactive"
          groupId="pane-inactive"
          active
        />
      </>,
    );

    expect(document.activeElement).toBe(searchInput());
  });

  it("suppresses normal autofocus when an inactive request is canceled", () => {
    stubCoarsePointer(false);
    const rendered = render(
      <>
        <button type="button" data-testid="focus-anchor">
          Focus anchor
        </button>
        <PaneOpener
          epicId="epic-1"
          tabId="tab-inactive-canceled"
          groupId="pane-inactive-canceled"
          active={false}
        />
      </>,
    );
    const anchor = screen.getByTestId("focus-anchor");
    anchor.focus();
    requestPaneOpenerFocus("tab-inactive-canceled", "pane-inactive-canceled");
    fireEvent.focusIn(anchor);

    rendered.rerender(
      <>
        <button type="button" data-testid="focus-anchor">
          Focus anchor
        </button>
        <PaneOpener
          epicId="epic-1"
          tabId="tab-inactive-canceled"
          groupId="pane-inactive-canceled"
          active
        />
      </>,
    );

    expect(document.activeElement).toBe(screen.getByTestId("focus-anchor"));
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

  it("wraps arrow-key selection around both ends of the root list", async () => {
    render(
      <PaneOpener
        epicId="epic-1"
        tabId="tab-loop"
        groupId="group-loop"
        active
      />,
    );
    const rows = screen.getAllByRole("option");
    const first = rows[0];
    const last = rows[rows.length - 1];

    await waitFor(() => {
      expect(first.getAttribute("data-selected")).toBe("true");
    });

    fireEvent.keyDown(searchInput(), { key: "ArrowUp" });
    await waitFor(() => {
      expect(last.getAttribute("data-selected")).toBe("true");
    });

    fireEvent.keyDown(searchInput(), { key: "ArrowDown" });
    await waitFor(() => {
      expect(first.getAttribute("data-selected")).toBe("true");
    });
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

  it("root query surfaces leaves n levels deep with their full path", () => {
    render(
      <PaneOpener
        epicId="epic-1"
        tabId="tab-deep"
        groupId="group-deep"
        active={false}
      />,
    );
    // Deep rows are absent while the query is empty.
    expect(
      screen.queryByRole("option", { name: /Deep Create Leaf/ }),
    ).toBeNull();

    fireEvent.change(searchInput(), { target: { value: "create" } });

    // The level-3 leaf matches from the root; its accessible name carries the
    // full path, so the hierarchy is what the user actually reads.
    expect(
      screen.getByRole("option", {
        name: "Category → Nested → Deep Create Leaf",
      }),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("option", { name: /Deep Create Leaf/ }));
    expect(spies.openTileIntoTargetGroup).toHaveBeenCalledWith({
      tabId: "tab-deep",
      groupId: "group-deep",
    });
  });

  it("includes a deep row's status badge in its accessible name", () => {
    render(
      <PaneOpener
        epicId="epic-1"
        tabId="tab-status"
        groupId="group-status"
        active={false}
      />,
    );

    fireEvent.change(searchInput(), { target: { value: "unavailable" } });

    expect(
      screen.getByRole("option", {
        name: "Category → Unavailable Leaf → Unavailable: Remote Box",
      }),
    ).not.toBeNull();
  });

  it("selecting a deep row that bears a sub-page drills into it", () => {
    render(
      <PaneOpener
        epicId="epic-1"
        tabId="tab-drill"
        groupId="group-drill"
        active={false}
      />,
    );
    fireEvent.change(searchInput(), { target: { value: "nested" } });

    fireEvent.click(screen.getByRole("option", { name: "Category → Nested" }));

    // Now inside the "Nested" sub-page: its leaf shows, Back is available.
    expect(
      screen.getByRole("option", { name: "Deep Create Leaf" }),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).not.toBeNull();
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

  it("renders a host badge only on a sub-page row that carries one", () => {
    render(
      <PaneOpener
        epicId="epic-1"
        tabId="tab-badge"
        groupId="group-badge"
        active={false}
      />,
    );
    fireEvent.click(screen.getByText("Category"));

    expect(screen.getByText("Badged Leaf")).not.toBeNull();
    expect(screen.getByText("Remote Box")).not.toBeNull();
    // The unbadged row's own container carries no badge text.
    const innerLeafRow = screen
      .getByText("Inner Leaf")
      .closest('[data-slot="command-item"]');
    expect(innerLeafRow?.textContent).not.toContain("Remote Box");
  });
});
