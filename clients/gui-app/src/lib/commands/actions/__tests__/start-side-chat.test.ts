import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";

import {
  sideChatPlacementForTile,
  startSideChat,
  type StartSideChatArgs,
} from "@/lib/commands/actions/start-side-chat";
import type { CreateChatCommand } from "@/lib/commands/actions/new-chat";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { setMobileApp } from "@/lib/mobile-app";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  selectInitialChatHandoff,
  useInitialChatHandoffStore,
} from "@/stores/epics/initial-chat-handoff-store";

/**
 * `startSideChat` (`/btw`): forks the current chat and asks the remainder of
 * the prompt there. Modeled on
 * `clone-chat-on-host-switch`/`profile-durability-clone-host-switch-edges.test.ts`
 * for the recoverable-fork-refusal retry shape, and `new-chat.test.ts` for the
 * canvas-store seeding conventions.
 */

const EPIC_ID = "epic-side-chat";
const TAB_ID = "tab-side-chat";
const HOST_ID = "host-1";
const USER_ID = "user-1";
const SOURCE_CHAT_ID = "source-chat-1";

const SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "sonnet-4.5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const QUESTION_CONTENT: JsonContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "why is it slow?" }] },
  ],
};

const EMPTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

const WORKTREE_INTENT: WorktreeIntent = {
  entries: [
    {
      kind: "local",
      workspacePath: "/repo",
      repoIdentifier: { owner: "traycerai", repo: "repo" },
      isPrimary: true,
    },
  ],
};

interface CreateChatCall {
  readonly request: CreateChatMutationInput;
  readonly onSuccess: (result: {
    chatId: string;
    initialTurnStarted?: boolean;
  }) => void;
  readonly onError: (error: HostRpcError) => void;
}

function createChatRecorder(): {
  readonly calls: CreateChatCall[];
  readonly createChat: CreateChatCommand;
} {
  const calls: CreateChatCall[] = [];
  return {
    calls,
    createChat: (request, callbacks) => {
      calls.push({
        request,
        onSuccess: callbacks.onSuccess,
        onError: callbacks.onError,
      });
    },
  };
}

function resetCanvasStore(): void {
  useEpicCanvasStore.setState({
    tabsById: {},
    openTabOrder: [],
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
    artifactTreeByEpicId: {},
    selfDeletedArtifactIds: new Set<string>(),
    preAckRootCreatesByEpic: {},
    pendingRootCreatesByEpic: {},
  });
}

function baseArgs(overrides: Partial<StartSideChatArgs>): StartSideChatArgs {
  const recorder = createChatRecorder();
  return {
    epicId: EPIC_ID,
    tabId: TAB_ID,
    hostId: HOST_ID,
    userId: USER_ID,
    sourceChatId: SOURCE_CHAT_ID,
    sourceChatTitle: "",
    sourceOwnerUserId: null,
    content: QUESTION_CONTENT,
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" },
    worktreeIntent: null,
    placement: { kind: "active-tile" },
    createChat: recorder.createChat,
    onHistoryUnavailable: vi.fn(),
    ...overrides,
  };
}

function checkpointUnavailableError(): HostRpcError {
  return new HostRpcError({
    code: "E_FORK_CHECKPOINT_UNAVAILABLE",
    message: "Cannot fork chat because it has no assistant checkpoint yet.",
    requestId: "req-side-chat-1",
    method: "epic.createChat",
    fatalDetails: null,
  });
}

function unrelatedError(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "host unreachable",
    requestId: "req-side-chat-2",
    method: "epic.createChat",
    fatalDetails: null,
  });
}

const scope = { hostId: HOST_ID, userId: USER_ID, epicId: EPIC_ID };

describe("startSideChat", () => {
  beforeEach(() => {
    resetCanvasStore();
    useInitialChatHandoffStore.getState().resetForTests();
    setMobileApp(false);
  });

  afterEach(() => {
    resetCanvasStore();
    useInitialChatHandoffStore.getState().resetForTests();
    setMobileApp(false);
    vi.restoreAllMocks();
  });

  describe("a non-empty question", () => {
    it("registers a pending handoff and sends a forkSource: latest create request", () => {
      const recorder = createChatRecorder();
      startSideChat(
        baseArgs({
          createChat: recorder.createChat,
          worktreeIntent: WORKTREE_INTENT,
          placement: { kind: "split", groupId: "pane-1", position: "right" },
        }),
      );

      expect(recorder.calls).toHaveLength(1);
      const { request } = recorder.calls[0];
      expect(request.parentId).toBe(SOURCE_CHAT_ID);
      expect(request.forkSource).toEqual({
        boundary: "latest",
        sourceChatId: SOURCE_CHAT_ID,
        sourceOwnerUserId: null,
      });
      expect(request.title.startsWith("Side - ")).toBe(true);
      expect(request.initialMessage).not.toBeNull();
      expect(request.initialMessage?.sender).toEqual({
        type: "user",
        userId: USER_ID,
      });
      expect(request.worktreeIntent).toBe(WORKTREE_INTENT);
      expect(request.workspaceMode).toBe("inherit");

      const handoff = selectInitialChatHandoff(
        useInitialChatHandoffStore.getState(),
        scope,
      );
      expect(handoff).not.toBeNull();
      expect(handoff?.status).toBe("pending");
      expect(handoff?.placement).toEqual({
        kind: "split",
        groupId: "pane-1",
        position: "right",
      });
      expect(handoff?.messageId).toBe(request.initialMessage?.messageId);
      expect(handoff?.clientActionId).toBe(
        request.initialMessage?.clientActionId,
      );
    });

    it("uses folderless workspaceMode for a null worktreeIntent", () => {
      const recorder = createChatRecorder();
      startSideChat(
        baseArgs({ createChat: recorder.createChat, worktreeIntent: null }),
      );

      expect(recorder.calls[0].request.workspaceMode).toBe("folderless");
      expect(recorder.calls[0].request.worktreeIntent).toBeNull();
    });

    it("marks the handoff sending once the host confirms the initial turn started", () => {
      const recorder = createChatRecorder();
      startSideChat(baseArgs({ createChat: recorder.createChat }));

      recorder.calls[0].onSuccess({
        chatId: "forked-chat",
        initialTurnStarted: true,
      });

      const handoff = selectInitialChatHandoff(
        useInitialChatHandoffStore.getState(),
        scope,
      );
      expect(handoff?.status).toBe("sending");
    });

    it("invalidates the handoff when the caller cancels before the create answers", () => {
      const recorder = createChatRecorder();
      const cancel = startSideChat(
        baseArgs({ createChat: recorder.createChat }),
      );

      // The tile unmounted while the create was still in flight. Without this
      // the handoff outlives it and a late answer still opens + sends.
      cancel();
      recorder.calls[0].onSuccess({ chatId: "forked-chat" });

      const handoff = selectInitialChatHandoff(
        useInitialChatHandoffStore.getState(),
        scope,
      );
      expect(handoff?.status).toBe("failed");
    });

    it("leaves the handoff non-sending when initialTurnStarted is absent", () => {
      const recorder = createChatRecorder();
      startSideChat(baseArgs({ createChat: recorder.createChat }));

      recorder.calls[0].onSuccess({ chatId: "forked-chat" });

      const handoff = selectInitialChatHandoff(
        useInitialChatHandoffStore.getState(),
        scope,
      );
      expect(handoff?.status).toBe("pending");
    });

    it("retries settings-only exactly once after a checkpoint-unavailable refusal", () => {
      const onHistoryUnavailable = vi.fn();
      const recorder = createChatRecorder();
      startSideChat(
        baseArgs({ createChat: recorder.createChat, onHistoryUnavailable }),
      );

      expect(recorder.calls).toHaveLength(1);
      recorder.calls[0].onError(checkpointUnavailableError());

      expect(onHistoryUnavailable).toHaveBeenCalledTimes(1);
      expect(onHistoryUnavailable).toHaveBeenCalledWith("no-checkpoint");
      expect(recorder.calls).toHaveLength(2);
      expect(recorder.calls[1].request.forkSource).toBeNull();
      expect(recorder.calls[1].request.chatId).toBe(
        recorder.calls[0].request.chatId,
      );

      // A second failure on the settings-only retry marks the handoff
      // failed and does not attempt a third create.
      recorder.calls[1].onError(unrelatedError());
      expect(recorder.calls).toHaveLength(2);
      const handoff = selectInitialChatHandoff(
        useInitialChatHandoffStore.getState(),
        scope,
      );
      expect(handoff?.status).toBe("failed");
    });

    it("does not retry a non-recoverable failure on the first attempt", () => {
      const onHistoryUnavailable = vi.fn();
      const recorder = createChatRecorder();
      startSideChat(
        baseArgs({ createChat: recorder.createChat, onHistoryUnavailable }),
      );

      recorder.calls[0].onError(unrelatedError());

      expect(onHistoryUnavailable).not.toHaveBeenCalled();
      expect(recorder.calls).toHaveLength(1);
      const handoff = selectInitialChatHandoff(
        useInitialChatHandoffStore.getState(),
        scope,
      );
      expect(handoff?.status).toBe("failed");
    });

    it("tracks ChatForked with include_history true on the fork success, false after the settings-only retry", () => {
      const track = vi.spyOn(Analytics.getInstance(), "track");
      const onHistoryUnavailable = vi.fn();
      const recorder = createChatRecorder();
      startSideChat(
        baseArgs({ createChat: recorder.createChat, onHistoryUnavailable }),
      );

      recorder.calls[0].onSuccess({
        chatId: "forked-chat",
        initialTurnStarted: true,
      });
      expect(track).toHaveBeenCalledWith(
        AnalyticsEvent.ChatForked,
        expect.objectContaining({ include_history: true }),
      );
      track.mockClear();

      const recorder2 = createChatRecorder();
      startSideChat(
        baseArgs({ createChat: recorder2.createChat, onHistoryUnavailable }),
      );
      recorder2.calls[0].onError(checkpointUnavailableError());
      recorder2.calls[1].onSuccess({
        chatId: "forked-chat-2",
        initialTurnStarted: true,
      });

      expect(track).toHaveBeenCalledWith(
        AnalyticsEvent.ChatForked,
        expect.objectContaining({ include_history: false }),
      );
    });
  });

  describe("a bare /btw (empty content)", () => {
    it("sends initialMessage: null and registers no handoff", () => {
      const recorder = createChatRecorder();
      startSideChat(
        baseArgs({ createChat: recorder.createChat, content: EMPTY_CONTENT }),
      );

      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0].request.initialMessage).toBeNull();
      const handoff = selectInitialChatHandoff(
        useInitialChatHandoffStore.getState(),
        scope,
      );
      expect(handoff).toBeNull();
    });
  });
});

describe("sideChatPlacementForTile", () => {
  beforeEach(() => {
    resetCanvasStore();
    setMobileApp(false);
  });

  afterEach(() => {
    resetCanvasStore();
    setMobileApp(false);
  });

  it("splits to the right of the pane holding the source chat's tile", () => {
    useEpicCanvasStore
      .getState()
      .seedEpic(EPIC_ID, { tabId: TAB_ID, name: "Epic" }, []);
    useEpicCanvasStore.getState().openTileInTab(TAB_ID, {
      id: SOURCE_CHAT_ID,
      instanceId: "inst-source-chat",
      type: "chat",
      name: "Source chat",
      hostId: HOST_ID,
    });
    const paneId =
      useEpicCanvasStore.getState().canvasByTabId[TAB_ID]?.activePaneId ?? null;
    expect(paneId).not.toBeNull();

    const placement = sideChatPlacementForTile(TAB_ID, SOURCE_CHAT_ID);
    expect(placement).toEqual({
      kind: "split",
      groupId: paneId,
      position: "right",
    });
  });

  it("falls back to active-tile for an unknown tab", () => {
    expect(sideChatPlacementForTile("unknown-tab", SOURCE_CHAT_ID)).toEqual({
      kind: "active-tile",
    });
  });

  it("falls back to active-tile when the chat is not on the canvas", () => {
    useEpicCanvasStore
      .getState()
      .seedEpic(EPIC_ID, { tabId: TAB_ID, name: "Epic" }, []);

    expect(sideChatPlacementForTile(TAB_ID, SOURCE_CHAT_ID)).toEqual({
      kind: "active-tile",
    });
  });

  it("falls back to active-tile on the mobile app regardless of canvas state", () => {
    useEpicCanvasStore
      .getState()
      .seedEpic(EPIC_ID, { tabId: TAB_ID, name: "Epic" }, []);
    useEpicCanvasStore.getState().openTileInTab(TAB_ID, {
      id: SOURCE_CHAT_ID,
      instanceId: "inst-source-chat",
      type: "chat",
      name: "Source chat",
      hostId: HOST_ID,
    });
    setMobileApp(true);

    expect(sideChatPlacementForTile(TAB_ID, SOURCE_CHAT_ID)).toEqual({
      kind: "active-tile",
    });
  });
});
