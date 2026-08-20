import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_ARTIFACT_DND_TYPE,
  SIDEBAR_NODE_DND_TYPE,
  type EpicCanvasChatArtifactDragData,
  type EpicCanvasSidebarNodeDragData,
} from "@/components/epic-canvas/dnd/dnd";
import {
  canDropOnHeaderStrip,
  sourceToTileRef,
} from "@/components/epic-canvas/dnd/root-dnd-commits";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
} from "@/stores/epics/open-epic/store";
import type { ChatProjection } from "@/stores/epics/open-epic/types";

const CHAT_ARTIFACT_SOURCE: EpicCanvasChatArtifactDragData = {
  kind: CHAT_ARTIFACT_DND_TYPE,
  epicId: "epic-1",
  viewTabId: "tab-1",
  artifact: {
    id: "artifact-1",
    type: "ticket",
    name: "Fix resolution",
    hostId: "host-1",
  },
};

describe("sourceToTileRef - chat-artifact branch", () => {
  it("maps artifact identity to the expected EpicArtifactRef fields", () => {
    const ref = sourceToTileRef(CHAT_ARTIFACT_SOURCE);
    expect(ref).not.toBeNull();
    expect(ref).toMatchObject({
      id: "artifact-1",
      type: "ticket",
      name: "Fix resolution",
      hostId: "host-1",
    });
    expect(ref === null ? "" : ref.instanceId).not.toBe("");
  });

  it("mints a fresh instanceId on every call (C2)", () => {
    const first = sourceToTileRef(CHAT_ARTIFACT_SOURCE);
    const second = sourceToTileRef(CHAT_ARTIFACT_SOURCE);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const firstInstanceId = first === null ? "a" : first.instanceId;
    const secondInstanceId = second === null ? "b" : second.instanceId;
    expect(firstInstanceId).not.toBe(secondInstanceId);
  });
});

describe("canDropOnHeaderStrip - chat-artifact", () => {
  it("accepts a chat-artifact source so the header tab strip is not a dead zone", () => {
    // Collision already offers chat-artifact the header slot (top priority), so
    // this predicate must accept it - otherwise the header strip previews and
    // commits nothing, unlike the sibling sidebar-node / workspace-file sources.
    expect(canDropOnHeaderStrip(CHAT_ARTIFACT_SOURCE)).toBe(true);
  });

  it("rejects a null source", () => {
    expect(canDropOnHeaderStrip(null)).toBe(false);
  });
});

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

const SIDEBAR_CHAT: ChatProjection = {
  id: "chat-1",
  title: "Chat one",
  parentId: null,
  createdAt: 1,
  updatedAt: 1,
  userId: null,
  hostId: null,
  isTitleEditedByUser: false,
  settings: null,
  archivedAt: null,
};

describe("sourceToTileRef - sidebar-node branch", () => {
  afterEach(() => {
    __getOpenEpicRegistryForTests().disposeAll();
  });

  it("mints the ref against the payload's bound host, not the app-wide one", () => {
    // Chats and artifacts carry no intrinsic host id, so the fallback IS the
    // tile's host for life: the root DndContext mounts at the app shell, so
    // during an A->B re-point the app-wide client already answers B while the
    // dragged row still belongs to the A-backed Epic. `sourceToTileRef` used
    // to resolve that fallback from the app-wide active host instead of
    // `source.hostId` (the payload's bound host, stamped by the sidebar
    // producers from the Epic SESSION host) - in a test environment with no
    // app host client mounted, that fallback resolves to
    // `UNKNOWN_HOST_PLACEHOLDER`, which is exactly what this arm rules out.
    const registry = __getOpenEpicRegistryForTests();
    const handle = createOpenEpicStore({
      epicId: "epic-dnd",
      streamClientFactory: noopStreamClientFactory,
      userId: null,
      onAuthError: null,
    });
    handle.store.setState((s) => ({
      chats: {
        byId: { ...s.chats.byId, "chat-1": SIDEBAR_CHAT },
        allIds: [...s.chats.allIds, "chat-1"],
      },
    }));
    registry.acquireMounted("epic-dnd", () => handle);

    const source: EpicCanvasSidebarNodeDragData = {
      kind: SIDEBAR_NODE_DND_TYPE,
      epicId: "epic-dnd",
      viewTabId: "tab-1",
      hostId: "host-a",
      nodeId: "chat-1",
    };
    const ref = sourceToTileRef(source);

    expect(ref).not.toBeNull();
    expect(ref === null ? "" : ref.hostId).toBe("host-a");
    expect(ref === null ? "" : ref.hostId).not.toBe(UNKNOWN_HOST_PLACEHOLDER);
  });
});
