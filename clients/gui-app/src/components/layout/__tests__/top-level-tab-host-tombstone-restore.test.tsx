import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  MAX_RETAINED_TOP_LEVEL_SURFACES,
  TopLevelTabHost,
} from "@/components/layout/top-level-tab-host";
import { goBack } from "@/lib/commands/actions/history-navigation";
import { createPersistentMemoryHistory } from "@/lib/persistent-history";
import type { RouterHistory } from "@tanstack/react-router";
import { reopenClosedResourceOwnerTile } from "@/lib/resources/reopen-closed-resource-owner-tile";
import { queryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { commitPlainTerminalDeletion } from "@/lib/terminals/plain-terminal-presentation-invalidation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import { pane } from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";

vi.mock("@/components/epic-tabs/epic-surface", () => ({
  EpicSurface: (props: { readonly epicId: string; readonly tabId: string }) => (
    <div data-testid={`epic-surface-body-${props.tabId}`} />
  ),
}));

vi.mock("@/components/home/landing-draft-surface", () => ({
  LandingDraftSurface: () => <div data-testid="draft-surface-body" />,
}));

vi.mock("@/components/epics/history-surface", () => ({
  HistorySurface: () => <div data-testid="history-surface-body" />,
}));

vi.mock("@/components/settings/settings-surface", () => ({
  SettingsSurface: () => <div data-testid="settings-surface-body" />,
}));

const WINDOW_ID = "top-level-tombstone-restore";
const HOST_ID = "host-authority";
const TERMINAL_ID = "terminal-1";

function seedSources(refs: ReadonlyArray<TabRef>): void {
  for (const ref of refs) {
    if (ref.kind === "epic") {
      useEpicCanvasStore
        .getState()
        .openEpicTabWithId(ref.id, ref.id, `Epic ${ref.id}`);
    }
  }
}

function setSingle(ref: TabRef, refs: ReadonlyArray<TabRef>): void {
  useTabsStore.setState((state) => ({
    ...state,
    items: refs.map((candidate) => ({
      kind: "tab" as const,
      id: `tab:${candidate.kind}:${candidate.id}`,
      ref: candidate,
    })),
    activeItemId: `tab:${ref.kind}:${ref.id}`,
    stripOrder: refs,
  }));
}

function storageKey(windowId: string): string {
  return `traycer-gui-app:last-route:${windowId}`;
}

function seedPersistentHistory(
  entries: ReadonlyArray<string>,
  index: number,
): RouterHistory {
  window.localStorage.setItem(
    storageKey(WINDOW_ID),
    JSON.stringify({ entries, index }),
  );
  return createPersistentMemoryHistory(null, WINDOW_ID);
}

function closedLegacy(instanceId: string): EpicCanvasTileRef {
  return {
    id: TERMINAL_ID,
    instanceId,
    type: "terminal",
    name: "Late closed",
    hostId: HOST_ID,
    titleSource: "manual",
    cwd: "/legacy",
  };
}

describe("<TopLevelTabHost /> evicted epic tombstone restore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
    queryClient.clear();
  });

  afterEach(() => {
    cleanup();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
    queryClient.clear();
    window.localStorage.clear();
  });

  it("rejects history and resource restore after the real retention cap evicts the surface", async () => {
    const refs = Array.from({ length: 6 }, (_value, index) => ({
      kind: "epic" as const,
      id: `epic-${index}`,
    }));
    seedSources(refs);
    setSingle(refs[0], refs);
    render(<TopLevelTabHost />);

    for (const ref of refs.slice(1)) {
      act(() => setSingle(ref, refs));
    }

    await waitFor(() => {
      expect(screen.getAllByTestId(/^top-level-surface-epic-/)).toHaveLength(
        MAX_RETAINED_TOP_LEVEL_SURFACES,
      );
    });
    expect(screen.queryByTestId("top-level-surface-epic-0")).toBeNull();
    expect(screen.queryByTestId("epic-surface-body-epic-0")).toBeNull();
    expect(useEpicCanvasStore.getState().openTabOrder).toContain("epic-0");

    const evictedTabId = "epic-0";
    act(() => {
      useEpicCanvasStore.setState((state) => ({
        canvasByTabId: {
          ...state.canvasByTabId,
          [evictedTabId]: {
            root: pane("pane-0", []),
            activePaneId: "pane-0",
            tilesByInstanceId: {},
            sizesByGroupId: {},
          },
        },
      }));
    });
    expect(
      commitPlainTerminalDeletion({
        queryClient,
        queryKey: hostQueryKeys.plainTerminals(HOST_ID, {
          kind: "epic",
          epicId: evictedTabId,
        }),
        hostId: HOST_ID,
        terminalId: TERMINAL_ID,
        evidence: { kind: "stream", revision: 2 },
        deferPresentation: false,
      }),
    ).toBe(true);

    const legacy = closedLegacy("late-closed-legacy");
    const future: EpicCanvasTileRef = {
      id: TERMINAL_ID,
      instanceId: "late-closed-future",
      type: "terminal",
      name: "Future authority",
      hostId: HOST_ID,
      authority: "unsupported",
      rawAuthority: "future-v2",
      legacyFallback: {
        name: "Future authority",
        titleSource: "manual",
        cwd: "/repo",
      },
    };
    const otherId: EpicCanvasTileRef = {
      id: "terminal-other",
      instanceId: "late-closed-other-id",
      type: "terminal",
      name: "Other terminal",
      hostId: HOST_ID,
      titleSource: "manual",
      cwd: "/other",
    };
    act(() => {
      useEpicCanvasStore.setState((state) => ({
        closedTilePayloadsByTabId: {
          ...state.closedTilePayloadsByTabId,
          [evictedTabId]: {
            [legacy.instanceId]: { node: legacy, pendingCreate: false },
            [future.instanceId]: { node: future, pendingCreate: false },
            [otherId.instanceId]: { node: otherId, pendingCreate: false },
          },
        },
      }));
    });
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[evictedTabId]?.[
        legacy.instanceId
      ],
    ).toBeDefined();

    const landing = `/epics/${evictedTabId}/${evictedTabId}?focusPaneId=pane-0&focusTileInstanceId=${legacy.instanceId}`;
    const history = seedPersistentHistory(
      [landing, `/epics/${evictedTabId}/${evictedTabId}`],
      1,
    );
    vi.spyOn(history, "go").mockImplementation(() => {});
    act(() => goBack({ history }));

    expect(
      useEpicCanvasStore.getState().canvasByTabId[evictedTabId]
        ?.tilesByInstanceId[legacy.instanceId],
    ).toBeUndefined();
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[evictedTabId]?.[
        legacy.instanceId
      ],
    ).toBeUndefined();
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[evictedTabId]?.[
        future.instanceId
      ],
    ).toBeDefined();
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[evictedTabId]?.[
        otherId.instanceId
      ],
    ).toBeDefined();

    useEpicCanvasStore.setState((state) => ({
      closedTilePayloadsByTabId: {
        ...state.closedTilePayloadsByTabId,
        [evictedTabId]: {
          ...state.closedTilePayloadsByTabId[evictedTabId],
          [legacy.instanceId]: { node: legacy, pendingCreate: false },
        },
      },
    }));

    expect(
      reopenClosedResourceOwnerTile({
        epicId: evictedTabId,
        tabId: evictedTabId,
        node: legacy,
      }),
    ).toBe(false);
    expect(
      useEpicCanvasStore.getState().canvasByTabId[evictedTabId]
        ?.tilesByInstanceId[legacy.instanceId],
    ).toBeUndefined();
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[evictedTabId]?.[
        future.instanceId
      ],
    ).toBeDefined();
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[evictedTabId]?.[
        otherId.instanceId
      ],
    ).toBeDefined();
  });
});
