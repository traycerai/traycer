/**
 * Shared fixture for the tests that mount the real `ChatTreePanelBody` over a
 * seeded task: a Yjs doc of chats, the session that serves it, the host-hook
 * stubs the tree reads, and queries over what the tree drew.
 *
 * Each test file declares its own `vi.mock` lines (they are hoisted per file)
 * from the factories here, and the jsdom layout from `chat-tree-virtual-layout`.
 */
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DndContext } from "@dnd-kit/core";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

export const EPIC_ID = "epic-chat-tree";
export const TAB_ID = "tab-chat-tree";
const USER_ID = "user-1";
const OWNER_HOST = "host-a";

export interface SeedChat {
  readonly id: string;
  readonly parentId: string | null;
  readonly updatedAt: number;
}

/** Chats `c0..c{count-1}`, all roots, newest first under the default sort. */
export function rootChats(count: number): SeedChat[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    parentId: null,
    updatedAt: 100_000 - index,
  }));
}

function chatEntry(chat: SeedChat): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", chat.id);
  entry.set("title", `Title ${chat.id}`);
  entry.set("parentId", chat.parentId);
  entry.set("createdAt", 1);
  entry.set("updatedAt", chat.updatedAt);
  entry.set("hostId", OWNER_HOST);
  entry.set("archivedAt", null);
  entry.set("messages", new Y.Array<unknown>());
  return entry;
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Chat tree",
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

function seedDoc(chats: readonly SeedChat[]): Uint8Array {
  const donor = new Y.Doc();
  const epic = donor.getMap<unknown>("epic");
  const chatMap = new Y.Map<unknown>();
  for (const chat of chats) chatMap.set(chat.id, chatEntry(chat));
  epic.set("title", "Chat tree");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", chatMap);
  return Y.encodeStateAsUpdate(donor);
}

export function openChatSession(
  chats: readonly SeedChat[],
): OpenedStoreForTest {
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
  captured.value.onSnapshot(makeMeta(), seedDoc(chats));
  return handle;
}

/** Writes `chat` into the live doc, the way a remote edit reaches the tree. */
export function upsertChat(session: OpenedStoreForTest, chat: SeedChat): void {
  const chats = session.doc.getMap<unknown>("epic").get("chats");
  if (!(chats instanceof Y.Map)) throw new Error("the doc has no chats map");
  session.doc.transact(() => {
    chats.set(chat.id, chatEntry(chat));
  });
}

export function renderChatTree(session: OpenedStoreForTest): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EpicSessionContext.Provider value={session}>
        <DndContext>
          <ChatTreePanelBody
            epicId={EPIC_ID}
            tabId={TAB_ID}
            messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
          />
        </DndContext>
      </EpicSessionContext.Provider>
    </QueryClientProvider>,
  );
}

export function treeList(): HTMLElement {
  // `hidden`: an open modal dialog marks the rest of the page aria-hidden.
  return screen.getByRole("tree", { hidden: true });
}

/** The tree's mounted `<li role="treeitem">`s, in DOM order. */
export function mountedItems(): HTMLElement[] {
  return Array.from(
    treeList().querySelectorAll<HTMLElement>(':scope > [role="treeitem"]'),
  );
}

/** The chat ids of the mounted agent rows, in DOM order; a row being created has none. */
export function mountedChatIds(): string[] {
  return mountedItems().flatMap((item) => {
    const id = item
      .querySelector("[data-sidebar-node-id]")
      ?.getAttribute("data-sidebar-node-id");
    return id === null || id === undefined ? [] : [id];
  });
}

export function itemOf(chatId: string): HTMLElement {
  const item = screen
    .getByTestId(`epic-sidebar-item-${chatId}`)
    .closest<HTMLElement>('[role="treeitem"]');
  if (item === null) throw new Error(`no treeitem for ${chatId}`);
  return item;
}

export function topOf(item: HTMLElement): number {
  return parseFloat(item.style.top);
}
