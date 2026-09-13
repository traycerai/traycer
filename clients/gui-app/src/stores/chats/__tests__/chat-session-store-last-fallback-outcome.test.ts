import { describe, expect, it } from "vitest";
import type { Chat, Message } from "@traycer/protocol/persistence/epic/schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { LastFallbackOutcome } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ChatLoadRangeRequest,
  ChatTranscriptDerived,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { isTailHydrated } from "@/stores/chats/transcript-window";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * D215 (`lastFallbackOutcome`) pins.
 *
 * Deliberately its OWN file rather than an extension of
 * `chat-session-store-pending-fallback.test.ts`: that file's helpers
 * (`emitLegacySnapshot`, `emitTurnState`, `deferredWindowedSnapshot`) do not
 * thread this field, and it carries a fixture shape (`blockId`,
 * `assistantMessageId`, `kind`, `details`, `sequence`) none of the other three
 * DTOs have - widening those helpers would cost every one of their existing
 * call sites a new required argument for a field they do not exercise.
 *
 * Field NAMES are deliberately not pinned anywhere below: the store assigns
 * this DTO wholesale and reads no field off it (H-A renamed `revision` to
 * `sequence` on the wire and the store needed zero change), so a test that
 * destructured it would redden for a rename that broke nothing here.
 */

const EPIC_ID = "epic-outcome";
const CHAT_ID = "chat-outcome";
const OWNER_ID = "owner-outcome";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

function outcome(input: {
  readonly blockId: string;
  readonly kind: LastFallbackOutcome["kind"];
  readonly sequence: number;
}): LastFallbackOutcome {
  return {
    blockId: input.blockId,
    assistantMessageId: `assistant-${input.blockId}`,
    kind: input.kind,
    title: `Outcome ${input.blockId}`,
    message: null,
    details: [],
    sequence: input.sequence,
  };
}

const OUTCOME_A = outcome({ blockId: "block-a", kind: "applied", sequence: 1 });
const OUTCOME_B = outcome({ blockId: "block-b", kind: "settled", sequence: 2 });

function userMessage(messageId: string, timestamp: number): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

interface LegacyHarness {
  readonly handle: ChatSessionStoreHandle;
  callbacks(): ChatStreamCallbacks;
}

function createLegacyHarness(): LegacyHarness {
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
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

interface WindowedHarness {
  readonly handle: ChatSessionStoreHandle;
  readonly rangeRequests: ChatLoadRangeRequest[];
  callbacks(): ChatStreamCallbacks;
  lastRangeRequestId(): string;
}

function createWindowedHarness(): WindowedHarness {
  const rangeRequests: ChatLoadRangeRequest[] = [];
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
        requestTranscriptRange: (request) => {
          rangeRequests.push(request);
        },
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    rangeRequests,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
    lastRangeRequestId: () => {
      const last = rangeRequests.at(-1);
      if (last === undefined) throw new Error("Expected an outstanding range");
      return last.requestId;
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

function emitLegacySnapshot(
  callbacks: ChatStreamCallbacks,
  lastFallbackOutcome: LastFallbackOutcome | undefined,
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
      pendingFallback: undefined,
      pendingReturn: undefined,
      lastFallbackOutcome,
    },
  });
}

function emitTurnState(
  callbacks: ChatStreamCallbacks,
  lastFallbackOutcome: LastFallbackOutcome | undefined,
): void {
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: "idle",
    activeTurn: null,
    pendingFallback: undefined,
    pendingReturn: undefined,
    lastFallbackOutcome,
  });
}

const WINDOWED_DERIVED: ChatTranscriptDerived = {
  latestAssistantUsage: null,
  pinnedTodo: null,
  pinnedTaskTodoItems: [],
  latestForkableAssistantMessageId: "assistant-9",
  restorableSetupInterruption: null,
  interviewAnswerability: [],
  latestAssistantAuthFailureTurnKey: null,
  setupCardWindows: [],
};

function deferredWindowedSnapshot(
  lastFallbackOutcome: LastFallbackOutcome | undefined,
): Parameters<ChatStreamCallbacks["onWindowedSnapshot"]>[0] {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: OWNER_ID,
        hostId: "host-a",
        title: "Chat",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        settings: null,
        archivedAt: null,
        lastDeliveredRolesDigest: null,
        activeSessionChain: null,
        claudePendingWakes: [],
        pinnedUserProviderHandle: null,
      },
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      managedCommands: [],
      heldUpdates: [],
      // Unhydrated tail - `isTailHydrated` reads this false - so every case
      // below drives the DEFERRAL branch, not the ordinary fold.
      transcriptEpoch: 4,
      rowCount: 2,
      indexRevision: null,
      tail: { fromOrdinal: 2, messages: [], events: [] },
      derived: WINDOWED_DERIVED,
      pendingFallback: undefined,
      pendingReturn: undefined,
      lastFallbackOutcome,
    },
  };
}

function completeTail(harness: WindowedHarness): void {
  harness.callbacks().onRange({
    kind: "range",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    range: {
      requestId: harness.lastRangeRequestId(),
      epoch: 4,
      fromOrdinal: 0,
      rowIds: ["row-0", "row-1"],
      messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
      events: [],
      rowContext: {},
      reachedStart: true,
      reachedEnd: true,
    },
  });
}

describe("chat-session-store lastFallbackOutcome D215", () => {
  it("sets an outcome through a legacy snapshot, and clears it back to undefined through one", () => {
    const harness = createLegacyHarness();
    try {
      const callbacks = harness.callbacks();
      emitLegacySnapshot(callbacks, OUTCOME_A);
      expect(harness.handle.store.getState().lastFallbackOutcome).toBe(
        OUTCOME_A,
      );

      emitLegacySnapshot(callbacks, undefined);
      // Falsification: add "?? current.lastFallbackOutcome" to the
      // applyAuthoritativeSnapshot write and THIS assertion must go red.
      //
      // `undefined` is the frame ASSERTING that there is no last outcome, not
      // the frame declining to mention one. Absence is not an outcome - a
      // settle and a cancellation are outcomes, each with its own `kind` and
      // its own block, exactly like OUTCOME_A above - so this case is the
      // NEW-INCIDENT clear: the host has started a fresh traversal and the
      // previous one's report no longer describes anything on screen. Reading
      // it as an omission is what leaves the old sentence standing over a new
      // incident, which is the defect, and the `??` is how it gets written.
      expect(
        harness.handle.store.getState().lastFallbackOutcome,
      ).toBeUndefined();
    } finally {
      harness.handle.dispose();
    }
  });

  it("sets and clears an outcome through turnStateChanged", () => {
    const harness = createLegacyHarness();
    try {
      const callbacks = harness.callbacks();
      emitLegacySnapshot(callbacks, undefined);
      emitTurnState(callbacks, OUTCOME_A);
      expect(harness.handle.store.getState().lastFallbackOutcome).toBe(
        OUTCOME_A,
      );

      emitTurnState(callbacks, undefined);
      // Falsification: add "?? state.lastFallbackOutcome" to the
      // turnStateChanged write and THIS assertion must go red.
      expect(
        harness.handle.store.getState().lastFallbackOutcome,
      ).toBeUndefined();
    } finally {
      harness.handle.dispose();
    }
  });

  it("seats an outcome-bearing windowed snapshot IMMEDIATELY, before the tail hydrates", () => {
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      callbacks.onWindowedSnapshot(deferredWindowedSnapshot(OUTCOME_A));

      // The precondition every case in this describe block relies on: this
      // snapshot is genuinely deferred, so what follows exercises the
      // deferral branch and not the ordinary fold.
      expect(
        isTailHydrated(harness.handle.store.getState().transcriptWindow),
      ).toBe(false);

      // Falsification: move this seat out of `applyOrDeferWindowedSnapshot`'s
      // deferral branch (seat it only once the fold runs) and THIS assertion
      // goes red - the whole point of D215's asymmetry with the other three
      // fallback DTOs is that `appendFallbackNoticeBlock` publishes a
      // snapshot and guarantees no later `turnStateChanged`, so a held
      // outcome has no second carrier to arrive on.
      expect(harness.handle.store.getState().lastFallbackOutcome).toBe(
        OUTCOME_A,
      );
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps the SUPERSEDING outcome, not the held snapshot's original, once the tail hydrates", () => {
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      callbacks.onWindowedSnapshot(deferredWindowedSnapshot(OUTCOME_A));
      expect(harness.handle.store.getState().lastFallbackOutcome).toBe(
        OUTCOME_A,
      );

      // A turnStateChanged arrives WHILE the snapshot is still held and
      // supersedes the value - `advanceDeferredSnapshotAux` is the only thing
      // that can reach it before the fold runs.
      emitTurnState(callbacks, OUTCOME_B);
      // The live read already moved (immediate-seat rule above applies here
      // too - turnStateChanged writes the live state directly as well).
      expect(harness.handle.store.getState().lastFallbackOutcome).toBe(
        OUTCOME_B,
      );

      completeTail(harness);

      // Falsification: in `advanceDeferredSnapshotAux`'s turnStateChanged
      // caller, drop the `lastFallbackOutcome: frame.lastFallbackOutcome`
      // line - the held aux keeps replaying OUTCOME_A and THIS assertion
      // goes red once the fold runs and re-seats from the (unsuperseded) aux.
      expect(harness.handle.store.getState().lastFallbackOutcome).toBe(
        OUTCOME_B,
      );
    } finally {
      harness.handle.dispose();
    }
  });

  it("does not resurrect a superseded outcome on RE-ENTRY of the deferral branch", () => {
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      const snapshot = deferredWindowedSnapshot(OUTCOME_A);
      callbacks.onWindowedSnapshot(snapshot);
      expect(harness.handle.store.getState().lastFallbackOutcome).toBe(
        OUTCOME_A,
      );

      // Supersede while still held.
      emitTurnState(callbacks, OUTCOME_B);

      // A range response that does NOT complete the tail - re-entry of the
      // SAME deferred frame, so `applyOrDeferWindowedSnapshot` defers AGAIN
      // rather than running the fold. This is the exact re-entry the seat's
      // `heldAux` guard exists for: without it, this second pass would
      // re-derive from `deferredWindowedSnapshotAuxOf(frame.snapshot)` - the
      // ORIGINAL frame's own aux - and resurrect OUTCOME_A.
      //
      // It must return the EARLY row (ordinal 0), and `reachedEnd: false` is
      // NOT what makes this partial. `isTailHydrated` ignores those flags
      // entirely: it asks whether any span covers `rowCount - 1`
      // (`transcript-window.ts`). The snapshot declares `rowCount: 2`, so
      // ordinal 1 IS the last row - returning `row-1` here hydrates the tail
      // and runs the fold, which is what the first version of this test did.
      // It still read OUTCOME_B afterwards and would have passed; the
      // non-vacuousness assertion below is the only thing that caught it.
      callbacks.onRange({
        kind: "range",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        range: {
          requestId: harness.lastRangeRequestId(),
          epoch: 4,
          fromOrdinal: 0,
          rowIds: ["row-0"],
          messages: [userMessage("m-0", 0)],
          events: [],
          rowContext: {},
          reachedStart: false,
          reachedEnd: false,
        },
      });

      // NON-VACUOUSNESS CHECK, not incidental: `emitTurnState` above already
      // wrote OUTCOME_B to the LIVE state directly (D215's immediate-seat
      // rule applies there too), so reading OUTCOME_B after the `onRange`
      // below is not by itself proof that this response re-entered the
      // deferral branch at all - a response that instead completed the tail,
      // or short-circuited before touching `lastFallbackOutcome`, would read
      // the same value and pass for the wrong reason (the D219 shape: green
      // without having exercised anything). This assertion is what rules
      // that out: the tail is STILL not hydrated, which is possible only if
      // `applyOrDeferWindowedSnapshot` actually deferred again rather than
      // running the fold or returning early. Read together with the outcome
      // assertion below - "still deferred" AND "still the superseding
      // value" - the pair excludes the vacuous reading; neither proves it
      // alone.
      expect(
        isTailHydrated(harness.handle.store.getState().transcriptWindow),
      ).toBe(false);

      // Falsification (stated in chat-session-store.ts's own comment, pinned
      // here): change the seat's `heldAux ?? deferredWindowedSnapshotAuxOf(frame.snapshot)`
      // to unconditionally `deferredWindowedSnapshotAuxOf(frame.snapshot)` -
      // this assertion goes red, reading OUTCOME_A again on re-entry.
      expect(harness.handle.store.getState().lastFallbackOutcome).toBe(
        OUTCOME_B,
      );

      // And the eventual real hydration still ends on the superseding value.
      completeTail(harness);
      expect(harness.handle.store.getState().lastFallbackOutcome).toBe(
        OUTCOME_B,
      );
    } finally {
      harness.handle.dispose();
    }
  });
});
