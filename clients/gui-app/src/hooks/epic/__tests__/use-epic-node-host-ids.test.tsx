/**
 * `useEpicNodeHostIds` - the open Epic's node records folded to the set of
 * hosts its GUI chats and terminal agents name.
 *
 * Driven through the REAL open-Epic store (`openStoreForTest`), mounted via
 * `<EpicSessionContext.Provider>` directly rather than the full
 * `<EpicSessionProvider>` - the same shape `use-chat-archive-support.test.ts`
 * uses. A GUI chat's host reaches `state.chats.byId[id].hostId` either
 * through its record row (`applyChatRecords` / `applyChatRecordDelta`) or,
 * for a chat that predates `Chat.hostId`, through the doc snapshot itself
 * (`chat-records-union.test.ts`'s `docChatEntry` shape); a terminal agent's
 * host always arrives through its record row (`applyTuiAgentRecords`) - the
 * wire never carries a null `hostId` for one.
 */
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import type { ChatRecordSummaryV12 } from "@traycer/protocol/host/epic/chat-records";
import type {
  TuiAgentRecordSummaryV11,
  TuiAgentRecordSummaryV13,
} from "@traycer/protocol/host/epic/tui-agent-records";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { useAuthStore } from "@/stores/auth/auth-store";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { useEpicNodeHostIds } from "@/hooks/epic/use-epic-node-host-ids";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-node-host-ids-test",
      title: "Epic test",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

/** One open handle per test, disposed in `afterEach` - never shared. */
let session: OpenedStoreForTest | null = null;

/**
 * Opens a fresh session and feeds `seedDoc`'s doc through as the root
 * snapshot, the same shape `chat-records-union.test.ts`'s `newSession` uses.
 * Every case passes a seeder explicitly - `() => undefined` for the cases
 * with nothing to seed - rather than defaulting the parameter (no default
 * params per this repo's ESLint rules).
 */
function openSession(seedDoc: (doc: Y.Doc) => void): OpenedStoreForTest {
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
    epicId: "epic-node-host-ids-test",
    userId: null,
    factories: {
      streamClientFactory: factory,
      laneSelection: null,
    },
    // Explicit: `null` means this suite never writes.
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  const seed = new Y.Doc();
  seedDoc(seed);
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(seed));
  session = handle;
  return handle;
}

function Wrapper(props: { readonly children: ReactNode }): ReactNode {
  if (session === null) throw new Error("no session opened for this test");
  return createElement(
    EpicSessionContext.Provider,
    { value: session },
    props.children,
  );
}

function chatRecord(
  overrides: Partial<ChatRecordSummaryV12>,
): ChatRecordSummaryV12 {
  return {
    chatId: "chat-1",
    ownerUserId: "user-a",
    originHostId: "host-1",
    title: "A chat",
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    runSettingsSummary: "claude",
    revision: 1,
    visibility: "private",
    origin: "own",
    docResident: false,
    kind: "conversation",
    ...overrides,
  };
}

/**
 * A local (registry-resident) `@1.3` terminal-agent row - the same shape
 * `tui-agent-records-merge.test.ts` builds, trimmed to this suite's needs.
 * `hostId` is a non-empty string by schema (`z.string().min(1)`) for every
 * TUI record arm, so unlike a chat there is no legacy-null case to fixture.
 */
function tuiAgentRecord(
  overrides: Partial<TuiAgentRecordSummaryV11>,
): Extract<TuiAgentRecordSummaryV13, { origin: "registry" }> {
  const base: TuiAgentRecordSummaryV11 = {
    tuiAgentId: "tui-1",
    ownerUserId: "user-a",
    hostId: "host-1",
    harnessId: "claude",
    harnessSessionId: null,
    parentId: null,
    title: "An agent",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    workspaceFolders: [],
    workspaceMode: null,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    revision: 1,
    docResident: false,
    ...overrides,
  };
  return { ...base, sessionState: null, lastExit: null, origin: "registry" };
}

/**
 * A doc-resident chat entry with NO `hostId` key at all - what a chat that
 * predates `Chat.hostId` looks like on the wire (`docChatEntry` in
 * `chat-records-union.test.ts`, whose `chats.byId.legacy.hostId` this
 * mirrors). Never answered by a record row, so this is the only way to put
 * one in front of the hook.
 */
function seedLegacyDocChat(doc: Y.Doc, id: string, title: string): void {
  const chat = new Y.Map<unknown>();
  chat.set("id", id);
  chat.set("title", title);
  chat.set("parentId", null);
  chat.set("createdAt", 1);
  chat.set("updatedAt", 1);
  chat.set("isTitleEditedByUser", false);
  const chats = new Y.Map<unknown>();
  chats.set(id, chat);
  doc.getMap("epic").set("chats", chats);
}

afterEach(() => {
  cleanup();
  session?.dispose();
  session = null;
  // The auth store is module-global; nothing in this suite signs in, but a
  // stray sign-in surviving from another suite in the same worker must not
  // leak into these ownerUserId-filtered reads.
  useAuthStore.getState().setSignedOut();
});

describe("useEpicNodeHostIds", () => {
  it("folds GUI chats and terminal agents to their union of hosts, deduplicated", () => {
    const handle = openSession(() => undefined);
    handle.store.getState().applyChatRecords(
      [
        chatRecord({ chatId: "c1", originHostId: "host-a" }),
        // Same host as the chat above - must not double-count.
        chatRecord({ chatId: "c2", originHostId: "host-a" }),
      ],
      null,
    );
    handle.store
      .getState()
      .applyTuiAgentRecords(
        [tuiAgentRecord({ tuiAgentId: "t1", hostId: "host-b" })],
        null,
      );

    const { result } = renderHook(() => useEpicNodeHostIds(), {
      wrapper: Wrapper,
    });
    expect([...result.current].sort()).toEqual(["host-a", "host-b"]);
  });

  it("contributes nothing for an Epic with no chats or terminal agents", () => {
    openSession(() => undefined);
    const { result } = renderHook(() => useEpicNodeHostIds(), {
      wrapper: Wrapper,
    });
    expect(result.current.size).toBe(0);
  });

  it("contributes nothing for a legacy chat that predates `Chat.hostId`", () => {
    openSession((doc) => seedLegacyDocChat(doc, "legacy", "Legacy chat"));
    const { result } = renderHook(() => useEpicNodeHostIds(), {
      wrapper: Wrapper,
    });
    expect(result.current.size).toBe(0);
  });

  it("includes an archived chat's and an archived agent's hosts", () => {
    const handle = openSession(() => undefined);
    handle.store.getState().applyChatRecords(
      [
        chatRecord({
          chatId: "archived-chat",
          originHostId: "host-archived-chat",
          archived: true,
          archivedAt: 5_000,
        }),
      ],
      null,
    );
    handle.store.getState().applyTuiAgentRecords(
      [
        tuiAgentRecord({
          tuiAgentId: "archived-agent",
          hostId: "host-archived-agent",
          archived: true,
          archivedAt: 5_000,
        }),
      ],
      null,
    );

    const { result } = renderHook(() => useEpicNodeHostIds(), {
      wrapper: Wrapper,
    });
    expect([...result.current].sort()).toEqual([
      "host-archived-agent",
      "host-archived-chat",
    ]);
  });

  it("answers the empty set with no EpicSessionContext in scope, rather than throwing", () => {
    const { result } = renderHook(() => useEpicNodeHostIds());
    expect(result.current.size).toBe(0);
  });

  it("reacts to a node being added and removed, over the record push channel", () => {
    const handle = openSession(() => undefined);
    handle.store
      .getState()
      .applyChatRecords(
        [chatRecord({ chatId: "c1", originHostId: "host-a" })],
        null,
      );

    const { result } = renderHook(() => useEpicNodeHostIds(), {
      wrapper: Wrapper,
    });
    expect([...result.current]).toEqual(["host-a"]);

    act(() => {
      handle.store.getState().applyChatRecordDelta({
        kind: "upsert",
        epicId: "epic-node-host-ids-test",
        record: chatRecord({
          chatId: "c2",
          originHostId: "host-b",
          revision: 1,
        }),
      });
    });
    expect([...result.current].sort()).toEqual(["host-a", "host-b"]);

    act(() => {
      handle.store.getState().applyChatRecordDelta({
        kind: "remove",
        epicId: "epic-node-host-ids-test",
        chatId: "c1",
        reason: "deleted",
      });
    });
    expect([...result.current]).toEqual(["host-b"]);
  });

  it("hands back the same Set instance across an update that does not change the host union", () => {
    const handle = openSession(() => undefined);
    handle.store.getState().applyChatRecords(
      [
        chatRecord({
          chatId: "c1",
          originHostId: "host-a",
          title: "Before",
          revision: 1,
        }),
      ],
      null,
    );

    const { result } = renderHook(() => useEpicNodeHostIds(), {
      wrapper: Wrapper,
    });
    const before = result.current;
    expect([...before]).toEqual(["host-a"]);

    // A rename on the SAME host - the union's content is unchanged, only an
    // unrelated field moved, so the returned Set must be the identical
    // object: a consumer keying a memo or an effect on this value must not
    // re-run for churn that never touched which hosts exist.
    act(() => {
      handle.store.getState().applyChatRecordDelta({
        kind: "upsert",
        epicId: "epic-node-host-ids-test",
        record: chatRecord({
          chatId: "c1",
          originHostId: "host-a",
          title: "After",
          revision: 2,
        }),
      });
    });

    expect(result.current).toBe(before);
  });
});
