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

function makeError(code: RpcErrorCode, message: string): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "test",
    method: "epic.createChat",
    fatalDetails: null,
  });
}

/**
 * Verbatim shape of what the host puts on the wire when the requested worktree
 * could not be made: `WorktreeCreateFailedError` joins each failed entry's own
 * `git worktree add` stderr, and `dispatchRpc` answers 409 `RPC_ERROR` with
 * that string as the message - no dedicated wire code, by design. The reason
 * exists NOWHERE else the user can reach, which is why this arm forwards it.
 */
const WORKTREE_CREATE_FAILED_MESSAGE =
  "git worktree add failed for traycer/tidy-badger at " +
  "/Users/x/.traycer/worktrees/repo-tidy-badger: " +
  "fatal: a branch named 'traycer/tidy-badger' already exists";

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

/**
 * The MANUAL fork dialog's request: a precise boundary the user picked. Nobody
 * retries it, so every refusal it earns is terminal and must be reported.
 */
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

/**
 * The CLONE-on-host-switch request. `boundary: "latest"` has exactly one
 * producer in this app (`cloneChatOnHostSwitch`), and that producer is standing
 * by to narrate the history downgrade and retry without `forkSource`.
 */
const CLONE_VARIABLES: CreateChatMutationInput = {
  hostId: "host-test",
  epicId: "e",
  chatId: "c",
  parentId: null,
  title: "t",
  forkSource: {
    boundary: "latest",
    sourceChatId: "source-chat",
    sourceOwnerUserId: null,
  },
};

/** A plain create - the new-agent modal's shape, no fork at all. */
const PLAIN_VARIABLES: CreateChatMutationInput = {
  hostId: "host-test",
  epicId: "e",
  chatId: "c",
  parentId: null,
  title: "t",
};

describe("useEpicCreateChatForHostClient error policy", () => {
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
    getCreateOnError()(
      makeError("E_FORK_BOUNDARY_NOT_PUBLISHED", "test"),
      VARIABLES,
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(clearPendingChatCreation).toHaveBeenCalledWith("e", "c");
  });

  it("still toasts any other error code", () => {
    renderHook(() => useEpicCreateChatForHostClient(null), {
      wrapper: makeWrapper(),
    });
    getCreateOnError()(makeError("RPC_ERROR", "test"), VARIABLES);
    expect(toast.error).toHaveBeenCalledWith("Couldn't create agent. test");
  });

  // The staging finding: the 409 carried "…a branch named 'traycer/tidy-badger'
  // already exists" and the user was shown "Couldn't create agent." alone, with
  // the reason reachable only by opening host.log.
  it("names the worktree failure the host reported, not just 'Couldn't create agent.'", () => {
    renderHook(() => useEpicCreateChatForHostClient(null), {
      wrapper: makeWrapper(),
    });
    getCreateOnError()(
      makeError("RPC_ERROR", WORKTREE_CREATE_FAILED_MESSAGE),
      VARIABLES,
    );
    expect(toast.error).toHaveBeenCalledWith(
      `Couldn't create agent. ${WORKTREE_CREATE_FAILED_MESSAGE}`,
    );
  });

  // The other half of forwarding detail: an error the toast mapper already has
  // written-for-a-person copy for must NOT gain a raw host suffix.
  it("leaves a mapped code's copy alone rather than appending the raw message", () => {
    renderHook(() => useEpicCreateChatForHostClient(null), {
      wrapper: makeWrapper(),
    });
    getCreateOnError()(
      makeError("E_HOST_UNSUPPORTED", "epic.createChat@12.0 not supported"),
      VARIABLES,
    );
    expect(toast.error).toHaveBeenCalledWith(
      "This needs a newer Traycer host. Update the host to continue.",
    );
  });

  // Review #1297 finding 1. The clone flow recovers from both of these - it
  // narrates the downgrade and retries without `forkSource` - so a toast here
  // describes an attempt, not an outcome, and the detail policy above makes it
  // read as a specific terminal failure moments before the clone succeeds.
  it.each([
    ["E_FORK_CHECKPOINT_UNAVAILABLE" as const, "no assistant checkpoint yet"],
    ["DOWNGRADE_UNSUPPORTED" as const, "epic.createChat@1.1 unavailable"],
  ])(
    "stays silent on %s for the clone's latest-boundary fork - the flow retries",
    (code, message) => {
      renderHook(() => useEpicCreateChatForHostClient(null), {
        wrapper: makeWrapper(),
      });
      getCreateOnError()(makeError(code, message), CLONE_VARIABLES);
      expect(toast.error).not.toHaveBeenCalled();
      // Still released: no record will arrive for an attempt that failed, and
      // the retry creates under its own id.
      expect(clearPendingChatCreation).toHaveBeenCalledWith("e", "c");
    },
  );

  // The guard that keeps the suppression from swallowing a real failure. Same
  // code, precise boundary: the manual fork dialog has no retry behind it.
  it("still toasts E_FORK_CHECKPOINT_UNAVAILABLE for a precise-boundary fork", () => {
    renderHook(() => useEpicCreateChatForHostClient(null), {
      wrapper: makeWrapper(),
    });
    getCreateOnError()(
      makeError("E_FORK_CHECKPOINT_UNAVAILABLE", "no assistant checkpoint yet"),
      VARIABLES,
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't create agent. no assistant checkpoint yet",
    );
  });

  // And the suppression is scoped to the codes the flow retries on, not to the
  // clone request as a whole - a worktree failure on a clone is terminal.
  it("still toasts a non-recoverable failure on the clone's own request", () => {
    renderHook(() => useEpicCreateChatForHostClient(null), {
      wrapper: makeWrapper(),
    });
    getCreateOnError()(
      makeError("RPC_ERROR", WORKTREE_CREATE_FAILED_MESSAGE),
      CLONE_VARIABLES,
    );
    expect(toast.error).toHaveBeenCalledWith(
      `Couldn't create agent. ${WORKTREE_CREATE_FAILED_MESSAGE}`,
    );
  });

  it("toasts a checkpoint refusal that arrives with no fork source at all", () => {
    renderHook(() => useEpicCreateChatForHostClient(null), {
      wrapper: makeWrapper(),
    });
    getCreateOnError()(
      makeError("E_FORK_CHECKPOINT_UNAVAILABLE", "no assistant checkpoint yet"),
      PLAIN_VARIABLES,
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't create agent. no assistant checkpoint yet",
    );
  });
});
