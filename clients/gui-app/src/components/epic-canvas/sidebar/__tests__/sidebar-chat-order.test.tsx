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
import {
  EpicSessionContext,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import { useEpicTreeIndex } from "@/lib/epic-selectors";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

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

function createSession(): OpenedStoreForTest {
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
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: "user-1",
    // The factories go to the COMPOSITION now, not the store:
    // `createOpenEpicStore` stopped constructing a runtime, so a
    // suite that used to hand it a `streamClientFactory` has nothing
    // to hand it. `handle.doc` still resolves because this harness
    // builds the runtime in THIS thread.
    factories: {
      streamClientFactory: factory,
      laneSelection: null,
    },
    // Explicit: `null` means this suite never writes, so a write in
    // one that said so fails rather than resolving quietly.
    writeCommand: null,
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
          clock: null,
        }).filter((id) => !archiveHiddenIds.has(id)),
        // The picker flattens, so compare against a fully expanded panel.
        expandedIds: new Set(Object.keys(tree.nodeById)),
        tree,
        treeFilter: CHATS_TREE_FILTER,
        emitFilter: CHATS_TREE_FILTER,
        visibleIds: combineSidebarVisibleIds(null, archiveHiddenIds, tree),
        comparator: null,
        clock: null,
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

/**
 * The picker follows the publication clock, at BOTH tree levels.
 *
 * The send-to-chat picker is reached from a terminal quote, an artifact quote
 * and a browser annotation - none of them inside a chat panel - so it has no
 * `SidebarSortClockContext` to read and used to sort on the projection's raw
 * `updatedAt`. For a FOREIGN row that stamp is a metadata timestamp a
 * publication never moves, so a collaborator's chat that had just streamed a
 * turn stayed wherever its last rename left it, one or more places off the
 * order the sidebar renders.
 *
 * `useEpicChatSortClock` derives the same clock the panel publishes from the
 * same store inputs. The head arrives on `chatRecordHeads`, which the record
 * stream feeds - so this is the head-only delta case end to end: nothing about
 * the row's METADATA moves, and the order still changes.
 */
const SESSION_HOST_ID = "host-a";
const PICKER_FOREIGN_HOST_ID = "host-b";
const OLDER_ROOT_ID = "chat-foreign-older";
const NEWER_ROOT_ID = "chat-foreign-newer";
const OLDER_CHILD_ID = "chat-foreign-child-older";
const NEWER_CHILD_ID = "chat-foreign-child-newer";
const PARENT_ID = "chat-local-parent";

function foreignChat(id: string, parentId: string | null, updatedAt: number) {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("title", id);
  entry.set("parentId", parentId);
  entry.set("createdAt", 1);
  // The metadata stamp. A publication does not move it, which is the whole
  // reason this row needs a clock.
  entry.set("updatedAt", updatedAt);
  entry.set("hostId", PICKER_FOREIGN_HOST_ID);
  entry.set("archivedAt", null);
  entry.set("messages", new Y.Array<unknown>());
  return entry;
}

function seedForeignDoc(doc: Y.Doc): void {
  const chats = new Y.Map<unknown>();
  chats.set(NEWER_ROOT_ID, foreignChat(NEWER_ROOT_ID, null, 200));
  chats.set(OLDER_ROOT_ID, foreignChat(OLDER_ROOT_ID, null, 100));
  // A local parent so the nested pair is walked as CHILDREN - the level
  // `collectVisibleSidebarTreeIds` orders, which is a different call from the
  // one that orders roots.
  const parent = new Y.Map<unknown>();
  parent.set("id", PARENT_ID);
  parent.set("title", PARENT_ID);
  parent.set("parentId", null);
  parent.set("createdAt", 1);
  parent.set("updatedAt", 300);
  parent.set("hostId", SESSION_HOST_ID);
  parent.set("archivedAt", null);
  parent.set("messages", new Y.Array<unknown>());
  chats.set(PARENT_ID, parent);
  chats.set(NEWER_CHILD_ID, foreignChat(NEWER_CHILD_ID, PARENT_ID, 200));
  chats.set(OLDER_CHILD_ID, foreignChat(OLDER_CHILD_ID, PARENT_ID, 100));
  const epic = doc.getMap("epic");
  epic.set("title", "Chat order");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("chats", chats);
}

function createForeignSession(): OpenedStoreForTest {
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
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: "user-1",
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("stream factory not invoked");
  // What `epic-session-provider.tsx` stamps in production. Without it
  // `useEpicSessionHostId` reads `null`, every row reads as own-host, and the
  // clock is empty - so this registration is what makes the test non-vacuous.
  handleHostIds.set(handle, SESSION_HOST_ID);
  const donor = new Y.Doc();
  seedForeignDoc(donor);
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(donor));
  donor.destroy();
  return handle;
}

function PickerOrderProbe() {
  return (
    <output data-testid="chat-order">
      {useSidebarChatOrder(EPIC_ID).join(",")}
    </output>
  );
}

function publishHead(
  handle: OpenedStoreForTest,
  chatId: string,
  parentChatId: string | null,
  publishedAt: number,
): void {
  handle.store.getState().applyChatRecordDelta({
    kind: "upsert",
    epicId: EPIC_ID,
    record: {
      chatId,
      ownerUserId: "user-1",
      originHostId: PICKER_FOREIGN_HOST_ID,
      title: chatId,
      isTitleEditedByUser: false,
      // The row's REAL parent. Passing `null` here would reparent the chat to
      // a root, and a clocked root sort would then float it for a reason that
      // has nothing to do with the level under test - which is exactly what
      // an ablation of the child-level clock caught.
      parentChatId,
      createdAt: 1,
      // Unchanged from the doc entry: this is a HEAD-ONLY delta, so nothing
      // the metadata guard orders by has moved.
      updatedAt: 100,
      archived: false,
      archivedAt: null,
      runSettingsSummary: "claude",
      revision: 1,
      visibility: "task",
      origin: "foreign",
      head: {
        headSha256: "a".repeat(64),
        throughRecordSeq: 1,
        publishedAt,
      },
    },
  });
}

describe("useSidebarChatOrder follows the record head's publishedAt", () => {
  it("floats a foreign ROOT above its newer-stamped sibling on a head-only delta", async () => {
    const handle = createForeignSession();
    const view = render(
      <EpicSessionContext.Provider value={handle}>
        <PickerOrderProbe />
      </EpicSessionContext.Provider>,
    );
    try {
      await waitFor(() => {
        expect(screen.getByTestId("chat-order").textContent).toContain(
          OLDER_ROOT_ID,
        );
      });
      const before = screen.getByTestId("chat-order").textContent;
      // Metadata order: the newer stamp leads.
      expect(before.indexOf(NEWER_ROOT_ID)).toBeLessThan(
        before.indexOf(OLDER_ROOT_ID),
      );

      publishHead(handle, OLDER_ROOT_ID, null, 900);

      await waitFor(() => {
        const after = screen.getByTestId("chat-order").textContent;
        expect(after.indexOf(OLDER_ROOT_ID)).toBeLessThan(
          after.indexOf(NEWER_ROOT_ID),
        );
      });
    } finally {
      view.unmount();
      handle.dispose();
    }
  });

  it("floats a foreign CHILD above its newer-stamped sibling too", async () => {
    // The second ordering call: roots and children are sorted by different
    // functions, and clocking only one leaves the list half-corrected.
    const handle = createForeignSession();
    const view = render(
      <EpicSessionContext.Provider value={handle}>
        <PickerOrderProbe />
      </EpicSessionContext.Provider>,
    );
    try {
      await waitFor(() => {
        expect(screen.getByTestId("chat-order").textContent).toContain(
          OLDER_CHILD_ID,
        );
      });
      const before = screen.getByTestId("chat-order").textContent;
      expect(before.indexOf(NEWER_CHILD_ID)).toBeLessThan(
        before.indexOf(OLDER_CHILD_ID),
      );

      publishHead(handle, OLDER_CHILD_ID, PARENT_ID, 900);

      await waitFor(() => {
        const after = screen.getByTestId("chat-order").textContent;
        expect(after.indexOf(OLDER_CHILD_ID)).toBeLessThan(
          after.indexOf(NEWER_CHILD_ID),
        );
      });
    } finally {
      view.unmount();
      handle.dispose();
    }
  });
});
