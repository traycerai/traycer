/**
 * Cloud-chat deletion suppression.
 *
 * Deleting a local chat drops its id from the local tree (via
 * `applyConfirmedChatMutation`) before the cloud plane catches up. Since the
 * sidebar's fold (`selectUnfoldedCloudChats`, `lib/chats/unified-chat-list.ts`)
 * hides a cloud row only while a matching LOCAL id is still present, dropping
 * that id used to un-fold the chat's own still-cached cloud backup and render
 * it as a ghost root row - visible until the next `epic.listCloudChats`
 * refetch happened to observe the retraction, which can be a while: the list
 * is not polled after success (30s `staleTime`, no success cadence).
 *
 * `useEpicDeleteChat`'s `onMutate` now marks the identity PENDING
 * (`beginCloudChatDeletion`) before the RPC round-trips, and CONFIRMS it on
 * success (`settleCloudChatDeletion(token, true)`); a failure clears the
 * pending mark WITHOUT confirming it. `useCloudChatList` filters both the
 * pending and confirmed sets out of whatever the cloud answers, `select`-side
 * (`filterDeletedCloudChats`), so neither an in-flight delete nor a stale
 * (not-yet-caught-up) refetch can put the row back in front of the fold.
 *
 * Driven against the REAL `useEpicSyncChatRecords` / `useEpicChatIds` /
 * `useCloudChatList` / `useEpicDeleteChat` / `selectUnfoldedCloudChats` stack
 * over a mock messenger, the way `chat-record-freshness.test.tsx` drives the
 * record channel - the defect was precisely a seam between the local tree and
 * the cloud list, so a selector replayed with hand-built arrays would not
 * have caught it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
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
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicSyncChatRecords } from "@/hooks/chats/use-epic-chat-records";
import { useCloudChatList } from "@/hooks/chats/use-cloud-chat-queries";
import { useEpicDeleteChat } from "@/hooks/epic/use-epic-chat-mutations";
import { useEpicChatIds } from "@/lib/epic-selectors";
import { selectUnfoldedCloudChats } from "@/lib/chats/unified-chat-list";
import {
  cloudChatListQueryKey,
  readCloudKnownChatIds,
} from "@/lib/chats/cloud-chat-list-cache";
import { useCloudChatDeletions } from "@/lib/chats/cloud-chat-deletions";
import { queryKeys } from "@/lib/query-keys";

const EPIC_ID = "epic-cloud-del";
const VIEWER_ID = "viewer-1";
const HOST_ID = mockLocalHostEntry.hostId;
const OTHER_USER_ID = "viewer-2";
const OTHER_HOST_ID = "host-other";

// Same wiring seam as `chat-record-freshness.test.tsx`: `useEpicDeleteChat`
// resolves its client through `useHostBinding()` / the app-wide runtime, so
// every seam has to land on the fixture's one client for the mutation's
// captured `hostId` to match the identity the cloud rows carry.
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

function record(
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

function cloudChat(args: {
  readonly identity: CloudChatSummary["identity"];
  readonly ownerHostId: string;
  readonly isOwnedByViewer: boolean;
  readonly title: string;
}): CloudChatSummary {
  return {
    identity: args.identity,
    ownerHostId: args.ownerHostId,
    isOwnedByViewer: args.isOwnedByViewer,
    title: args.title,
    createdAt: 1,
    visibility: "private",
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: null,
    publishedAt: null,
    throughRecordSeq: null,
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
      title: "Cloud deletion",
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

interface DeleteGate {
  resolve: ((publicationChatId: string | null) => void) | null;
  reject: ((error: HostRpcError) => void) | null;
}

interface Fixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly handle: OpenedStoreForTest;
  readonly listCalls: { value: number };
  readonly cloudListCalls: { value: number };
  readonly records: ChatRecordSummaryV11[];
  readonly cloudRows: CloudChatSummary[];
  readonly deleteGate: DeleteGate;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

function defaultCloudRows(): CloudChatSummary[] {
  // Three cloud rows that all resolve `chatId: "chat-1"` under the local
  // chat's own identity fields EXCEPT the one that pins the target - so a
  // suppression keyed only on `chatId` (rather than the full
  // task+owner+host+id tuple `beginCloudChatDeletion` takes) would wrongly
  // hide the collaborator's row, the other-host row, or both.
  return [
    cloudChat({
      identity: { taskId: EPIC_ID, chatId: "chat-1", ownerUserId: VIEWER_ID },
      ownerHostId: HOST_ID,
      isOwnedByViewer: true,
      title: "Mine",
    }),
    cloudChat({
      identity: {
        taskId: EPIC_ID,
        chatId: "chat-1",
        ownerUserId: OTHER_USER_ID,
      },
      ownerHostId: HOST_ID,
      isOwnedByViewer: false,
      title: "Collaborator, same host-minted id",
    }),
    cloudChat({
      identity: { taskId: EPIC_ID, chatId: "chat-2", ownerUserId: VIEWER_ID },
      ownerHostId: OTHER_HOST_ID,
      isOwnedByViewer: true,
      title: "Mine, on a different host",
    }),
  ];
}

function createFixture(
  overrides: { readonly cloudRows?: readonly CloudChatSummary[] } | undefined,
): Fixture {
  const records: ChatRecordSummaryV11[] = [
    record({ chatId: "chat-1", title: "Mine" }),
  ];
  const cloudRows: CloudChatSummary[] = [
    ...(overrides?.cloudRows ?? defaultCloudRows()),
  ];
  const listCalls = { value: 0 };
  const cloudListCalls = { value: 0 };
  const requestSeq = { value: 0 };
  const deleteGate: DeleteGate = { resolve: null, reject: null };
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
          return Promise.resolve({
            kind: "snapshot" as const,
            listStamp: null,
            chats: records.map((row) => ({ ...row })),
          });
        },
        "epic.listCloudChats": () => {
          cloudListCalls.value += 1;
          // Always answers from the same `cloudRows` array - a delete never
          // mutates it, on purpose: the cloud retraction lagging behind a
          // local delete (the "still stale" case this suite pins) is
          // exactly a refetch that keeps answering with the deleted row.
          return Promise.resolve({
            chats: cloudRows.map((row) => ({ ...row })),
          });
        },
        // Held open until the test explicitly resolves or rejects it, so
        // the PENDING window (after `onMutate`, before the RPC settles) is
        // observable.
        "epic.deleteChat": (params) =>
          new Promise((resolve, reject) => {
            deleteGate.resolve = (publicationChatId) => {
              const index = records.findIndex(
                (entry) => entry.chatId === params.chatId,
              );
              if (index >= 0) records.splice(index, 1);
              resolve({
                deleted: true,
                publicationChatId: publicationChatId ?? null,
              });
            };
            deleteGate.reject = (error) => reject(error);
          }),
      },
    }),
  });
  spine.setRequestContext(
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
  return {
    client,
    queryClient,
    handle,
    listCalls,
    cloudListCalls,
    records,
    cloudRows,
    deleteGate,
    Wrapper,
  };
}

let fixture: Fixture;

beforeEach(() => {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: VIEWER_ID, username: VIEWER_ID },
    // `useEpicDeleteChat`'s `onMutate` gates `beginCloudChatDeletion` on
    // `currentProfileUserId()`, which reads `profile.userId` - a DIFFERENT
    // field than the cache-key `contextMetadata.userId` above. Both must be
    // set to this suite's viewer or the suppression token is never minted.
    profile: {
      userId: VIEWER_ID,
      userName: VIEWER_ID,
      email: "viewer@example.com",
    },
  });
  useCloudChatDeletions.setState({ pending: new Map(), confirmed: new Set() });
  fixture = createFixture(undefined);
});

afterEach(() => {
  cleanup();
  fixture.handle.store.getState().dispose();
  runtime.client = null;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useCloudChatDeletions.setState({ pending: new Map(), confirmed: new Set() });
});

/** Renders the record channel, the cloud list, the delete mutation and the fold - as the sidebar does. */
function renderChannel() {
  return renderHook(
    () => {
      useEpicSyncChatRecords(EPIC_ID);
      const chatIds = useEpicChatIds();
      const cloudList = useCloudChatList({
        client: fixture.client,
        taskId: EPIC_ID,
        enabled: true,
      });
      const deleteChat = useEpicDeleteChat();
      const unfolded = selectUnfoldedCloudChats({
        chats: cloudList.data?.chats ?? [],
        localChatIds: chatIds,
        publicationChatIdByChatId: new Map(),
      });
      return { chatIds, cloudList, deleteChat, unfolded };
    },
    { wrapper: fixture.Wrapper },
  );
}

async function settleFirstRead(): Promise<void> {
  await waitFor(() => {
    expect(fixture.listCalls.value).toBe(1);
  });
  await waitFor(() => {
    expect(fixture.handle.store.getState().chatRecordListAuthoritative).toBe(
      true,
    );
  });
}

function ownRowVisible(chats: readonly CloudChatSummary[]): boolean {
  return chats.some(
    (chat) =>
      chat.identity.chatId === "chat-1" &&
      chat.identity.ownerUserId === VIEWER_ID &&
      chat.ownerHostId === HOST_ID,
  );
}

const OTHER_ROW_TITLES = [
  "Collaborator, same host-minted id",
  "Mine, on a different host",
].sort();

describe("cloud-chat deletion suppression", () => {
  it("hides the deleted row through the pending delete, the confirmed delete, and a refetch that still answers stale", async () => {
    const rendered = renderChannel();
    await settleFirstRead();
    await waitFor(() => {
      expect(rendered.result.current.cloudList.isSuccess).toBe(true);
    });
    expect(fixture.cloudListCalls.value).toBe(1);
    await waitFor(() => {
      expect(rendered.result.current.chatIds).toEqual(["chat-1"]);
    });

    // Before any delete: the viewer's own backup folds into the local row
    // (the local chat is still in the tree), and the two genuinely distinct
    // rows stay visible. This is the pre-bug baseline.
    expect(rendered.result.current.unfolded.map((c) => c.title).sort()).toEqual(
      OTHER_ROW_TITLES,
    );

    rendered.result.current.deleteChat.mutate({
      epicId: EPIC_ID,
      chatId: "chat-1",
      hostId: HOST_ID,
    });
    await waitFor(() => {
      expect(fixture.deleteGate.resolve).not.toBeNull();
    });

    // PENDING: `onMutate` has already marked the identity, before the RPC
    // settles - the cloud list's own filtered data excludes it, independent
    // of the fold (the local chat is still present at this point, so the
    // fold alone would already hide it too; this checks the NEW mechanism
    // directly).
    await waitFor(() => {
      expect(
        ownRowVisible(rendered.result.current.cloudList.data?.chats ?? []),
      ).toBe(false);
    });

    const callsBeforeSuccess = fixture.cloudListCalls.value;
    fixture.deleteGate.resolve?.(null);
    await waitFor(() => {
      expect(rendered.result.current.deleteChat.isSuccess).toBe(true);
    });

    // `onSuccess` now ALSO invalidates the cloud list's own query key, so a
    // mounted observer refetches automatically - and the mock server still
    // answers with row A (the cloud has not actually purged it yet, the way
    // a real retraction can lag behind a local delete). That refetch must
    // not resurrect the row: it stays hidden only because the cloud list's
    // own filtered data still excludes it (now via the CONFIRMED set rather
    // than the pending one).
    await waitFor(() => {
      expect(fixture.cloudListCalls.value).toBeGreaterThan(callsBeforeSuccess);
    });

    // The local tree has now dropped chat-1 (`applyConfirmedChatMutation`),
    // so the FOLD alone no longer has a reason to hide row A - which is
    // exactly the ghost this suite pins.
    await waitFor(() => {
      expect(rendered.result.current.chatIds).toEqual([]);
    });
    expect(
      ownRowVisible(rendered.result.current.cloudList.data?.chats ?? []),
    ).toBe(false);
    expect(rendered.result.current.unfolded.map((c) => c.title).sort()).toEqual(
      OTHER_ROW_TITLES,
    );

    // A LATER refetch (the sidebar's own 30s `staleTime`, or another
    // explicit invalidate elsewhere) - still stale, still answering with row
    // A - must not resurrect it either. Compared against the count just
    // captured rather than a hardcoded absolute, since the automatic
    // post-success invalidation above already used up one refetch.
    const callsBeforeLaterRefetch = fixture.cloudListCalls.value;
    await fixture.queryClient.invalidateQueries({
      queryKey: cloudChatListQueryKey({
        hostId: HOST_ID,
        viewerUserId: VIEWER_ID,
        taskId: EPIC_ID,
      }),
    });
    await waitFor(() => {
      expect(fixture.cloudListCalls.value).toBe(callsBeforeLaterRefetch + 1);
    });
    expect(
      ownRowVisible(rendered.result.current.cloudList.data?.chats ?? []),
    ).toBe(false);
    expect(rendered.result.current.unfolded.map((c) => c.title).sort()).toEqual(
      OTHER_ROW_TITLES,
    );
  });

  it("restores the cloud row when the delete fails, and never touches the collaborator's or the other-host row", async () => {
    const rendered = renderChannel();
    await settleFirstRead();
    await waitFor(() => {
      expect(rendered.result.current.cloudList.isSuccess).toBe(true);
    });
    expect(
      ownRowVisible(rendered.result.current.cloudList.data?.chats ?? []),
    ).toBe(true);

    rendered.result.current.deleteChat.mutate({
      epicId: EPIC_ID,
      chatId: "chat-1",
      hostId: HOST_ID,
    });
    await waitFor(() => {
      expect(fixture.deleteGate.reject).not.toBeNull();
    });
    await waitFor(() => {
      expect(
        ownRowVisible(rendered.result.current.cloudList.data?.chats ?? []),
      ).toBe(false);
    });
    // Never suppressed: neither shares the deleted identity's (task, owner,
    // host, chatId) tuple.
    expect(
      (rendered.result.current.cloudList.data?.chats ?? [])
        .map((c) => c.title)
        .sort(),
    ).toEqual(OTHER_ROW_TITLES);

    const callsBeforeReject = fixture.cloudListCalls.value;
    fixture.deleteGate.reject?.(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "delete failed",
        requestId: "req-fail",
        method: "epic.deleteChat",
        fatalDetails: null,
      }),
    );
    await waitFor(() => {
      expect(rendered.result.current.deleteChat.isError).toBe(true);
    });

    // `onError` now ALSO invalidates the cloud list's own query key, the
    // same as `onSuccess` - a host's cleanup/release can still reject
    // AFTER it already committed a tombstone, so the client can't assume a
    // failed RPC left the server-side state untouched and must go look.
    // The mock still answers from the same never-mutated `cloudRows`
    // array, so this refetch's "stale" answer happens to equal the TRUE
    // precommit state here - but the point is that it refetches at all,
    // automatically, rather than only trusting the pending mark's clear.
    await waitFor(() => {
      expect(fixture.cloudListCalls.value).toBeGreaterThan(callsBeforeReject);
    });

    // The pending mark clears WITHOUT confirming, so the row is visible
    // again - and the local chat, never removed on a failed delete, is
    // still in the tree.
    expect(
      ownRowVisible(rendered.result.current.cloudList.data?.chats ?? []),
    ).toBe(true);
    expect(rendered.result.current.chatIds).toEqual(["chat-1"]);
  });
});

// Closing the fork mapping gap: `onMutate` has no better guess than the
// LOCAL chat id (or a cached redirect, when one happens to exist) at the
// moment it mints the pending mark. The delete response now carries the
// owning host's AUTHORITATIVE answer, and `confirmCloudChatDeletion`
// replaces whatever the pending mark guessed with that - not a moved key,
// a freshly confirmed one - so a chat that forked away from its local id
// before this device ever cached the redirect is still suppressed correctly.
describe("authoritative publication identity from the delete response", () => {
  function rowVisible(
    chats: readonly CloudChatSummary[],
    identity: { readonly chatId: string; readonly ownerHostId: string },
  ): boolean {
    return chats.some(
      (chat) =>
        chat.identity.chatId === identity.chatId &&
        chat.identity.ownerUserId === VIEWER_ID &&
        chat.ownerHostId === identity.ownerHostId,
    );
  }

  it("hides the redirected clone the response names, not the local id the pending mark guessed, while the still-live original-id row on another host survives a stale refetch", async () => {
    const CLONE_ID = "clone-1";
    // No local id "chat-1" row on HOST_ID at all: after a fork this
    // device's own backup lives under the clone id, and the row still
    // carrying "chat-1" belongs to the OTHER host's lineage (the same
    // geometry `unified-chat-list.test.ts` documents).
    fixture = createFixture({
      cloudRows: [
        cloudChat({
          identity: {
            taskId: EPIC_ID,
            chatId: CLONE_ID,
            ownerUserId: VIEWER_ID,
          },
          ownerHostId: HOST_ID,
          isOwnedByViewer: true,
          title: "Mine, redirected clone",
        }),
        cloudChat({
          identity: {
            taskId: EPIC_ID,
            chatId: "chat-1",
            ownerUserId: VIEWER_ID,
          },
          ownerHostId: OTHER_HOST_ID,
          isOwnedByViewer: true,
          title: "Other host, original id (still live)",
        }),
      ],
    });

    const rendered = renderChannel();
    await settleFirstRead();
    await waitFor(() => {
      expect(rendered.result.current.cloudList.isSuccess).toBe(true);
    });
    // No cached redirect for "chat-1" anywhere - the pending mark this
    // mints below is a bare fallback to the local id, which is wrong.
    expect(
      rowVisible(rendered.result.current.cloudList.data?.chats ?? [], {
        chatId: CLONE_ID,
        ownerHostId: HOST_ID,
      }),
    ).toBe(true);
    expect(
      rowVisible(rendered.result.current.cloudList.data?.chats ?? [], {
        chatId: "chat-1",
        ownerHostId: OTHER_HOST_ID,
      }),
    ).toBe(true);

    rendered.result.current.deleteChat.mutate({
      epicId: EPIC_ID,
      chatId: "chat-1",
      hostId: HOST_ID,
    });
    await waitFor(() => {
      expect(fixture.deleteGate.resolve).not.toBeNull();
    });
    fixture.deleteGate.resolve?.(CLONE_ID);
    await waitFor(() => {
      expect(rendered.result.current.deleteChat.isSuccess).toBe(true);
    });

    // The clone is hidden - the response's identity won, not the guess.
    await waitFor(() => {
      expect(
        rowVisible(rendered.result.current.cloudList.data?.chats ?? [], {
          chatId: CLONE_ID,
          ownerHostId: HOST_ID,
        }),
      ).toBe(false);
    });
    // The other host's still-live lineage under the ORIGINAL id is
    // untouched - a suppression keyed on chatId alone (ignoring host) would
    // have hidden it too.
    expect(
      rowVisible(rendered.result.current.cloudList.data?.chats ?? [], {
        chatId: "chat-1",
        ownerHostId: OTHER_HOST_ID,
      }),
    ).toBe(true);
    expect(
      readCloudKnownChatIds(fixture.queryClient, {
        hostId: HOST_ID,
        viewerUserId: VIEWER_ID,
        taskId: EPIC_ID,
      }),
    ).toEqual(new Set(["chat-1"])); // the other-host row, read through HOST_ID's own list slot

    // A later refetch - the cloud has not actually purged the clone row yet
    // - must not resurrect it either.
    const callsBeforeRefetch = fixture.cloudListCalls.value;
    await fixture.queryClient.invalidateQueries({
      queryKey: cloudChatListQueryKey({
        hostId: HOST_ID,
        viewerUserId: VIEWER_ID,
        taskId: EPIC_ID,
      }),
    });
    await waitFor(() => {
      expect(fixture.cloudListCalls.value).toBeGreaterThan(callsBeforeRefetch);
    });
    expect(
      rowVisible(rendered.result.current.cloudList.data?.chats ?? [], {
        chatId: CLONE_ID,
        ownerHostId: HOST_ID,
      }),
    ).toBe(false);
  });

  it("overrides a STALE cached guess with the response's authoritative id", async () => {
    const CLONE_ID = "clone-correct";
    const STALE_GUESS_ID = "clone-stale-guess";
    fixture = createFixture({
      cloudRows: [
        cloudChat({
          identity: {
            taskId: EPIC_ID,
            chatId: CLONE_ID,
            ownerUserId: VIEWER_ID,
          },
          ownerHostId: HOST_ID,
          isOwnedByViewer: true,
          title: "Mine, the TRUE redirected clone",
        }),
        cloudChat({
          identity: {
            taskId: EPIC_ID,
            chatId: STALE_GUESS_ID,
            ownerUserId: VIEWER_ID,
          },
          ownerHostId: HOST_ID,
          isOwnedByViewer: true,
          title: "Mine, what a stale cache entry guessed",
        }),
      ],
    });
    // A stale (or simply wrong) cached publication-target answer for
    // "chat-1", seeded exactly as the real hook would have cached it.
    fixture.queryClient.setQueryData(
      queryKeys.hostMethod<HostRpcRegistry, "epic.listChatPublicationTargets">(
        HOST_ID,
        "epic.listChatPublicationTargets",
        { epicId: EPIC_ID, chatIds: ["chat-1"] },
      ),
      { redirected: [{ chatId: "chat-1", publicationChatId: STALE_GUESS_ID }] },
    );

    const rendered = renderChannel();
    await settleFirstRead();
    await waitFor(() => {
      expect(rendered.result.current.cloudList.isSuccess).toBe(true);
    });

    rendered.result.current.deleteChat.mutate({
      epicId: EPIC_ID,
      chatId: "chat-1",
      hostId: HOST_ID,
    });
    await waitFor(() => {
      expect(fixture.deleteGate.resolve).not.toBeNull();
    });
    // The response disagrees with the stale cache - it wins.
    fixture.deleteGate.resolve?.(CLONE_ID);
    await waitFor(() => {
      expect(rendered.result.current.deleteChat.isSuccess).toBe(true);
    });

    await waitFor(() => {
      expect(
        rowVisible(rendered.result.current.cloudList.data?.chats ?? [], {
          chatId: CLONE_ID,
          ownerHostId: HOST_ID,
        }),
      ).toBe(false);
    });
    // The stale guess's row was never the right target and stays visible.
    expect(
      rowVisible(rendered.result.current.cloudList.data?.chats ?? [], {
        chatId: STALE_GUESS_ID,
        ownerHostId: HOST_ID,
      }),
    ).toBe(true);
  });
});
