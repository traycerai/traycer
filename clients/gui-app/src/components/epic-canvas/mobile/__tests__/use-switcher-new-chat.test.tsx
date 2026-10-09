import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostRpcRegistry } from "@/lib/host";
import type { LandingPlacementTarget } from "@/lib/composer/landing-placement";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";
import type { CreatedChatOpenIntent } from "@/lib/commands/actions";
import type { CreateChatResponseV12 } from "@traycer/protocol/host/epic/unary-schemas";
import { useSwitcherNewChat } from "@/components/epic-canvas/mobile/use-switcher-new-chat";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const HOST_ID = "host-A";

const spies = vi.hoisted(() => ({
  mutate: vi.fn<(request: CreateChatMutationInput) => void>(),
  /** Resolves the in-flight `mutateAsync` of the last send. */
  answer: {
    current: (_response: CreateChatResponseV12): void => undefined,
  },
  setSelection: vi.fn(),
  openWhenProjected:
    vi.fn<(args: { readonly intent: CreatedChatOpenIntent }) => () => void>(),
  toastError: vi.fn(),
  placement: { refused: false },
  isPending: false,
}));

vi.mock("sonner", () => ({ toast: { error: spies.toastError } }));
vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "host-A",
}));
vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => () => undefined,
}));
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: () => ({
    mutateAsync: (request: CreateChatMutationInput) =>
      new Promise<CreateChatResponseV12>((resolve) => {
        spies.mutate(request);
        spies.answer.current = resolve;
      }),
    isPending: spies.isPending,
  }),
}));
vi.mock("@/hooks/host/use-composer-placement", () => ({
  useEpicConversationPlacement: () => ({
    pin: { setSelection: spies.setSelection },
    submitTarget: submitTarget(spies.placement.refused ? null : HOST_ID),
  }),
}));
// Keep `openNewChatInActiveTile` real; only the projection wait is a boundary.
vi.mock("@/lib/commands/actions/new-chat", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/commands/actions/new-chat")>();
  return {
    ...actual,
    openCreatedChatWhenProjectedWithNavigation: spies.openWhenProjected,
  };
});

/** Only host identity is asked of the client; typed factory, no `as unknown`. */
function submitTarget(hostId: string | null): LandingPlacementTarget {
  if (hostId === null) {
    return {
      resolvedHostId: null,
      client: null,
      hostLabel: "This device",
      isPinned: false,
      namedHostDead: false,
    };
  }
  const activeHost: HostDirectoryEntry = {
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: "ws://127.0.0.1:4917/rpc",
    version: "0.0.0-test",
    transportDialability: "dialable",
  };
  const client: Pick<
    HostClient<HostRpcRegistry>,
    "getActiveHost" | "getActiveHostId"
  > = {
    getActiveHost: () => activeHost,
    getActiveHostId: () => hostId,
  };
  return {
    resolvedHostId: hostId,
    client: client as HostClient<HostRpcRegistry>,
    hostLabel: hostId,
    isPinned: false,
    namedHostDead: false,
  };
}

function lastCreate(): { readonly request: CreateChatMutationInput } {
  const call = spies.mutate.mock.calls.at(-1);
  if (call === undefined) throw new Error("epic.createChat was not sent");
  return { request: call[0] };
}

/** The host answers; the hook's `.then` runs on the microtask queue. */
async function answer(response: CreateChatResponseV12): Promise<void> {
  await act(async () => {
    spies.answer.current(response);
    await Promise.resolve();
  });
}

beforeEach(() => {
  spies.mutate.mockReset();
  spies.setSelection.mockReset();
  spies.openWhenProjected.mockReset();
  spies.toastError.mockReset();
  spies.placement.refused = false;
  spies.isPending = false;
  useNewConversationModalOpenStore.getState().close();
});
afterEach(() => {
  useNewConversationModalOpenStore.getState().close();
});

describe("useSwitcherNewChat", () => {
  it("sends one empty epic.createChat on the resolved host and opens it when answered", async () => {
    const onOpened = vi.fn();
    const { result } = renderHook(() =>
      useSwitcherNewChat(EPIC_ID, TAB_ID, onOpened),
    );
    act(() => result.current.start(null));

    expect(spies.mutate).toHaveBeenCalledTimes(1);
    const { request } = lastCreate();
    expect(request).toMatchObject({
      epicId: EPIC_ID,
      hostId: HOST_ID,
      parentId: null,
      title: "",
      settings: null,
      worktreeIntent: null,
      forkSource: null,
    });
    expect("initialMessage" in request).toBe(false);
    expect(spies.setSelection).toHaveBeenCalledWith(HOST_ID);
    expect(onOpened).not.toHaveBeenCalled();

    await answer({ chatId: "chat-new" });
    expect(spies.openWhenProjected).toHaveBeenCalledTimes(1);
    expect(spies.openWhenProjected.mock.calls[0][0].intent).toMatchObject({
      epicId: EPIC_ID,
      tabId: TAB_ID,
      chatId: "chat-new",
      hostId: HOST_ID,
    });
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("opens nothing when the host refuses the create", async () => {
    const onOpened = vi.fn();
    const { result } = renderHook(() =>
      useSwitcherNewChat(EPIC_ID, TAB_ID, onOpened),
    );
    act(() => result.current.start(null));
    await answer({
      chatId: "never-made",
      refusal: {
        kind: "local-store-unavailable",
        message: "unavailable",
        remedy: "retry",
      },
    });
    expect(spies.openWhenProjected).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("still opens the chat when the sheet unmounts before the host answers", async () => {
    const { result, unmount } = renderHook(() =>
      useSwitcherNewChat(EPIC_ID, TAB_ID, vi.fn()),
    );
    act(() => result.current.start(null));
    unmount();
    await answer({ chatId: "chat-late" });
    expect(spies.openWhenProjected).toHaveBeenCalledTimes(1);
  });

  it("creates a child when given a parent id", () => {
    const { result } = renderHook(() =>
      useSwitcherNewChat(EPIC_ID, TAB_ID, vi.fn()),
    );
    act(() => result.current.start("parent-1"));
    expect(lastCreate().request.parentId).toBe("parent-1");
  });

  it("toasts and creates nothing when the placement is refused", () => {
    spies.placement.refused = true;
    const onOpened = vi.fn();
    const { result } = renderHook(() =>
      useSwitcherNewChat(EPIC_ID, TAB_ID, onOpened),
    );
    act(() => result.current.start(null));
    expect(spies.toastError).toHaveBeenCalledTimes(1);
    expect(spies.mutate).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("never files a New Conversation modal request", () => {
    const { result } = renderHook(() =>
      useSwitcherNewChat(EPIC_ID, TAB_ID, vi.fn()),
    );
    act(() => result.current.start(null));
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
  });

  it("ignores a second start while a create is pending", () => {
    spies.isPending = true;
    const { result } = renderHook(() =>
      useSwitcherNewChat(EPIC_ID, TAB_ID, vi.fn()),
    );
    expect(result.current.isPending).toBe(true);
    act(() => result.current.start(null));
    expect(spies.mutate).not.toHaveBeenCalled();
  });
});
