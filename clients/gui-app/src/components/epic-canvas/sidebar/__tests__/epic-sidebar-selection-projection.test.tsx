import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useMemo, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import {
  SidebarBulkSelectionProvider,
  sidebarIdsWithinRoots,
  useSidebarBulkSelection,
} from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { useEpicArchivedNodeIds, useEpicTreeIndex } from "@/lib/epic-selectors";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";

const EPIC_ID = "epic-selection-projection";
const ROOT_ID = "chat-root";
const PEER_ID = "chat-peer";

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Selection projection",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "user",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

function chat(id: string, parentId: string | null): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("title", id);
  entry.set("parentId", parentId);
  entry.set("createdAt", 1);
  entry.set("updatedAt", 1);
  entry.set("hostId", "host-a");
  entry.set("messages", new Y.Array<unknown>());
  return entry;
}

function seedDoc(doc: Y.Doc): void {
  const chats = new Y.Map<unknown>();
  chats.set(ROOT_ID, chat(ROOT_ID, null));
  chats.set(PEER_ID, chat(PEER_ID, null));
  const epic = doc.getMap("epic");
  epic.set("title", "Selection projection");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", chats);
}

function createSession(): OpenEpicStoreHandle {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_epicId, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: factory,
    userId: null,
    onAuthError: null,
  });
  if (captured.value === null) throw new Error("stream factory not invoked");
  const donor = new Y.Doc();
  seedDoc(donor);
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(donor));
  donor.destroy();
  return handle;
}

function ProjectionSelectionProbe() {
  const tree = useEpicTreeIndex();
  const archivedIds = useEpicArchivedNodeIds();
  const selection = useSidebarBulkSelection();
  const [peerHidden, setPeerHidden] = useState(false);
  const hiddenIds = useMemo(
    () =>
      new Set(
        sidebarIdsWithinRoots({
          ids: Object.keys(tree.nodeById),
          rootIds: archivedIds,
          tree,
        }),
      ),
    [archivedIds, tree],
  );
  const selectableIds = useMemo(
    () =>
      Object.keys(tree.nodeById).filter((id) => {
        if (peerHidden && id === PEER_ID) return false;
        const type = tree.nodeById[id].type;
        return (
          (type === "chat" || type === "terminal-agent") && !hiddenIds.has(id)
        );
      }),
    [hiddenIds, peerHidden, tree],
  );
  const setSelectableIds = selection.setSelectableIds;
  useEffect(() => {
    setSelectableIds(selectableIds);
  }, [selectableIds, setSelectableIds]);

  return (
    <>
      <button type="button" onClick={selection.enterSelectionMode}>
        Enter selection
      </button>
      <button type="button" onClick={() => selection.toggleSelection(ROOT_ID)}>
        Select root
      </button>
      <button type="button" onClick={() => selection.toggleSelection(PEER_ID)}>
        Select peer
      </button>
      <button
        type="button"
        onClick={() => {
          selection.clearSelectedIds([ROOT_ID]);
          selection.armSelectablePruneExit([ROOT_ID]);
        }}
      >
        Settle archive response
      </button>
      <button type="button" onClick={() => setPeerHidden(true)}>
        Hide peer
      </button>
      <output data-testid="selection-mode">
        {selection.selectionMode ? "selecting" : "idle"}
      </output>
      <output data-testid="selected-count">{selection.selectedCount}</output>
      <output data-testid="selectable-count">
        {selection.selectableIds.length}
      </output>
    </>
  );
}

function projectArchivedReparent(handle: OpenEpicStoreHandle): void {
  const chats: unknown = handle.doc.getMap("epic").get("chats");
  if (!(chats instanceof Y.Map)) throw new Error("expected chats map");
  const root: unknown = chats.get(ROOT_ID);
  if (!(root instanceof Y.Map)) throw new Error("expected root chat");
  const peer: unknown = chats.get(PEER_ID);
  if (!(peer instanceof Y.Map)) throw new Error("expected peer chat");
  handle.doc.transact(() => {
    peer.set("parentId", ROOT_ID);
    root.set("archivedAt", 2);
  });
}

function projectArchivedRoot(handle: OpenEpicStoreHandle): void {
  const chats: unknown = handle.doc.getMap("epic").get("chats");
  if (!(chats instanceof Y.Map)) throw new Error("expected chats map");
  const root: unknown = chats.get(ROOT_ID);
  if (!(root instanceof Y.Map)) throw new Error("expected root chat");
  root.set("archivedAt", 2);
}

afterEach(() => {
  cleanup();
});

describe("sidebar selection projection reconciliation", () => {
  it("exits after a later archive projection prunes the last selected row", async () => {
    const handle = createSession();
    const view = render(
      <EpicSessionContext.Provider value={handle}>
        <SidebarBulkSelectionProvider panelId="chats" collapsed={false}>
          <ProjectionSelectionProbe />
        </SidebarBulkSelectionProvider>
      </EpicSessionContext.Provider>,
    );
    try {
      await waitFor(() => {
        expect(screen.getByTestId("selectable-count").textContent).toBe("2");
      });
      fireEvent.click(screen.getByRole("button", { name: "Enter selection" }));
      fireEvent.click(screen.getByRole("button", { name: "Select root" }));
      fireEvent.click(screen.getByRole("button", { name: "Select peer" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Settle archive response" }),
      );
      expect(screen.getByTestId("selection-mode").textContent).toBe(
        "selecting",
      );
      expect(screen.getByTestId("selected-count").textContent).toBe("1");

      act(() => {
        projectArchivedReparent(handle);
      });

      await waitFor(() => {
        expect(screen.getByTestId("selectable-count").textContent).toBe("0");
        expect(screen.getByTestId("selected-count").textContent).toBe("0");
        expect(screen.getByTestId("selection-mode").textContent).toBe("idle");
      });
    } finally {
      view.unmount();
      handle.dispose();
    }
  });

  it("does not let a settled archive projection exit a later unrelated prune", async () => {
    const handle = createSession();
    const view = render(
      <EpicSessionContext.Provider value={handle}>
        <SidebarBulkSelectionProvider panelId="chats" collapsed={false}>
          <ProjectionSelectionProbe />
        </SidebarBulkSelectionProvider>
      </EpicSessionContext.Provider>,
    );
    try {
      await waitFor(() => {
        expect(screen.getByTestId("selectable-count").textContent).toBe("2");
      });
      fireEvent.click(screen.getByRole("button", { name: "Enter selection" }));
      fireEvent.click(screen.getByRole("button", { name: "Select root" }));
      fireEvent.click(screen.getByRole("button", { name: "Select peer" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Settle archive response" }),
      );

      act(() => {
        projectArchivedRoot(handle);
      });

      await waitFor(() => {
        expect(screen.getByTestId("selectable-count").textContent).toBe("1");
        expect(screen.getByTestId("selected-count").textContent).toBe("1");
        expect(screen.getByTestId("selection-mode").textContent).toBe(
          "selecting",
        );
      });

      fireEvent.click(screen.getByRole("button", { name: "Hide peer" }));

      await waitFor(() => {
        expect(screen.getByTestId("selectable-count").textContent).toBe("0");
        expect(screen.getByTestId("selected-count").textContent).toBe("0");
        expect(screen.getByTestId("selection-mode").textContent).toBe(
          "selecting",
        );
      });
    } finally {
      view.unmount();
      handle.dispose();
    }
  });
});
