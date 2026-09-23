/**
 * An identity's evolution chat is folded into the archive partition
 * (`chatListedAsArchived`), so the sidebar's default (unarchived) view hides
 * it and the Archived view shows it - the reverse of an ordinary conversation
 * chat. Exercised through `useSidebarArchiveHiddenIds` against a real
 * open-epic session (`openStoreForTest`), the same harness
 * `sidebar-chat-order.test.tsx` uses for this hook.
 *
 * Also pins the record-plane half of the mapping: `chatProjectionFromRecord`
 * carries a row's `kind: "evolution"` into `chatKind: "evolution"`.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import {
  CHAT_ARCHIVE_VISIBILITY,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";
import { useSidebarArchiveHiddenIds } from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { chatProjectionFromRecord } from "@/stores/epics/open-epic/projection-helpers";
import type { HeldChatRecordRow } from "@/stores/epics/open-epic/types";

const EPIC_ID = "epic-evolution-visibility";
const CONVO_ID = "chat-convo";
const EVOLUTION_ID = "chat-evolution";

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Evolution visibility",
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

function seedDoc(doc: Y.Doc): void {
  const chats = new Y.Map<unknown>();
  chats.set(CONVO_ID, chat(CONVO_ID, null));
  chats.set(EVOLUTION_ID, chat(EVOLUTION_ID, "evolution"));
  const epic = doc.getMap("epic");
  epic.set("title", "Evolution visibility");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
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
    factories: {
      streamClientFactory: factory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("stream factory not invoked");
  const donor = new Y.Doc();
  seedDoc(donor);
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(donor));
  donor.destroy();
  return handle;
}

function HiddenIdsProbe(props: { readonly epicId: string }) {
  const hiddenIds = useSidebarArchiveHiddenIds(props.epicId);
  return (
    <output data-testid="hidden-ids">{[...hiddenIds].sort().join(",")}</output>
  );
}

afterEach(() => {
  cleanup();
  useLeftPanelStore
    .getState()
    .setChatArchiveVisibility(EPIC_ID, CHAT_ARCHIVE_VISIBILITY.Unarchived);
});

describe("useSidebarArchiveHiddenIds - identity evolution chats", () => {
  it("hides an evolution chat by default and leaves a conversation chat visible", async () => {
    const handle = createSession();
    const view = render(
      <EpicSessionContext.Provider value={handle}>
        <HiddenIdsProbe epicId={EPIC_ID} />
      </EpicSessionContext.Provider>,
    );
    try {
      await waitFor(() => {
        expect(screen.getByTestId("hidden-ids").textContent).not.toBe("");
      });
      const hidden = screen.getByTestId("hidden-ids").textContent.split(",");

      expect(hidden).toContain(EVOLUTION_ID);
      expect(hidden).not.toContain(CONVO_ID);
    } finally {
      view.unmount();
      handle.dispose();
    }
  });

  it("shows the evolution chat and hides the conversation chat under the Archived view", async () => {
    const handle = createSession();
    const view = render(
      <EpicSessionContext.Provider value={handle}>
        <HiddenIdsProbe epicId={EPIC_ID} />
      </EpicSessionContext.Provider>,
    );
    try {
      await waitFor(() => {
        expect(screen.getByTestId("hidden-ids").textContent).not.toBe("");
      });

      act(() => {
        useLeftPanelStore
          .getState()
          .setChatArchiveVisibility(EPIC_ID, CHAT_ARCHIVE_VISIBILITY.Archived);
      });

      await waitFor(() => {
        const hidden = screen.getByTestId("hidden-ids").textContent.split(",");
        expect(hidden).not.toContain(EVOLUTION_ID);
      });
      const hidden = screen.getByTestId("hidden-ids").textContent.split(",");
      expect(hidden).toContain(CONVO_ID);
    } finally {
      view.unmount();
      handle.dispose();
    }
  });
});

describe("chatProjectionFromRecord - identity evolution chats", () => {
  const BASE_ROW: HeldChatRecordRow = {
    chatId: "chat-1",
    ownerUserId: "user-1",
    originHostId: "host-a",
    title: "Chat",
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    archivedAt: null,
    runSettingsSummary: null,
    revision: 1,
    visibility: "private",
    origin: "own",
    docResident: null,
    kind: "conversation",
  };

  it("maps a row carrying kind: 'evolution' to the evolution chatKind", () => {
    const evolutionRow: HeldChatRecordRow = { ...BASE_ROW, kind: "evolution" };

    expect(chatProjectionFromRecord(evolutionRow).chatKind).toBe("evolution");
    expect(chatProjectionFromRecord(BASE_ROW).chatKind).toBe("conversation");
  });
});
