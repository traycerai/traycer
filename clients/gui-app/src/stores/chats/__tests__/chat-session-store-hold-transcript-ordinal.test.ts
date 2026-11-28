import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { HYDRATION_REQUEST_TIMEOUT_MS } from "@/stores/chats/chat-session-store";
import { TRANSCRIPT_WINDOW_MAX_BYTES } from "@/stores/chats/transcript-window";
import {
  createHarness,
  primeWindowAtTail,
  type WindowedChatIdentity,
} from "@/stores/chats/test-support/windowed-chat-session-harness";

/**
 * `holdTranscriptOrdinal` is REQUIRED hydration for as long as a surface
 * outside the transcript shows the row (a bot thread's post in its panel),
 * never a viewport move. Each hold is its own entry, so two surfaces on one
 * row release independently.
 * Driven through the real store and its real planner; only the stream client
 * is a double, recording every `loadRange` the store sends.
 */
const EPIC_ID = "epic-hold";
const CHAT_ID = "chat-hold";
const OWNER_ID = "owner-hold";
const IDENTITY: WindowedChatIdentity = {
  hostId: "host-hold",
  epicId: EPIC_ID,
  chatId: CHAT_ID,
  ownerId: OWNER_ID,
};

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

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

function oversizedUserMessage(messageId: string, timestamp: number): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "x".repeat(TRANSCRIPT_WINDOW_MAX_BYTES + 1024),
              },
            ],
          },
        ],
      },
      browserAnnotations: [],
    },
    timestamp,
    sessionAnchor: null,
  };
}

describe("chat-session-store - held transcript ordinals", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates the held row without a viewport move or a jump", () => {
    const harness = createHarness(IDENTITY);
    try {
      primeWindowAtTail(harness, 40, 20, userMessage("tail", 20));
      expect(harness.rangeRequests).toEqual([]);

      harness.handle.store.getState().holdTranscriptOrdinal(5);

      const state = harness.handle.store.getState();
      expect(state.heldReadOrdinals).toEqual([5]);
      expect(state.jumpTargetOrdinal).toBeNull();
      expect(harness.rangeRequests).toHaveLength(1);
      expect(harness.rangeRequests[0]).toMatchObject({
        fromOrdinal: 5,
        toOrdinal: 5,
      });
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps asking for the row while any hold on it stands, and stops after the last release", () => {
    vi.useFakeTimers();
    const harness = createHarness(IDENTITY);
    try {
      primeWindowAtTail(harness, 40, 20, userMessage("tail", 20));
      const releaseFirst = harness.handle.store
        .getState()
        .holdTranscriptOrdinal(5);
      const releaseSecond = harness.handle.store
        .getState()
        .holdTranscriptOrdinal(5);
      expect(harness.rangeRequests).toHaveLength(1);

      releaseFirst();
      // A second release of the same hold changes nothing.
      releaseFirst();
      expect(harness.handle.store.getState().heldReadOrdinals).toEqual([5]);
      vi.advanceTimersByTime(HYDRATION_REQUEST_TIMEOUT_MS + 1);
      expect(harness.rangeRequests).toHaveLength(2);
      expect(harness.rangeRequests[1]).toMatchObject({
        fromOrdinal: 5,
        toOrdinal: 5,
      });

      releaseSecond();
      expect(harness.handle.store.getState().heldReadOrdinals).toEqual([]);
      vi.advanceTimersByTime(HYDRATION_REQUEST_TIMEOUT_MS + 1);
      expect(harness.rangeRequests).toHaveLength(2);
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps every hold through a legacy downgrade, and only each surface's own release ends its hold", () => {
    const harness = createHarness(IDENTITY);
    try {
      primeWindowAtTail(harness, 40, 20, userMessage("tail", 20));
      const releaseFirst = harness.handle.store
        .getState()
        .holdTranscriptOrdinal(5);
      const releaseSecond = harness.handle.store
        .getState()
        .holdTranscriptOrdinal(5);
      expect(harness.handle.store.getState().heldReadOrdinals).toEqual([5, 5]);

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
            hostId: "host-hold",
            title: "Hold",
            createdAt: 1,
            updatedAt: 2,
            isTitleEditedByUser: false,
            settings: null,
            archivedAt: null,
            lastDeliveredRolesDigest: null,
            activeSessionChain: null,
            claudePendingWakes: [],
            pinnedUserProviderHandle: null,
            messages: [userMessage("legacy", 2)],
            events: [],
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
          accumulatedFileChanges: [],
          managedCommands: [],
          heldUpdates: [],
          portForwards: [],
          pendingFallback: undefined,
          pendingReturn: undefined,
          suggestedPrompt: undefined,
          thinkingTokensEstimate: undefined,
        },
      });
      const downgraded = harness.handle.store.getState();
      expect(downgraded.transcriptDerived).toBeNull();
      expect(downgraded.heldReadOrdinals).toEqual([5, 5]);

      releaseFirst();
      expect(harness.handle.store.getState().heldReadOrdinals).toEqual([5]);
      releaseFirst();
      expect(harness.handle.store.getState().heldReadOrdinals).toEqual([5]);
      releaseSecond();
      expect(harness.handle.store.getState().heldReadOrdinals).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });

  it("is held apart from a find read: releasing the hold leaves the read", () => {
    const harness = createHarness(IDENTITY);
    try {
      primeWindowAtTail(harness, 40, 20, userMessage("tail", 20));
      harness.handle.store.getState().requestFindReadOrdinal(6);
      const release = harness.handle.store.getState().holdTranscriptOrdinal(5);
      release();

      const state = harness.handle.store.getState();
      expect(state.findReadOrdinal).toBe(6);
      expect(state.heldReadOrdinals).toEqual([]);
    } finally {
      harness.handle.dispose();
    }
  });
  it("keeps a held row hydrated through a snapshot that pushes the window over budget", () => {
    const harness = createHarness(IDENTITY);
    try {
      primeWindowAtTail(harness, 40, 20, userMessage("tail", 20));
      harness.handle.store.getState().holdTranscriptOrdinal(5);
      const request = harness.rangeRequests[0];
      expect(request).toMatchObject({ fromOrdinal: 5, toOrdinal: 5 });
      harness.callbacks().onRange({
        kind: "range",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        range: {
          requestId: request.requestId,
          epoch: 1,
          fromOrdinal: 5,
          rowIds: ["row-5"],
          messages: [userMessage("held", 5)],
          events: [],
          rowContext: {},
          reachedStart: false,
          reachedEnd: false,
        },
      });
      const heldSpan = (): boolean =>
        harness.handle.store
          .getState()
          .transcriptWindow.spans.some((span) => span.fromOrdinal === 5);
      expect(heldSpan()).toBe(true);

      // A new tail row larger than the whole budget: the snapshot path is
      // over budget and may only drop what is not protected.
      primeWindowAtTail(harness, 41, 21, oversizedUserMessage("huge", 21));

      expect(harness.handle.store.getState().heldReadOrdinals).toEqual([5]);
      expect(heldSpan()).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });
});
