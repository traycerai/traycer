import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { deletedArtifactsTileId } from "@/stores/epics/canvas/tile-schema/deleted-artifacts-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  DeletedArtifactsTileRef,
  EpicCanvasState,
} from "@/stores/epics/canvas/types";

import { useEpicOpenDeletedArtifacts } from "../use-epic-open-deleted-artifacts";

describe("useEpicOpenDeletedArtifacts", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  function deletedTiles(
    canvas: EpicCanvasState | undefined,
  ): DeletedArtifactsTileRef[] {
    if (canvas === undefined) return [];
    return Object.values(canvas.tilesByInstanceId).filter(
      (tile): tile is DeletedArtifactsTileRef =>
        tile !== undefined && tile.type === "deleted-artifacts",
    );
  }

  it("reopens through the real canvas store and focuses the existing tile", () => {
    const { result } = renderHook(() =>
      useEpicOpenDeletedArtifacts("epic-a", "host-a"),
    );

    act(() => result.current());
    const tabId =
      useEpicCanvasStore.getState().mostRecentTabIdByEpicId["epic-a"];
    if (tabId === undefined) throw new Error("Expected an epic tab");
    const firstCanvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (firstCanvas === undefined) throw new Error("Expected an epic canvas");
    const first = deletedTiles(firstCanvas);
    expect(first).toHaveLength(1);

    act(() => result.current());
    const reopenedCanvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    const reopened = deletedTiles(reopenedCanvas);

    expect(reopened).toHaveLength(1);
    expect(reopened).toEqual(first);
    expect(reopened.map((tile) => tile.id)).toEqual([
      deletedArtifactsTileId("epic-a", "host-a"),
    ]);
  });

  it("opens a separate lifetime-bound tile when the same epic changes hosts", () => {
    const { result, rerender } = renderHook(
      ({ hostId }: { readonly hostId: string }) =>
        useEpicOpenDeletedArtifacts("epic-a", hostId),
      { initialProps: { hostId: "host-a" } },
    );

    act(() => result.current());
    rerender({ hostId: "host-b" });
    act(() => result.current());

    const tabId =
      useEpicCanvasStore.getState().mostRecentTabIdByEpicId["epic-a"];
    if (tabId === undefined) throw new Error("Expected an epic tab");
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas === undefined) throw new Error("Expected an epic canvas");
    const opened = deletedTiles(canvas);

    expect(opened).toHaveLength(2);
    expect(new Set(opened.map((tile) => tile.id))).toEqual(
      new Set([
        deletedArtifactsTileId("epic-a", "host-a"),
        deletedArtifactsTileId("epic-a", "host-b"),
      ]),
    );
  });

  it("does not open without a session host", () => {
    const { result } = renderHook(() =>
      useEpicOpenDeletedArtifacts("epic-a", null),
    );

    act(() => result.current());

    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
  });
});
