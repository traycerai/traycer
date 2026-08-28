import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { createElement } from "react";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const epicSessionHostClient = vi.hoisted(() => ({
  request: vi.fn(),
  getActiveHostId: () => "epic-host",
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => epicSessionHostClient,
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/chats/use-cloud-chat-queries")
    >();
  return {
    ...actual,
    useCloudChatViewerId: () => "viewer-1",
  };
});

interface CapturedMutationArgs {
  readonly client: unknown;
  readonly method: string;
  readonly options: unknown;
  readonly mapVariables: ((variables: never) => unknown) | undefined;
}

const capturedMutations: Partial<Record<string, CapturedMutationArgs>> = {};
vi.mock("@/hooks/host/use-host-query", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/host/use-host-query")>();
  return {
    ...actual,
    useHostMutation: (args: CapturedMutationArgs) => {
      capturedMutations[args.method] = args;
      return {
        mutate: vi.fn(),
        mutateAsync: vi.fn(),
        isPending: false,
      };
    },
  };
});

import { renderHook } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type MutationFunctionContext,
} from "@tanstack/react-query";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { toast } from "sonner";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import { cloudChatListQueryKey } from "@/lib/chats/cloud-chat-list-cache";
import { cloudChatQueryKeys } from "@/lib/query-keys/cloud-chat-query-keys";
import { indexOwnCloudChatsByLocalId } from "@/lib/chats/unified-chat-list";
import {
  CHAT_SHARING_IN_FLIGHT_MESSAGE,
  isChatSharingInFlight,
  resetChatSharingInFlightForTests,
} from "@/lib/chats/chat-sharing-inflight";
import {
  useEpicSetChatSharingDefault,
  useEpicSetCloudChatVisibility,
} from "@/hooks/epic/use-epic-chat-visibility-mutations";

const CHAT: CloudChatSummary = {
  identity: {
    taskId: "task-1",
    chatId: "chat-1",
    ownerUserId: "viewer-1",
  },
  ownerHostId: "epic-host",
  createdAt: 1,
  visibility: "task",
  title: "Walkthrough",
  isTitleEditedByUser: false,
  parentChatId: null,
  isArchived: false,
  runSettingsSummary: null,
  metadataUpdatedAt: 1,
  headSha256: null,
  publishedAt: 1,
  throughRecordSeq: null,
  isOwnedByViewer: true,
};

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

function getCapturedMutation(method: string): CapturedMutationArgs {
  const mutation = capturedMutations[method];
  if (mutation === undefined) {
    throw new Error(`expected ${method} mutation capture`);
  }
  return mutation;
}

const VISIBILITY_VARS = {
  taskId: "task-1",
  chatId: "chat-1",
  visibility: "task" as const,
};

const DEFAULT_VARS = {
  taskId: "task-1",
  defaultVisibility: "task" as const,
  applyToExisting: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetChatSharingInFlightForTests();
  for (const method of Object.keys(capturedMutations)) {
    delete capturedMutations[method];
  }
});

describe("useEpicSetCloudChatVisibility", () => {
  it("reconciles the returned row and invalidates the viewer-scoped cloud-chat keys", () => {
    const { wrapper, queryClient } = makeWrapperWithClient();
    const listKey = cloudChatListQueryKey({
      hostId: "epic-host",
      viewerUserId: "viewer-1",
      taskId: "task-1",
    });
    queryClient.setQueryData(listKey, {
      chats: [{ ...CHAT, visibility: "private" }],
    });
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();

    renderHook(() => useEpicSetCloudChatVisibility(), { wrapper });
    const mutation = getCapturedMutation("epic.setCloudChatVisibility");
    expect(mutation.client).toBe(epicSessionHostClient);
    const opts = mutation.options as {
      onMutate: (variables: typeof VISIBILITY_VARS) => {
        readonly hostId: string | null;
        readonly viewerUserId: string;
      };
      onSuccess: (
        data: { readonly chat: CloudChatSummary },
        variables: typeof VISIBILITY_VARS,
        ctx: { readonly hostId: string | null; readonly viewerUserId: string },
        mutationContext: MutationFunctionContext,
      ) => void;
      onSettled: (
        data: unknown,
        error: unknown,
        variables: typeof VISIBILITY_VARS,
        ctx: { readonly hostId: string | null; readonly viewerUserId: string },
      ) => void;
    };

    const ctx = opts.onMutate(VISIBILITY_VARS);
    expect(ctx).toEqual({ hostId: "epic-host", viewerUserId: "viewer-1" });
    expect(isChatSharingInFlight("task-1", "viewer-1")).toBe(true);
    opts.onSuccess({ chat: CHAT }, VISIBILITY_VARS, ctx, {
      client: queryClient,
      meta: undefined,
    });
    opts.onSettled({ chat: CHAT }, null, VISIBILITY_VARS, ctx);

    expect(queryClient.getQueryData(listKey)).toEqual({ chats: [CHAT] });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: cloudChatQueryKeys.scope("epic-host", "viewer-1"),
    });
    expect(isChatSharingInFlight("task-1", "viewer-1")).toBe(false);
  });

  it("mutates the redirected cloud lineage and patches the session-host cache", () => {
    const { wrapper, queryClient } = makeWrapperWithClient();
    const localId = "chat-c1";
    const publishedId = "chat-c2";
    const clone: CloudChatSummary = {
      ...CHAT,
      identity: { ...CHAT.identity, chatId: publishedId },
    };
    const incumbent: CloudChatSummary = {
      ...CHAT,
      identity: { ...CHAT.identity, chatId: localId },
    };
    const sessionListKey = cloudChatListQueryKey({
      hostId: "epic-host",
      viewerUserId: "viewer-1",
      taskId: "task-1",
    });
    const activeHostListKey = cloudChatListQueryKey({
      hostId: "active-host",
      viewerUserId: "viewer-1",
      taskId: "task-1",
    });
    queryClient.setQueryData(sessionListKey, {
      chats: [incumbent, clone],
    });
    queryClient.setQueryData(activeHostListKey, {
      chats: [incumbent, clone],
    });

    const folded = indexOwnCloudChatsByLocalId({
      chats: [incumbent, clone],
      localChatIds: [localId],
      publicationChatIdByChatId: new Map([[localId, publishedId]]),
    });
    const target = folded.get(localId);
    expect(target?.identity.chatId).toBe(publishedId);

    renderHook(() => useEpicSetCloudChatVisibility(), { wrapper });
    const mutation = getCapturedMutation("epic.setCloudChatVisibility");
    expect(mutation.client).toBe(epicSessionHostClient);
    const variables = {
      taskId: "task-1",
      chatId: target?.identity.chatId ?? "",
      visibility: "private" as const,
    };
    const opts = mutation.options as {
      onMutate: (next: typeof variables) => {
        readonly hostId: string | null;
        readonly viewerUserId: string;
      };
      onSuccess: (
        data: { readonly chat: CloudChatSummary },
        next: typeof variables,
        ctx: { readonly hostId: string | null; readonly viewerUserId: string },
        mutationContext: MutationFunctionContext,
      ) => void;
      onSettled: (
        data: unknown,
        error: unknown,
        next: typeof variables,
        ctx: { readonly hostId: string | null; readonly viewerUserId: string },
      ) => void;
    };
    expect(variables.chatId).toBe(publishedId);
    const ctx = opts.onMutate(variables);
    expect(ctx.hostId).toBe("epic-host");
    const updated = { ...clone, visibility: "private" as const };
    opts.onSuccess({ chat: updated }, variables, ctx, {
      client: queryClient,
      meta: undefined,
    });
    opts.onSettled({ chat: updated }, null, variables, ctx);

    expect(queryClient.getQueryData(sessionListKey)).toEqual({
      chats: [incumbent, updated],
    });
    expect(queryClient.getQueryData(activeHostListKey)).toEqual({
      chats: [incumbent, clone],
    });
  });

  it("toasts a generic fallback on a real failure", () => {
    renderHook(() => useEpicSetCloudChatVisibility(), {
      wrapper: makeWrapperWithClient().wrapper,
    });
    const opts = getCapturedMutation("epic.setCloudChatVisibility").options as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(makeError("RPC_ERROR"));
    expect(toast.error).toHaveBeenCalledWith("Couldn't update sharing.");
  });
});

describe("useEpicSetChatSharingDefault", () => {
  it("applies the written visibility to every own row and invalidates the viewer scope", () => {
    const { wrapper, queryClient } = makeWrapperWithClient();
    const listKey = cloudChatListQueryKey({
      hostId: "epic-host",
      viewerUserId: "viewer-1",
      taskId: "task-1",
    });
    queryClient.setQueryData(listKey, {
      chats: [{ ...CHAT, visibility: "private" }],
    });
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();

    renderHook(() => useEpicSetChatSharingDefault(), { wrapper });
    const mutation = getCapturedMutation("epic.setChatSharingDefault");
    expect(mutation.client).toBe(epicSessionHostClient);
    const opts = mutation.options as {
      onMutate: (variables: typeof DEFAULT_VARS) => {
        readonly hostId: string | null;
        readonly viewerUserId: string;
      };
      onSuccess: (
        data: { readonly updatedCount: number },
        variables: typeof DEFAULT_VARS,
        ctx: { readonly hostId: string | null; readonly viewerUserId: string },
        mutationContext: MutationFunctionContext,
      ) => void;
      onSettled: (
        data: unknown,
        error: unknown,
        variables: typeof DEFAULT_VARS,
        ctx: { readonly hostId: string | null; readonly viewerUserId: string },
      ) => void;
    };

    const ctx = opts.onMutate(DEFAULT_VARS);
    expect(ctx).toEqual({ hostId: "epic-host", viewerUserId: "viewer-1" });
    opts.onSuccess({ updatedCount: 1 }, DEFAULT_VARS, ctx, {
      client: queryClient,
      meta: undefined,
    });
    opts.onSettled({ updatedCount: 1 }, null, DEFAULT_VARS, ctx);

    expect(queryClient.getQueryData(listKey)).toEqual({ chats: [CHAT] });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: cloudChatQueryKeys.scope("epic-host", "viewer-1"),
    });
  });

  it("shares one in-flight gate across the master toggle and a per-chat flip", () => {
    const { wrapper } = makeWrapperWithClient();
    renderHook(() => useEpicSetChatSharingDefault(), { wrapper });
    renderHook(() => useEpicSetCloudChatVisibility(), { wrapper });

    const defaultOpts = getCapturedMutation("epic.setChatSharingDefault")
      .options as {
      onMutate: (variables: typeof DEFAULT_VARS) => unknown;
      onError: (error: HostRpcError) => void;
      onSettled: (
        data: unknown,
        error: unknown,
        variables: typeof DEFAULT_VARS,
        ctx: unknown,
      ) => void;
    };
    const visibilityOpts = getCapturedMutation("epic.setCloudChatVisibility")
      .options as {
      onMutate: (variables: typeof VISIBILITY_VARS) => unknown;
      onError: (error: HostRpcError) => void;
      onSettled: (
        data: unknown,
        error: unknown,
        variables: typeof VISIBILITY_VARS,
        ctx: unknown,
      ) => void;
    };

    const ctx = defaultOpts.onMutate(DEFAULT_VARS);
    expect(isChatSharingInFlight("task-1", "viewer-1")).toBe(true);
    expect(() => visibilityOpts.onMutate(VISIBILITY_VARS)).toThrow(
      CHAT_SHARING_IN_FLIGHT_MESSAGE,
    );
    visibilityOpts.onError(
      new HostRpcError({
        code: "RPC_ERROR",
        message: CHAT_SHARING_IN_FLIGHT_MESSAGE,
        requestId: "test",
        method: "epic.setCloudChatVisibility",
        fatalDetails: null,
      }),
    );
    expect(toast.error).not.toHaveBeenCalled();
    visibilityOpts.onSettled(undefined, null, VISIBILITY_VARS, undefined);
    expect(isChatSharingInFlight("task-1", "viewer-1")).toBe(true);
    defaultOpts.onSettled({ updatedCount: 0 }, null, DEFAULT_VARS, ctx);
    expect(isChatSharingInFlight("task-1", "viewer-1")).toBe(false);
  });
});
