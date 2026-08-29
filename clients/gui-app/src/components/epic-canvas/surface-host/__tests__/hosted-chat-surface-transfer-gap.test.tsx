/**
 * Ticket 21 slice 4 fix round, finding 1 (BLOCKER): a header tear-off must
 * not unmount/remount the hosted chat body. Reproduces the reviewer's exact
 * transfer-gap discriminator - a REAL tear-off action moves the tile's
 * canvas entry to a destination tab in one synchronous `EpicCanvasStore`
 * write, while the environment passed to the bridge deliberately stays the
 * SOURCE environment (no destination `TileSurfaceSlot` is rendered here to
 * republish a fresh one - that's the gap).
 *
 * `renderTile` is swapped for a STABLE, module-level mount-tracking probe -
 * defined ONCE, not recreated per call - so a false remount reading can't be
 * an artifact of the mock itself; only `HostedChatSurfaceBody`'s own node
 * resolution can cause one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import {
  pane,
  TEST_HOST_ID,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import { buildSyntheticTileSurfaceEnvironment } from "@/components/epic-canvas/surface-host/__tests__/synthetic-tile-surface-fixture";
import type { ReadyTileSurfaceEnvironment } from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import type { TabRef } from "@/stores/tabs/types";

const INSTANCE_ID = "chat-transfer-1";
const SOURCE_TAB_ID = "tab-source";
const PANE_ID = "p1";
const EPIC_ID = "epic-1";

const CHAT_NODE = {
  id: INSTANCE_ID,
  instanceId: INSTANCE_ID,
  type: "chat" as const,
  name: "Transfer chat",
  hostId: TEST_HOST_ID,
};

interface ProbeEvent {
  readonly kind: "mount" | "unmount";
}
const probeEvents = vi.hoisted((): ProbeEvent[] => []);

function TransferGapProbe(): ReactNode {
  useEffect(() => {
    probeEvents.push({ kind: "mount" });
    return () => {
      probeEvents.push({ kind: "unmount" });
    };
  }, []);
  return <div data-testid="transfer-gap-probe" />;
}

vi.mock("@/components/epic-canvas/renderers/tile-render", () => ({
  renderTile: (): ReactNode => <TransferGapProbe />,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicPermissionRole: () => "owner",
}));

vi.mock("@/components/epic-canvas/renderers/browser-sessions-provider", () => ({
  BrowserSessionsHostProvider: (props: { readonly children: ReactNode }) =>
    props.children,
}));

// Import AFTER the mocks so the bridge picks them up.
import { HostedChatSurfaceContextBridge } from "@/components/epic-canvas/surface-host/hosted-chat-surface-context-bridge";

function seedSourceCanvas(): void {
  useEpicCanvasStore.setState({
    tabsById: {
      [SOURCE_TAB_ID]: { tabId: SOURCE_TAB_ID, epicId: EPIC_ID, name: "Epic" },
    },
    canvasByTabId: {
      [SOURCE_TAB_ID]: {
        root: pane(PANE_ID, [INSTANCE_ID]),
        activePaneId: PANE_ID,
        tilesByInstanceId: { [INSTANCE_ID]: CHAT_NODE },
        sizesByGroupId: {},
      },
    },
    openTabOrder: [SOURCE_TAB_ID],
    activeTabId: SOURCE_TAB_ID,
  });
  const ref: TabRef = { kind: "epic", id: SOURCE_TAB_ID };
  useTabsStore.setState((state) => ({
    ...state,
    items: [{ kind: "tab" as const, id: `tab:${ref.kind}:${ref.id}`, ref }],
    activeItemId: `tab:${ref.kind}:${ref.id}`,
    stripOrder: [ref],
  }));
}

function sourceEnvironment(): ReadyTileSurfaceEnvironment {
  return buildSyntheticTileSurfaceEnvironment(INSTANCE_ID, {
    identity: {
      instanceId: INSTANCE_ID,
      tileKind: "chat",
      contentId: INSTANCE_ID,
      epicId: EPIC_ID,
      hostId: TEST_HOST_ID,
    },
    placement: {
      epicId: EPIC_ID,
      viewTabId: SOURCE_TAB_ID,
      paneId: PANE_ID,
      hostId: TEST_HOST_ID,
    },
    canvasActivity: { tabSelected: true, canvasPaneActive: true },
  });
}

describe("HostedChatSurfaceContextBridge transfer-gap continuity (finding 1)", () => {
  beforeEach(() => {
    probeEvents.length = 0;
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    seedSourceCanvas();
  });
  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
  });

  it("keeps the body mounted across a real header tear-off while the environment still names the source tab", () => {
    render(
      <HostedChatSurfaceContextBridge environment={sourceEnvironment()} />,
    );
    expect(screen.getByTestId("transfer-gap-probe")).not.toBeNull();
    expect(probeEvents.filter((e) => e.kind === "mount")).toHaveLength(1);
    expect(probeEvents.filter((e) => e.kind === "unmount")).toHaveLength(0);

    // Real tear-off: the `EpicCanvasStore` write lands synchronously inside
    // the coordinator transaction; `useTabsStore`'s header ref lands moments
    // later in the SAME transaction. The bridge keeps the SAME (now-stale)
    // source environment throughout - no destination `TileSurfaceSlot`
    // exists in this test to republish a fresh one, reproducing the gap.
    let destinationTabId: string | null = null;
    act(() => {
      tabCommandCoordinator.createSourceRefAtStripIndex(0, () => {
        destinationTabId = useEpicCanvasStore
          .getState()
          .tearOffTabIntoNewHeaderTab({
            sourceTabId: SOURCE_TAB_ID,
            sourcePaneId: PANE_ID,
            sourceTileTabId: INSTANCE_ID,
            insertIndex: 0,
          });
        return destinationTabId === null
          ? null
          : { kind: "epic", id: destinationTabId };
      });
    });
    expect(destinationTabId).not.toBeNull();

    // Confirm the tile really did move out of the source tab - this is the
    // actual gap condition, not a no-op action.
    expect(
      useEpicCanvasStore.getState().canvasByTabId[SOURCE_TAB_ID]
        ?.tilesByInstanceId[INSTANCE_ID],
    ).toBeUndefined();

    expect(screen.getByTestId("transfer-gap-probe")).not.toBeNull();
    expect(probeEvents.filter((e) => e.kind === "mount")).toHaveLength(1);
    expect(probeEvents.filter((e) => e.kind === "unmount")).toHaveLength(0);
  });
});
