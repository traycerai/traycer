/**
 * Opt-in, wall-clock GUI-side reproduction of a Pending row surviving a slow
 * host round trip, through a REAL `chat-session-store.ts` (no fake timers).
 *
 * *** This is a SEPARATE fixture from
 * `chat-send-timing-injected-delay.repro.test.ts` (traycer-host). The two do
 * NOT share one correlated trace: this test's `~12s` gap is a real
 * `setTimeout` before this fixture's own fake `onMessageAccepted` callback
 * fires, standing in for "the host round trip took ~12s" - it says nothing
 * about what the host actually spent that time on. A combined GUI+host
 * bridge (piping a real `ChatSessionManager` subscription into a real GUI
 * store in one process) was considered and rejected: `gui-app`'s Vitest runs
 * under `jsdom` with no `@traycer/host`/`@traycerai/common` aliasing, and
 * `chat-session-manager.ts` pulls in native SQLite + Inversify + Node-only
 * machinery that config was never set up to load. That import-boundary
 * surface is broad enough that bridging it is its own task, not a
 * few-minutes addition to this one.
 *
 * What this DOES show: `pendingUserMessages` keeps the row, and no
 * reconciliation-door phase (`pending_replaced_by_acceptance` etc.) fires,
 * for the entire real wall-clock gap - i.e. this store never speculatively
 * clears Pending early. It is NOT a measurement of, and must not be cited as
 * evidence for, the natural incident's root cause.
 *
 * Skipped by default (`TRAYCER_SEND_TIMING_REPRO` unset). Evidence directory
 * is configurable via `TRAYCER_SEND_TIMING_EVIDENCE_DIR` (default: a tmp
 * dir), not baked into this file. Written to disk, not merely logged: the
 * jsdom test environment still runs in a real Node process, so
 * `node:fs/promises` works here exactly as it does in the host-side repros -
 * relying on `appLogger.info` being visible was unreliable (this file's own
 * `vi.spyOn` mocks it as a no-op for the whole test, and even unmocked, the
 * real logger gates on `appLogLevel`, which is not guaranteed to admit
 * "info" under Vitest's default mode).
 */
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  SendTimingBatch,
  SendTimingEntry,
} from "@traycer/protocol/host/agent/gui/send-timing";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { appLogger } from "@/lib/logger";

const REPRO_ENABLED = process.env.TRAYCER_SEND_TIMING_REPRO === "1";
const INJECTED_ROUND_TRIP_MS = 12_000;
const REPRO_TIMEOUT_MS = 30_000;

const EVIDENCE_DIR =
  process.env.TRAYCER_SEND_TIMING_EVIDENCE_DIR ??
  path.join(os.tmpdir(), "traycer-send-timing-repro-evidence");

const SEND_TIMING_LOCAL_STORAGE_KEY = "traycer:send-timing";
const ORIGINAL_SEND_TIMING_LOCAL_STORAGE_VALUE = localStorage.getItem(
  SEND_TIMING_LOCAL_STORAGE_KEY,
);

// The store reads this gate ONCE, at `createChatSessionStore()` construction
// (see `chat-session-store.ts`), so it must already be "1" before
// `createHarness()` builds the store below - and without it `sendTimings`
// is a total no-op (`enabled: false`), so every mark()/begin() call here is
// silently dropped and every "no reconciliation-door phase fired" assertion
// would pass vacuously rather than for the reason this repro claims.
beforeEach(() => {
  localStorage.setItem(SEND_TIMING_LOCAL_STORAGE_KEY, "1");
});

afterEach(() => {
  if (ORIGINAL_SEND_TIMING_LOCAL_STORAGE_VALUE === null) {
    localStorage.removeItem(SEND_TIMING_LOCAL_STORAGE_KEY);
  } else {
    localStorage.setItem(
      SEND_TIMING_LOCAL_STORAGE_KEY,
      ORIGINAL_SEND_TIMING_LOCAL_STORAGE_VALUE,
    );
  }
});

function runnerInfo(): {
  readonly nodeVersion: string;
  readonly bunVersion: string | null;
} {
  return {
    nodeVersion: process.version,
    bunVersion: process.versions.bun ?? null,
  };
}

const EPIC_ID = "epic-send-timing-repro";
const CHAT_ID = "chat-send-timing-repro";
const OWNER_ID = "owner-send-timing-repro";
const HOST_ID = "host-send-timing-repro";

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
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
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
        sendAction: () => undefined,
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
}

function emitSnapshot(callbacks: ChatStreamCallbacks): void {
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
      portForwards: [],
    },
  });
}

/**
 * Acceptance carries a user message, not the broader transcript Message union.
 */
type AcceptedMessage = Parameters<
  ChatStreamCallbacks["onMessageAccepted"]
>[0]["message"];

function acceptedMessage(
  messageId: string,
  timestamp: number,
): AcceptedMessage {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isSendTimingBatch(value: unknown): value is SendTimingBatch {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(Reflect.get(value, "entries"))
  );
}

function sendTimingEntriesFor(
  calls: readonly (readonly unknown[])[],
  messageId: string,
): SendTimingEntry[] {
  return calls
    .filter((call) => call[0] === "ChatSendTiming")
    .map((call) => call[1])
    .filter(isSendTimingBatch)
    .flatMap((batch) => batch.entries)
    .filter((entry) => entry.messageId === messageId);
}

function sendTimingPhasesFor(
  calls: readonly (readonly unknown[])[],
  messageId: string,
): string[] {
  return sendTimingEntriesFor(calls, messageId).map((entry) => entry.phase);
}

describe.skipIf(!REPRO_ENABLED)(
  "ChatSendTiming: opt-in GUI-side injected round-trip reproduction",
  () => {
    it(
      "keeps the pending row and fires no reconciliation-door phase for a real ~12s gap before acceptance",
      async () => {
        const info = vi.spyOn(appLogger, "info").mockImplementation(() => {});
        const harness = createHarness();
        try {
          const callbacks = harness.callbacks();
          emitSnapshot(callbacks);

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

          const wallStart = Date.now();
          await realDelay(INJECTED_ROUND_TRIP_MS);
          const wallGapMs = Date.now() - wallStart;

          // The row survived the whole injected gap: this store never
          // speculatively clears Pending while waiting on the host.
          expect(
            harness.handle.store
              .getState()
              .pendingUserMessages.some(
                (m) => m.messageId === action.messageId,
              ),
          ).toBe(true);
          const phasesBeforeAcceptance = sendTimingPhasesFor(
            info.mock.calls,
            action.messageId,
          );
          // Positive proof the recorder actually captured this send before
          // asserting on its absence below - otherwise every "not toContain"
          // check would pass just as well on an empty (disabled-recorder)
          // trace, which is exactly the bug the missing localStorage gate
          // used to produce.
          expect(phasesBeforeAcceptance).toContain("send_called");
          expect(phasesBeforeAcceptance).toContain(
            "optimistic_pending_published",
          );
          expect(phasesBeforeAcceptance).toContain("dispatched");
          expect(phasesBeforeAcceptance).not.toContain(
            "pending_replaced_by_acceptance",
          );
          expect(phasesBeforeAcceptance).not.toContain(
            "pending_replaced_by_transcript",
          );
          expect(phasesBeforeAcceptance).not.toContain(
            "pending_replaced_by_queue",
          );
          expect(phasesBeforeAcceptance).not.toContain("pending_removed");

          callbacks.onMessageAccepted({
            kind: "messageAccepted",
            hasBinaryPayload: false,
            epicId: EPIC_ID,
            chatId: CHAT_ID,
            message: acceptedMessage(action.messageId, Date.now()),
          });

          expect(
            harness.handle.store
              .getState()
              .pendingUserMessages.some(
                (m) => m.messageId === action.messageId,
              ),
          ).toBe(false);
          // `sendTimings.mark()` only buffers; the reconciliation phase this
          // just recorded is not visible on the spy until the ~1s auto-flush
          // (or `clear()`) actually emits the batch, so read it back through a
          // real-timer wait rather than the synchronous state assertion above.
          await vi.waitFor(
            () => {
              expect(
                sendTimingPhasesFor(info.mock.calls, action.messageId),
              ).toContain("pending_replaced_by_acceptance");
            },
            { timeout: 2_000, interval: 50 },
          );

          // Full trace, not just a summary, so `summarize.py` (or any other
          // downstream reader) can parse every phase this send recorded -
          // collected from the spy's calls BEFORE restoring it.
          const fullTrace = sendTimingEntriesFor(
            info.mock.calls,
            action.messageId,
          );

          await mkdir(EVIDENCE_DIR, { recursive: true });
          const evidence = {
            label: "INJECTED_ROUND_TRIP_REPRODUCTION",
            warning:
              "This is a SEPARATE GUI-only fixture from the host-side " +
              "serializer-hold repro. The ~12s gap here is a real " +
              "setTimeout before this fixture's own fake onMessageAccepted " +
              "callback fires, standing in for 'the host round trip took " +
              "~12s' - it says nothing about what the host actually spent " +
              "that time on, and is NOT evidence of the natural incident's " +
              "root cause.",
            runner: runnerInfo(),
            injectedRoundTripMs: INJECTED_ROUND_TRIP_MS,
            observedWallGapMs: wallGapMs,
            messageId: action.messageId,
            phasesBeforeAcceptance,
            recordedAt: new Date().toISOString(),
            trace: fullTrace,
          };
          await writeFile(
            path.join(
              EVIDENCE_DIR,
              "gui-injected-round-trip-repro-timings.json",
            ),
            JSON.stringify(evidence, null, 2),
          );
        } finally {
          info.mockRestore();
          harness.handle.dispose();
        }
      },
      REPRO_TIMEOUT_MS,
    );
  },
);
