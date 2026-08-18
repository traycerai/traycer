/**
 * The record channel's FRESHNESS seam (chat-sync-v2 ticket 49).
 *
 * Since the single-write pivot a created chat exists only in the host's chat
 * database: nothing pushes it to this renderer, so `epic.listChatRecords` is
 * the only way a fresh chat ever reaches `chats.byId`. Two mechanisms are
 * supposed to keep that list current - the mutations invalidate it on success,
 * and the table's 20s cadence bounds everything else - and a create-then-open
 * flow (`openCreatedChatWhenProjected`, the new-conversation modal's handoff)
 * waits on the projection with nothing else to wake it.
 *
 * Both mechanisms were dead on the staging shakedown build, which is what
 * these tests pin. The suite drives the REAL hooks against a real
 * `QueryClient`, a real `HostClient` over the mock messenger, and a real
 * open-epic store, because the defect was precisely a cache-key / opt-in
 * mismatch between those layers - every layer was correct on its own.
 *
 * Ablations each test is written against:
 *  - drop `invalidateEpicChatRecords` from `useEpicCreateChatForHostClient`
 *    (the explicit-client twin, ticket 43) and the create tests hang on a
 *    record list that is never re-read: the user-visible spinning new tab.
 *  - drop `poll: true` from `useEpicSyncChatRecords` and the cadence test
 *    reads `false`, i.e. a list that only ever refreshes on window focus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import type { ChatRecordSummary } from "@traycer/protocol/host/epic/chat-records";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicSyncChatRecords } from "@/hooks/chats/use-epic-chat-records";
import {
  useEpicArchiveChat,
  useEpicCreateChatForHostClient,
  useEpicDeleteChat,
  useEpicRenameChat,
} from "@/hooks/epic/use-epic-chat-mutations";

const EPIC_ID = "epic-records";
const VIEWER_ID = "viewer-1";
const HOST_ID = mockLocalHostEntry.hostId;

// `useEpicSyncChatRecords` and the rename/delete hooks read the EPIC SESSION's
// client (`EpicSessionHostClientContext`, provided by the wrapper below); the
// create-for-client hook takes one as an argument; the app-wide runtime mock
// serves whatever still resolves through it. All must land on the same host
// for the invalidation key to match the query key at all, which is the
// mismatch class this suite exists to catch - so every seam hands back the one
// fixture client and the assertions do the rest.
const runtime: { client: HostClient<HostRpcRegistry> | null } = vi.hoisted(
  () => ({ client: null }),
);
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => runtime.client,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => runtime.client,
}));

interface Fixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly handle: OpenEpicStoreHandle;
  readonly listCalls: { value: number };
  readonly records: ChatRecordSummary[];
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

function record(overrides: Partial<ChatRecordSummary>): ChatRecordSummary {
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
    ...overrides,
  };
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

/** A real open-epic session with an empty doc `chats` map (the post-sweep steady state). */
function newSession(): OpenEpicStoreHandle {
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
  const handle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: factory,
    userId: VIEWER_ID,
    onAuthError: null,
  });
  if (captured.value === null) throw new Error("stream factory not invoked");
  const seed = new Y.Doc();
  seed.getMap("epic").set("chats", new Y.Map<unknown>());
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(seed));
  return handle;
}

function createFixture(listFailureCode: "E_HOST_UNSUPPORTED" | null): Fixture {
  const records: ChatRecordSummary[] = [];
  const listCalls = { value: 0 };
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
          listCalls.value += 1;
          if (listFailureCode !== null) {
            return Promise.reject(
              new HostRpcError({
                code: listFailureCode,
                message: "record list unsupported",
                requestId: `req-${String(requestSeq.value)}`,
                method: "epic.listChatRecords",
                fatalDetails: null,
              }),
            );
          }
          return Promise.resolve({ chats: records.map((row) => ({ ...row })) });
        },
        // The host writes the registry row BEFORE it answers
        // (`chatRegistryWriter.createChat` is awaited inside the resolver), so
        // a list read that starts after this response is guaranteed to see it.
        "epic.createChat": (params) => {
          records.push(record({ chatId: params.chatId }));
          return Promise.resolve({
            chatId: params.chatId,
            initialTurnStarted: false,
          });
        },
        "epic.renameChat": (params) => {
          const index = records.findIndex(
            (entry) => entry.chatId === params.chatId,
          );
          if (index >= 0) {
            records[index] = { ...records[index], title: params.title };
          }
          return Promise.resolve({ updated: true });
        },
        "epic.setChatArchived": (params) => {
          const index = records.findIndex(
            (entry) => entry.chatId === params.chatId,
          );
          if (index >= 0) {
            records[index] = {
              ...records[index],
              // BOTH fields, the way a real host answers: `archived` is the
              // rendering-authoritative boolean every row can carry, and
              // `archivedAt` the timestamp only an OWN row has. A fixture that
              // moved the timestamp alone would describe a row no host emits.
              archived: params.archived,
              archivedAt: params.archived ? 5 : null,
            };
          }
          return Promise.resolve({ updated: true });
        },
        "epic.deleteChat": (params) => {
          const index = records.findIndex(
            (entry) => entry.chatId === params.chatId,
          );
          if (index >= 0) records.splice(index, 1);
          return Promise.resolve({ deleted: true });
        },
      },
    }),
  });
  spine.setRequestContext(
    // Any authenticated context will do: the client's request-context user id
    // only gates `useHostQuery`'s readiness. The VIEWER identity that scopes
    // the cache key is the auth store's, seeded in `beforeEach`.
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  runtime.client = client;
  const handle = newSession();
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
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
  return { client, queryClient, handle, listCalls, records, Wrapper };
}

let fixture: Fixture;

beforeEach(() => {
  useAuthStore.setState({
    contextMetadata: { userId: VIEWER_ID, username: VIEWER_ID },
  });
  fixture = createFixture(null);
});

afterEach(() => {
  cleanup();
  fixture.handle.store.getState().dispose();
  runtime.client = null;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

/** Renders the record channel plus one mutation hook, as the epic route does. */
function renderChannel<T>(useMutationHook: () => T): { readonly current: T } {
  const rendered = renderHook(
    () => {
      useEpicSyncChatRecords(EPIC_ID);
      return useMutationHook();
    },
    { wrapper: fixture.Wrapper },
  );
  return rendered.result;
}

async function settleFirstRead(): Promise<void> {
  expect(fixture.handle.store.getState().chatRecordListAuthoritative).toBe(
    false,
  );
  await waitFor(() => {
    expect(fixture.listCalls.value).toBe(1);
  });
  await waitFor(() => {
    expect(fixture.handle.store.getState().chatRecordListAuthoritative).toBe(
      true,
    );
  });
}

describe("record-list deletion authority", () => {
  it("treats E_HOST_UNSUPPORTED as an authoritative doc-only answer", async () => {
    fixture.handle.store.getState().dispose();
    fixture = createFixture("E_HOST_UNSUPPORTED");

    renderHook(() => useEpicSyncChatRecords(EPIC_ID), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(fixture.listCalls.value).toBe(1);
      expect(fixture.handle.store.getState().chatRecordListAuthoritative).toBe(
        true,
      );
    });
    expect(fixture.handle.store.getState().chats.allIds).toEqual([]);
  });
});

describe("a create refreshes the record list", () => {
  it("re-reads the records after a create sent on an explicitly resolved host client", async () => {
    // The in-Epic new-conversation modal's path: it resolves the picked host's
    // own client (`useHostClientForHostId`) and creates on THAT, so this hook -
    // not the app-wide one - is what the sidebar's "New agent" actually runs.
    const result = renderChannel(() =>
      useEpicCreateChatForHostClient(fixture.client),
    );
    await settleFirstRead();

    result.current.mutate({
      epicId: EPIC_ID,
      hostId: HOST_ID,
      chatId: "chat-new",
      parentId: null,
      title: "",
    });

    // The create's own success is not the assertion - the record list being
    // re-read is. Without it the created chat reaches `chats.byId` only when
    // the poll fires (or never, if the poll is off), and the create-then-open
    // flow spins on a projection that never arrives.
    await waitFor(() => {
      expect(fixture.listCalls.value).toBe(2);
    });
  });

  it("delivers the created chat into the epic session's record table", async () => {
    const result = renderChannel(() =>
      useEpicCreateChatForHostClient(fixture.client),
    );
    await settleFirstRead();
    expect(
      Object.hasOwn(fixture.handle.store.getState().chats.byId, "chat-new"),
    ).toBe(false);

    result.current.mutate({
      epicId: EPIC_ID,
      hostId: HOST_ID,
      chatId: "chat-new",
      parentId: null,
      title: "",
    });

    // End of the chain the spinning tab was waiting on: refetch -> union ->
    // `chats.byId`, which is what `openCreatedChatWhenProjected` and the
    // handoff's `projectedChatId` both read.
    await waitFor(() => {
      expect(
        Object.hasOwn(fixture.handle.store.getState().chats.byId, "chat-new"),
      ).toBe(true);
    });
  });
});

describe("the other record mutations refresh the list too", () => {
  beforeEach(() => {
    fixture.records.push(record({ chatId: "chat-1", title: "Before" }));
  });

  it("re-reads after a rename", async () => {
    const result = renderChannel(() => useEpicRenameChat());
    await settleFirstRead();

    result.current.mutate({
      epicId: EPIC_ID,
      chatId: "chat-1",
      title: "After",
    });

    await waitFor(() => {
      expect(fixture.handle.store.getState().chats.byId["chat-1"].title).toBe(
        "After",
      );
    });
  });

  it("re-reads after an archive", async () => {
    const result = renderChannel(() => useEpicArchiveChat());
    await settleFirstRead();

    result.current.mutate({
      epicId: EPIC_ID,
      chatId: "chat-1",
      archived: true,
    });

    await waitFor(() => {
      expect(fixture.listCalls.value).toBe(2);
    });
    expect(
      fixture.handle.store.getState().chats.byId["chat-1"].archivedAt,
    ).toBe(5);
  });

  it("re-reads after a delete", async () => {
    const result = renderChannel(() => useEpicDeleteChat());
    await settleFirstRead();

    result.current.mutate({ epicId: EPIC_ID, chatId: "chat-1" });

    await waitFor(() => {
      expect(
        Object.hasOwn(fixture.handle.store.getState().chats.byId, "chat-1"),
      ).toBe(false);
    });
  });
});

describe("the record list runs on the table's cadence", () => {
  it("arms the 20s interval the channel documents", async () => {
    renderChannel(() => null);
    await settleFirstRead();

    // `HOST_METHOD_POLL_TABLE` declares a fixed 20s cadence for this method,
    // but a fixed policy is OPT-IN (`useHostQuery` arms `refetchInterval` only
    // for `poll: true`). Without the opt-in the query's interval is `false` and
    // the only thing that ever refreshes the list is a window-focus refetch -
    // which is exactly the irregular cadence the staging host log showed.
    const found = fixture.queryClient
      .getQueryCache()
      .findAll({ queryKey: ["host", HOST_ID, "epic.listChatRecords"] });
    expect(found).toHaveLength(1);
    expect(found[0].observers[0].options.refetchInterval).toBe(20_000);
  });
});
