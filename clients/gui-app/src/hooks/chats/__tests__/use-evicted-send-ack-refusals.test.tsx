import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { JsonContent } from "@traycer/protocol/common/registry";

const sonnerToastError = vi.hoisted(() => vi.fn());
const sonnerToastWarning = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    warning: sonnerToastWarning,
    error: sonnerToastError,
    success: vi.fn(),
    dismiss: vi.fn(),
  }),
  __esModule: true,
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "Laptop",
    unavailability: null,
    basis: "directory",
    hostKind: "remote",
  }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

import { ChatTileErrorNoticeToasts } from "@/components/epic-canvas/renderers/chat-tile-error-notice-toasts";
import { useEvictedChatSend } from "@/hooks/chats/use-evicted-chat-send";
import { useEvictedSendAckRefusals } from "@/hooks/chats/use-evicted-send-ack-refusals";
import type { EvictedChatRefusal } from "@/lib/chats/evicted-chat-refusal";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

const EPIC_ID = "epic-x";
const CHAT_ID = "chat-x";
const OWNER_ID = "owner-x";

const MESSAGE: JsonContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "fix the bug" }] },
  ],
};

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly callbacks: () => ChatStreamCallbacks;
}

function createHarness(): Harness {
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  const harness: Harness = {
    handle,
    callbacks: () => {
      if (callbacks === null) throw new Error("expected callbacks");
      return callbacks;
    },
  };
  harness.callbacks().onConnectionStatus("open", null, null, null);
  harness.callbacks().onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: OWNER_ID,
        hostId: "test-host",
        title: "Chat",
        createdAt: 0,
        updatedAt: 0,
        isTitleEditedByUser: false,
        settings: null,
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [],
        events: [],
        archivedAt: null,
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
      },
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
    },
  });
  return harness;
}

function send(harness: Harness): string {
  const action = harness.handle.store.getState().sendMessage({
    content: MESSAGE,
    sender: { type: "user", userId: OWNER_ID },
    settings: {
      ultracode: false,
      harnessId: "codex",
      model: "gpt-5-codex",
      permissionMode: "supervised",
      reasoningEffort: "medium",
      serviceTier: null,
      agentMode: "epic",
      profileId: null,
    },
    attachments: buildAttachmentsFromJSONContent(MESSAGE),
    deliveryPolicy: "auto",
    restore: { content: MESSAGE, browserAnnotations: [] },
  });
  if (action === null) throw new Error("send refused");
  return action.clientActionId;
}

function reject(harness: Harness, clientActionId: string, code: string): void {
  act(() => {
    harness.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId,
      action: "send",
      status: "rejected",
      reason: "The host refused the message.",
      code,
      backgroundStopTaskIds: [],
      token: null,
    });
  });
}

/** The host's own notice, which follows its ack for the same action. */
function hostNotice(
  harness: Harness,
  clientActionId: string | null,
  code: string,
): void {
  act(() => {
    harness.callbacks().onErrorNotice({
      kind: "errorNotice",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      notice: {
        code,
        message: "The cloud copy could not be reached.",
        severity: "error",
        clientActionId,
      },
    });
  });
}

const refuse = vi.fn<(refusal: EvictedChatRefusal) => void>();

function Tile(props: { readonly handle: ChatSessionStoreHandle }): ReactNode {
  useEvictedSendAckRefusals(props.handle, refuse);
  return <ChatTileErrorNoticeToasts handle={props.handle} />;
}

function toastCount(): number {
  return (
    sonnerToastError.mock.calls.length + sonnerToastWarning.mock.calls.length
  );
}

beforeEach(() => {
  refuse.mockReset();
  sonnerToastError.mockReset();
  sonnerToastWarning.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("a rejected send's ack that carries a CHAT_EVICTED code", () => {
  it("is refused to the composer's line with no toast", () => {
    const harness = createHarness();
    render(<Tile handle={harness.handle} />);

    hostNotice(harness, null, "CHAT_EVICTED_UNREACHABLE");

    expect(refuse.mock.calls).toEqual([["unreachable"]]);
    expect(toastCount()).toBe(0);
  });

  it("still toasts any other code", () => {
    const harness = createHarness();
    render(<Tile handle={harness.handle} />);

    reject(harness, send(harness), "SEND_REJECTED");

    expect(refuse).not.toHaveBeenCalled();
    expect(toastCount()).toBeGreaterThan(0);
  });

  it("is not reported when the notice was in the ring before the tile mounted", () => {
    const harness = createHarness();
    reject(harness, send(harness), "CHAT_EVICTED_HEAD_MOVED");

    render(<Tile handle={harness.handle} />);

    expect(refuse).not.toHaveBeenCalled();
    expect(toastCount()).toBe(0);
  });

  it("waits for the composer to consume the failed-send slot the rejection claimed", () => {
    const harness = createHarness();
    render(<Tile handle={harness.handle} />);
    const clientActionId = send(harness);

    reject(harness, clientActionId, "CHAT_EVICTED_HEAD_MOVED");
    expect(harness.handle.store.getState().failedSendRestoration).toMatchObject(
      {
        clientActionId,
      },
    );
    expect(refuse).not.toHaveBeenCalled();

    act(() => {
      harness.handle.store.getState().ackFailedSendRestoration(clientActionId);
    });

    expect(refuse.mock.calls).toEqual([["head-moved"]]);
    expect(toastCount()).toBe(0);
  });
});

describe("the host's own notice for an action its ack already answered", () => {
  it("does not refuse the action a second time", () => {
    const harness = createHarness();
    render(<Tile handle={harness.handle} />);
    const clientActionId = send(harness);
    reject(harness, clientActionId, "CHAT_EVICTED_UNREACHABLE");
    act(() => {
      harness.handle.store.getState().ackFailedSendRestoration(clientActionId);
    });

    hostNotice(harness, clientActionId, "CHAT_EVICTED_UNREACHABLE");

    expect(refuse.mock.calls).toEqual([["unreachable"]]);
  });

  it("refuses nothing for a send displaced into SEND_NOT_RECORDED", () => {
    const harness = createHarness();
    render(<Tile handle={harness.handle} />);
    const first = send(harness);
    const second = send(harness);
    reject(harness, first, "SEND_REJECTED");
    reject(harness, second, "CHAT_EVICTED_UNREACHABLE");
    expect(
      harness.handle.store
        .getState()
        .errorNotices.some(
          (notice) =>
            notice.code === "SEND_NOT_RECORDED" &&
            notice.clientActionId === second,
        ),
    ).toBe(true);

    hostNotice(harness, second, "CHAT_EVICTED_UNREACHABLE");

    expect(refuse).not.toHaveBeenCalled();
  });

  it("drops the hand-over when the composer declines the message it waited on", () => {
    const harness = createHarness();
    render(<Tile handle={harness.handle} />);
    const clientActionId = send(harness);
    reject(harness, clientActionId, "CHAT_EVICTED_HEAD_MOVED");

    act(() => {
      harness.handle.store
        .getState()
        .stateFailedSendRestoration(clientActionId);
    });
    hostNotice(harness, clientActionId, "CHAT_EVICTED_HEAD_MOVED");

    expect(refuse).not.toHaveBeenCalled();
  });

  it("leaves the line ended by an edit made after the refusal", () => {
    useComposerDraftStore.setState({ drafts: {} });
    const harness = createHarness();
    function Line(): ReactNode {
      const evicted = useEvictedChatSend({
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        hostId: "host-a",
        served: false,
        held: false,
      });
      useEvictedSendAckRefusals(harness.handle, evicted.refuse);
      return <output>{evicted.line ?? "none"}</output>;
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Line />
      </QueryClientProvider>,
    );
    const clientActionId = send(harness);
    reject(harness, clientActionId, "CHAT_EVICTED_UNREACHABLE");
    act(() => {
      useComposerDraftStore.getState().setSnapshot(CHAT_ID, MESSAGE, null);
      harness.handle.store.getState().ackFailedSendRestoration(clientActionId);
    });
    expect(screen.getByRole("status").textContent).toBe("unreachable");
    act(() => {
      useComposerDraftStore.getState().setSnapshot(
        CHAT_ID,
        {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "new" }] },
          ],
        },
        null,
      );
    });
    expect(screen.getByRole("status").textContent).toBe("none");

    hostNotice(harness, clientActionId, "CHAT_EVICTED_UNREACHABLE");

    expect(screen.getByRole("status").textContent).toBe("none");
  });
});
