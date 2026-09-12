/**
 * The revision-GATING dispatch contract for the two record-list polls
 * (`epic.listChatRecords@1.3` / `epic.listTuiAgents@1.3`): what goes out as
 * `knownRevision`, when it moves, and when it resets to `null`.
 *
 * Mirrors `record-reads-per-session-generation.test.tsx`'s harness shape -
 * real `QueryClient`, real `HostClient` over `MockHostMessenger`, real
 * open-epic store handles via `openStoreForTest`, both real hooks mounted
 * together exactly as `EpicRecordSyncEffects` mounts them. `MockHostMessenger`
 * records every dispatch's params in its `calls` array, which is how the
 * wire payload is asserted rather than inferred from store state.
 *
 * R1-R5 drive dispatches through explicit invalidation
 * (`invalidateEpicChatRecords` / `invalidateEpicTuiAgentRecords`) rather than
 * the 20s poll interval, so no fake timers are needed. Each case asserts the
 * chat method's dispatches (the primary claim) and mirrors the same claim on
 * the terminal-agent method, since both hooks are mounted together and the
 * gating hook (`useRecordListStamp`) is shared code between them - a defect
 * in the shared seam would otherwise only show up on whichever method a case
 * happened to check. R6 is a unit test with no React at all: the
 * wire-projection layer that strips `knownRevision` for an older host.
 *
 * R8 and R9 are the other half of the contract, and the one the rest of this
 * file cannot reach: what must NOT be sent. An answer whose rows the store's
 * request-time fence held back is not a description of what this client holds,
 * so its stamp may not go out - see `record-table.ts`'s "Declining a stamp".
 * They drive a real push delta into the store from inside the RPC handler, which
 * is the only place a write genuinely lands mid-flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import type {
  RecordListRecencyPatch,
  RecordListStamp,
} from "@traycer/protocol/host/epic/record-list-revision";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { TuiAgentRecordSummaryV11 } from "@traycer/protocol/host/epic/tui-agent-records";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import {
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { prepareRequestPayload } from "@traycer-clients/shared/host-transport/ws-rpc-client";
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
import {
  invalidateEpicChatRecords,
  useEpicSyncChatRecords,
} from "@/hooks/chats/use-epic-chat-records";
import {
  invalidateEpicTuiAgentRecords,
  useEpicSyncTuiAgentRecords,
} from "@/hooks/chats/use-epic-tui-agent-records";
import { publishRecordListDeltaStamp } from "@/lib/records/record-list-delta-stamps";

const EPIC_ID = "epic-revision-gating";
const VIEWER_ID = "viewer-1";
const HOST_ID = mockLocalHostEntry.hostId;

type ChatListRequest = RequestOfMethod<HostRpcRegistry, "epic.listChatRecords">;
type ChatListResponse = ResponseOfMethod<
  HostRpcRegistry,
  "epic.listChatRecords"
>;
type TuiListRequest = RequestOfMethod<HostRpcRegistry, "epic.listTuiAgents">;
type TuiListResponse = ResponseOfMethod<HostRpcRegistry, "epic.listTuiAgents">;

// Same seam as `record-reads-per-session-generation.test.tsx`: both hooks
// read the EPIC SESSION's client via `EpicSessionHostClientContext`, but
// other host plumbing they touch indirectly still resolves through the
// app-wide runtime mock.
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
function tuiRow(overrides: Partial<TuiAgentRecordSummaryV11>) {
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
  const wire = { ...base, sessionState: null, lastExit: null };
  return base.docResident
    ? { ...wire, origin: "doc" as const }
    : { ...wire, origin: "registry" as const };
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Epic revision gating",
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

/** A fresh open-epic session, one "generation", with an empty doc replica. */
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

interface HandlerBox<Req, Res> {
  // `| Promise<Res>` so a case can hold a dispatch in flight (R8's
  // in-flight-refetch case) without every other case's synchronous handler
  // having to wrap its answer.
  impl: (params: Req) => Res | Promise<Res>;
}

interface Fixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly handle: OpenedStoreForTest;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly chatHandler: HandlerBox<ChatListRequest, ChatListResponse>;
  readonly tuiHandler: HandlerBox<TuiListRequest, TuiListResponse>;
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

/**
 * Like {@link wrapperFor}, but reads the session handle out of a mutable box
 * on every render instead of closing over a fixed one - so a caller can swap
 * `box.current` and `rerender()` the SAME mounted hook instance onto a new
 * store, exactly as a mid-life session rebuild (self-heal, clone-not-migrate)
 * re-points a mounted tab without unmounting its consumers. R7 is the one
 * case that needs this; every other case mounts once and never swaps.
 */
function wrapperForHandleBox(
  queryClient: QueryClient,
  box: { current: OpenedStoreForTest },
  client: HostClient<HostRpcRegistry>,
): (props: { readonly children: ReactNode }) => ReactNode {
  return (props) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        EpicSessionContext.Provider,
        { value: box.current },
        createElement(
          EpicSessionHostClientContext.Provider,
          { value: client },
          props.children,
        ),
      ),
    );
}

/** Mounts both real record-sync hooks together, exactly as the composer does. */
function useBothRecordSyncHooks(): void {
  useEpicSyncChatRecords(EPIC_ID);
  useEpicSyncTuiAgentRecords(EPIC_ID);
}

function createFixture(): Fixture {
  const chatHandler: HandlerBox<ChatListRequest, ChatListResponse> = {
    impl: () => ({ kind: "snapshot", listStamp: null, chats: [] }),
  };
  const tuiHandler: HandlerBox<TuiListRequest, TuiListResponse> = {
    impl: () => ({ kind: "snapshot", listStamp: null, tuiAgents: [] }),
  };
  const requestSeq = { value: 0 };
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestSeq.value += 1;
      return `req-${String(requestSeq.value)}`;
    },
    handlers: {
      "epic.listChatRecords": (params) => chatHandler.impl(params),
      "epic.listTuiAgents": (params) => tuiHandler.impl(params),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
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
    messenger,
    chatHandler,
    tuiHandler,
    Wrapper: wrapperFor(queryClient, handle, client),
  };
}

function chatCalls(
  messenger: MockHostMessenger<HostRpcRegistry>,
): ChatListRequest[] {
  return messenger.calls
    .filter((call) => call.method === "epic.listChatRecords")
    .map((call) => call.params as ChatListRequest);
}

function tuiCalls(
  messenger: MockHostMessenger<HostRpcRegistry>,
): TuiListRequest[] {
  return messenger.calls
    .filter((call) => call.method === "epic.listTuiAgents")
    .map((call) => call.params as TuiListRequest);
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

describe("R1 - the first dispatch holds nothing, and a snapshot's stamp is sent back verbatim", () => {
  it("sends knownRevision: null first, then the exact listStamp a snapshot carried", async () => {
    const chatStamp: RecordListStamp = {
      epoch: "E",
      revision: 7,
      touchRevision: 3,
    };
    const tuiStamp: RecordListStamp = {
      epoch: "F",
      revision: 4,
      touchRevision: 1,
    };
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: chatStamp,
      chats: [chatRow({ chatId: "chat-a" })],
    });
    fixture.tuiHandler.impl = () => ({
      kind: "snapshot",
      listStamp: tuiStamp,
      tuiAgents: [tuiRow({ tuiAgentId: "tui-a" })],
    });

    const view = renderHook(useBothRecordSyncHooks, {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(1);
      expect(tuiCalls(fixture.messenger)).toHaveLength(1);
    });
    expect(chatCalls(fixture.messenger)[0]?.knownRevision).toBeNull();
    expect(tuiCalls(fixture.messenger)[0]?.knownRevision).toBeNull();

    // Wait for the FIRST answer to actually be APPLIED - not merely
    // dispatched - before invalidating: `stamp.hold` runs in the same effect
    // as the apply, and a dispatch racing ahead of it would still read `null`
    // and falsify the very claim this case exists to pin.
    await waitFor(() => {
      expect(fixture.handle.store.getState().chats.allIds).toContain("chat-a");
      expect(fixture.handle.store.getState().tuiAgents.allIds).toContain(
        "tui-a",
      );
    });

    invalidateEpicChatRecords(fixture.queryClient, HOST_ID);
    invalidateEpicTuiAgentRecords(fixture.queryClient, HOST_ID);

    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(2);
      expect(tuiCalls(fixture.messenger)).toHaveLength(2);
    });
    expect(chatCalls(fixture.messenger)[1]?.knownRevision).toEqual(chatStamp);
    expect(tuiCalls(fixture.messenger)[1]?.knownRevision).toEqual(tuiStamp);

    view.unmount();
  });
});

describe("R2 - an unchanged answer's patches move only the rows they name", () => {
  it("moves the touched rows' updatedAt, retracts nothing, and leaves other rows' identity untouched", async () => {
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: { epoch: "E", revision: 1, touchRevision: 1 },
      chats: [
        chatRow({ chatId: "chat-a", revision: 1, updatedAt: 10 }),
        chatRow({ chatId: "chat-b", revision: 1, updatedAt: 10 }),
        chatRow({ chatId: "chat-c", revision: 1, updatedAt: 10 }),
      ],
    });
    fixture.tuiHandler.impl = () => ({
      kind: "snapshot",
      listStamp: { epoch: "F", revision: 1, touchRevision: 1 },
      tuiAgents: [
        tuiRow({ tuiAgentId: "tui-a", revision: 1, updatedAt: 10 }),
        tuiRow({ tuiAgentId: "tui-b", revision: 1, updatedAt: 10 }),
      ],
    });

    const view = renderHook(useBothRecordSyncHooks, {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(
        Object.keys(fixture.handle.store.getState().chats.byId).sort(),
      ).toEqual(["chat-a", "chat-b", "chat-c"]);
      expect(
        Object.keys(fixture.handle.store.getState().tuiAgents.byId).sort(),
      ).toEqual(["tui-a", "tui-b"]);
    });
    const untouchedChat = fixture.handle.store.getState().chats.byId["chat-c"];
    const untouchedTui =
      fixture.handle.store.getState().tuiAgents.byId["tui-b"];

    const chatPatches: RecordListRecencyPatch[] = [
      { id: "chat-a", ownerUserId: VIEWER_ID, updatedAt: 55, revision: 2 },
      { id: "chat-b", ownerUserId: VIEWER_ID, updatedAt: 66, revision: 2 },
    ];
    const tuiPatches: RecordListRecencyPatch[] = [
      { id: "tui-a", ownerUserId: VIEWER_ID, updatedAt: 77, revision: 2 },
    ];
    fixture.chatHandler.impl = () => ({
      kind: "unchanged",
      listStamp: { epoch: "E", revision: 1, touchRevision: 2 },
      touched: chatPatches,
    });
    fixture.tuiHandler.impl = () => ({
      kind: "unchanged",
      listStamp: { epoch: "F", revision: 1, touchRevision: 2 },
      touched: tuiPatches,
    });
    invalidateEpicChatRecords(fixture.queryClient, HOST_ID);
    invalidateEpicTuiAgentRecords(fixture.queryClient, HOST_ID);

    await waitFor(() => {
      expect(
        fixture.handle.store.getState().chats.byId["chat-a"]?.updatedAt,
      ).toBe(55);
      expect(
        fixture.handle.store.getState().tuiAgents.byId["tui-a"]?.updatedAt,
      ).toBe(77);
    });
    expect(
      fixture.handle.store.getState().chats.byId["chat-b"]?.updatedAt,
    ).toBe(66);
    // Retracts nothing: every id from the original snapshots is still present.
    expect(
      Object.keys(fixture.handle.store.getState().chats.byId).sort(),
    ).toEqual(["chat-a", "chat-b", "chat-c"]);
    expect(
      Object.keys(fixture.handle.store.getState().tuiAgents.byId).sort(),
    ).toEqual(["tui-a", "tui-b"]);
    // The untouched rows' projections are the IDENTICAL objects, not merely
    // deep-equal - an `unchanged` answer names nothing about them.
    expect(fixture.handle.store.getState().chats.byId["chat-c"]).toBe(
      untouchedChat,
    );
    expect(fixture.handle.store.getState().tuiAgents.byId["tui-b"]).toBe(
      untouchedTui,
    );

    view.unmount();
  });
});

describe("R3 - a new touchRevision is what the next dispatch carries", () => {
  it("sends the stamp from the LATEST unchanged answer, not a stale held one", async () => {
    const chatStampV1: RecordListStamp = {
      epoch: "E",
      revision: 1,
      touchRevision: 1,
    };
    const tuiStampV1: RecordListStamp = {
      epoch: "F",
      revision: 1,
      touchRevision: 1,
    };
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: chatStampV1,
      chats: [chatRow({ chatId: "chat-a" })],
    });
    fixture.tuiHandler.impl = () => ({
      kind: "snapshot",
      listStamp: tuiStampV1,
      tuiAgents: [tuiRow({ tuiAgentId: "tui-a" })],
    });

    const view = renderHook(useBothRecordSyncHooks, {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(1);
      expect(tuiCalls(fixture.messenger)).toHaveLength(1);
    });
    // Wait for the first answer to be APPLIED (see R1) before invalidating,
    // or the second dispatch can race ahead of `stamp.hold` and read `null`.
    await waitFor(() => {
      expect(fixture.handle.store.getState().chats.allIds).toContain("chat-a");
      expect(fixture.handle.store.getState().tuiAgents.allIds).toContain(
        "tui-a",
      );
    });

    const chatStampV2: RecordListStamp = {
      epoch: "E",
      revision: 1,
      touchRevision: 2,
    };
    const tuiStampV2: RecordListStamp = {
      epoch: "F",
      revision: 1,
      touchRevision: 2,
    };
    // Carries a patch too, so the answer's APPLICATION (not just its
    // dispatch) is independently observable through the store - needed to
    // sequence the THIRD invalidate below after this answer actually landed.
    fixture.chatHandler.impl = () => ({
      kind: "unchanged",
      listStamp: chatStampV2,
      touched: [
        { id: "chat-a", ownerUserId: VIEWER_ID, updatedAt: 123, revision: 2 },
      ],
    });
    fixture.tuiHandler.impl = () => ({
      kind: "unchanged",
      listStamp: tuiStampV2,
      touched: [
        { id: "tui-a", ownerUserId: VIEWER_ID, updatedAt: 123, revision: 2 },
      ],
    });
    invalidateEpicChatRecords(fixture.queryClient, HOST_ID);
    invalidateEpicTuiAgentRecords(fixture.queryClient, HOST_ID);
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(2);
      expect(tuiCalls(fixture.messenger)).toHaveLength(2);
    });
    expect(chatCalls(fixture.messenger)[1]?.knownRevision).toEqual(chatStampV1);
    expect(tuiCalls(fixture.messenger)[1]?.knownRevision).toEqual(tuiStampV1);
    // Wait for the SECOND answer to be applied before invalidating a third
    // time, for the same race reason as above.
    await waitFor(() => {
      expect(
        fixture.handle.store.getState().chats.byId["chat-a"]?.updatedAt,
      ).toBe(123);
      expect(
        fixture.handle.store.getState().tuiAgents.byId["tui-a"]?.updatedAt,
      ).toBe(123);
    });

    invalidateEpicChatRecords(fixture.queryClient, HOST_ID);
    invalidateEpicTuiAgentRecords(fixture.queryClient, HOST_ID);
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(3);
      expect(tuiCalls(fixture.messenger)).toHaveLength(3);
    });
    // The THIRD dispatch must carry the stamp the SECOND answer just gave,
    // not the one the first snapshot gave.
    expect(chatCalls(fixture.messenger)[2]?.knownRevision).toEqual(chatStampV2);
    expect(tuiCalls(fixture.messenger)[2]?.knownRevision).toEqual(tuiStampV2);

    view.unmount();
  });
});

describe("R4 - a snapshot with no revision to report keeps the client on knownRevision: null", () => {
  it("holds null after a snapshot whose listStamp is null (the @1.2 upgrade path)", async () => {
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: null,
      chats: [chatRow({ chatId: "chat-a" })],
    });
    fixture.tuiHandler.impl = () => ({
      kind: "snapshot",
      listStamp: null,
      tuiAgents: [tuiRow({ tuiAgentId: "tui-a" })],
    });

    const view = renderHook(useBothRecordSyncHooks, {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(1);
      expect(tuiCalls(fixture.messenger)).toHaveLength(1);
    });
    expect(chatCalls(fixture.messenger)[0]?.knownRevision).toBeNull();
    expect(tuiCalls(fixture.messenger)[0]?.knownRevision).toBeNull();

    invalidateEpicChatRecords(fixture.queryClient, HOST_ID);
    invalidateEpicTuiAgentRecords(fixture.queryClient, HOST_ID);
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(2);
      expect(tuiCalls(fixture.messenger)).toHaveLength(2);
    });
    // Still `null`: the `@1.2` peer never gave this client a revision to
    // hold, so every dispatch keeps asking for a full snapshot - today's
    // behaviour, preserved.
    expect(chatCalls(fixture.messenger)[1]?.knownRevision).toBeNull();
    expect(tuiCalls(fixture.messenger)[1]?.knownRevision).toBeNull();

    view.unmount();
  });
});

describe("R5 - an epic reopen starts the new generation on knownRevision: null", () => {
  it("does not carry the previous generation's held stamp into a fresh store", async () => {
    const chatStamp: RecordListStamp = {
      epoch: "E",
      revision: 9,
      touchRevision: 1,
    };
    const tuiStamp: RecordListStamp = {
      epoch: "F",
      revision: 9,
      touchRevision: 1,
    };
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: chatStamp,
      chats: [chatRow({ chatId: "chat-a" })],
    });
    fixture.tuiHandler.impl = () => ({
      kind: "snapshot",
      listStamp: tuiStamp,
      tuiAgents: [tuiRow({ tuiAgentId: "tui-a" })],
    });

    const viewA = renderHook(useBothRecordSyncHooks, {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(1);
      expect(tuiCalls(fixture.messenger)).toHaveLength(1);
    });
    expect(chatCalls(fixture.messenger)[0]?.knownRevision).toBeNull();
    expect(tuiCalls(fixture.messenger)[0]?.knownRevision).toBeNull();

    // Park: unmount and release generation A's session.
    viewA.unmount();
    fixture.handle.store.getState().dispose();

    // Show: generation B, a brand-new session/store.
    const handleB = newSession();
    const WrapperB = wrapperFor(fixture.queryClient, handleB, fixture.client);
    renderHook(useBothRecordSyncHooks, { wrapper: WrapperB });

    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(2);
      expect(tuiCalls(fixture.messenger)).toHaveLength(2);
    });
    // Generation B's cache entry is fresh (a different `fenceIdentity`), so
    // its first dispatch must not inherit generation A's held stamp.
    expect(chatCalls(fixture.messenger)[1]?.knownRevision).toBeNull();
    expect(tuiCalls(fixture.messenger)[1]?.knownRevision).toBeNull();

    handleB.store.getState().dispose();
  });
});

describe("R6 - an older host never sees the field at all", () => {
  it("strips knownRevision when projecting onto a @1.2 epic.listChatRecords peer", () => {
    const request: ChatListRequest = {
      epicId: EPIC_ID,
      hasDocReplica: false,
      knownRevision: { epoch: "E", revision: 1, touchRevision: 1 },
    };
    const prepared = prepareRequestPayload(
      hostRpcRegistry["epic.listChatRecords"],
      { major: 1, minor: 3 },
      { major: 1, minor: 2 },
      request,
      "req-old-chat-host",
      "epic.listChatRecords",
    );
    expect(Object.hasOwn(prepared.onWirePayload, "knownRevision")).toBe(false);
  });

  it("strips knownRevision when projecting onto a @1.2 epic.listTuiAgents peer", () => {
    const request: TuiListRequest = {
      epicId: EPIC_ID,
      hasDocReplica: false,
      knownRevision: { epoch: "E", revision: 1, touchRevision: 1 },
    };
    const prepared = prepareRequestPayload(
      hostRpcRegistry["epic.listTuiAgents"],
      { major: 1, minor: 3 },
      { major: 1, minor: 2 },
      request,
      "req-old-tui-host",
      "epic.listTuiAgents",
    );
    expect(Object.hasOwn(prepared.onWirePayload, "knownRevision")).toBe(false);
  });
});

describe("R7 - a session-handle swap under a MOUNTED hook also resets to null", () => {
  it("drops the previous handle's held stamp when EpicSessionContext re-points the same hook instance, with no remount", async () => {
    // Distinct from R5: R5 proves a FRESH hook instance starts at `null`,
    // which a plain ref (no identity check at all) would also satisfy. This
    // case exercises the identity comparison itself, inside a hook instance
    // that never unmounts - the self-heal / clone-not-migrate re-point that
    // swaps a mounted tab's session handle out from under its consumers.
    const stamp: RecordListStamp = {
      epoch: "E",
      revision: 5,
      touchRevision: 1,
    };
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: stamp,
      chats: [chatRow({ chatId: "chat-a" })],
    });
    fixture.tuiHandler.impl = () => ({
      kind: "snapshot",
      listStamp: stamp,
      tuiAgents: [tuiRow({ tuiAgentId: "tui-a" })],
    });

    const handleBox: { current: OpenedStoreForTest } = {
      current: fixture.handle,
    };
    const WrapperBox = wrapperForHandleBox(
      fixture.queryClient,
      handleBox,
      fixture.client,
    );

    const view = renderHook(useBothRecordSyncHooks, { wrapper: WrapperBox });

    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(1);
      expect(tuiCalls(fixture.messenger)).toHaveLength(1);
    });
    expect(chatCalls(fixture.messenger)[0]?.knownRevision).toBeNull();
    expect(tuiCalls(fixture.messenger)[0]?.knownRevision).toBeNull();

    // Wait for the snapshot to be APPLIED (see R1) before swapping the
    // handle, so the swap cannot race ahead of `stamp.hold`.
    await waitFor(() => {
      expect(fixture.handle.store.getState().chats.allIds).toContain("chat-a");
      expect(fixture.handle.store.getState().tuiAgents.allIds).toContain(
        "tui-a",
      );
    });

    // Re-point the SAME mounted hooks onto a brand-new store - no unmount,
    // no fresh `renderHook`. The new generation's `fenceIdentity` differs, so
    // the cache key changes and TanStack mounts a fresh query on its own -
    // exactly as generation B's first read in R5 needs no explicit
    // invalidation either.
    const newHandle = newSession();
    handleBox.current = newHandle;
    view.rerender();

    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(2);
      expect(tuiCalls(fixture.messenger)).toHaveLength(2);
    });
    // The new store generation's rows are not the ones the OLD handle's held
    // stamp describes, so the next dispatch must ask for a snapshot again -
    // this is the identity check inside `useRecordListStamp.read()`, not
    // merely "a fresh ref starts empty".
    expect(chatCalls(fixture.messenger)[1]?.knownRevision).toBeNull();
    expect(tuiCalls(fixture.messenger)[1]?.knownRevision).toBeNull();

    view.unmount();
    newHandle.store.getState().dispose();
  });
});

describe("R8 - an answer the store did not take whole does not license `unchanged`", () => {
  it("returns to knownRevision: null after a delta fence-skips the answer's copy of a row, and the next snapshot states the home", async () => {
    // THE MOST REACHABLE VARIANT, end to end: one push delta racing one
    // in-flight poll, no lost frame and no unusual timing. The answer carries
    // the row at the SAME revision the delta did - a fresher read of the same
    // registry row, not a staler one - so rule 1's carried half skips it before
    // the `docResident: null` waiver that exists to let exactly this answer
    // state the home can be reached.
    //
    // What must NOT happen: the stamp being held anyway. Every later poll then
    // answers `unchanged`, the home stays unknown, and `routeChatWrite` reports
    // the chat as unadopted - rename, archive, reparent and delete closed for
    // the life of the session.
    const stampBefore: RecordListStamp = {
      epoch: "E",
      revision: 4,
      touchRevision: 1,
    };
    const stampAfter: RecordListStamp = {
      epoch: "E",
      revision: 5,
      touchRevision: 1,
    };
    const stampRepaired: RecordListStamp = {
      epoch: "E",
      revision: 6,
      touchRevision: 1,
    };
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: stampBefore,
      chats: [chatRow({ chatId: "chat-seed" })],
    });

    const view = renderHook(useBothRecordSyncHooks, {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => {
      expect(fixture.handle.store.getState().chats.allIds).toContain(
        "chat-seed",
      );
    });

    // The second dispatch: the owning host's `upsert` for a chat the user just
    // created lands IN FLIGHT (applied from inside the handler, which runs
    // after `captureRequestContext` has read the fence). The stream row cannot
    // state the home and nothing is held to carry one from, so the row is
    // seeded `docResident: null`.
    const deltaSent = { value: false };
    fixture.chatHandler.impl = () => {
      if (!deltaSent.value) {
        deltaSent.value = true;
        const { docResident: _home, ...streamRow } = chatRow({
          chatId: "chat-new",
          revision: 9,
        });
        fixture.handle.store.getState().applyChatRecordDelta({
          kind: "upsert",
          epicId: EPIC_ID,
          record: streamRow,
        });
      }
      return {
        kind: "snapshot",
        listStamp: stampAfter,
        chats: [
          chatRow({ chatId: "chat-seed" }),
          // The home, stated, at the revision the delta already carried.
          chatRow({ chatId: "chat-new", revision: 9, docResident: false }),
        ],
      };
    };
    invalidateEpicChatRecords(fixture.queryClient, HOST_ID);
    // The barrier, and a claim in its own right: waiting on the projected
    // INCOMPLETE counter is what proves the second answer was applied (a
    // `chats.allIds` wait would be satisfied by the delta alone, and the
    // invalidate below would then cancel the very answer this case is about).
    //
    // It also pins the delivery. This apply changes no slice - the seed row is
    // re-served at its own revision and rejected by rule 2, the new row is
    // fence-skipped - so the change gate holds and the ONLY thing that reaches
    // the main thread is the counter itself.
    await waitFor(() => {
      expect(fixture.handle.store.getState().chatSnapshotIncompleteSeq).toBe(1);
    });
    expect(chatCalls(fixture.messenger)[1]?.knownRevision).toEqual(stampBefore);
    // The fence skipped the answer's copy, so the home is still unknown.
    expect(
      fixture.handle.store.getState().chats.byId["chat-new"]?.docResident,
    ).toBeNull();

    // THE CLAIM. This answer's rows are not the rows the store holds, so its
    // stamp is not this client's to send.
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: stampRepaired,
      chats: [
        chatRow({ chatId: "chat-seed" }),
        chatRow({ chatId: "chat-new", revision: 9, docResident: false }),
      ],
    });
    invalidateEpicChatRecords(fixture.queryClient, HOST_ID);
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(3);
    });
    expect(chatCalls(fixture.messenger)[2]?.knownRevision).toBeNull();

    // Which makes the repair real rather than merely permitted: the snapshot
    // that answer forces has a current fence, so the home lands.
    await waitFor(() => {
      expect(
        fixture.handle.store.getState().chats.byId["chat-new"]?.docResident,
      ).toBe(false);
    });

    // Self-healing ONCE. A complete apply is held again, so the gating that
    // costs this one extra snapshot is not disabled for the session.
    invalidateEpicChatRecords(fixture.queryClient, HOST_ID);
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(4);
    });
    expect(chatCalls(fixture.messenger)[3]?.knownRevision).toEqual(
      stampRepaired,
    );

    view.unmount();
  });
});

describe("R9 - the terminal twin: a racing tuiUpsert also declines the stamp", () => {
  it("returns to knownRevision: null, so the snapshot that states the session facet is not suppressed", async () => {
    // The same race on the terminal plane, and the reason it is worth its own
    // case: `tui-agent-record-table.ts` carries `sessionState` / `lastExit`
    // forward from the held row, and for an agent never held that is `null` -
    // "this host cannot know". A suppressed snapshot leaves it there, and a
    // REAPED AGENT THEN READS AS ABSENT rather than as asleep and resumable,
    // which is the original symptom this epic exists to fix.
    //
    // `TerminalAgentsSlice` now carries the facet, so this pins both halves:
    // the step that decides it (the next dispatch asks for a snapshot) and the
    // value that step delivers (the repaired snapshot's `sleeping` reaching
    // the slice).
    const stampBefore: RecordListStamp = {
      epoch: "F",
      revision: 4,
      touchRevision: 1,
    };
    const stampAfter: RecordListStamp = {
      epoch: "F",
      revision: 5,
      touchRevision: 1,
    };
    fixture.tuiHandler.impl = () => ({
      kind: "snapshot",
      listStamp: stampBefore,
      tuiAgents: [tuiRow({ tuiAgentId: "tui-seed" })],
    });

    const view = renderHook(useBothRecordSyncHooks, {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => {
      expect(fixture.handle.store.getState().tuiAgents.allIds).toContain(
        "tui-seed",
      );
    });

    const deltaSent = { value: false };
    fixture.tuiHandler.impl = () => {
      if (!deltaSent.value) {
        deltaSent.value = true;
        const {
          sessionState: _state,
          lastExit: _exit,
          ...streamRow
        } = tuiRow({ tuiAgentId: "tui-new", revision: 9 });
        fixture.handle.store.getState().applyTuiAgentRecordDelta({
          kind: "tuiUpsert",
          epicId: EPIC_ID,
          record: streamRow,
          // NOT STATED, which is what a pre-`@1.4` frame carries and what
          // makes this the racing case: a `@1.4` frame would state the facet
          // outright and the answer would have nothing left to repair.
          sessionFacet: null,
        });
      }
      return {
        kind: "snapshot",
        listStamp: stampAfter,
        tuiAgents: [
          tuiRow({ tuiAgentId: "tui-seed" }),
          // The answer that would have stated the facet, at the same revision
          // the delta already carried.
          {
            ...tuiRow({ tuiAgentId: "tui-new", revision: 9 }),
            sessionState: "sleeping" as const,
          },
        ],
      };
    };
    invalidateEpicTuiAgentRecords(fixture.queryClient, HOST_ID);
    // The projected counter is the barrier here for the reason the chat twin
    // gives: an `allIds` wait is satisfied by the delta alone, and invalidating
    // on it cancels the in-flight answer this case is about.
    await waitFor(() => {
      expect(
        fixture.handle.store.getState().tuiAgentSnapshotIncompleteSeq,
      ).toBe(1);
    });
    expect(tuiCalls(fixture.messenger)[1]?.knownRevision).toEqual(stampBefore);

    invalidateEpicTuiAgentRecords(fixture.queryClient, HOST_ID);
    await waitFor(() => {
      expect(tuiCalls(fixture.messenger)).toHaveLength(3);
    });
    expect(tuiCalls(fixture.messenger)[2]?.knownRevision).toBeNull();

    // And the repair lands the facet. The snapshot that the dropped stamp
    // forces is answered with the row stated, and `sleeping` reaches the
    // slice - the agent reads as asleep and resumable rather than absent,
    // which is the symptom itself and not merely the step that decides it.
    //
    // At revision 10 here only to keep this case about the STAMP. The
    // equal-revision answer lands too, via the facet waiver in
    // `tuiAgentRowSupersedes` - that is the second half of the same repair
    // and `record-table-incomplete-apply.test.ts`'s I2 pins it directly, at
    // the revision the delta actually seeded.
    fixture.tuiHandler.impl = () => ({
      kind: "snapshot",
      listStamp: { epoch: "F", revision: 6, touchRevision: 1 },
      tuiAgents: [
        tuiRow({ tuiAgentId: "tui-seed" }),
        {
          ...tuiRow({ tuiAgentId: "tui-new", revision: 10 }),
          sessionState: "sleeping" as const,
          lastExit: "reaped" as const,
        },
      ],
    });
    invalidateEpicTuiAgentRecords(fixture.queryClient, HOST_ID);
    await waitFor(() => {
      expect(
        fixture.handle.store.getState().tuiAgents.byId["tui-new"]?.sessionState,
      ).toBe("sleeping");
    });
    expect(
      fixture.handle.store.getState().tuiAgents.byId["tui-new"]?.lastExit,
    ).toBe("reaped");

    view.unmount();
  });
});

/**
 * R10 - `useRecordListStreamStamp` keeps a held stamp current from the PUSH
 * channel (`publishRecordListDeltaStamp`), so an ordinary change stops costing
 * a snapshot. Reuses R1-R7's harness verbatim: the same fixture, the same real
 * hooks, the same `chatCalls`/`tuiCalls` dispatch log - the only new
 * ingredient is publishing directly onto the per-epic channel the mount would
 * otherwise announce on, since this file has no `ChatRecordsStreamMount`
 * mounted.
 *
 * Downstream of R8/R9, and the pairing is the point: those two decide when a
 * stamp may be HELD at all, and this one advances a held stamp without a read.
 * A stamp this client should have dropped is a stamp the push channel would
 * then keep alive indefinitely.
 */
describe("R10 - the push stream's stamp", () => {
  it("advances the held stamp on the immediate successor, with no refetch, and the next dispatch carries it", async () => {
    const chatStamp: RecordListStamp = {
      epoch: "E",
      revision: 1,
      touchRevision: 3,
    };
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: chatStamp,
      chats: [chatRow({ chatId: "chat-a" })],
    });

    const view = renderHook(useBothRecordSyncHooks, {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(fixture.handle.store.getState().chats.allIds).toContain("chat-a");
    });

    // The immediate successor: same epoch, `held.revision + 1`.
    publishRecordListDeltaStamp(EPIC_ID, { epoch: "E", revision: 2 });
    // No refetch fires from the publish alone - `publish` is synchronous, so
    // if a refetch had been queued it would already have been dispatched by
    // the time this assertion runs.
    expect(chatCalls(fixture.messenger)).toHaveLength(1);

    invalidateEpicChatRecords(fixture.queryClient, HOST_ID);
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(2);
    });
    // The advanced revision, with `touchRevision` carried through UNCHANGED -
    // the delta reports a list change, never a quiet write.
    expect(chatCalls(fixture.messenger)[1]?.knownRevision).toEqual({
      epoch: "E",
      revision: 2,
      touchRevision: 3,
    });

    view.unmount();
  });

  it("advances the TERMINAL-AGENT plane's held stamp from a delta announced for the SAME epic - the per-epic channel, not a per-plane one", async () => {
    // The channel is per (viewer, epic), not per list method: both planes
    // answer with the same composite revision, so one announcement - whatever
    // kind of row actually changed - must move BOTH held stamps.
    const tuiStamp: RecordListStamp = {
      epoch: "F",
      revision: 1,
      touchRevision: 1,
    };
    fixture.tuiHandler.impl = () => ({
      kind: "snapshot",
      listStamp: tuiStamp,
      tuiAgents: [tuiRow({ tuiAgentId: "tui-a" })],
    });

    renderHook(useBothRecordSyncHooks, { wrapper: fixture.Wrapper });
    await waitFor(() => {
      expect(tuiCalls(fixture.messenger)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(fixture.handle.store.getState().tuiAgents.allIds).toContain(
        "tui-a",
      );
    });

    publishRecordListDeltaStamp(EPIC_ID, { epoch: "F", revision: 2 });

    invalidateEpicTuiAgentRecords(fixture.queryClient, HOST_ID);
    await waitFor(() => {
      expect(tuiCalls(fixture.messenger)).toHaveLength(2);
    });
    expect(tuiCalls(fixture.messenger)[1]?.knownRevision).toEqual({
      epoch: "F",
      revision: 2,
      touchRevision: 1,
    });
  });

  it("triggers exactly one refetch for a delta at held + 2 - a gap, not a jump to follow", async () => {
    const chatStamp: RecordListStamp = {
      epoch: "E",
      revision: 1,
      touchRevision: 1,
    };
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: chatStamp,
      chats: [chatRow({ chatId: "chat-a" })],
    });

    renderHook(useBothRecordSyncHooks, { wrapper: fixture.Wrapper });
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(fixture.handle.store.getState().chats.allIds).toContain("chat-a");
    });

    // A gap: `held.revision + 2`, not the immediate successor. The in-between
    // change is exactly what this client has no other way to learn about, so
    // the rule must re-read rather than silently skip it.
    publishRecordListDeltaStamp(EPIC_ID, { epoch: "E", revision: 3 });

    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(2);
    });
    // Settle and assert no THIRD dispatch follows from the same publish.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chatCalls(fixture.messenger)).toHaveLength(2);
  });

  it("triggers exactly one refetch when the epoch differs, even though the revision happens to equal held + 1", async () => {
    const chatStamp: RecordListStamp = {
      epoch: "E",
      revision: 1,
      touchRevision: 1,
    };
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: chatStamp,
      chats: [chatRow({ chatId: "chat-a" })],
    });

    renderHook(useBothRecordSyncHooks, { wrapper: fixture.Wrapper });
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(fixture.handle.store.getState().chats.allIds).toContain("chat-a");
    });

    // Revisions from two epochs do not compare - this is a host restart or a
    // re-hydrate, not "the very next change", however the bare number reads.
    publishRecordListDeltaStamp(EPIC_ID, { epoch: "OTHER-EPOCH", revision: 2 });

    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(2);
    });
    expect(chatCalls(fixture.messenger)[1]?.knownRevision).toBeNull();
  });

  it("a plane holding null ignores a delta entirely: no refetch, nothing held", async () => {
    // The `@1.2` upgrade path (R4): a snapshot with no revision to report
    // leaves the plane on `knownRevision: null`, which already asks for a
    // snapshot on every dispatch - a delta has nothing to tell it.
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: null,
      chats: [chatRow({ chatId: "chat-a" })],
    });

    renderHook(useBothRecordSyncHooks, { wrapper: fixture.Wrapper });
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(fixture.handle.store.getState().chats.allIds).toContain("chat-a");
    });

    publishRecordListDeltaStamp(EPIC_ID, { epoch: "E", revision: 2 });
    // Settle any microtask a (wrongly) queued refetch would need.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chatCalls(fixture.messenger)).toHaveLength(1);

    invalidateEpicChatRecords(fixture.queryClient, HOST_ID);
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(2);
    });
    expect(chatCalls(fixture.messenger)[1]?.knownRevision).toBeNull();
  });

  it("a second delta arriving while the gap's refetch is still in flight triggers no further refetch - the stamp was dropped", async () => {
    const chatStamp: RecordListStamp = {
      epoch: "E",
      revision: 1,
      touchRevision: 1,
    };
    const refetchLatch: { resolve: (() => void) | null } = { resolve: null };
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: chatStamp,
      chats: [chatRow({ chatId: "chat-a" })],
    });

    renderHook(useBothRecordSyncHooks, { wrapper: fixture.Wrapper });
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(fixture.handle.store.getState().chats.allIds).toContain("chat-a");
    });

    // The refetch this gap triggers will hang until `refetchLatch.resolve` runs.
    fixture.chatHandler.impl = () =>
      new Promise((resolve) => {
        refetchLatch.resolve = () => {
          resolve({
            kind: "snapshot",
            listStamp: { epoch: "E", revision: 3, touchRevision: 1 },
            chats: [chatRow({ chatId: "chat-a" })],
          });
        };
      });

    publishRecordListDeltaStamp(EPIC_ID, { epoch: "E", revision: 3 });
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(2);
    });
    expect(refetchLatch.resolve).not.toBeNull();

    // A second delta lands while the first refetch is still in flight. The
    // stamp was already dropped to `null` by the first one, so this must find
    // `currentStamp === null` and do nothing - no third dispatch.
    publishRecordListDeltaStamp(EPIC_ID, { epoch: "E", revision: 4 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chatCalls(fixture.messenger)).toHaveLength(2);

    refetchLatch.resolve?.();
    await waitFor(() => {
      expect(
        fixture.handle.store.getState().chats.byId["chat-a"],
      ).toBeDefined();
    });
    // Still exactly two dispatches once the in-flight refetch resolves.
    expect(chatCalls(fixture.messenger)).toHaveLength(2);
  });

  it("does not advance a stamp the store's incomplete apply already invalidated - the push channel cannot launder a dropped stamp", async () => {
    // THE SEAM BETWEEN R8 AND THIS SUITE, and the one neither covers alone.
    // R8 proves an incomplete apply makes the next DISPATCH send `null`. This
    // proves the push channel cannot undo that: a delta arriving in between
    // finds `read()` already refusing the stamp and so has nothing to move,
    // and the snapshot R8's decline buys is still asked for.
    //
    // Without it the two mechanisms compose into the failure neither has on
    // its own - a stamp dropped for an incomplete apply, then re-advanced by
    // the very next delta and sent as though it described rows this client
    // holds. Ablating the counter check in `read` fails exactly here, with
    // `{E, 6}` going out in place of `null`.
    const stampBefore: RecordListStamp = {
      epoch: "E",
      revision: 4,
      touchRevision: 1,
    };
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: stampBefore,
      chats: [chatRow({ chatId: "chat-seed" })],
    });

    const view = renderHook(useBothRecordSyncHooks, {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => {
      expect(fixture.handle.store.getState().chats.allIds).toContain(
        "chat-seed",
      );
    });

    // Same race as R8: a delta lands from inside the handler, so the answer's
    // copy of the row is held back by the request-time fence.
    const deltaSent = { value: false };
    fixture.chatHandler.impl = () => {
      if (!deltaSent.value) {
        deltaSent.value = true;
        const { docResident: _home, ...streamRow } = chatRow({
          chatId: "chat-new",
          revision: 9,
        });
        fixture.handle.store.getState().applyChatRecordDelta({
          kind: "upsert",
          epicId: EPIC_ID,
          record: streamRow,
        });
      }
      return {
        kind: "snapshot",
        listStamp: { epoch: "E", revision: 5, touchRevision: 1 },
        chats: [
          chatRow({ chatId: "chat-seed" }),
          chatRow({ chatId: "chat-new", revision: 9, docResident: false }),
        ],
      };
    };
    invalidateEpicChatRecords(fixture.queryClient, HOST_ID);
    await waitFor(() => {
      expect(fixture.handle.store.getState().chatSnapshotIncompleteSeq).toBe(1);
    });

    // The immediate successor of the stamp that answer carried. Under a
    // re-binding `advance` this would be held as `{E, 6}` and sent.
    publishRecordListDeltaStamp(EPIC_ID, { epoch: "E", revision: 6 });

    invalidateEpicChatRecords(fixture.queryClient, HOST_ID);
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(3);
    });
    // THE CLAIM: still `null`. The delta moved nothing, because there was no
    // valid stamp for it to move.
    expect(chatCalls(fixture.messenger)[2]?.knownRevision).toBeNull();

    view.unmount();
  });
});

/**
 * R11 - a REMOTE CREATE between polls, end to end.
 *
 * The case R8-R10 leave open, and the one that needs no race at all: no
 * in-flight poll, no lost frame, no unusual timing. Another window or an A2A
 * agent creates a chat; its `@1.4` `upsert` arrives stamped with the exact
 * successor of the revision this client holds.
 *
 * Every mechanism then behaves correctly and the result is still wrong. The
 * delta is applied whole (no fence skipped anything, so `snapshotIncompleteSeq`
 * does not move), the revision IS contiguous (so R10 advances the stamp), and
 * every later poll answers `unchanged`. The chat's home is never stated, and
 * `routeChatWrite` reads `docResident: null` as "unavailable" - rename,
 * archive, reparent and delete closed on it for the life of the session,
 * behind copy that says it is not adopted.
 *
 * What closes it is that a delta INTRODUCING a row it cannot fully state is
 * itself an incomplete apply, counted separately (`deltaIncompleteSeq`) and
 * repaired by the GAP RULE rather than by the dispatch comparison - a delta
 * has no dispatch to bind a stamp to.
 */
describe("R11 - a delta that introduces an unstated row declines the stamp", () => {
  it("re-reads once, the snapshot states the home, and the stamp advances normally after", async () => {
    const stampBefore: RecordListStamp = {
      epoch: "E",
      revision: 4,
      touchRevision: 1,
    };
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: stampBefore,
      chats: [chatRow({ chatId: "chat-seed" })],
    });

    const view = renderHook(useBothRecordSyncHooks, {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => {
      expect(fixture.handle.store.getState().chats.allIds).toContain(
        "chat-seed",
      );
    });
    expect(chatCalls(fixture.messenger)).toHaveLength(1);

    // The answer the forced re-read will get: both chats, the new one with
    // its home stated at last.
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: { epoch: "E", revision: 5, touchRevision: 1 },
      chats: [
        chatRow({ chatId: "chat-seed" }),
        chatRow({ chatId: "chat-new", revision: 9, docResident: false }),
      ],
    });

    // THE REMOTE CREATE. Applied first, then the stamp announced - exactly
    // the order `ChatRecordsStreamMount` uses.
    const { docResident: _home, ...streamRow } = chatRow({
      chatId: "chat-new",
      revision: 9,
    });
    fixture.handle.store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: streamRow,
    });
    publishRecordListDeltaStamp(EPIC_ID, { epoch: "E", revision: 5 });

    // The row is here and its home is unknown - the state the whole case is
    // about.
    await waitFor(() => {
      expect(fixture.handle.store.getState().chats.allIds).toContain(
        "chat-new",
      );
    });

    // THE CLAIM. One re-read, asking for a full snapshot rather than
    // reporting the revision the delta just advanced to.
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(2);
    });
    expect(chatCalls(fixture.messenger)[1]?.knownRevision).toBeNull();

    // And it lands, which is what makes the chat writable again.
    await waitFor(() => {
      expect(
        fixture.handle.store.getState().chats.byId["chat-new"]?.docResident,
      ).toBe(false);
    });

    // Self-healing ONCE: the repaired snapshot was a complete apply, so the
    // gating is back on and the next dispatch carries its stamp.
    invalidateEpicChatRecords(fixture.queryClient, HOST_ID);
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(3);
    });
    expect(chatCalls(fixture.messenger)[2]?.knownRevision).toEqual({
      epoch: "E",
      revision: 5,
      touchRevision: 1,
    });

    view.unmount();
  });

  it("a delta carrying a KNOWN home forward costs no snapshot", async () => {
    // The steady state, and the saving this epic exists for. If this
    // re-read, every rename on every chat would cost a full list.
    const stampBefore: RecordListStamp = {
      epoch: "E",
      revision: 4,
      touchRevision: 1,
    };
    fixture.chatHandler.impl = () => ({
      kind: "snapshot",
      listStamp: stampBefore,
      chats: [chatRow({ chatId: "chat-a", docResident: false })],
    });

    const view = renderHook(useBothRecordSyncHooks, {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => {
      expect(fixture.handle.store.getState().chats.allIds).toContain("chat-a");
    });
    expect(chatCalls(fixture.messenger)).toHaveLength(1);

    const { docResident: _home, ...streamRow } = chatRow({
      chatId: "chat-a",
      revision: 9,
      title: "renamed",
    });
    fixture.handle.store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: streamRow,
    });
    publishRecordListDeltaStamp(EPIC_ID, { epoch: "E", revision: 5 });

    // No re-read: the home rode forward, so the representation stayed whole.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chatCalls(fixture.messenger)).toHaveLength(1);

    // And the advanced stamp is what the next dispatch carries.
    invalidateEpicChatRecords(fixture.queryClient, HOST_ID);
    await waitFor(() => {
      expect(chatCalls(fixture.messenger)).toHaveLength(2);
    });
    expect(chatCalls(fixture.messenger)[1]?.knownRevision).toEqual({
      epoch: "E",
      revision: 5,
      touchRevision: 1,
    });

    view.unmount();
  });
});
