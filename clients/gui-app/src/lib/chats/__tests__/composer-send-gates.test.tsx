import { act, cleanup, renderHook } from "@testing-library/react";
import type {
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { useChatComposerSubmit } from "@/components/chat/composer/use-chat-composer-submit";
import {
  AGENT_CANT_TAKE_NOTICE,
  AGENT_NO_WORKSPACE_NOTICE,
  AGENT_NOT_READY_NOTICE,
  executePageAct,
  type PageActReads,
} from "@/lib/voice/page-acts";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * One chat, two senders: the composer's Mod-Enter and the voice's "tell it".
 * The composer is a real `useChatComposerSubmit` with its real inputs and the
 * voice is the real page executor over a real chat session store, and the voice
 * reads the composer only through what the hook itself publishes: each case puts
 * the same inputs to both and asks the same question of them. Only the stream
 * client, the wire, is faked.
 */

const HOST_ID = "host-a";
const EPIC_ID = "epic-voice";
const CHAT_ID = "chat-voice";
const USER_ID = "user-me";
const TITLE = "Main agent";
const MESSAGE = "use the other branch";

const SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "model-a",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

interface Session {
  readonly handle: ChatSessionStoreHandle;
  readonly sent: ChatSubscribeClientFrame[];
}

/** A real, idle chat session store, open and able to act, whose wire is recorded. */
function openIdleSession(): Session {
  const sent: ChatSubscribeClientFrame[] = [];
  const wire: { callbacks: ChatStreamCallbacks | null } = { callbacks: null };
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: HOST_ID,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: USER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, callbacks) => {
      wire.callbacks = callbacks;
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
  const { callbacks } = wire;
  if (callbacks === null) throw new Error("the store never opened its stream");
  callbacks.onConnectionStatus("open", null, null, null);
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: USER_ID,
        hostId: HOST_ID,
        title: TITLE,
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        settings: SETTINGS,
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [],
        events: [],
        archivedAt: null,
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
      },
      access: { role: "owner", ownerUserId: USER_ID, canAct: true },
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
  return { handle, sent };
}

function sendFrames(session: Session) {
  return session.sent.flatMap((frame) =>
    frame.kind === "send" ? [frame] : [],
  );
}

const DRAFT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: MESSAGE }] }],
};

/** A composer editor holding {@link DRAFT}: the only thing the submit reads from it. */
const EDITOR: ComposerPromptEditorHandle = {
  isReady: () => true,
  getEditorIncarnation: () => null,
  hasFocus: () => false,
  focus: () => undefined,
  focusAtEnd: () => undefined,
  getJSON: () => DRAFT,
  isEmpty: () => false,
  clear: () => undefined,
  setContent: () => undefined,
  syncContent: () => undefined,
  insertImageAttachments: () => undefined,
  insertMentionAttachment: () => false,
  beginPathInsertion: () => null,
  removeImageAttachmentById: () => undefined,
  rewriteImageAttachmentHashById: () => false,
  insertDictatedText: () => undefined,
  draftGeneration: () => 0,
  dismissActiveSuggestion: () => false,
};

/** The inputs of the composer that decide whether it will send. */
interface Gates {
  readonly sendDisabled: boolean | undefined;
  readonly workspaceBlocked: boolean;
}

const OPEN_GATES: Gates = { sendDisabled: false, workspaceBlocked: false };

interface MountedComposer {
  /** Mod-Enter in the composer; what it handed its owner to send. */
  readonly pressModEnter: () => Promise<ReadonlyArray<ChatComposerSubmitInput>>;
  readonly rerender: (gates: Gates) => void;
  readonly unmount: () => void;
}

/** The chat's composer, mounted with `gates` and a toolbar that has chosen `modelSlug`. */
function mountComposer(gates: Gates, modelSlug: string): MountedComposer {
  const submitted: ChatComposerSubmitInput[] = [];
  const toolbarStore = createComposerToolbarStore({
    purpose: "run",
    reasoningFallback: "model-default",
    seedKey: "composer-send-gates",
    values: {
      ultracode: false,
      permission: "supervised",
      selection: { harnessId: "claude", modelSlug, profileId: null },
      reasoning: "",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    ultracodeCarried: false,
    hostId: HOST_ID,
  });
  const pickerStore = createComposerPickerStore();
  const mounted = renderHook(
    (current: Gates) =>
      useChatComposerSubmit({
        taskId: CHAT_ID,
        editorRef: { current: EDITOR },
        pickerStore,
        toolbarStore,
        activeTurnStatus: null,
        steerCapable: false,
        steerEnabled: useSettingsStore.getState().steerOnModEnterEnabled,
        steerProtocolSupported: true,
        getActiveTurnForSteer: () => null,
        hasPendingApprovals: false,
        sendDisabled: current.sendDisabled,
        sendDisabledHint: null,
        workspaceBlocked: current.workspaceBlocked,
        imagesUnsupported: false,
        attachmentPreparationPending: false,
        onSubmitMessage: (input) => {
          submitted.push(input);
          return true;
        },
        onSideChat: null,
        targetHostId: HOST_ID,
        queueEditTargetId: null,
        getDraftBlobBridgeSupported: () => true,
      }),
    { initialProps: gates },
  );
  return {
    pressModEnter: async () => {
      submitted.length = 0;
      await act(async () => {
        mounted.result.current.submitDraft("mod-enter");
        await Promise.resolve();
      });
      return [...submitted];
    },
    rerender: (next) => mounted.rerender(next),
    unmount: () => mounted.unmount(),
  };
}

function readsOver(session: Session): PageActReads {
  return {
    agentSession: (chatId) =>
      chatId !== null && chatId !== CHAT_ID
        ? null
        : {
            handle: session.handle,
            chatId: CHAT_ID,
            epicId: EPIC_ID,
            hostId: HOST_ID,
            title: TITLE,
          },
    paletteRow: () => null,
  };
}

/** "Tell the agent", as the say loop hands it to the page executor. */
function voiceTells(session: Session) {
  return executePageAct({
    row: {
      action: `agent.tell:${CHAT_ID}`,
      label: "Tell the agent",
      takesWords: true,
      confirm: false,
    },
    text: MESSAGE,
    turnId: null,
    reads: readsOver(session),
  });
}

const initialAuth = useAuthStore.getInitialState();

beforeEach(() => {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: USER_ID, userName: "Me", email: "me@example.com" },
    contextMetadata: { userId: USER_ID, username: "me" },
  });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState(initialAuth, true);
});

describe("a message to the chat, from the composer and by voice", () => {
  it.each([
    {
      name: "the composer cannot send (a disabled profile, a run still preparing, signed out, no access)",
      gates: { ...OPEN_GATES, sendDisabled: true },
      modelSlug: SETTINGS.model,
      say: AGENT_CANT_TAKE_NOTICE,
    },
    {
      name: "the composer's workspace is not ready",
      gates: { ...OPEN_GATES, workspaceBlocked: true },
      modelSlug: SETTINGS.model,
      say: AGENT_NO_WORKSPACE_NOTICE,
    },
    {
      name: "the toolbar has not chosen a model yet",
      gates: OPEN_GATES,
      modelSlug: "",
      say: AGENT_NOT_READY_NOTICE,
    },
  ])(
    "sends nothing from either when $name",
    async ({ gates, modelSlug, say }) => {
      const session = openIdleSession();
      const composer = mountComposer(gates, modelSlug);

      const submitted = await composer.pressModEnter();
      const outcome = await voiceTells(session);

      expect(submitted).toEqual([]);
      expect(outcome).toEqual({ kind: "refused", say });
      expect(sendFrames(session)).toEqual([]);
    },
  );

  it("sends from both when the composer is open, with the settings the composer would send", async () => {
    const session = openIdleSession();
    const composer = mountComposer(OPEN_GATES, SETTINGS.model);

    const submitted = await composer.pressModEnter();
    const outcome = await voiceTells(session);

    expect(submitted).toHaveLength(1);
    expect(outcome).toEqual({ kind: "executed" });
    expect(sendFrames(session)).toHaveLength(1);
    expect(sendFrames(session).at(0)?.settings).toEqual(submitted[0]?.settings);
    expect(sendFrames(session).at(0)?.deliveryPolicy).toBe(
      submitted[0]?.deliveryPolicy,
    );
  });

  it("stops sending by voice when the composer unmounts", async () => {
    const session = openIdleSession();
    const composer = mountComposer(OPEN_GATES, SETTINGS.model);
    expect(await voiceTells(session)).toEqual({ kind: "executed" });

    composer.unmount();
    const outcome = await voiceTells(session);

    expect(outcome).toEqual({ kind: "refused", say: AGENT_CANT_TAKE_NOTICE });
    expect(sendFrames(session)).toHaveLength(1);
  });

  it("follows the composer when it stops being able to send, and when it can again", async () => {
    const session = openIdleSession();
    const composer = mountComposer(OPEN_GATES, SETTINGS.model);

    composer.rerender({ ...OPEN_GATES, sendDisabled: true });
    const whileDisabled = await voiceTells(session);
    const submittedWhileDisabled = await composer.pressModEnter();
    composer.rerender(OPEN_GATES);
    const afterwards = await voiceTells(session);

    expect(whileDisabled).toEqual({
      kind: "refused",
      say: AGENT_CANT_TAKE_NOTICE,
    });
    expect(submittedWhileDisabled).toEqual([]);
    expect(afterwards).toEqual({ kind: "executed" });
    expect(sendFrames(session)).toHaveLength(1);
  });
});
