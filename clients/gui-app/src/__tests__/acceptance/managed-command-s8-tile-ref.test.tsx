/**
 * Independent acceptance suite — seam S8 (GUI half).
 *
 * S8 pins the output window's persisted shape to what `UI.md` §9a promises:
 * a renderer-local pointer of exactly `{ id: commandId, instanceId, type,
 * hostId }`, with kind/description/status re-read live on restore, and
 * NOTHING written to the epic doc. The key-set assertion is the fence that
 * keeps state from creeping into storage later.
 *
 * S9's GUI half (CPU/mem readout chips on the Shells menu rows) went with the
 * menu itself (product decision, 2026-08-15): the shell's readout now lives on
 * its owner row in the Resource Monitor. The old-peer fold and its frame
 * invariant are still proven host-side in
 * `traycer-host/.../managed-command-ui-acceptance.test.ts` (S9a-c).
 */
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  makeManagedCommandOutputTileRef,
  managedCommandOutputTileSchema,
} from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";
import { TILE_KIND_MANAGED_COMMAND_OUTPUT } from "@/stores/epics/canvas/tile-kinds";

const EPIC_ID = "epic-s8";
const TAB_ID = "tab-s8";
const HOST_ID = "host-1";

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let epicHandle: OpenEpicStoreHandle | null = null;

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic" } },
    openTabOrder: [TAB_ID],
    activeTabId: TAB_ID,
  });
});

afterEach(() => {
  cleanup();
  epicHandle?.dispose();
  epicHandle = null;
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("S8 · tile-ref minimalism", () => {
  it("S8a: the persisted ref is exactly { id: commandId, instanceId, type, hostId } — nothing else can ride along", () => {
    const ref = makeManagedCommandOutputTileRef({
      commandId: "cmd-pin",
      hostId: HOST_ID,
    });
    const persisted = managedCommandOutputTileSchema.serialize(ref);
    if (persisted === null || typeof persisted !== "object") {
      throw new Error("expected an object");
    }
    // UI.md §9a pins this exact key set.
    expect(Object.keys(persisted).sort()).toEqual([
      "hostId",
      "id",
      "instanceId",
      "type",
    ]);
    expect(persisted).toMatchObject({
      id: "cmd-pin",
      type: TILE_KIND_MANAGED_COMMAND_OUTPUT,
      hostId: HOST_ID,
    });
  });

  it("S8b: state smuggled into storage is dropped on parse — kind, description and status stay live-only", () => {
    const parsed = managedCommandOutputTileSchema.parse({
      id: "cmd-creep",
      instanceId: "instance-1",
      type: TILE_KIND_MANAGED_COMMAND_OUTPUT,
      hostId: HOST_ID,
      // The creep §9a rules out — none of it may survive a round-trip.
      monitoring: true,
      description: "deploy watcher",
      command: "tail -f deploy.log",
      cwd: "/work/repo",
      cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
      status: { state: "running", pid: 4410 },
      name: "Shell · deploy watcher",
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) throw new Error("unreachable");
    const reserialized = managedCommandOutputTileSchema.serialize(parsed);
    if (reserialized === null || typeof reserialized !== "object") {
      throw new Error("expected an object");
    }
    expect(Object.keys(reserialized).sort()).toEqual([
      "hostId",
      "id",
      "instanceId",
      "type",
    ]);
  });

  it("S8c: a ref that lost its command or host is rejected, not defaulted", () => {
    expect(
      managedCommandOutputTileSchema.parse({
        instanceId: "instance-1",
        type: TILE_KIND_MANAGED_COMMAND_OUTPUT,
        hostId: HOST_ID,
      }),
    ).toBeNull();
    expect(
      managedCommandOutputTileSchema.parse({
        id: "cmd-x",
        instanceId: "instance-1",
        type: TILE_KIND_MANAGED_COMMAND_OUTPUT,
        hostId: "",
      }),
    ).toBeNull();
  });

  it("S8d: opening an output window writes nothing to the epic doc", () => {
    epicHandle = createOpenEpicStore({
      epicId: EPIC_ID,
      streamClientFactory: noopEpicStreamClientFactory,
      userId: null,
      onAuthError: null,
    });
    let docUpdates = 0;
    epicHandle.doc.on("update", () => {
      docUpdates += 1;
    });

    useEpicCanvasStore.getState().openTileInTab(
      TAB_ID,
      makeManagedCommandOutputTileRef({
        commandId: "cmd-doc",
        hostId: HOST_ID,
      }),
    );

    // The window exists on the canvas…
    const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
    const tiles = Object.values(canvas?.tilesByInstanceId ?? {});
    expect(tiles.some((ref) => ref !== undefined && ref.id === "cmd-doc")).toBe(
      true,
    );
    // …and the epic doc never heard about it (UI.md §9a: zero protocol /
    // persistence surface; invisible to other users by construction).
    expect(docUpdates).toBe(0);
  });
});
