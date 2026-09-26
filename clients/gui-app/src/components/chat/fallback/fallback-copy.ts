import {
  fallbackRungRefusalKindSchema,
  type ChatFallbackListTargetsResponse,
  type FallbackActionOutcome,
  type FallbackRungRefusalDetail,
  type FallbackRungRefusalKind,
} from "@traycer/protocol/host/chat-fallback";
import type {
  FallbackSwitchDisposition,
  FallbackWaitDisposition,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { FALLBACK_REASON_LABELS } from "@traycer/protocol/host/notifications/presentation";
import { limitedFamilyQualifier } from "@/lib/rate-limits/rate-limit-copy";
import type { ProfileRateLimitSeverity } from "@/lib/rate-limits/rate-limit-scope-match";

/**
 * User-facing copy for the provider-fallback chat surfaces.
 *
 * Centralised because the vocabulary is FIXED by the UX spec's table and is the
 * kind of thing that drifts one card at a time. The words that must never
 * appear anywhere below: "tier", "ladder", "rung", "grace", "fallback",
 * "Inherit", a raw reason code, or a time this client invented. The words that
 * must: "profile", "Terminal account", "equivalent model", "Don't switch",
 * "Stop waiting", and provider names from `PROVIDER_DISPLAY_NAMES`.
 *
 * A bare "Cancel" is banned for the card refusals on purpose: every one keeps
 * the error and leaves the queue paused, so "Cancel" would read as a no-op
 * undo of something that has not happened yet.
 *
 * No text-link actions (user ruling, 2026-09-26). Every label below that names
 * an action is rendered on a real `Button` with a variant - one filled primary
 * per card, the rest outlined - and never as a link or a ghost caption. A
 * routing card's settings entry is its gear icon, not a "Model routing" link.
 */

/**
 * The reason a traversal armed, as a short label - or `null`.
 *
 * A MAP built from the shared record rather than a direct index, because the
 * DTO's `reason` is an open `string` on the wire (deliberately: the value
 * travels from a provider adapter, and a strict enum there would fail the whole
 * frame over a field that is only ever rendered as a label). Indexing a
 * `Record<HostNotificationStoppedReason, string>` with that string is exactly
 * the cast the type-safety table forbids, so this goes through a `Map` whose
 * key type is `string` by construction.
 *
 * `null` for a reason this build has never heard of, and the caller then omits
 * the label entirely. That is the one behaviour that stays honest either way:
 * printing the raw code would put `provider_connection_failed` in front of a
 * user, which the vocabulary table bans, and inventing a generic phrase would
 * assert a category we did not receive.
 */
const REASON_LABEL_BY_CODE: ReadonlyMap<string, string> = new Map(
  Object.entries(FALLBACK_REASON_LABELS),
);

export function fallbackReasonLabelFor(reason: string): string | null {
  return REASON_LABEL_BY_CODE.get(reason) ?? null;
}

/** "Don't switch" - the countdown card's refusal for a switch. Never "Cancel". */
export const DONT_SWITCH_LABEL = "Don't switch";
/** The countdown card's refusal when the plan is a wait. */
export const DONT_WAIT_LABEL = "Don't wait";
/** "Stop waiting" - the waiting card's and the background row's refusal. */
export const STOP_WAITING_LABEL = "Stop waiting";
/**
 * The countdown card's productive action, one per plan: end the countdown now
 * and let the step the host planned run (`chat.fallback.proceed`). Two, not
 * three: a countdown never plans a retry (the transient series arms straight
 * into `retrying`, with no window to end early).
 */
export const SWITCH_NOW_LABEL = "Switch now";
export const WAIT_NOW_LABEL = "Wait now";
/**
 * The picker's entry where there is no destination chip to click: beside the
 * tuple on a wait plan, and as the waiting card's filled button.
 */
export const CHOOSE_ANOTHER_MODEL_LABEL = "Choose another model…";
/**
 * The failed-turn card's picker trigger.
 *
 * Nothing is in motion on a failed row, so the switch IS the action rather than
 * an alternative to one - hence a verb and a destination to come, not
 * "instead" or "another".
 */
export const SWITCH_LABEL = "Switch to…";
export const SIGN_IN_INSTEAD_LABEL = "Sign in instead";
/** The return card's three answers, in the order the card draws them. */
export const SWITCH_BACK_LABEL = "Switch back";
export const DONT_ASK_FOR_CHAT_LABEL = "Don't ask for this chat";
/**
 * Beside a disabled action row while the chat stream is down (or this reader
 * cannot steer the chat). Without it the greyed buttons read as broken.
 */
export const RECONNECTING_LABEL = "Reconnecting…";
/** Beside the countdown card's disabled row while the host resolves its plan. */
export const DECIDING_LABEL = "Deciding…";
/**
 * The routing card's hide control, as its tooltip says it. Hiding cancels
 * nothing - the countdown or the wait runs on - which is the one thing a user
 * might fear a × does here.
 */
export const HIDE_ROUTING_CARD_LABEL = "Hide. Routing continues.";
/** The gear's accessible name: what the icon opens. */
export const ROUTING_SETTINGS_LABEL = "Model routing settings";
/** The waiting card's pill: a wait moves nothing. */
export const SAME_SESSION_LABEL = "same settings, same session";
/**
 * The settings entry on surfaces that still carry one as a labelled button -
 * the divider notices' expanded details and the resumed-turn marker. Routing
 * cards carry a gear instead ({@link ROUTING_SETTINGS_LABEL}).
 *
 * "Model routing", not "Fallback settings": "fallback" named a mechanism, and
 * the feature is a routing table the user authors.
 */
export const FALLBACK_SETTINGS_LABEL = "Model routing";
/** The settled card's receipt when routing ran no step at all. */
export const NOTHING_COULD_BE_TRIED_LABEL = "Nothing could be tried";
/** The settled card's disclosure over the host's raw detail rows. */
export const BUG_REPORT_DETAILS_LABEL = "Details for a bug report";
/**
 * The Message Queue panel's paused pill when the host paused it because a turn
 * failed (`queue.pausedReason` `turn_error` / `routing`), and its tooltip.
 */
export const QUEUE_PAUSED_AFTER_ERROR_LABEL = "Paused after an error";
export const QUEUE_PAUSED_AFTER_ERROR_TOOLTIP =
  "Held because the last turn failed. Retry or switch sends it after; Resume sends it now.";

/**
 * "New session from this transcript" - the cost line's own form of
 * {@link FRESH_SESSION_HELPER}, one clause among others on a line joined with
 * " · " rather than a sentence of its own.
 */
export const NEW_SESSION_CLAUSE = "New session from this transcript";

/**
 * What a switch costs, stated on every surface that offers one.
 *
 * Not a warning and not hedging: a fresh provider session is a real consequence
 * (context is reseeded from the transcript) and the user is entitled to know it
 * before a countdown spends it for them.
 */
export const FRESH_SESSION_HELPER =
  "Starts a fresh session from this transcript.";

/**
 * "N queued messages will run on the new settings too."
 *
 * Hidden at zero rather than rendered as "0 queued messages", which reads as a
 * problem. The count is the DTO's `queuedItemsMoving`, which is the same
 * derivation the settle's own notice uses - so the card cannot promise to move
 * a different number than the host reports afterwards.
 */
export function queuedMessagesMovingText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 queued message will run on the new settings too."
    : `${count} queued messages will run on the new settings too.`;
}

/**
 * What picking a destination actually DOES, said before any row is clicked.
 *
 * The grace card states this above its menu because the card itself carries
 * {@link FRESH_SESSION_HELPER}; the error card and the waiting card had no
 * equivalent anywhere, and their trigger is a bare "Switch…" / "Switch
 * instead…" - which reads perfectly well as changing a setting for the NEXT
 * message. It is not: the pick replays the failed message immediately, in a
 * new provider session, and takes the queue with it. Three consequences the
 * user was finding out about afterwards.
 *
 * `queuedItemsMoving` is `null` where no count exists - the error card acts on
 * a failed ATTEMPT and its DTO carries no queue figure - and the copy then
 * says the true thing without a number rather than guessing one or staying
 * silent about the queue entirely.
 */
export function switchConsequencesText(
  queuedItemsMoving: number | null,
): string {
  const queued =
    queuedItemsMoving === null
      ? "Any queued messages move with it."
      : queuedMessagesMovingText(queuedItemsMoving);
  const replay = `Replays this message on the destination you pick. ${FRESH_SESSION_HELPER}`;
  return queued === null ? replay : `${replay} ${queued}`;
}

/**
 * "and moves N queued messages back".
 *
 * A clause rather than a sentence: the announcer states the return's whole
 * consequence in one line ("Applies to your next message and moves 2 queued
 * messages back"), because switching back moving the queue too is the one
 * rule that copy has to carry. Leaving the queue on the previous account while
 * the next fresh send routes to the preferred one would interleave two
 * providers in one chat with nobody told.
 *
 * The queue helpers say deliberately DIFFERENT things and must not converge: a
 * wait moves nothing, a switch moves messages forward onto new settings, and a
 * return moves them back (see {@link queuedWaitingClause} and its siblings for
 * the cards' forms). Hidden at zero.
 */
export function queuedMessagesReturningText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? " and moves 1 queued message back"
    : ` and moves ${count} queued messages back`;
}

/**
 * "work-account is running low on Fable usage" - the advisory clause the return
 * banner absorbs.
 *
 * The banner outranks the rate-limit advisory in the composer's one-at-a-time
 * chain, so without this the user answering "Stay" lost the one fact that
 * argues against staying: the account they would be staying on is itself
 * running out. Taking the SLOT and dropping the SENTENCE is what MF09 found;
 * UX §2 asks for one banner carrying both facts, not a collision resolved by
 * silence.
 *
 * The wording is the advisory banner's own, deliberately
 * (`profile-rate-limit-switch-banner.tsx` renders the same two arms with the
 * same family qualifier): the user may see this clause here and the full
 * advisory a message later, and two wordings for one reading would read as two
 * different findings. A CLAUSE rather than a sentence - the headline joins it
 * to the reset with "and", which is the shape UX §2 spells out.
 *
 * `limitedFamilies` is empty when the triggering limit is shared or per-scope
 * data is unavailable; the copy is then profile-wide, exactly as the advisory's
 * is.
 */
export function fallbackLowUsageClause(input: {
  readonly accountName: string;
  readonly severity: ProfileRateLimitSeverity;
  readonly limitedFamilies: ReadonlyArray<string>;
}): string {
  // The SAME qualifier the composer's advisory builds, from one module, so the
  // absorbed clause and the full advisory cannot drift into two wordings of one
  // finding.
  const qualifier = limitedFamilyQualifier(input.limitedFamilies);
  return input.severity === "hard_limit"
    ? `${input.accountName} has reached its ${qualifier}rate limit`
    : `${input.accountName} is running low on ${qualifier}usage`;
}

/**
 * "N other chats in this task are also switching" - a cost-line clause.
 *
 * Informational only - there is no action, and deliberately so: picks are per
 * chat (the task-wide variant was designed and dropped). Hidden at zero.
 */
export function siblingSwitchingClause(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 other chat in this task is also switching"
    : `${count} other chats in this task are also switching`;
}

/**
 * The routing cards' cost-line clauses. Each is a CLAUSE, joined with the
 * others by " · " on one line that appears only when one of them is true -
 * never a row of sentences stacked under the buttons.
 *
 * The three queue clauses say deliberately different things, for the reason
 * {@link queuedMessagesReturningText} gives: a switch moves the queue forward
 * onto new settings, a wait moves nothing, a return moves it back. Hidden at
 * zero, like their sentence siblings.
 */
export function queuedMovingClause(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 queued message moves with it"
    : `${count} queued messages move with it`;
}

export function queuedWaitingClause(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 queued message waits with it"
    : `${count} queued messages wait with it`;
}

export function queuedReturningClause(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "moves 1 queued message back"
    : `moves ${count} queued messages back`;
}

/** The countdown card's pointer at its picker, while the picker can open. */
export const CHANGE_DESTINATION_CLAUSE = "click the destination to change it";
/** The return card's timing: a switch-back takes effect on the next send. */
export const APPLIES_TO_NEXT_MESSAGE_CLAUSE = "Applies to your next message";

/** The clauses that are true, as one line - or `null` when none is. */
export function joinCostClauses(
  clauses: ReadonlyArray<string | null>,
): string | null {
  const present = clauses.filter((clause): clause is string => clause !== null);
  return present.length === 0 ? null : present.join(" · ");
}

/**
 * The countdown chooser between the click and the host's answer.
 *
 * Said while `fallback.holdForChoice` is in flight, and it is deliberately in
 * the PRESENT progressive: the countdown is still running until the host says
 * otherwise. Claiming "countdown paused" here would be the client asserting a
 * hold the engine has not granted - the same optimism the card's `choosing`
 * headline already refuses.
 */
export const PAUSING_COUNTDOWN_LABEL = "Pausing the countdown…";
/**
 * The hold the host declined - the chooser says so.
 *
 * NO CAUSE, deliberately (D220). This used to end "— this chat has moved on",
 * which is one cause stated as the only one and unproven at every site that
 * renders it: an ACCEPTED ack carrying no token refuses too (the host took the
 * freeze and minted nothing), and since B1 made reopening from `choosing` a
 * normal path, a refusal no longer implies the traversal advanced. Same class
 * as MF10/F6 - refusal copy names no cause unless advancement is proven.
 *
 * A "try again" or "the countdown is still running" tail is not a fix either:
 * both are causes in disguise. The card or menu state above this line is the
 * truthful next step, so this sentence stops at the fact it can vouch for.
 */
export const COUNTDOWN_NOT_PAUSED_LABEL = "Couldn't pause the countdown.";
/**
 * The one transport FAILURE the chooser can hit, as opposed to every `outcome`
 * above - all of which arrive in a successful response.
 *
 * A constant because the chooser's status region has to announce the same
 * sentence its heading renders, and two copies of one line is how the ear and the
 * eye start disagreeing.
 */
export const HOST_UNREACHABLE_LABEL =
  "Couldn't reach this chat's host just now.";

/**
 * The one sentence that may claim the chat advanced.
 *
 * Shared by the two switches below because `attempt_not_latest` is one fact
 * with one name on both the listing and the action side, and two wordings for
 * it in one file is how a renderer starts implying they are different
 * situations.
 */
const CHAT_MOVED_ON_LABEL = "This chat has moved on since that message.";

/**
 * Why the failed attempt is offering no wait, or `null` when it is.
 *
 * Every branch renders a HOST-ESTABLISHED fact. This is the whole point of the
 * disposition existing: before it, the only thing a card could reason from was
 * `failure.resetsAt`, which is PRESENT for a boundary beyond the user's cap and
 * ABSENT for one the host never verified - so the two states a user can
 * actually act on (raise the cap; wait for the provider to report a boundary)
 * looked identical, and the state where a wait is impossible looked like the
 * state where it is merely far away.
 *
 * `resetsAt` is the failure payload's, read WITHOUT a cap, and it is named only
 * under `beyond_cap` - the one disposition where the boundary is known. The cap
 * itself never reaches the client, so the copy points at Settings instead of
 * quoting a number it does not have.
 *
 * Exhaustive with no `default`, so a new disposition is a compile error rather
 * than a silently unexplained card.
 */
export function describeWaitDisposition(
  disposition: FallbackWaitDisposition,
  resetsAtLabel: string | null,
): string | null {
  switch (disposition) {
    case "eligible":
      // Nothing to explain: the button IS the statement, and a sentence
      // beside it saying a wait is available would be the card narrating its
      // own controls.
      return null;
    case "checking":
      return "Checking when this limit resets…";
    case "no_verified_reset":
      return "The provider hasn't said when this limit resets, so there's nothing to wait for.";
    case "beyond_cap":
      // Names the SETTING, not just the verdict. "Later than your longest wait
      // allows" states a fact about a number the user cannot see from here and
      // gives them nowhere to go; the cap lives on this feature's own settings
      // page, which the card already links to beside this line.
      return resetsAtLabel === null
        ? "This limit resets later than Traycer is set to wait."
        : `This limit resets at ${resetsAtLabel} — longer than Traycer is set to wait.`;
    case "attempt_unavailable":
      // SILENT, deliberately.
      //
      // The line here used to read "Waiting isn't available for this message."
      // It claimed no cause, which was right (D220 - the host withheld the wait
      // replay envelope, and why is not ours to state), but a sentence that
      // claims no cause and names no remedy is a sentence with nothing in it.
      // The reader never saw a wait control on this row, so its absence needs
      // no eulogy; what they have is Retry and Switch, and the card now leads
      // with those.
      //
      // This does NOT weaken F6's rule that a vanished control must be
      // explained. F6 is about a control the user could reasonably expect: the
      // three dispositions above all describe a wait that is genuinely on the
      // table and merely blocked - by a check still running, by a provider that
      // has not published a boundary, or by a cap the user themselves set and
      // can raise. Each of those names something to do or something to wait
      // for. This one names neither, and is the only arm where the honest copy
      // is none.
      return null;
  }
}

/**
 * "No other model is set up for Claude Code · default".
 *
 * The ONE sentence for "this chat has nowhere to switch to", rendered on both
 * surfaces that have to say it: the error card, where it explains a missing
 * "Switch…" button, and the destination menu's empty state, where it explains
 * an empty list. One function because they are explaining one host verdict, and
 * a card and the menu it opens disagreeing about why would be worse than either
 * of them saying nothing.
 *
 * NAMES THE CHAT, which is the whole difference from a generic line. "No
 * destinations available" tells a user nothing they cannot already see; naming
 * the provider and model tells them which setting to go and look at, and it is
 * the only form in which the sentence is checkable by the person reading it.
 *
 * No trailing full stop, deliberately: the sentence ends in an identity, and a
 * stop after a model slug reads as part of the slug.
 *
 * The vocabulary table governs every word here. Not "group" - that is policy
 * STRUCTURE, banned for the same reason "tier", "ladder" and "rung" are - and
 * not "equivalence" either. "Set up" is what the user did, or did not do.
 */
export function noSwitchDestinationText(providerModelLabel: string): string {
  return `No other model is set up for ${providerModelLabel}`;
}

/**
 * Why the failed attempt is offering no switch, or `null` when it is.
 *
 * The counterpart to {@link describeWaitDisposition} and held to the same rule:
 * every branch renders a HOST-ESTABLISHED fact, and the client infers none of
 * them. It cannot - the question is whether this user's fallback policy and
 * accounts name any other destination for the model that failed, and a renderer
 * holds neither.
 *
 * `null` under `unknown` as well as under `eligible`, and the two share it for
 * one reason: the button is present in both. `unknown` means the host could not
 * check, so the control is offered and nothing is claimed - a sentence there
 * would be the card narrating a doubt at a user who has a working button in
 * front of them.
 *
 * `providerModelLabel` is `null` when the failed attempt's tuple did not reach
 * this client, and the sentence is then omitted rather than rendered
 * subject-less. That absence travels WITH `unknown` on the same frame (both
 * come from a missing replay envelope), so the null arm is belt-and-braces
 * rather than a state the card meets.
 *
 * Exhaustive with no `default`, so a new disposition is a compile error here
 * rather than a silently unexplained card.
 */
export function describeSwitchDisposition(
  disposition: FallbackSwitchDisposition,
  providerModelLabel: string | null,
): string | null {
  switch (disposition) {
    case "eligible":
    case "unknown":
      return null;
    case "no_destination":
      return providerModelLabel === null
        ? null
        : noSwitchDestinationText(providerModelLabel);
  }
}

/**
 * What to say when `chat.fallback.listTargets` answered anything but `listed`.
 *
 * Every arm is a NORMAL outcome in a successful response with empty lists -
 * the method never throws on a moved-on world - so these are facts about the
 * chat rather than failures of the menu. `null` for `listed`: the rows are the
 * answer.
 *
 * Exhaustive with no `default`, so a new outcome is a compile error here rather
 * than an empty popover.
 */
export function describeListTargetsOutcome(
  outcome: ChatFallbackListTargetsResponse["outcome"],
): string | null {
  switch (outcome) {
    case "listed":
      return null;
    case "no_active_traversal":
      return "That's already been decided for this chat.";
    case "traversal_advanced":
      return "This chat already resumed.";
    case "attempt_not_latest":
      // The transcript moved under an open menu - a later turn ran, so the
      // failure this menu was opened from is no longer the one to act on.
      return CHAT_MOVED_ON_LABEL;
    case "state_unreadable":
      // Deliberately does not speculate. The host could not read the state it
      // would have listed from, and naming a cause would be a guess presented
      // as a reason.
      return "Couldn't read this chat's state just now.";
  }
}

/**
 * What to tell the user when an action answered anything but `applied`.
 *
 * `null` for `applied`: the frame that follows is the feedback, and a toast
 * saying "switched" beside a card that just changed to say the same thing is
 * noise.
 *
 * Every other arm is a NORMAL outcome delivered in a successful response, not
 * an error - a pick that lost a race is not a failed call. So these are stated
 * as facts about the chat rather than as failures of the button.
 *
 * Exhaustive over the outcome union with no `default`, so a new outcome is a
 * compile error here rather than a silent blank.
 */
export function describeFallbackOutcome(
  outcome: FallbackActionOutcome,
): string | null {
  switch (outcome) {
    case "applied":
      return null;
    case "traversal_advanced":
      return "This chat already resumed.";
    case "no_active_traversal":
      // The card outlived what it was describing - a settle landed while it was
      // on screen. Says what is true now rather than "nothing happened", which
      // would suggest the button was broken.
      return "That's already been decided for this chat.";
    case "choice_lease_stale":
      // Both stale-lease shapes (a token this session never minted, and one
      // whose hold has since been released) land here by decision - the client
      // cannot tell them apart and the remedy is identical: re-read the DTO.
      return "The menu is out of date — reopen it to choose.";
    case "rung_unavailable":
      // The NEUTRAL residue, and it must stay neutral. This arm used to read
      // "That isn't available any more — this chat has moved on", and it was
      // the only string the card had: the host returns this code for an
      // unusable destination and a failed preparation with no newer turn at
      // all, so the copy asserted an advancement the host had established
      // nothing about. The two facts the host CAN prove now have their own
      // outcomes below; whatever still reaches here gets a sentence that
      // claims no cause.
      return "That action isn't available right now.";
    case "attempt_not_latest":
      // The ONE outcome that proves the chat advanced, and the only one
      // allowed to say so. Deliberately the same sentence
      // `describeListTargetsOutcome` gives the identically-named outcome: one
      // fact, one wording, across the two switches this file holds.
      return CHAT_MOVED_ON_LABEL;
    case "rung_target_unavailable":
      // "right now", never "any more". The chat did NOT move and the attempt
      // is still the latest - the destination simply stopped validating - so
      // "any more" would assert a change that is exactly what did not happen.
      // Reopening the menu is the useful next step, which is what this points
      // at.
      return "That destination isn't available right now.";
    case "return_unavailable":
      // NEVER rendered as success: the offer closed and the chat did NOT move.
      // The host appends a durable notice saying why, which is where the
      // specific reason lives - this line's job is to stop the banner from
      // closing silently as though it had worked.
      return "Couldn't switch back — see the note in the transcript.";
  }
}

/**
 * Which of the failed-turn card's actions survive a refusal.
 *
 * `none` removes the action row and leaves the sentence; `retry_and_switch`
 * and `switch` keep those buttons (a wait that was refused is not offered
 * again); `all` keeps the row as it was, because pressing again can work.
 */
export type RefusalRemainingActions =
  | "none"
  | "retry_and_switch"
  | "switch"
  | "all";

/** What the failed-turn card says, inline, where a refused action was. */
export interface RefusalNoteCopy {
  /**
   * The sentence, or `null` where another surface is already saying it - a
   * refusal because routing is handling the turn has the countdown or the
   * waiting card on screen, and a second line here would be the same fact
   * twice.
   */
  readonly text: string | null;
  readonly remaining: RefusalRemainingActions;
}

/**
 * The actions each refusal kind leaves when the host says pressing again will
 * NOT help (`retryable: false`). Total over the vocabulary with no default,
 * so a kind the protocol adds is a compile error here rather than a card that
 * silently keeps or drops its buttons.
 */
const REFUSAL_REMAINING_BY_KIND: Readonly<
  Record<FallbackRungRefusalKind, RefusalRemainingActions>
> = {
  turn_running: "none",
  routing_active: "none",
  worktree_missing: "none",
  no_workspace: "none",
  message_changed: "none",
  prelaunch_failed: "retry_and_switch",
  reset_passed: "retry_and_switch",
  no_verified_reset: "retry_and_switch",
  host_unavailable: "all",
  settings_missing: "none",
  storage_failed: "all",
  target_unusable: "switch",
  unknown: "all",
};

/**
 * The two kinds whose row goes away whatever `retryable` says: the chat is
 * busy with something else, and the host brings the actions back itself (by
 * naming the attempt again) once it is not.
 */
const ROW_HIDDEN_KINDS: ReadonlySet<FallbackRungRefusalKind> = new Set([
  "turn_running",
  "routing_active",
]);

/**
 * The sentence for one refusal kind. `hostLabel` is the TAB host's directory
 * label - never anything from the detail, whose strings are the host's fixed
 * copy and carry no identifiers by contract.
 */
function refusalKindText(
  kind: FallbackRungRefusalKind,
  hostLabel: string | null,
): string | null {
  switch (kind) {
    case "turn_running":
      return "This chat is busy. The actions come back when the current turn ends.";
    case "routing_active":
      return null;
    case "worktree_missing":
      return hostLabel === null
        ? "This chat's worktree no longer exists on its host. Start a new chat from this task."
        : `This chat's worktree no longer exists on ${hostLabel}. Start a new chat from this task.`;
    case "no_workspace":
      return "This chat has no folder to run in any more. Start a new chat from this task.";
    case "message_changed":
      return "The original message changed, so it can't be replayed. Send it again from the composer.";
    case "prelaunch_failed":
      return "Couldn't start the replacement turn. Try again, or switch.";
    case "reset_passed":
      return "That limit has reset. Retry instead.";
    case "no_verified_reset":
      return describeWaitDisposition("no_verified_reset", null);
    case "host_unavailable":
      return "This chat's host is restarting. Try again in a moment.";
    case "settings_missing":
      return "This chat has no model set. Pick one in the composer and send again.";
    case "storage_failed":
      return "Couldn't save this chat's state just now. Try again.";
    case "target_unusable":
      return "That model can't be used right now. Pick another.";
    case "unknown":
      return null;
  }
}

/**
 * What the failed-turn card says when the host refused a manual action and
 * said why (`chat.fallback.runManualRung@1.1`'s `detail`).
 *
 * The kind is an OPEN string on the wire, so it is parsed here: a kind this
 * build knows maps to its own copy, and one it does not - or `unknown`, the
 * host's residue - renders the host's `label`, a fixed sentence per kind
 * written by the host's copy table, and keeps every button. `retryable` is the
 * host's word on whether pressing again can work, so it keeps the row whole;
 * the table above is what remains when it cannot.
 */
export function describeRefusalDetail(
  detail: FallbackRungRefusalDetail,
  hostLabel: string | null,
): RefusalNoteCopy {
  // A blank label is no sentence at all; the caller then says the neutral one.
  const hostSentence = detail.label.trim() === "" ? null : detail.label;
  const parsed = fallbackRungRefusalKindSchema.safeParse(detail.kind);
  if (!parsed.success) return { text: hostSentence, remaining: "all" };
  const kind = parsed.data;
  const text =
    refusalKindText(kind, hostLabel) ??
    (kind === "unknown" ? hostSentence : null);
  if (ROW_HIDDEN_KINDS.has(kind)) return { text, remaining: "none" };
  return {
    text,
    remaining: detail.retryable ? "all" : REFUSAL_REMAINING_BY_KIND[kind],
  };
}

/** The manual actions the failed-turn card sends. */
export type ManualRungKind = "retry" | "wait_once" | "switch";

/**
 * The neutral sentence for a refusal the host did not explain - an older host
 * (`detail: null` from the `1.0` upgrade path), or one whose detail is
 * missing. It names the action and claims no cause, and the button stays, so
 * the user can press again. It is never the only sentence for every reason:
 * a host that explains itself gets {@link describeRefusalDetail}.
 */
function neutralRefusalText(rung: ManualRungKind): string {
  switch (rung) {
    case "retry":
      return "Couldn't retry just now.";
    case "wait_once":
      return "Couldn't start the wait just now.";
    case "switch":
      return "Couldn't switch just now.";
  }
}

/**
 * What the failed-turn card says, inline, for any non-`applied` answer to a
 * manual action - or `null` for `applied`, whose feedback is the frame that
 * follows.
 *
 * `attempt_not_latest` is a fact about the chat rather than a refusal of this
 * action, and the one outcome allowed to say the chat moved on; the two
 * explainable refusals go through {@link describeRefusalDetail}; everything
 * else keeps its outcome sentence and every button.
 */
export function describeManualRungRefusal(input: {
  readonly outcome: FallbackActionOutcome;
  readonly detail: FallbackRungRefusalDetail | null;
  readonly rung: ManualRungKind;
  readonly hostLabel: string | null;
}): RefusalNoteCopy | null {
  const { outcome, detail, rung, hostLabel } = input;
  if (outcome === "applied") return null;
  if (outcome === "attempt_not_latest") {
    // The card has room for the next step, which a toast or a picker footer
    // does not (spec Flow 4's table).
    return {
      text: `${CHAT_MOVED_ON_LABEL} Send a new message to continue.`,
      remaining: "none",
    };
  }
  if (detail !== null) {
    const copy = describeRefusalDetail(detail, hostLabel);
    // An unexplained refusal that leaves the buttons still says something -
    // "Couldn't retry just now" - so a press never ends in silence. The one
    // silent kind (`routing_active`) hides the row, and the routing card on
    // screen is its explanation.
    if (copy.text === null && copy.remaining !== "none") {
      return { text: neutralRefusalText(rung), remaining: copy.remaining };
    }
    return copy;
  }
  if (outcome === "rung_target_unavailable") {
    return { text: describeFallbackOutcome(outcome), remaining: "switch" };
  }
  if (outcome === "rung_unavailable") {
    return { text: neutralRefusalText(rung), remaining: "all" };
  }
  return { text: describeFallbackOutcome(outcome), remaining: "all" };
}

/**
 * The routing chooser's switch consequence, split around the destination so
 * the footer can set it apart. Read in order and joined with single spaces:
 * "Replays this message on | Fable · high on Surya | in a new session from
 * this transcript. 1 queued message moves with it."
 */
export interface SwitchDestinationConsequenceCopy {
  readonly lead: string;
  readonly destination: string;
  readonly trail: string;
}

/**
 * What a switch to one named destination does - Flow 3's footer.
 *
 * {@link switchConsequencesText} names no destination ("the destination you
 * pick"); the chooser rewrites this one with every selection change, so it is
 * the confirm's own tuple read back. The queue clause says the same thing that
 * one does: "Any queued messages" where the host gives no count, nothing at
 * zero.
 */
export function switchDestinationConsequence(
  destination: string,
  queuedItemsMoving: number | null,
): SwitchDestinationConsequenceCopy {
  const replay = "in a new session from this transcript.";
  const queued = queuedMovesWithItText(queuedItemsMoving);
  return {
    lead: "Replays this message on",
    destination,
    trail: queued === null ? replay : `${replay} ${queued}`,
  };
}

function queuedMovesWithItText(count: number | null): string | null {
  if (count === null) return "Any queued messages move with it.";
  if (count <= 0) return null;
  return count === 1
    ? "1 queued message moves with it."
    : `${count} queued messages move with it.`;
}
