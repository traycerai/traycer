import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTerminalTileRef,
  mintNewEpicTerminalTile,
} from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { isHostEpicTerminalRef } from "@/stores/epics/canvas/types";

describe("buildTerminalTileRef", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("mints a host-authority ref with launch evidence in legacyFallback", () => {
    const ref = buildTerminalTileRef({
      hostId: "host-1",
      cwd: "/work/repo",
    });
    expect(isHostEpicTerminalRef(ref)).toBe(true);
    if (!isHostEpicTerminalRef(ref)) return;
    expect(ref.legacyFallback).toEqual({
      name: ref.name,
      titleSource: "default",
      cwd: "/work/repo",
    });
    expect(
      useEpicCanvasStore.getState().pendingCreateArtifactIds.has(ref.id),
    ).toBe(false);
  });

  it("marks a new epic terminal pending-create so the tile dispatches create", () => {
    const ref = mintNewEpicTerminalTile({
      hostId: "host-1",
      cwd: "/work/repo",
    });
    expect(isHostEpicTerminalRef(ref)).toBe(true);
    expect(
      useEpicCanvasStore.getState().pendingCreateArtifactIds.has(ref.id),
    ).toBe(true);
  });
});
