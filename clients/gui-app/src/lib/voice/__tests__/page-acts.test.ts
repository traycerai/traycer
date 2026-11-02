import type {
  ChatActiveTurn,
  ChatApprovalState,
  ChatFileEditApprovalState,
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  chatApprovalStateSchema,
  chatFileEditApprovalStateSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  WorktreeBinding,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import { publishComposerSendState } from "@/lib/chats/composer-send-gates";
import { composeVoiceDirectory } from "@/lib/voice/directory";
import type { ActionId } from "@/lib/keybindings/actions";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import {
  ACT_FAILED_NOTICE,
  AGENT_GONE_NOTICE,
  AGENT_CANT_TAKE_NOTICE,
  AGENT_NOT_READY_NOTICE,
  AGENT_NO_WORKSPACE_NOTICE,
  AGENT_STOPPING_NOTICE,
  AGENT_WAITING_NOTICE,
  AGENT_WORKSPACE_CHANGE_NOTICE,
  ALREADY_DECIDED_NOTICE,
  APPROVAL_NOT_WAITING_NOTICE,
  DECISION_IN_FLIGHT_NOTICE,
  NOT_DELIVERED_NOTICE,
  NOTHING_TO_STOP_NOTICE,
  OPENER_ASLEEP_NOTICE,
  OPENER_MAY_WAKE_NOTICE,
  ROW_GONE_NOTICE,
  TURN_ENDED_NOTICE,
  executePageAct,
  type PageActReads,
  type VoicePaletteRow,
} from "@/lib/voice/page-acts";
import { resolveRoute, type RouterResult } from "@/lib/voice/router";
import {
  createSayLoop,
  type AskOutcome,
  type SayLoop,
} from "@/lib/voice/say-loop";
import {
  composeVoiceView,
  NO_PALETTE_ITEMS,
  type VoiceView,
  type HostWake,
  type VoiceViewRow,
} from "@/lib/voice/view";
import { wasTileOpenRequested } from "@/lib/canvas/tile-open/tile-open-provenance";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  useVoiceSessionStore,
  type VoiceFocus,
} from "@/stores/voice/voice-session-store";
import {
  useWorktreeIntentStagingStore,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";

/**
 * The executors of the page's actions, run through the real consumers: a real
 * chat session store (only its stream client, the wire, is faked, so the frames
 * the store sends are what is asserted), the real auth, settings, staging and
 * canvas stores, a real query client for the epic's folder listing, the real
 * `runCommandItem` and the real `dispatchAction` behind a registry row. Nothing
 * in `page-acts.ts` is replaced.
 */

const HOST_ID = "host-a";
const EPIC_ID = "epic-voice";
const CHAT_ID = "chat-voice";
const USER_ID = "user-me";
const TITLE = "Main agent";
/** The tile the chat is shown in: the composer publishes under it and the voice reads it. */
const TILE_ID = "tile-voice";

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

const ACTIVE_TURN: ChatActiveTurn = {
  turnId: "turn-1",
  status: "running",
  harnessId: "claude",
  model: "model-a",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
  userMessageId: null,
  startedAt: 1,
  updatedAt: 1,
  sameTurnSteeringSupported: true,
};

/** The turn that starts after {@link ACTIVE_TURN} ended. */
const TURN_B: ChatActiveTurn = { ...ACTIVE_TURN, turnId: "turn-2" };

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

/** A chat that runs in a worktree of its folder. */
const BOUND_TO_WORKTREE: WorktreeBinding = {
  entries: [
    { ...BOUND.entries[0], mode: "worktree", worktreePath: "/repo-wt" },
  ],
};

const STAGING_KEY: WorktreeStagingKey = {
  surface: "owner",
  hostId: HOST_ID,
  epicId: EPIC_ID,
  ownerKind: "chat",
  ownerId: CHAT_ID,
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

function approval(overrides: Partial<ChatApprovalState>): ChatApprovalState {
  return chatApprovalStateSchema.parse({
    approvalId: "ap-1",
    toolName: "bash",
    description: "Run bun install",
    input: null,
    requestedAt: 1,
    kind: "tool",
    planId: null,
    actions: [],
    reason: null,
    reviewing: null,
    ...overrides,
  });
}

function fileEditApproval(): ChatFileEditApprovalState {
  return chatFileEditApprovalStateSchema.parse({
    approvalId: "fe-1",
    toolName: "edit",
    description: "Edit a file",
    paths: ["/repo/a.ts"],
    operation: "edit",
    input: null,
    requestedAt: 1,
  });
}

interface SnapshotShape {
  readonly running: boolean;
  readonly settings: ChatRunSettings | null;
  readonly binding: WorktreeBinding | null;
  readonly missingWorktreePaths: ReadonlyArray<string>;
  readonly approvals: ReadonlyArray<ChatApprovalState>;
  readonly fileEditApprovals: ReadonlyArray<ChatFileEditApprovalState>;
  readonly canAct: boolean;
}

const READY_TO_SEND: SnapshotShape = {
  running: false,
  settings: SETTINGS,
  binding: BOUND,
  missingWorktreePaths: [],
  approvals: [],
  fileEditApprovals: [],
  canAct: true,
};

interface Session {
  readonly handle: ChatSessionStoreHandle;
  readonly sent: ChatSubscribeClientFrame[];
  readonly callbacks: ChatStreamCallbacks;
  /** The host's snapshot of the chat, with `turn` as the turn it is running (or none). */
  readonly snapshot: (turn: ChatActiveTurn | null) => void;
}

/**
 * A real chat session store whose stream client records what the store puts on
 * the wire, opened onto a snapshot of `shape`.
 */
function openSession(shape: SnapshotShape): Session {
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
  const snapshot = (turn: ChatActiveTurn | null): void =>
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
          settings: shape.settings,
          activeSessionChain: null,
          claudePendingWakes: [],
          messages: [],
          events: [],
          archivedAt: null,
          pinnedUserProviderHandle: null,
          lastDeliveredRolesDigest: null,
        },
        access: { role: "owner", ownerUserId: USER_ID, canAct: shape.canAct },
        queue: { status: "idle", items: [] },
        runStatus: turn === null ? "idle" : "running",
        activeTurn: turn,
        pendingApprovals: [...shape.approvals],
        pendingInterviews: [],
        worktreeBinding: shape.binding,
        missingWorktreePaths: [...shape.missingWorktreePaths],
        pendingFileEditApprovals: [...shape.fileEditApprovals],
        accumulatedFileChanges: [],
        managedCommands: [],
        heldUpdates: [],
        portForwards: [],
      },
    });
  snapshot(shape.running ? ACTIVE_TURN : null);
  return { handle, sent, callbacks, snapshot };
}

/** The host reports the chat's turn: `turn` is running, or none is. */
function moveToTurn(session: Session, turn: ChatActiveTurn | null): void {
  session.callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: turn === null ? "idle" : "running",
    activeTurn: turn,
    turnInProgress: turn !== null,
  });
}

function sendFrames(session: Session) {
  return session.sent.flatMap((frame) =>
    frame.kind === "send" ? [frame] : [],
  );
}

function stopFrames(session: Session) {
  return session.sent.flatMap((frame) =>
    frame.kind === "stop" ? [frame] : [],
  );
}

function decisionFrames(session: Session) {
  return session.sent.flatMap((frame) =>
    frame.kind === "approvalDecision" ? [frame] : [],
  );
}

const KEYBINDING_ROUTER: KeybindingRouter = {
  getPathname: () => "/",
  navigateHome: () => undefined,
  navigateSettings: () => undefined,
  navigateToEpic: () => undefined,
  navigateToEpicTab: () => undefined,
  navigateToEpicList: () => undefined,
  navigateSettingsSection: () => undefined,
  navigateToTabIntent: () => undefined,
  goBack: () => undefined,
  goForward: () => undefined,
  isHistoryNavAvailable: () => false,
  canGoBack: () => false,
  canGoForward: () => false,
};

function context(overrides: Partial<CommandContext>): CommandContext {
  return {
    pathname: "/",
    router: KEYBINDING_ROUTER,
    activeTabId: null,
    activeEpicId: null,
    focusedComposerKind: null,
    targetGroupId: null,
    ...overrides,
  };
}

function commandItem(
  id: string,
  run: CommandItem["run"],
  actionId: ActionId | null,
): CommandItem {
  return {
    id,
    label: id,
    description: null,
    keywords: [],
    group: "actions",
    scope: "actions",
    shortcut: null,
    actionId,
    run,
    subpage: null,
  };
}

function rowFor(action: string): VoiceViewRow {
  return { action, label: action, takesWords: false, confirm: false };
}

/** What the page offers: the chat in front, and the palette rows by their ids. */
function readsOver(
  session: Session | null,
  rows: ReadonlyArray<VoicePaletteRow>,
): PageActReads {
  return {
    agentSession: (chatId) =>
      session === null || (chatId !== null && chatId !== CHAT_ID)
        ? null
        : {
            handle: session.handle,
            chatId: CHAT_ID,
            epicId: EPIC_ID,
            hostId: HOST_ID,
            tileInstanceId: TILE_ID,
            title: TITLE,
          },
    paletteRow: (action) => rows.find((row) => row.item.id === action) ?? null,
  };
}

function run(action: string, text: string, reads: PageActReads) {
  return executePageAct({
    row: rowFor(action),
    text,
    turnId: null,
    reads,
  });
}

/** The stop row, as a route made while `routedTurnId` was the agent's turn. */
function stop(session: Session, routedTurnId: string | null) {
  return executePageAct({
    row: rowFor(`agent.stop:${CHAT_ID}`),
    text: "",
    turnId: routedTurnId,
    reads: readsOver(session, []),
  });
}

function tell(session: Session, text: string) {
  return run(`agent.tell:${CHAT_ID}`, text, readsOver(session, []));
}

/** What the chat's mounted composer tells the voice, as `useChatComposerSubmit` publishes it. */
interface PublishedComposer {
  readonly sendDisabled: boolean | undefined;
  readonly workspaceBlocked: boolean;
  readonly imagesUnsupported: boolean;
  readonly attachmentPreparationPending: boolean;
  readonly modelSlug: string;
  readonly settings: ChatRunSettings;
}

const OPEN_COMPOSER: PublishedComposer = {
  sendDisabled: false,
  workspaceBlocked: false,
  imagesUnsupported: false,
  attachmentPreparationPending: false,
  modelSlug: SETTINGS.model,
  settings: SETTINGS,
};

let retractComposer: () => void = () => undefined;

/** The chat's composer as `composer` says, in place of the one before; every test starts with {@link OPEN_COMPOSER}. */
function composerIs(composer: PublishedComposer): void {
  retractComposer();
  retractComposer = publishComposerSendState(HOST_ID, CHAT_ID, TILE_ID, {
    sendDisabled: composer.sendDisabled,
    workspaceBlocked: composer.workspaceBlocked,
    imagesUnsupported: composer.imagesUnsupported,
    attachmentPreparationPending: composer.attachmentPreparationPending,
    restingSandbox: false,
    sandboxFrozen: false,
    submit: () => false,
    modelSlug: () => composer.modelSlug,
    runSettings: () => composer.settings,
  });
}

function refusedWith(say: string) {
  return { kind: "refused", say };
}

const initialSettings = useSettingsStore.getInitialState();
const initialAuth = useAuthStore.getInitialState();

beforeEach(() => {
  window.localStorage.clear();
  composerIs(OPEN_COMPOSER);
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: USER_ID, userName: "Me", email: "me@example.com" },
    contextMetadata: { userId: USER_ID, username: "me" },
  });
  useSettingsStore.setState(initialSettings, true);
  useWorktreeIntentStagingStore.getState().resetForTests();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

afterEach(() => {
  retractComposer();
  useAuthStore.setState(initialAuth, true);
  useWorktreeIntentStagingStore.getState().resetForTests();
});

describe("telling the agent", () => {
  it("steers a running turn", async () => {
    const session = openSession({ ...READY_TO_SEND, running: true });

    const outcome = await tell(session, "use the other branch");

    expect(outcome).toEqual({ kind: "executed" });
    expect(sendFrames(session)).toHaveLength(1);
    expect(sendFrames(session).at(0)?.deliveryPolicy).toBe("after_safe_point");
  });

  it("reads the turn when it runs, not when the reads were built", async () => {
    const session = openSession({ ...READY_TO_SEND, running: true });
    const reads = readsOver(session, []);

    session.handle.store.setState({ runStatus: "idle", activeTurn: null });
    await run(`agent.tell:${CHAT_ID}`, "and then", reads);

    expect(sendFrames(session).at(0)?.deliveryPolicy).toBe("auto");
  });

  it.each([
    {
      name: "the person turned steering off",
      arrange: () => {
        useSettingsStore.setState({ steerOnModEnterEnabled: false });
      },
    },
    {
      name: "the host's protocol cannot steer",
      arrange: (session: Session) => {
        session.handle.store.setState({ steerProtocolSupported: false });
      },
    },
  ])("queues behind a running turn when $name", async ({ arrange }) => {
    const session = openSession({ ...READY_TO_SEND, running: true });
    arrange(session);

    await tell(session, "after that");

    expect(sendFrames(session).at(0)?.deliveryPolicy).toBe("auto");
  });

  it.each([
    { name: "model", settings: { ...SETTINGS, model: "model-b" } },
    { name: "harness", settings: { ...SETTINGS, harnessId: "codex" } },
  ] as const)(
    "queues instead of restarting the turn when the composer's $name differs from it",
    async ({ settings }) => {
      const session = openSession({ ...READY_TO_SEND, running: true });
      composerIs({ ...OPEN_COMPOSER, settings });

      await tell(session, "switch to this one");

      expect(sendFrames(session).at(0)?.deliveryPolicy).toBe("auto");
    },
  );

  it("sends with the settings the composer holds now, not the chat's own", async () => {
    const session = openSession(READY_TO_SEND);
    const settings: ChatRunSettings = {
      ...SETTINGS,
      model: "model-b",
      permissionMode: "auto",
    };
    composerIs({ ...OPEN_COMPOSER, settings });

    await tell(session, "hello");

    expect(sendFrames(session).at(0)?.settings).toEqual(settings);
  });

  it("sends the span as the message, from the signed-in person, with no attachments", async () => {
    const session = openSession(READY_TO_SEND);

    await tell(session, "please run the tests");

    const frame = sendFrames(session).at(0);
    expect(
      frame === undefined
        ? null
        : extractPlainTextFromComposerJSONContent(frame.content),
    ).toBe("please run the tests");
    expect(frame?.sender).toEqual({ type: "user", userId: USER_ID });
    expect(frame?.browserAnnotations).toEqual([]);
  });

  it("is told the agent is gone when the chat in front is another one", async () => {
    const session = openSession(READY_TO_SEND);

    const outcome = await run(
      "agent.tell:chat-elsewhere",
      "hello",
      readsOver(session, []),
    );

    expect(outcome).toEqual(refusedWith(AGENT_GONE_NOTICE));
    expect(sendFrames(session)).toEqual([]);
  });
});

describe("what stops a message to the agent", () => {
  /** Each is the composer's own blocker, said as a refusal; nothing is sent. */
  const BLOCKERS: ReadonlyArray<{
    readonly name: string;
    readonly say: string;
    readonly open: () => Session;
    readonly arrange: ((session: Session) => void) | null;
  }> = [
    {
      name: "an approval a person can answer",
      say: AGENT_WAITING_NOTICE,
      open: () =>
        openSession({
          ...READY_TO_SEND,
          running: true,
          approvals: [approval({})],
        }),
      arrange: null,
    },
    {
      name: "a file edit waiting on an approval",
      say: AGENT_WAITING_NOTICE,
      open: () =>
        openSession({
          ...READY_TO_SEND,
          running: true,
          fileEditApprovals: [fileEditApproval()],
        }),
      arrange: null,
    },
    {
      name: "a turn that is stopping",
      say: AGENT_STOPPING_NOTICE,
      open: () => openSession({ ...READY_TO_SEND, running: true }),
      arrange: (session) => {
        session.handle.store.setState({ runStatus: "stopping" });
      },
    },
    {
      name: "a stop that has gone out",
      say: AGENT_STOPPING_NOTICE,
      open: () => openSession({ ...READY_TO_SEND, running: true }),
      arrange: (session) => {
        session.handle.store.getState().stopTurn();
      },
    },
    {
      name: "a composer that cannot send",
      say: AGENT_CANT_TAKE_NOTICE,
      open: () => openSession(READY_TO_SEND),
      arrange: () => {
        composerIs({ ...OPEN_COMPOSER, sendDisabled: true });
      },
    },
    {
      name: "a composer whose workspace is not ready",
      say: AGENT_NO_WORKSPACE_NOTICE,
      open: () => openSession(READY_TO_SEND),
      arrange: () => {
        composerIs({ ...OPEN_COMPOSER, workspaceBlocked: true });
      },
    },
    {
      name: "a new worktree staged for the folder",
      say: AGENT_WORKSPACE_CHANGE_NOTICE,
      open: () => openSession(READY_TO_SEND),
      arrange: () => {
        useWorktreeIntentStagingStore
          .getState()
          .setIntent(STAGING_KEY, NEW_WORKTREE);
      },
    },
    {
      name: "a composer whose model is not chosen yet",
      say: AGENT_NOT_READY_NOTICE,
      open: () => openSession(READY_TO_SEND),
      arrange: () => {
        composerIs({ ...OPEN_COMPOSER, modelSlug: "" });
      },
    },
  ];

  it.each(BLOCKERS)("refuses for $name and sends nothing", async (blocker) => {
    const session = blocker.open();
    blocker.arrange?.(session);

    const outcome = await tell(session, "hello");

    expect(outcome).toEqual(refusedWith(blocker.say));
    expect(sendFrames(session)).toEqual([]);
  });

  it("refuses when no composer is mounted for the chat, though the chat itself can act", async () => {
    const session = openSession(READY_TO_SEND);
    retractComposer();

    const outcome = await tell(session, "hello");

    expect(outcome).toEqual(refusedWith(AGENT_CANT_TAKE_NOTICE));
    expect(sendFrames(session)).toEqual([]);
  });

  it("refuses when the person is signed out, though the composer is open", async () => {
    const session = openSession(READY_TO_SEND);
    useAuthStore.setState({ profile: null });

    const outcome = await tell(session, "hello");

    expect(outcome).toEqual(refusedWith(AGENT_NOT_READY_NOTICE));
    expect(sendFrames(session)).toEqual([]);
  });

  it("is not stopped by an approval a judge is still deciding", async () => {
    const session = openSession({
      ...READY_TO_SEND,
      running: true,
      approvals: [approval({ reviewing: "checking" })],
    });

    const outcome = await tell(session, "hello");

    expect(outcome).toEqual({ kind: "executed" });
    expect(sendFrames(session)).toHaveLength(1);
  });

  it("says it did not reach the agent when the store declines to send", async () => {
    // A staged pick of the folder's current worktree, whose folder cannot be
    // resolved: no rebind to disclose, and the store refuses the send.
    const session = openSession({
      ...READY_TO_SEND,
      binding: BOUND_TO_WORKTREE,
    });
    const staging = useWorktreeIntentStagingStore.getState();
    staging.setIntent(STAGING_KEY, {
      entries: [
        {
          kind: "import",
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          worktreePath: "/repo-wt",
        },
      ],
    });
    staging.setSuspendedWorkspacePaths(STAGING_KEY, ["/repo"]);

    const outcome = await tell(session, "hello");

    expect(outcome).toEqual(refusedWith(NOT_DELIVERED_NOTICE));
    expect(sendFrames(session)).toEqual([]);
  });
});

describe("stopping the agent", () => {
  it("stops the running turn it was asked of", async () => {
    const session = openSession({ ...READY_TO_SEND, running: true });

    const outcome = await stop(session, ACTIVE_TURN.turnId);

    expect(outcome).toEqual({ kind: "executed" });
    expect(stopFrames(session)).toHaveLength(1);
  });

  it("says nothing was running to stop, and does not stop the turn running now, when none was on the wire at the route", async () => {
    const session = openSession({ ...READY_TO_SEND, running: true });

    const outcome = await stop(session, null);

    expect(outcome).toEqual(refusedWith(NOTHING_TO_STOP_NOTICE));
    expect(stopFrames(session)).toEqual([]);
  });

  it("says the turn already ended, and does not stop", async () => {
    const session = openSession(READY_TO_SEND);

    const outcome = await stop(session, ACTIVE_TURN.turnId);

    expect(outcome).toEqual(refusedWith(TURN_ENDED_NOTICE));
    expect(stopFrames(session)).toEqual([]);
  });

  it("says the turn ended when the one running began after it ended, and does not stop it", async () => {
    const session = openSession({ ...READY_TO_SEND, running: true });
    moveToTurn(session, null);
    moveToTurn(session, TURN_B);

    const outcome = await stop(session, ACTIVE_TURN.turnId);

    expect(outcome).toEqual(refusedWith(TURN_ENDED_NOTICE));
    expect(stopFrames(session)).toEqual([]);
  });

  it("does not stop a turn that is already stopping a second time", async () => {
    const session = openSession({ ...READY_TO_SEND, running: true });
    session.handle.store.getState().stopTurn();

    const outcome = await stop(session, ACTIVE_TURN.turnId);

    expect(outcome).toEqual(refusedWith(AGENT_STOPPING_NOTICE));
    expect(stopFrames(session)).toHaveLength(1);
  });

  it("says it did not reach the agent while the connection is down", async () => {
    const session = openSession({ ...READY_TO_SEND, running: true });
    session.callbacks.onConnectionStatus("reconnecting", null, null, null);

    const outcome = await stop(session, ACTIVE_TURN.turnId);

    expect(outcome).toEqual(refusedWith(NOT_DELIVERED_NOTICE));
    expect(stopFrames(session)).toEqual([]);
  });
});

/**
 * A spoken "stop the agent", from the request to the yes, through the real say
 * loop and the real page act: the read-back can outlast the turn it was asked of.
 */
describe("a spoken stop that waits for its yes", () => {
  const FOCUS: VoiceFocus = {
    botId: "bot_tracy",
    hostId: HOST_ID,
    threadId: null,
    anchorMessageId: null,
    anchorThread: null,
  };
  const initialVoice = useVoiceSessionStore.getInitialState();

  beforeEach(() => {
    useVoiceSessionStore.setState(initialVoice, true);
    useVoiceSessionStore.getState().setFocus(FOCUS);
  });

  afterEach(() => {
    useVoiceSessionStore.setState(initialVoice, true);
  });

  const STOP_ACTION = `agent.stop:${CHAT_ID}`;

  /** The page in front while turn-1 runs. */
  const VIEW: VoiceView = composeVoiceView({
    page: { kind: "task", title: "Tracy Bots", tile: TITLE },
    agent: {
      chatId: CHAT_ID,
      title: TITLE,
      state: "working",
      waitingOn: null,
      turnId: ACTIVE_TURN.turnId,
    },
    agentAsleep: false,
    agentTurnRunning: true,
    approvals: [],
    palette: NO_PALETTE_ITEMS,
    generation: 1,
  });

  const DIRECTORY = composeVoiceDirectory({
    environments: [],
    bots: [],
    threadsByBot: new Map(),
    followedThreads: new Set(),
    viewerUserId: USER_ID,
    focus: FOCUS,
    queue: [],
    hostOf: () => null,
    heldPostText: () => null,
  });

  /** What the model chose for the stop row, over the one segment said. */
  const STOP_ROUTE: RouterResult = {
    action: "act",
    target: {
      environmentId: null,
      botId: null,
      threadId: null,
      itemId: null,
      actionId: STOP_ACTION,
      agentId: null,
    },
    span: { fromSegment: 0, toSegment: 0 },
    uncertain: false,
    question: null,
    control: null,
    choice: null,
  };

  interface SpokenStop {
    readonly loop: SayLoop;
    readonly notices: Array<{ text: string; delegationId: string | null }>;
    readonly asks: AskOutcome[];
  }

  function buildLoop(session: Session): SpokenStop {
    const notices: SpokenStop["notices"] = [];
    const asks: AskOutcome[] = [];
    const loop = createSayLoop({
      store: useVoiceSessionStore,
      send: () => {
        throw new Error("a stop posts nothing");
      },
      notify: (text, delegationId) => {
        notices.push({ text, delegationId });
      },
      ask: (_text, _delegationId, outcome) => {
        asks.push(outcome);
        return () => undefined;
      },
      decide: (request) =>
        Promise.resolve({
          decision: resolveRoute(
            STOP_ROUTE,
            DIRECTORY,
            VIEW,
            request.segments.length,
          ),
          seen: null,
        }),
      recheck: () => true,
      navigate: () => Promise.resolve(true),
      think: () => undefined,
      control: () => undefined,
      canSend: () => true,
      schedule: () => () => undefined,
      openThread: () => undefined,
      botTitle: (botId) => botId,
      onAccepted: () => undefined,
      view: () => VIEW,
      act: (row, text, turnId) =>
        executePageAct({
          row,
          text,
          turnId,
          reads: readsOver(session, []),
        }),
    });
    return { loop, notices, asks };
  }

  /** Says the request and lets the question be heard. */
  async function askToStop(h: SpokenStop) {
    useVoiceSessionStore.getState().appendInputSegment("stop the agent", 0);
    await h.loop.onDelegationCreated("d-1");
    h.asks[0]?.onDelivered();
  }

  async function sayYes(h: SpokenStop) {
    useVoiceSessionStore.getState().appendInputSegment("yes", 400);
    await h.loop.onDelegationCreated("d-2");
  }

  it("stops the turn it asked about on a yes", async () => {
    const session = openSession({ ...READY_TO_SEND, running: true });
    const h = buildLoop(session);
    await askToStop(h);
    expect(h.asks).toHaveLength(1);

    await sayYes(h);

    expect(stopFrames(session)).toMatchObject([{ turnId: "turn-1" }]);
    expect(h.notices).toEqual([]);
  });

  it("stops the turn the host renamed in place while the question waited", async () => {
    const session = openSession({ ...READY_TO_SEND, running: true });
    const h = buildLoop(session);
    await askToStop(h);
    moveToTurn(session, TURN_B);

    await sayYes(h);

    expect(stopFrames(session)).toMatchObject([{ turnId: "turn-2" }]);
    expect(h.notices).toEqual([]);
  });

  it("stops the turn renamed twice while the question waited", async () => {
    const session = openSession({ ...READY_TO_SEND, running: true });
    const h = buildLoop(session);
    await askToStop(h);
    moveToTurn(session, TURN_B);
    moveToTurn(session, { ...ACTIVE_TURN, turnId: "turn-3" });

    await sayYes(h);

    expect(stopFrames(session)).toMatchObject([{ turnId: "turn-3" }]);
    expect(h.notices).toEqual([]);
  });

  it("stops the turn renamed away and back while the question waited", async () => {
    const session = openSession({ ...READY_TO_SEND, running: true });
    const h = buildLoop(session);
    await askToStop(h);
    moveToTurn(session, TURN_B);
    moveToTurn(session, ACTIVE_TURN);

    await sayYes(h);

    expect(stopFrames(session)).toMatchObject([{ turnId: "turn-1" }]);
    expect(h.notices).toEqual([]);
  });

  describe("when a live frame replaces the turn with another execution", () => {
    it.each([
      { name: "started at another time", other: { startedAt: 2 } },
      { name: "answers another message", other: { userMessageId: "m-2" } },
    ])(
      "does not stop a turn that $name, though no frame between named that the turn ended",
      async ({ other }) => {
        const session = openSession({ ...READY_TO_SEND, running: true });
        const h = buildLoop(session);
        await askToStop(h);
        moveToTurn(session, { ...TURN_B, ...other });

        await sayYes(h);

        expect(stopFrames(session)).toEqual([]);
        expect(h.notices).toEqual([
          { text: TURN_ENDED_NOTICE, delegationId: "d-1" },
        ]);
      },
    );

    it("forgets a rename the live frames made once another execution takes over under the renamed turn's id", async () => {
      const session = openSession({ ...READY_TO_SEND, running: true });
      const h = buildLoop(session);
      await askToStop(h);
      moveToTurn(session, TURN_B);
      moveToTurn(session, { ...TURN_B, startedAt: 2 });

      await sayYes(h);

      expect(stopFrames(session)).toEqual([]);
      expect(h.notices).toEqual([
        { text: TURN_ENDED_NOTICE, delegationId: "d-1" },
      ]);
    });
  });

  describe("across a reconnect", () => {
    /** The stream drops and returns, and the host's snapshot names `turn`. */
    function reconnectOnto(session: Session, turn: ChatActiveTurn | null) {
      session.callbacks.onConnectionStatus("reconnecting", null, null, null);
      session.callbacks.onConnectionStatus("open", null, null, null);
      session.snapshot(turn);
    }

    it("stops the same execution that came back under a new id", async () => {
      const session = openSession({ ...READY_TO_SEND, running: true });
      const h = buildLoop(session);
      await askToStop(h);
      reconnectOnto(session, {
        ...ACTIVE_TURN,
        turnId: "provider-id",
        updatedAt: 2,
      });

      await sayYes(h);

      expect(stopFrames(session)).toMatchObject([{ turnId: "provider-id" }]);
      expect(h.notices).toEqual([]);
    });

    it.each([
      { name: "started at another time", other: { startedAt: 2 } },
      { name: "answers another message", other: { userMessageId: "m-2" } },
    ])(
      "does not stop a turn that $name, though it came back under a new id",
      async ({ other }) => {
        const session = openSession({ ...READY_TO_SEND, running: true });
        const h = buildLoop(session);
        await askToStop(h);
        reconnectOnto(session, {
          ...ACTIVE_TURN,
          turnId: "provider-id",
          ...other,
        });

        await sayYes(h);

        expect(stopFrames(session)).toEqual([]);
        expect(h.notices).toEqual([
          { text: TURN_ENDED_NOTICE, delegationId: "d-1" },
        ]);
      },
    );

    it("keeps a rename the live frames made when the snapshot still names that turn", async () => {
      const session = openSession({ ...READY_TO_SEND, running: true });
      const h = buildLoop(session);
      await askToStop(h);
      moveToTurn(session, TURN_B);
      reconnectOnto(session, TURN_B);

      await sayYes(h);

      expect(stopFrames(session)).toMatchObject([{ turnId: "turn-2" }]);
      expect(h.notices).toEqual([]);
    });

    it("forgets a rename once a snapshot says no turn was running, so a later turn of that id is not the one asked about", async () => {
      const session = openSession({ ...READY_TO_SEND, running: true });
      const h = buildLoop(session);
      await askToStop(h);
      moveToTurn(session, TURN_B);
      reconnectOnto(session, null);
      moveToTurn(session, TURN_B);

      await sayYes(h);

      expect(stopFrames(session)).toEqual([]);
      expect(h.notices).toEqual([
        { text: TURN_ENDED_NOTICE, delegationId: "d-1" },
      ]);
    });

    it("forgets a rename once a snapshot names another execution, so a later turn of the renamed id is not the one asked about", async () => {
      const session = openSession({ ...READY_TO_SEND, running: true });
      const h = buildLoop(session);
      await askToStop(h);
      moveToTurn(session, TURN_B);
      reconnectOnto(session, {
        ...ACTIVE_TURN,
        turnId: "turn-3",
        startedAt: 2,
      });
      moveToTurn(session, TURN_B);

      await sayYes(h);

      expect(stopFrames(session)).toEqual([]);
      expect(h.notices).toEqual([
        { text: TURN_ENDED_NOTICE, delegationId: "d-1" },
      ]);
    });

    it("forgets a rename once the connection closes, so a later turn of that id is not the one asked about", async () => {
      const session = openSession({ ...READY_TO_SEND, running: true });
      const h = buildLoop(session);
      await askToStop(h);
      moveToTurn(session, TURN_B);
      session.callbacks.onConnectionStatus("closed", null, null, null);
      session.callbacks.onConnectionStatus("open", null, null, null);
      moveToTurn(session, TURN_B);

      await sayYes(h);

      expect(stopFrames(session)).toEqual([]);
      expect(h.notices).toEqual([
        { text: TURN_ENDED_NOTICE, delegationId: "d-1" },
      ]);
    });
  });

  it("does not stop the next turn when the one it asked about ended while the question waited", async () => {
    const session = openSession({ ...READY_TO_SEND, running: true });
    const h = buildLoop(session);
    await askToStop(h);
    moveToTurn(session, null);
    moveToTurn(session, TURN_B);

    await sayYes(h);

    expect(stopFrames(session)).toEqual([]);
    expect(h.notices).toEqual([
      { text: TURN_ENDED_NOTICE, delegationId: "d-1" },
    ]);
  });
});

describe("deciding an approval", () => {
  function waitingOn(...approvals: ChatApprovalState[]): Session {
    return openSession({ ...READY_TO_SEND, running: true, approvals });
  }

  it.each([
    { verb: "approve", approved: true },
    { verb: "decline", approved: false },
  ])(
    "$verb sends the decision for that approval",
    async ({ verb, approved }) => {
      const session = waitingOn(approval({}), approval({ approvalId: "ap-2" }));

      const outcome = await run(
        `approval.${verb}:ap-2`,
        "",
        readsOver(session, []),
      );

      expect(outcome).toEqual({ kind: "executed" });
      expect(decisionFrames(session)).toHaveLength(1);
      expect(decisionFrames(session).at(0)).toMatchObject({
        approvalId: "ap-2",
        decision: { approved },
      });
    },
  );

  it("says it was already decided when the approval is gone from the list, and decides nothing", async () => {
    const session = waitingOn();

    const outcome = await run(
      "approval.approve:ap-1",
      "",
      readsOver(session, []),
    );

    expect(outcome).toEqual(refusedWith(ALREADY_DECIDED_NOTICE));
    expect(decisionFrames(session)).toEqual([]);
  });

  it("says it isn't waiting on the person when a judge took the approval after the question, and decides nothing", async () => {
    const session = waitingOn(approval({}));
    session.handle.store.setState({
      pendingApprovals: [approval({ reviewing: "checking" })],
    });

    const outcome = await run(
      "approval.approve:ap-1",
      "",
      readsOver(session, []),
    );

    expect(outcome).toEqual(refusedWith(APPROVAL_NOT_WAITING_NOTICE));
    expect(decisionFrames(session)).toEqual([]);
  });

  it("waits for a decision that is still going through rather than sending a second", async () => {
    const session = waitingOn(approval({}), approval({ approvalId: "ap-2" }));
    session.handle.store
      .getState()
      .approvalDecision("ap-2", { approved: true });

    const outcome = await run(
      "approval.decline:ap-1",
      "",
      readsOver(session, []),
    );

    expect(outcome).toEqual(refusedWith(DECISION_IN_FLIGHT_NOTICE));
    expect(decisionFrames(session)).toHaveLength(1);
  });

  it("says it did not reach the agent while the connection is down", async () => {
    const session = waitingOn(approval({}));
    session.callbacks.onConnectionStatus("reconnecting", null, null, null);

    const outcome = await run(
      "approval.approve:ap-1",
      "",
      readsOver(session, []),
    );

    expect(outcome).toEqual(refusedWith(NOT_DELIVERED_NOTICE));
    expect(decisionFrames(session)).toEqual([]);
  });
});

describe("a row of the palette", () => {
  it("runs through the palette's own runner with the context it was composed for", async () => {
    const itemRun = vi.fn<CommandItem["run"]>();
    const ctx = context({ pathname: "/composed-for" });
    const item = commandItem("nav:somewhere", itemRun, null);

    const outcome = await run(
      item.id,
      "",
      readsOver(null, [{ item, ctx, hostWake: "none" }]),
    );

    expect(outcome).toEqual({ kind: "executed" });
    expect(itemRun).toHaveBeenCalledTimes(1);
    expect(itemRun.mock.calls.at(0)?.[0]).toBe(ctx);
  });

  it("goes through the action dispatcher when the row names an action", async () => {
    const itemRun = vi.fn<CommandItem["run"]>();
    const navigateToEpicList = vi.fn<() => void>();
    const ctx = context({
      router: { ...KEYBINDING_ROUTER, navigateToEpicList },
    });
    const item = commandItem(
      "action:app.history.open",
      itemRun,
      "app.history.open",
    );

    const outcome = await run(
      item.id,
      "",
      readsOver(null, [{ item, ctx, hostWake: "none" }]),
    );

    expect(outcome).toEqual({ kind: "executed" });
    expect(navigateToEpicList).toHaveBeenCalledTimes(1);
    expect(itemRun).not.toHaveBeenCalled();
  });

  it("says it is not available when the page no longer offers the row", async () => {
    const outcome = await run(
      "action:app.history.open",
      "",
      readsOver(null, []),
    );

    expect(outcome).toEqual(refusedWith(ROW_GONE_NOTICE));
  });

  it("settles as a refusal when the row's own run throws", async () => {
    const item = commandItem(
      "nav:broken",
      () => {
        throw new Error("the row failed");
      },
      null,
    );

    const outcome = await run(
      item.id,
      "",
      readsOver(null, [{ item, ctx: context({}), hostWake: "none" }]),
    );

    expect(outcome).toEqual(refusedWith(ACT_FAILED_NOTICE));
  });

  describe("that opens a tile", () => {
    const CHAT_TILE: EpicNodeRef = {
      id: CHAT_ID,
      instanceId: "inst-chat",
      type: "chat",
      name: TITLE,
      hostId: HOST_ID,
    };
    const SPEC_TILE: EpicNodeRef = {
      id: "spec-1",
      instanceId: "inst-spec",
      type: "spec",
      name: "Plan",
      hostId: HOST_ID,
    };

    /** A task whose canvas holds a spec, the chat when asked, and the spec on top. */
    function taskCanvas(withChat: boolean) {
      return canvasHolding(withChat ? CHAT_TILE : null);
    }

    function canvasHolding(chat: EpicNodeRef | null) {
      const canvas = useEpicCanvasStore.getState();
      const tabId = canvas.openEpicTab(EPIC_ID, "Task");
      if (chat !== null) canvas.openTileInTab(tabId, chat);
      canvas.openTileInTab(tabId, SPEC_TILE);
      const state = useEpicCanvasStore.getState().canvasByTabId[tabId];
      if (state === undefined || state.activePaneId === null) {
        throw new Error("the canvas never opened a pane");
      }
      return { tabId, paneId: state.activePaneId };
    }

    function canvasOf(tabId: string) {
      const state = useEpicCanvasStore.getState().canvasByTabId[tabId];
      if (state === undefined) throw new Error("the canvas is gone");
      return state;
    }

    it("switches to the instance the task already has, and opens no second view", async () => {
      const { tabId, paneId } = taskCanvas(true);
      const itemRun = vi.fn<CommandItem["run"]>();
      const item = commandItem(`open:chats:${CHAT_ID}`, itemRun, null);
      const ctx = context({
        activeTabId: tabId,
        activeEpicId: EPIC_ID,
        targetGroupId: paneId,
      });
      expect(findPaneById(canvasOf(tabId).root, paneId)?.activeTabId).toBe(
        SPEC_TILE.instanceId,
      );

      const outcome = await run(
        item.id,
        "",
        readsOver(null, [{ item, ctx, hostWake: "none" }]),
      );

      expect(outcome).toEqual({ kind: "executed" });
      expect(Object.keys(canvasOf(tabId).tilesByInstanceId).sort()).toEqual([
        CHAT_TILE.instanceId,
        SPEC_TILE.instanceId,
      ]);
      expect(findPaneById(canvasOf(tabId).root, paneId)?.activeTabId).toBe(
        CHAT_TILE.instanceId,
      );
      expect(itemRun).not.toHaveBeenCalled();
    });

    it("runs the opener when the task has not got the tile open", async () => {
      const { tabId, paneId } = taskCanvas(false);
      const itemRun = vi.fn<CommandItem["run"]>();
      const item = commandItem(`open:chats:${CHAT_ID}`, itemRun, null);
      const ctx = context({
        activeTabId: tabId,
        activeEpicId: EPIC_ID,
        targetGroupId: paneId,
      });

      const outcome = await run(
        item.id,
        "",
        readsOver(null, [{ item, ctx, hostWake: "none" }]),
      );

      expect(outcome).toEqual({ kind: "executed" });
      expect(itemRun).toHaveBeenCalledTimes(1);
      expect(itemRun.mock.calls.at(0)?.[0]).toBe(ctx);
    });

    /** The opener of the chat, as the palette offers it for a host in `hostWake`. */
    function openerOn(
      hostWake: HostWake,
      itemRun: CommandItem["run"],
      ctx: CommandContext,
    ): PageActReads {
      const item = commandItem(`open:chats:${CHAT_ID}`, itemRun, null);
      return readsOver(null, [{ item, ctx, hostWake }]);
    }

    /** The opener's row, as the router returns it: read back with a wake question or not. */
    function openerRow(readBack: boolean): VoiceViewRow {
      const row = rowFor(`open:chats:${CHAT_ID}`);
      return readBack
        ? { ...row, confirm: true, wakeQuestion: "Wake it and open it. Yes?" }
        : row;
    }

    function openNow(row: VoiceViewRow, reads: PageActReads) {
      return executePageAct({ row, text: "", turnId: null, reads });
    }

    describe("on a host whose sandbox rests", () => {
      /** The opener of the chat, as the palette offers it for a host that rests. */
      function restingOpener(
        itemRun: CommandItem["run"],
        ctx: CommandContext,
      ): PageActReads {
        return openerOn("wakes", itemRun, ctx);
      }

      it("opens the tile the task already has, and marks it asked for, once the wake was read back", async () => {
        const asked = { ...CHAT_TILE, instanceId: "inst-chat-read-back" };
        const { tabId, paneId } = canvasHolding(asked);
        const itemRun = vi.fn<CommandItem["run"]>();
        const ctx = context({
          activeTabId: tabId,
          activeEpicId: EPIC_ID,
          targetGroupId: paneId,
        });
        expect(wasTileOpenRequested(asked.instanceId)).toBe(false);

        const outcome = await openNow(
          openerRow(true),
          restingOpener(itemRun, ctx),
        );

        expect(outcome).toEqual({ kind: "executed" });
        expect(findPaneById(canvasOf(tabId).root, paneId)?.activeTabId).toBe(
          asked.instanceId,
        );
        expect(Object.keys(canvasOf(tabId).tilesByInstanceId)).toHaveLength(2);
        expect(wasTileOpenRequested(asked.instanceId)).toBe(true);
      });

      it("refuses a request that was not read back, and leaves a tile the task has open and unasked for", async () => {
        const unasked = { ...CHAT_TILE, instanceId: "inst-chat-not-read-back" };
        const { tabId, paneId } = canvasHolding(unasked);
        const ctx = context({
          activeTabId: tabId,
          activeEpicId: EPIC_ID,
          targetGroupId: paneId,
        });
        const before = canvasOf(tabId);

        const outcome = await openNow(
          openerRow(false),
          restingOpener(vi.fn<CommandItem["run"]>(), ctx),
        );

        expect(outcome).toEqual(refusedWith(OPENER_ASLEEP_NOTICE));
        expect(canvasOf(tabId)).toBe(before);
        expect(wasTileOpenRequested(unasked.instanceId)).toBe(false);
      });

      it("refuses a request that was not read back before the opener runs", async () => {
        const { tabId, paneId } = taskCanvas(false);
        const itemRun = vi.fn<CommandItem["run"]>();
        const ctx = context({
          activeTabId: tabId,
          activeEpicId: EPIC_ID,
          targetGroupId: paneId,
        });

        const outcome = await openNow(
          openerRow(false),
          restingOpener(itemRun, ctx),
        );

        expect(outcome).toEqual(refusedWith(OPENER_ASLEEP_NOTICE));
        expect(itemRun).not.toHaveBeenCalled();
      });

      it("runs the opener of a tile the task has not got once the wake was read back", async () => {
        const { tabId, paneId } = taskCanvas(false);
        const itemRun = vi.fn<CommandItem["run"]>();
        const ctx = context({
          activeTabId: tabId,
          activeEpicId: EPIC_ID,
          targetGroupId: paneId,
        });

        const outcome = await openNow(
          openerRow(true),
          restingOpener(itemRun, ctx),
        );

        expect(outcome).toEqual({ kind: "executed" });
        expect(itemRun).toHaveBeenCalledTimes(1);
      });
    });

    describe("on a host the directory does not know yet", () => {
      function canvasAndContext() {
        const { tabId, paneId } = taskCanvas(false);
        const ctx = context({
          activeTabId: tabId,
          activeEpicId: EPIC_ID,
          targetGroupId: paneId,
        });
        return { tabId, ctx };
      }

      it("says it may wake the sandbox and opens nothing when the request was not read back", async () => {
        const { tabId, ctx } = canvasAndContext();
        const itemRun = vi.fn<CommandItem["run"]>();
        const before = canvasOf(tabId);

        const outcome = await openNow(
          openerRow(false),
          openerOn("unknown", itemRun, ctx),
        );

        expect(outcome).toEqual(refusedWith(OPENER_MAY_WAKE_NOTICE));
        expect(itemRun).not.toHaveBeenCalled();
        expect(canvasOf(tabId)).toBe(before);
      });

      it("runs the opener once the question was asked", async () => {
        const { ctx } = canvasAndContext();
        const itemRun = vi.fn<CommandItem["run"]>();

        const outcome = await openNow(
          openerRow(true),
          openerOn("unknown", itemRun, ctx),
        );

        expect(outcome).toEqual({ kind: "executed" });
        expect(itemRun).toHaveBeenCalledTimes(1);
      });
    });

    it("opens a read back opener whose host woke before the yes, as any opener", async () => {
      const { tabId, paneId } = taskCanvas(false);
      const itemRun = vi.fn<CommandItem["run"]>();
      const item = commandItem(`open:chats:${CHAT_ID}`, itemRun, null);
      const ctx = context({
        activeTabId: tabId,
        activeEpicId: EPIC_ID,
        targetGroupId: paneId,
      });

      const outcome = await executePageAct({
        row: openerRow(true),
        text: "",
        turnId: null,
        reads: readsOver(null, [{ item, ctx, hostWake: "none" }]),
      });

      expect(outcome).toEqual({ kind: "executed" });
      expect(itemRun).toHaveBeenCalledTimes(1);
    });
  });
});
