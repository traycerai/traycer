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

const { beginPendingChatCreation, clearPendingChatCreation } = vi.hoisted(
  () => ({
    beginPendingChatCreation: vi.fn(),
    clearPendingChatCreation: vi.fn(),
  }),
);

vi.mock("@/lib/chats/pending-chat-creations", () => ({
  beginPendingChatCreation,
  clearPendingChatCreation,
}));

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
      mutateAsync: vi.fn(),
      isPending: false,
    };
  },
}));

import { toast } from "sonner";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEpicCreateChatForHostClient } from "@/hooks/epic/use-epic-chat-mutations";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";

function makeError(code: RpcErrorCode): HostRpcError {
  return new HostRpcError({
    code,
    message: "test",
    requestId: "test",
    method: "epic.createChat",
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

function getCreateOnError(): (
  error: HostRpcError,
  variables: CreateChatMutationInput,
) => void {
  const mutation = capturedMutations["epic.createChat"];
  if (mutation === undefined) {
    throw new Error("expected epic.createChat mutation capture");
  }
  return (
    mutation.options as {
      onError: (
        error: HostRpcError,
        variables: CreateChatMutationInput,
      ) => void;
    }
  ).onError;
}

const VARIABLES: CreateChatMutationInput = {
  hostId: "host-test",
  epicId: "e",
  chatId: "c",
  parentId: null,
  title: "t",
  forkSource: {
    boundary: "assistantMessage",
    sourceChatId: "source-chat",
    assistantMessageId: "assistant-1",
    sourceOwnerUserId: null,
    interviewBlockId: null,
    carriedInterviews: null,
  },
};

describe("useEpicCreateChatForHostClient inline fork refusal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const method of Object.keys(capturedMutations)) {
      delete capturedMutations[method];
    }
  });

  it("skips the generic create-agent toast for E_FORK_BOUNDARY_NOT_PUBLISHED", () => {
    renderHook(() => useEpicCreateChatForHostClient(null), {
      wrapper: makeWrapper(),
    });
    getCreateOnError()(makeError("E_FORK_BOUNDARY_NOT_PUBLISHED"), VARIABLES);
    expect(toast.error).not.toHaveBeenCalled();
    expect(clearPendingChatCreation).toHaveBeenCalledWith("e", "c");
  });

  it("still toasts any other error code", () => {
    renderHook(() => useEpicCreateChatForHostClient(null), {
      wrapper: makeWrapper(),
    });
    getCreateOnError()(makeError("RPC_ERROR"), VARIABLES);
    expect(toast.error).toHaveBeenCalledWith("Couldn't create agent.");
  });
});
