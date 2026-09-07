/**
 * Output-window persisted shape is `{ id, instanceId, type, hostId }` only. Nothing is written to the epic doc.
 */
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
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

let epicHandle: OpenedStoreForTest | null = null;

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
    epicHandle = openStoreForTest({
      epicId: EPIC_ID,
      userId: null,
      // Factories go to the composition; createOpenEpicStore no longer builds a
      // runtime. handle.doc still resolves because this harness builds it here.
      factories: {
        streamClientFactory: noopEpicStreamClientFactory,
        laneSelection: null,
      },
      // Explicit: `null` means this suite never writes, so a write in
      // one that said so fails rather than resolving quietly.
      writeCommand: null,
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
