/**
 * The withdrawn-opening lifecycle at the `chat-session-store.ts` level. An
 * opening prompt is either sent or back in the composer, and the host's
 * delivery view (`chat.subscribe@1.15`) is the ONE restorer for a message it
 * names, in any phase - every local copy stands aside for it.
 *
 * Covers:
 *  - the synchronous drop: every local copy of a withdrawn opening disappears
 *    in the SAME update that seats the withdrawal, via `onMessageDeliveryChanged`
 *    and via an ordinary `onSnapshot` fold. (The third seating path - the
 *    windowed/deferred seat - has its own dedicated test in
 *    `chat-session-store-message-delivery-deferred-snapshot.test.ts`, which
 *    already owns that harness.)
 *  - recovery suppressed while the view names a message:
 *    `takeSetupFailedRestoration` and a rejected `send`.
 *  - `takeMessageDeliveryRestoration`'s take gates.
 *  - the `messageDeliveryRestored` acknowledgement marker, including its
 *    localStorage-backed persistence across a reload (the coordinator's
 *    "duplicate merge after reload" fix).
 *
 * jsdom does NOT clear localStorage between tests in one file - every test
 * that restores or acknowledges resets it in beforeEach/afterEach.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatMessageDelivery } from "@traycer/protocol/host/agent/gui/message-delivery";
import type {
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { SEND_RESTORED_NOTICE_CODE } from "@/stores/chats/chat-queue-reconciler";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  readPersistedDeliveryRestoreAck,
  writePersistedDeliveryRestoreAck,
} from "@/lib/chats/delivery-restore-ack-persistence";
import { deliveryRestoreAckKey } from "@/lib/persist";

const EPIC_ID = "epic-delivery-lifecycle";
const CHAT_ID = "chat-delivery-lifecycle";
const OWNER_ID = "owner-delivery-lifecycle";
const HOST_ID = "host-delivery-lifecycle";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

const SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-sonnet-4-5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly sent: ChatSubscribeClientFrame[];
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
  const sent: ChatSubscribeClientFrame[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: HOST_ID,
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
        sendAction: (frame) => {
          sent.push(frame);
        },
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => false,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    sent,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

function emitSnapshot(
  callbacks: ChatStreamCallbacks,
  options: {
    readonly messageDelivery?: ChatMessageDelivery | null;
    readonly role?: "owner" | "viewer";
    readonly canAct?: boolean;
  },
): void {
  callbacks.onConnectionStatus("open", null, null);
  const chat: Chat = {
    id: CHAT_ID,
    parentId: null,
    userId: OWNER_ID,
    hostId: HOST_ID,
    title: "Chat",
    createdAt: 1,
    updatedAt: 1,
    isTitleEditedByUser: false,
    settings: null,
    activeSessionChain: null,
    claudePendingWakes: [],
    messages: [],
    events: [],
    archivedAt: null,
    pinnedUserProviderHandle: null,
    lastDeliveredRolesDigest: null,
  };
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat,
      access: {
        role: options.role ?? "owner",
        ownerUserId: OWNER_ID,
        canAct: options.canAct ?? true,
      },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
      messageDelivery: options.messageDelivery ?? null,
    },
  });
}

function emitMessageDeliveryChanged(
  callbacks: ChatStreamCallbacks,
  value: ChatMessageDelivery | null,
): void {
  callbacks.onMessageDeliveryChanged({
    kind: "messageDeliveryChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    delivery: value,
  });
}

function pendingDelivery(
  messageId: string,
  revision: number,
  phase: "pending" | "preparing",
): ChatMessageDelivery {
  return { messageId, revision, state: { phase } };
}

function withdrawnDelivery(
  messageId: string,
  revision: number,
  options: {
    readonly restore: JsonContent | null;
    readonly restoreClaimed: boolean;
  },
): ChatMessageDelivery {
  return {
    messageId,
    revision,
    state: {
      phase: "withdrawn",
      code: "MESSAGE_START_INTERRUPTED",
      reason: "The opening message was not sent. Retry when ready.",
      missingHashes: [],
      restore: options.restore === null ? null : { content: options.restore },
      restoreClaimed: options.restoreClaimed,
    },
  };
}

function rejectSend(
  callbacks: ChatStreamCallbacks,
  clientActionId: string,
): void {
  callbacks.onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId,
    action: "send",
    status: "rejected",
    reason: "Rejected",
    code: null,
    backgroundStopTaskIds: [],
    token: null,
  });
}

function acceptAction(
  callbacks: ChatStreamCallbacks,
  clientActionId: string,
): void {
  callbacks.onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId,
    action: "messageDeliveryRestored",
    status: "accepted",
    reason: null,
    code: null,
    backgroundStopTaskIds: [],
    token: null,
  });
}

function rejectAction(
  callbacks: ChatStreamCallbacks,
  clientActionId: string,
): void {
  callbacks.onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId,
    action: "messageDeliveryRestored",
    status: "rejected",
    reason: "Rejected",
    code: null,
    backgroundStopTaskIds: [],
    token: null,
  });
}

function sendPrompt(harness: Harness): {
  readonly clientActionId: string;
  readonly messageId: string;
} {
  const action = harness.handle.store.getState().sendMessage({
    content: CONTENT,
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    attachments: [],
    deliveryPolicy: "auto",
    restore: { content: CONTENT, browserAnnotations: [] },
  });
  expect(action).not.toBeNull();
  if (action === null) throw new Error("sendMessage was refused");
  return action;
}

let harness: Harness | null = null;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  harness?.handle.dispose();
  harness = null;
  window.localStorage.clear();
});

describe("chat-session-store messageDelivery: synchronous drop", () => {
  it("onMessageDeliveryChanged drops every local copy of the withdrawn message in the SAME update, leaving another message's copies untouched", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {});
    const first = sendPrompt(harness);
    const second = sendPrompt(harness);

    const before = harness.handle.store.getState();
    expect(before.pendingActions[first.clientActionId]).toBeDefined();
    expect(before.pendingActions[second.clientActionId]).toBeDefined();
    expect(
      before.pendingUserMessages.some((m) => m.messageId === first.messageId),
    ).toBe(true);
    expect(
      before.pendingUserMessages.some((m) => m.messageId === second.messageId),
    ).toBe(true);

    emitMessageDeliveryChanged(
      callbacks,
      withdrawnDelivery(first.messageId, 1, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    );

    const after = harness.handle.store.getState();
    expect(after.messageDelivery?.messageId).toBe(first.messageId);
    expect(after.pendingActions[first.clientActionId]).toBeUndefined();
    expect(after.pendingActions[second.clientActionId]).toBeDefined();
    expect(
      after.pendingUserMessages.some((m) => m.messageId === first.messageId),
    ).toBe(false);
    expect(
      after.pendingUserMessages.some((m) => m.messageId === second.messageId),
    ).toBe(true);
  });

  it("an ordinary onSnapshot fold drops every local copy of the withdrawn message it seats, in that same fold", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {});
    const sent = sendPrompt(harness);
    expect(
      harness.handle.store
        .getState()
        .pendingUserMessages.some((m) => m.messageId === sent.messageId),
    ).toBe(true);

    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery(sent.messageId, 1, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    });

    const after = harness.handle.store.getState();
    expect(after.messageDelivery?.messageId).toBe(sent.messageId);
    expect(after.pendingActions).toEqual({});
    expect(
      after.pendingUserMessages.some((m) => m.messageId === sent.messageId),
    ).toBe(false);
  });

  it("keeps every slice's object identity when the changed delivery names no message this store holds", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {});
    sendPrompt(harness);

    const before = harness.handle.store.getState();
    emitMessageDeliveryChanged(
      callbacks,
      pendingDelivery("message-unrelated", 1, "pending"),
    );
    const after = harness.handle.store.getState();

    expect(after.pendingActions).toBe(before.pendingActions);
    expect(after.acceptedActions).toBe(before.acceptedActions);
    expect(after.pendingUserMessages).toBe(before.pendingUserMessages);
    expect(after.queue).toBe(before.queue);
    expect(after.hashOnlyRecoveries).toBe(before.hashOnlyRecoveries);
    expect(after.failedSendRestoration).toBe(before.failedSendRestoration);
  });
});

describe("chat-session-store messageDelivery: recovery suppressed (store level)", () => {
  it("takeSetupFailedRestoration(M) returns null and leaves the record untouched while the delivery view names M - the identical record IS restorable without the gate", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {});

    // Positive control first: with no delivery view, the exact same shape of
    // record restores normally - this is what proves the gated assertions
    // below would fail without the gate.
    const control = sendPrompt(harness);
    expect(
      harness.handle.store
        .getState()
        .takeSetupFailedRestoration(control.messageId),
    ).toEqual(CONTENT);

    const gated = sendPrompt(harness);
    emitMessageDeliveryChanged(
      callbacks,
      pendingDelivery(gated.messageId, 1, "pending"),
    );

    expect(
      harness.handle.store
        .getState()
        .takeSetupFailedRestoration(gated.messageId),
    ).toBeNull();
    // Untouched, not consumed: the pending action's restore slot still holds
    // its content, ready for the view to hand it back itself.
    expect(
      harness.handle.store.getState().pendingActions[gated.clientActionId]
        ?.restore,
    ).not.toBeNull();
  });

  it("a rejected send of M produces no restoration, no notice and no last-copy prompt while the delivery view names M - the identical rejection WOULD produce a restoration without the gate", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {});

    // Positive control: the identical rejected send with no delivery view.
    const control = sendPrompt(harness);
    rejectSend(callbacks, control.clientActionId);
    const controlState = harness.handle.store.getState();
    expect(controlState.failedSendRestoration).not.toBeNull();
    expect(controlState.failedSendRestoration?.clientActionId).toBe(
      control.clientActionId,
    );

    const gated = sendPrompt(harness);
    emitMessageDeliveryChanged(
      callbacks,
      pendingDelivery(gated.messageId, 1, "pending"),
    );
    rejectSend(callbacks, gated.clientActionId);

    const state = harness.handle.store.getState();
    // The control already holds the single failedSendRestoration slot, so the
    // gate is proven by NOTHING changing about it - the rejected send above
    // neither displaces it nor adds a notice/last-copy entry of its own.
    expect(state.failedSendRestoration).toBe(
      controlState.failedSendRestoration,
    );
    expect(state.errorNotices).toEqual(controlState.errorNotices);
    expect(state.lastCopyPrompts).toEqual(controlState.lastCopyPrompts);
  });
});

describe("chat-session-store messageDelivery: take gates", () => {
  it("returns null for a null view, and for an unresolved (pending/preparing) one", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {});
    expect(
      harness.handle.store.getState().takeMessageDeliveryRestoration(),
    ).toBeNull();

    emitMessageDeliveryChanged(
      callbacks,
      pendingDelivery("message-1", 1, "pending"),
    );
    expect(
      harness.handle.store.getState().takeMessageDeliveryRestoration(),
    ).toBeNull();

    emitMessageDeliveryChanged(
      callbacks,
      pendingDelivery("message-1", 2, "preparing"),
    );
    expect(
      harness.handle.store.getState().takeMessageDeliveryRestoration(),
    ).toBeNull();
  });

  it("a viewer's take returns null WITHOUT marking the message handled - it restores once access becomes owner", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      role: "viewer",
      messageDelivery: withdrawnDelivery("message-1", 1, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    });
    expect(
      harness.handle.store.getState().takeMessageDeliveryRestoration(),
    ).toBeNull();

    emitSnapshot(callbacks, {
      role: "owner",
      messageDelivery: withdrawnDelivery("message-1", 1, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    });
    expect(
      harness.handle.store.getState().takeMessageDeliveryRestoration(),
    ).toEqual({
      messageId: "message-1",
      revision: 1,
      content: CONTENT,
    });
  });

  it("restore === null returns null and PERMANENTLY marks the message handled, even once a later revision would otherwise restore", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, {
        restore: null,
        restoreClaimed: false,
      }),
    });
    expect(
      harness.handle.store.getState().takeMessageDeliveryRestoration(),
    ).toBeNull();

    // Same message, a later revision that now DOES carry restore content -
    // still null, because "handled" is permanent for this message id.
    emitMessageDeliveryChanged(
      callbacks,
      withdrawnDelivery("message-1", 2, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    );
    expect(
      harness.handle.store.getState().takeMessageDeliveryRestoration(),
    ).toBeNull();
  });

  it("claimed-and-not-watched returns null WITHOUT marking handled - it restores once the claim clears", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    // This store's very first sighting of "message-1" is already withdrawn
    // and claimed - it never watched a pending/preparing phase for it, so
    // some other window already claimed the prompt.
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, {
        restore: CONTENT,
        restoreClaimed: true,
      }),
    });
    expect(
      harness.handle.store.getState().takeMessageDeliveryRestoration(),
    ).toBeNull();

    // Not marked handled: the SAME message, once no longer claimed (the other
    // window's claim lapsed), still restores here.
    emitMessageDeliveryChanged(
      callbacks,
      withdrawnDelivery("message-1", 1, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    );
    expect(
      harness.handle.store.getState().takeMessageDeliveryRestoration(),
    ).toEqual({
      messageId: "message-1",
      revision: 1,
      content: CONTENT,
    });
  });

  it("claimed-and-watched restores - a claim made after this store watched the message live does not block it", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {});
    // This store DID watch the message live, while it was still pending.
    emitMessageDeliveryChanged(
      callbacks,
      pendingDelivery("message-1", 1, "pending"),
    );
    emitMessageDeliveryChanged(
      callbacks,
      withdrawnDelivery("message-1", 2, {
        restore: CONTENT,
        restoreClaimed: true,
      }),
    );
    expect(
      harness.handle.store.getState().takeMessageDeliveryRestoration(),
    ).toEqual({
      messageId: "message-1",
      revision: 2,
      content: CONTENT,
    });
  });

  it("unclaimed-and-not-watched restores - reopening a chat after a withdrawal must not require having watched it live", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    });
    expect(
      harness.handle.store.getState().takeMessageDeliveryRestoration(),
    ).toEqual({
      messageId: "message-1",
      revision: 1,
      content: CONTENT,
    });
  });

  it("a second take of the same message returns null", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    });
    expect(
      harness.handle.store.getState().takeMessageDeliveryRestoration(),
    ).not.toBeNull();
    expect(
      harness.handle.store.getState().takeMessageDeliveryRestoration(),
    ).toBeNull();
  });

  it("a successful take appends a notice carrying the host's own reason", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    });
    harness.handle.store.getState().takeMessageDeliveryRestoration();

    const notices = harness.handle.store.getState().errorNotices;
    expect(notices).toHaveLength(1);
    expect(notices[0]?.code).toBe(SEND_RESTORED_NOTICE_CODE);
    expect(notices[0]?.message).toBe(
      "The opening message was not sent. Retry when ready.",
    );
  });

  it("take-time read: a marker another window persisted for this message makes the take return null (coordinator addendum)", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    });
    // Simulates another window/tab on this device already restoring this
    // exact message and persisting its own marker, read live at take-time
    // rather than only at store construction.
    writePersistedDeliveryRestoreAck(CHAT_ID, {
      messageId: "message-1",
      expectedRevision: 1,
    });

    expect(
      harness.handle.store.getState().takeMessageDeliveryRestoration(),
    ).toBeNull();
  });
});

describe("chat-session-store messageDelivery: acknowledgement marker", () => {
  it("messageDeliveryRestored writes the persisted key with the right value", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 3, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    });
    const restoration = harness.handle.store
      .getState()
      .takeMessageDeliveryRestoration();
    expect(restoration).not.toBeNull();
    if (restoration === null) throw new Error("expected a restoration");

    harness.handle.store.getState().messageDeliveryRestored({
      messageId: restoration.messageId,
      expectedRevision: restoration.revision,
    });

    expect(
      JSON.parse(
        window.localStorage.getItem(deliveryRestoreAckKey(CHAT_ID)) ?? "null",
      ),
    ).toEqual({ messageId: "message-1", expectedRevision: 3 });
    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toEqual({
      messageId: "message-1",
      expectedRevision: 3,
    });
  });

  it("holds the acknowledgement (no frame) while the view is null, and sends it once an authoritative snapshot corroborates it - with the persisted expectedRevision", () => {
    harness = createHarness();
    // Called before any snapshot: state.messageDelivery is still null, so the
    // frame stays held even though the marker itself is set and persisted.
    // This is also the RELOAD shape (coordinator addendum #2): a marker this
    // device already owes, read back before the first snapshot lands.
    harness.handle.store.getState().messageDeliveryRestored({
      messageId: "message-1",
      expectedRevision: 5,
    });
    expect(harness.sent).toHaveLength(0);
    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toEqual({
      messageId: "message-1",
      expectedRevision: 5,
    });

    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 5, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    });

    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    if (frame.kind !== "messageDeliveryRestored") {
      throw new Error(
        `expected a messageDeliveryRestored frame, got ${frame.kind}`,
      );
    }
    expect(frame.messageId).toBe("message-1");
    expect(frame.expectedRevision).toBe(5);
  });

  it("an ACCEPTED ack of the acknowledgement clears the marker and the persisted key", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    });
    const restoration = harness.handle.store
      .getState()
      .takeMessageDeliveryRestoration();
    if (restoration === null) throw new Error("expected a restoration");
    harness.handle.store.getState().messageDeliveryRestored({
      messageId: restoration.messageId,
      expectedRevision: restoration.revision,
    });
    const clientActionId = harness.sent.at(-1);
    if (clientActionId?.kind !== "messageDeliveryRestored") {
      throw new Error("expected the acknowledgement frame to have gone out");
    }

    acceptAction(callbacks, clientActionId.clientActionId);

    expect(
      harness.handle.store.getState().unacknowledgedDeliveryRestore,
    ).toBeNull();
    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toBeNull();
  });

  it("a REJECTED ack of the acknowledgement ALSO clears the marker and the persisted key - the host never refuses one", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    });
    const restoration = harness.handle.store
      .getState()
      .takeMessageDeliveryRestoration();
    if (restoration === null) throw new Error("expected a restoration");
    harness.handle.store.getState().messageDeliveryRestored({
      messageId: restoration.messageId,
      expectedRevision: restoration.revision,
    });
    const clientActionId = harness.sent.at(-1);
    if (clientActionId?.kind !== "messageDeliveryRestored") {
      throw new Error("expected the acknowledgement frame to have gone out");
    }

    rejectAction(callbacks, clientActionId.clientActionId);

    expect(
      harness.handle.store.getState().unacknowledgedDeliveryRestore,
    ).toBeNull();
    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toBeNull();
  });

  it("a view that has moved on to another message clears the marker WITHOUT sending", () => {
    harness = createHarness();
    // No prior snapshot: messageDeliveryRestored holds (does not send) here,
    // isolating the flush this test is actually about to the snapshot below.
    harness.handle.store.getState().messageDeliveryRestored({
      messageId: "message-1",
      expectedRevision: 1,
    });

    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: pendingDelivery("message-2", 1, "pending"),
    });

    expect(harness.sent).toHaveLength(0);
    expect(
      harness.handle.store.getState().unacknowledgedDeliveryRestore,
    ).toBeNull();
    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toBeNull();
  });

  it("a view the host has already claimed clears the marker WITHOUT sending", () => {
    harness = createHarness();
    harness.handle.store.getState().messageDeliveryRestored({
      messageId: "message-1",
      expectedRevision: 1,
    });

    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, {
        restore: CONTENT,
        restoreClaimed: true,
      }),
    });

    expect(harness.sent).toHaveLength(0);
    expect(
      harness.handle.store.getState().unacknowledgedDeliveryRestore,
    ).toBeNull();
    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toBeNull();
  });

  it("resends with a NEW clientActionId once the earlier one is no longer pending, as a reconnect sweep would leave it", () => {
    harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    });
    const restoration = harness.handle.store
      .getState()
      .takeMessageDeliveryRestoration();
    if (restoration === null) throw new Error("expected a restoration");
    harness.handle.store.getState().messageDeliveryRestored({
      messageId: restoration.messageId,
      expectedRevision: restoration.revision,
    });
    expect(harness.sent).toHaveLength(1);
    const firstFrame = harness.sent[0];
    if (firstFrame.kind !== "messageDeliveryRestored") {
      throw new Error("expected the first acknowledgement frame");
    }

    // A reconnect swept the in-flight action without ever acking it - the
    // marker still names the same message/revision, but its clientActionId no
    // longer exists in pendingActions.
    harness.handle.store.setState((state) => ({
      pendingActions: Object.fromEntries(
        Object.entries(state.pendingActions).filter(
          ([id]) => id !== firstFrame.clientActionId,
        ),
      ),
    }));

    // The next authoritative snapshot (the reconnect) re-corroborates the
    // still-unclaimed withdrawal and flushes again.
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, {
        restore: CONTENT,
        restoreClaimed: false,
      }),
    });

    expect(harness.sent).toHaveLength(2);
    const secondFrame = harness.sent[1];
    if (secondFrame.kind !== "messageDeliveryRestored") {
      throw new Error("expected a second acknowledgement frame");
    }
    expect(secondFrame.clientActionId).not.toBe(firstFrame.clientActionId);
    expect(secondFrame.messageId).toBe("message-1");
    expect(secondFrame.expectedRevision).toBe(1);
  });
});
