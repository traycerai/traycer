import { describe, expect, it } from "vitest";
import {
  isTileRefRecordLive,
  type TileRefLivenessCheck,
} from "@/stores/epics/canvas/canvas-selectors";
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

function chatTile(id: string, hostId: string): EpicCanvasTileRef {
  return {
    id,
    instanceId: `inst-${id}`,
    type: "chat",
    name: id,
    hostId,
  };
}

function liveness(
  overrides: Partial<TileRefLivenessCheck>,
): TileRefLivenessCheck {
  return {
    hasLiveRecord: () => false,
    isCloudKnown: () => false,
    recordListAuthorizesChatAbsence: true,
    ...overrides,
  };
}

describe("isTileRefRecordLive", () => {
  it("is always live for a non-record-backed kind (blank tile)", () => {
    expect(
      isTileRefRecordLive(blankTile("b1"), new Set(), liveness({}), null),
    ).toBe(true);
  });

  it("is live when a record-backed kind is still present per hasLiveRecord", () => {
    expect(
      isTileRefRecordLive(
        specTile("art-1"),
        new Set(),
        liveness({ hasLiveRecord: (id) => id === "art-1" }),
        null,
      ),
    ).toBe(true);
  });

  it("is dead when a record-backed kind is absent per hasLiveRecord", () => {
    expect(
      isTileRefRecordLive(specTile("art-1"), new Set(), liveness({}), null),
    ).toBe(false);
  });

  it("exempts a CHAT ref bound to another host from projection policing", () => {
    // A reachable owner's chat opened live from the unified sidebar has no
    // record in THIS device's projection - chat records are host-
    // authoritative. Reaping it made the sidebar click a silent no-op
    // (caught in the two-slot live check, 2026-08-08).
    expect(
      isTileRefRecordLive(
        chatTile("chat-remote", "host-b"),
        new Set(),
        liveness({}),
        "host-a",
      ),
    ).toBe(true);
  });

  it("still polices a CHAT ref bound to the projection's own host", () => {
    expect(
      isTileRefRecordLive(
        chatTile("chat-local", "host-a"),
        new Set(),
        liveness({}),
        "host-a",
      ),
    ).toBe(false);
  });

  it("keeps a same-host CHAT live until the local record list answers", () => {
    expect(
      isTileRefRecordLive(
        chatTile("chat-local-unanswered", "host-a"),
        new Set(),
        liveness({ recordListAuthorizesChatAbsence: false }),
        "host-a",
      ),
    ).toBe(true);
  });

  it("keeps a CHAT live while the projection host identity is unresolved", () => {
    expect(
      isTileRefRecordLive(
        chatTile("chat-host-unresolved", "host-a"),
        new Set(),
        liveness({}),
        null,
      ),
    ).toBe(true);
  });

  it("still polices a cross-host ARTIFACT ref - artifact records are doc-shared", () => {
    const ref: EpicCanvasTileRef = {
      id: "art-x",
      instanceId: "inst-art-x",
      type: "spec",
      name: "art-x",
      hostId: "host-b",
    };
    expect(isTileRefRecordLive(ref, new Set(), liveness({}), "host-a")).toBe(
      false,
    );
  });

  it("is live while still within the optimistic-create window, even if hasLiveRecord says no", () => {
    expect(
      isTileRefRecordLive(
        specTile("art-pending"),
        new Set(["art-pending"]),
        liveness({}),
        null,
      ),
    ).toBe(true);
  });

  // chat-sync-v2 ticket 36
  it("is live for a SAME-host CHAT ref with no local record but still cloud-known", () => {
    expect(
      isTileRefRecordLive(
        chatTile("chat-local-cloud-known", "host-a"),
        new Set(),
        liveness({ isCloudKnown: (id) => id === "chat-local-cloud-known" }),
        "host-a",
      ),
    ).toBe(true);
  });

  it("stays dead for a same-host CHAT ref that is neither locally live nor cloud-known", () => {
    expect(
      isTileRefRecordLive(
        chatTile("chat-local-gone", "host-a"),
        new Set(),
        liveness({}),
        "host-a",
      ),
    ).toBe(false);
  });

  it("does not extend the cloud-known exemption to a non-chat ref", () => {
    // The exemption is scoped to `ref.type === "chat"` deliberately -
    // artifact/terminal-agent records are doc-shared and a cloud-chat id
    // match would be a coincidence, never a real exemption.
    expect(
      isTileRefRecordLive(
        specTile("art-1"),
        new Set(),
        liveness({ isCloudKnown: () => true }),
        "host-a",
      ),
    ).toBe(false);
  });
});
