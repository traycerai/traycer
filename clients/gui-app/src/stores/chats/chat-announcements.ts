import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type {
  ChatRunSettings,
  LastFallbackOutcome,
  PendingFallback,
  PendingReturn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatMessage } from "@/stores/composer/chat-store";
import {
  STOP_WAITING_LABEL,
  queuedReturningClause,
} from "@/components/chat/fallback/fallback-copy";
import {
  countdownRefusalLabel,
  routingCountdownCountClauses,
  routingCountdownPlan,
  type RoutingCountdownPlan,
} from "@/components/chat/fallback/fallback-state";
import { isFallbackNoticeKind } from "@/components/chat/fallback/fallback-notice-kinds";
import { formatWaitTime } from "@/lib/relative-time";
import {
  isRoutingCancellationNotice,
  isRoutingCancellationOutcome,
} from "@/stores/chats/hidden-transcript-notices";

/**
 * Polite announcements for transcript completions and fallback lifecycle.
 *
 * `useChatAnnouncements` derives turn/background completion (decision #24).
 * The fallback observer derives host plan transitions and confirmed outcomes.
 * The renderer queues both into one persistent region; only the completion
 * signal also drives the "New reply" latch.
 *
 * Transcript completion must distinguish a LIVE arrival from history. Its
 * deriver never infers that from row shape - not from sorted position, not
 * from completion recency, not from timestamp comparisons, all of which are
 * undecidable for cases the projector legitimately produces (a background
 * task from an earlier turn settles late and its notification is anchored at
 * that turn's ORIGINAL transcript position, i.e. before rows the reader has
 * already seen; wall-clock stamps are not unique, so recency cannot rank
 * simultaneous completions either).
 *
 * Instead liveness comes from HOW the data reached the client, which the
 * chat session store knows exactly:
 *
 * - `baselineEpoch` changes whenever an authoritative snapshot re-established
 *   the transcript for a NEW connection (mount hydration, reconnect
 *   backfill). Everything visible at that moment is history by construction -
 *   it is silently absorbed as the new baseline, however it sorts and
 *   whenever it completed.
 * - `hydrationSequence` changes whenever a range response seated rows the
 *   reader SCROLLED to. Those rows are settled history that was always there,
 *   reached by travelling backwards through it - so a row that first APPEARS
 *   across such a change is absorbed too. Without this, a windowed transcript
 *   announced every turn in unloaded history as a fresh completion as the
 *   reader scrolled up through it.
 * - While both are unchanged the client is connected and watching, so any
 *   row that reaches a settled state - or whose background-completion digest
 *   changes - is news, again regardless of position or timestamp.
 *
 * That leaves completion selection a pure function of per-row semantic
 * state keyed by row id, with no cross-row comparisons and no tie-breaking.
 */

export type ChatAnnouncementKind =
  | "turn-completed"
  | "background-completion"
  | "background-update";

export interface ChatAnnouncement {
  /**
   * Monotonic per-transcript counter. Two consecutive announcements can be
   * identical in every other respect (same row, same wall-clock stamp, same
   * copy) when a second background task settles in the same millisecond, so
   * consumers distinguish them by this counter. The shared live-region queue
   * assigns its own sequence to completion and fallback sentences together,
   * ensuring repeated text still replaces the region's child node.
   */
  readonly sequence: number;
  readonly kind: ChatAnnouncementKind;
}

/** `baselineEpoch` for a transcript whose first snapshot has not landed. */
export const NO_TRANSCRIPT_BASELINE = -1;

interface RowAnnouncementState {
  /** Terminal and not user-stopped: a Stop is the reader's own action. */
  readonly settled: boolean;
  /** A background-completion notification rather than a provider turn. */
  readonly footerless: boolean;
  /**
   * Content version of the row's resume notification. Encodes each trigger's
   * `live` state, not just a count: the protocol appends triggers to the
   * existing divider while the chat stays idle, AND a still-running producer
   * settles IN PLACE (count unchanged, `live` flips off) - both are new
   * background news on an otherwise unchanged row.
   */
  readonly notificationDigest: string | null;
  /** Settled (non-`live`) triggers; decides completion vs update copy. */
  readonly settledTriggerCount: number;
  readonly hasLiveTrigger: boolean;
}

function rowAnnouncementState(message: ChatMessage): RowAnnouncementState {
  const digestParts: string[] = [];
  let settledTriggerCount = 0;
  let hasLiveTrigger = false;
  for (const segment of message.segments) {
    if (segment.kind !== "autonomous_resume") continue;
    let states = "";
    for (const trigger of segment.triggers) {
      if (trigger.live) {
        hasLiveTrigger = true;
        states += "l";
      } else {
        settledTriggerCount += 1;
        states += "t";
      }
    }
    digestParts.push(`${segment.id}:${states}`);
  }
  return {
    settled: message.completedAt !== null && message.stopped === null,
    footerless: message.showCompletionFooter === false,
    notificationDigest: digestParts.length === 0 ? null : digestParts.join("|"),
    settledTriggerCount,
    hasLiveTrigger,
  };
}

/**
 * Copy selection for a settled row. A `live: true` trigger is a producer that
 * was STILL RUNNING when the digest rendered - the visible card says so - and
 * calling that a "completion" would contradict the screen. Completion copy
 * therefore requires a settled trigger the reader has not heard about yet; a
 * row whose only news is still-running producers gets update copy. A
 * footerless row with no trigger digest keeps completion copy: its own
 * terminal transition is the only thing it can be announcing.
 */
function announcementKindForSettledRow(
  next: RowAnnouncementState,
  priorSettledTriggerCount: number,
): ChatAnnouncementKind {
  if (!next.footerless) return "turn-completed";
  if (next.settledTriggerCount > priorSettledTriggerCount) {
    return "background-completion";
  }
  return next.hasLiveTrigger ? "background-update" : "background-completion";
}

/**
 * The announceable transitions, all on a stable row id:
 *
 * - a row the reader has never seen arrives settled (a batched snapshot can
 *   deliver a notification and its adopting provider turn together, and the
 *   live row is replaced by its persisted row under a new id);
 * - a known row reaches a settled state;
 * - a footerless notification is adopted by its provider turn (the footer
 *   flips on);
 * - a footerless notification's digest changes (a trigger is appended, or a
 *   still-running one settles in place).
 *
 * A settled row whose footer and digest are both unchanged stays silent -
 * that is a canonicalized snapshot timestamp, not news.
 */
function announcementKindFor(
  prior: RowAnnouncementState | undefined,
  next: RowAnnouncementState,
): ChatAnnouncementKind | null {
  if (!next.settled) return null;
  if (prior === undefined) return announcementKindForSettledRow(next, 0);
  if (!prior.settled) {
    return announcementKindForSettledRow(next, prior.settledTriggerCount);
  }
  if (!prior.footerless) return null;
  if (!next.footerless) return "turn-completed";
  if (next.notificationDigest === prior.notificationDigest) return null;
  return announcementKindForSettledRow(next, prior.settledTriggerCount);
}

export interface ChatAnnouncementsInput {
  readonly messages: ReadonlyArray<ChatMessage>;
  /**
   * `ChatSessionState.transcriptBaselineEpoch` - the connection whose
   * authoritative snapshot established the current transcript. A change means
   * "this transcript was (re)hydrated wholesale"; an unchanged value means
   * "we have been connected and watching since the last observation".
   */
  readonly baselineEpoch: number;
  /**
   * `ChatSessionState.transcriptHydrationSequence` - bumped when a range
   * response seated rows the reader scrolled to. A change means "rows that
   * just appeared are unloaded history, not arrivals".
   */
  readonly hydrationSequence: number;
  /**
   * `ChatSessionState.coldRewrittenMessageIds` - rows the store rewrote while
   * their span was EVICTED, and therefore could not publish at the time.
   *
   * The exemption from the history rule below, and the only way this hook can
   * tell the two cases apart. A detached background task completing in a cold
   * row is genuinely new - the reader has never seen it - but the store
   * deliberately drops the live delta (the persisted host body carries it at
   * the next hydration), so the row first becomes observable across a
   * hydration and takes the history path. This hook supplies background
   * completion speech; without the exemption that live update is never
   * announced when the row becomes available again.
   */
  readonly coldRewrittenMessageIds: ReadonlySet<string>;
}

export function useChatAnnouncements(
  input: ChatAnnouncementsInput,
): ChatAnnouncement | null {
  const {
    messages,
    baselineEpoch,
    coldRewrittenMessageIds,
    hydrationSequence,
  } = input;
  const [announcement, setAnnouncement] = useState<ChatAnnouncement | null>(
    null,
  );
  const observedRef = useRef<ReadonlyMap<string, RowAnnouncementState> | null>(
    null,
  );
  const baselineEpochRef = useRef<number | null>(null);
  const hydrationSequenceRef = useRef<number | null>(null);
  const sequenceRef = useRef(0);
  /**
   * Cold-rewrite ids this hook has already spent its exemption on.
   *
   * The store's set is append-only within an epoch - it records that a rewrite
   * happened, and has no way to know when a reader was told. One-shot is what
   * the exemption needs, though: a row exempted, announced, later evicted and
   * hydrated AGAIN would otherwise announce a completion the reader was
   * already told about, every time it scrolled past. Keeping the consumption
   * here rather than round-tripping a clear through the store also keeps this
   * hook's only output an announcement.
   */
  const consumedColdRewritesRef = useRef<Set<string>>(new Set());

  useLayoutEffect(() => {
    const observed = new Map<string, RowAnnouncementState>();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      observed.set(message.id, rowAnnouncementState(message));
    }
    const previous = observedRef.current;
    const previousEpoch = baselineEpochRef.current;
    const previousHydration = hydrationSequenceRef.current;
    observedRef.current = observed;
    baselineEpochRef.current = baselineEpoch;
    hydrationSequenceRef.current = hydrationSequence;
    // First observation, or a snapshot that re-established the transcript:
    // absorb it as the baseline. History never announces.
    if (previous === null || previousEpoch !== baselineEpoch) {
      // The store clears its own set on a rebase, so the consumption record
      // has to go with it - otherwise an id reused across epochs would find
      // its exemption already spent.
      consumedColdRewritesRef.current = new Set();
      return;
    }
    // A range response seated rows the reader scrolled to. Rows already known
    // are still evaluated - a live turn can settle in the same commit that
    // hydrates old scrollback - but a row that FIRST appears here is history
    // arriving late, not news.
    const hydrating = previousHydration !== hydrationSequence;
    // Spends this row's exemption, if it has one. Called only from the branch
    // that would otherwise skip, so a row arriving on the LIVE path keeps its
    // exemption for a later eviction rather than burning it on an announcement
    // it was going to get anyway.
    const claimColdRewrite = (messageId: string): boolean => {
      if (!coldRewrittenMessageIds.has(messageId)) return false;
      if (consumedColdRewritesRef.current.has(messageId)) return false;
      consumedColdRewritesRef.current.add(messageId);
      return true;
    };
    let kind: ChatAnnouncementKind | null = null;
    for (const message of messages) {
      const next = observed.get(message.id);
      if (next === undefined) continue;
      const prior = previous.get(message.id);
      const candidate = announcementKindFor(prior, next);
      // ANNOUNCEABLE first, then the exemption - and the order is the whole
      // fix. A cold-rewritten row that first hydrates while still RUNNING has
      // no announcement to make, so spending its exemption here buys nothing
      // and costs the announcement it exists for: when that row later completes
      // while evicted, its next hydration finds the claim already consumed,
      // takes the history path, and the completion is never announced.
      //
      // `claimColdRewrite` writes as it tests, so it cannot be called
      // speculatively.
      if (candidate === null) continue;
      if (prior === undefined && hydrating && !claimColdRewrite(message.id)) {
        continue;
      }
      // Last announceable row wins: a batch that settles one turn while
      // appending the next running one announces the settled turn.
      kind = candidate;
    }
    if (kind === null) return;
    sequenceRef.current += 1;
    const sequence = sequenceRef.current;
    // Deferred out of the layout pass: the announcement drives a sibling
    // latch and a live-region child, neither of which belongs in the commit
    // that produced the rows.
    queueMicrotask(() => setAnnouncement({ sequence, kind }));
  }, [messages, baselineEpoch, coldRewrittenMessageIds, hydrationSequence]);

  return announcement;
}

/** A sentence frozen at the semantic transition, independent of display ticks. */
export interface FallbackAnnouncement {
  readonly key: string;
  readonly text: string;
}

/** The semantic key uses host plan/state identity, never countdowns or labels. */
export interface FallbackTraversalAnnouncement {
  readonly traversalId: string;
  readonly revision: number;
  readonly semanticKey: string;
  readonly text: string;
}

/**
 * The countdown card's plan for a frame, with the destination as the card's
 * formatter names it.
 *
 * `countdown` is `routingCountdownPlan` - the card's own reading of the frame,
 * never a second one. The two used to disagree about a wait's resume: the
 * card read the destination against the failed tuple and said "Resuming", the
 * announcer read the rung alone and said "The chat will switch to" the account
 * it was already on (seen live).
 */
export interface FallbackAnnouncementPlan {
  /** The host's plan id, or `null` on a frame that carries no impending step. */
  readonly planId: string | null;
  readonly countdown: RoutingCountdownPlan;
  /** The switch destination, resolved for speech, or `null`. */
  readonly destination: string | null;
}

export function fallbackAnnouncementPlan(
  pending: PendingFallback,
  destination: string | null,
): FallbackAnnouncementPlan {
  const countdown = routingCountdownPlan(pending);
  return {
    planId: pending.impendingAction?.planId ?? null,
    countdown,
    destination: countdown.kind === "switch" ? destination : null,
  };
}

/** What a frame with no plan at all is announced as. */
const NO_COUNTDOWN_PLAN: RoutingCountdownPlan = { kind: "nothing" };

function fallbackTupleAnnouncementKey(tuple: ChatRunSettings | null): string {
  if (tuple === null) return "none";
  return JSON.stringify([
    tuple.harnessId,
    tuple.model,
    tuple.reasoningEffort,
    tuple.profileId,
  ]);
}

/**
 * The button the countdown card offers to refuse this plan, as it is labelled
 * - by the card's own function, so the name spoken is the button drawn.
 */
function countdownRefusalAction(
  pending: PendingFallback,
  plan: RoutingCountdownPlan,
): string {
  return `Select ${countdownRefusalLabel(pending, plan)} to cancel.`;
}

/**
 * The countdown clause, and the one part of it that is not plan-agnostic.
 *
 * Two of the three forms say nothing about WHAT is due, and are true on every
 * plan: "cancel" is honest whatever the plan would have done, and the refusal
 * named is the one the card draws for this plan ({@link countdownRefusalAction}).
 *
 * The due-now form names a switch, and only one plan has one. A resume attempts
 * the same tuple again, a wait parks until a reset, `nothing` stops and leaves
 * the error standing, `deciding` does not know yet - on all four, "The switch
 * is due now" asserted a move that was not going to happen, to the one audience
 * that cannot see the card contradicting it.
 *
 * The seconds are the card headline's: both count down to `pending.deadline`.
 * They are said once per plan - the observer keys on the plan, never the tick
 * (`spokenPlanKey`).
 */
function cancelOpportunityText(
  deadline: number | null,
  now: number,
  planIsSwitch: boolean,
  action: string,
): string {
  if (deadline === null) return action;
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1_000));
  if (seconds === 0) {
    return planIsSwitch
      ? `The switch is due now. ${action}`
      : `The countdown is up. ${action}`;
  }
  return `You have ${seconds} ${seconds === 1 ? "second" : "seconds"} to cancel. ${action}`;
}

/**
 * A plan sentence and the identities it NAMED.
 *
 * The two travel together because `semanticKey` deduplicates on identity and
 * the sentence is what the user hears: an identity in the key that the words
 * never used re-announces text that has not changed, and a spoken one missing
 * from the key silences a correction. Which identity a line speaks is not
 * uniform - a resume and a wait name the failed tuple, a switch names its
 * destination, and `deciding` / `nothing` name neither - so the answer has to
 * come from the branch that wrote the words rather than from a predicate
 * standing beside it.
 */
interface FallbackPlanLine {
  readonly text: string;
  readonly spoken: ReadonlyArray<string>;
}

function fallbackPlanText(
  plan: FallbackAnnouncementPlan | null,
  failedIdentity: string,
  now: number,
): FallbackPlanLine {
  const countdown = plan?.countdown ?? NO_COUNTDOWN_PLAN;
  switch (countdown.kind) {
    case "nothing":
      return {
        text: "There's nowhere to route this chat. It will stop and keep the error visible.",
        spoken: [],
      };
    case "deciding":
      return { text: "Working out where to route this chat…", spoken: [] };
    case "switch": {
      const destination = plan?.destination ?? null;
      return destination === null
        ? { text: "The host is checking the next destination.", spoken: [] }
        : {
            text: `The chat will switch to ${destination}.`,
            spoken: [destination],
          };
    }
    // The card's "Resuming in 12s": the wait finishing onto the account the
    // chat never left, so there is nothing to switch to.
    case "resume":
      return {
        text: `The chat will resume on ${failedIdentity}.`,
        spoken: [failedIdentity],
      };
    case "wait":
      return countdown.resumesAt === null
        ? {
            text: `The host is checking when ${failedIdentity} can resume.`,
            spoken: [failedIdentity],
          }
        : {
            text: `The chat will wait for ${failedIdentity} and resume at ${formatWaitTime(countdown.resumesAt, now)}.`,
            spoken: [failedIdentity],
          };
  }
}

/** A cost-line clause as a sentence of its own: "2 queued messages move with it." */
function countSentence(clause: string): string {
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}

/**
 * The countdown as the card states it: the plan, the count clauses that are
 * true, and the refusal with its time. Nothing the card no longer shows - the
 * fresh-session helper is the picker footer's, and a countdown applies to the
 * failed turn, not "your next message" (clutter cuts, 2026-09-27).
 */
function fallbackHoldText(
  pending: PendingFallback,
  plan: FallbackAnnouncementPlan | null,
  failedIdentity: string,
  now: number,
): FallbackPlanLine {
  const countdown = plan?.countdown ?? NO_COUNTDOWN_PLAN;
  const line = fallbackPlanText(plan, failedIdentity, now);
  const parts = [
    line.text,
    ...routingCountdownCountClauses(pending, countdown).map(countSentence),
    cancelOpportunityText(
      pending.deadline,
      now,
      countdown.kind === "switch",
      countdownRefusalAction(pending, countdown),
    ),
  ];
  // Everything this wrapper adds - the counts and the countdown - names no
  // tuple, so the identities are the inner line's unchanged.
  return { text: parts.join(" "), spoken: line.spoken };
}

// The plan is keyed only where the sentence SPEAKS it: `hold` and `choosing`.
// `switching` and `waiting` name a tuple, and a plan moving under an unchanged
// sentence re-announced it - after a wait's resumed attempt failed, the host
// entered its next rung while still `switching` onto the resumed tuple, and
// "Resuming this chat on …" was said again after "Resumed on …" (seen live).
// A frame with no host plan id is keyed by what the card reads instead: its
// plan kind and target.
function spokenPlanKey(
  pending: PendingFallback,
  plan: FallbackAnnouncementPlan | null,
): readonly [string | null, string | null] {
  if (pending.state !== "hold" && pending.state !== "choosing") {
    return [null, null];
  }
  const planId = plan?.planId ?? null;
  if (planId !== null) return [planId, null];
  return [
    (plan?.countdown ?? NO_COUNTDOWN_PLAN).kind,
    fallbackTupleAnnouncementKey(pending.targetTuple),
  ];
}

export function fallbackTraversalAnnouncement(input: {
  readonly pending: PendingFallback | undefined;
  readonly plan: FallbackAnnouncementPlan | null;
  readonly failedIdentity: string;
  readonly targetIdentity: string | null;
  readonly now: number;
}): FallbackTraversalAnnouncement | null {
  const { pending, plan, failedIdentity, targetIdentity, now } = input;
  // The transient retry row already announces its attempts. This persistent
  // path owns the intervention window and its subsequent lifecycle.
  if (pending === undefined || pending.state === "retrying") return null;
  let text: string;
  // The identities this branch actually SPOKE, carried out of the same code
  // that builds the sentence.
  //
  // Not "both of them": `semanticKey` is what the observer deduplicates on, so
  // an identity in the key the TEXT never used re-enqueues a sentence that has
  // not changed a character, and a screen reader says it twice.
  //
  // Which identity a branch names is genuinely irregular, which is why this is
  // reported rather than derived. `waiting` and the resume arm of `switching`
  // name the failed tuple; an ordinary `switching` names its destination; and
  // `hold` / `choosing` name whichever their PLAN line named - the failed tuple
  // under a resume and a wait, the destination under a switch, neither under
  // `deciding`, `nothing` or no plan at all. A predicate standing beside the
  // text would have to restate all of that and would drift from it the first
  // time a sentence moved.
  let spokenIdentities: ReadonlyArray<string>;
  switch (pending.state) {
    case "hold": {
      const line = fallbackHoldText(pending, plan, failedIdentity, now);
      text = line.text;
      spokenIdentities = line.spoken;
      break;
    }
    case "choosing": {
      const line = fallbackPlanText(plan, failedIdentity, now);
      text = `Countdown paused. ${line.text} Choose a destination or close the menu to resume the countdown.`;
      spokenIdentities = line.spoken;
      break;
    }
    case "switching": {
      // The wait rung's resume runs these same phases onto the tuple that
      // failed, so there is nowhere to switch TO: "Switching this chat to <the
      // model it was already on>" announced a move that never happened. The
      // card's plan decides it, as it decides the card's "Resuming now…".
      if (plan?.countdown.kind === "resume") {
        text = `Resuming this chat on ${failedIdentity}.`;
        spokenIdentities = [failedIdentity];
        break;
      }
      const destination = targetIdentity ?? plan?.destination ?? null;
      // No destination: a rung's commit phase entering it, the plan re-pointed
      // at that rung and still resolving. The next breath names a target
      // (announced below, as the switch it is) or skips the rung for the next
      // one (announced as whatever it becomes), so there is no switch to
      // announce yet - and "The host is preparing the provider switch." was
      // false every time the rung was skipped, as on the way to a wait.
      if (destination === null) return null;
      text = `Switching this chat to ${destination}.`;
      // The resolved `destination`, not `targetIdentity`: when the catalogue
      // has not landed this sentence names `plan.destination` instead, and
      // keying on the input rather than on what was SAID would move the key
      // while the text stood still.
      spokenIdentities = [destination];
      break;
    }
    case "waiting": {
      const resume =
        pending.deadline === null
          ? "The host will resume when the verified reset is ready."
          : `Resuming at ${formatWaitTime(pending.deadline, now)}.`;
      text = `Waiting for ${failedIdentity}. ${resume} Select ${STOP_WAITING_LABEL} to cancel.`;
      spokenIdentities = [failedIdentity];
      break;
    }
  }
  return {
    traversalId: pending.traversalId,
    revision: pending.revision,
    // No tick, deadline, queued count or sibling count here. The host plan id
    // changes when its action or destination changes.
    //
    // The SPOKEN identities are in the key, and that is a deliberate exception
    // to "no display labels". The model catalogue is fetched only once a
    // fallback exists, so the FIRST fallback of a cold session observes before
    // it resolves and names the raw slug - "claude-fable-5-1[1m]", the
    // provider-internal string this feature exists to stop showing. The
    // resolver updates a moment later, but without them the corrected sentence
    // deduplicates against the slug one and the user is never told the real
    // model name.
    //
    // Safe to key on precisely because they are pure IDENTITY - provider,
    // account and model. Unlike a tick or a deadline they change once, when
    // the catalogue lands, and then hold, so this re-announces a corrected
    // name rather than re-announcing continuously.
    //
    // SPOKEN, not both of them: the branch reports what its sentence named, so
    // the key moves when the words move and not otherwise.
    semanticKey: JSON.stringify([
      pending.state,
      ...spokenPlanKey(pending, plan),
      spokenIdentities,
    ]),
    text,
  };
}

export function fallbackReturnAnnouncement(
  pending: PendingReturn | undefined,
  preferredIdentity: string,
): FallbackTraversalAnnouncement | null {
  if (pending === undefined) return null;
  // The card's headline and its one count clause, when true - nothing the
  // card no longer shows (clutter cuts, 2026-09-27).
  const returning = queuedReturningClause(pending.queuedItemsMoving);
  const parts = [`Switch back to ${preferredIdentity}?`];
  if (returning !== null) parts.push(`Switching back ${returning}.`);
  return {
    traversalId: pending.traversalId,
    revision: pending.revision,
    semanticKey: JSON.stringify([
      pending.offeredAt,
      fallbackTupleAnnouncementKey(pending.preferredTuple),
      // Same exception as the traversal key above, for the same reason: this
      // sentence names a resolved account and model, and on a cold catalogue
      // the slug-named version would otherwise be the only one ever heard.
      preferredIdentity,
    ]),
    text: parts.join(" "),
  };
}

export interface FallbackNoticeAnnouncement extends FallbackAnnouncement {
  readonly messageId: string;
}

// A routing notice is spoken by its TITLE alone - the label-form sentence its
// divider reads ("Switched to Sonnet 5 · Low on Surya after a rate limit").
// The message and the detail rows are the raw route a bug report wants
// ("claude/sonnet (Surya 2) → claude/sonnet (Surya)", "Failed on: …",
// "Tried: none"), and reading them aloud after every hop told a screen-reader
// user provider slugs no sighted user is shown (seen live).
function fallbackNoticeText(title: string): string {
  return title;
}

/** Confirmed host metadata reaches this path even when its row is unloaded. */
export function fallbackOutcomeAnnouncement(
  outcome: LastFallbackOutcome | undefined,
): FallbackNoticeAnnouncement | null {
  if (outcome === undefined) return null;
  // The slot carries the transcript's refusal notice too, and what the
  // transcript hides is not spoken. Silence is the answer after a refusal: an
  // earlier hop's outcome in the slot was spoken when it landed.
  if (isRoutingCancellationOutcome(outcome)) return null;
  return {
    key: `notice:${outcome.blockId}`,
    messageId: outcome.assistantMessageId,
    text: fallbackNoticeText(outcome.title),
  };
}

/** Only host-authored prose is spoken; a notice kind alone is not an outcome. */
export function fallbackNoticeAnnouncements(
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<FallbackNoticeAnnouncement> {
  const notices: FallbackNoticeAnnouncement[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const segment of message.segments) {
      if (
        segment.kind !== "provider_notice" ||
        segment.parentId !== null ||
        segment.status !== "completed"
      ) {
        continue;
      }
      // ONE list, shared with the transcript's settings-link gate rather than
      // restated here. These were two hand-maintained enumerations of the same
      // five kinds, and nothing made a sixth kind added to one of them show up
      // in the other - the failure mode being a new fallback notice that draws
      // its affordance in the transcript and is silently never announced, or
      // the reverse. `FALLBACK_NOTICE_KINDS` is the single definition and its
      // own suite pins it exhaustively against `providerNoticeKindSchema`.
      //
      // The return's two endings are in that set (row #4 split
      // `fallback_applied` into the forward hop and these). Both are spoken,
      // and the "stayed put" one is not an exception: a chat that did NOT move
      // when it offered to is exactly as much news as one that did, and its
      // title is what says which.
      if (!isFallbackNoticeKind(segment.noticeKind)) {
        continue;
      }
      // Hidden in the transcript on every host, so never spoken either
      // (`hidden-transcript-notices.ts`).
      if (isRoutingCancellationNotice(segment)) continue;
      notices.push({
        key: `notice:${segment.id}`,
        messageId: message.id,
        text: fallbackNoticeText(segment.title),
      });
    }
  }
  return notices;
}

export interface FallbackAnnouncementsInput {
  /** Visible, connected, and past the first authoritative snapshot. */
  readonly ready: boolean;
  readonly baselineEpoch: number;
  readonly hydrationSequence: number;
  readonly coldRewrittenMessageIds: ReadonlySet<string>;
  readonly residentMessageIds: ReadonlySet<string>;
  readonly traversal: FallbackTraversalAnnouncement | null;
  readonly returnOffer: FallbackTraversalAnnouncement | null;
  /** Host outcome metadata, independent of transcript range hydration. */
  readonly liveOutcome: FallbackNoticeAnnouncement | null;
  readonly notices: ReadonlyArray<FallbackNoticeAnnouncement>;
  /** A confirmed manual result, correlated to this host, chat and attempt. */
  readonly manualOutcome: FallbackAnnouncement | null;
  /**
   * An outcome whose initiating surface had already gone (MF11).
   *
   * A separate slot from {@link manualOutcome} rather than the same one, and
   * not for tidiness: the two are produced independently and can be published
   * in the same observation, so one slot would silently drop whichever arrived
   * second. They also mean opposite things - one is a confirmed action, the
   * other is the answer nobody was left to hear.
   */
  readonly unattendedOutcome: FallbackAnnouncement | null;
}

export interface FallbackAnnouncementObserver {
  readonly observe: (
    input: FallbackAnnouncementsInput,
  ) => ReadonlyArray<FallbackAnnouncement>;
  /**
   * Whether an observation with these inputs would ABSORB rather than speak.
   *
   * Exposed for one caller and one reason: a producer that is DEFERRING an
   * event has to know whether handing it over now would deliver it or bin it.
   * An absorbing observation still records the key, so a deferred outcome
   * passed into one is consumed and silently dropped - and the caller cannot
   * work this out for itself, because absorption turns on state only the
   * observer holds (the readiness of the PREVIOUS observation, and the
   * baseline epoch it last saw).
   *
   * Call it with the same inputs as the `observe` that follows; `observe`
   * mutates both, so the answer is only good for the next one.
   */
  readonly willAbsorb: (input: {
    readonly ready: boolean;
    readonly baselineEpoch: number;
  }) => boolean;
}

interface ObservedFallbackTraversal {
  readonly revision: number;
  readonly semanticKey: string;
}

/**
 * Observes semantic news for one mounted chat. The input adapter owns copy and
 * protocol interpretation; this owns provenance and one-time delivery. Keeping
 * it independent of React also lets a store subscription observe intermediate
 * transitions that React may render together.
 */
export function createFallbackAnnouncementObserver(): FallbackAnnouncementObserver {
  let baselineEpoch: number | null = null;
  let hydrationSequence: number | null = null;
  let residentMessageIds: ReadonlySet<string> = new Set();
  let wasReady = false;
  const traversals = new Map<string, ObservedFallbackTraversal>();
  const seenTransitions = new Set<string>();
  // A body first seen through history stays history on subsequent renders.
  // It does not consume a later independently confirmed outcome: a range
  // reply can arrive before the snapshot carrying that outcome's metadata.
  const seenNoticeBodies = new Set<string>();
  // Block ids unite delivered notices, confirmed outcomes and absorbed
  // baselines across row replacement, hydration and reconnect.
  const consumedNotices = new Set<string>();
  const seenManualOutcomes = new Set<string>();
  const seenUnattendedOutcomes = new Set<string>();

  // One definition of absorption, read by `observe` and answered to callers
  // through `willAbsorb`. Two spellings of this rule would be a defect waiting
  // to happen: a producer deciding whether to hand an event over has to be
  // asking the same question the delivery then answers.
  const willAbsorb = (input: {
    readonly ready: boolean;
    readonly baselineEpoch: number;
  }): boolean =>
    baselineEpoch !== input.baselineEpoch || !wasReady || !input.ready;

  return {
    willAbsorb,
    observe: (input) => {
      const absorb = willAbsorb(input);
      const hydrating = hydrationSequence !== input.hydrationSequence;
      const priorResidentMessageIds = residentMessageIds;
      baselineEpoch = input.baselineEpoch;
      hydrationSequence = input.hydrationSequence;
      residentMessageIds = input.residentMessageIds;
      wasReady = input.ready;
      // A reconnect changes provenance, not block or traversal identity.
      // Retain consumed keys even when the new baseline omits their cold rows.

      const announcements: FallbackAnnouncement[] = [];
      const observeTraversal = (
        source: "fallback" | "return",
        next: FallbackTraversalAnnouncement | null,
      ): void => {
        if (next === null) return;
        const traversalKey = JSON.stringify([source, next.traversalId]);
        const prior = traversals.get(traversalKey);
        // Replayed older frames must not rewind our idea of the live state.
        if (prior !== undefined && next.revision < prior.revision) return;
        traversals.set(traversalKey, {
          revision: next.revision,
          semanticKey: next.semanticKey,
        });
        const key = JSON.stringify([
          source,
          next.traversalId,
          next.revision,
          next.semanticKey,
        ]);
        const seen = seenTransitions.has(key);
        seenTransitions.add(key);
        // A revision can move because of bookkeeping alone. Conversely, a
        // later hold after choosing is news even if the plan is the same.
        if (seen || absorb || prior?.semanticKey === next.semanticKey) return;
        announcements.push({ key, text: next.text });
      };
      observeTraversal("fallback", input.traversal);
      observeTraversal("return", input.returnOffer);

      const liveOutcome = input.liveOutcome;
      if (liveOutcome !== null && !consumedNotices.has(liveOutcome.key)) {
        consumedNotices.add(liveOutcome.key);
        if (!absorb) {
          announcements.push({ key: liveOutcome.key, text: liveOutcome.text });
        }
      }
      for (const notice of input.notices) {
        const seen = seenNoticeBodies.has(notice.key);
        seenNoticeBodies.add(notice.key);
        if (absorb) {
          consumedNotices.add(notice.key);
          continue;
        }
        if (seen || consumedNotices.has(notice.key)) continue;
        if (
          hydrating &&
          !priorResidentMessageIds.has(notice.messageId) &&
          !input.coldRewrittenMessageIds.has(notice.messageId)
        ) {
          continue;
        }
        consumedNotices.add(notice.key);
        announcements.push({ key: notice.key, text: notice.text });
      }

      // The two direct outcome slots. One rule, written once and applied
      // twice: remember the key whether or not it is spoken (so a replay is
      // silent either way), and speak it unless this observation is absorbing
      // - a record already in the store when the observer took its baseline is
      // history, and a reconnect is a change of provenance, not a second
      // event. Their seen-sets stay SEPARATE: the keys are namespaced by
      // producer and sharing one set would let a confirmed action suppress an
      // unattended answer that happened to collide.
      const deliverDirectOutcome = (
        seen: Set<string>,
        outcome: FallbackAnnouncement | null,
      ): void => {
        if (outcome === null || seen.has(outcome.key)) return;
        seen.add(outcome.key);
        if (!absorb) announcements.push(outcome);
      };
      deliverDirectOutcome(seenManualOutcomes, input.manualOutcome);
      deliverDirectOutcome(seenUnattendedOutcomes, input.unattendedOutcome);
      return announcements;
    },
  };
}

interface RenderedChatAnnouncement {
  readonly sequence: number;
  readonly text: string;
}

interface ChatAnnouncementQueue {
  readonly announcement: RenderedChatAnnouncement | null;
  readonly enqueue: (texts: ReadonlyArray<string>) => void;
  readonly reset: () => void;
}

/** Keeps every transition React batches before the live region commits. */
export function useChatAnnouncementQueue(): ChatAnnouncementQueue {
  const [announcement, setAnnouncement] =
    useState<RenderedChatAnnouncement | null>(null);
  const pending = useRef<RenderedChatAnnouncement[]>([]);
  const sequence = useRef(0);
  const generation = useRef(0);
  const scheduled = useRef(false);

  const reset = useCallback(() => {
    generation.current += 1;
    pending.current = [];
    scheduled.current = false;
    setAnnouncement(null);
  }, []);

  const enqueue = useCallback((texts: ReadonlyArray<string>) => {
    if (texts.length === 0) return;
    for (const text of texts) {
      sequence.current += 1;
      pending.current.push({ sequence: sequence.current, text });
    }
    if (scheduled.current) return;
    scheduled.current = true;
    const queuedGeneration = generation.current;
    queueMicrotask(() => {
      if (queuedGeneration !== generation.current) return;
      scheduled.current = false;
      const last = pending.current.at(-1);
      if (last === undefined) return;
      setAnnouncement({
        sequence: last.sequence,
        text: pending.current.map((entry) => entry.text).join(" "),
      });
    });
  }, []);

  useLayoutEffect(() => {
    if (announcement === null) return;
    // A later microtask can add news before this commit. Consume only what
    // the region actually rendered, leaving that later news in the queue.
    pending.current = pending.current.filter(
      (entry) => entry.sequence > announcement.sequence,
    );
  }, [announcement]);

  useLayoutEffect(
    () => () => {
      generation.current += 1;
      pending.current = [];
      scheduled.current = false;
    },
    [],
  );

  return { announcement, enqueue, reset };
}
