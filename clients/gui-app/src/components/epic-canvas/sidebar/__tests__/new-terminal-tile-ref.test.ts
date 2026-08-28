import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTerminalTileRef,
  mintNewEpicTerminalTile,
} from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import {
  peekEpicTerminalDurableCreate,
  resetEpicTerminalDurableCreatesForTests,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { hasTerminalPendingCreate } from "@/lib/terminals/pending-create-identity";
import { isHostEpicTerminalRef } from "@/stores/epics/canvas/types";

describe("buildTerminalTileRef", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    resetEpicTerminalDurableCreatesForTests();
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

  it("marks a new epic terminal pending-create and accepts a durable create job", () => {
    const ref = mintNewEpicTerminalTile({
      hostId: "host-1",
      cwd: "/work/repo",
      epicId: "epic-1",
    });
    expect(isHostEpicTerminalRef(ref)).toBe(true);
    expect(
      hasTerminalPendingCreate(
        useEpicCanvasStore.getState().pendingCreateTerminalIdentities,
        ref.hostId,
        ref.id,
      ),
    ).toBe(true);
    expect(peekEpicTerminalDurableCreate(ref.hostId, ref.id)).toEqual({
      request: {
        hostId: "host-1",
        terminalId: ref.id,
        epicId: "epic-1",
        cwd: "/work/repo",
        cols: 80,
        rows: 24,
      },
      status: "accepted",
      error: null,
    });
  });
});
