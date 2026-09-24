/**
 * An identity's evolution chat is LISTED under Archived (`chatListedAsArchived`)
 * even though its record carries no `archivedAt`. The row's presentation must
 * follow the partition it is listed in, not the record's archive flag: under
 * the All view the evolution row is dimmed and the conversation row is not
 * (finding 45). Rendered through the real `ChatTreePanelBody` over a real
 * open-epic session, with the same host-RPC seams
 * `sidebar-chat-row-node-churn.test.tsx` fakes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import {
  CHAT_ARCHIVE_VISIBILITY,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-client-for-host-id")
    >();
  return { ...actual, useHostClientForHostId: () => null };
});

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

const EPIC_ID = "epic-evolution-row-dimmed";
const TAB_ID = "tab-evolution-row";
const CONVO_ID = "chat-convo";
const EVOLUTION_ID = "chat-evolution";
const ARCHIVED_ROW_CLASS = "opacity-55";

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Evolution row",
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

function chat(id: string, kind: "evolution" | null): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("title", id);
  entry.set("parentId", null);
  entry.set("createdAt", 1);
  entry.set("updatedAt", 1);
  entry.set("hostId", "host-a");
  entry.set("archivedAt", null);
  entry.set("messages", new Y.Array<unknown>());
  if (kind !== null) entry.set("kind", kind);
  return entry;
}

function seedDoc(): Uint8Array {
  const donor = new Y.Doc();
  const chats = new Y.Map<unknown>();
  chats.set(CONVO_ID, chat(CONVO_ID, null));
  chats.set(EVOLUTION_ID, chat(EVOLUTION_ID, "evolution"));
  const epic = donor.getMap<unknown>("epic");
  epic.set("title", "Evolution row");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", chats);
  return Y.encodeStateAsUpdate(donor);
}

function createSession(): OpenedStoreForTest {
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
    userId: "user-1",
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), seedDoc());
  return handle;
}

function row(nodeId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-sidebar-node-id="${nodeId}"]`,
  );
  if (element === null) throw new Error(`no row for ${nodeId}`);
  return element;
}

const opened: OpenedStoreForTest[] = [];

afterEach(() => {
  for (const handle of opened.splice(0)) handle.dispose();
  cleanup();
  useLeftPanelStore
    .getState()
    .setChatArchiveVisibility(EPIC_ID, CHAT_ARCHIVE_VISIBILITY.Unarchived);
});

describe("evolution chat row presentation (finding 45)", () => {
  it("dims the evolution row under the All view, and not the conversation row", async () => {
    const handle = createSession();
    opened.push(handle);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EpicSessionContext.Provider value={handle}>
          <ChatTreePanelBody
            epicId={EPIC_ID}
            tabId={TAB_ID}
            messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
          />
        </EpicSessionContext.Provider>
      </QueryClientProvider>,
    );

    act(() => {
      useLeftPanelStore
        .getState()
        .setChatArchiveVisibility(EPIC_ID, CHAT_ARCHIVE_VISIBILITY.All);
    });
    await waitFor(() => {
      expect(screen.getByText(EVOLUTION_ID)).not.toBeNull();
      expect(screen.getByText(CONVO_ID)).not.toBeNull();
    });

    // The evolution row is LISTED as archived (the partition it sits in), so
    // it renders archived - its record's `archivedAt` is null all the same.
    expect(row(EVOLUTION_ID).classList.contains(ARCHIVED_ROW_CLASS)).toBe(true);
    expect(row(CONVO_ID).classList.contains(ARCHIVED_ROW_CLASS)).toBe(false);
  });
});
