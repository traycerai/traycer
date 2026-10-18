import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { ReactNode } from "react";
import { createElement } from "react";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    message: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  }),
}));

vi.mock("@/lib/host/runtime", async () => {
  const { HostRpcError } =
    await import("@traycer-clients/shared/host-transport/host-messenger");
  return {
    useHostClient: () => ({
      // `epic.deleteChat` names no host on the wire, so the delete hook reads
      // the client's own host to scope its session teardown.
      getActiveHostId: () => "host-test",
      request: () =>
        Promise.reject(
          new HostRpcError({
            code: "RPC_ERROR",
            message: "test",
            requestId: "test",
            method: "test",
            fatalDetails: null,
          }),
        ),
    }),
    useHostBinding: hostBinding,
  };
});

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: hostBinding,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-test",
}));

interface MockNamedHostClient {
  readonly getActiveHostId: () => string;
  readonly request: Mock;
}

const {
  archiveChatMutateAsync,
  epicSessionHostClient,
  forceReleaseChatSession,
  beginPendingChatCreation,
  clearPendingChatCreation,
  namedHostClients,
  hostBinding,
} = vi.hoisted(() => {
  const clients = new Map<string, MockNamedHostClient>();
  const namedHostClients = {
    get(hostId: string) {
      const existing = clients.get(hostId);
      if (existing !== undefined) return existing;
      const created = {
        getActiveHostId: () => hostId,
        request: vi.fn(),
      };
      clients.set(hostId, created);
      return created;
    },
    reset() {
      clients.clear();
    },
  };
  return {
    archiveChatMutateAsync: vi.fn(),
    epicSessionHostClient: {
      request: vi.fn(),
      // The archive hook's `onMutate` captures this at mutate time, per the
      // host-swap convention; the lifecycle tests below invoke it for real.
      getActiveHostId: () => "host-test",
    },
    forceReleaseChatSession: vi.fn(),
    beginPendingChatCreation: vi.fn(),
    clearPendingChatCreation: vi.fn(),
    namedHostClients,
    hostBinding: () => ({
      hostClient: {
        createRequesterForHostId: (hostId: string) =>
          namedHostClients.get(hostId),
      },
      hostId: null,
    }),
  };
});
// The pending-creation registry is the open-epic store's seam
// (`stores/epics/open-epic/pending-chat-creations.ts`), covered on its own
// terms in that store's tests. Mocked at its facade leaf here so these tests
// pin the WIRING - that the create hooks call it with the right facts on
// success/error - without dragging in a live open-epic session.
vi.mock("@/lib/chats/pending-chat-creations", () => ({
  beginPendingChatCreation,
  clearPendingChatCreation,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ request: vi.fn() }),
}));
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => epicSessionHostClient,
}));
vi.mock("@/lib/registries/chat-session-registry", () => ({
  getChatSessionRegistry: () => ({
    forceRelease: forceReleaseChatSession,
  }),
}));

import type {
  ArchiveChatMutationInput,
  CreateChatMutationInput,
  DeleteChatMutationInput,
  DeleteChatMutationOptions,
  RenameChatMutationInput,
} from "@/hooks/epic/use-epic-chat-mutations";

interface CapturedMutationArgs {
  readonly client: unknown;
  readonly method: string;
  readonly options: unknown;
  readonly mapVariables: ((variables: never) => unknown) | undefined;
}

const capturedMutations: Partial<Record<string, CapturedMutationArgs>> = {};
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: CapturedMutationArgs) => {
    capturedMutations[args.method] = args;
    return {
      mutate: vi.fn(),
      mutateAsync: archiveChatMutateAsync,
      isPending: false,
    };
  },
}));

import { toast } from "sonner";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type MutationFunctionContext,
} from "@tanstack/react-query";
import {
  useEpicArchiveChat,
  useEpicArchiveChats,
  useEpicCreateChatForHostClient,
  useEpicRenameChat,
  useEpicDeleteChat,
  useEpicDeleteChatInBatch,
} from "@/hooks/epic/use-epic-chat-mutations";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { hostQueryKeys } from "@/lib/query-keys";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import type {
  CreateChatResponse,
  SetChatArchivedRequest,
  SetChatArchivedResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import {
  EPIC_CREATE_SEED_HOLD_TIMEOUT_MS,
  clearEpicCreateSeedPending,
  markEpicCreateSeedPending,
  readEpicCreateSeed,
} from "@/lib/worktree/pending-epic-create-seeds";

function makeError(code: RpcErrorCode): HostRpcError {
  return new HostRpcError({
    code,
    message: "test",
    requestId: "test",
    method: "test",
    fatalDetails: null,
  });
}

const UNREACHABLE_NOTICE =
  "Traycer can't reach that host right now, so nothing on it was changed. Try again once it is reachable.";
const BATCH_ONE_HOST_NOTICE =
  "Traycer can't reach the host these agents run on, so nothing on it was changed. Try again once it is reachable.";
const BATCH_HOSTS_NOTICE =
  "Traycer can't reach the hosts these agents run on, so nothing on them was changed. Try again once they are reachable.";

function hostUnreachable(method: string): RetryableTransportError {
  return new RetryableTransportError({
    replaySafetyFromKey: false,
    code: "RPC_ERROR",
    message: "Remote session is not ready",
    requestId: "req-offline",
    method,
    fatalDetails: null,
  });
}

const UNKNOWN_OUTCOME_NOTICE =
  "No reply came back from the Traycer host, so this may or may not have gone through.";

function aborted(
  method: string,
  mayHaveDispatched: boolean,
): HostRequestAbortedError {
  return new HostRequestAbortedError({
    message: "aborted",
    requestId: "req-aborted",
    method,
    mayHaveDispatched,
  });
}

/** The ids every notice the test raised was given, in order. */
function noticeIds(): unknown[] {
  return vi
    .mocked(toast)
    .mock.calls.map((call) =>
      typeof call[1] === "object" ? call[1].id : undefined,
    );
}

function makeWrapperWithClient(): {
  readonly wrapper: ({ children }: { children: ReactNode }) => ReactNode;
  readonly queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return {
    wrapper: ({ children }) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
    queryClient,
  };
}

function makeWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  return makeWrapperWithClient().wrapper;
}

function getCapturedMutation(method: string): CapturedMutationArgs {
  const mutation = capturedMutations[method];
  if (mutation === undefined) {
    throw new Error(`expected ${method} mutation capture`);
  }
  return mutation;
}

interface ArchiveChatContext {
  readonly hostId: string | null;
  readonly viewerHostId: string | null;
  readonly viewerUserId: string | null;
  readonly servingHostId: string | null;
}

type ChatMutationClientResolver = (variables: {
  readonly hostId: string | null;
}) => unknown;

function isChatMutationClientResolver(
  value: unknown,
): value is ChatMutationClientResolver {
  return typeof value === "function";
}

function resolveCapturedClient(method: string, hostId: string | null): unknown {
  const client = getCapturedMutation(method).client;
  if (!isChatMutationClientResolver(client)) {
    throw new Error(`expected ${method} client resolver`);
  }
  return client({ hostId });
}

beforeEach(() => {
  vi.clearAllMocks();
  namedHostClients.reset();
  for (const method of Object.keys(capturedMutations)) {
    delete capturedMutations[method];
  }
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("useEpicCreateChatForHostClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearEpicCreateSeedPending("e2", "c2");
    clearEpicCreateSeedPending("e-none", "c-none");
  });

  it("retains the created chat on success", () => {
    renderHook(() => useEpicCreateChatForHostClient(null), {
      wrapper: makeWrapper(),
    });
    const opts = getCapturedMutation("epic.createChat").options as {
      onSuccess: (
        data: CreateChatResponse,
        params: CreateChatMutationInput,
        ctx: { hostId: string | null; ownerUserId: string | null },
      ) => void;
    };

    opts.onSuccess(
      { chatId: "host-chat" },
      {
        hostId: "host-test",
        epicId: "e2",
        chatId: "c2",
        parentId: null,
        title: "",
      },
      { hostId: "host-test", ownerUserId: "user-at-submit" },
    );

    expect(beginPendingChatCreation).toHaveBeenCalledWith("e2", {
      chatId: "host-chat",
      hostId: "host-test",
      parentChatId: null,
      title: "",
      ownerUserId: "user-at-submit",
    });
  });

  it("releases the pending creation on error", () => {
    renderHook(() => useEpicCreateChatForHostClient(null), {
      wrapper: makeWrapper(),
    });
    const opts = getCapturedMutation("epic.createChat").options as {
      onError: (e: HostRpcError, variables: CreateChatMutationInput) => void;
    };

    opts.onError(makeError("RPC_ERROR"), {
      hostId: "host-test",
      epicId: "e2",
      chatId: "c2",
      parentId: null,
      title: "",
    });

    expect(clearPendingChatCreation).toHaveBeenCalledWith("e2", "c2");
  });

  it("onSuccess arms its own pair's timer and is a no-op for a surface that registered nothing", () => {
    vi.useFakeTimers();
    const released: string[] = [];
    markEpicCreateSeedPending("e2", "c2", {
      hostId: "host-test",
      seededMessageId: "msg-1",
      seedRows: false,
      heldForDeferredCreate: false,
      release: () => {
        released.push("c2");
      },
    });
    renderHook(() => useEpicCreateChatForHostClient(null), {
      wrapper: makeWrapper(),
    });
    const opts = getCapturedMutation("epic.createChat").options as {
      onSuccess: (
        data: CreateChatResponse,
        params: CreateChatMutationInput,
        ctx: { hostId: string | null; ownerUserId: string | null },
      ) => void;
    };

    opts.onSuccess(
      { chatId: "c-none" },
      {
        hostId: "host-test",
        epicId: "e-none",
        chatId: "c-none",
        parentId: null,
        title: "",
      },
      { hostId: "host-test", ownerUserId: "user-at-submit" },
    );
    vi.advanceTimersByTime(EPIC_CREATE_SEED_HOLD_TIMEOUT_MS);
    expect(released).toEqual([]);
    expect(readEpicCreateSeed("e2", "c2")).not.toBeNull();

    opts.onSuccess(
      { chatId: "c2" },
      {
        hostId: "host-test",
        epicId: "e2",
        chatId: "c2",
        parentId: null,
        title: "",
      },
      { hostId: "host-test", ownerUserId: "user-at-submit" },
    );
    vi.advanceTimersByTime(EPIC_CREATE_SEED_HOLD_TIMEOUT_MS);
    expect(released).toEqual(["c2"]);
    expect(readEpicCreateSeed("e2", "c2")).toBeNull();
  });

  it("onError clears the pair, including an armed timer", () => {
    vi.useFakeTimers();
    const released: string[] = [];
    markEpicCreateSeedPending("e2", "c2", {
      hostId: "host-test",
      seededMessageId: "msg-1",
      seedRows: false,
      heldForDeferredCreate: false,
      release: () => {
        released.push("c2");
      },
    });
    renderHook(() => useEpicCreateChatForHostClient(null), {
      wrapper: makeWrapper(),
    });
    const successOpts = getCapturedMutation("epic.createChat").options as {
      onSuccess: (
        data: CreateChatResponse,
        params: CreateChatMutationInput,
        ctx: { hostId: string | null; ownerUserId: string | null },
      ) => void;
      onError: (e: HostRpcError, variables: CreateChatMutationInput) => void;
    };
    successOpts.onSuccess(
      { chatId: "c2" },
      {
        hostId: "host-test",
        epicId: "e2",
        chatId: "c2",
        parentId: null,
        title: "",
      },
      { hostId: "host-test", ownerUserId: "user-at-submit" },
    );
    expect(readEpicCreateSeed("e2", "c2")).not.toBeNull();

    successOpts.onError(makeError("RPC_ERROR"), {
      hostId: "host-test",
      epicId: "e2",
      chatId: "c2",
      parentId: null,
      title: "",
    });
    expect(readEpicCreateSeed("e2", "c2")).toBeNull();
    vi.advanceTimersByTime(EPIC_CREATE_SEED_HOLD_TIMEOUT_MS);
    expect(released).toEqual([]);
  });
});

describe("useEpicRenameChat", () => {
  it("shows fallback on error", () => {
    renderHook(() => useEpicRenameChat(), { wrapper: makeWrapper() });
    const opts = getCapturedMutation("epic.renameChat").options as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(makeError("RPC_ERROR"));
    expect(toast.error).toHaveBeenCalledWith("Couldn't rename agent.");
  });

  // The caller names the record's owning host on the mutation input
  // (`RenameChatMutationInput.hostId`), like archive/delete above - a rename
  // is a write to that row's owning host, not to whatever the Epic session
  // happens to be bound to. `useEpicRecordMutationClient()` still prefers the
  // session client when it already addresses the named host (avoids minting
  // a second requester for the common case) and falls through to the binding
  // otherwise.
  it("uses the session client for the session host and the binding otherwise", () => {
    renderHook(() => useEpicRenameChat(), { wrapper: makeWrapper() });
    expect(resolveCapturedClient("epic.renameChat", "host-test")).toBe(
      epicSessionHostClient,
    );
    expect(resolveCapturedClient("epic.renameChat", "remote-host")).toBe(
      namedHostClients.get("remote-host"),
    );
  });

  it("fails closed for a null host without dispatching anywhere", () => {
    renderHook(() => useEpicRenameChat(), { wrapper: makeWrapper() });
    expect(resolveCapturedClient("epic.renameChat", null)).toBeNull();
  });

  it("strips hostId from the wire request", () => {
    renderHook(() => useEpicRenameChat(), { wrapper: makeWrapper() });
    const mapVariables = getCapturedMutation("epic.renameChat").mapVariables;
    if (mapVariables === undefined) {
      throw new Error("expected renameChat mapVariables");
    }
    const variables: RenameChatMutationInput = {
      epicId: "epic-1",
      chatId: "chat-1",
      title: "New title",
      hostId: "remote-host",
    };
    expect(mapVariables(variables as never)).toEqual({
      epicId: "epic-1",
      chatId: "chat-1",
      title: "New title",
    });
  });

  it("refreshes both the target and viewer caches after a remote rename", () => {
    const { wrapper, queryClient } = makeWrapperWithClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    renderHook(() => useEpicRenameChat(), { wrapper });
    const opts = getCapturedMutation("epic.renameChat").options as {
      onMutate: (variables: RenameChatMutationInput) => {
        readonly hostId: string | null;
        readonly viewerHostId: string | null;
      };
      onSuccess: (
        data: unknown,
        variables: RenameChatMutationInput,
        ctx: {
          readonly hostId: string | null;
          readonly viewerHostId: string | null;
        },
        mutationContext: MutationFunctionContext,
      ) => void;
    };

    const variables: RenameChatMutationInput = {
      epicId: "epic-1",
      chatId: "chat-1",
      title: "New title",
      hostId: "remote-host",
    };
    const ctx = opts.onMutate(variables);
    expect(ctx).toEqual({ hostId: "remote-host", viewerHostId: "host-test" });
    opts.onSuccess(undefined, variables, ctx, {
      client: queryClient,
      meta: undefined,
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(
        "remote-host",
        "epic.listChatRecords",
      ),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope("host-test", "epic.listChatRecords"),
    });
  });
});

describe("useEpicDeleteChat", () => {
  it("force-releases the deleted chat session on success", () => {
    const store = useEpicCanvasStore.getState();
    const targetTabId = store.openEpicTab("epic-1", "Target");
    const peerTabId = store.openEpicTab("epic-1", "Peer");
    const target: EpicCanvasTileRef = {
      id: "chat-1",
      instanceId: "target-chat-instance",
      type: "chat",
      name: "Target chat",
      hostId: "host-test",
    };
    const sameIdOtherHost: EpicCanvasTileRef = {
      ...target,
      instanceId: "peer-chat-instance",
      hostId: "peer-host",
    };
    store.openTileInTab(targetTabId, target);
    store.openTileInTab(peerTabId, sameIdOtherHost);

    renderHook(() => useEpicDeleteChat(), { wrapper: makeWrapper() });
    const opts = getCapturedMutation("epic.deleteChat")
      .options as DeleteChatMutationOptions;
    if (opts.onSuccess === undefined) {
      throw new Error("expected deleteChat success handler");
    }
    const mutationContext: MutationFunctionContext = {
      client: new QueryClient(),
      meta: undefined,
    };

    opts.onSuccess(
      { deleted: true, publicationChatId: null, outcome: "applied" },
      { epicId: "epic-1", chatId: "chat-1", hostId: "host-test" },
      // The host captured at mutate time - `epic.deleteChat` carries no host
      // on the wire, so the teardown is told which machine's session to close.
      {
        hostId: "host-test",
        viewerHostId: "host-test",
        viewerUserId: null,
        servingHostId: "host-test",
        cloudDeletionToken: null,
      },
      mutationContext,
    );

    expect(forceReleaseChatSession).toHaveBeenCalledWith(
      "epic-1",
      "chat-1",
      "host-test",
    );
    expect(
      useEpicCanvasStore.getState().canvasByTabId[targetTabId]
        ?.tilesByInstanceId[target.instanceId],
    ).toBeUndefined();
    expect(
      useEpicCanvasStore.getState().canvasByTabId[peerTabId]?.tilesByInstanceId[
        sameIdOtherHost.instanceId
      ],
    ).toEqual(sameIdOtherHost);
  });

  it("does not force-release anything when no host was active at mutate time", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Target");
    const target: EpicCanvasTileRef = {
      id: "chat-1",
      instanceId: "target-chat-instance",
      type: "chat",
      name: "Target chat",
      hostId: "host-test",
    };
    store.openTileInTab(tabId, target);

    renderHook(() => useEpicDeleteChat(), { wrapper: makeWrapper() });
    const opts = getCapturedMutation("epic.deleteChat")
      .options as DeleteChatMutationOptions;
    if (opts.onSuccess === undefined) {
      throw new Error("expected deleteChat success handler");
    }

    opts.onSuccess(
      { deleted: true, publicationChatId: null, outcome: "applied" },
      { epicId: "epic-1", chatId: "chat-1", hostId: null },
      {
        hostId: null,
        viewerHostId: "host-test",
        viewerUserId: null,
        servingHostId: null,
        cloudDeletionToken: null,
      },
      { client: new QueryClient(), meta: undefined },
    );

    // Guessing a host here would dispose a same-id chat session belonging to
    // whichever machine happened to be active - the exact cross-host teardown
    // this scoping exists to prevent.
    expect(forceReleaseChatSession).not.toHaveBeenCalled();
    expect(
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId[
        target.instanceId
      ],
    ).toEqual(target);
  });

  it("shows fallback on error", () => {
    useEpicCanvasStore.getState().markArtifactSelfDeleted("chat-1");
    renderHook(() => useEpicDeleteChat(), { wrapper: makeWrapper() });
    const opts = getCapturedMutation("epic.deleteChat").options as {
      onError: (e: HostRpcError, variables: DeleteChatMutationInput) => void;
    };
    opts.onError(makeError("RPC_ERROR"), {
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "host-test",
    });
    expect(
      useEpicCanvasStore.getState().selfDeletedArtifactIds.has("chat-1"),
    ).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Couldn't delete agent.");
  });

  it("says the owning host is unreachable when the delete never reached it", () => {
    renderHook(() => useEpicDeleteChat(), { wrapper: makeWrapper() });
    const opts = getCapturedMutation("epic.deleteChat").options as {
      onError: (e: HostRpcError, variables: DeleteChatMutationInput) => void;
    };
    opts.onError(hostUnreachable("epic.deleteChat"), {
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "host-test",
    });
    expect(toast.message).toHaveBeenCalledWith(
      UNREACHABLE_NOTICE,
      expect.anything(),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  // traycerai/traycer#2546 row 3, on the individual path: an abort after the
  // send may have deleted the agent, so it is not silent.
  it("says no reply came back when an individual delete was aborted after its send", () => {
    renderHook(() => useEpicDeleteChat(), { wrapper: makeWrapper() });
    const opts = getCapturedMutation("epic.deleteChat").options as {
      onError: (e: HostRpcError, variables: DeleteChatMutationInput) => void;
    };
    const variables = {
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "host-test",
    };
    opts.onError(aborted("epic.deleteChat", true), variables);
    opts.onError(aborted("epic.deleteChat", true), variables);
    expect(vi.mocked(toast).mock.calls.map((call) => call[0])).toEqual([
      UNKNOWN_OUTCOME_NOTICE,
      UNKNOWN_OUTCOME_NOTICE,
    ]);
    // One id per action: the second delete's notice does not replace the
    // first's.
    const ids = noticeIds();
    expect(new Set(ids).size).toBe(2);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.message).not.toHaveBeenCalled();
  });

  it("stays silent when an individual delete was cancelled before its send", () => {
    renderHook(() => useEpicDeleteChat(), { wrapper: makeWrapper() });
    const opts = getCapturedMutation("epic.deleteChat").options as {
      onError: (e: HostRpcError, variables: DeleteChatMutationInput) => void;
    };
    opts.onError(aborted("epic.deleteChat", false), {
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "host-test",
    });
    expect(toast).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.message).not.toHaveBeenCalled();
  });

  it("leaves a batch member's failure to its caller and still rolls back the row", () => {
    renderHook(() => useEpicDeleteChatInBatch(), { wrapper: makeWrapper() });
    useEpicCanvasStore.getState().markArtifactSelfDeleted("chat-1");
    const opts = getCapturedMutation("epic.deleteChat").options as {
      onError: (e: HostRpcError, variables: DeleteChatMutationInput) => void;
    };
    opts.onError(hostUnreachable("epic.deleteChat"), {
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "host-test",
    });
    expect(toast.message).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(
      useEpicCanvasStore.getState().selfDeletedArtifactIds.has("chat-1"),
    ).toBe(false);
  });

  it("uses the session client when the named host is the session host", () => {
    renderHook(() => useEpicDeleteChat(), { wrapper: makeWrapper() });
    expect(resolveCapturedClient("epic.deleteChat", "host-test")).toBe(
      epicSessionHostClient,
    );
  });

  it("resolves a named non-session host through the binding", () => {
    renderHook(() => useEpicDeleteChat(), { wrapper: makeWrapper() });
    expect(resolveCapturedClient("epic.deleteChat", "remote-host")).toBe(
      namedHostClients.get("remote-host"),
    );
  });

  it("fails closed when the named host is null", () => {
    renderHook(() => useEpicDeleteChat(), { wrapper: makeWrapper() });
    expect(resolveCapturedClient("epic.deleteChat", null)).toBeNull();
  });

  it("strips hostId from the wire request", () => {
    renderHook(() => useEpicDeleteChat(), { wrapper: makeWrapper() });
    const mapVariables = getCapturedMutation("epic.deleteChat").mapVariables;
    if (mapVariables === undefined) {
      throw new Error("expected deleteChat mapVariables");
    }
    expect(
      mapVariables({
        epicId: "epic-1",
        chatId: "chat-1",
        hostId: "remote-host",
      } as never),
    ).toEqual({ epicId: "epic-1", chatId: "chat-1" });
  });
});

describe("useEpicArchiveChat", () => {
  it("registers epic.setChatArchived with no optimistic cache write (B9)", () => {
    renderHook(() => useEpicArchiveChat(), { wrapper: makeWrapper() });

    const mutation = getCapturedMutation("epic.setChatArchived");
    expect(typeof mutation.client).toBe("function");
    expect(mutation.method).toBe("epic.setChatArchived");
    // hostId is caller-captured routing context and must not go on the wire.
    if (mutation.mapVariables === undefined) {
      throw new Error("expected setChatArchived mapVariables");
    }
    const variables: ArchiveChatMutationInput = {
      epicId: "epic-1",
      chatId: "agent-or-chat-id",
      hostId: "host-test",
      archived: true,
    };
    const mapVariables = mutation.mapVariables as (
      vars: ArchiveChatMutationInput,
    ) => SetChatArchivedRequest;
    expect(mapVariables(variables)).toEqual({
      epicId: "epic-1",
      chatId: "agent-or-chat-id",
      archived: true,
    });

    const opts = mutation.options as {
      onSuccess: ((data: SetChatArchivedResponse) => void) | undefined;
      onMutate:
        | ((variables: ArchiveChatMutationInput) => ArchiveChatContext)
        | undefined;
      onError: (e: HostRpcError) => void;
    };
    // Still no optimistic CACHE WRITE - nothing here fabricates an archived
    // row. What the handlers do is refresh the host's record list, and that is
    // a correction rather than an addition (chat-sync-v2 ticket 49): this test
    // used to assert both were absent, on the premise that "the archive flag
    // lives in the epic Y.Doc, so the host's write replicates back through the
    // epic stream". Since the single-write pivot `archivedAt` is a chat-DATABASE
    // fact and nothing replicates it, so without the refetch an archived swept
    // chat stays in the tree until the record poll fires.
    expect(opts.onMutate).toBeDefined();
    expect(opts.onSuccess).toBeDefined();
  });

  it("uses the session client for the session host and the binding otherwise", () => {
    renderHook(() => useEpicArchiveChat(), { wrapper: makeWrapper() });
    expect(resolveCapturedClient("epic.setChatArchived", "host-test")).toBe(
      epicSessionHostClient,
    );
    expect(resolveCapturedClient("epic.setChatArchived", "remote-host")).toBe(
      namedHostClients.get("remote-host"),
    );
    expect(resolveCapturedClient("epic.setChatArchived", null)).toBeNull();
  });

  it("treats { updated: false } as success and does not toast (B9)", () => {
    const { wrapper, queryClient } = makeWrapperWithClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    renderHook(() => useEpicArchiveChat(), { wrapper });
    const opts = getCapturedMutation("epic.setChatArchived").options as {
      onMutate:
        | ((variables: ArchiveChatMutationInput) => ArchiveChatContext)
        | undefined;
      onSuccess:
        | ((
            data: SetChatArchivedResponse,
            variables: ArchiveChatMutationInput,
            ctx: ArchiveChatContext,
            mutationContext: MutationFunctionContext,
          ) => void)
        | undefined;
      onError: (e: HostRpcError) => void;
    };
    if (opts.onMutate === undefined || opts.onSuccess === undefined) {
      throw new Error("expected setChatArchived lifecycle handlers");
    }

    // Idempotent "already in requested state" is a success response, DRIVEN
    // here rather than merely present: `onMutate` captures the named target
    // and the viewing session, and `onSuccess` for `{ updated: false }` must
    // still refresh both record lists while announcing nothing.
    const variables: ArchiveChatMutationInput = {
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "host-test",
      archived: true,
    };
    const ctx = opts.onMutate(variables);
    expect(ctx).toEqual({
      hostId: "host-test",
      viewerHostId: "host-test",
      viewerUserId: null,
      servingHostId: "host-test",
    });
    opts.onSuccess({ updated: false, outcome: "applied" }, variables, ctx, {
      client: queryClient,
      meta: undefined,
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope("host-test", "epic.listChatRecords"),
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("refreshes both the target and viewer caches after a remote archive", () => {
    const { wrapper, queryClient } = makeWrapperWithClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    renderHook(() => useEpicArchiveChat(), { wrapper });
    const opts = getCapturedMutation("epic.setChatArchived").options as {
      onMutate: (variables: ArchiveChatMutationInput) => ArchiveChatContext;
      onSuccess: (
        data: SetChatArchivedResponse,
        variables: ArchiveChatMutationInput,
        ctx: ArchiveChatContext,
        mutationContext: MutationFunctionContext,
      ) => void;
    };

    const variables: ArchiveChatMutationInput = {
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "remote-host",
      archived: true,
    };
    const ctx = opts.onMutate(variables);
    expect(ctx).toEqual({
      hostId: "remote-host",
      viewerHostId: "host-test",
      viewerUserId: null,
      servingHostId: "remote-host",
    });
    opts.onSuccess({ updated: true, outcome: "applied" }, variables, ctx, {
      client: queryClient,
      meta: undefined,
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(
        "remote-host",
        "epic.listChatRecords",
      ),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope("host-test", "epic.listChatRecords"),
    });
  });

  it("says the owning host is unreachable, not a generic transport toast, when archive never reached it", () => {
    renderHook(() => useEpicArchiveChat(), { wrapper: makeWrapper() });
    const opts = getCapturedMutation("epic.setChatArchived").options as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(hostUnreachable("epic.setChatArchived"));
    expect(toast.message).toHaveBeenCalledWith(
      UNREACHABLE_NOTICE,
      expect.anything(),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  // traycerai/traycer#2546 row 3, on the individual path.
  it("says no reply came back when an individual archive was aborted after its send", () => {
    renderHook(() => useEpicArchiveChat(), { wrapper: makeWrapper() });
    const opts = getCapturedMutation("epic.setChatArchived").options as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(aborted("epic.setChatArchived", true));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast).mock.calls.map((call) => call[0])).toEqual([
      UNKNOWN_OUTCOME_NOTICE,
    ]);
    expect(vi.mocked(toast).mock.calls[0][1]?.id).toMatch(
      /^owner-host-batch-result:/,
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("stays silent when an individual archive was cancelled before its send", () => {
    renderHook(() => useEpicArchiveChat(), { wrapper: makeWrapper() });
    const opts = getCapturedMutation("epic.setChatArchived").options as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(aborted("epic.setChatArchived", false));
    expect(toast).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.message).not.toHaveBeenCalled();
  });

  it("toasts a generic fallback on a real failure (B9)", () => {
    renderHook(() => useEpicArchiveChat(), { wrapper: makeWrapper() });
    const opts = getCapturedMutation("epic.setChatArchived").options as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(makeError("RPC_ERROR"));
    expect(toast.error).toHaveBeenCalledWith("Couldn't archive agent.");
    // One generic toast only - do not assert on status codes or parse messages.
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("surfaces E_HOST_UNSUPPORTED with the host-upgrade toast", () => {
    renderHook(() => useEpicArchiveChat(), { wrapper: makeWrapper() });
    const opts = getCapturedMutation("epic.setChatArchived").options as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(makeError("E_HOST_UNSUPPORTED"));
    // Archive is user-initiated, so it follows the FOREGROUND convention:
    // `toastFromHostError` reports the failure rather than swallowing it (only
    // the background helper swallows capability gaps, since nobody asked for
    // that work). Silence here would read as a broken button. The capability
    // gate keeps this path cold - reaching it means the host changed under a
    // live session. `toastFromHostError` maps E_HOST_UNSUPPORTED to a specific
    // host-upgrade message (a version gap, not a failed archive), which is the
    // right actionable copy for this exact case, so the fallback never shows.
    expect(toast.error).toHaveBeenCalledWith(
      "This needs a newer Traycer host. Update the host to continue.",
    );
  });
});

describe("useEpicArchiveChats", () => {
  it("tracks the aggregate archive batch with a Query mutation", async () => {
    let resolveArchive: (value: SetChatArchivedResponse) => void = () => {
      throw new Error("Archive resolver is unavailable");
    };
    const pendingArchive = new Promise<SetChatArchivedResponse>((resolve) => {
      resolveArchive = resolve;
    });
    archiveChatMutateAsync.mockReturnValue(pendingArchive);
    const { result } = renderHook(() => useEpicArchiveChats(), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.mutate({
        epicId: "epic-1",
        chats: [
          {
            chatId: "chat-1",
            hostId: "host-test",
            selectedRows: 1,
            coveredRows: () => 1,
          },
          {
            chatId: "chat-2",
            hostId: "remote-host",
            selectedRows: 1,
            coveredRows: () => 1,
          },
        ],
        archived: true,
      });
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });
    expect(archiveChatMutateAsync).toHaveBeenCalledTimes(2);
    expect(archiveChatMutateAsync).toHaveBeenNthCalledWith(1, {
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "host-test",
      archived: true,
    });
    expect(archiveChatMutateAsync).toHaveBeenNthCalledWith(2, {
      epicId: "epic-1",
      chatId: "chat-2",
      hostId: "remote-host",
      archived: true,
    });

    resolveArchive({ updated: true, outcome: "applied" });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
      expect(result.current.data?.map((entry) => entry.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
    });
  });

  it("keeps mixed outcomes ordered and reports one batch failure", async () => {
    archiveChatMutateAsync.mockImplementation(
      (input: ArchiveChatMutationInput) =>
        input.chatId === "chat-1"
          ? Promise.resolve({ updated: true })
          : Promise.reject(makeError("RPC_ERROR")),
    );
    const { result } = renderHook(() => useEpicArchiveChats(), {
      wrapper: makeWrapper(),
    });
    const childOptions = getCapturedMutation("epic.setChatArchived")
      .options as { readonly onError: unknown };
    // The per-row callback only refreshes the lists a failed write could
    // have changed; the batch reports the failure once (asserted below, and
    // with a real per-row mutation in the archive-routing stand-in suite).
    expect(typeof childOptions.onError).toBe("function");

    act(() => {
      result.current.mutate({
        epicId: "epic-1",
        chats: [
          {
            chatId: "chat-1",
            hostId: "host-test",
            selectedRows: 1,
            coveredRows: () => 1,
          },
          {
            chatId: "chat-2",
            hostId: "remote-host",
            selectedRows: 1,
            coveredRows: () => 1,
          },
        ],
        archived: true,
      });
    });

    await waitFor(() => {
      expect(result.current.data?.map((entry) => entry.status)).toEqual([
        "fulfilled",
        "rejected",
      ]);
    });
    expect(toast.error).toHaveBeenCalledWith(
      "Archived 1 of 2 selected agents. 1 couldn't be archived.",
      expect.anything(),
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  // Codex thread 4302962544. A record whose owner is gone is archived by a
  // stand-in host, which writes the cloud row and answers `requested`. When
  // the row already had that state it answers `updated: false` as well. The
  // per-record mutation reports it as accepted, so the batch must count it
  // as accepted too, never as unconfirmed.
  describe("a requested no-op from a stand-in host", () => {
    function allNotices(): string[] {
      return [
        ...vi.mocked(toast).mock.calls,
        ...vi.mocked(toast.error).mock.calls,
        ...vi.mocked(toast.message).mock.calls,
      ].map((call) => {
        const [message] = call;
        return typeof message === "string" ? message : JSON.stringify(message);
      });
    }

    async function settleBatch(
      answers: Readonly<Record<string, () => Promise<SetChatArchivedResponse>>>,
      archived: boolean,
    ): Promise<void> {
      vi.mocked(toast).mockClear();
      vi.mocked(toast.error).mockClear();
      vi.mocked(toast.message).mockClear();
      const answerByChat = new Map(Object.entries(answers));
      archiveChatMutateAsync.mockImplementation(
        (input: ArchiveChatMutationInput) => {
          const answer = answerByChat.get(input.chatId);
          if (answer === undefined)
            throw new Error(`unexpected ${input.chatId}`);
          return answer();
        },
      );
      const { result, unmount } = renderHook(() => useEpicArchiveChats(), {
        wrapper: makeWrapper(),
      });
      act(() => {
        result.current.mutate({
          epicId: "epic-1",
          chats: Object.keys(answers).map((chatId) => ({
            chatId,
            hostId: "remote-host",
            selectedRows: 2,
            coveredRows: () => 2,
          })),
          archived,
        });
      });
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });
      unmount();
    }

    it.each([true, false])(
      "says nothing about confirmation when every row was accepted (archived=%s)",
      async (archived) => {
        await settleBatch(
          {
            "chat-1": () =>
              Promise.resolve({ updated: false, outcome: "requested" }),
            "chat-2": () =>
              Promise.resolve({ updated: true, outcome: "applied" }),
          },
          archived,
        );

        expect(allNotices()).toEqual([]);
      },
    );

    it("counts the requested no-op's rows as applied beside a failure", async () => {
      await settleBatch(
        {
          "chat-1": () =>
            Promise.resolve({ updated: false, outcome: "requested" }),
          "chat-2": () => Promise.reject(makeError("RPC_ERROR")),
        },
        true,
      );

      expect(allNotices()).toEqual([
        "Archived 2 of 4 selected agents. 2 couldn't be archived.",
      ]);
    });
  });

  // traycerai/traycer thread taE7F. `updated: false` is an already-satisfied
  // no-op, or a chat deleted while its archive write waited its turn: neither
  // applied nor failed as far as the batch can tell. Every mix of two and
  // three rows, for archive and unarchive, holds four invariants:
  //  1. a count names the whole selection;
  //  2. a not-updated row is never counted as applied or as failed;
  //  3. every guidance sentence the same mix shows without its not-updated
  //     rows is still shown with them;
  //  4. a mix of only updated and not-updated rows says nothing.
  type ArchiveRow =
    | "updated"
    | "not-updated"
    | "refused"
    | "unreachable"
    | "dropped";

  const ARCHIVE_ROWS: readonly ArchiveRow[] = [
    "updated",
    "not-updated",
    "refused",
    "unreachable",
    "dropped",
  ];

  function archiveMixesOf(size: number, from: number): ArchiveRow[][] {
    if (size === 0) return [[]];
    return ARCHIVE_ROWS.slice(from).flatMap((row, offset) =>
      archiveMixesOf(size - 1, from + offset).map((rest) => [row, ...rest]),
    );
  }

  const ARCHIVE_MIXES = [
    ...archiveMixesOf(2, 0),
    ...archiveMixesOf(3, 0),
  ].flatMap((mix) =>
    [true, false].map((archived) => ({
      name: `${archived ? "archive" : "unarchive"} [${mix.join(", ")}]`,
      mix,
      archived,
    })),
  );

  const GUIDANCE_SENTENCES = [
    UNREACHABLE_NOTICE,
    BATCH_ONE_HOST_NOTICE,
    BATCH_HOSTS_NOTICE,
    "You don't have permission to do that.",
  ];

  interface SelectedArchiveRow {
    readonly row: ArchiveRow;
    readonly chatId: string;
    readonly hostId: string;
  }

  function archiveRowAnswer(row: ArchiveRow): Promise<{ updated: boolean }> {
    switch (row) {
      case "updated":
        return Promise.resolve({ updated: true });
      case "not-updated":
        return Promise.resolve({ updated: false });
      case "refused":
        return Promise.reject(makeError("FORBIDDEN"));
      case "unreachable":
        return Promise.reject(hostUnreachable("epic.setChatArchived"));
      case "dropped":
        return Promise.reject(
          new HostTransportFailureError({
            code: "RPC_ERROR",
            message: "socket closed after the request was sent",
            requestId: "req-dropped",
            method: "epic.setChatArchived",
            fatalDetails: null,
          }),
        );
    }
  }

  function noticeText(call: readonly unknown[]): string {
    const [message] = call;
    return typeof message === "string" ? message : JSON.stringify(message);
  }

  /** Every notice the batch raised, as text. */
  async function archiveBatchNotices(
    rows: readonly SelectedArchiveRow[],
    archived: boolean,
  ): Promise<string[]> {
    vi.mocked(toast).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.message).mockClear();
    const rowByChat = new Map(rows.map((entry) => [entry.chatId, entry.row]));
    archiveChatMutateAsync.mockImplementation(
      (input: ArchiveChatMutationInput) => {
        const row = rowByChat.get(input.chatId);
        if (row === undefined) throw new Error(`unexpected ${input.chatId}`);
        return archiveRowAnswer(row);
      },
    );
    const { result, unmount } = renderHook(() => useEpicArchiveChats(), {
      wrapper: makeWrapper(),
    });
    act(() => {
      result.current.mutate({
        epicId: "epic-1",
        chats: rows.map(({ chatId, hostId }) => ({
          chatId,
          hostId,
          selectedRows: 1,
          coveredRows: () => 1,
        })),
        archived,
      });
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    unmount();
    return [
      ...vi.mocked(toast).mock.calls,
      ...vi.mocked(toast.error).mock.calls,
      ...vi.mocked(toast.message).mock.calls,
    ].map(noticeText);
  }

  it.each(ARCHIVE_MIXES)("$name", async ({ mix, archived }) => {
    const rows = mix.map((row, index) => ({
      row,
      chatId: `chat-${String(index)}`,
      hostId: `host-${String(index)}`,
    }));
    const notices = await archiveBatchNotices(rows, archived);
    const said = notices.join(" | ");

    // 4. Only applied and not-updated rows: nothing to report.
    if (mix.every((row) => row === "updated" || row === "not-updated")) {
      expect(notices).toEqual([]);
      return;
    }
    // 1. Any count names the whole selection.
    for (const [, count] of said.matchAll(/(\d+) selected/g)) {
      expect(count).toBe(String(mix.length));
    }
    if (!mix.includes("not-updated")) return;
    // 2. Never counted as applied, and never as failed.
    expect(said).not.toMatch(/(?:Archived|Unarchived) \d+ of/);
    expect(said).not.toContain("any of the");
    expect(said).not.toMatch(/couldn't be (?:un)?archived/);
    expect(said).not.toMatch(/Couldn't (?:un)?archive agent\./);
    // 3. The guidance the mix gives without its not-updated rows survives.
    const withoutNotUpdated = rows.filter(
      (entry) => entry.row !== "not-updated",
    );
    if (withoutNotUpdated.length === 0) return;
    const saidWithout = (
      await archiveBatchNotices(withoutNotUpdated, archived)
    ).join(" | ");
    for (const sentence of GUIDANCE_SENTENCES) {
      if (saidWithout.includes(sentence)) expect(said).toContain(sentence);
    }
  });

  it("reports one plural notice when the unreachable batch spans several hosts", async () => {
    archiveChatMutateAsync.mockImplementation(() =>
      Promise.reject(hostUnreachable("epic.setChatArchived")),
    );
    const { result } = renderHook(() => useEpicArchiveChats(), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.mutate({
        epicId: "epic-1",
        chats: [
          {
            chatId: "chat-1",
            hostId: "host-test",
            selectedRows: 1,
            coveredRows: () => 1,
          },
          {
            chatId: "chat-2",
            hostId: "remote-host",
            selectedRows: 1,
            coveredRows: () => 1,
          },
        ],
        archived: true,
      });
    });

    await waitFor(() => {
      expect(toast.message).toHaveBeenCalledWith(
        BATCH_HOSTS_NOTICE,
        expect.anything(),
      );
    });
    expect(toast.message).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("names one host when every agent in the unreachable batch runs on it", async () => {
    archiveChatMutateAsync.mockImplementation(() =>
      Promise.reject(hostUnreachable("epic.setChatArchived")),
    );
    const { result } = renderHook(() => useEpicArchiveChats(), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.mutate({
        epicId: "epic-1",
        chats: [
          {
            chatId: "chat-1",
            hostId: "remote-host",
            selectedRows: 1,
            coveredRows: () => 1,
          },
          {
            chatId: "chat-2",
            hostId: "remote-host",
            selectedRows: 1,
            coveredRows: () => 1,
          },
        ],
        archived: true,
      });
    });

    await waitFor(() => {
      expect(toast.message).toHaveBeenCalledWith(
        BATCH_ONE_HOST_NOTICE,
        expect.anything(),
      );
    });
    expect(toast.message).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not call a partly archived batch unreachable", async () => {
    // One agent archived and one host unreachable is a partial failure: the
    // offline notice says nothing was changed, which is false here.
    archiveChatMutateAsync.mockImplementation(
      (input: ArchiveChatMutationInput) =>
        input.chatId === "chat-1"
          ? Promise.resolve({ updated: true })
          : Promise.reject(hostUnreachable("epic.setChatArchived")),
    );
    const { result } = renderHook(() => useEpicArchiveChats(), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.mutate({
        epicId: "epic-1",
        chats: [
          {
            chatId: "chat-1",
            hostId: "host-test",
            selectedRows: 1,
            coveredRows: () => 1,
          },
          {
            chatId: "chat-2",
            hostId: "remote-host",
            selectedRows: 1,
            coveredRows: () => 1,
          },
        ],
        archived: true,
      });
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Archived 1 of 2 selected agents. 1 couldn't be archived.",
        expect.anything(),
      );
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
    expect(toast.message).not.toHaveBeenCalled();
  });
  // traycerai/traycer thread taOw7: archiving a parent hides its subtree, so
  // the sidebar sends only the topmost selected rows. Each carries the
  // selected rows it covers, and the notice counts those, not the requests.
  type WeightedArchiveRow =
    | "updated"
    | "not-updated"
    | "refused"
    | "unreachable";

  async function weightedArchiveNotice(
    rows: readonly {
      readonly row: WeightedArchiveRow;
      readonly selectedRows: number;
      readonly coveredRows: number;
    }[],
    archived: boolean,
  ): Promise<unknown> {
    archiveChatMutateAsync.mockImplementation(
      (input: ArchiveChatMutationInput) => {
        const row = rows[Number(input.chatId.slice("root-".length))]?.row;
        if (row === "refused") return Promise.reject(makeError("FORBIDDEN"));
        if (row === "unreachable") {
          return Promise.reject(hostUnreachable("epic.setChatArchived"));
        }
        return Promise.resolve({ updated: row === "updated" });
      },
    );
    const { result } = renderHook(() => useEpicArchiveChats(), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.mutate({
        epicId: "epic-1",
        chats: rows.map((entry, index) => ({
          chatId: `root-${String(index)}`,
          hostId: `host-${String(index)}`,
          selectedRows: entry.selectedRows,
          coveredRows: () => entry.coveredRows,
        })),
        archived,
      });
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
    return vi.mocked(toast.error).mock.calls[0]?.[0];
  }

  it("counts an unreachable parent with its selected child as two of three selected", async () => {
    await expect(
      weightedArchiveNotice(
        [
          { row: "unreachable", selectedRows: 2, coveredRows: 2 },
          { row: "updated", selectedRows: 1, coveredRows: 1 },
        ],
        true,
      ),
    ).resolves.toBe("Archived 1 of 3 selected agents. 2 couldn't be archived.");
  });

  it("counts an archived parent with its selected child as two of three selected", async () => {
    await expect(
      weightedArchiveNotice(
        [
          { row: "updated", selectedRows: 2, coveredRows: 2 },
          { row: "refused", selectedRows: 1, coveredRows: 1 },
        ],
        true,
      ),
    ).resolves.toBe(
      "Archived 2 of 3 selected agents. 1 couldn't be archived. You don't have permission to do that.",
    );
  });

  it("keeps a not-updated parent's selected child in the selection's count", async () => {
    await expect(
      weightedArchiveNotice(
        [
          { row: "not-updated", selectedRows: 2, coveredRows: 2 },
          { row: "refused", selectedRows: 1, coveredRows: 1 },
        ],
        true,
      ),
    ).resolves.toBe(
      "Couldn't confirm all 3 selected agents were archived. Check them and archive any that weren't. You don't have permission to do that.",
    );
  });

  // Thread round 9: a selected child moved out of the parent while the
  // archive was in flight is not archived with it. The request stands for
  // fewer rows at settlement than at the gesture, and the rows it no longer
  // covers are unconfirmed - never archived, never failed.
  it("counts a selected child moved out of an archived parent as unconfirmed", async () => {
    await expect(
      weightedArchiveNotice(
        [
          { row: "updated", selectedRows: 2, coveredRows: 1 },
          { row: "refused", selectedRows: 1, coveredRows: 1 },
        ],
        true,
      ),
    ).resolves.toBe(
      "Couldn't confirm all 3 selected agents were archived. Check them and archive any that weren't. You don't have permission to do that.",
    );
  });

  it("counts an unarchive the same way", async () => {
    await expect(
      weightedArchiveNotice(
        [
          { row: "unreachable", selectedRows: 2, coveredRows: 2 },
          { row: "updated", selectedRows: 1, coveredRows: 1 },
        ],
        false,
      ),
    ).resolves.toBe(
      "Unarchived 1 of 3 selected agents. 2 couldn't be unarchived.",
    );
  });
});
