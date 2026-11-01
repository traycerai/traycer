import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";
import type { CreateChatCommandCallbacks } from "@/lib/commands/actions/new-chat";
import { useChatCloneOnHostSwitch } from "../use-chat-clone-on-host-switch";

/**
 * Pressing Continue on another host from a chat with no copy, through the real
 * hook and the real `cloneChatOnHostSwitch`: only the host that answers
 * `epic.createChat`, the target selection and the projection the new chat is
 * opened from are stood in for. The sandbox end line's button
 * (`SandboxEndActions`) calls this hook's `clone` and nothing else, but its
 * own mount needs an epic session, owner lookups and a host binding that the
 * button's suites sever, so this drives `clone` itself.
 */
const mocks = vi.hoisted(() => ({
  requests: [] as unknown[],
  answers: [] as unknown[],
  callbacks: [] as unknown[],
  opened: [] as { readonly chatId: string; readonly hostId: string }[],
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn() }),
}));
vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    directory: { findById: () => null },
    hostClient: { request: vi.fn() },
  }),
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-B",
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({}),
}));
vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => vi.fn(),
}));
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: () => ({
    mutate: (
      request: CreateChatMutationInput,
      callbacks: CreateChatCommandCallbacks,
    ) => {
      mocks.requests.push(request);
      const answer = mocks.answers.shift();
      if (answer instanceof HostRpcError) callbacks.onError(answer);
      else callbacks.onSuccess({ chatId: "new-chat" });
    },
  }),
}));
vi.mock("@/lib/commands/actions/new-chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/commands/actions/new-chat")>()),
  openCreatedChatWhenProjectedWithNavigation: (args: {
    readonly intent: { readonly chatId: string; readonly hostId: string };
  }) => {
    mocks.opened.push({
      chatId: args.intent.chatId,
      hostId: args.intent.hostId,
    });
    return () => undefined;
  },
}));

const ARGS = {
  epicId: "epic-1",
  tabId: "tab-1",
  chatId: "chat-1",
  sourceHostId: "host-A",
  sourceSettings: null,
  sourceTitle: "",
  sourceOwnerUserId: "user-1",
};

function refusal(code: string): HostRpcError {
  return new HostRpcError({
    code: code as never,
    message: "refused",
    requestId: "r",
    method: "epic.createChat",
    fatalDetails: null,
  });
}

function forkSourceOf(request: unknown): unknown {
  return (request as CreateChatMutationInput).forkSource;
}

beforeEach(() => {
  mocks.requests = [];
  mocks.answers = [];
  mocks.opened = [];
  vi.mocked(toast).mockClear();
});
afterEach(cleanup);

describe("Continue on another host from a chat the host cannot carry history for", () => {
  it.each([
    [
      "no published checkpoint",
      "E_FORK_CHECKPOINT_UNAVAILABLE",
      "This agent's history can't be carried - continuing without it.",
    ],
    [
      "a host version that cannot receive it",
      "DOWNGRADE_UNSUPPORTED",
      "This device can't send this agent's history to that host version - continuing without it.",
    ],
  ])(
    "says the exact sentence for %s and lands the clone without history",
    async (_case, code, sentence) => {
      mocks.answers = [refusal(code)];
      const { result } = renderHook(() => useChatCloneOnHostSwitch(ARGS));

      act(() => {
        result.current.clone();
      });
      await waitFor(() => {
        expect(mocks.opened).toEqual([
          { chatId: "new-chat", hostId: "host-B" },
        ]);
      });

      expect(vi.mocked(toast).mock.calls).toEqual([[sentence]]);
      expect(mocks.requests).toHaveLength(2);
      expect(forkSourceOf(mocks.requests[0])).toMatchObject({
        boundary: "latest",
        sourceChatId: "chat-1",
      });
      expect(forkSourceOf(mocks.requests[1])).toBeNull();
    },
  );
});
