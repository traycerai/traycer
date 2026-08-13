import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { createElement } from "react";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const epicSessionHostClient = vi.hoisted(() => ({
  request: vi.fn(),
  getActiveHostId: () => "host-test",
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => epicSessionHostClient,
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/chats/use-cloud-chat-queries")>();
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
  ownerHostId: "host-test",
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

beforeEach(() => {
  vi.clearAllMocks();
  for (const method of Object.keys(capturedMutations)) {
    delete capturedMutations[method];
  }
});

describe("useEpicSetCloudChatVisibility", () => {
  it("reconciles the returned row and invalidates the viewer-scoped cloud-chat keys", () => {
    const { wrapper, queryClient } = makeWrapperWithClient();
    const listKey = cloudChatListQueryKey({
      hostId: "host-test",
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
    const opts = getCapturedMutation("epic.setCloudChatVisibility").options as {
      onMutate: () => {
        readonly hostId: string | null;
        readonly viewerUserId: string;
      };
      onSuccess: (
        data: { readonly chat: CloudChatSummary },
        variables: unknown,
        ctx: { readonly hostId: string | null; readonly viewerUserId: string },
        mutationContext: MutationFunctionContext,
      ) => void;
    };

    const ctx = opts.onMutate();
    expect(ctx).toEqual({ hostId: "host-test", viewerUserId: "viewer-1" });
    opts.onSuccess({ chat: CHAT }, {}, ctx, {
      client: queryClient,
      meta: undefined,
    });

    expect(queryClient.getQueryData(listKey)).toEqual({ chats: [CHAT] });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: cloudChatQueryKeys.scope("host-test", "viewer-1"),
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
      hostId: "host-test",
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
    const opts = getCapturedMutation("epic.setChatSharingDefault").options as {
      onMutate: () => {
        readonly hostId: string | null;
        readonly viewerUserId: string;
      };
      onSuccess: (
        data: { readonly updatedCount: number },
        variables: {
          readonly taskId: string;
          readonly defaultVisibility: "private" | "task";
          readonly applyToExisting: boolean;
        },
        ctx: { readonly hostId: string | null; readonly viewerUserId: string },
        mutationContext: MutationFunctionContext,
      ) => void;
    };

    const ctx = opts.onMutate();
    opts.onSuccess(
      { updatedCount: 1 },
      {
        taskId: "task-1",
        defaultVisibility: "task",
        applyToExisting: true,
      },
      ctx,
      { client: queryClient, meta: undefined },
    );

    expect(queryClient.getQueryData(listKey)).toEqual({ chats: [CHAT] });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: cloudChatQueryKeys.scope("host-test", "viewer-1"),
    });
  });
});
