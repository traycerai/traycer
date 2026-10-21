import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLeftPanelDefinition } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { LAYOUT_CLUSTER_ATTRIBUTE } from "@/components/layout-editor/canvas/canvas-attributes";
import { createAppQueryClient } from "@/lib/query-client";
import { SampleWorkspaceSidebar } from "@/components/sample-workspace/sample-workspace-sidebar";
import {
  SAMPLE_COMMENT_THREADS,
  SAMPLE_PULL_REQUESTS,
  SAMPLE_SIDEBAR_AGENTS,
  SAMPLE_SIDEBAR_ARTIFACTS,
} from "@/components/sample-workspace/sample-workspace-scene";
import {
  insertRailDivider,
  unstackRail,
} from "@/lib/layout/layout-arrangement";
import { leftPanelIdForRailRegion } from "@/lib/layout/rail";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

/**
 * The surface a session's rail drag happens on (L-115), plus - since F3 -
 * the sidebar's own body, drawn from the same real components the epic
 * sidebar renders. The rail is `arrangement.rail`, entry for entry, inside
 * one toolbar cluster; the body follows the canvas selection like the real
 * sidebar's own panel section does.
 */

function toolbar(): HTMLElement {
  return screen.getByRole("toolbar", { name: "Sample sidebar panels" });
}

function railEntries(): ReadonlyArray<HTMLElement> {
  return [...toolbar().children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  );
}

function sidebarBody(): HTMLElement {
  const body = document.querySelector("[data-sample-sidebar-body]");
  if (!(body instanceof HTMLElement)) {
    throw new Error("sample sidebar body not rendered");
  }
  return body;
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

/** One divider in the rail, which is the only way there is one (L-155). */
function addDivider(index: number): void {
  const { arrangement } = useLayoutStore.getState();
  useLayoutStore
    .getState()
    .setArrangement(insertRailDivider(arrangement, index));
}

/** The rail with its one shipped stack taken apart, for a flat-rail case. */
function unstackShippedPair(): void {
  const { arrangement } = useLayoutStore.getState();
  useLayoutStore
    .getState()
    .setArrangement(unstackRail(arrangement, "stack:railAgents+railArtifacts"));
}

function hidePanel(railRegion: "railBrowsers"): void {
  useLayoutStore.setState({
    overrides: {
      ...useLayoutStore.getState().overrides,
      [railRegion]: { shown: "hidden" },
    },
  });
}

describe("the sample sidebar's icon rail", () => {
  it("is nine icons and nothing else by default (L-155, L-166, L-181)", () => {
    render(<SampleWorkspaceSidebar />);

    const nodes = railEntries();
    // Eight things in the toolbar, because the shipped stack draws as ONE
    // group icon (G3) - nine panels all the same.
    expect(nodes).toHaveLength(8);
    expect(screen.getAllByTestId("epic-rail-stack")).toHaveLength(1);
    expect(
      screen
        .getByTestId("epic-rail-stack")
        .querySelectorAll("[data-layout-region]"),
    ).toHaveLength(1);
    expect(toolbar().querySelectorAll("[data-layout-region]")).toHaveLength(8);
    expect(screen.queryAllByTestId("epic-rail-divider")).toHaveLength(0);
  });

  it("draws a divider the user added as a gap at rest, and its panels in order", () => {
    unstackShippedPair();
    addDivider(2);
    render(<SampleWorkspaceSidebar />);

    const rail = useLayoutStore.getState().arrangement.rail;
    expect(rail.filter((entry) => entry.kind === "divider")).toHaveLength(1);
    expect(
      railEntries().map((node) => node.getAttribute("aria-label")),
    ).toEqual(
      rail.map((entry) =>
        entry.kind === "panel"
          ? getLeftPanelDefinition(leftPanelIdForRailRegion(entry.id)).title
          : null,
      ),
    );
    const dividers = screen.getAllByTestId("epic-rail-divider");
    expect(dividers).toHaveLength(1);
    expect(dividers[0].hasAttribute("data-rail-divider-resting")).toBe(true);
  });

  it("lays the entries out in one cluster, which is the drop's own scope", () => {
    render(<SampleWorkspaceSidebar />);

    const bar = toolbar();
    expect(bar.hasAttribute(LAYOUT_CLUSTER_ATTRIBUTE)).toBe(true);
    for (const node of railEntries())
      expect(node.closest(`[${LAYOUT_CLUSTER_ATTRIBUTE}]`)).toBe(bar);
  });

  it("marks no member at rest", () => {
    render(<SampleWorkspaceSidebar />);

    for (const node of railEntries()) {
      expect(node.getAttribute("data-layout-group")).toBeNull();
      expect(node.getAttribute("data-layout-draggable")).toBeNull();
    }
  });

  it("offers the real rail's menu for the icon the pointer was over", () => {
    render(<SampleWorkspaceSidebar />);

    fireEvent.contextMenu(screen.getByLabelText("Browsers"));

    expect(screen.getByTestId("epic-rail-context-menu")).not.toBeNull();
    expect(screen.getByTestId("epic-rail-hide-pointed-panel").textContent).toBe(
      "Hide 'Browsers'",
    );
    expect(screen.getByTestId("customize-layout-menu-item")).not.toBeNull();
  });

  it("opens the panel list over the rail's own space, naming no panel", () => {
    render(<SampleWorkspaceSidebar />);

    fireEvent.contextMenu(toolbar());

    expect(screen.getByTestId("epic-rail-context-menu")).not.toBeNull();
    expect(screen.queryByTestId("epic-rail-hide-pointed-panel")).toBeNull();
  });

  it("records a hide as a gesture, so Undo and Discard both take it back", () => {
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });
    const entry = useLayoutEditorStore.getState().entrySnapshot;
    render(<SampleWorkspaceSidebar />);

    useLayoutEditorStore.getState().recordGesture(() => {
      useLayoutStore.getState().applyPreset("compact");
    });
    fireEvent.contextMenu(screen.getByLabelText("Browsers"));
    fireEvent.click(screen.getByTestId("epic-rail-hide-pointed-panel"));

    expect(useLayoutStore.getState().overrides.railBrowsers).toEqual({
      shown: "hidden",
    });
    expect(useLayoutEditorStore.getState().history.past).toHaveLength(2);
    expect(useLayoutEditorStore.getState().entrySnapshot).toEqual(entry);

    useLayoutEditorStore.getState().undo();

    expect(useLayoutStore.getState().overrides.railBrowsers).toBeUndefined();
    expect(useLayoutStore.getState().basePreset).toBe("compact");

    useLayoutEditorStore.getState().discard();

    expect(useLayoutStore.getState().basePreset).toBe("default");
    expect(useLayoutStore.getState().overrides).toEqual({});
  });

  it("offers 'Move sidebar to right' for the default (left) side, and writes sidebarSide on click", () => {
    render(<SampleWorkspaceSidebar />);

    fireEvent.contextMenu(toolbar());
    expect(screen.getByTestId("epic-rail-move-sidebar").textContent).toBe(
      "Move sidebar to right",
    );

    fireEvent.click(screen.getByTestId("epic-rail-move-sidebar"));

    expect(useLayoutStore.getState().arrangement.sidebarSide).toBe("right");
    expect(useLayoutEditorStore.getState().history.past).toHaveLength(0);
  });

  it("makes every entry a draggable member of the rail in a session", () => {
    addDivider(2);
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });

    render(<SampleWorkspaceSidebar />);

    const rail = useLayoutStore.getState().arrangement.rail;
    const nodes = railEntries();
    expect(nodes).toHaveLength(rail.length);
    for (const [index, entry] of rail.entries()) {
      const node = nodes[index];
      expect(node.getAttribute("data-layout-group")).toBe("rail");
      expect(node.getAttribute("data-layout-draggable")).toBe("1");
      expect(
        node.getAttribute("data-layout-member") ??
          node.getAttribute("data-layout-region"),
      ).toBe(entry.id);
    }
  });
});

describe("the sample sidebar's body", () => {
  it("has Pull Requests and Comments present by default (Auto panels)", () => {
    render(<SampleWorkspaceSidebar />);

    expect(screen.getByLabelText("Pull Requests")).not.toBeNull();
    expect(screen.getByLabelText("Comments")).not.toBeNull();
  });

  it("shows the Agents+Artifacts stack for the default selection, agents first", () => {
    render(<SampleWorkspaceSidebar />);

    const body = within(sidebarBody());
    for (const agent of SAMPLE_SIDEBAR_AGENTS) {
      expect(body.getByText(agent.title)).not.toBeNull();
    }
  });

  it("shows a resource usage chip on each agent row when agent rows readings are on", () => {
    useLayoutStore
      .getState()
      .setRegionValues("resourceMonitor", { agentRows: true });
    render(<SampleWorkspaceSidebar />);

    const chips = sidebarBody().querySelectorAll(
      '[data-slot="resource-usage-chip"]',
    );
    expect(chips).toHaveLength(SAMPLE_SIDEBAR_AGENTS.length);
  });

  it("shows no resource usage chip when agent rows readings are off (the default)", () => {
    render(<SampleWorkspaceSidebar />);

    const chips = sidebarBody().querySelectorAll(
      '[data-slot="resource-usage-chip"]',
    );
    expect(chips).toHaveLength(0);
  });

  it("switches the displayed body to the selected rail region, showing the sample PR rows", () => {
    render(<SampleWorkspaceSidebar />);

    act(() => {
      useLayoutEditorStore.getState().select("railPullRequests");
    });
    // Re-render happens via subscription; query after the store write.
    // The section header repeats the panel title, so match on any instance.
    const body = within(sidebarBody());
    expect(body.getAllByText("Pull Requests").length).toBeGreaterThan(0);
    expect(body.getAllByTestId("pr-row")).toHaveLength(
      SAMPLE_PULL_REQUESTS.length,
    );
    for (const pr of SAMPLE_PULL_REQUESTS) {
      expect(body.getByText(pr.title ?? "")).not.toBeNull();
    }
  });

  it("shows the sample comment threads when Comments is selected", () => {
    // The comments panel's poll needs a QueryClient the other panels
    // sampled here do not - it is disabled by `commentRoomAvailability`
    // rather than by having nothing to reach, so the hook still mounts.
    const queryClient = createAppQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <SampleWorkspaceSidebar />
      </QueryClientProvider>,
    );

    act(() => {
      useLayoutEditorStore.getState().select("railComments");
    });

    const body = within(sidebarBody());
    for (const thread of SAMPLE_COMMENT_THREADS) {
      expect(body.getByText(thread.data.quotedText ?? "")).not.toBeNull();
    }
  });

  it("shows the Agents+Artifacts stack when the stacked member is selected", () => {
    render(<SampleWorkspaceSidebar />);

    act(() => {
      useLayoutEditorStore.getState().select("railArtifacts");
    });

    const body = within(sidebarBody());
    for (const artifact of SAMPLE_SIDEBAR_ARTIFACTS) {
      expect(body.getByText(artifact.name)).not.toBeNull();
    }
    for (const agent of SAMPLE_SIDEBAR_AGENTS) {
      expect(body.getByText(agent.title)).not.toBeNull();
    }
  });

  it("hides a user-hidden panel's rail tile at rest", () => {
    hidePanel("railBrowsers");
    render(<SampleWorkspaceSidebar />);

    expect(screen.queryByLabelText("Browsers")).toBeNull();
  });

  it("brings a hidden panel's tile back, ghosted, while it is hovered during a live session", () => {
    hidePanel("railBrowsers");
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });
    render(<SampleWorkspaceSidebar />);

    expect(screen.queryByLabelText("Browsers")).toBeNull();

    act(() => {
      useLayoutEditorStore.getState().setHovered("railBrowsers");
    });

    const tile = screen.getByLabelText("Browsers");
    expect(tile).not.toBeNull();
    expect(tile.getAttribute("data-ghost")).toBe("1");
  });

  it("brings a hidden panel's tile back, ghosted, while it is selected during a live session", () => {
    hidePanel("railBrowsers");
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });
    render(<SampleWorkspaceSidebar />);

    act(() => {
      useLayoutEditorStore.getState().select("railBrowsers");
    });

    const tile = screen.getByLabelText("Browsers");
    expect(tile).not.toBeNull();
    expect(tile.getAttribute("data-ghost")).toBe("1");
  });

  it("draws an un-ghosted tile for a hovered hidden panel outside a live session", () => {
    hidePanel("railBrowsers");
    render(<SampleWorkspaceSidebar />);

    act(() => {
      useLayoutEditorStore.getState().setHovered("railBrowsers");
    });

    // The tile follows hover/select regardless of a session; only the
    // ghost decoration is session-gated (`regionGhostRequested`).
    const tile = screen.getByLabelText("Browsers");
    expect(tile.getAttribute("data-ghost")).not.toBe("1");
  });
});
