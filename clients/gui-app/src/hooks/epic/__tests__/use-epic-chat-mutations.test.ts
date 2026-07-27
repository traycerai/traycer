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

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-test",
}));

const { forceReleaseChatSession } = vi.hoisted(() => ({
  forceReleaseChatSession: vi.fn(),
}));
vi.mock("@/lib/registries/chat-session-registry", () => ({
  getChatSessionRegistry: () => ({
    forceRelease: forceReleaseChatSession,
  }),
}));

import type { CreateChatRequest } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  CreateChatMutationInput,
  DeleteChatMutationOptions,
} from "@/hooks/epic/use-epic-chat-mutations";

interface CapturedMutationArgs {
  readonly method: string;
  readonly options: unknown;
  readonly mapVariables:
    ((variables: CreateChatMutationInput) => CreateChatRequest) | undefined;
}

const capturedMutations: Partial<Record<string, CapturedMutationArgs>> = {};
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: CapturedMutationArgs) => {
    capturedMutations[args.method] = args;
    return { mutate: vi.fn(), isPending: false };
  },
}));

import { toast } from "sonner";
import { renderHook } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type MutationFunctionContext,
} from "@tanstack/react-query";
import {
  useEpicCreateChat,
  useEpicRenameChat,
  useEpicDeleteChat,
} from "@/hooks/epic/use-epic-chat-mutations";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";

function makeError(code: RpcErrorCode): HostRpcError {
  return new HostRpcError({
    code,
    message: "test",
    requestId: "test",
    method: "test",
    fatalDetails: null,
  });
}

function makeWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
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

describe("useEpicCreateChat", () => {
  it("stamps the active host id before delegating to useHostMutation", () => {
    renderHook(() => useEpicCreateChat(), { wrapper: makeWrapper() });

    const mutation = getCapturedMutation("epic.createChat");
    if (mutation.mapVariables === undefined) {
      throw new Error("expected createChat mutation capture");
    }

    const params = mutation.mapVariables({
      epicId: "e",
      chatId: "c",
      parentId: null,
      title: "t",
    });

    expect(params).toEqual({
      hostId: "host-test",
      epicId: "e",
      chatId: "c",
      parentId: null,
      title: "t",
    } satisfies CreateChatRequest);
  });

  it("shows fallback on error", () => {
    renderHook(() => useEpicCreateChat(), { wrapper: makeWrapper() });
    const opts = getCapturedMutation("epic.createChat").options as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(makeError("RPC_ERROR"));
    expect(toast.error).toHaveBeenCalledWith("Couldn't create agent.");
  });
});

describe("useEpicRenameChat", () => {
  it("shows fallback on error", () => {
    renderHook(() => useEpicRenameChat());
    const opts = getCapturedMutation("epic.renameChat").options as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(makeError("RPC_ERROR"));
    expect(toast.error).toHaveBeenCalledWith("Couldn't rename agent.");
  });
});

describe("useEpicDeleteChat", () => {
  it("force-releases the deleted chat session on success", () => {
    renderHook(() => useEpicDeleteChat());
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
      undefined,
      mutationContext,
    );

    expect(forceReleaseChatSession).toHaveBeenCalledWith("epic-1", "chat-1");
  });

  it("shows fallback on error", () => {
    renderHook(() => useEpicDeleteChat());
    const opts = getCapturedMutation("epic.deleteChat").options as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(makeError("RPC_ERROR"));
    expect(toast.error).toHaveBeenCalledWith("Couldn't delete agent.");
  });
});
