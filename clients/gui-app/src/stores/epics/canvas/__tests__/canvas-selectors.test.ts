import { describe, expect, it } from "vitest";
import { isTileRefRecordLive } from "@/stores/epics/canvas/canvas-selectors";
import { TILE_KIND_BLANK } from "@/stores/epics/canvas/tile-kinds";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

function specTile(id: string): EpicCanvasTileRef {
  return {
    id,
    instanceId: `inst-${id}`,
    type: "spec",
    name: id,
    hostId: "test-host",
  };
}

function blankTile(id: string): EpicCanvasTileRef {
  return {
    id,
    instanceId: `inst-${id}`,
    type: TILE_KIND_BLANK,
    name: "New tab",
    hostId: "test-host",
  };
}

describe("isTileRefRecordLive", () => {
  it("is always live for a non-record-backed kind (blank tile)", () => {
    expect(isTileRefRecordLive(blankTile("b1"), new Set(), () => false)).toBe(
      true,
    );
  });

  it("is live when a record-backed kind is still present per hasLiveRecord", () => {
    expect(
      isTileRefRecordLive(specTile("art-1"), new Set(), (id) => id === "art-1"),
    ).toBe(true);
  });

  it("is dead when a record-backed kind is absent per hasLiveRecord", () => {
    expect(isTileRefRecordLive(specTile("art-1"), new Set(), () => false)).toBe(
      false,
    );
  });

  it("is live while still within the optimistic-create window, even if hasLiveRecord says no", () => {
    expect(
      isTileRefRecordLive(
        specTile("art-pending"),
        new Set(["art-pending"]),
        () => false,
      ),
    ).toBe(true);
  });
});
