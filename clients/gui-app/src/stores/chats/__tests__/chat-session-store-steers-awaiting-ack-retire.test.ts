/**
 * `steersAwaitingAck` holds a queued steer's settings and sending tile from
 * the moment the frame is built until its ack, so a refusal that arrives
 * synchronously still finds them. An ack is the only thing that read the
 * entry, so a steer that never gets one - a dispatch the store refused, or a
 * frame that died with its connection - kept its entry for the session's
 * life.
 *
 * The map is private and nothing reads a dead steer's entry again, so these
 * cases find the map through a spy on `Map.prototype.set` (the private map's
 * own prototype, not a production change) and read its size.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  draftMirrorClientForHost: () => null,
}));

const EPIC_ID = "epic-steer-retire";
const CHAT_ID = "chat-steer-retire";
const OWNER_ID = "owner-steer-retire";
const TILE_ID = "tile-steer-retire";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
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
    hostId: "host-steer-retire",
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
        draftBlobBridgeSupported: () => true,
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

function emitOwnerSnapshot(callbacks: ChatStreamCallbacks): void {
  callbacks.onConnectionStatus("open", null, null);
  const chat: Chat = {
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
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat,
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

function isTileEntry(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "initiatorId" in value &&
    value.initiatorId === TILE_ID
  );
}

/**
 * Queue a steer from `TILE_ID` and return the private map its entry went
 * into, found as the `Map` whose `set` received that tile's entry.
 */
function queueSteerAndFindMap(harness: Harness): {
  readonly clientActionId: string | null;
  readonly steersAwaitingAck: Map<unknown, unknown>;
} {
  const setSpy = vi.spyOn(Map.prototype, "set");
  try {
    const clientActionId = harness.handle.store
      .getState()
      .queueSteerNow("queue-1", SETTINGS, false, {
        initiatorId: TILE_ID,
        editSettings: null,
      });
    const call = setSpy.mock.calls.findIndex(([, value]) => isTileEntry(value));
    const steersAwaitingAck = setSpy.mock.contexts[call];
    if (!(steersAwaitingAck instanceof Map)) {
      throw new Error("Expected the steer's entry to go into a Map");
    }
    return { clientActionId, steersAwaitingAck };
  } finally {
    setSpy.mockRestore();
  }
}

let harness: Harness | null = null;

afterEach(() => {
  harness?.handle.dispose();
  harness = null;
});

describe("steersAwaitingAck: a steer that will never get an ack leaves no entry", () => {
  it("drops the entry when the store refuses to dispatch the steer", () => {
    harness = createHarness();
    // No snapshot yet: the connection is not open, so nothing can be sent.
    const { clientActionId, steersAwaitingAck } = queueSteerAndFindMap(harness);

    expect(clientActionId).toBeNull();
    expect(harness.sent).toEqual([]);
    expect(steersAwaitingAck.size).toBe(0);
  });

  it("drops the entry when a reconnect's snapshot sweeps the steer its connection lost", () => {
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const { clientActionId, steersAwaitingAck } = queueSteerAndFindMap(harness);
    expect(clientActionId).not.toBeNull();
    if (clientActionId === null) throw new Error("Expected a dispatch");
    expect(steersAwaitingAck.has(clientActionId)).toBe(true);

    harness.callbacks().onConnectionStatus("reconnecting", null, null);
    emitOwnerSnapshot(harness.callbacks());

    // The sweep ran: the steer's pending action is gone with its connection.
    expect(
      harness.handle.store.getState().pendingActions[clientActionId],
    ).toBeUndefined();
    expect(steersAwaitingAck.size).toBe(0);
  });

  it("drops a dispatched steer's entry when the store is disposed", () => {
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const { clientActionId, steersAwaitingAck } = queueSteerAndFindMap(harness);
    expect(clientActionId).not.toBeNull();

    harness.handle.dispose();
    harness = null;

    expect(steersAwaitingAck.size).toBe(0);
  });
});
