import type {
  ChatFallbackListTargetsResponse,
  FallbackActionOutcome,
} from "@traycer/protocol/host/chat-fallback";
import { FALLBACK_REASON_LABELS } from "@traycer/protocol/host/notifications/presentation";

/**
 * User-facing copy for the provider-fallback chat surfaces.
 *
 * Centralised because the vocabulary is FIXED by the UX spec's table and is the
 * kind of thing that drifts one card at a time. The words that must never
 * appear anywhere below: "tier", "ladder", "rung", "grace", "Inherit", a raw
 * reason code, or a time this client invented. The words that must: "profile",
 * "Terminal account", "equivalent model", "Don't switch", "Stop waiting", and
 * provider names from `PROVIDER_DISPLAY_NAMES`.
 *
 * A bare "Cancel" is banned for the two card actions on purpose: both keep the
 * error and leave the queue paused, so "Cancel" would read as a no-op undo of
 * something that has not happened yet.
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

/** "Don't switch" - the grace card's refusal. Never "Cancel". */
export const DONT_SWITCH_LABEL = "Don't switch";
/** "Stop waiting" - the waiting card's and the background row's refusal. */
export const STOP_WAITING_LABEL = "Stop waiting";
export const CHOOSE_DIFFERENTLY_LABEL = "Choose differently…";
export const SWITCH_INSTEAD_LABEL = "Switch instead…";
/**
 * The error card's own menu trigger.
 *
 * Shorter than its two card siblings on purpose: "Switch instead" and "Choose
 * differently" are both answers to something already in motion, and there is
 * nothing in motion on a failed row - the switch IS the action, not an
 * alternative to one.
 */
export const SWITCH_LABEL = "Switch…";
export const SIGN_IN_INSTEAD_LABEL = "Sign in instead";
export const FALLBACK_SETTINGS_LABEL = "Fallback settings";

/**
 * The consequence helper both refusals carry.
 *
 * Says what is KEPT rather than what is stopped, because that is the part a
 * user cannot see: the error is already in the transcript and the queue is
 * already paused, so pressing either button changes nothing about the turn -
 * it only ends the host's attempt to rescue it.
 */
export const KEEPS_THE_ERROR_HELPER =
  "keeps the error — you can retry from the message";

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
 * "N queued messages are waiting with it."
 *
 * The waiting card's counterpart to {@link queuedMessagesMovingText}, and a
 * separate sentence rather than the same one reworded: a wait moves nothing.
 * The queue is held on the tuple it already carries and resumes on that same
 * tuple, so "will run on the new settings" would promise a change that a wait
 * is specifically the alternative to. Hidden at zero for the same reason.
 */
export function queuedMessagesWaitingText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 queued message is waiting with it."
    : `${count} queued messages are waiting with it.`;
}

/**
 * "and moves N queued messages back".
 *
 * The third member of the family, and a clause rather than a sentence: the
 * return banner states the whole consequence in one line ("Applies to your next
 * message and moves 2 queued messages back"), because switching back moving the
 * queue too is the one rule that copy has to carry. Leaving the queue on the
 * fallback while the next fresh send routes to the preferred account would
 * interleave two providers in one chat with nobody told.
 *
 * All three helpers say deliberately DIFFERENT things and must not converge: a
 * wait moves nothing, a switch moves messages forward onto new settings, and a
 * return moves them back. Hidden at zero like its siblings.
 */
export function queuedMessagesReturningText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? " and moves 1 queued message back"
    : ` and moves ${count} queued messages back`;
}

/**
 * "N other chats in this task are also switching."
 *
 * Informational only - there is no action, and deliberately so: picks are per
 * chat (the task-wide variant was designed and dropped). Hidden at zero.
 */
export function siblingSwitchingText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 other chat in this task is also switching."
    : `${count} other chats in this task are also switching.`;
}

/**
 * The destination menu's two section headings.
 *
 * Neither names the policy structure the candidates came from. A group is
 * STRUCTURE, and the vocabulary table bans "tier"/"ladder"/"rung" for exactly
 * that reason; a heading naming the group would be the same thing in a
 * friendlier word, and one rendering the raw `groupId` would put an internal
 * identifier in front of a user. `groupId` keeps same-group rows adjacent and
 * stably ordered here, and nothing more.
 */
export const OTHER_PROFILES_HEADING = "Other profiles";
export const EQUIVALENT_MODELS_HEADING = "Equivalent models";
/** The one row the ladder would take next, marked so the default is visible. */
export const RECOMMENDED_LABEL = "Recommended";
export const FINDING_DESTINATIONS_LABEL = "Finding destinations…";
/**
 * The grace card's menu between the click and the host's answer.
 *
 * Said while `fallback.holdForChoice` is in flight, and it is deliberately in
 * the PRESENT progressive: the countdown is still running until the host says
 * otherwise. Claiming "countdown paused" here would be the client asserting a
 * hold the engine has not granted - the same optimism the card's `choosing`
 * headline already refuses.
 */
export const PAUSING_COUNTDOWN_LABEL = "Pausing the countdown…";
/** The hold the host declined - the menu says so and closes. */
export const COUNTDOWN_NOT_PAUSED_LABEL =
  "Couldn't pause the countdown — this chat has moved on.";
/**
 * The empty menu, when the host gave no rung-level explanation.
 *
 * Says what is true of BOTH lists, because the menu offers both and a user
 * reading "no equivalent model" would reasonably ask about their other
 * account. When `modelTargetsSkip` is present its host-written label is
 * rendered instead - it is the more specific fact, and `no-group` (the
 * commonest ineligibility, being what a user sees after deleting or narrowing
 * their groups) is precisely the case a generic sentence would fail.
 */
export const NO_DESTINATIONS_LABEL =
  "No other profile or equivalent model is available right now.";

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
      return "This chat has moved on since that message.";
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
      // Deliberately generic. Seven host guards answer this code and five of
      // them say nothing about which, so naming a cause would be a guess
      // presented as a reason. A typed refusal reason is a recorded follow-up;
      // until it exists, one honest sentence beats seven speculative ones.
      return "That isn't available any more — this chat has moved on.";
    case "return_unavailable":
      // NEVER rendered as success: the offer closed and the chat did NOT move.
      // The host appends a durable notice saying why, which is where the
      // specific reason lives - this line's job is to stop the banner from
      // closing silently as though it had worked.
      return "Couldn't switch back — see the note in the transcript.";
  }
}
