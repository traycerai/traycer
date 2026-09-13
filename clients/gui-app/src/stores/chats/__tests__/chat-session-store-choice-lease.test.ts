import { describe, expect, it } from "vitest";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import type { PendingFallback } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
  type ChatStreamClientHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  pendingFallback,
} from "@/components/chat/fallback/__tests__/fallback-fixtures";

// `chat-session-store.ts`'s own `ChatOwnerActionFrame` is a PRIVATE alias, and
// the protocol has never exported that name, so importing it could never have
// worked. Derived here from the SEAM this test actually drives - the
// `sendAction` it hands the store - rather than re-stating the store's
// `Exclude<ChatSubscribeClientFrame, { kind: "ping" }>`.
//
// Restating it was the first attempt and it failed to compile: the store's
// alias narrows what the store CONSTRUCTS, while `sendAction` accepts the
// wider `ChatStreamClient` union, so a `sent: ChatOwnerActionFrame[]` could
// not take the callback's argument. Two types that look identical in source
// answer different questions. Deriving from the seam cannot drift from it, and
// it mirrors the store's own `ChatActionAckFrame` on the callback side.
type ChatOwnerActionFrame = Parameters<ChatStreamClientHandle["sendAction"]>[0];

const EPIC_ID = "epic-choice-lease";
const CHAT_ID = "chat-choice-lease";
const OWNER_ID = "owner-choice-lease";
const TRAVERSAL_ID = "traversal-choice-lease";

function fallbackDto(input: {
  readonly state: PendingFallback["state"];
  readonly revision: number;
}): PendingFallback {
  return pendingFallback({
    state: input.state,
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: TARGET_CODEX_TUPLE,
    impendingAction: null,
    deadline: input.state === "hold" ? 1_700_000_012_000 : null,
    attempt: 1,
    maxAttempts: 3,
    queuedItemsMoving: 2,
    siblingSwitching: 1,
    traversalId: TRAVERSAL_ID,
    revision: input.revision,
  });
}

// The DTO the host reports while the countdown is running and no menu has
// asked for a hold yet.
const HOLD = fallbackDto({ state: "hold", revision: 4 });
// The DTO the host reports once a `fallback.holdForChoice` has been accepted
// and the freeze is in effect - the state `fallbackHoldForChoice` must also
// admit on reopen (see case 4).
const CHOOSING = fallbackDto({ state: "choosing", revision: 5 });
// A traversal that has moved on to resuming the fallback tuple - neither
// `hold` nor `choosing`, so a lease naming it is dead.
const SWITCHING = fallbackDto({ state: "switching", revision: 6 });

/**
 * Every frame the store handed to the transport, in send order. The whole
 * point of this suite is asserting which frames were sent and with which
 * token, so (unlike the sibling `chat-session-store-pending-fallback.test.ts`
 * harness, whose `sendAction` is a no-op) this one records every frame.
 */
interface LeaseHarness {
  readonly handle: ChatSessionStoreHandle;
  readonly sent: ChatOwnerActionFrame[];
  callbacks(): ChatStreamCallbacks;
}

function createLeaseHarness(): LeaseHarness {
  let callbacks: ChatStreamCallbacks | null = null;
  const sent: ChatOwnerActionFrame[] = [];
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
        sendAction: (frame) => {
          sent.push(frame);
        },
        sameTurnSteeringProtocolSupported: () => true,
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

function emptyChat(): Chat {
  return {
    id: CHAT_ID,
    parentId: null,
    userId: OWNER_ID,
    hostId: "test-host",
    title: "Host Chat",
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
}

function emitSnapshot(
  callbacks: ChatStreamCallbacks,
  pending: PendingFallback | undefined,
): void {
  callbacks.onConnectionStatus("open", null, null);
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: emptyChat(),
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
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
      pendingFallback: pending,
      pendingReturn: undefined,
    },
  });
}

function emitTurnState(
  callbacks: ChatStreamCallbacks,
  pending: PendingFallback | undefined,
): void {
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: "idle",
    activeTurn: null,
    pendingFallback: pending,
    pendingReturn: undefined,
  });
}

interface AckInput {
  readonly clientActionId: string;
  readonly status: "accepted" | "rejected";
  readonly token: string | null;
}

function emitActionAck(callbacks: ChatStreamCallbacks, input: AckInput): void {
  callbacks.onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId: input.clientActionId,
    action: "fallback.holdForChoice",
    status: input.status,
    reason: input.status === "rejected" ? "traversal_advanced" : null,
    code: input.status === "rejected" ? "traversal_advanced" : null,
    backgroundStopTaskIds: [],
    token: input.token,
  });
}

function holdFrames(sent: ChatOwnerActionFrame[]): ChatOwnerActionFrame[] {
  return sent.filter((frame) => frame.kind === "fallback.holdForChoice");
}

function releaseFrames(sent: ChatOwnerActionFrame[]): ChatOwnerActionFrame[] {
  return sent.filter((frame) => frame.kind === "fallback.releaseChoice");
}

/*
 * Callers of the two helpers above narrow by `kind` before reading a
 * frame-specific field, because `Array.prototype.filter` with a plain
 * predicate does NOT narrow the element type - the returned array is still
 * the whole `ChatOwnerActionFrame` union.
 *
 * They do NOT also test the element for `undefined`. Indexing is not checked
 * in this project's config, so `frames[0]` is typed as the element rather
 * than `element | undefined`, and `=== undefined` is a comparison between
 * types with no overlap - `no-unnecessary-condition` rejects it. The
 * `expect(...).toHaveLength(1)` that precedes every one of these is what
 * establishes the element exists; the type system is already assuming it.
 */

describe("chat-session-store fallbackChoiceLease", () => {
  it("releases the eventual token when the menu closes before the hold ack", () => {
    const harness = createLeaseHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, HOLD);

      const clientActionId = harness.handle.store
        .getState()
        .fallbackHoldForChoice(TRAVERSAL_ID);
      expect(clientActionId).not.toBeNull();
      if (clientActionId === null) throw new Error("unreachable");

      harness.handle.store.getState().fallbackReleaseChoice();
      // Negative half: closing while the ack is still outstanding must not
      // itself send a release - there is no token yet to hand back.
      // Falsification: revert `fallbackReleaseChoice`'s `pending` branch to
      // the old unconditional `set(() => ({ fallbackChoiceLease: null }))`
      // and this assertion goes red (a release frame appears here).
      expect(releaseFrames(harness.sent)).toHaveLength(0);
      expect(
        harness.handle.store.getState().fallbackChoiceLease,
      ).not.toBeNull();

      emitActionAck(callbacks, {
        clientActionId,
        status: "accepted",
        token: "tok-1",
      });

      // Falsification: same revert as above - the ack now finds no lease to
      // mint into (the slot was cleared on close), so no release frame is
      // ever sent and this goes red.
      expect(releaseFrames(harness.sent)).toHaveLength(1);
      const release = releaseFrames(harness.sent)[0];
      if (release.kind !== "fallback.releaseChoice") {
        throw new Error("expected a release frame");
      }
      expect(release.token).toBe("tok-1");
      expect(release.traversalId).toBe(TRAVERSAL_ID);
      expect(harness.handle.store.getState().fallbackChoiceLease).toBeNull();
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps a pending lease across a same-connection snapshot and releases it on the later ack", () => {
    const harness = createLeaseHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, HOLD);

      const clientActionId = harness.handle.store
        .getState()
        .fallbackHoldForChoice(TRAVERSAL_ID);
      if (clientActionId === null) throw new Error("expected a clientActionId");

      // A resnapshot on the SAME connection, naming the SAME traversal in
      // `choosing` - the host answering a resnapshot request, not a detach.
      emitSnapshot(callbacks, CHOOSING);
      // Falsification: drop `reconcileFallbackChoiceLeaseWithFrame` from the
      // snapshot write and restore the old unconditional
      // `fallbackChoiceLease: null` - this must go red (lease wiped by the
      // snapshot, before the close even happens).
      expect(
        harness.handle.store.getState().fallbackChoiceLease,
      ).not.toBeNull();

      harness.handle.store.getState().fallbackReleaseChoice();
      expect(releaseFrames(harness.sent)).toHaveLength(0);

      emitActionAck(callbacks, {
        clientActionId,
        status: "accepted",
        token: "tok-2",
      });

      expect(releaseFrames(harness.sent)).toHaveLength(1);
      const release = releaseFrames(harness.sent)[0];
      if (release.kind !== "fallback.releaseChoice") {
        throw new Error("expected a release frame");
      }
      expect(release.token).toBe("tok-2");
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps a held lease across a same-connection snapshot and releases its token on close", () => {
    const harness = createLeaseHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, HOLD);

      const clientActionId = harness.handle.store
        .getState()
        .fallbackHoldForChoice(TRAVERSAL_ID);
      if (clientActionId === null) throw new Error("expected a clientActionId");

      emitActionAck(callbacks, {
        clientActionId,
        status: "accepted",
        token: "tok-3",
      });
      expect(harness.handle.store.getState().fallbackChoiceLease?.status).toBe(
        "held",
      );

      emitSnapshot(callbacks, CHOOSING);
      // Falsification: revert the snapshot write to the unconditional
      // `fallbackChoiceLease: null` - the `held` lease (and its token) is
      // wiped here and the assertion below fails to find it.
      expect(harness.handle.store.getState().fallbackChoiceLease?.token).toBe(
        "tok-3",
      );

      harness.handle.store.getState().fallbackReleaseChoice();

      expect(releaseFrames(harness.sent)).toHaveLength(1);
      const release = releaseFrames(harness.sent)[0];
      if (release.kind !== "fallback.releaseChoice") {
        throw new Error("expected a release frame");
      }
      expect(release.token).toBe("tok-3");
      expect(harness.handle.store.getState().fallbackChoiceLease).toBeNull();
    } finally {
      harness.handle.dispose();
    }
  });

  it("reopening during a pending release reuses the in-flight hold instead of minting a second one", () => {
    const harness = createLeaseHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, HOLD);

      const firstClientActionId = harness.handle.store
        .getState()
        .fallbackHoldForChoice(TRAVERSAL_ID);
      if (firstClientActionId === null) {
        throw new Error("expected a clientActionId");
      }

      // Close before the ack lands.
      harness.handle.store.getState().fallbackReleaseChoice();
      expect(
        harness.handle.store.getState().fallbackChoiceLease?.releaseRequested,
      ).toBe(true);

      // The DTO moves to `choosing` - the host already took the freeze.
      emitSnapshot(callbacks, CHOOSING);

      const reopenClientActionId = harness.handle.store
        .getState()
        .fallbackHoldForChoice(TRAVERSAL_ID);

      // MF01: reopening must reuse the in-flight request, not stall on
      // "Pausing the countdown..." forever because `pending.state !== "hold"`
      // refused it (the DTO is `choosing` now) or because a second frame
      // orphaned the first token.
      // Falsification: revert the `pending.state !== "hold" &&
      // pending.state !== "choosing"` guard in `fallbackHoldForChoice` to the
      // old `pending.state !== "hold"` and this assertion goes red (`null`
      // returned instead of the in-flight id).
      expect(reopenClientActionId).toBe(firstClientActionId);
      // Exactly one hold frame was ever sent - the reopen must not mint a
      // second lease.
      expect(holdFrames(harness.sent)).toHaveLength(1);
      expect(
        harness.handle.store.getState().fallbackChoiceLease?.releaseRequested,
      ).toBe(false);

      emitActionAck(callbacks, {
        clientActionId: firstClientActionId,
        status: "accepted",
        token: "tok-4",
      });

      // The menu wants the hold again - the ack must NOT trigger a release
      // now that the reopen withdrew the obligation.
      expect(releaseFrames(harness.sent)).toHaveLength(0);
      expect(harness.handle.store.getState().fallbackChoiceLease?.status).toBe(
        "held",
      );
      expect(harness.handle.store.getState().fallbackChoiceLease?.token).toBe(
        "tok-4",
      );
    } finally {
      harness.handle.dispose();
    }
  });

  it("drops the lease when the connection epoch moves and sends no release", () => {
    const harness = createLeaseHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, HOLD);

      const clientActionId = harness.handle.store
        .getState()
        .fallbackHoldForChoice(TRAVERSAL_ID);
      if (clientActionId === null) throw new Error("expected a clientActionId");

      emitActionAck(callbacks, {
        clientActionId,
        status: "accepted",
        token: "tok-5",
      });
      expect(harness.handle.store.getState().fallbackChoiceLease?.status).toBe(
        "held",
      );

      // A REAL detach: the connection drops.
      callbacks.onConnectionStatus("reconnecting", null, null);
      emitSnapshot(callbacks, CHOOSING);

      // Positive control: this is the one authoritative-frame case that MUST
      // clear the lease, so a reconciler that always returns `lease` (never
      // actually checking the epoch) cannot pass every case in this file
      // vacuously.
      // Falsification: drop the `lease.connectionEpoch !== connectionEpoch`
      // check from `reconcileFallbackChoiceLeaseWithFrame` (always fall
      // through to the traversal/state checks) - the lease survives here and
      // this goes red.
      expect(harness.handle.store.getState().fallbackChoiceLease).toBeNull();

      harness.handle.store.getState().fallbackReleaseChoice();
      expect(releaseFrames(harness.sent)).toHaveLength(0);
    } finally {
      harness.handle.dispose();
    }
  });

  it("clears the lease when the traversal settles through turnStateChanged", () => {
    const harness = createLeaseHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, HOLD);

      const clientActionId = harness.handle.store
        .getState()
        .fallbackHoldForChoice(TRAVERSAL_ID);
      if (clientActionId === null) throw new Error("expected a clientActionId");
      emitActionAck(callbacks, {
        clientActionId,
        status: "accepted",
        token: "tok-6",
      });

      emitTurnState(callbacks, undefined);

      // Falsification: revert the `onTurnStateChanged` write to skip
      // `reconcileFallbackChoiceLeaseWithFrame` (the pre-fix handler did not
      // touch the slot at all here) and this assertion goes red - the dead
      // lease keeps standing.
      expect(harness.handle.store.getState().fallbackChoiceLease).toBeNull();
    } finally {
      harness.handle.dispose();
    }
  });

  it("clears the lease when turnStateChanged reports the traversal has moved past the window", () => {
    const harness = createLeaseHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, HOLD);

      const clientActionId = harness.handle.store
        .getState()
        .fallbackHoldForChoice(TRAVERSAL_ID);
      if (clientActionId === null) throw new Error("expected a clientActionId");
      emitActionAck(callbacks, {
        clientActionId,
        status: "accepted",
        token: "tok-7",
      });

      emitTurnState(callbacks, SWITCHING);

      // Falsification: same as above, and also covers dropping the
      // `pendingFallback.state !== "hold" && ... !== "choosing"` arm of
      // `reconcileFallbackChoiceLeaseWithFrame` - `switching` is neither, so
      // this must clear.
      expect(harness.handle.store.getState().fallbackChoiceLease).toBeNull();
    } finally {
      harness.handle.dispose();
    }
  });

  it("sends no release frame for a refused hold", () => {
    const harness = createLeaseHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, HOLD);

      const clientActionId = harness.handle.store
        .getState()
        .fallbackHoldForChoice(TRAVERSAL_ID);
      if (clientActionId === null) throw new Error("expected a clientActionId");

      emitActionAck(callbacks, {
        clientActionId,
        status: "rejected",
        token: null,
      });
      expect(harness.handle.store.getState().fallbackChoiceLease?.status).toBe(
        "refused",
      );

      harness.handle.store.getState().fallbackReleaseChoice();

      // Falsification: change `fallbackReleaseChoice`'s `refused` branch to
      // call `sendFallbackChoiceRelease` unconditionally (drop the
      // `lease.status !== "held" || lease.token === null` guard) and a
      // release frame with a `null`-turned token appears here.
      expect(releaseFrames(harness.sent)).toHaveLength(0);
      expect(harness.handle.store.getState().fallbackChoiceLease).toBeNull();
    } finally {
      harness.handle.dispose();
    }
  });

  it("sends no release frame when the menu closes before a rejected ack arrives", () => {
    const harness = createLeaseHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, HOLD);

      const clientActionId = harness.handle.store
        .getState()
        .fallbackHoldForChoice(TRAVERSAL_ID);
      if (clientActionId === null) throw new Error("expected a clientActionId");

      harness.handle.store.getState().fallbackReleaseChoice();
      expect(
        harness.handle.store.getState().fallbackChoiceLease?.releaseRequested,
      ).toBe(true);

      emitActionAck(callbacks, {
        clientActionId,
        status: "rejected",
        token: null,
      });

      // Falsification: in `reconcileFallbackChoiceAck`, change the
      // `lease.releaseRequested ? null : { ...lease, ... "refused" }` branch
      // to always return the `refused` lease (ignore `releaseRequested`) -
      // the slot survives here instead of clearing, and this assertion goes
      // red.
      expect(harness.handle.store.getState().fallbackChoiceLease).toBeNull();
      expect(releaseFrames(harness.sent)).toHaveLength(0);
    } finally {
      harness.handle.dispose();
    }
  });
});
