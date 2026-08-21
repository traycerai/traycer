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

/**
 * Notice code for a send whose text the CLIENT is the last holder of - the
 * message body is inlined in `ChatErrorNotice.message` because nothing else
 * holds it any more. The toast layer reads this twice: to REPLAY such a notice
 * when a pane focuses (the reconnect-while-away case is exactly when one
 * arrives, and an unreplayed one is a destroyed draft), and to keep it on
 * screen until dismissed. A notice carrying the only copy of someone's text
 * must neither be skipped nor expire on a timer.
 *
 * Both reconcile passes emit it, because both make the same promise: this
 * send is settled, its row is gone, and the text is right here.
 */
export const SEND_NOT_RECORDED_NOTICE_CODE = "SEND_NOT_RECORDED";

/**
 * Whether this notice inlines content nothing else holds any more. Both passes
 * settle the send and drop its row, so the message body in the notice IS the
 * draft - not a pointer to one.
 *
 * That makes it data rather than notice history, and it inherits every
 * durability obligation the row had: the store never evicts it from the
 * capped ring, and the toast layer both replays it on focus and refuses to
 * expire it. One definition, because all three would otherwise drift apart.
 */
export function noticeCarriesOnlyCopy(notice: ChatErrorNotice): boolean {
  return notice.code === SEND_NOT_RECORDED_NOTICE_CODE;
}

/**
 * Input for queue reconciliation. Contains the immutable state slices needed
 * to determine which pending actions have been queued and should transition
 * to accepted actions.
 */
export type ReconcileQueueInput = {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly queue: ChatQueueState;
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
  /**
   * The connection this snapshot arrived on. Absence from a snapshot is only
   * EVIDENCE for an action dispatched on an earlier connection, whose ack died
   * with it; a same-connection dispatch can be missing simply because the host
   * built the snapshot before the frame reached it. See
   * {@link reconcileSnapshotChange}.
   */
  readonly connectionEpoch: number;
  /** The chat's settings as of this snapshot - see {@link settingsDriftClause}. */
  readonly currentSettings: ChatRunSettings | null;
  /** The account a resend would bill - see {@link accountDriftClause}. */
  readonly currentAccountContext: AccountContext | null;
  /** See {@link WorktreeSweptPredicate}. */
  readonly worktreeWasSwept: WorktreeSweptPredicate;
  readonly nowMs: number;
};

/**
 * Whether a sweep removed this intent's worktree while its dispatch was in
 * flight.
 *
 * Injected rather than read, because the answer lives in the staging store and
 * both reconcile passes are pure. The passes STATE displaced sends, and a
 * statement naming a deleted worktree as re-pickable is the same defect the
 * restore paths already guard - so they have to be able to ask.
 */
export type WorktreeSweptPredicate = (intent: WorktreeIntent) => boolean;

/** A send with no staged worktree has none to have lost. */
function worktreeGoneFor(
  intent: WorktreeIntent | null,
  wasSwept: WorktreeSweptPredicate,
): boolean {
  return intent !== null && wasSwept(intent);
}

/**
 * Output patch for snapshot reconciliation. Contains updated state slices
 * to apply to the store, including the failedSendRestoration field.
 *
 * `appendedErrorNotices` is a DELTA - only the notices this pass produced, in
 * order - not the store's ring. The caller appends them onto its own
 * `errorNotices` (that is where the FIFO cap lives), so an empty delta writes
 * nothing. Named so it cannot collide with the `errorNotices` STATE key: the
 * settled patch below is applied by spreading it into the state update, and a
 * colliding name would silently replace the ring with the delta.
 */
export type ReconcileSnapshotPatch = {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly acceptedActions: Readonly<Record<string, AcceptedChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly failedSendRestoration: FailedSendRestorationState | null;
  readonly appendedErrorNotices: ReadonlyArray<ChatErrorNotice>;
  /**
   * The staged worktree choice belonging to the send whose prompt just claimed
   * the restoration slot, for the caller to re-stage under the revision guard.
   * A prompt handed back WITHOUT its binding is the silent-local-run hazard:
   * the resubmit looks identical and runs somewhere else. `null` when this
   * pass restored nothing, or when the restored send carried no staged choice.
   */
  readonly restoredWorktreeIntent: StagedWorktreeIntentSource | null;
};

/**
 * The statement for a dead send that could not claim the single
 * `failedSendRestoration` slot.
 *
 * The slot is deliberately first-writer-wins - the earlier send has waited
 * longest, and last-wins would bury it - so a displacement is expected. What
 * must not happen is a displaced send going quiet: the rejection ack path
 * already pairs the same rule with an `errorNotice`, and this is that
 * statement for both reconcile passes.
 *
 * It INLINES the message body, because by the time this fires the client is
 * the last holder of that text. Both passes settle the send outright - row
 * dropped, action dropped - so there is no surviving row to point at. That is
 * deliberate on both: a row that will never confirm keeps edit/delete gated
 * off and renders a user message the host never recorded, and (on the
 * reconnect path) an action left restoration-eligible re-states itself on
 * every later snapshot and pushes stale text back into the composer after the
 * user has already resent it.
 *
 * What survives the trip is TEXT, and {@link classifyContentRecovery} decides
 * what that costs. The criterion there is whether a loss is INVISIBLE in the
 * projected text and so unretypeable - attachment bytes, a mention's binding,
 * a quote's provenance - not whether the projection is byte-identical.
 * Markdown structure is visible in its absence and would only add noise.
 *
 * The classification is total and fails CLOSED, so a node kind nobody has
 * classified earns a generic qualification rather than passing as complete.
 * This defect shipped three times running - attachments, then mentions, then
 * sourced quotes - because each was fixed as itself; driving the clauses off
 * one classification is what makes a fourth a test failure instead.
 */
/**
 * The one sentence that says a prompt came back WITHOUT the worktree it was
 * staged for, because a sweep removed that worktree while the dispatch was in
 * flight.
 *
 * Four surfaces owe it - the snapshot pass, the settled-turn pass, a
 * rejection's own notice, and a rejection DISPLACED into the statement
 * builder - and they reach it three different ways: two append it to
 * `failedSendRestoration.reason` (the composer says it), one appends it to
 * the rejection's `errorNotice` (its own surface already speaks there), and
 * the fourth needs {@link UnrecoverableSend.worktreeGone} instead, because a
 * statement names the branch and must not name it as re-pickable.
 *
 * It is a CONSTANT rather than three literals because it was three literals:
 * the fourth surface was missed twice running, and each miss was found only
 * after shipping. Nothing here can enforce that a new surface asks the
 * question, but nothing should be able to ask it and then phrase the answer
 * differently.
 */
export const WORKTREE_GONE_STATEMENT =
  "Its staged worktree no longer exists, so it was not restored.";

export interface UnrecoverableSend {
  readonly clientActionId: string;
  readonly content: JsonContent;
  /** How this send died, phrased to open the statement. */
  readonly circumstance: string;
  readonly worktreeIntent: WorktreeIntent | null;
  /**
   * Whether a sweep removed {@link worktreeIntent}'s worktree while this
   * dispatch was in flight. REQUIRED, and deliberately not defaulted: the
   * clause below names a branch to go re-pick, and naming a deleted one sends
   * someone after a worktree that is not there. A new caller has to answer it.
   */
  readonly worktreeGone: boolean;
  readonly sentSettings: ChatRunSettings | null;
  readonly currentSettings: ChatRunSettings | null;
  readonly sentAccountContext: AccountContext | null;
  readonly sentDeliveryPolicy: ChatQueueDeliveryPolicy | null;
  readonly currentAccountContext: AccountContext | null;
}

export function unrecoverableSendNotice(
  send: UnrecoverableSend,
): ChatErrorNotice {
  const { clientActionId, content, circumstance, worktreeIntent } = send;
  // The quote is VERBATIM; only the branch decision is trimmed. A message of
  // pure whitespace has nothing to hand back, but a code block whose first
  // line is indented very much does - and trimming the quote itself is what
  // used to corrupt it.
  const text = recoveryTextFromContent(content);
  const hasText = text.trim().length > 0;
  const losses = classifyContentRecovery(content);
  const attachments = losses.get("attachment") ?? 0;
  const preamble = `${circumstance}, and another unsent message is already waiting in the composer.`;
  return {
    code: SEND_NOT_RECORDED_NOTICE_CODE,
    message: statementQuoting(
      [
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
        // The quoted text is right there in the copy below, `> ` and all -
        // what does not survive is that it was QUOTED. Both paste paths
        // dissolve a blockquote, so the resend reads as ordinary prose and the
        // agent is no longer told which part was being asked about.
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
        worktreeClause(worktreeIntent, send.worktreeGone),
        deliveryClause(send.sentDeliveryPolicy),
        settingsDriftClause(
          send.sentSettings,
          send.currentSettings,
          send.sentAccountContext,
          send.currentAccountContext,
        ),
      ].join(""),
      hasText ? text : null,
    ),
    severity: "warning",
    clientActionId,
  };
}

/**
 * The one place the quoted draft is separated from everything said about it.
 *
 * The draft goes LAST and runs to the end of the notice. Every clause is said
 * ahead of it, because the draft is the single part of this statement whose
 * extent the statement does not control: it is verbatim user text of any
 * shape, and the toast renders the notice pre-wrapped, so a clause after a
 * multi-line draft reads as one more line of the user's own message. Ending
 * at the draft makes "from the marker to the end" an exact description of
 * what to copy - which is the gesture the notice is asking for.
 *
 * Fences would read better and cannot be used: the draft is VERBATIM and may
 * carry a fence line of its own, and a delimiter the payload can forge is not
 * a delimiter. Position cannot be forged.
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
 * A PARTIAL loss, and worth its own sentence: the projected text above is real
 * and pasteable, but it pastes as prose. Only re-picking restores the binding
 * the agent actually reads.
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

/**
 * The staged worktree a STATED send was going to run in.
 *
 * Unlike the restored send's, this binding cannot be handed back: the staging
 * slot is single and per chat, and the send that won the restoration slot
 * rightfully holds it. So this is a statement obligation rather than a restore
 * one - the same rule as the text itself. Naming the branch makes it
 * actionable: re-picking blind is how the resubmit silently runs somewhere
 * else, which is exactly what the restore path exists to prevent.
 */
/**
 * What the send was queued to WAIT for, when it was not the default.
 *
 * Delivery is dispatched per send and dies with the action, so a resend takes
 * whatever the composer's submit gesture implies now: a message deliberately
 * queued to land after the running turn's safe point can come back and
 * interrupt instead. Stated only when non-default, on the same rule the
 * settings drift follows - naming `auto` every time would bury the case that
 * matters.
 */
function deliveryClause(policy: ChatQueueDeliveryPolicy | null): string {
  if (policy === null || policy === "auto") return "";
  const described =
    policy === "after_safe_point"
      ? "after the running turn reached a safe point"
      : "after the running turn finished";
  return ` It was queued to be delivered ${described}; a resend goes by whatever you choose then.`;
}

function worktreeClause(
  intent: WorktreeIntent | null,
  worktreeGone: boolean,
): string {
  if (intent === null) return "";
  // `WorktreeIntent` permits one entry per workspace folder, so a multi-repo
  // staging read as "branch a, branch b" with no way to tell which repo each
  // belonged to - unre-pickable. Qualified only when there is more than one:
  // with a single workspace the association is unambiguous and naming it would
  // be noise in the common case.
  const qualify = intent.entries.length > 1;
  const labels = intent.entries.flatMap((entry) => {
    const label = worktreeEntryLabel(entry);
    if (label === null) return [];
    return qualify && entry.workspacePath.length > 0
      ? [`${label} in ${entry.workspacePath}`]
      : [label];
  });
  if (labels.length === 0) return "";
  // A swept worktree is not re-pickable, so the clause must not ask for it.
  // Naming it is still right - it is what the send was going to run in, and
  // silence would leave the resend looking identical to the original - but the
  // ask changes from "re-pick that" to "pick something else".
  if (worktreeGone) {
    return ` It was staged to run in ${labels.join(", ")}, which no longer exists - a resend runs against this chat's current worktree unless you pick another.`;
  }
  return ` It was staged to run in ${labels.join(", ")} - re-pick that before resending, or it runs against this chat's current worktree.`;
}

/**
 * How to NAME a staged entry so the user can re-pick it deliberately.
 *
 * Every kind gets one. "No branch to re-pick" is not "nothing to state": a
 * `local` entry is a decision to run against a particular workspace checkout
 * and an `import` adopts a particular on-disk worktree, so a send staged to
 * switch to either and then settled silently resends against the previous
 * binding - the same silent-wrong-worktree hazard the branch case covers.
 * Returns `null` only when the entry names nothing usable.
 */
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
      // A new entry kind must be NAMED here, not absorbed by an else-branch
      // that labels it "the workspace checkout" and quietly misdescribes what
      // the send was staged to do. Same fail-closed rule the content
      // classification follows, enforced at compile time.
      return assertNeverEntry(entry);
  }
}

/**
 * What the send was going to RUN under, when that differs from what a resend
 * would use now.
 *
 * The dead send's `settings` die with it, so resending picks up the chat's
 * current pick - a different model, profile or permission mode changes what
 * the agent does, silently. Only the DIFFERING fields are named: stating the
 * full tuple every time is noise that buries the one field that moved, and a
 * send whose settings still match needs no clause at all.
 */
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
  // Two comparisons with DIFFERENT preconditions, which is why they are no
  // longer behind one gate. Billing is not a run setting - the drift record's
  // key type says so explicitly - and a chat that has never run has
  // `chat.settings === null` until its first turn. Sharing the run-settings
  // gate meant an initial send displaced while the user switched Personal ->
  // Team said nothing about which account the resend would charge, even though
  // both account contexts were present and comparable the whole time.
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
  // Keyed by `keyof ChatRunSettings`, NOT `Record<string, ...>`. The earlier
  // shape validated value TYPES only - it never required every field - so the
  // comment claiming a new setting would be forced into the comparison was
  // false, and a new field would have gone uncompared in silence. This shape
  // fails to COMPILE when one is missing, which is what that claim was
  // supposed to buy.
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

/**
 * Billing, compared on its OWN terms.
 *
 * It rides alongside the run settings rather than inside them, and it is the
 * one drift with a money consequence - which account a resend charges - so it
 * is exactly the field that must not be silenced by an unrelated absence.
 */
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
 * A `worktree` entry is more than its branch name - a fork source, carried
 * uncommitted changes, setup/teardown overrides. The label cannot carry all of
 * that legibly, and the obligation is HONESTY rather than completeness: name
 * what is compactly nameable, and say plainly when the rest has to be
 * re-configured. Naming only the branch invites a re-pick that behaves
 * differently from what the send was actually staged to do.
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
 * Reconcile pending actions when the queue changes. Transitions pending
 * actions that are now in the queue to accepted actions.
 *
 * Pure function - all timing inputs must be passed explicitly.
 */
export function reconcileQueueChange(
  input: ReconcileQueueInput,
): ReconcileQueuePatch {
  const queuedPendingActionIds = pendingActionIdsForQueuedMessages(
    input.pendingActions,
    input.pendingUserMessages,
    input.queue,
  );
  if (queuedPendingActionIds.size === 0) {
    return {
      pendingActions: input.pendingActions,
      acceptedActions: {},
      pendingUserMessages: input.pendingUserMessages,
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
      (next, action) => addAcceptedAction(next, action, input.nowMs),
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
  };
}

/**
 * Reconcile pending actions against a snapshot. Clears pending actions whose
 * messages have been confirmed in the snapshot or are in the queue.
 *
 * Two kinds of conclusion live here and they have different evidence bars.
 * PRESENCE - the message is in `messages` or the queue - is authoritative
 * whatever connection dispatched it. ABSENCE is not: it settles a send only
 * when that send was dispatched on an EARLIER connection, matching the bar
 * {@link sweepStalePendingActions} applies to every other action kind. A
 * same-connection dispatch missing from a snapshot has simply outrun it.
 *
 * That is not a rare race. The host broadcasts snapshots on a LIVE connection
 * for many unrelated reasons - `finishActiveTurn` pushes one at every turn
 * end, the pump-backlog backfill pushes another - and one built before the
 * host processed the send frame naturally lacks the message without that send
 * being lost. Its ack (or `messageAccepted`) is still coming; if the
 * connection drops first the epoch bumps and the next snapshot settles it
 * truthfully.
 *
 * Pure function - all timing inputs must be passed explicitly.
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
  };
  return Object.values(input.pendingActions).reduce(
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
          ),
          pendingUserMessages: next.pendingUserMessages.filter(
            (message) => message.clientActionId !== pending.clientActionId,
          ),
        };
      }
      // Nothing to restore and nothing lost: the send stays pending and no
      // statement is owed.
      if (pending.restoreContent === null) {
        return next;
      }
      // Everything below settles on ABSENCE, and absence is only evidence for
      // a dispatch from a dead connection. A send issued after this connection
      // reached `open` - the composer gate reopens there, before the initial
      // snapshot lands - is legitimately missing from a snapshot the host
      // built first, and its accepted ack is still on its way. Settling it
      // would restore or state text that is about to materialize anyway: the
      // same manufactured duplicate this pass exists to prevent, one side over.
      // Its ack, or the next connection's snapshot, settles it truthfully.
      if (pending.connectionEpoch >= input.connectionEpoch) {
        return next;
      }
      // The slot is taken by a longer-waiting send. Keep first-writer-wins,
      // but SETTLE this one rather than leaving it parked: its ack died with
      // the connection and this snapshot is authoritative, so it can never
      // confirm. Leaving it eligible re-stated it on every later snapshot
      // (polluting the notice ring until it evicted unrelated entries) and
      // let the slot re-claim it once freed, pushing stale text into the
      // composer after the user had followed the advice and resent it. The
      // statement carries the text, since nothing holds it once the row goes.
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
              content: pending.restoreContent,
              circumstance: "A message was not confirmed after reconnect",
              worktreeIntent: pending.restoreWorktreeIntent,
              worktreeGone: worktreeGoneFor(
                pending.restoreWorktreeIntent,
                input.worktreeWasSwept,
              ),
              sentSettings: pending.settings,
              currentSettings: input.currentSettings,
              sentAccountContext: pending.accountContext,
              sentDeliveryPolicy: pending.deliveryPolicy,
              currentAccountContext: input.currentAccountContext,
            }),
          ],
        };
      }
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
          content: pending.restoreContent,
          reason: "Message was not confirmed after reconnect.",
        },
        // The prompt goes back to the composer, so its worktree goes back to
        // the staging slot with it.
        restoredWorktreeIntent: pending,
      };
    },
    initial,
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
  /** See {@link WorktreeSweptPredicate}. */
  readonly worktreeWasSwept: WorktreeSweptPredicate;
};

export type ReconcileTurnSettledPatch = {
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly failedSendRestoration: FailedSendRestorationState | null;
  /** Delta, appended by the caller - see {@link ReconcileSnapshotPatch}. */
  readonly appendedErrorNotices: ReadonlyArray<ChatErrorNotice>;
  /** See {@link ReconcileSnapshotPatch.restoredWorktreeIntent}. */
  readonly restoredWorktreeIntent: StagedWorktreeIntentSource | null;
};

/**
 * Whether a `turnStateChanged` frame or `chat.subscribe` snapshot reports the
 * turn settled: the host's own `turnInProgress` when present, with the
 * `runStatus` idle read as the fallback for an older host that predates the
 * field. A settled report is the trigger for {@link reconcileTurnSettled}.
 */
export function turnSettledFromStatus(
  turnInProgress: boolean | undefined,
  runStatus: ChatRunStatus,
): boolean {
  return turnInProgress === undefined ? runStatus === "idle" : !turnInProgress;
}

/**
 * Drop stranded optimistic user messages when the turn settles.
 *
 * An accepted send ack deliberately keeps its `pendingUserMessages` entry
 * alive - the durable `messageAccepted` frame is what normally clears it. A
 * stop during turn activation can abort the send after the accepted ack but
 * before the host appends the message, in which case neither
 * `messageAccepted` nor a rejected ack ever arrives and the entry would
 * survive indefinitely - keeping edit/delete gated off and rendering a user
 * message the host never recorded. A settled report is the authoritative
 * "this send will never materialize" signal. It arrives two ways, and this
 * runs on both: a live `turnStateChanged` frame, and a re-subscribe snapshot
 * (`reconcileSnapshotChange` only settles sends still in `pendingActions`,
 * so an already-acked entry needs this pass on reconnect too).
 *
 * An entry survives while a path to materialization remains open: its ack is
 * still in flight (`pendingActions`) or it was parked in the queue (a later
 * `queueChanged`/`messageAccepted` settles it, and the mutation gate stays
 * closed on the queue anyway). An entry whose message already reached the
 * transcript is stale bookkeeping - dropped without restoration. Truly dead
 * entries are dropped and the first one's content is restored to the
 * composer via the `failedSendRestoration` slot (single-slot; an occupied
 * slot is never overwritten).
 *
 * Every OTHER truly-dead entry - the ones the single slot cannot take - is
 * stated via {@link unrecoverableSendNotice}, which inlines the message body.
 * Dropping the row is correct here but it takes the last copy of that text
 * with it, so the statement has to carry the text or the send is simply gone.
 * An entry already in the transcript needs no notice: dropping it loses
 * nothing.
 *
 * The invariant both passes now share: a dead send is either RESTORED to the
 * composer (it won the slot) or STATED with its text inlined (it did not).
 * Never both - which is what made the reconnect path manufacture duplicate
 * sends - and never neither.
 *
 * Pure function - all state is passed explicitly. `settled` is
 * {@link turnSettledFromStatus}'s answer for the triggering frame/snapshot; a
 * non-settled report returns the input slices unchanged.
 */
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
    };
  }
  const restorable = stranded.find(
    (message) => !confirmedMessageIds.has(message.messageId),
  );
  const strandedActionIds = new Set(
    stranded.map((message) => message.clientActionId),
  );
  // Who actually gets the composer back: `restorable` only claims the slot
  // when it is free, because the slot is first-writer-wins. Everyone else
  // whose message never reached the transcript is losing their only copy, so
  // each of them is stated with their text inlined - not just the first.
  const slotClaimantActionId =
    input.failedSendRestoration === null && restorable !== undefined
      ? restorable.clientActionId
      : null;
  return {
    pendingUserMessages: input.pendingUserMessages.filter(
      (message) => !strandedActionIds.has(message.clientActionId),
    ),
    failedSendRestoration:
      input.failedSendRestoration !== null || restorable === undefined
        ? input.failedSendRestoration
        : {
            clientActionId: restorable.clientActionId,
            content: restorable.content,
            reason: "The message was not recorded before the turn stopped.",
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
          worktreeIntent: message.restoreWorktreeIntent,
          worktreeGone: worktreeGoneFor(
            message.restoreWorktreeIntent,
            input.worktreeWasSwept,
          ),
          sentSettings: message.settings,
          currentSettings: input.currentSettings,
          sentAccountContext: message.accountContext,
          sentDeliveryPolicy: message.deliveryPolicy,
          currentAccountContext: input.currentAccountContext,
        }),
      ),
  };
}

export interface StalePendingActionsSweep {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly sweptActionIds: ReadonlySet<string>;
}

const NO_SWEPT_ACTION_IDS: ReadonlySet<string> = new Set();

/**
 * Drop pending actions dispatched on an earlier connection than the
 * snapshot's. Their `actionAck` died with the dropped stream (frames and
 * acks are fire-and-forget per connection), so keeping them would leave
 * their controls (Stop, restore/revert, message edit, plan approval, queue
 * edits) disabled forever. The arriving snapshot is the authority on what
 * actually happened; dropping the pending re-enables the control so the user
 * can re-issue against that state. Only `send` is excluded -
 * `reconcileSnapshotChange` settles sends by messageId, restoring an
 * unconfirmed send's content to the composer, a path no other kind has
 * (a stale APPLIED `editUserMessage` shows in the snapshot's messages
 * either way; only its accepted-action bookkeeping entry is skipped).
 *
 * Pure function; only ever driven by an authoritative snapshot, never by a
 * connection-status event (a transient wobble must not cancel anything).
 * Returns the swept ids so the caller can settle sibling records keyed by
 * the same `clientActionId` (background stops) without re-deriving them.
 */
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
 * Find all pending action ids that correspond to messages already in the queue.
 * Used during queue reconciliation to identify which pending actions to promote
 * to accepted.
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
    action.restoreContent === null ||
    action.sender === null ||
    action.settings === null
  ) {
    return undefined;
  }
  return {
    clientActionId: action.clientActionId,
    messageId: action.messageId,
    content: action.restoreContent,
    sender: action.sender,
    settings: action.settings,
    accountContext: { type: "PERSONAL" },
    deliveryPolicy: null,
    timestamp: action.createdAt,
    restoreWorktreeIntent: action.restoreWorktreeIntent,
  };
}

/**
 * Check if a queue contains a send matching the given pending message id
 * or content. Matches by message id first, then falls back to content
 * equality for pending messages not yet assigned an id by the host.
 */
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

/**
 * Add a pending action as accepted to the record. Applies pruning to
 * enforce retention limits.
 */
export function addAcceptedAction(
  acceptedActions: Readonly<Record<string, AcceptedChatAction>>,
  pending: PendingChatAction,
  now: number,
): Readonly<Record<string, AcceptedChatAction>> {
  return pruneAcceptedActions(
    {
      ...acceptedActions,
      [pending.clientActionId]: {
        clientActionId: pending.clientActionId,
        action: pending.action,
        interviewBlockId: pending.interviewBlockId,
        messageId: pending.messageId,
        acceptedAt: now,
        restoreContent: pending.restoreContent,
      },
    },
    now,
  );
}

/**
 * Prune accepted actions to enforce retention time limit (5 minutes) and
 * record cap (64 records). Prioritizes send/editUserMessage actions and
 * recent entries. Returns the same object if no pruning is needed.
 *
 * An accepted-but-unresolved interview action (`interviewBlockId !== null`)
 * is a lifecycle lock, not generic action history: the UI busy-gate and the
 * duplicate-dispatch guard both read it via `existingInterviewActionId`, and
 * it must survive until the host's `interviewAnswered`/`interviewErrored`
 * frame authoritatively clears it (`withoutInterviewActionsForBlock`).
 * Exempt it from the retention window and record cap below, or a
 * slow-to-resolve interview (or enough unrelated traffic to evict it from the
 * cap) would silently un-gate a duplicate submission before the host
 * responds.
 */
export function pruneAcceptedActions(
  acceptedActions: Readonly<Record<string, AcceptedChatAction>>,
  now: number,
): Readonly<Record<string, AcceptedChatAction>> {
  const RETENTION_MS = 5 * 60 * 1_000;
  const MAX_RECORDS = 64;

  const all = Object.values(acceptedActions);
  const interviewLocked = all.filter(
    (action) => action.interviewBlockId !== null,
  );
  const prunable = all.filter((action) => action.interviewBlockId === null);

  const unexpired = prunable.filter(
    (action) => now - action.acceptedAt <= RETENTION_MS,
  );
  const retained =
    unexpired.length <= MAX_RECORDS
      ? unexpired
      : unexpired
          .toSorted(compareAcceptedActionForRetention)
          .slice(0, MAX_RECORDS);
  const kept = [...interviewLocked, ...retained];
  if (kept.length === all.length) {
    return acceptedActions;
  }
  return kept.reduce<Record<string, AcceptedChatAction>>((next, action) => {
    next[action.clientActionId] = action;
    return next;
  }, {});
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
