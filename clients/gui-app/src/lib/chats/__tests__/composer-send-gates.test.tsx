import { act, cleanup, renderHook } from "@testing-library/react";
import type {
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import type {
  WorktreeBinding,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { useChatComposerSubmit } from "@/components/chat/composer/use-chat-composer-submit";
import { TileMinimapContext } from "@/components/epic-canvas/tile-minimap/tile-minimap-context";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useBoundSandboxSend } from "@/hooks/sandboxes/use-bound-sandbox-send";
import type { RestingChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";
import {
  AGENT_ASLEEP_NOTICE,
  AGENT_CANT_TAKE_NOTICE,
  AGENT_NO_WORKSPACE_NOTICE,
  AGENT_NOT_READY_NOTICE,
  NOT_DELIVERED_NOTICE,
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
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";
import {
  useWorktreeIntentStagingStore,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";

const catalogue = vi.hoisted(() => ({
  data: undefined as SandboxCatalogue | undefined,
}));

// The cloud catalogue is the only thing a resting sandbox's send reads from
// outside the app: which agents sandboxes run.
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: catalogue.data }),
}));

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

/** A chat bound to one folder, run in place. */
const BOUND: WorktreeBinding = {
  entries: [
    {
      workspacePath: "/repo",
      mode: "local",
      repoIdentifier: null,
      worktreePath: null,
      branch: null,
      isPrimary: true,
      isImported: false,
      setupState: "not_required",
      setupTerminalSessionId: null,
      setupExitCode: null,
      setupFailedAt: null,
      createdAt: 1,
    },
  ],
};

/** A pick of a new worktree for the folder: a send would commit it as a rebind. */
const NEW_WORKTREE: WorktreeIntent = {
  entries: [
    {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat-voice",
        source: "main",
        carryUncommittedChanges: false,
      },
    },
  ],
};

const STAGING_KEY: WorktreeStagingKey = {
  surface: "owner",
  hostId: HOST_ID,
  epicId: EPIC_ID,
  ownerKind: "chat",
  ownerId: CHAT_ID,
};

/** The sandbox the chat is bound to, resting; the wake is its own `resume`, or `start` when stopped. */
function resting(state: "suspended" | "stopped"): RestingChatSandbox {
  return {
    kind: "resting",
    sandbox: sandboxSummaryFixture({
      id: "sbx-r",
      hostId: HOST_ID,
      displayName: "e2e-sbx-rest",
      state,
    }),
    configuration: { kind: "team", teamId: "team-a", teamName: "Acme" },
    wakeChangesPayer: true,
  };
}

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
      worktreeBinding: BOUND,
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
  readonly imagesUnsupported: boolean;
  readonly attachmentPreparationPending: boolean;
}

const OPEN_GATES: Gates = {
  sendDisabled: false,
  workspaceBlocked: false,
  imagesUnsupported: false,
  attachmentPreparationPending: false,
};

/** The two panes a split shows the one chat in. */
const FRONT = "tile-front";
const OTHER = "tile-other";

interface MountedComposer {
  /** Mod-Enter in the composer; what it handed its owner to send. */
  readonly pressModEnter: () => Promise<ReadonlyArray<ChatComposerSubmitInput>>;
  readonly rerender: (gates: Gates) => void;
  readonly unmount: () => void;
}

/**
 * The chat's composer in the tile `tileInstanceId`, mounted with `gates` and a
 * toolbar that has chosen `modelSlug`; with `null`, in no tile at all.
 */
function mountComposer(
  gates: Gates,
  modelSlug: string,
  tileInstanceId: string | null,
): MountedComposer {
  return mountComposerOver(null, gates, modelSlug, tileInstanceId);
}

/**
 * The same composer over a chat whose sandbox rests when `target` is not
 * `null`: its owner is then the real bound-sandbox send, which holds the
 * message for the wake, and `submitted` still records what it was handed.
 */
function mountComposerOver(
  target: RestingChatSandbox | null,
  gates: Gates,
  modelSlug: string,
  tileInstanceId: string | null,
): MountedComposer {
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
    (current: Gates) => {
      const boundSend = useBoundSandboxSend({
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        target,
      });
      return useChatComposerSubmit({
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
        imagesUnsupported: current.imagesUnsupported,
        attachmentPreparationPending: current.attachmentPreparationPending,
        onSubmitMessage: (input) => {
          submitted.push(input);
          return target === null ? true : boundSend(input);
        },
        onSideChat: null,
        targetHostId: HOST_ID,
        restingSandbox: target,
        queueEditTargetId: null,
        getDraftBlobBridgeSupported: () => true,
      });
    },
    {
      initialProps: gates,
      wrapper: ({ children }: { readonly children: ReactNode }) =>
        tileInstanceId === null ? (
          children
        ) : (
          <TileMinimapContext.Provider value={tileInstanceId}>
            {children}
          </TileMinimapContext.Provider>
        ),
    },
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

/** The page's reads with the chat shown in the tile `tileInstanceId`. */
function readsOver(session: Session, tileInstanceId: string): PageActReads {
  return {
    agentSession: (chatId) =>
      chatId !== null && chatId !== CHAT_ID
        ? null
        : {
            handle: session.handle,
            chatId: CHAT_ID,
            epicId: EPIC_ID,
            hostId: HOST_ID,
            tileInstanceId,
            title: TITLE,
          },
    paletteRow: () => null,
  };
}

/** "Tell the agent" of the chat shown in `tileInstanceId`, as the say loop hands it to the page executor. */
function voiceTells(session: Session, tileInstanceId: string) {
  return voiceTellsRow(session, tileInstanceId, false);
}

/** The same tell after the person said yes to waking the sandbox first. */
function voiceTellsAfterWakeYes(session: Session, tileInstanceId: string) {
  return voiceTellsRow(session, tileInstanceId, true);
}

function voiceTellsRow(
  session: Session,
  tileInstanceId: string,
  readBackAsWake: boolean,
) {
  return executePageAct({
    row: {
      action: `agent.tell:${CHAT_ID}`,
      label: "Tell the agent",
      takesWords: true,
      confirm: readBackAsWake,
    },
    text: MESSAGE,
    turnId: null,
    reads: readsOver(session, tileInstanceId),
  });
}

const initialAuth = useAuthStore.getInitialState();

function resetSandboxStores(): void {
  usePendingSandboxSendStore.setState({ sends: {} });
  useStagedSandboxStore.setState({ bySurface: {} });
  useWorktreeIntentStagingStore.getState().resetForTests();
}

beforeEach(() => {
  catalogue.data = { providers: [], offeredAgents: [SETTINGS.harnessId] };
  resetSandboxStores();
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: USER_ID, userName: "Me", email: "me@example.com" },
    contextMetadata: { userId: USER_ID, username: "me" },
  });
});

afterEach(() => {
  cleanup();
  resetSandboxStores();
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
    {
      name: "the draft holds an image this model cannot take",
      gates: { ...OPEN_GATES, imagesUnsupported: true },
      modelSlug: SETTINGS.model,
      say: AGENT_CANT_TAKE_NOTICE,
    },
    {
      name: "an attachment is still being prepared",
      gates: { ...OPEN_GATES, attachmentPreparationPending: true },
      modelSlug: SETTINGS.model,
      say: AGENT_CANT_TAKE_NOTICE,
    },
  ])(
    "sends nothing from either when $name",
    async ({ gates, modelSlug, say }) => {
      const session = openIdleSession();
      const composer = mountComposer(gates, modelSlug, FRONT);

      const submitted = await composer.pressModEnter();
      const outcome = await voiceTells(session, FRONT);

      expect(submitted).toEqual([]);
      expect(outcome).toEqual({ kind: "refused", say });
      expect(sendFrames(session)).toEqual([]);
    },
  );

  it("sends from both when the composer is open", async () => {
    const session = openIdleSession();
    const composer = mountComposer(OPEN_GATES, SETTINGS.model, FRONT);

    const submitted = await composer.pressModEnter();
    const outcome = await voiceTells(session, FRONT);

    expect(submitted).toHaveLength(1);
    expect(outcome).toEqual({ kind: "executed" });
    expect(sendFrames(session)).toHaveLength(1);
    expect(sendFrames(session).at(0)?.deliveryPolicy).toBe(
      submitted[0]?.deliveryPolicy,
    );
  });

  it("stops sending by voice when the composer unmounts", async () => {
    const session = openIdleSession();
    const composer = mountComposer(OPEN_GATES, SETTINGS.model, FRONT);
    expect(await voiceTells(session, FRONT)).toEqual({ kind: "executed" });

    composer.unmount();
    const outcome = await voiceTells(session, FRONT);

    expect(outcome).toEqual({ kind: "refused", say: AGENT_CANT_TAKE_NOTICE });
    expect(sendFrames(session)).toHaveLength(1);
  });

  it("follows the composer when it stops being able to send, and when it can again", async () => {
    const session = openIdleSession();
    const composer = mountComposer(OPEN_GATES, SETTINGS.model, FRONT);

    composer.rerender({ ...OPEN_GATES, sendDisabled: true });
    const whileDisabled = await voiceTells(session, FRONT);
    const submittedWhileDisabled = await composer.pressModEnter();
    composer.rerender(OPEN_GATES);
    const afterwards = await voiceTells(session, FRONT);

    expect(whileDisabled).toEqual({
      kind: "refused",
      say: AGENT_CANT_TAKE_NOTICE,
    });
    expect(submittedWhileDisabled).toEqual([]);
    expect(afterwards).toEqual({ kind: "executed" });
    expect(sendFrames(session)).toHaveLength(1);
  });

  it("publishes nothing from a composer that is in no tile, so the voice refuses", async () => {
    const session = openIdleSession();
    mountComposer(OPEN_GATES, SETTINGS.model, null);

    const outcome = await voiceTells(session, FRONT);

    expect(outcome).toEqual({ kind: "refused", say: AGENT_CANT_TAKE_NOTICE });
    expect(sendFrames(session)).toEqual([]);
  });
});

describe("a chat shown in two panes", () => {
  /** The two composers, mounted in the order named; the voice is routed to the front pane. */
  const ORDERS = [
    { name: "the front pane mounted first", frontFirst: true },
    { name: "the front pane mounted last", frontFirst: false },
  ];

  interface Panes {
    readonly front: MountedComposer;
    readonly other: MountedComposer;
  }

  function mountPanes(
    front: { readonly gates: Gates; readonly modelSlug: string },
    other: { readonly gates: Gates; readonly modelSlug: string },
    frontFirst: boolean,
  ): Panes {
    const mountFront = () => mountComposer(front.gates, front.modelSlug, FRONT);
    const mountOther = () => mountComposer(other.gates, other.modelSlug, OTHER);
    if (frontFirst) {
      const mountedFront = mountFront();
      return { front: mountedFront, other: mountOther() };
    }
    const mountedOther = mountOther();
    return { front: mountFront(), other: mountedOther };
  }

  it.each(ORDERS)(
    "refuses by voice when the front pane cannot send and the other can, $name",
    async ({ frontFirst }) => {
      const session = openIdleSession();
      const panes = mountPanes(
        {
          gates: { ...OPEN_GATES, sendDisabled: true },
          modelSlug: "front-model",
        },
        { gates: OPEN_GATES, modelSlug: "other-model" },
        frontFirst,
      );

      const submitted = await panes.front.pressModEnter();
      const outcome = await voiceTells(session, FRONT);

      expect(submitted).toEqual([]);
      expect(outcome).toEqual({ kind: "refused", say: AGENT_CANT_TAKE_NOTICE });
      expect(sendFrames(session)).toEqual([]);
    },
  );

  it.each(ORDERS)(
    "sends with the front pane's settings, the ones its own Mod-Enter sends, $name",
    async ({ frontFirst }) => {
      const session = openIdleSession();
      const panes = mountPanes(
        { gates: OPEN_GATES, modelSlug: "front-model" },
        { gates: OPEN_GATES, modelSlug: "other-model" },
        frontFirst,
      );

      const submitted = await panes.front.pressModEnter();
      const outcome = await voiceTells(session, FRONT);

      expect(outcome).toEqual({ kind: "executed" });
      expect(sendFrames(session).at(0)?.settings.model).toBe("front-model");
      expect(sendFrames(session).at(0)?.settings).toEqual(
        submitted[0]?.settings,
      );
    },
  );

  it("is not moved by the other pane's gate changing and republishing", async () => {
    const session = openIdleSession();
    const panes = mountPanes(
      { gates: OPEN_GATES, modelSlug: "front-model" },
      { gates: OPEN_GATES, modelSlug: "other-model" },
      true,
    );

    panes.other.rerender({ ...OPEN_GATES, sendDisabled: true });
    panes.other.rerender(OPEN_GATES);
    const outcome = await voiceTells(session, FRONT);

    expect(outcome).toEqual({ kind: "executed" });
    expect(sendFrames(session).at(0)?.settings.model).toBe("front-model");
  });

  it("refuses by voice when the front pane has no composer, though the other pane does", async () => {
    const session = openIdleSession();
    mountComposer(OPEN_GATES, "other-model", OTHER);

    const outcome = await voiceTells(session, FRONT);

    expect(outcome).toEqual({ kind: "refused", say: AGENT_CANT_TAKE_NOTICE });
    expect(sendFrames(session)).toEqual([]);
  });

  it("keeps sending to the front pane when the other pane unmounts", async () => {
    const session = openIdleSession();
    const panes = mountPanes(
      { gates: OPEN_GATES, modelSlug: "front-model" },
      { gates: OPEN_GATES, modelSlug: "other-model" },
      false,
    );

    panes.other.unmount();
    const outcome = await voiceTells(session, FRONT);

    expect(outcome).toEqual({ kind: "executed" });
    expect(sendFrames(session).at(0)?.settings.model).toBe("front-model");
  });
});

describe("a message to a chat whose sandbox rests", () => {
  function heldSends() {
    return Object.values(usePendingSandboxSendStore.getState().sends);
  }

  function stagedWakes() {
    return Object.values(useStagedSandboxStore.getState().bySurface);
  }

  it.each([
    ["suspended", "resume"],
    ["stopped", "start"],
  ] as const)(
    "holds the message in the pending store and stages the %s sandbox's %s, sending no frame, when the tell was read back as a wake",
    async (state, verb) => {
      const session = openIdleSession();
      mountComposerOver(resting(state), OPEN_GATES, SETTINGS.model, FRONT);

      const outcome = await voiceTellsAfterWakeYes(session, FRONT);

      expect(outcome).toEqual({ kind: "executed" });
      expect(sendFrames(session)).toEqual([]);
      const [held, ...rest] = heldSends();
      expect(rest).toEqual([]);
      expect(held).toMatchObject({
        epicId: EPIC_ID,
        request: { kind: "message", chatId: CHAT_ID },
        text: MESSAGE,
        delivery: null,
      });
      const [stage, ...otherStages] = stagedWakes();
      expect(otherStages).toEqual([]);
      expect(stage?.target).toMatchObject({
        kind: "existing",
        sandboxId: "sbx-r",
        verb,
      });
    },
  );

  it("holds what the same composer's Mod-Enter holds: the same settings and delivery policy", async () => {
    const session = openIdleSession();
    const composer = mountComposerOver(
      resting("suspended"),
      OPEN_GATES,
      "front-model",
      FRONT,
    );
    await voiceTellsAfterWakeYes(session, FRONT);
    const byVoice = heldSends().map((send) => ({
      settings: send.settings,
      deliveryPolicy:
        send.request.kind === "message" ? send.request.deliveryPolicy : null,
    }));
    resetSandboxStores();

    const handed = await composer.pressModEnter();
    const byHand = heldSends().map((send) => ({
      settings: send.settings,
      deliveryPolicy:
        send.request.kind === "message" ? send.request.deliveryPolicy : null,
    }));

    expect(handed).toHaveLength(1);
    expect(byVoice).toHaveLength(1);
    expect(byHand).toEqual(byVoice);
    expect(byVoice[0]?.settings.model).toBe("front-model");
    expect(byVoice[0]?.deliveryPolicy).toBe(handed[0]?.deliveryPolicy);
  });

  it("refuses a tell read back as an ordinary send, holding and staging nothing", async () => {
    const session = openIdleSession();
    mountComposerOver(resting("suspended"), OPEN_GATES, SETTINGS.model, FRONT);

    const outcome = await voiceTells(session, FRONT);

    expect(outcome).toEqual({ kind: "refused", say: AGENT_ASLEEP_NOTICE });
    expect(heldSends()).toEqual([]);
    expect(stagedWakes()).toEqual([]);
    expect(sendFrames(session)).toEqual([]);
  });

  it("says it did not reach the agent, staging nothing, when the catalogue cannot be read", async () => {
    catalogue.data = undefined;
    const session = openIdleSession();
    mountComposerOver(resting("suspended"), OPEN_GATES, SETTINGS.model, FRONT);

    const outcome = await voiceTellsAfterWakeYes(session, FRONT);

    expect(outcome).toEqual({ kind: "refused", say: NOT_DELIVERED_NOTICE });
    expect(heldSends()).toEqual([]);
    expect(stagedWakes()).toEqual([]);
  });

  it("carries a staged change of workspace with the held message, and does not refuse for it", async () => {
    const session = openIdleSession();
    mountComposerOver(resting("suspended"), OPEN_GATES, SETTINGS.model, FRONT);
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, NEW_WORKTREE);

    const outcome = await voiceTellsAfterWakeYes(session, FRONT);

    expect(outcome).toEqual({ kind: "executed" });
    const held = heldSends().at(0);
    expect(
      held?.request.kind === "message" ? held.request.worktreeIntent : null,
    ).toEqual(NEW_WORKTREE);
  });

  it("holds nothing when the composer cannot send, though the tell was read back as a wake", async () => {
    const session = openIdleSession();
    mountComposerOver(
      resting("suspended"),
      { ...OPEN_GATES, sendDisabled: true },
      SETTINGS.model,
      FRONT,
    );

    const outcome = await voiceTellsAfterWakeYes(session, FRONT);

    expect(outcome).toEqual({ kind: "refused", say: AGENT_CANT_TAKE_NOTICE });
    expect(heldSends()).toEqual([]);
    expect(stagedWakes()).toEqual([]);
  });
});
