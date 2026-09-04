import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCallback, type MouseEvent } from "react";
import { useTraycerReferenceOpenHandler } from "@/markdown/components/use-traycer-reference-open";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import {
  MANUAL_TILE_OPEN,
  openTileWithNavigation,
} from "@/lib/canvas/tile-open/open-tile";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";

const testState = vi.hoisted(() => ({
  testRef: {
    id: "spec-1",
    instanceId: "spec-instance-1",
    type: "spec",
    name: "Spec One",
    hostId: "host-1",
  } satisfies EpicNodeRef,
  openTile: vi.fn((_intent: TileOpenIntent): NestedFocusTarget | null => null),
  openEpicHandle: {
    epicId: "epic-1",
    store: {
      getState: () => ({}),
    },
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => "host-1",
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => testState.openEpicHandle,
}));

vi.mock("@/lib/epic-selectors", () => ({
  epicNodeRefForNodeId: () => testState.testRef,
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: testState.openTile }),
}));

describe("useTraycerReferenceOpenHandler", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    // The spy runs the REAL seam, so the store still transitions and the
    // recorded intent is the thing under test.
    testState.openTile.mockImplementation(
      (intent: TileOpenIntent): NestedFocusTarget | null =>
        openTileWithNavigation(
          intent,
          (_epicId, _tabId, prepare) => prepare(),
          MANUAL_TILE_OPEN,
        ),
    );
    testState.openTile.mockClear();
  });

  afterEach(cleanup);

  it("routes same-epic reference preview opens through the tile navigation boundary", () => {
    const viewTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-1", "Epic");

    render(<ReferenceButton />);

    fireEvent.click(screen.getByRole("button", { name: "Open reference" }));

    // A revert to the raw canvas preview call would still mutate the store, but
    // it would bypass this route-aware boundary spy.
    // A click on a reference is a SINGLE gesture on the epic, de-duped, with
    // the click's modifier triple attached: preview-vs-permanent is then the
    // resolver's call, not this hook's.
    expect(testState.openTile).toHaveBeenCalledWith({
      node: testState.testRef,
      target: { epicId: "epic-1" },
      gesture: "single",
      modifiers: { shift: false, alt: false, middle: false },
      placement: null,
      dedupe: true,
      source: "direct_ui",
    });
    const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
    if (canvas?.root?.kind !== "pane") throw new Error("expected pane");
    const activeTile =
      canvas.tilesByInstanceId[canvas.root.activeTabId ?? ""] ?? null;
    expect(activeTile).toMatchObject({
      id: testState.testRef.id,
      type: testState.testRef.type,
      name: testState.testRef.name,
      hostId: testState.testRef.hostId,
    } satisfies Partial<EpicNodeRef>);
  });
});

function ReferenceButton() {
  const { onOpen } = useTraycerReferenceOpenHandler({
    epicId: "epic-1",
    nodeId: testState.testRef.id,
    requiresNode: true,
  });
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      if (onOpen === null) return;
      onOpen(event);
    },
    [onOpen],
  );
  return (
    <button type="button" onClick={handleClick}>
      Open reference
    </button>
  );
}
