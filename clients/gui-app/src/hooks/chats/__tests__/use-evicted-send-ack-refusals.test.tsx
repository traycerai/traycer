import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatErrorNotice } from "@traycer/protocol/host/agent/gui/subscribe";

const sonnerToastError = vi.hoisted(() =>
  vi.fn<(message: ReactNode) => void>(),
);
const sonnerToastWarning = vi.hoisted(() =>
  vi.fn<(message: ReactNode) => void>(),
);
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    warning: sonnerToastWarning,
    error: sonnerToastError,
    success: vi.fn(),
    dismiss: vi.fn(),
  }),
  __esModule: true,
}));

import { ChatTileErrorNoticeToasts } from "@/components/epic-canvas/renderers/chat-tile-error-notice-toasts";
import { useEvictedSendAckRefusals } from "@/hooks/chats/use-evicted-send-ack-refusals";
import { EVICTED_SEND_FAILED_MESSAGE } from "@/lib/chats/evicted-chat-refusal";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";

const EPIC_ID = "epic-x";
const CHAT_ID = "chat-x";
const OWNER_ID = "owner-x";
const HOST_REASON = "The host refused the message.";
const HOST_NOTICE_MESSAGE = "The cloud copy could not be reached.";

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

function pauseQueue(harness: Harness): string {
  const clientActionId = harness.handle.store.getState().pauseQueue();
  if (clientActionId === null) throw new Error("pause refused");
  return clientActionId;
}

function reject(
  harness: Harness,
  clientActionId: string,
  action: "send" | "pauseQueue",
  code: string,
): void {
  act(() => {
    harness.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId,
      action,
      status: "rejected",
      reason: HOST_REASON,
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
        message: HOST_NOTICE_MESSAGE,
        severity: "error",
        clientActionId,
      },
    });
  });
}

function noticeCoded(
  harness: Harness,
  code: string,
  clientActionId: string,
): ChatErrorNotice | undefined {
  return harness.handle.store
    .getState()
    .errorNotices.find(
      (notice) =>
        notice.code === code && notice.clientActionId === clientActionId,
    );
}

function messageText(message: ReactNode): string {
  if (typeof message === "string") return message;
  if (isValidElement<{ readonly children: string }>(message)) {
    return message.props.children;
  }
  throw new Error("an unexpected toast message");
}

/** What was toasted, in order, whatever the severity. */
function toasted(): string[] {
  return [...sonnerToastError.mock.calls, ...sonnerToastWarning.mock.calls].map(
    ([message]) => messageText(message),
  );
}

const refuse = vi.fn<() => void>();

function Refusals(props: { readonly handle: ChatSessionStoreHandle }): null {
  useEvictedSendAckRefusals(props.handle, refuse);
  return null;
}

beforeEach(() => {
  refuse.mockReset();
  sonnerToastError.mockReset();
  sonnerToastWarning.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("useEvictedSendAckRefusals", () => {
  it.each(["CHAT_EVICTED_UNREACHABLE", "CHAT_EVICTED_HEAD_MOVED"])(
    "refuses once for a %s notice that arrives while mounted",
    (code) => {
      const harness = createHarness();
      render(<Refusals handle={harness.handle} />);

      hostNotice(harness, null, code);

      expect(refuse.mock.calls).toEqual([[]]);
    },
  );

  it("refuses nothing for any other code", () => {
    const harness = createHarness();
    render(<Refusals handle={harness.handle} />);

    hostNotice(harness, null, "SEND_REJECTED");

    expect(refuse).not.toHaveBeenCalled();
  });

  it("refuses nothing for a notice that was in the ring before it mounted", () => {
    const harness = createHarness();
    hostNotice(harness, null, "CHAT_EVICTED_HEAD_MOVED");

    render(<Refusals handle={harness.handle} />);

    expect(refuse).not.toHaveBeenCalled();
  });

  it("sees a notice appended by an update that a listener nested inside it", () => {
    const harness = createHarness();
    const { store } = harness.handle;
    let nested = false;
    // Registered first, so zustand runs it before the hook's listener, and its
    // own `set` calls the hook's listener with the nested state ahead of the
    // outer update's result.
    store.subscribe((state) => {
      if (nested) return;
      nested = true;
      store.setState({
        errorNotices: [
          ...state.errorNotices,
          {
            code: "SOMETHING_ELSE",
            message: "A second notice.",
            severity: "warning",
            clientActionId: null,
          },
        ],
      });
    });
    render(<Refusals handle={harness.handle} />);

    hostNotice(harness, null, "CHAT_EVICTED_UNREACHABLE");

    expect(refuse.mock.calls).toEqual([[]]);
  });

  it("refuses once for a send rejected with the code, and not again for the host's follow-up", () => {
    const harness = createHarness();
    render(<Refusals handle={harness.handle} />);
    const clientActionId = send(harness);

    reject(harness, clientActionId, "send", "CHAT_EVICTED_UNREACHABLE");
    hostNotice(harness, clientActionId, "CHAT_EVICTED_UNREACHABLE");

    expect(refuse.mock.calls).toEqual([[]]);
  });

  it("refuses once when an evicted send is displaced into SEND_NOT_RECORDED", () => {
    const harness = createHarness();
    render(<Refusals handle={harness.handle} />);
    const first = send(harness);
    const second = send(harness);
    reject(harness, first, "send", "SEND_REJECTED");
    reject(harness, second, "send", "CHAT_EVICTED_UNREACHABLE");

    hostNotice(harness, second, "CHAT_EVICTED_UNREACHABLE");

    expect(refuse.mock.calls).toEqual([[]]);
  });
});

describe("a send rejected with a CHAT_EVICTED code", () => {
  it.each(["CHAT_EVICTED_UNREACHABLE", "CHAT_EVICTED_HEAD_MOVED"])(
    "toasts once, for %s, in the words of any failed send and not the host's",
    (code) => {
      const harness = createHarness();
      render(<ChatTileErrorNoticeToasts handle={harness.handle} />);
      const clientActionId = send(harness);

      reject(harness, clientActionId, "send", code);
      hostNotice(harness, clientActionId, code);

      expect(toasted()).toEqual([EVICTED_SEND_FAILED_MESSAGE]);
      expect(
        harness.handle.store.getState().failedSendRestoration?.reason,
      ).toBe(EVICTED_SEND_FAILED_MESSAGE);
    },
  );

  it("says the same sentence when the pane was unfocused and the composer takes the prompt back", () => {
    const harness = createHarness();
    const clientActionId = send(harness);
    reject(harness, clientActionId, "send", "CHAT_EVICTED_UNREACHABLE");

    act(() => {
      harness.handle.store.getState().ackFailedSendRestoration(clientActionId);
    });

    expect(noticeCoded(harness, "SEND_RESTORED", clientActionId)?.message).toBe(
      EVICTED_SEND_FAILED_MESSAGE,
    );
  });

  it("quotes the prompt of a send displaced from the slot, with no toast in the host's words", () => {
    const harness = createHarness();
    render(<ChatTileErrorNoticeToasts handle={harness.handle} />);
    const first = send(harness);
    const second = send(harness);
    reject(harness, first, "send", "SEND_REJECTED");
    sonnerToastError.mockReset();
    sonnerToastWarning.mockReset();

    reject(harness, second, "send", "CHAT_EVICTED_UNREACHABLE");
    hostNotice(harness, second, "CHAT_EVICTED_UNREACHABLE");

    const displaced = noticeCoded(harness, "SEND_NOT_RECORDED", second);
    expect(displaced?.message).toContain(
      EVICTED_SEND_FAILED_MESSAGE.replace(/\.$/, ""),
    );
    expect(displaced?.message).toContain("fix the bug");
    const said = toasted();
    expect(said).toHaveLength(1);
    expect(said[0]).toBe(displaced?.message);
    expect(said.join()).not.toContain(HOST_REASON);
    expect(said.join()).not.toContain(HOST_NOTICE_MESSAGE);
  });

  it("keeps the host's own words for the same code on an action that is not a send", () => {
    const harness = createHarness();
    render(<ChatTileErrorNoticeToasts handle={harness.handle} />);
    const clientActionId = pauseQueue(harness);

    reject(harness, clientActionId, "pauseQueue", "CHAT_EVICTED_UNREACHABLE");
    hostNotice(harness, clientActionId, "CHAT_EVICTED_UNREACHABLE");

    expect(toasted()).toEqual([HOST_REASON]);

    hostNotice(harness, null, "CHAT_EVICTED_UNREACHABLE");

    expect(toasted().sort()).toEqual([HOST_NOTICE_MESSAGE, HOST_REASON]);
  });

  it("still toasts a send rejected for any other code", () => {
    const harness = createHarness();
    render(<ChatTileErrorNoticeToasts handle={harness.handle} />);
    const clientActionId = send(harness);

    reject(harness, clientActionId, "send", "SEND_REJECTED");

    expect(toasted().join()).toContain(HOST_REASON);
  });
});
