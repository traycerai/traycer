import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { act } from "react";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

const rowRenders = vi.hoisted(() => new Map<string, number>());

/**
 * The faked boundary, and only it: this suite stands up no host, so the two host-RPC seams the chat panel reaches through answer "no host".
 * `useHostClientForHostId` returns `HostClient | null` in production and both consumers here - the panel's indicator layer and a row's worktree tooltip - already handle `null`, so `null` is a value the tree is built for rather than a shape invented for the test.
 */
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-client-for-host-id")
    >();
  return { ...actual, useHostClientForHostId: () => null };
});

/**
 * Stubbed at the hook rather than seam by seam, which is both where its own suite stubs it (`worktree-owner-metadata-error-plumbing`) and the only boundary that does not move again when it grows a fourth read.
 * HOISTED and frozen for the same reason as the indicator query below: a result object minted per render would be a fresh prop on every row and indistinguishable from the churn this suite counts.
 */
const OWNER_PR_REFERENCES = vi.hoisted(() =>
  Object.freeze({
    references: [],
    isPending: false,
    error: false,
    sendRefresh: () => undefined,
  }),
);
vi.mock("@/hooks/pr/use-owner-pr-references", () => ({
  useOwnerListPrReferences: () => OWNER_PR_REFERENCES,
}));

vi.mock(
  "@/hooks/notifications/use-host-notification-indicators-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/notifications/use-host-notification-indicators-query")
      >();
    const { EMPTY_INDICATOR_STATE_RESPONSE } =
      await import("@/stores/notifications/notification-indicator-state");
    const frozen = {
      data: EMPTY_INDICATOR_STATE_RESPONSE,
      isPending: false,
      isFetching: false,
      error: null,
      refetch: (): Promise<void> => Promise.resolve(),
    } as const;
    return { ...actual, useHostNotificationIndicators: () => frozen };
  },
);

vi.mock(
  "@/components/epic-canvas/sidebar/epic-sidebar-filter",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/epic-canvas/sidebar/epic-sidebar-filter")
      >();
    return {
      ...actual,
      // Counts, then delegates - every `ChatNode` calls this once per render.
      useFilteredPanelChildIds: (
        parentId: string,
        treeFilter: (type: string | null | undefined) => boolean,
      ): readonly string[] => {
        rowRenders.set(parentId, (rowRenders.get(parentId) ?? 0) + 1);
        return actual.useFilteredPanelChildIds(parentId, treeFilter);
      },
    };
  },
);

const EPIC_ID = "epic-chat-row-node-churn";
const TAB_ID = "tab-chat-row";
const USER_ID = "user-1";
const ROW_IDS: readonly string[] = Array.from(
  { length: 40 },
  (_unused, index) => `chat-${index + 1}`,
);
const BUMPED_IDS: readonly string[] = ROW_IDS.slice(0, 12);

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Chat row node churn",
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

function chatEntry(id: string, updatedAt: number): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("title", `Chat ${id}`);
  entry.set("parentId", null);
  entry.set("createdAt", 1);
  entry.set("updatedAt", updatedAt);
  entry.set("hostId", "host-a");
  entry.set("archivedAt", null);
  entry.set("messages", new Y.Array<unknown>());
  return entry;
}

/** `updatedAt` per id; anything absent keeps the seed value. */
function seedDoc(updatedAtById: ReadonlyMap<string, number>): Uint8Array {
  const donor = new Y.Doc();
  const epic = donor.getMap<unknown>("epic");
  const chats = new Y.Map<unknown>();
  for (const id of ROW_IDS) {
    chats.set(id, chatEntry(id, updatedAtById.get(id) ?? 1));
  }
  epic.set("title", "Chat row node churn");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", chats);
  return Y.encodeStateAsUpdate(donor);
}

interface OpenedSession {
  readonly handle: OpenedStoreForTest;
  readonly callbacks: EpicStreamCallbacks;
}

function chatsMap(handle: OpenedStoreForTest): Y.Map<unknown> {
  const chats = handle.doc.getMap<unknown>("epic").get("chats");
  if (!(chats instanceof Y.Map)) {
    throw new Error("the seeded doc has no chats map");
  }
  return chats;
}

function createSession(): OpenedSession {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
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
    userId: USER_ID,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), seedDoc(new Map()));
  return { handle, callbacks: captured.value };
}

describe("a chat row's tree-node subscription", () => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
    cleanup();
    rowRenders.clear();
  });

  function renderPanel(): OpenedSession {
    const session = createSession();
    opened.push(session.handle);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EpicSessionContext.Provider value={session.handle}>
          <ChatTreePanelBody epicId={EPIC_ID} tabId={TAB_ID} />
        </EpicSessionContext.Provider>
      </QueryClientProvider>,
    );
    for (const id of ROW_IDS) {
      expect(rowRenders.get(id) ?? 0).toBeGreaterThan(0);
    }
    return session;
  }

  /**
   * Each entry is REPLACED by an identical one with a new timestamp, which is what makes the stamp reach the tree at all: `CHAT_TREE_KEYS` is `{parentId, title, createdAt}`, so a bare `entry.set("updatedAt", …)` never sets `structuralTreeDirty` and the node would keep its old value - a pin built on that write would read zero renders whether or not the row is narrowed.
   * The assertions below check that actually happened rather than assuming it.
   */
  function bumpTimestamps(session: OpenedSession, base: number): void {
    act(() => {
      session.handle.doc.transact(() => {
        const chats = chatsMap(session.handle);
        BUMPED_IDS.forEach((id, index) => {
          chats.set(id, chatEntry(id, base + index));
        });
      });
    });
  }

  it("holds the UNTOUCHED rows still when twelve others are stamped", () => {
    const session = renderPanel();
    const before = new Map(rowRenders);
    const titlesBefore = ROW_IDS.map(
      (id) => session.handle.store.getState().tree.nodeById[id].title,
    );

    bumpTimestamps(session, 500);

    // Non-vacuity: the stamps really landed in the TREE (a bare `updatedAt`
    // write would not have reached it) and really left the titles alone.
    const nodesAfter = session.handle.store.getState().tree.nodeById;
    expect(ROW_IDS.map((id) => nodesAfter[id].title)).toEqual(titlesBefore);
    expect(BUMPED_IDS.map((id) => nodesAfter[id].updatedAt)).toEqual(
      BUMPED_IDS.map((_unused, index) => 500 + index),
    );

    // Before these fixes all forty re-rendered - the twelve legitimately, the twenty-eight through three separate whole-slice subscriptions that no prop and no `memo` could stop.
    const rerendered = ROW_IDS.filter(
      (id) =>
        !BUMPED_IDS.includes(id) &&
        (rowRenders.get(id) ?? 0) !== (before.get(id) ?? 0),
    );
    expect({ untouchedThatRerendered: rerendered.length }).toEqual({
      untouchedThatRerendered: 0,
    });
  });

  it("holds a row still when its OWN node re-mints with nothing it renders changed", () => {
    // Under an `updatedAt` bump only the twelve stamped nodes re-mint, and those twelve re-render anyway through the last-activity time - so the whole-node read is masked on the rows that move and irrelevant on the rows that do not.
    // A pin that cannot fail for a defect does not cover it.
    const session = renderPanel();
    const before = new Map(rowRenders);
    const nodesBefore = BUMPED_IDS.map(
      (id) => session.handle.store.getState().tree.nodeById[id],
    );

    act(() => {
      session.handle.doc.transact(() => {
        const chats = chatsMap(session.handle);
        BUMPED_IDS.forEach((id, index) => {
          const entry = chatEntry(id, 1);
          entry.set("createdAt", 900 + index);
          chats.set(id, entry);
        });
      });
    });

    // Non-vacuity, and it is the whole premise: these nodes must really have re-minted, while `updatedAt` - the one field the row DOES render off the records - stayed put.
    // Without this the case could pass by doing nothing.
    const nodesAfter = BUMPED_IDS.map(
      (id) => session.handle.store.getState().tree.nodeById[id],
    );
    expect(nodesAfter.map((node, i) => node === nodesBefore[i])).toEqual(
      BUMPED_IDS.map(() => false),
    );
    expect(nodesAfter.map((node) => node.updatedAt)).toEqual(
      BUMPED_IDS.map(() => 1),
    );

    // THE PIN: not one row re-renders, including the twelve whose own nodes
    // were replaced.
    const rerendered = ROW_IDS.filter(
      (id) => (rowRenders.get(id) ?? 0) !== (before.get(id) ?? 0),
    );
    expect({ rowsThatRerendered: rerendered.length }).toEqual({
      rowsThatRerendered: 0,
    });
  });

  it("still re-renders the twelve rows whose displayed TIME moved", () => {
    // The counterpart, and the reason the case above excludes them rather than asserting a flat zero as the artifact panel's twin does.
    // These twelve MUST re-render - a fix that stopped them would be showing stale times - and a flat zero would have demanded exactly that regression.
    const session = renderPanel();
    const before = new Map(rowRenders);

    bumpTimestamps(session, 700);

    const stale = BUMPED_IDS.filter(
      (id) => (rowRenders.get(id) ?? 0) === (before.get(id) ?? 0),
    );
    expect({ stampedRowsThatDidNotRerender: stale.length }).toEqual({
      stampedRowsThatDidNotRerender: 0,
    });
  });

  it("still re-renders when a row's TITLE changes", () => {
    // `title` is what the row reads off the tree node, so the narrowing must not
    // have severed that subscription either.
    const session = renderPanel();
    const target = ROW_IDS[0];
    const before = rowRenders.get(target) ?? 0;

    act(() => {
      const entry = chatsMap(session.handle).get(target);
      if (!(entry instanceof Y.Map)) throw new Error("no chat entry");
      entry.set("title", "Renamed chat");
    });

    expect(rowRenders.get(target) ?? 0).toBeGreaterThan(before);
  });
});
