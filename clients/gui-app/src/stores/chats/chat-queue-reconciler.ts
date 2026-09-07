import type {
  ChatErrorNotice,
  ChatQueueDeliveryPolicy,
  ChatQueueState,
  ChatRunSettings,
  ChatRunStatus,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { AccountContext } from "@traycer/protocol/common/schemas";
import {
  classifyContentRecovery,
  recoveryTextFromContent,
} from "@/lib/composer/content-recovery";
import type {
  AcceptedChatAction,
  FailedSendRestorationState,
  PendingChatAction,
  PendingUserMessage,
  StagedWorktreeIntentSource,
} from "@/stores/chats/chat-session-store";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";

/**
 * Notice code for a send whose text the CLIENT is the last holder of - the message body is inlined
 * in `ChatErrorNotice.message` because nothing else holds it any more.
 */
export const SEND_NOT_RECORDED_NOTICE_CODE = "SEND_NOT_RECORDED";

/**
 * Notice code for the send that WON the restoration slot: its text is safely back in the composer,
 * and this carries the account of why it came back and what changed underneath it.
 */
export const SEND_RESTORED_NOTICE_CODE = "SEND_RESTORED";

/** Whether a notice must survive the pane being unfocused when it arrived. */
export function noticeMustSurviveUnfocus(notice: ChatErrorNotice): boolean {
  return (
    noticeCarriesOnlyCopy(notice) || notice.code === SEND_RESTORED_NOTICE_CODE
  );
}

/**
 * Whether this notice inlines content nothing else holds any more. Both passes settle the send and
 * drop its row, so the message body in the notice IS the draft - not a pointer to one.
 */
export function noticeCarriesOnlyCopy(notice: ChatErrorNotice): boolean {
  return notice.code === SEND_NOT_RECORDED_NOTICE_CODE;
}

/**
 * Input for queue reconciliation. Contains the immutable state slices needed to determine which
 * pending actions have been queued and should transition to accepted actions.
 */
export type ReconcileQueueInput = {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly queue: ChatQueueState;
  /**
   * Accepted records, because this frame confirms sends that are no longer
   * pending. See the stamping pass in {@link reconcileQueueChange}.
   */
  readonly acceptedActions: Readonly<Record<string, AcceptedChatAction>>;
  readonly nowMs: number;
};

/**
 * Output patch for queue reconciliation. Contains updated state slices
 * to apply to the store.
 */
export type ReconcileQueuePatch = {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly acceptedActions: Readonly<Record<string, AcceptedChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  /**
   * Already-accepted records this frame CONFIRMED - see {@link AcceptedChatAction.confirmedByHost}.
   * Merged by the caller over its own map, like the snapshot pass's channel of the same shape.
   */
  readonly confirmedAcceptedActions: Readonly<
    Record<string, AcceptedChatAction>
  >;
};

/**
 * Input for snapshot reconciliation. Contains all state and snapshot data
 * needed to reconcile pending actions against a newly-received snapshot.
 */
export type ReconcileSnapshotInput = {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly messages: ReadonlyArray<Message>;
  readonly queue: ChatQueueState;
  readonly failedSendRestoration: FailedSendRestorationState | null;
  /** The connection this snapshot arrived on. */
  readonly connectionEpoch: number;
  /** The chat's settings as of this snapshot - see {@link settingsDriftClause}. */
  readonly currentSettings: ChatRunSettings | null;
  /** The account a resend would bill - see {@link accountDriftClause}. */
  readonly currentAccountContext: AccountContext | null;
  /** See {@link WorktreePartitionFn}. */
  readonly worktreePartition: WorktreePartitionFn;
  /** Accepted records, because an ACCEPTED send can die too. */
  readonly acceptedActions: Readonly<Record<string, AcceptedChatAction>>;
  readonly nowMs: number;
};

/**
 * Which of this intent's folders a sweep removed while its dispatch was in flight, and which
 * survived.
 */
export type WorktreePartitionFn = (intent: WorktreeIntent) => {
  readonly survivors: WorktreeIntent | null;
  readonly swept: WorktreeIntent | null;
};

/** A send with no staged worktree has none to have lost. */
export function worktreeSweepFor(
  intent: WorktreeIntent | null,
  partition: WorktreePartitionFn,
  superseded: boolean,
): WorktreeSweepAccount {
  if (intent === null) return { ...NO_WORKTREE_SWEEP, superseded };
  const { survivors, swept } = partition(intent);
  return { survivors, swept, superseded };
}

/**
 * Output patch for snapshot reconciliation. Contains updated state slices to apply to the store,
 * including the failedSendRestoration field.
 */
export type ReconcileSnapshotPatch = {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly acceptedActions: Readonly<Record<string, AcceptedChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly failedSendRestoration: FailedSendRestorationState | null;
  readonly appendedErrorNotices: ReadonlyArray<ChatErrorNotice>;
  /** Accepted sends this pass declared dead. */
  readonly settledAcceptedActionIds: ReadonlySet<string>;
  /**
   * Accepted records this pass STAMPED as confirmed. Merged by the caller over
   * its own map - see {@link AcceptedChatAction.confirmedByHost}.
   */
  readonly confirmedAcceptedActions: Readonly<
    Record<string, AcceptedChatAction>
  >;
  /**
   * The staged worktree choice belonging to the send whose prompt just claimed the restoration slot,
   * for the caller to re-stage under the revision guard.
   */
  readonly restoredWorktreeIntent: StagedWorktreeIntentSource | null;
};

/** Superseded, not swept: a different fact from {@link worktreeAccountClause}, so deliberately not the same sentence. */
export const WORKTREE_SUPERSEDED_STATEMENT =
  "Its staged worktree was taken by a later message and was not restored, so a resend runs against this chat's current worktree unless you pick one.";

export interface UnrecoverableSend {
  readonly clientActionId: string;
  readonly content: JsonContent;
  /** How this send died, phrased to open the statement. */
  readonly circumstance: string;
  /** Everything said after the content losses. */
  readonly account: DeadSendAccount;
}

/**
 * Everything a dead send's statement says about its CONTENT - the headline and the loss clauses,
 * in canonical order. Shared because both statements are the last accounting of the same thing.
 */
function contentLossStatement(content: JsonContent, preamble: string): string {
  const text = recoveryTextFromContent(content);
  const hasText = text.trim().length > 0;
  const losses = classifyContentRecovery(content);
  const attachments = losses.get("attachment") ?? 0;
  return [
    headline(preamble, hasText, attachments),
    attachmentClause(attachments, hasText),
    countedClause({
      count: losses.get("mention") ?? 0,
      singular: "mention",
      plural: "mentions",
      verbPhrase: "will paste as plain text - re-pick",
      tail: "so the agent sees what they point at again",
    }),
    countedClause({
      count: losses.get("quote") ?? 0,
      singular: "quoted source",
      plural: "quoted sources",
      verbPhrase: "lose the link to what they quote - re-quote",
      tail: "so that link comes back",
    }),
    countedClause({
      count: losses.get("command") ?? 0,
      singular: "skill chip",
      plural: "skill chips",
      verbPhrase: "will paste as plain text from where they sit - re-pick",
      tail: "so they run again",
    }),
    countedClause({
      count: losses.get("table") ?? 0,
      singular: "table",
      plural: "tables",
      verbPhrase:
        "will paste back as markdown text rather than a grid - rebuild",
      tail: "if the layout matters",
    }),
    countedClause({
      count: losses.get("quotedBlock") ?? 0,
      singular: "quoted block",
      plural: "quoted blocks",
      verbPhrase: "will paste back as ordinary text - re-apply",
      tail: "with the composer's quote control so the agent sees them as quotes",
    }),
    (losses.get("unknown") ?? 0) > 0
      ? " Some of its content will not survive as plain text and has to be rebuilt in the composer."
      : "",
  ].join("");
}

/** The verbatim draft this statement is handing back, or `null` if there is none. */
function quotedDraftOf(content: JsonContent): string | null {
  const text = recoveryTextFromContent(content);
  return text.trim().length > 0 ? text : null;
}

export function unrecoverableSendNotice(
  send: UnrecoverableSend,
): ChatErrorNotice {
  const { clientActionId, content, circumstance } = send;
  return {
    code: SEND_NOT_RECORDED_NOTICE_CODE,
    message: statementQuoting(
      [
        contentLossStatement(
          content,
          `${circumstance}, and another unsent message is already waiting in the composer.`,
        ),
        // The account tail. Only THIS caller renders it - see
        // `contentLossStatement`.
        deadSendAccountClauses(send.account, false),
      ].join(""),
      quotedDraftOf(content),
    ),
    severity: "warning",
    clientActionId,
  };
}

/**
 * The statement for a restored prompt the composer could NOT take, because the user has already
 * typed something else there.
 */
export function displacedRestorationNotice(
  clientActionId: string,
  content: JsonContent,
  reason: string,
): ChatErrorNotice {
  return {
    code: SEND_NOT_RECORDED_NOTICE_CODE,
    message: statementQuoting(
      // `reason` already carries the account clauses, baked in by whichever pass built the restoration
      // slot - so this path must not render them a second time.
      contentLossStatement(
        content,
        `${reason} It was not put back in the composer, because you have started another message there.`,
      ),
      quotedDraftOf(content),
    ),
    severity: "warning",
    clientActionId,
  };
}

/**
 * The one place the quoted draft is separated from everything said about it. The draft goes LAST
 * and runs to the end of the notice.
 */
function statementQuoting(said: string, draft: string | null): string {
  if (draft === null) return said;
  return `${said}\n\nCopy the message below to resend it:\n${draft}`;
}

/**
 * `attachmentClause` states an attachment-only send, so the bare preamble is
 * right there; only a send with neither text nor attachments needs saying.
 */
function headline(
  preamble: string,
  hasText: boolean,
  attachmentCount: number,
): string {
  if (hasText || attachmentCount > 0) return preamble;
  return `${preamble} It had no recoverable content.`;
}

/** A whole loss: the bytes are not in the notice and cannot be. */
function attachmentClause(attachmentCount: number, hasText: boolean): string {
  if (attachmentCount === 0) return "";
  const noun = attachmentCount === 1 ? "image attachment" : "image attachments";
  if (!hasText) {
    return ` It carried no text - only ${attachmentCount} ${noun}, which cannot be recovered here.`;
  }
  return ` It also carried ${attachmentCount} ${noun} that cannot be carried here - re-add ${attachmentCount === 1 ? "it" : "them"} before resending.`;
}

/**
 * A PARTIAL loss, and worth its own sentence: the projected text above is real and pasteable, but
 * it pastes as prose. Only re-picking restores the binding the agent actually reads.
 */
interface CountedLossClause {
  readonly count: number;
  readonly singular: string;
  readonly plural: string;
  /** What happens to it, phrased to precede the pronoun. */
  readonly verbPhrase: string;
  /** Why re-doing it matters, phrased to follow the pronoun. */
  readonly tail: string;
}

/** The staged worktree a STATED send was going to run in. */
/** What the send was queued to WAIT for, when it was not the default. */
function deliveryClause(policy: ChatQueueDeliveryPolicy | null): string {
  if (policy === null || policy === "auto") return "";
  const described =
    policy === "after_safe_point"
      ? "after the running turn reached a safe point"
      : "after the running turn finished";
  return ` It was queued to be delivered ${described}; a resend goes by whatever you choose then.`;
}

/** What a mid-dispatch sweep did to a send's staged binding, per ENTRY. */
export interface WorktreeSweepAccount {
  readonly survivors: WorktreeIntent | null;
  readonly swept: WorktreeIntent | null;
  /** The slot was refused because the USER made a newer pick, not because anything was deleted. */
  readonly superseded: boolean;
}

/** A send with nothing to say: no staging, no drift. */
export const EMPTY_DEAD_SEND_ACCOUNT: DeadSendAccount = {
  worktree: { survivors: null, swept: null, superseded: false },
  sentSettings: null,
  currentSettings: null,
  sentAccountContext: null,
  currentAccountContext: null,
  sentDeliveryPolicy: null,
};

export const NO_WORKTREE_SWEEP: WorktreeSweepAccount = {
  survivors: null,
  swept: null,
  superseded: false,
};

/** Every fact a dead send's account is composed from. */
export interface DeadSendAccount {
  readonly worktree: WorktreeSweepAccount;
  readonly sentSettings: ChatRunSettings | null;
  readonly currentSettings: ChatRunSettings | null;
  readonly sentAccountContext: AccountContext | null;
  readonly currentAccountContext: AccountContext | null;
  readonly sentDeliveryPolicy: ChatQueueDeliveryPolicy | null;
}

/**
 * THE account, in the canonical clause order: what it was going to RUN IN, then what changed
 * underneath it.
 */
export function deadSendAccountClauses(
  account: DeadSendAccount,
  handedBack: boolean,
): string {
  return [
    worktreeAccountClause(account.worktree, handedBack),
    account.worktree.superseded ? ` ${WORKTREE_SUPERSEDED_STATEMENT}` : "",
    deliveryClause(account.sentDeliveryPolicy),
    settingsDriftClause(
      account.sentSettings,
      account.currentSettings,
      account.sentAccountContext,
      account.currentAccountContext,
    ),
  ].join("");
}

/**
 * Removed and surviving folders, named SEPARATELY. A swept folder is not re-pickable, so the
 * clause must not ask for it; a surviving one is, so it must not be described as gone.
 */
function worktreeAccountClause(
  sweep: WorktreeSweepAccount,
  handedBack: boolean,
): string {
  // Qualified against the WHOLE staging, not each half: whether a folder needs naming by workspace
  // is a fact about how many were staged, and splitting the list must not change how its members
  const total =
    (sweep.survivors?.entries.length ?? 0) + (sweep.swept?.entries.length ?? 0);
  const survivors = intentLabels(sweep.survivors, total > 1);
  const swept = intentLabels(sweep.swept, total > 1);
  if (survivors.length === 0 && swept.length === 0) return "";
  if (handedBack) {
    // The survivors came back staged with the prompt, so there is nothing to
    // ask of the user about them - only the loss needs saying.
    if (swept.length === 0) return "";
    if (survivors.length === 0) {
      return ` Its staged worktree ${swept.join(", ")} no longer exists, so it was not restored.`;
    }
    return ` Its staged worktree ${swept.join(", ")} no longer exists; the rest of its staging came back, so check the binding before resending.`;
  }
  if (swept.length === 0) {
    return ` It was staged to run in ${survivors.join(", ")} - re-pick that before resending, or it runs against this chat's current worktree.`;
  }
  if (survivors.length === 0) {
    return ` It was staged to run in ${swept.join(", ")}, which no longer exists - a resend runs against this chat's current worktree unless you pick another.`;
  }
  return ` It was staged to run in ${survivors.join(", ")} - re-pick that before resending. It was also staged to run in ${swept.join(", ")}, which no longer exists.`;
}

/**
 * `WorktreeIntent` permits one entry per workspace folder, so a multi-repo staging read as "branch
 * a, branch b" with no way to tell which repo each belonged to - unre-pickable.
 */
function intentLabels(
  intent: WorktreeIntent | null,
  qualify: boolean,
): ReadonlyArray<string> {
  if (intent === null) return [];
  return intent.entries.flatMap((entry) => {
    const label = worktreeEntryLabel(entry);
    if (label === null) return [];
    return qualify && entry.workspacePath.length > 0
      ? [`${label} in ${entry.workspacePath}`]
      : [label];
  });
}

/** How to NAME a staged entry so the user can re-pick it deliberately. Every kind gets one. */
function worktreeEntryLabel(
  entry: WorktreeIntent["entries"][number],
): string | null {
  switch (entry.kind) {
    case "worktree":
      return worktreeBranchLabel(entry.branch, entry.scripts !== null);
    case "import":
      return entry.worktreePath.length > 0
        ? `the existing worktree ${entry.worktreePath}`
        : null;
    case "local":
      return entry.workspacePath.length > 0
        ? `the workspace checkout ${entry.workspacePath}`
        : null;
    default:
      // A new entry kind must be NAMED here, not absorbed by an else-branch that labels it "the
      // workspace checkout" and quietly misdescribes what the send was staged to do.
      return assertNeverEntry(entry);
  }
}

/** What the send was going to RUN under, when that differs from what a resend would use now. */
const DRIFT_LABELS: Record<keyof ChatRunSettings | "accountContext", string> = {
  harnessId: "harness",
  model: "model",
  permissionMode: "permission mode",
  reasoningEffort: "reasoning effort",
  serviceTier: "service tier",
  agentMode: "agent mode",
  profileId: "profile",
  accountContext: "billing",
};

function settingsDriftClause(
  sent: ChatRunSettings | null,
  current: ChatRunSettings | null,
  sentAccount: AccountContext | null,
  currentAccount: AccountContext | null,
): string {
  // Two comparisons with DIFFERENT preconditions, which is why they are no longer behind one gate.
  const named = [
    ...runSettingsDrift(sent, current),
    ...accountDrift(sentAccount, currentAccount),
  ];
  if (named.length === 0) return "";
  return ` It was going to run with ${named.join(", ")}; the chat uses different settings now, so a resend will not match unless you set them back.`;
}

/** Nothing to compare when either side is absent - unlike billing. */
function runSettingsDrift(
  sent: ChatRunSettings | null,
  current: ChatRunSettings | null,
): ReadonlyArray<string> {
  if (sent === null || current === null) return [];
  // Keyed by `keyof ChatRunSettings`, NOT `Record<string, ...>`.
  const values: Record<
    keyof ChatRunSettings,
    readonly [string | null, string | null]
  > = {
    harnessId: [sent.harnessId, current.harnessId],
    model: [sent.model, current.model],
    permissionMode: [sent.permissionMode, current.permissionMode],
    reasoningEffort: [sent.reasoningEffort, current.reasoningEffort],
    serviceTier: [sent.serviceTier, current.serviceTier],
    agentMode: [sent.agentMode, current.agentMode],
    profileId: [sent.profileId ?? null, current.profileId ?? null],
  };
  // `null` is a VALUE - "use the default" - not an absence. Dropping a field
  // because its SENT value was null hid the drift that matters most.
  return namedDrift(values);
}

/** Billing, compared on its OWN terms. */
function accountDrift(
  sentAccount: AccountContext | null,
  currentAccount: AccountContext | null,
): ReadonlyArray<string> {
  return namedDrift({
    accountContext: [
      sentAccount === null ? null : describeAccount(sentAccount),
      currentAccount === null ? null : describeAccount(currentAccount),
    ],
  });
}

function namedDrift(
  values: Partial<
    Record<
      keyof ChatRunSettings | "accountContext",
      readonly [string | null, string | null]
    >
  >,
): ReadonlyArray<string> {
  // An absent key is simply not enumerated, so the pair is always present.
  return Object.entries(values).flatMap(([key, [was, now]]) =>
    was === now
      ? []
      : [
          `${DRIFT_LABELS[key as keyof typeof DRIFT_LABELS]} ${describeSetting(was)}`,
        ],
  );
}

function describeAccount(context: AccountContext): string {
  return context.type === "TEAM"
    ? `team ${context.teamId}`
    : "your personal account";
}

function describeSetting(value: string | null): string {
  return value === null ? "default" : value;
}

type StagedBranchSelection = Extract<
  WorktreeIntent["entries"][number],
  { kind: "worktree" }
>["branch"];

/**
 * A `worktree` entry is more than its branch name - a fork source, carried uncommitted changes,
 * setup/teardown overrides.
 */
function worktreeBranchLabel(
  branch: StagedBranchSelection,
  hasScripts: boolean,
): string | null {
  if (branch.name.length === 0) return null;
  const carried = branch.type === "new" && branch.carryUncommittedChanges;
  const base =
    branch.type === "new"
      ? `a new branch ${branch.name} from ${branch.source}${carried ? " carrying your uncommitted changes" : ""}`
      : `branch ${branch.name}`;
  return hasScripts
    ? `${base} (its setup/teardown overrides cannot be restated - re-configure before resending)`
    : base;
}

function assertNeverEntry(entry: never): null {
  void entry;
  return null;
}

function countedClause(clause: CountedLossClause): string {
  if (clause.count === 0) return "";
  const noun = clause.count === 1 ? clause.singular : clause.plural;
  const pronoun = clause.count === 1 ? "it" : "them";
  return ` Its ${clause.count} ${noun} ${clause.verbPhrase} ${pronoun} ${clause.tail}.`;
}

/**
 * Reconcile pending actions when the queue changes. Transitions pending actions that are now in
 * the queue to accepted actions.
 */
export function reconcileQueueChange(
  input: ReconcileQueueInput,
): ReconcileQueuePatch {
  const queuedPendingActionIds = pendingActionIdsForQueuedMessages(
    input.pendingActions,
    input.pendingUserMessages,
    input.queue,
  );
  const confirmedAcceptedActions = confirmAcceptedSendsInQueue(input);
  if (queuedPendingActionIds.size === 0) {
    return {
      pendingActions: input.pendingActions,
      acceptedActions: {},
      pendingUserMessages: input.pendingUserMessages,
      confirmedAcceptedActions,
    };
  }
  const queuedPendingActions = Object.values(input.pendingActions).filter(
    (action) => queuedPendingActionIds.has(action.clientActionId),
  );
  const nextPendingActions = queuedPendingActions.reduce(
    (next, action) => withoutPendingAction(next, action.clientActionId),
    input.pendingActions,
  );
  const nextAcceptedActions = pruneAcceptedActions(
    queuedPendingActions.reduce(
      // This transition happens BECAUSE the host's queue reports the
      // message - the confirmation IS the trigger.
      (next, action) =>
        addAcceptedAction(next, action, input.nowMs, {
          confirmedByHost: true,
          messageConfirmedByHost: false,
        }),
      {},
    ),
    input.nowMs,
  );
  return {
    pendingActions: nextPendingActions,
    acceptedActions: nextAcceptedActions,
    pendingUserMessages: input.pendingUserMessages.filter(
      (message) => !queuedPendingActionIds.has(message.clientActionId),
    ),
    confirmedAcceptedActions,
  };
}

/**
 * Stamp accepted sends this live queue frame CONFIRMS. The fourth confirmation door, and the one
 * the pending walk above cannot reach.
 */
function confirmAcceptedSendsInQueue(
  input: ReconcileQueueInput,
): Readonly<Record<string, AcceptedChatAction>> {
  // A send that still has an optimistic row belongs to the settled pass, the
  // same partition `reconcileAcceptedSends` keeps.
  const optimisticRowIds = new Set(
    input.pendingUserMessages.map((message) => message.clientActionId),
  );
  return Object.values(input.acceptedActions).reduce<
    Record<string, AcceptedChatAction>
  >((confirmed, accepted) => {
    if (
      accepted.action !== "send" ||
      accepted.messageId === null ||
      accepted.confirmedByHost ||
      optimisticRowIds.has(accepted.clientActionId)
    ) {
      return confirmed;
    }
    if (!queueContainsPendingSend(input.queue, accepted.messageId, undefined)) {
      return confirmed;
    }
    confirmed[accepted.clientActionId] = {
      ...accepted,
      confirmedByHost: true,
    };
    return confirmed;
  }, {});
}

/**
 * Stamp the accepted send a `messageAccepted` frame CONFIRMS. The fifth confirmation door, and the
 * one that closes the set.
 */
export function confirmAcceptedSendByMessageId(
  acceptedActions: Readonly<Record<string, AcceptedChatAction>>,
  messageId: string,
): Readonly<Record<string, AcceptedChatAction>> {
  const accepted = Object.values(acceptedActions).find(
    (candidate) =>
      candidate.action === "send" &&
      candidate.messageId === messageId &&
      (!candidate.confirmedByHost || candidate.displayWorktreeIntent !== null),
  );
  if (accepted === undefined) return acceptedActions;
  return {
    ...acceptedActions,
    [accepted.clientActionId]: {
      ...accepted,
      confirmedByHost: true,
      displayWorktreeIntent: null,
    },
  };
}

/**
 * Reconcile pending actions against a snapshot. Clears pending actions whose messages have been
 * confirmed in the snapshot or are in the queue.
 */
export function reconcileSnapshotChange(
  input: ReconcileSnapshotInput,
): ReconcileSnapshotPatch {
  const acceptedMessageIds = confirmedMessageIdsForMessages(input.messages);
  const pendingUsersByAction = new Map(
    input.pendingUserMessages.map((message) => [
      message.clientActionId,
      message,
    ]),
  );
  const initial: ReconcileSnapshotPatch = {
    pendingActions: input.pendingActions,
    acceptedActions: {},
    pendingUserMessages: input.pendingUserMessages,
    failedSendRestoration: input.failedSendRestoration,
    appendedErrorNotices: [],
    restoredWorktreeIntent: null,
    settledAcceptedActionIds: NO_SETTLED_ACCEPTED_IDS,
    confirmedAcceptedActions: {},
  };
  const afterPending = Object.values(input.pendingActions).reduce(
    (next, pending): ReconcileSnapshotPatch => {
      if (
        (pending.action !== "send" && pending.action !== "editUserMessage") ||
        pending.messageId === null
      ) {
        return next;
      }
      const pendingUser = resolvePendingUser(pendingUsersByAction, pending);
      if (
        acceptedMessageIds.has(pending.messageId) ||
        (pending.action === "send" &&
          queueContainsPendingSend(input.queue, pending.messageId, pendingUser))
      ) {
        return {
          ...next,
          pendingActions: withoutPendingAction(
            next.pendingActions,
            pending.clientActionId,
          ),
          acceptedActions: addAcceptedAction(
            next.acceptedActions,
            pending,
            input.nowMs,
            {
              // Reached only when the snapshot SHOWS the message or queue.
              confirmedByHost: true,
              messageConfirmedByHost: acceptedMessageIds.has(pending.messageId),
            },
          ),
          pendingUserMessages: next.pendingUserMessages.filter(
            (message) => message.clientActionId !== pending.clientActionId,
          ),
        };
      }
      // Nothing to restore and nothing lost: the send stays pending and no
      // statement is owed.
      if (pending.restore === null) {
        return next;
      }
      // Everything below settles on ABSENCE, and absence is only evidence for a dispatch from a dead
      // connection.
      if (pending.connectionEpoch >= input.connectionEpoch) {
        return next;
      }
      // The slot is taken by a longer-waiting send.
      if (next.failedSendRestoration !== null) {
        return {
          ...next,
          pendingActions: withoutPendingAction(
            next.pendingActions,
            pending.clientActionId,
          ),
          pendingUserMessages: next.pendingUserMessages.filter(
            (message) => message.clientActionId !== pending.clientActionId,
          ),
          appendedErrorNotices: [
            ...next.appendedErrorNotices,
            unrecoverableSendNotice({
              clientActionId: pending.clientActionId,
              content: pending.restore.content,
              circumstance: "A message was not confirmed after reconnect",
              account: {
                worktree: worktreeSweepFor(
                  pending.restoreWorktreeIntent,
                  input.worktreePartition,
                  false,
                ),
                sentSettings: pending.settings,
                currentSettings: input.currentSettings,
                sentAccountContext: pending.accountContext,
                sentDeliveryPolicy: pending.deliveryPolicy,
                currentAccountContext: input.currentAccountContext,
              },
            }),
          ],
        };
      }
      // Computed once: the two variants of this account must describe the same
      // evidence and differ only in whether the binding came back.
      const snapshotAccount: DeadSendAccount = {
        worktree: worktreeSweepFor(
          pending.restoreWorktreeIntent,
          input.worktreePartition,
          false,
        ),
        sentSettings: pending.settings,
        currentSettings: input.currentSettings,
        sentAccountContext: pending.accountContext,
        currentAccountContext: input.currentAccountContext,
        sentDeliveryPolicy: pending.deliveryPolicy,
      };
      return {
        ...next,
        pendingActions: withoutPendingAction(
          next.pendingActions,
          pending.clientActionId,
        ),
        pendingUserMessages: next.pendingUserMessages.filter(
          (message) => message.clientActionId !== pending.clientActionId,
        ),
        failedSendRestoration: {
          clientActionId: pending.clientActionId,
          content: pending.restore.content,
          browserAnnotations: pending.restore.browserAnnotations,
          reason: `Message was not confirmed after reconnect.${deadSendAccountClauses(
            snapshotAccount,
            true,
          )}`,
          displacedReason: `Message was not confirmed after reconnect.${deadSendAccountClauses(
            snapshotAccount,
            false,
          )}`,
          // This pass has no surface of its own; the ack speaks for it.
          stated: false,
        },
        // The prompt goes back to the composer, so its worktree goes back to
        // the staging slot with it.
        restoredWorktreeIntent: pending,
      };
    },
    initial,
  );
  return reconcileAcceptedSends(afterPending, input, acceptedMessageIds);
}

const NO_SETTLED_ACCEPTED_IDS: ReadonlySet<string> = new Set();

/** Settle ACCEPTED sends the snapshot cannot account for. */
function reconcileAcceptedSends(
  patch: ReconcileSnapshotPatch,
  input: ReconcileSnapshotInput,
  acceptedMessageIds: ReadonlySet<string>,
): ReconcileSnapshotPatch {
  // A send that still has an optimistic user-message row belongs to {@link reconcileTurnSettled},
  // which walks exactly those and states them as "not recorded before the turn stopped".
  const optimisticRowIds = new Set(
    input.pendingUserMessages.map((message) => message.clientActionId),
  );
  return Object.values(input.acceptedActions).reduce(
    (next, accepted): ReconcileSnapshotPatch => {
      if (
        accepted.action !== "send" ||
        accepted.messageId === null ||
        accepted.restore === null ||
        optimisticRowIds.has(accepted.clientActionId)
      ) {
        return next;
      }
      // Presence is authoritative whatever dispatched it - and it is worth RECORDING, not just returning
      // on.
      if (
        acceptedMessageIds.has(accepted.messageId) ||
        queueContainsPendingSend(input.queue, accepted.messageId, undefined)
      ) {
        if (
          accepted.confirmedByHost &&
          (!acceptedMessageIds.has(accepted.messageId) ||
            accepted.displayWorktreeIntent === null)
        ) {
          return next;
        }
        return {
          ...next,
          confirmedAcceptedActions: {
            ...next.confirmedAcceptedActions,
            [accepted.clientActionId]: {
              ...accepted,
              confirmedByHost: true,
              displayWorktreeIntent: acceptedMessageIds.has(accepted.messageId)
                ? null
                : accepted.displayWorktreeIntent,
            },
          },
        };
      }
      // Absence is only evidence for a send nothing has ever confirmed.
      if (accepted.confirmedByHost) return next;
      // ...and absence is evidence only against a dead connection.
      if (accepted.connectionEpoch >= input.connectionEpoch) return next;
      const settledAcceptedActionIds = new Set(next.settledAcceptedActionIds);
      settledAcceptedActionIds.add(accepted.clientActionId);
      const account: DeadSendAccount = {
        worktree: worktreeSweepFor(
          accepted.restoreWorktreeIntent,
          input.worktreePartition,
          false,
        ),
        sentSettings: accepted.settings,
        currentSettings: input.currentSettings,
        sentAccountContext: accepted.accountContext,
        currentAccountContext: input.currentAccountContext,
        sentDeliveryPolicy: accepted.deliveryPolicy,
      };
      // First-writer-wins, shared with the pending pass: whoever has waited longest keeps the composer,
      // and everyone else is STATED with their text inlined.
      if (next.failedSendRestoration !== null) {
        return {
          ...next,
          settledAcceptedActionIds,
          appendedErrorNotices: [
            ...next.appendedErrorNotices,
            unrecoverableSendNotice({
              clientActionId: accepted.clientActionId,
              content: accepted.restore.content,
              circumstance:
                "A queued message was not confirmed after reconnect",
              account,
            }),
          ],
        };
      }
      return {
        ...next,
        settledAcceptedActionIds,
        failedSendRestoration: {
          clientActionId: accepted.clientActionId,
          content: accepted.restore.content,
          browserAnnotations: accepted.restore.browserAnnotations,
          reason: `A queued message was not confirmed after reconnect.${deadSendAccountClauses(
            account,
            true,
          )}`,
          displacedReason: `A queued message was not confirmed after reconnect.${deadSendAccountClauses(
            account,
            false,
          )}`,
          stated: false,
        },
        restoredWorktreeIntent: accepted,
      };
    },
    patch,
  );
}

/**
 * Input for turn-settled reconciliation: the state slices needed to decide
 * which optimistic pending user messages can no longer materialize.
 */
export type ReconcileTurnSettledInput = {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly messages: ReadonlyArray<Message>;
  readonly queue: ChatQueueState;
  readonly failedSendRestoration: FailedSendRestorationState | null;
  /** See {@link ReconcileSnapshotInput.currentSettings}. */
  readonly currentSettings: ChatRunSettings | null;
  /** See {@link ReconcileSnapshotInput.currentAccountContext}. */
  readonly currentAccountContext: AccountContext | null;
  /** See {@link WorktreePartitionFn}. */
  readonly worktreePartition: WorktreePartitionFn;
  /**
   * Accepted records, so a row this pass settles can retire its record in the
   * same breath - see {@link ReconcileTurnSettledPatch.settledAcceptedActionIds}.
   */
  readonly acceptedActions: Readonly<Record<string, AcceptedChatAction>>;
};

export type ReconcileTurnSettledPatch = {
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly failedSendRestoration: FailedSendRestorationState | null;
  /** Delta, appended by the caller - see {@link ReconcileSnapshotPatch}. */
  readonly appendedErrorNotices: ReadonlyArray<ChatErrorNotice>;
  /** See {@link ReconcileSnapshotPatch.restoredWorktreeIntent}. */
  readonly restoredWorktreeIntent: StagedWorktreeIntentSource | null;
  /** Accepted records whose ROW this pass just settled. */
  readonly settledAcceptedActionIds: ReadonlySet<string>;
};

export function turnSettledFromStatus(
  turnInProgress: boolean | undefined,
  runStatus: ChatRunStatus,
): boolean {
  return turnInProgress === undefined ? runStatus === "idle" : !turnInProgress;
}

/** Drop stranded optimistic user messages when the turn settles. */
export function reconcileTurnSettled(
  settled: boolean,
  input: ReconcileTurnSettledInput,
): ReconcileTurnSettledPatch {
  if (!settled) {
    return {
      pendingUserMessages: input.pendingUserMessages,
      failedSendRestoration: input.failedSendRestoration,
      appendedErrorNotices: [],
      restoredWorktreeIntent: null,
      settledAcceptedActionIds: NO_SETTLED_ACCEPTED_IDS,
    };
  }
  const confirmedMessageIds = confirmedMessageIdsForMessages(input.messages);
  const stranded = input.pendingUserMessages.filter(
    (message) =>
      !Object.hasOwn(input.pendingActions, message.clientActionId) &&
      !queueContainsPendingSend(input.queue, message.messageId, message),
  );
  if (stranded.length === 0) {
    return {
      pendingUserMessages: input.pendingUserMessages,
      failedSendRestoration: input.failedSendRestoration,
      appendedErrorNotices: [],
      restoredWorktreeIntent: null,
      settledAcceptedActionIds: NO_SETTLED_ACCEPTED_IDS,
    };
  }
  const restorable = stranded.find(
    (message) => !confirmedMessageIds.has(message.messageId),
  );
  const strandedActionIds = new Set(
    stranded.map((message) => message.clientActionId),
  );
  // Same rule as the snapshot arm: one account, two tellings.
  const settledAccount: DeadSendAccount | null =
    restorable === undefined
      ? null
      : {
          worktree: worktreeSweepFor(
            restorable.restoreWorktreeIntent,
            input.worktreePartition,
            false,
          ),
          sentSettings: restorable.settings,
          currentSettings: input.currentSettings,
          sentAccountContext: restorable.accountContext,
          currentAccountContext: input.currentAccountContext,
          sentDeliveryPolicy: restorable.deliveryPolicy,
        };
  // Who actually gets the composer back: `restorable` only claims the slot when it is free, because
  // the slot is first-writer-wins.
  const slotClaimantActionId =
    input.failedSendRestoration === null && restorable !== undefined
      ? restorable.clientActionId
      : null;
  return {
    // Every stranded row this pass settled - restored or stated - takes its accepted record with it,
    // so no later pass can find the same send unaccounted for and recover it twice.
    settledAcceptedActionIds: new Set(
      [...strandedActionIds].filter((clientActionId) =>
        Object.hasOwn(input.acceptedActions, clientActionId),
      ),
    ),
    pendingUserMessages: input.pendingUserMessages.filter(
      (message) => !strandedActionIds.has(message.clientActionId),
    ),
    failedSendRestoration:
      input.failedSendRestoration !== null || restorable === undefined
        ? input.failedSendRestoration
        : {
            clientActionId: restorable.clientActionId,
            content: restorable.restore.content,
            browserAnnotations: restorable.restore.browserAnnotations,
            reason: `The message was not recorded before the turn stopped.${deadSendAccountClauses(
              settledAccount ?? EMPTY_DEAD_SEND_ACCOUNT,
              true,
            )}`,
            displacedReason: `The message was not recorded before the turn stopped.${deadSendAccountClauses(
              settledAccount ?? EMPTY_DEAD_SEND_ACCOUNT,
              false,
            )}`,
            stated: false,
          },
    // Only when THIS pass handed the prompt back - an already-occupied slot
    // restored nothing here, so there is no binding to re-stage with it.
    restoredWorktreeIntent:
      input.failedSendRestoration !== null || restorable === undefined
        ? null
        : restorable,
    appendedErrorNotices: stranded
      .filter(
        (message) =>
          !confirmedMessageIds.has(message.messageId) &&
          message.clientActionId !== slotClaimantActionId,
      )
      .map((message) =>
        unrecoverableSendNotice({
          clientActionId: message.clientActionId,
          content: message.content,
          circumstance: "A message was not recorded before the turn stopped",
          account: {
            worktree: worktreeSweepFor(
              message.restoreWorktreeIntent,
              input.worktreePartition,
              false,
            ),
            sentSettings: message.settings,
            currentSettings: input.currentSettings,
            sentAccountContext: message.accountContext,
            sentDeliveryPolicy: message.deliveryPolicy,
            currentAccountContext: input.currentAccountContext,
          },
        }),
      ),
  };
}

export interface StalePendingActionsSweep {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly sweptActionIds: ReadonlySet<string>;
}

const NO_SWEPT_ACTION_IDS: ReadonlySet<string> = new Set();

/** Drop pending actions dispatched on an earlier connection than the snapshot's. */
export function sweepStalePendingActions(
  pendingActions: Readonly<Record<string, PendingChatAction>>,
  connectionEpoch: number,
): StalePendingActionsSweep {
  const stale = Object.values(pendingActions).filter(
    (pending) =>
      pending.action !== "send" && pending.connectionEpoch < connectionEpoch,
  );
  if (stale.length === 0) {
    return { pendingActions, sweptActionIds: NO_SWEPT_ACTION_IDS };
  }
  const sweptActionIds = new Set(
    stale.map((pending) => pending.clientActionId),
  );
  return {
    pendingActions: Object.fromEntries(
      Object.entries(pendingActions).filter(
        ([clientActionId]) => !sweptActionIds.has(clientActionId),
      ),
    ),
    sweptActionIds,
  };
}

/**
 * Find all pending action ids that correspond to messages already in the queue. Used during queue
 * reconciliation to identify which pending actions to promote to accepted.
 */
function pendingActionIdsForQueuedMessages(
  pendingActions: Readonly<Record<string, PendingChatAction>>,
  pendingUserMessages: ReadonlyArray<PendingUserMessage>,
  queue: ChatQueueState,
): Set<string> {
  const pendingUsersByAction = new Map(
    pendingUserMessages.map((message) => [message.clientActionId, message]),
  );
  return new Set([
    ...Object.values(pendingActions).flatMap((action) =>
      action.action === "send" &&
      action.messageId !== null &&
      queueContainsPendingSend(
        queue,
        action.messageId,
        resolvePendingUser(pendingUsersByAction, action),
      )
        ? [action.clientActionId]
        : [],
    ),
    ...pendingUserMessages.flatMap((message) =>
      queueContainsPendingSend(queue, message.messageId, message)
        ? [message.clientActionId]
        : [],
    ),
  ]);
}

/**
 * Resolve the pending user message associated with a pending action,
 * either from the live array or reconstructed from the action fields.
 */
function resolvePendingUser(
  pendingUsersByAction: ReadonlyMap<string, PendingUserMessage>,
  action: PendingChatAction,
): PendingUserMessage | undefined {
  return (
    pendingUsersByAction.get(action.clientActionId) ??
    pendingUserMessageFromPendingAction(action)
  );
}

/**
 * Reconstruct a pending user message from a pending action's fields.
 * Returns undefined if the action lacks the required fields.
 */
function pendingUserMessageFromPendingAction(
  action: PendingChatAction,
): PendingUserMessage | undefined {
  if (
    action.messageId === null ||
    action.restore === null ||
    action.sender === null ||
    action.settings === null ||
    // Joined the guard rather than being defaulted.
    action.accountContext === null
  ) {
    return undefined;
  }
  return {
    clientActionId: action.clientActionId,
    messageId: action.messageId,
    content: action.restore.content,
    attachments: buildAttachmentsFromJSONContent(action.restore.content),
    sender: action.sender,
    settings: action.settings,
    accountContext: action.accountContext,
    deliveryPolicy: action.deliveryPolicy,
    timestamp: action.createdAt,
    restore: action.restore,
    restoreWorktreeIntent: action.restoreWorktreeIntent,
  };
}

/** Check if a queue contains a send matching the given pending message id or content. */
function queueContainsPendingSend(
  queue: ChatQueueState,
  pendingMessageId: string,
  pendingUser: PendingUserMessage | undefined,
): boolean {
  const pendingUserMessageId = pendingUser?.messageId ?? null;
  let targetContent: string | null = null;
  let targetSender: string | null = null;
  let targetSettings: string | null = null;
  return queue.items.some((item) => {
    // A managed-command item is host-authored and content-free; it can never be
    // the queue's echo of the user's pending send.
    if (item.kind !== "prompt") return false;
    if (item.messageId === pendingMessageId) return true;
    if (pendingUser === undefined) return false;
    if (item.messageId === pendingUserMessageId) return true;
    if (targetContent === null) {
      targetContent = JSON.stringify(pendingUser.content);
      targetSender = JSON.stringify(pendingUser.sender);
      targetSettings = JSON.stringify(pendingUser.settings);
    }
    if (JSON.stringify(item.message.content) !== targetContent) return false;
    if (JSON.stringify(item.sender) !== targetSender) return false;
    return JSON.stringify(item.settings) === targetSettings;
  });
}

/**
 * Extract message ids from a message list. Used to determine which
 * pending actions have been confirmed by the host.
 */
function confirmedMessageIdsForMessages(
  messages: ReadonlyArray<Message>,
): Set<string> {
  return new Set(
    messages.flatMap((message) => {
      if (message.role === "user") return [message.messageId];
      return [];
    }),
  );
}

/**
 * Remove a pending action from the record by id. Returns the same object
 * if the action is not present (no allocation).
 */
export function withoutPendingAction(
  pendingActions: Readonly<Record<string, PendingChatAction>>,
  clientActionId: string,
): Readonly<Record<string, PendingChatAction>> {
  if (!Object.hasOwn(pendingActions, clientActionId)) return pendingActions;
  const next = { ...pendingActions };
  delete next[clientActionId];
  return next;
}

export interface AcceptedActionConfirmation {
  /** Whether host state in hand at this transition CONFIRMS the send. */
  readonly confirmedByHost: boolean;
  /** Whether transcript confirmation makes the display overlay obsolete. */
  readonly messageConfirmedByHost: boolean;
}

/**
 * Add a pending action as accepted to the record. Applies pruning to
 * enforce retention limits.
 */
export function addAcceptedAction(
  acceptedActions: Readonly<Record<string, AcceptedChatAction>>,
  pending: PendingChatAction,
  now: number,
  confirmation: AcceptedActionConfirmation,
): Readonly<Record<string, AcceptedChatAction>> {
  return pruneAcceptedActions(
    {
      ...acceptedActions,
      [pending.clientActionId]: {
        clientActionId: pending.clientActionId,
        action: pending.action,
        queueItemId: pending.queueItemId,
        interviewBlockId: pending.interviewBlockId,
        interviewDeliveryRetry: pending.interviewDeliveryRetry,
        messageId: pending.messageId,
        acceptedAt: now,
        restore: pending.restore,
        // The recovery tuple travels with the record now - see `AcceptedChatAction`. A queued send's ONLY
        // copy lives here between its accepted ack and the host's durable confirmation.
        sender: pending.sender,
        settings: pending.settings,
        accountContext: pending.accountContext,
        deliveryPolicy: pending.deliveryPolicy,
        restoreWorktreeIntent: pending.restoreWorktreeIntent,
        // Queue confirmation deliberately keeps this display copy: queued sends are accepted before their
        // deferred worktree setup begins.
        displayWorktreeIntent:
          pending.action === "editUserMessage" ||
          confirmation.messageConfirmedByHost
            ? null
            : pending.displayWorktreeIntent,
        connectionEpoch: pending.connectionEpoch,
        confirmedByHost: confirmation.confirmedByHost,
      },
    },
    now,
  );
}

/**
 * Prune accepted actions to enforce retention time limit (5 minutes) and record cap (64 records).
 * Prioritizes send/editUserMessage actions and recent entries.
 */
export function pruneAcceptedActions(
  acceptedActions: Readonly<Record<string, AcceptedChatAction>>,
  now: number,
): Readonly<Record<string, AcceptedChatAction>> {
  const RETENTION_MS = 5 * 60 * 1_000;
  const MAX_RECORDS = 64;

  const all = Object.values(acceptedActions);
  const lifecycleLocked = all.filter(isAcceptedActionLifecycleLocked);
  const prunable = all.filter(
    (action) => !isAcceptedActionLifecycleLocked(action),
  );

  const unexpired = prunable.filter(
    (action) => now - action.acceptedAt <= RETENTION_MS,
  );
  const retained =
    unexpired.length <= MAX_RECORDS
      ? unexpired
      : unexpired
          .toSorted(compareAcceptedActionForRetention)
          .slice(0, MAX_RECORDS);
  const kept = [...lifecycleLocked, ...retained];
  if (kept.length === all.length) {
    return acceptedActions;
  }
  return kept.reduce<Record<string, AcceptedChatAction>>((next, action) => {
    next[action.clientActionId] = action;
    return next;
  }, {});
}

/**
 * Retire accepted queue cancellations once an authoritative queue no longer contains their target.
 * Until then the record carries the optimistic projection across the ack-to-queue-update gap.
 */
export function withoutResolvedAcceptedQueueCancellations(
  acceptedActions: Readonly<Record<string, AcceptedChatAction>>,
  queue: ChatQueueState,
): Readonly<Record<string, AcceptedChatAction>> {
  const queueItemIds = new Set(queue.items.map((item) => item.queueItemId));
  const retained = Object.values(acceptedActions).filter(
    (action) =>
      action.action !== "queueCancel" ||
      action.queueItemId === null ||
      queueItemIds.has(action.queueItemId),
  );
  if (retained.length === Object.keys(acceptedActions).length) {
    return acceptedActions;
  }
  return retained.reduce<Record<string, AcceptedChatAction>>((next, action) => {
    next[action.clientActionId] = action;
    return next;
  }, {});
}

function isAcceptedActionLifecycleLocked(action: AcceptedChatAction): boolean {
  return (
    action.interviewBlockId !== null ||
    action.interviewDeliveryRetry !== null ||
    (action.action === "queueCancel" && action.queueItemId !== null)
  );
}

/**
 * Comparator for sorting accepted actions by retention priority.
 * Prioritizes send/editUserMessage actions and more recent entries.
 */
function compareAcceptedActionForRetention(
  a: AcceptedChatAction,
  b: AcceptedChatAction,
): number {
  const rankDelta =
    acceptedActionRetentionRank(b) - acceptedActionRetentionRank(a);
  if (rankDelta !== 0) return rankDelta;
  const timeDelta = b.acceptedAt - a.acceptedAt;
  if (timeDelta !== 0) return timeDelta;
  return a.clientActionId.localeCompare(b.clientActionId);
}

/**
 * Retention rank for an action type. Send and editUserMessage actions
 * rank higher (1) than other actions (0).
 */
function acceptedActionRetentionRank(action: AcceptedChatAction): number {
  return action.action === "send" || action.action === "editUserMessage"
    ? 1
    : 0;
}
