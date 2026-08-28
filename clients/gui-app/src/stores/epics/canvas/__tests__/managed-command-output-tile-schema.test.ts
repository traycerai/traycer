import { describe, expect, it } from "vitest";
import {
  parseTileRef,
  serializeTileRef,
} from "@/stores/epics/canvas/tile-schema";
import {
  MANAGED_COMMAND_OUTPUT_TILE_NAME,
  makeManagedCommandOutputTileRef,
} from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";

/**
 * An output window is a POINTER, not a copy. The persisted tile carries the
 * command it points at and the host that owns it - nothing else. Every label,
 * kind and status a viewer reads comes from the owning chat's live set, so a window
 * restored days later cannot show a stale description or a status the command
 * left long ago. This test is the fence around that (`UI.md` §4, seam S8).
 */

const HOST = "host-1";
const COMMAND = "cmd-42";

describe("managed-command output tile schema", () => {
  it("persists the command pointer and the host, and nothing else", () => {
    const ref = makeManagedCommandOutputTileRef({
      commandId: COMMAND,
      hostId: HOST,
    });

    const serialized = serializeTileRef(ref);

    expect(Object.keys(serialized as object).sort()).toEqual([
      "hostId",
      "id",
      "instanceId",
      "type",
    ]);
  });

  it("addresses the command by the tile's content id, so one command opens one window", () => {
    const first = makeManagedCommandOutputTileRef({
      commandId: COMMAND,
      hostId: HOST,
    });
    const second = makeManagedCommandOutputTileRef({
      commandId: COMMAND,
      hostId: HOST,
    });

    // Same command => same content id (the canvas dedup key), fresh tab
    // identity each time.
    expect(first.id).toBe(second.id);
    expect(first.id).toBe(COMMAND);
    expect(first.instanceId).not.toBe(second.instanceId);
  });

  it("round-trips the pointer through persistence", () => {
    const ref = makeManagedCommandOutputTileRef({
      commandId: COMMAND,
      hostId: HOST,
    });

    const restored = parseTileRef(serializeTileRef(ref));

    expect(restored).toEqual({
      id: COMMAND,
      instanceId: ref.instanceId,
      type: "managed-command-output",
      name: MANAGED_COMMAND_OUTPUT_TILE_NAME,
      hostId: HOST,
    });
  });

  it("drops command state a persisted tile should never have carried", () => {
    const restored = parseTileRef({
      id: COMMAND,
      instanceId: "tab-1",
      type: "managed-command-output",
      hostId: HOST,
      monitoring: true,
      description: "deploy watcher",
      command: "tail -f deploy.log",
      cwd: "/work/repo",
      cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
      status: { state: "running", pid: 4410, startedAtMs: 1 },
      name: "Shell · deploy watcher",
    });

    // The label falls back to the generic constant: a persisted title would
    // be a second source of truth for something the stream already answers.
    expect(restored).toEqual({
      id: COMMAND,
      instanceId: "tab-1",
      type: "managed-command-output",
      name: MANAGED_COMMAND_OUTPUT_TILE_NAME,
      hostId: HOST,
    });
  });

  it("refuses a tile with no host to bind to", () => {
    expect(
      parseTileRef({
        id: COMMAND,
        instanceId: "tab-1",
        type: "managed-command-output",
      }),
    ).toBeNull();
  });
});
