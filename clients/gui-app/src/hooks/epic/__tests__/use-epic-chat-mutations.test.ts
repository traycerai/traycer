import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { createElement } from "react";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
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
  };
});

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-test",
}));

const {
  archiveChatMutateAsync,
  epicSessionHostClient,
  forceReleaseChatSession,
  beginPendingChatCreation,
  clearPendingChatCreation,
} = vi.hoisted(() => ({
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
}));
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
  CreateChatMutationInput,
  DeleteChatMutationOptions,
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
} from "@/hooks/epic/use-epic-chat-mutations";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostQueryKeys } from "@/lib/query-keys";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import type {
  CreateChatResponse,
  SetChatArchivedRequest,
  SetChatArchivedResponse,
} from "@traycer/protocol/host/epic/unary-schemas";

function makeError(code: RpcErrorCode): HostRpcError {
  return new HostRpcError({
    code,
    message: "test",
    requestId: "test",
    method: "test",
    fatalDetails: null,
  });
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

beforeEach(() => {
  vi.clearAllMocks();
  for (const method of Object.keys(capturedMutations)) {
    delete capturedMutations[method];
  }
});

describe("useEpicCreateChatForHostClient", () => {
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

  it("addresses the Epic session's host, not the app-wide one", () => {
    // Both call sites (the sidebar chat tree, the canvas tab rename) live
    // inside an Epic and outside every tile `TabHostProvider`. The ambient
    // client this used to read is the EFFECTIVE host, which diverges from the
    // session host for the whole of a re-point - a window in which the sidebar
    // stays interactive because only the canvas is made inert.
    //
    // Identity, not "a client was passed": `useHostClient()` is mocked to
    // return a fresh object per call, so a regression fails here on the
    // object rather than on an absence.
    renderHook(() => useEpicRenameChat(), { wrapper: makeWrapper() });
    expect(getCapturedMutation("epic.renameChat").client).toBe(
      epicSessionHostClient,
    );
  });
});

describe("useEpicDeleteChat", () => {
  it("force-releases the deleted chat session on success", () => {
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
      { deleted: true },
      { epicId: "epic-1", chatId: "chat-1" },
      // The host captured at mutate time - `epic.deleteChat` carries no host
      // on the wire, so the teardown is told which machine's session to close.
      { hostId: "host-test" },
      mutationContext,
    );

    expect(forceReleaseChatSession).toHaveBeenCalledWith(
      "epic-1",
      "chat-1",
      "host-test",
    );
  });

  it("does not force-release anything when no host was active at mutate time", () => {
    renderHook(() => useEpicDeleteChat(), { wrapper: makeWrapper() });
    const opts = getCapturedMutation("epic.deleteChat")
      .options as DeleteChatMutationOptions;
    if (opts.onSuccess === undefined) {
      throw new Error("expected deleteChat success handler");
    }

    opts.onSuccess(
      { deleted: true },
      { epicId: "epic-1", chatId: "chat-1" },
      { hostId: null },
      { client: new QueryClient(), meta: undefined },
    );

    // Guessing a host here would dispose a same-id chat session belonging to
    // whichever machine happened to be active - the exact cross-host teardown
    // this scoping exists to prevent.
    expect(forceReleaseChatSession).not.toHaveBeenCalled();
  });

  it("shows fallback on error", () => {
    renderHook(() => useEpicDeleteChat(), { wrapper: makeWrapper() });
    const opts = getCapturedMutation("epic.deleteChat").options as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(makeError("RPC_ERROR"));
    expect(toast.error).toHaveBeenCalledWith("Couldn't delete agent.");
  });

  it("addresses the Epic session's host, not the app-wide one", () => {
    // The stakes are higher here than on rename: `epic.deleteChat` names no
    // host on the wire, so it deletes whatever the RECEIVING machine holds
    // under that chat id. Sent to the effective host during a re-point, it is
    // a delete aimed at a row the sidebar is projecting from elsewhere.
    renderHook(() => useEpicDeleteChat(), { wrapper: makeWrapper() });
    expect(getCapturedMutation("epic.deleteChat").client).toBe(
      epicSessionHostClient,
    );
  });
});

describe("useEpicArchiveChat", () => {
  it("registers epic.setChatArchived with no optimistic cache write (B9)", () => {
    renderHook(() => useEpicArchiveChat(), { wrapper: makeWrapper() });

    const mutation = getCapturedMutation("epic.setChatArchived");
    expect(mutation.client).toBe(epicSessionHostClient);
    expect(mutation.method).toBe("epic.setChatArchived");
    // mapVariables is identity - chats and terminal-agents share one RPC keyed
    // by record id; there is no separate TUI method.
    if (mutation.mapVariables === undefined) {
      throw new Error("expected setChatArchived mapVariables");
    }
    const variables = {
      epicId: "epic-1",
      chatId: "agent-or-chat-id",
      archived: true,
    };
    const mapVariables = mutation.mapVariables as (
      vars: typeof variables,
    ) => typeof variables;
    expect(mapVariables(variables)).toEqual(variables);

    const opts = mutation.options as {
      onSuccess: ((data: SetChatArchivedResponse) => void) | undefined;
      onMutate: (() => { readonly hostId: string | null }) | undefined;
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

  it("treats { updated: false } as success and does not toast (B9)", () => {
    const { wrapper, queryClient } = makeWrapperWithClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    renderHook(() => useEpicArchiveChat(), { wrapper });
    const opts = getCapturedMutation("epic.setChatArchived").options as {
      onMutate: (() => { readonly hostId: string | null }) | undefined;
      onSuccess:
        | ((
            data: SetChatArchivedResponse,
            variables: SetChatArchivedRequest,
            ctx: { readonly hostId: string | null },
            mutationContext: MutationFunctionContext,
          ) => void)
        | undefined;
      onError: (e: HostRpcError) => void;
    };
    if (opts.onMutate === undefined || opts.onSuccess === undefined) {
      throw new Error("expected setChatArchived lifecycle handlers");
    }

    // Idempotent "already in requested state" is a success response, DRIVEN
    // here rather than merely present: `onMutate` captures the session host
    // at mutate time, and `onSuccess` for `{ updated: false }` must still
    // refresh that host's record list (the row may have been archived by
    // another client - the refetch is the correction) while announcing
    // nothing.
    const ctx = opts.onMutate();
    expect(ctx).toEqual({ hostId: "host-test" });
    opts.onSuccess(
      { updated: false },
      { epicId: "epic-1", chatId: "chat-1", archived: true },
      ctx,
      { client: queryClient, meta: undefined },
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope("host-test", "epic.listChatRecords"),
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
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
        chatIds: ["chat-1", "chat-2"],
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
      archived: true,
    });
    expect(archiveChatMutateAsync).toHaveBeenNthCalledWith(2, {
      epicId: "epic-1",
      chatId: "chat-2",
      archived: true,
    });

    resolveArchive({ updated: true });

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
      (input: SetChatArchivedRequest) =>
        input.chatId === "chat-1"
          ? Promise.resolve({ updated: true })
          : Promise.reject(makeError("RPC_ERROR")),
    );
    const { result } = renderHook(() => useEpicArchiveChats(), {
      wrapper: makeWrapper(),
    });
    const childOptions = getCapturedMutation("epic.setChatArchived")
      .options as { readonly onError: unknown };
    expect(childOptions.onError).toBeUndefined();

    act(() => {
      result.current.mutate({
        epicId: "epic-1",
        chatIds: ["chat-1", "chat-2"],
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
      "Couldn't archive some selected agents.",
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
