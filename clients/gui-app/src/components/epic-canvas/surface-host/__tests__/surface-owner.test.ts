import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpicArtifactRef } from "@/stores/epics/canvas/types";
import type { surfaceOwnerFor as SurfaceOwnerFor } from "@/components/epic-canvas/surface-host/surface-owner";

const SWITCH_MODULE_PATH =
  "@/components/epic-canvas/surface-host/stable-tile-surface-host-switch";

const CHAT_REF: EpicArtifactRef = {
  id: "chat-1",
  instanceId: "instance-1",
  type: "chat",
  name: "Chat",
  hostId: "host-1",
};

const SPEC_REF: EpicArtifactRef = {
  ...CHAT_REF,
  id: "spec-1",
  instanceId: "instance-2",
  type: "spec",
};

async function loadSurfaceOwnerFor(
  enabled: boolean,
): Promise<typeof SurfaceOwnerFor> {
  vi.resetModules();
  vi.doMock(SWITCH_MODULE_PATH, () => ({
    STABLE_TILE_SURFACE_HOST_ENABLED: enabled,
  }));
  const mod =
    await import("@/components/epic-canvas/surface-host/surface-owner");
  return mod.surfaceOwnerFor;
}

afterEach(() => {
  vi.doUnmock(SWITCH_MODULE_PATH);
  vi.resetModules();
});

describe("surfaceOwnerFor", () => {
  it("stays inline for a live chat while the switch is off", async () => {
    const surfaceOwnerFor = await loadSurfaceOwnerFor(false);
    expect(surfaceOwnerFor({ node: CHAT_REF, isRemoteDeleted: false })).toBe(
      "inline",
    );
  });

  it("hosts a live chat once the switch is on", async () => {
    const surfaceOwnerFor = await loadSurfaceOwnerFor(true);
    expect(surfaceOwnerFor({ node: CHAT_REF, isRemoteDeleted: false })).toBe(
      "hosted",
    );
  });

  it("keeps a remote-deleted chat inline even with the switch on", async () => {
    const surfaceOwnerFor = await loadSurfaceOwnerFor(true);
    expect(surfaceOwnerFor({ node: CHAT_REF, isRemoteDeleted: true })).toBe(
      "inline",
    );
  });

  it("keeps a non-chat node inline even with the switch on", async () => {
    const surfaceOwnerFor = await loadSurfaceOwnerFor(true);
    expect(surfaceOwnerFor({ node: SPEC_REF, isRemoteDeleted: false })).toBe(
      "inline",
    );
  });
});
