import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCallback, type MouseEvent } from "react";
import { useTraycerReferenceOpenHandler } from "@/markdown/components/use-traycer-reference-open";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicCanvasTileRef,
  EpicNodeRef,
} from "@/stores/epics/canvas/types";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";

const testState = vi.hoisted(() => ({
  testRef: {
    id: "spec-1",
    instanceId: "spec-instance-1",
    type: "spec",
    name: "Spec One",
    hostId: "host-1",
  } satisfies EpicNodeRef,
  openTilePreviewInEpic: vi.fn(
    (_epicId: string, _node: EpicCanvasTileRef): NestedFocusTarget | null =>
      null,
  ),
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

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => testState.openEpicHandle,
}));

vi.mock("@/lib/epic-selectors", () => ({
  epicNodeRefForNodeId: () => testState.testRef,
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({
    openTilePreviewInEpic: testState.openTilePreviewInEpic,
    openTilePreviewInTab: vi.fn(),
    openTileInTab: vi.fn(),
    openTileInEpic: vi.fn(),
  }),
}));

describe("useTraycerReferenceOpenHandler", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    testState.openTilePreviewInEpic.mockImplementation(
      (epicId: string, node: EpicCanvasTileRef): NestedFocusTarget | null => {
        const store = useEpicCanvasStore.getState();
        const tabId = store.resolveTargetTabForEpic(epicId, undefined);
        return store.prepareOpenTilePreviewInTabFocusTarget(tabId, node);
      },
    );
    testState.openTilePreviewInEpic.mockClear();
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
    expect(testState.openTilePreviewInEpic).toHaveBeenCalledWith(
      "epic-1",
      testState.testRef,
    );
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
