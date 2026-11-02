import type { QueryClient } from "@tanstack/react-query";
import { plainTextPromptContent } from "@traycer-clients/shared/epic/plain-text-content";
import type { ChatQueueDeliveryPolicy } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  composerHasBlockingApprovals,
  humanActionableApprovals,
} from "@/components/epic-canvas/renderers/chat-approval-visibility";
import {
  chatTileCanAct,
  shouldGenerateChatTitleForSubmittedMessage,
  userMessageSenderForProfile,
} from "@/components/epic-canvas/renderers/chat-tile-session-state";
import { chatActionsFor } from "@/hooks/chats/use-chat-actions";
import { decideSteerSettings } from "@/lib/chats/decide-steer-settings";
import { resolveSubmitDeliveryPolicy } from "@/lib/chats/resolve-steer-submit";
import { openTileIntoTargetGroup } from "@/lib/commands/actions/open-into-target";
import { runCommandItem } from "@/lib/commands/dispatch";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import { buildSubmittedChatJSONContent } from "@/lib/composer/tiptap-json-content";
import {
  deriveWorktreeBindingWorkspaceAvailability,
  effectiveMissingWorktreePaths,
  workspaceComposerCanStart,
} from "@/lib/composer/workspace-composer-availability";
import { appLogger } from "@/lib/logger";
import { queryKeys } from "@/lib/query-keys";
import type { VerbOutcome } from "@/lib/voice/deferred-verbs";
import type { VoiceViewRow } from "@/lib/voice/view";
import { worktreeDraftCommitsRebind } from "@/lib/worktree/owner-teardown-snapshot";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  composerTurnStatus,
  resolvedTurnStatus,
  type ComposerTurnStatus,
} from "@/stores/chats/chat-run-activity";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { readStagedWorktreeIntent } from "@/stores/worktree/worktree-intent-staging-store";

/**
 * The executors of the page's actions (Tracy Bots voice, VT9b). Each is the
 * path the surface itself takes: an agent's send, stop and approval through
 * its chat session, with the composer's own blockers said as refusals, and a
 * registry row through `runCommandItem`. Nothing here posts to a bot, moves
 * the focus or says anything on success: the engine's own acknowledgement is
 * the only acknowledgement of an executed act.
 */

/** The chat in the page's active tile, as the view read it. */
export interface VoiceAgentSession {
  readonly handle: ChatSessionStoreHandle;
  readonly chatId: string;
  readonly epicId: string;
  readonly hostId: string;
  readonly title: string;
}

/** A palette row still offered, with the context it was composed for. */
export interface VoicePaletteRow {
  readonly item: CommandItem;
  readonly ctx: CommandContext;
}

/** What an executor reads from the page in front when it runs. */
export interface PageActReads {
  /** The active tile's chat; with an id, only while that chat is the one shown. */
  readonly agentSession: (chatId: string | null) => VoiceAgentSession | null;
  readonly paletteRow: (action: string) => VoicePaletteRow | null;
}

export const AGENT_GONE_NOTICE = "That agent is no longer on this page.";
export const AGENT_STOPPING_NOTICE = "The agent is stopping.";
export const AGENT_WAITING_NOTICE = "It is waiting on an approval.";
export const AGENT_NO_ACCESS_NOTICE =
  "That agent can't take a message from you right now.";
export const AGENT_NO_WORKSPACE_NOTICE = "Its workspace isn't ready.";
export const AGENT_WORKSPACE_CHANGE_NOTICE =
  "It has a workspace change waiting. Send this one from its message box.";
export const AGENT_NOT_READY_NOTICE = "It isn't ready for a message yet.";
export const NOT_DELIVERED_NOTICE = "That didn't reach the agent.";
export const ALREADY_DECIDED_NOTICE = "That was already decided.";
export const DECISION_IN_FLIGHT_NOTICE =
  "Another decision is still going through. Say it again in a moment.";
export const TURN_ENDED_NOTICE = "The agent's turn already ended.";
export const NOTHING_TO_STOP_NOTICE = "Nothing was running to stop.";
export const ROW_GONE_NOTICE = "That isn't available here any more.";
export const ACT_FAILED_NOTICE = "That didn't work.";

/** A row's outcome, with the voice's line when it was refused. */
function refused(say: string): VerbOutcome {
  return { kind: "refused", say };
}

const EXECUTED: VerbOutcome = { kind: "executed" };

const NO_PALETTE_HOOKS = {
  recordUse: () => undefined,
  close: () => undefined,
};

/** Not the raw `runStatus`: work left running after a turn ended keeps it `running`. */
function turnStatusOf(chat: ChatSessionState): ComposerTurnStatus {
  return resolvedTurnStatus(chat, composerTurnStatus(chat.runStatus));
}

function stopRequested(chat: ChatSessionState): boolean {
  return Object.values(chat.pendingActions).some(
    (action) => action.action === "stop",
  );
}

/**
 * The composer's own answer to where a send goes, as Mod-Enter gives it, read
 * now: steer a running turn when the wire allows it, queue otherwise. The
 * composer asks before a steer restarts the turn under other settings; the
 * voice has no such question, so that send queues instead of restarting.
 */
function deliveryPolicyOf(
  chat: ChatSessionState,
  settings: NonNullable<ChatSessionState["currentComposerSettings"]>,
): ChatQueueDeliveryPolicy {
  const policy = resolveSubmitDeliveryPolicy({
    source: "mod-enter",
    activeTurnStatus: turnStatusOf(chat),
    steerEnabled: useSettingsStore.getState().steerOnModEnterEnabled,
    steerProtocolSupported: chat.steerProtocolSupported,
  });
  if (
    policy === "after_safe_point" &&
    chat.activeTurn?.sameTurnSteeringSupported === true &&
    decideSteerSettings(chat.activeTurn, settings).kind === "interrupt_restart"
  ) {
    return "auto";
  }
  return policy;
}

/** The workspace half of the composer's blockers, from what the chat tile keeps warm. */
function workspaceRefusal(
  chat: ChatSessionState,
  session: VoiceAgentSession,
  queryClient: QueryClient,
): string | null {
  const staged = readStagedWorktreeIntent({
    surface: "owner",
    hostId: session.hostId,
    epicId: session.epicId,
    ownerKind: "chat",
    ownerId: session.chatId,
  });
  // A send commits a staged change of folder, which the chat tile asks about
  // first; the voice has no such question to put.
  if (
    worktreeDraftCommitsRebind({
      binding: chat.worktreeBinding,
      draft: staged,
      removedWorkspacePaths: [],
    })
  ) {
    return AGENT_WORKSPACE_CHANGE_NOTICE;
  }
  const listing = queryClient.getQueryData<
    ResponseOfMethod<HostRpcRegistry, "worktree.listBindingsForEpic">
  >(
    queryKeys.hostMethod<HostRpcRegistry, "worktree.listBindingsForEpic">(
      session.hostId,
      "worktree.listBindingsForEpic",
      { epicId: session.epicId },
    ),
  );
  const availability = deriveWorktreeBindingWorkspaceAvailability(
    chat.worktreeBinding,
    chat.snapshotLoaded,
    {
      count: listing === undefined ? null : listing.rows.length,
      didResolutionFail: false,
    },
    effectiveMissingWorktreePaths(
      chat.missingWorktreePaths,
      new Set(staged?.entries.map((entry) => entry.workspacePath) ?? []),
    ),
  );
  return workspaceComposerCanStart(availability)
    ? null
    : AGENT_NO_WORKSPACE_NOTICE;
}

/** What stops a send to this chat now, in the composer's words for the person. */
function tellRefusal(
  chat: ChatSessionState,
  session: VoiceAgentSession,
  queryClient: QueryClient,
): string | null {
  if (
    !chatTileCanAct(
      chat.connectionStatus,
      chat.access?.canAct === true,
      useAuthStore.getState().profile !== null,
    )
  ) {
    return AGENT_NO_ACCESS_NOTICE;
  }
  if (stopRequested(chat) || turnStatusOf(chat) === "stopping") {
    return AGENT_STOPPING_NOTICE;
  }
  if (
    composerHasBlockingApprovals(
      chat.pendingApprovals,
      chat.pendingFileEditApprovals.length,
    )
  ) {
    return AGENT_WAITING_NOTICE;
  }
  return workspaceRefusal(chat, session, queryClient);
}

function tellAgent(
  chatId: string,
  text: string,
  reads: PageActReads,
  queryClient: QueryClient,
): VerbOutcome {
  const session = reads.agentSession(chatId);
  if (session === null) return refused(AGENT_GONE_NOTICE);
  const chat = session.handle.store.getState();
  const refusal = tellRefusal(chat, session, queryClient);
  if (refusal !== null) return refused(refusal);
  const sender = userMessageSenderForProfile(useAuthStore.getState().profile);
  const settings = chat.currentComposerSettings ?? chat.chat?.settings ?? null;
  if (sender === null || settings === null) {
    return refused(AGENT_NOT_READY_NOTICE);
  }
  const content = buildSubmittedChatJSONContent(
    plainTextPromptContent(text),
    null,
  );
  const marksTitlePending = shouldGenerateChatTitleForSubmittedMessage({
    chat: chat.chat,
    messages: chat.messages,
    pendingUserMessages: chat.pendingUserMessages,
    transcriptWindow: chat.transcriptWindow,
    transcriptDerived: chat.transcriptDerived,
    content,
  });
  const sent = chatActionsFor(session.handle).sendMessage({
    content,
    sender,
    settings,
    attachments: [],
    deliveryPolicy: deliveryPolicyOf(chat, settings),
    restore: { content, browserAnnotations: [] },
  });
  if (sent === null) return refused(NOT_DELIVERED_NOTICE);
  if (marksTitlePending) {
    useEpicCanvasStore
      .getState()
      .markChatTitlePending(chatId, chat.chat?.title ?? session.title);
  }
  return EXECUTED;
}

/**
 * A stop acts on the turn it was asked of. The read-back can outlast that turn,
 * and a yes must not stop the next one, which nobody asked to stop. With no turn
 * on the wire when it was routed there is no such turn, and whatever runs by the
 * time of the yes is not what was asked about.
 */
function stopAgent(
  chatId: string,
  routedTurnId: string | null,
  reads: PageActReads,
): VerbOutcome {
  if (routedTurnId === null) return refused(NOTHING_TO_STOP_NOTICE);
  const session = reads.agentSession(chatId);
  if (session === null) return refused(AGENT_GONE_NOTICE);
  const chat = session.handle.store.getState();
  const status = turnStatusOf(chat);
  if (stopRequested(chat) || status === "stopping") {
    return refused(AGENT_STOPPING_NOTICE);
  }
  if (status !== "running" || chat.activeTurn?.turnId !== routedTurnId) {
    return refused(TURN_ENDED_NOTICE);
  }
  return chatActionsFor(session.handle).stopTurn() === null
    ? refused(NOT_DELIVERED_NOTICE)
    : EXECUTED;
}

function decideApproval(
  approvalId: string,
  approved: boolean,
  reads: PageActReads,
): VerbOutcome {
  const session = reads.agentSession(null);
  if (session === null) return refused(AGENT_GONE_NOTICE);
  const chat = session.handle.store.getState();
  if (
    !humanActionableApprovals(chat.pendingApprovals).some(
      (approval) => approval.approvalId === approvalId,
    )
  ) {
    return refused(ALREADY_DECIDED_NOTICE);
  }
  // The approval card takes no second decision while one is out either.
  if (
    Object.values(chat.pendingActions).some(
      (action) => action.action === "approvalDecision",
    )
  ) {
    return refused(DECISION_IN_FLIGHT_NOTICE);
  }
  return chatActionsFor(session.handle).approvalDecision(approvalId, {
    approved,
  }) === null
    ? refused(NOT_DELIVERED_NOTICE)
    : EXECUTED;
}

const OPENER_ROW = /^open:(?:chats|tui|artifacts):(.+)$/su;

/**
 * The tile an opener row names, when the task already has it open. The opener
 * mints a second view of its tile, which is what a person picking it from the
 * pane's list asks for and not what "switch to it" means.
 */
function openTileOf(
  action: string,
  ctx: CommandContext,
): EpicCanvasTileRef | null {
  const contentId = OPENER_ROW.exec(action)?.[1];
  if (contentId === undefined || ctx.activeTabId === null) return null;
  const canvas = useEpicCanvasStore.getState().canvasByTabId[ctx.activeTabId];
  if (canvas === undefined) return null;
  return (
    Object.values(canvas.tilesByInstanceId).find(
      (ref) => ref?.id === contentId,
    ) ?? null
  );
}

async function runRegistryRow(
  action: string,
  reads: PageActReads,
): Promise<VerbOutcome> {
  const row = reads.paletteRow(action);
  if (row === null) return refused(ROW_GONE_NOTICE);
  const { item, ctx } = row;
  const open = openTileOf(action, ctx);
  if (open !== null) {
    openTileIntoTargetGroup({
      tabId: ctx.activeTabId,
      groupId: ctx.targetGroupId,
      ref: open,
      dedupe: true,
      navigateNestedFocus: ctx.router.navigateNestedFocus,
    });
    return EXECUTED;
  }
  await runCommandItem(item, ctx, NO_PALETTE_HOOKS);
  return EXECUTED;
}

/** The part of a synthetic row's id after its kind; `null` for another kind. */
function idAfter(action: string, kind: string): string | null {
  return action.startsWith(`${kind}:`) ? action.slice(kind.length + 1) : null;
}

/** One row to run, as the say loop hands it over. */
interface PageActInput {
  readonly row: VoiceViewRow;
  /** The span of the person's words; what a row that takes words passes on. */
  readonly text: string;
  /** The agent's turn as the route saw it. */
  readonly turnId: string | null;
  readonly reads: PageActReads;
  readonly queryClient: QueryClient;
}

function runRow(input: PageActInput): VerbOutcome | Promise<VerbOutcome> {
  const { row, text, turnId, reads, queryClient } = input;
  const { action } = row;
  const tell = idAfter(action, "agent.tell");
  if (tell !== null) return tellAgent(tell, text, reads, queryClient);
  const stop = idAfter(action, "agent.stop");
  if (stop !== null) return stopAgent(stop, turnId, reads);
  const approve = idAfter(action, "approval.approve");
  if (approve !== null) return decideApproval(approve, true, reads);
  const decline = idAfter(action, "approval.decline");
  if (decline !== null) return decideApproval(decline, false, reads);
  return runRegistryRow(action, reads);
}

/**
 * Runs one row of the view. Always settles: a surface path that throws is said
 * as a refusal, never left as an unhandled rejection of the boundary.
 */
export async function executePageAct(
  input: PageActInput,
): Promise<VerbOutcome> {
  try {
    return await runRow(input);
  } catch (error) {
    appLogger.warn("[voice] page act failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return refused(ACT_FAILED_NOTICE);
  }
}
