import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  renderHook,
  screen,
  type RenderHookResult,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HydrateChatResponse } from "@traycer/protocol/host/epic/chat-hydration";
import type { RpcErrorCode } from "@traycer/protocol/framework/versioned-rpc-types";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import {
  MESSAGE_CONTENT,
  PICKED_SETTINGS,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { Toaster } from "@/components/ui/sonner";
import type { HostReachability } from "@/hooks/agent/use-host-reachability";

const reachability = vi.hoisted(() => ({
  status: "reachable" as HostReachability["status"],
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: (): HostReachability => ({
    status: reachability.status,
    hostLabel: "Laptop",
    unavailability: null,
    basis: "directory",
    hostKind: "remote",
  }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => requireTeamHostClient(),
}));

import {
  useEvictedChatSend,
  type EvictedChatSend,
  type ParkedEvictedSend,
} from "@/hooks/chats/use-evicted-chat-send";
import { useChatContinuingOnItsHost } from "@/lib/chats/chat-continuing-on-host";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

const CHAT = { hostId: "host-chat", epicId: "epic-1", chatId: "chat-1" };

const INPUT: ChatComposerSubmitInput = {
  content: MESSAGE_CONTENT,
  contentText: "fix the login bug",
  attachments: [],
  settings: PICKED_SETTINGS,
  deliveryPolicy: "auto",
  restartConfirmed: false,
  restore: { content: MESSAGE_CONTENT, browserAnnotations: [] },
};

interface Deferred {
  readonly resolve: (response: HydrateChatResponse) => void;
  readonly reject: (error: unknown) => void;
}

const hydrates: Deferred[] = [];

function refusal(code: RpcErrorCode): HostRpcError {
  return new HostRpcError({
    code,
    message: "refused",
    requestId: "req-1",
    method: "epic.hydrateChat",
    fatalDetails: null,
  });
}

interface Props {
  readonly served: boolean;
  readonly held: boolean;
}

type SendRender = RenderHookResult<EvictedChatSend, Props>;

function mount(initial: Props): {
  readonly send: SendRender;
  readonly hold: RenderHookResult<boolean, undefined>;
} {
  const page = mountTeamPage(poolSource("owner"), {
    "epic.hydrateChat": () =>
      new Promise<HydrateChatResponse>((resolve, reject) => {
        hydrates.push({ resolve, reject });
      }),
  });
  const Wrapper = ({ children }: { readonly children: ReactNode }) => (
    <page.Wrapper>
      {children}
      <Toaster />
    </page.Wrapper>
  );
  const send = renderHook(
    (props: Props) =>
      useEvictedChatSend({
        epicId: CHAT.epicId,
        chatId: CHAT.chatId,
        hostId: CHAT.hostId,
        ...props,
      }),
    { wrapper: Wrapper, initialProps: initial },
  );
  // A second observer that outlives the first one's unmount.
  const hold = renderHook(() => useChatContinuingOnItsHost(CHAT));
  return { send, hold };
}

function answer(index: number, settle: (deferred: Deferred) => void): void {
  const deferred = hydrates.at(index);
  if (deferred === undefined) throw new Error("no hydrate request");
  settle(deferred);
}

/** Parks `INPUT` and records what its promise settled to. */
function parkInput(send: SendRender): {
  readonly settled: boolean[];
} {
  const settled: boolean[] = [];
  act(() => {
    const parked = send.result.current.park(INPUT);
    if (parked === false) throw new Error("park refused");
    void parked.then((accepted) => settled.push(accepted));
  });
  return { settled };
}

beforeEach(() => {
  hydrates.length = 0;
  reachability.status = "reachable";
  useComposerDraftStore.setState({ drafts: {} });
});
afterEach(() => {
  cleanup();
});

describe("useEvictedChatSend", () => {
  it("keeps the message pending under the hydrating line, then holds the chat on its host and hands the message over", async () => {
    const { send, hold } = mount({ served: true, held: true });
    const { settled } = parkInput(send);
    await vi.waitFor(() => expect(hydrates).toHaveLength(1));
    expect(send.result.current.line).toBe("hydrating");
    expect(send.result.current.ready).toBe(false);
    expect(settled).toEqual([]);

    await act(async () => {
      answer(0, (d) => d.resolve({ outcome: "hydrated" }));
      await Promise.resolve();
    });

    expect(send.result.current.ready).toBe(true);
    expect(hold.result.current).toBe(true);
    let taken: ParkedEvictedSend | null = null;
    act(() => {
      taken = send.result.current.take();
    });
    expect(taken).toMatchObject({ input: INPUT });
    expect(send.result.current.line).toBeNull();
    expect(send.result.current.ready).toBe(false);
    act(() => taken?.settle(true));
    await vi.waitFor(() => expect(settled).toEqual([true]));
  });

  it("returns the message as the draft under the unreachable line, with no toast, until the draft is edited", async () => {
    const { send } = mount({ served: false, held: false });
    const toastsBefore = toast.getToasts().length;
    const { settled } = parkInput(send);
    await vi.waitFor(() => expect(hydrates).toHaveLength(1));

    await act(async () => {
      answer(0, (d) => d.reject(refusal("CHAT_EVICTED_UNREACHABLE")));
      await Promise.resolve();
    });

    expect(settled).toEqual([false]);
    expect(send.result.current.line).toBe("unreachable");
    expect(send.result.current.parks).toBe(true);
    expect(toast.getToasts()).toHaveLength(toastsBefore);

    act(() => {
      useComposerDraftStore
        .getState()
        .setSnapshot(CHAT.chatId, MESSAGE_CONTENT, null);
    });
    expect(send.result.current.line).toBeNull();
    expect(send.result.current.parks).toBe(true);
  });

  it("ends the unreachable line when the owner host goes away and comes back", async () => {
    const { send } = mount({ served: true, held: true });
    parkInput(send);
    await vi.waitFor(() => expect(hydrates).toHaveLength(1));
    await act(async () => {
      answer(0, (d) => d.reject(refusal("CHAT_EVICTED_UNREACHABLE")));
      await Promise.resolve();
    });
    expect(send.result.current.line).toBe("unreachable");

    reachability.status = "unreachable";
    send.rerender({ served: true, held: true });
    expect(send.result.current.line).toBe("unreachable");

    reachability.status = "reachable";
    send.rerender({ served: true, held: true });
    expect(send.result.current.line).toBeNull();
  });

  it("says the chat was continued elsewhere on a moved head", async () => {
    const { send } = mount({ served: true, held: true });
    const { settled } = parkInput(send);
    await vi.waitFor(() => expect(hydrates).toHaveLength(1));

    await act(async () => {
      answer(0, (d) => d.reject(refusal("CHAT_EVICTED_HEAD_MOVED")));
      await Promise.resolve();
    });

    expect(settled).toEqual([false]);
    expect(send.result.current.line).toBe("head-moved");
  });

  it("toasts any other failure, shows no line and returns the message", async () => {
    const { send } = mount({ served: true, held: true });
    const { settled } = parkInput(send);
    await vi.waitFor(() => expect(hydrates).toHaveLength(1));

    await act(async () => {
      answer(0, (d) => d.reject(refusal("RPC_ERROR")));
      await Promise.resolve();
    });

    expect(settled).toEqual([false]);
    expect(send.result.current.line).toBeNull();
    expect(await screen.findByText(/Couldn't send this message/)).toBeTruthy();
  });

  it("hands the draft back and releases the hold when the tile closes with a message parked", async () => {
    const { send, hold } = mount({ served: true, held: true });
    const { settled } = parkInput(send);
    await vi.waitFor(() => expect(hydrates).toHaveLength(1));
    await act(async () => {
      answer(0, (d) => d.resolve({ outcome: "hydrated" }));
      await Promise.resolve();
    });
    expect(hold.result.current).toBe(true);

    send.unmount();

    await vi.waitFor(() => expect(settled).toEqual([false]));
    expect(hold.result.current).toBe(false);
  });

  it("releases the hold once the witness no longer reads the chat at rest", async () => {
    const { send, hold } = mount({ served: true, held: true });
    parkInput(send);
    await vi.waitFor(() => expect(hydrates).toHaveLength(1));
    await act(async () => {
      answer(0, (d) => d.resolve({ outcome: "hydrated" }));
      await Promise.resolve();
    });
    expect(hold.result.current).toBe(true);

    send.rerender({ served: false, held: false });

    expect(hold.result.current).toBe(false);
  });
});
