import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedItem,
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";

/**
 * D1 (durability audit): "Profile switch while messages are QUEUED - do
 * queued sends restamp to the new profileId or keep the old? ... no
 * split-brain sessions."
 *
 * This probes the actual restamp funnel wired to a composer settings change:
 * `handleComposerSettingsChange` (use-chat-queue-actions.ts) always calls
 * `chatActions.restampQueuedItemSettings(settings, excludeQueueItemId)` on
 * every settings emit, including a pure profile switch. The store action
 * gates the whole restamp on `chatRunSettingsEqual`, which now compares
 * `profileId` too (previously it didn't, so a same-harness/same-model
 * profile switch was invisible to this gate - see the fix in
 * chat-session-store.ts).
 */

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const OWNER_ID = "owner-1";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};

const PROFILE_A_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "sonnet-4.5",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "regular",
  profileId: "profile-a",
};

// Same harness/model/permission/reasoning/tier/agentMode as PROFILE_A_SETTINGS
// - only `profileId` differs. This is the common "switch to another
// subscription on the same harness" case a rate-limit switch prompt drives.
const PROFILE_B_SETTINGS: ChatRunSettings = {
  ...PROFILE_A_SETTINGS,
  profileId: "profile-b",
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
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: (frame) => {
          sent.push(frame);
        },
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

function emitSnapshot(harness: Harness): void {
  harness.callbacks().onConnectionStatus("open", null);
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
        title: "Host Chat",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        settings: null,
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [],
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
    },
  });
}

function queuedItem(
  queueItemId: string,
  settings: ChatRunSettings,
): ChatQueuedItem {
  return {
    queueItemId,
    messageId: `m-${queueItemId}`,
    message: { kind: "user" as const, content: CONTENT },
    sender: { type: "user" as const, userId: OWNER_ID },
    settings,
    accountContext: { type: "PERSONAL" as const },
    delivery: "next_turn" as const,
    status: "pending" as const,
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("D1: queued messages + profile switch (restamp path)", () => {
  it("a same-harness/same-model profile-only switch restamps an already-queued message to the new profile", () => {
    const harness = createHarness();
    emitSnapshot(harness);

    // One message is already queued on profile A.
    harness.callbacks().onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: {
        status: "running",
        items: [queuedItem("queue-1", PROFILE_A_SETTINGS)],
      },
    });

    // The user switches to profile B via the rate-limit switch banner /
    // rail (same harness, same model - only profileId changes). This is
    // exactly what `handleComposerSettingsChange` forwards on every
    // toolbar commit.
    harness.handle.store
      .getState()
      .restampQueuedItemSettings(PROFILE_B_SETTINGS, null);

    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    if (frame.kind !== "queueSettingsRestamp") {
      throw new Error("Expected queueSettingsRestamp frame");
    }
    expect(frame.settings.profileId).toBe("profile-b");
  });

  it("a no-op re-commit of the SAME profile still sends nothing (chatRunSettingsEqual correctly reports equal)", () => {
    const harness = createHarness();
    emitSnapshot(harness);

    harness.callbacks().onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: {
        status: "running",
        items: [queuedItem("queue-1", PROFILE_A_SETTINGS)],
      },
    });

    harness.handle.store
      .getState()
      .restampQueuedItemSettings(PROFILE_A_SETTINGS, null);

    expect(harness.sent).toHaveLength(0);
  });

  it("control: a harness/model change on top of the same profile DOES restamp (chatRunSettingsEqual still catches non-profile fields)", () => {
    const harness = createHarness();
    emitSnapshot(harness);

    harness.callbacks().onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: {
        status: "running",
        items: [queuedItem("queue-1", PROFILE_A_SETTINGS)],
      },
    });

    const differentModelSameProfile: ChatRunSettings = {
      ...PROFILE_A_SETTINGS,
      model: "opus-4",
    };
    harness.handle.store
      .getState()
      .restampQueuedItemSettings(differentModelSameProfile, null);

    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    if (frame.kind !== "queueSettingsRestamp") {
      throw new Error("Expected queueSettingsRestamp frame");
    }
    expect(frame.settings.profileId).toBe("profile-a");
  });

  it("documents the mixed-queue contract: the GUI has no per-item scoping, only excludeQueueItemId - a profile-only item now trips the gate on its own, and a sibling with an unrelated field change rides along in the SAME frame", () => {
    const harness = createHarness();
    emitSnapshot(harness);

    harness.callbacks().onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: {
        status: "running",
        items: [
          // Differs ONLY by profileId from the incoming settings - now
          // correctly trips chatRunSettingsEqual on its own.
          queuedItem("queue-profile-only", PROFILE_A_SETTINGS),
          // Also differs in model, so it independently trips the check too.
          queuedItem("queue-model-stale", {
            ...PROFILE_A_SETTINGS,
            model: "opus-4",
          }),
        ],
      },
    });

    harness.handle.store
      .getState()
      .restampQueuedItemSettings(PROFILE_B_SETTINGS, null);

    // One frame is sent (the action fires at most once, not once per
    // differing item) and it carries the full new settings with no
    // per-item scoping beyond `excludeQueueItemId` - the GUI never
    // distinguishes "restamp only queue A" from "restamp only queue B",
    // it is all-or-nothing per exclude id. This structural characteristic
    // of the wire contract is unaffected by the profileId fix above.
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    if (frame.kind !== "queueSettingsRestamp") {
      throw new Error("Expected queueSettingsRestamp frame");
    }
    expect(frame.settings).toEqual(PROFILE_B_SETTINGS);
    expect(frame.excludeQueueItemId).toBeNull();
  });
});
