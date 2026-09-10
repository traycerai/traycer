import { describe, expect, it } from "vitest";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { NO_TRANSCRIPT_BASELINE } from "@/stores/chats/chat-announcements";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * `connectionEpoch` - the closure generation counter mirrored into state so
 * it is SUBSCRIBABLE (`ChatSessionState.connectionEpoch`), and its partner
 * `transcriptBaselineEpoch`.
 */

const EPIC_ID = "epic-epoch";
const CHAT_ID = "chat-epoch";
const OWNER_ID = "owner-epoch";

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly factoryCalls: number;
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
  let callbacks: ChatStreamCallbacks | null = null;
  let factoryCalls = 0;
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
      factoryCalls += 1;
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
    get factoryCalls() {
      return factoryCalls;
    },
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

function emitSnapshot(callbacks: ChatStreamCallbacks): void {
  callbacks.onConnectionStatus("open", null);
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
      lastFallbackOutcome: undefined,
    },
  });
}

describe("chat-session-store connectionEpoch", () => {
  it("is UNEQUAL to transcriptBaselineEpoch at cold mount (-1 vs 0), and equal once a snapshot seats", () => {
    const harness = createHarness();
    try {
      // The boundary this test names in its own title, so a reader does not
      // have to open the store's doc to learn it: `NO_TRANSCRIPT_BASELINE`
      // is -1, not 0, so a test asserting `0`/`0` at cold mount would pass
      // while lying about the real starting values.
      expect(NO_TRANSCRIPT_BASELINE).toBe(-1);
      const cold = harness.handle.store.getState();
      expect(cold.transcriptBaselineEpoch).toBe(NO_TRANSCRIPT_BASELINE);
      expect(cold.connectionEpoch).toBe(0);
      // Falsification: initialize `transcriptBaselineEpoch` to `0` in the
      // store's initial state and this assertion goes red - it would then
      // read EQUAL to `connectionEpoch` at cold mount, which is the "warm
      // remount" reading, not "never connected".
      expect(cold.transcriptBaselineEpoch).not.toBe(cold.connectionEpoch);

      emitSnapshot(harness.callbacks());
      const seated = harness.handle.store.getState();
      // Falsification: drop the `transcriptBaselineEpoch: connectionEpoch`
      // write from `applyAuthoritativeSnapshot` (leave the cold `-1`
      // standing) and this must go red.
      expect(seated.transcriptBaselineEpoch).toBe(seated.connectionEpoch);
    } finally {
      harness.handle.dispose();
    }
  });

  it("increments on reconnecting AND on closed, each visible in state", () => {
    const harness = createHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks);
      const afterSnapshot = harness.handle.store.getState().connectionEpoch;

      callbacks.onConnectionStatus("reconnecting", null);
      // Falsification: drop the `bumpConnectionEpoch()` call from the
      // `"reconnecting"` arm of `onConnectionStatus` and this stays at
      // `afterSnapshot` instead of incrementing.
      expect(harness.handle.store.getState().connectionEpoch).toBe(
        afterSnapshot + 1,
      );

      callbacks.onConnectionStatus("closed", null);
      // Falsification: same, for the `"closed"` arm - a SEPARATE increment,
      // not a no-op because one already fired this "incident".
      expect(harness.handle.store.getState().connectionEpoch).toBe(
        afterSnapshot + 2,
      );

      // Negative half: `"open"` is neither reconnecting nor closed, so it
      // must NOT bump.
      callbacks.onConnectionStatus("open", null);
      expect(harness.handle.store.getState().connectionEpoch).toBe(
        afterSnapshot + 2,
      );
    } finally {
      harness.handle.dispose();
    }
  });

  it("increments on a stream-client replacement (retry), and the mirror is what a subscriber actually observes", () => {
    const harness = createHarness();
    try {
      emitSnapshot(harness.callbacks());
      const before = harness.handle.store.getState().connectionEpoch;
      expect(harness.factoryCalls).toBe(1);

      const observed: number[] = [];
      const unsubscribe = harness.handle.store.subscribe((state) => {
        observed.push(state.connectionEpoch);
      });
      try {
        harness.handle.store.getState().retry();
      } finally {
        unsubscribe();
      }

      // The replacement itself calls the factory again - confirms `retry()`
      // actually swapped the client rather than reusing it.
      expect(harness.factoryCalls).toBe(2);
      // Falsification: drop the `bumpConnectionEpoch()` call from
      // `closeStreamClient` (the comment there calls out that the OLD
      // client's own `closed` status is suppressed by the generation guard,
      // "so bump here too") and this must go red.
      expect(harness.handle.store.getState().connectionEpoch).toBe(before + 1);
      // The whole point of mirroring the closure counter into state: a
      // subscriber actually SAW the bump as a state transition, not just a
      // final-value coincidence.
      expect(observed).toContain(before + 1);
    } finally {
      harness.handle.dispose();
    }
  });
});
