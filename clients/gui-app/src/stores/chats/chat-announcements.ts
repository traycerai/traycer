import { useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/stores/composer/chat-store";

/**
 * Polite-announcement deriver for the chat transcript (decision #24).
 *
 * The announcement question is "what just happened for this reader", and the
 * only hard part is separating a LIVE arrival from transcript history. This
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
 * That leaves announcement selection a pure function of per-row semantic
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
   * the live region must key its child on this to guarantee a DOM mutation -
   * without one, React reuses the node and a screen reader stays silent.
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
   * hydration and takes the history path. The completion is then announced
   * NOWHERE: `useChatAnnouncements` is the only `aria-live` path for the
   * transcript, so a screen-reader user simply never learns of it.
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
