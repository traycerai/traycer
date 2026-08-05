import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import {
  CHATS_TREE_FILTER,
  collectVisibleSidebarTreeIds,
  combineSidebarVisibleIds,
  sidebarTreeRootIds,
  useSidebarArchiveHiddenIds,
  useSidebarChatOrder,
} from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { useEpicTreeIndex } from "@/lib/epic-selectors";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";

const EPIC_ID = "epic-chat-order";
const AGENT_ID = "agent-parent";
const NESTED_UNDER_AGENT_ID = "chat-under-agent";
const ARCHIVED_PARENT_ID = "chat-archived-parent";
const LIVE_CHILD_ID = "chat-live-child";
const PLAIN_ID = "chat-plain";

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Chat order",
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

function chat(
  id: string,
  parentId: string | null,
  archivedAt: number | null,
): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("title", id);
  entry.set("parentId", parentId);
  entry.set("createdAt", 1);
  entry.set("updatedAt", 1);
  entry.set("hostId", "host-a");
  entry.set("archivedAt", archivedAt);
  entry.set("messages", new Y.Array<unknown>());
  return entry;
}

function terminalAgent(id: string): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("harnessId", "codex");
  entry.set("title", id);
  entry.set("parentId", null);
  entry.set("createdAt", 1);
  entry.set("updatedAt", 1);
  entry.set("userId", "user-1");
  entry.set("hostId", "host-a");
  entry.set("workspaceFolders", ["/repo"]);
  entry.set("model", null);
  entry.set("reasoningEffort", null);
  entry.set("agentMode", "regular");
  entry.set("harnessSessionId", null);
  entry.set("terminalShellCommand", null);
  entry.set("terminalShellArgs", null);
  return entry;
}

/**
 * The two shapes the send-to-chat picker used to get wrong, in one tree:
 * a chat nested under a terminal agent (a chat-rooted walk never reaches it)
 * and a live chat under an archived parent (the sidebar hides the whole
 * subtree; a per-row `archivedAt` check offers the child anyway).
 */
function seedDoc(doc: Y.Doc): void {
  const chats = new Y.Map<unknown>();
  chats.set(NESTED_UNDER_AGENT_ID, chat(NESTED_UNDER_AGENT_ID, AGENT_ID, null));
  chats.set(ARCHIVED_PARENT_ID, chat(ARCHIVED_PARENT_ID, null, 2));
  chats.set(LIVE_CHILD_ID, chat(LIVE_CHILD_ID, ARCHIVED_PARENT_ID, null));
  chats.set(PLAIN_ID, chat(PLAIN_ID, null, null));
  const tuiAgents = new Y.Map<unknown>();
  tuiAgents.set(AGENT_ID, terminalAgent(AGENT_ID));
  const epic = doc.getMap("epic");
  epic.set("title", "Chat order");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", tuiAgents);
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
    userId: "user-1",
    onAuthError: null,
  });
  if (captured.value === null) throw new Error("stream factory not invoked");
  const donor = new Y.Doc();
  seedDoc(donor);
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(donor));
  donor.destroy();
  return handle;
}

/**
 * Renders the picker's order beside the rows the chats sidebar would render
 * from the same tree, so the assertion can be the real invariant - the picker
 * offers exactly the sidebar's chat rows - rather than a hand-copied list that
 * would keep passing if the two implementations drifted apart again.
 */
function ChatOrderProbe() {
  const chatOrder = useSidebarChatOrder(EPIC_ID);
  const tree = useEpicTreeIndex();
  const archiveHiddenIds = useSidebarArchiveHiddenIds(EPIC_ID);
  const sidebarRows = useMemo(
    () =>
      collectVisibleSidebarTreeIds({
        rootIds: sidebarTreeRootIds({
          tree,
          treeFilter: CHATS_TREE_FILTER,
          comparator: null,
        }).filter((id) => !archiveHiddenIds.has(id)),
        // The picker flattens, so compare against a fully expanded panel.
        expandedIds: new Set(Object.keys(tree.nodeById)),
        tree,
        treeFilter: CHATS_TREE_FILTER,
        emitFilter: CHATS_TREE_FILTER,
        visibleIds: combineSidebarVisibleIds(null, archiveHiddenIds, tree),
        comparator: null,
      }),
    [archiveHiddenIds, tree],
  );

  return (
    <>
      <output data-testid="chat-order">{chatOrder.join(",")}</output>
      <output data-testid="sidebar-chat-rows">
        {sidebarRows
          .filter((id) => tree.nodeById[id].type === "chat")
          .join(",")}
      </output>
    </>
  );
}

afterEach(() => {
  cleanup();
});

describe("useSidebarChatOrder", () => {
  it("offers exactly the chats the sidebar shows", async () => {
    const handle = createSession();
    const view = render(
      <EpicSessionContext.Provider value={handle}>
        <ChatOrderProbe />
      </EpicSessionContext.Provider>,
    );
    try {
      await waitFor(() => {
        expect(screen.getByTestId("chat-order").textContent).not.toBe("");
      });
      const chatOrder = screen.getByTestId("chat-order").textContent;

      // A chat parented to a terminal agent is a real send target: the agent
      // is walked through, and only the agent itself is left out.
      expect(chatOrder).toContain(NESTED_UNDER_AGENT_ID);
      expect(chatOrder).not.toContain(AGENT_ID);
      // An archived parent hides its whole subtree, so the live child under it
      // is not offered either - the sidebar has no row for it to point at.
      expect(chatOrder).not.toContain(ARCHIVED_PARENT_ID);
      expect(chatOrder).not.toContain(LIVE_CHILD_ID);
      expect(chatOrder).toContain(PLAIN_ID);

      expect(chatOrder).toBe(
        screen.getByTestId("sidebar-chat-rows").textContent,
      );
    } finally {
      view.unmount();
      handle.dispose();
    }
  });
});
