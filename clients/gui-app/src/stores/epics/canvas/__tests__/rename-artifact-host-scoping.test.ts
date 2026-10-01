/**
 * `renameArtifactInTab` / `renameArtifact` take a fourth `hostId: string |
 * null` and must scope BOTH writes they perform - the open tile
 * (`tilesByInstanceId`) and the epic's own tree record
 * (`artifactTreeByEpicId`) - to that host. A cross-host id collision (a
 * host-minted id is unique per host, not globally - see `tileHostId` in
 * `actions.ts`) is the sharpest case: renaming host B's row must never touch
 * host A's row that happens to share the same content id.
 *
 * `hostId: null` is the reserved case for a shared, not-host-bound document
 * edit and must keep renaming by id alone, regardless of a matching row's
 * own host - the pre-existing behavior this parameter preserves.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import type { EpicNodeRecord } from "@/lib/artifacts/node-display";

const EPIC_ID = "epic-rename-host-scoping";
const HOST_A = "host-A";
const HOST_B = "host-B";
const SHARED_CHAT_ID = "chat-shared-id";

function chatTile(hostId: string, instanceId: string): EpicNodeRef {
  return {
    id: SHARED_CHAT_ID,
    instanceId,
    type: "chat",
    name: `Chat on ${hostId}`,
    hostId,
  };
}

function chatRecord(hostId: string, name: string): EpicNodeRecord {
  return { id: SHARED_CHAT_ID, parentId: null, name, type: "chat", hostId };
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("renameArtifactInTab host scoping", () => {
  it("renames only the named host's tile and tree record, leaving the same-id row on another host untouched", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(EPIC_ID, "Tab");
    store.openTileInTab(tabId, chatTile(HOST_A, "inst-a"));
    store.openTileInTab(tabId, chatTile(HOST_B, "inst-b"));
    useEpicCanvasStore.setState((state) => ({
      artifactTreeByEpicId: {
        ...state.artifactTreeByEpicId,
        [EPIC_ID]: [
          chatRecord(HOST_A, "Chat on host-A"),
          chatRecord(HOST_B, "Chat on host-B"),
        ],
      },
    }));

    useEpicCanvasStore
      .getState()
      .renameArtifactInTab(tabId, SHARED_CHAT_ID, "Renamed on B", HOST_B);

    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    expect(canvas?.tilesByInstanceId["inst-b"]?.name).toBe("Renamed on B");
    expect(canvas?.tilesByInstanceId["inst-a"]?.name).toBe("Chat on host-A");

    const records = useEpicCanvasStore.getState().artifactTreeByEpicId[EPIC_ID];
    expect(records?.find((r) => r.hostId === HOST_B)?.name).toBe(
      "Renamed on B",
    );
    expect(records?.find((r) => r.hostId === HOST_A)?.name).toBe(
      "Chat on host-A",
    );
  });

  it("renames a null-scoped (shared document) row by id alone, regardless of the row's own host", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(EPIC_ID, "Tab");
    store.openTileInTab(tabId, chatTile(HOST_A, "inst-a"));
    useEpicCanvasStore.setState((state) => ({
      artifactTreeByEpicId: {
        ...state.artifactTreeByEpicId,
        [EPIC_ID]: [chatRecord(HOST_A, "Chat on host-A")],
      },
    }));

    useEpicCanvasStore
      .getState()
      .renameArtifactInTab(tabId, SHARED_CHAT_ID, "Renamed shared", null);

    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    expect(canvas?.tilesByInstanceId["inst-a"]?.name).toBe("Renamed shared");
    expect(
      useEpicCanvasStore.getState().artifactTreeByEpicId[EPIC_ID]?.[0]?.name,
    ).toBe("Renamed shared");
  });
});
