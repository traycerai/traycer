/**
 * `use-chat-queue-actions.ts`'s steer refusal routing: a queued steer the host
 * refused until the person confirms ending the turn is asked about in the tile
 * that sent it, and only there. Two panes on one chat share one store, and an
 * unfocused pane renders no dialog, so a refusal claimed by the wrong pane is
 * a question nobody sees.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";

import {
  useChatQueueActions,
  type ChatQueueActionsInput,
} from "@/components/epic-canvas/renderers/use-chat-queue-actions";
import type { ChatActions } from "@/hooks/chats/use-chat-actions";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
  type SteerRestartRefusal,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

const NODE_ID = "chat-queue-1";
const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

function createHandle(): ChatSessionStoreHandle {
  return createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
    epicId: "epic-1",
    chatId: NODE_ID,
    userId: "user-1",
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: () => ({
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      draftBlobBridgeSupported: () => true,
      requestTranscriptRange: () => undefined,
      requestResnapshot: () => undefined,
      close: () => undefined,
    }),
  });
}

function fakeChatActions(overrides: Partial<ChatActions>): ChatActions {
  return {
    sendMessage: () => null,
    deleteMessageSuffix: () => null,
    editUserMessage: () => null,
    revertFileChanges: () => null,
    stopTurn: () => null,
    stopBackgroundItem: () => null,
    stopAllBackgroundItems: () => null,
    stopBackgroundSession: () => null,
    pauseQueue: () => null,
    resumeQueue: () => null,
    queueEdit: () => null,
    queueSettingsUpdate: () => null,
    submitQueueEdit: () => null,
    checkSendDelivery: () => undefined,
    restampQueuedItemSettings: () => undefined,
    updateActivePermissionMode: () => null,
    updateActiveProfile: () => null,
    queueCancel: () => "action-1",
    queueReorder: () => null,
    queueSteerNow: () => null,
    queueAbortSteer: () => null,
    approvalDecision: () => null,
    fileEditApprovalDecision: () => null,
    restoreCheckpoint: () => null,
    interviewAnswer: () => null,
    interviewSkip: () => null,
    interviewDeliveryRetry: () => null,
    ackFailedSendRestoration: () => undefined,
    ackAcceptedAction: () => undefined,
    takeSetupFailedRestoration: () => null,
    messageDeliveryRestored: () => null,
    ...overrides,
  };
}

function refusalFrom(initiatorId: string): SteerRestartRefusal {
  return {
    clientActionId: "steer-1",
    queueItemId: "queue-1",
    newSettings: SETTINGS,
    reasons: ["images"],
    initiatorId,
  };
}

function tileInput(
  handle: ChatSessionStoreHandle,
  tileInstanceId: string,
  queueSteerNow: ChatActions["queueSteerNow"],
): ChatQueueActionsInput {
  return {
    chatActions: fakeChatActions({ queueSteerNow }),
    handle,
    nodeId: NODE_ID,
    tileInstanceId,
    replaceDraftContent: () => undefined,
    clearDraftContent: () => undefined,
    currentComposerSettings: SETTINGS,
    nextStepSettings: SETTINGS,
    currentEpicId: "epic-1",
    editingQueueItemId: null,
    activeEditingQueueItemId: null,
    dispatchUi: () => undefined,
    setEpicRunSettings: () => undefined,
    persistChatRunSettings: () => undefined,
  };
}

describe("steer restart refusal routing", () => {
  it("asks in the tile that sent the steer, not in an earlier pane on the same chat", () => {
    const handle = createHandle();
    const queueSteerNow = vi.fn<ChatActions["queueSteerNow"]>(() => "steer-2");
    const tileA = renderHook(() =>
      useChatQueueActions(tileInput(handle, "tile-a", queueSteerNow)),
    );
    const tileB = renderHook(() =>
      useChatQueueActions(tileInput(handle, "tile-b", queueSteerNow)),
    );

    act(() => {
      handle.store.setState({ steerRestartRefusal: refusalFrom("tile-b") });
    });

    expect(tileA.result.current.steerRestart.open).toBe(false);
    expect(tileB.result.current.steerRestart.open).toBe(true);
    expect(tileB.result.current.steerRestart.reasons).toEqual(["images"]);

    act(() => {
      tileB.result.current.steerRestart.onRestart();
    });

    expect(queueSteerNow).toHaveBeenCalledWith(
      "queue-1",
      SETTINGS,
      true,
      "tile-b",
    );
    expect(handle.store.getState().steerRestartRefusal).toBeNull();
    expect(tileB.result.current.steerRestart.open).toBe(false);
    expect(tileA.result.current.steerRestart.open).toBe(false);
  });

  it("asks for a refusal that arrived before the sending tile rendered again", () => {
    const handle = createHandle();
    handle.store.setState({ steerRestartRefusal: refusalFrom("tile-b") });

    const tileB = renderHook(() =>
      useChatQueueActions(
        tileInput(
          handle,
          "tile-b",
          vi.fn<ChatActions["queueSteerNow"]>(() => null),
        ),
      ),
    );

    expect(tileB.result.current.steerRestart.open).toBe(true);

    act(() => {
      tileB.result.current.steerRestart.onOpenChange(false);
    });

    // Cancel leaves the prompt queued and the question answered.
    expect(handle.store.getState().steerRestartRefusal).toBeNull();
    expect(tileB.result.current.steerRestart.open).toBe(false);
  });
});
