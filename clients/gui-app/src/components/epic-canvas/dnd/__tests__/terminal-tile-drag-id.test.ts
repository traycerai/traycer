import { describe, expect, it } from "vitest";
import { plainTerminalFleetIdentityKey } from "@traycer/protocol/host/terminal/plain-schemas";
import {
  getPaneScopedDndId,
  getTerminalTileDragId,
} from "@/components/epic-canvas/dnd/dnd";

describe("getTerminalTileDragId", () => {
  it("namespaces drag ids by immutable owner host", () => {
    const sharedId = "shared-term";
    const hostA = getTerminalTileDragId(sharedId, "host-a");
    const hostB = getTerminalTileDragId(sharedId, "host-b");
    expect(hostA).not.toBe(hostB);
    expect(hostA).toBe(
      `terminal-tile:${plainTerminalFleetIdentityKey({ hostId: "host-a", terminalId: sharedId })}`,
    );
    expect(getPaneScopedDndId("tab-1", hostA)).not.toBe(
      getPaneScopedDndId("tab-1", hostB),
    );
  });
});
