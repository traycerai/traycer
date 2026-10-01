import {
  fallbackRungRefusalKindSchema,
  type FallbackActionOutcome,
  type FallbackRungRefusalDetail,
  type FallbackRungRefusalKind,
} from "@traycer/protocol/host/chat-fallback";
import type { FallbackWaitDisposition } from "@traycer/protocol/host/agent/gui/subscribe";
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
 * The countdown card's productive action on a switch plan: end the countdown
 * now and let the switch run (`chat.fallback.proceed`). A wait plan has no such
 * button - the countdown flows into waiting on its own - and a countdown never
 * plans a retry (the transient series arms straight into `retrying`).
 */
export const SWITCH_NOW_LABEL = "Switch now";
/**
 * The picker's entry where there is no destination chip to click: the filled
 * button on a wait-plan countdown and on the waiting card.
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
/**
 * The return card's filled answer. Its other answer is "Stay on {account}",
 * built where the account name is known.
 */
export const SWITCH_BACK_LABEL = "Switch back";
/**
 * Beside a disabled action row while the chat stream is down (or this reader
 * cannot steer the chat). Without it the greyed buttons read as broken.
 */
export const RECONNECTING_LABEL = "Reconnecting…";
/** Beside the countdown card's disabled row while the host resolves its plan. */
export const DECIDING_LABEL = "Deciding…";
/** The gear's accessible name: what the icon opens. */
export const ROUTING_SETTINGS_LABEL = "Model routing settings";
/** The settled card's receipt when routing ran no step at all. */
export const NOTHING_COULD_BE_TRIED_LABEL = "Nothing could be tried";
/**
 * The Message Queue panel's paused pill when the host paused it because a turn
 * failed (`queue.pausedReason` `turn_error` / `routing`), and its tooltip for
 * `turn_error`.
 *
 * The tooltip says why the row is held and how to send it, and promises no
 * more (review sweep, 2026-09-27, replacing the spec's "Retry or switch sends
 * it after; Resume sends it now"): a successful manual Retry or Switch leaves
 * the held rows paused - the host's own notice says "still paused - resume the
 * queue to send them" - and while one is in flight Resume is gated rather than
 * immediate.
 */
export const QUEUE_PAUSED_AFTER_ERROR_LABEL = "Paused after an error";
export const QUEUE_PAUSED_AFTER_ERROR_TOOLTIP =
  "Held because the last turn failed. Resume to send it.";
/**
 * The pill's tooltip under a routing pause (`pausedReason` `routing`): one
 * sentence for every state that pause spans, because it promises nothing about
 * when the row runs or what Resume does.
 *
 * The host writes `routing` while a traversal holds the queue (a countdown, a
 * choice, a wait, a retry, a switch - and on past the frame being withdrawn
 * while the replacement runs) and after one succeeded, for rows whose settings
 * the new provider rejected, which its release skips. What happens next differs
 * across those, and even per row, and the client cannot tell them apart from
 * what it receives - so it says what is true in all of them, and a row's own
 * reason line says what is specific to it.
 */
export const QUEUE_PAUSED_BY_ROUTING_TOOLTIP =
  "Held by routing after the last turn failed.";

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
 * The three queue clauses say deliberately different things and must not
 * converge: a switch moves the queue forward onto new settings, a wait moves
 * nothing, a return moves it back - and switching back moving the queue too is
 * the one rule that copy has to carry, since a queue left on the previous
 * account while the next send routes to the preferred one would interleave two
 * providers in one chat with nobody told. Hidden at zero rather than "0 queued
 * messages", which reads as a problem. The count is the DTO's
 * `queuedItemsMoving`, the settle notice's own derivation, so a card cannot
 * promise to move a different number than the host reports afterwards. The
 * announcer speaks these same clauses as sentences.
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

/** The clauses that are true, as one line - or `null` when none is. */
export function joinCostClauses(
  clauses: ReadonlyArray<string | null>,
): string | null {
  const present = clauses.filter((clause): clause is string => clause !== null);
  return present.length === 0 ? null : present.join(" · ");
}

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
 * The answer to a pressed Wait the host refused because the provider never
 * reported a reset (`no_verified_reset`). The answer to a press ONLY - never a
 * standing line on the card; see {@link describeWaitDisposition}.
 */
const NO_VERIFIED_RESET_TEXT =
  "The provider hasn't said when this limit resets, so there's nothing to wait for.";

/**
 * The failed-turn card's standing line about the missing Wait button, or
 * `null` - which is every disposition but `beyond_cap` (clutter cuts,
 * 2026-09-27).
 *
 * `beyond_cap` is the one line worth standing: the boundary is KNOWN, the
 * user set the cap that excludes it, and the sentence says so. Every other
 * disposition is silent here. `no_verified_reset` in particular used to stand
 * under the settled card's receipt, where a step reading "Waited until 3:45 am
 * for Surya 2" sat directly above "The provider hasn't said when this limit
 * resets" - the card contradicting itself. That sentence now answers a pressed
 * Wait the host refused (`refusalKindText`), and nothing else.
 *
 * Every branch still reads a HOST-ESTABLISHED disposition, never the failure
 * payload: `failure.resetsAt` is PRESENT for a boundary beyond the user's cap
 * and ABSENT for one the host never verified, so it cannot tell the two
 * apart. `resetsAt` is named only under `beyond_cap` - the one disposition
 * where the boundary is known - read WITHOUT a cap. The cap itself never
 * reaches the client, so the copy names the setting instead of quoting a
 * number it does not have.
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
      // SILENT (clutter cuts, 2026-09-27): nothing is said until the reset is
      // known, and then the Wait button itself appears. A line announcing a
      // check the user cannot act on was a sentence about the card's own
      // plumbing.
      return null;
    case "no_verified_reset":
      // SILENT as a standing line: see the doc above. The sentence is
      // `NO_VERIFIED_RESET_TEXT`, said only when a Wait press is refused.
      return null;
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
      // `beyond_cap` is the one standing line left: it describes a wait that
      // is genuinely on the table and blocked only by a cap the user set and
      // can raise. This one names nothing to do and nothing to wait for.
      return null;
  }
}

/**
 * "No other model is set up for Claude Code · default".
 *
 * The Model routing settings page's note under a model with no routing
 * destination. The failed-turn card no longer says it (clutter cuts,
 * 2026-09-27): "Switch to…" opens the full composer picker, which always has
 * somewhere to go, so there is no missing button left to explain there.
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
      // allowed to say so.
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
  message_unreplayable: "none",
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
    case "message_unreplayable":
      return "Something this message refers to is no longer available, so it can't be replayed. Send it again from the composer.";
    case "prelaunch_failed":
      return "Couldn't start the replacement turn. Try again, or switch.";
    case "reset_passed":
      return "That limit has reset. Retry instead.";
    case "no_verified_reset":
      return NO_VERIFIED_RESET_TEXT;
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
 * The routing chooser's one footer line, beside its Switch: where Switch
 * replays the message, as the picked model and account and nothing more -
 * "Replays on Sonnet 5 · Surya in a new session". The picker above it already
 * shows the provider and the effort.
 */
export function routingSwitchLine(
  modelLabel: string,
  accountLabel: string,
): string {
  return `Replays on ${modelLabel} · ${accountLabel} in a new session`;
}
