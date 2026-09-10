/**
 * The park-then-show cache-reuse defect (cold Codex review of renderer
 * parking, P2).
 *
 * `EpicRecordSyncEffects` (`components/epic-canvas/epic-route-session-body.tsx`)
 * gates `useEpicSyncChatRecords` and `useEpicSyncTuiAgentRecords` on
 * `useEpicParked(epicId)`. A park unmounts BOTH hooks and releases the epic
 * session - the open-epic store is disposed - so showing the tab again
 * remounts them against a BRAND-NEW session store. Both hooks read through
 * `useHostQueryWithResponseMap` with `staleTime: 10_000`; before the fix
 * their cache key carried no session identity
 * (`cacheKeyIdentity: [viewerUserId]`), so a park-then-show inside that 10s
 * window remounted against the SAME cache entry and served the pre-park
 * answer verbatim: zero new requests, and a chat/terminal-agent deleted at
 * the host while parked reappeared as though it still existed.
 *
 * The fix appends the session generation to the key
 * (`cacheKeyIdentity: [viewerUserId, fenceIdentity]`, where `fenceIdentity`
 * is `OpenEpicState.ingestFenceIdentity` - a module-monotonic value minted
 * once per store CONSTRUCTION). A reopened epic is then a different cache
 * entry, and its first read is a real request.
 *
 * This file drives both real hooks together, in one render, exactly as
 * `EpicRecordSyncEffects` mounts them, against a real `QueryClient`, a real
 * `HostClient` over `MockHostMessenger`, and two real open-epic store
 * generations - mirroring `chat-record-freshness.test.tsx`'s harness shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type {
  TuiAgentRecordSummaryV11,
  TuiAgentRecordSummaryV12,
} from "@traycer/protocol/host/epic/tui-agent-records";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicSyncChatRecords } from "@/hooks/chats/use-epic-chat-records";
import { useEpicSyncTuiAgentRecords } from "@/hooks/chats/use-epic-tui-agent-records";

const EPIC_ID = "epic-records-gen";
const VIEWER_ID = "viewer-1";
const HOST_ID = mockLocalHostEntry.hostId;

// Same seam as `chat-record-freshness.test.tsx`: both record hooks read the
// EPIC SESSION's client via `EpicSessionHostClientContext`, but other host
// plumbing they touch indirectly still resolves through the app-wide
// runtime mock, so it has to answer with the same fixture client.
const runtime: { client: HostClient<HostRpcRegistry> | null } = vi.hoisted(
  () => ({ client: null }),
);
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => runtime.client,
  useHostRuntimeClient: () => runtime.client,
  useHostBinding: () =>
    runtime.client === null
      ? null
      : { hostClient: runtime.client, hostId: null },
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () =>
    runtime.client === null
      ? null
      : { hostClient: runtime.client, hostId: null },
  useHostClient: () => runtime.client,
  useHostRuntimeClient: () => runtime.client,
}));

function chatRow(
  overrides: Partial<ChatRecordSummaryV11>,
): ChatRecordSummaryV11 {
  return {
    chatId: "chat-1",
    ownerUserId: VIEWER_ID,
    originHostId: HOST_ID,
    title: "",
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
    ...overrides,
  };
}

/** Mirrors `tui-agent-records-merge.test.ts`'s `row()` fixture. */
function tuiRow(
  overrides: Partial<TuiAgentRecordSummaryV11>,
): Extract<TuiAgentRecordSummaryV12, { origin: "registry" | "doc" }> {
  const base: TuiAgentRecordSummaryV11 = {
    tuiAgentId: "tui-1",
    ownerUserId: VIEWER_ID,
    hostId: HOST_ID,
    harnessId: "claude",
    harnessSessionId: null,
    parentId: null,
    title: "",
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
  return base.docResident
    ? { ...base, origin: "doc" as const }
    : { ...base, origin: "registry" as const };
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Epic records",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: VIEWER_ID,
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

/**
 * A fresh open-epic session - one "generation" - with an empty doc replica.
 * Seeding only `epic.chats` (never `epic.tuiAgents`) is deliberate: the
 * doc-projection layer defaults a missing `tuiAgents` sub-map to an empty
 * slice, so both hooks run safely against this minimal seed.
 */
function newSession(): OpenedStoreForTest {
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
    userId: VIEWER_ID,
    factories: {
      streamClientFactory: factory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("stream factory not invoked");
  const seed = new Y.Doc();
  seed.getMap("epic").set("chats", new Y.Map<unknown>());
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(seed));
  return handle;
}

interface Fixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly handle: OpenedStoreForTest;
  readonly chatListCalls: { value: number };
  readonly tuiListCalls: { value: number };
  readonly chatRows: ChatRecordSummaryV11[];
  readonly tuiRows: Array<
    Extract<TuiAgentRecordSummaryV12, { origin: "registry" | "doc" }>
  >;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

function wrapperFor(
  queryClient: QueryClient,
  handle: OpenedStoreForTest,
  client: HostClient<HostRpcRegistry>,
): (props: { readonly children: ReactNode }) => ReactNode {
  return (props) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        EpicSessionContext.Provider,
        { value: handle },
        createElement(
          EpicSessionHostClientContext.Provider,
          { value: client },
          props.children,
        ),
      ),
    );
}

function createFixture(): Fixture {
  const chatRows: ChatRecordSummaryV11[] = [];
  const tuiRows: Array<
    Extract<TuiAgentRecordSummaryV12, { origin: "registry" | "doc" }>
  > = [];
  const chatListCalls = { value: 0 };
  const tuiListCalls = { value: 0 };
  const requestSeq = { value: 0 };
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestSeq.value += 1;
        return `req-${String(requestSeq.value)}`;
      },
      handlers: {
        "epic.listChatRecords": () => {
          chatListCalls.value += 1;
          return Promise.resolve({
            chats: chatRows.map((row) => ({ ...row })),
          });
        },
        "epic.listTuiAgents": () => {
          tuiListCalls.value += 1;
          return Promise.resolve({
            tuiAgents: tuiRows.map((row) => ({ ...row })),
          });
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  runtime.client = client;
  const handle = newSession();
  return {
    client,
    queryClient,
    handle,
    chatListCalls,
    tuiListCalls,
    chatRows,
    tuiRows,
    Wrapper: wrapperFor(queryClient, handle, client),
  };
}

let fixture: Fixture;

beforeEach(() => {
  useAuthStore.setState({
    contextMetadata: { userId: VIEWER_ID, username: VIEWER_ID },
  });
  fixture = createFixture();
});

afterEach(() => {
  cleanup();
  fixture.handle.store.getState().dispose();
  runtime.client = null;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("record reads are scoped to the session generation", () => {
  it("issues a fresh request per method, and drops a record deleted while parked, across a park-then-show inside staleTime", async () => {
    // Generation A: one row per method that the host will delete while the
    // epic is parked.
    fixture.chatRows.push(chatRow({ chatId: "chat-doomed" }));
    fixture.tuiRows.push(tuiRow({ tuiAgentId: "tui-doomed" }));

    const viewA = renderHook(
      () => {
        useEpicSyncChatRecords(EPIC_ID);
        useEpicSyncTuiAgentRecords(EPIC_ID);
      },
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.chatListCalls.value).toBe(1);
      expect(fixture.tuiListCalls.value).toBe(1);
    });
    await waitFor(() => {
      expect(
        Object.hasOwn(
          fixture.handle.store.getState().chats.byId,
          "chat-doomed",
        ),
      ).toBe(true);
      expect(
        Object.hasOwn(
          fixture.handle.store.getState().tuiAgents.byId,
          "tui-doomed",
        ),
      ).toBe(true);
    });

    const fenceA = fixture.handle.store.getState().ingestFenceIdentity;

    // Park: unmount BOTH hooks (as `EpicRecordSyncEffects` unmounting does)
    // and release generation A's session - the park's actual disposal.
    viewA.unmount();
    fixture.handle.store.getState().dispose();

    // While parked, the host deletes the pre-park rows and gains rows
    // generation A never saw.
    fixture.chatRows.splice(
      0,
      fixture.chatRows.length,
      chatRow({ chatId: "chat-new-in-b" }),
    );
    fixture.tuiRows.splice(
      0,
      fixture.tuiRows.length,
      tuiRow({ tuiAgentId: "tui-new-in-b" }),
    );

    // Show: generation B, a brand-new session, mounted well inside
    // `staleTime` (10s) - no fake timers are advanced here. If the cache key
    // omitted the session generation, this remount would be served the
    // A-fenced cached answer synchronously and issue no request at all.
    const handleB = newSession();
    const WrapperB = wrapperFor(fixture.queryClient, handleB, fixture.client);

    renderHook(
      () => {
        useEpicSyncChatRecords(EPIC_ID);
        useEpicSyncTuiAgentRecords(EPIC_ID);
      },
      { wrapper: WrapperB },
    );

    // Synchronous observable, checked before any await settles anything: the
    // pre-fix bug applies the A-fenced cached answer to the new store inside
    // the same synchronous `act()` flush that `renderHook` performs, so a
    // reverted fix would already show `chat-doomed` / `tui-doomed` here.
    expect(
      Object.hasOwn(handleB.store.getState().chats.byId, "chat-doomed"),
    ).toBe(false);
    expect(
      Object.hasOwn(handleB.store.getState().tuiAgents.byId, "tui-doomed"),
    ).toBe(false);

    // Pin 1: a real second request per method - not a cache hit.
    await waitFor(() => {
      expect(fixture.chatListCalls.value).toBe(2);
      expect(fixture.tuiListCalls.value).toBe(2);
    });

    // Pin 2: generation B's fence differs from A's - states what "generation"
    // means for this key.
    expect(handleB.store.getState().ingestFenceIdentity).not.toBe(fenceA);

    // Pin 3: B's own read actually lands in B's store, fenced against B's own
    // generation - not merely "B ignored stale data" but "B applied fresh
    // data correctly".
    await waitFor(() => {
      expect(
        Object.hasOwn(handleB.store.getState().chats.byId, "chat-new-in-b"),
      ).toBe(true);
      expect(
        Object.hasOwn(handleB.store.getState().tuiAgents.byId, "tui-new-in-b"),
      ).toBe(true);
    });

    // Pin 4 (the reviewer's arm, re-checked directly against store contents
    // after settling, not only inferred from the request counter above): the
    // record deleted at the host while parked never resurrects in B.
    expect(
      Object.hasOwn(handleB.store.getState().chats.byId, "chat-doomed"),
    ).toBe(false);
    expect(
      Object.hasOwn(handleB.store.getState().tuiAgents.byId, "tui-doomed"),
    ).toBe(false);

    handleB.store.getState().dispose();
  });
});
