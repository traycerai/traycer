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
 * - While the epoch is unchanged the client is connected and watching, so any
 *   row that reaches a settled state - or whose background-completion digest
 *   changes - is news, again regardless of position or timestamp.
 *
 * That leaves announcement selection a pure function of per-row semantic
 * state keyed by row id, with no cross-row comparisons and no tie-breaking.
 */

export type ChatAnnouncementKind =
  "turn-completed" | "background-completion" | "background-update";

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
}

export function useChatAnnouncements(
  input: ChatAnnouncementsInput,
): ChatAnnouncement | null {
  const { messages, baselineEpoch } = input;
  const [announcement, setAnnouncement] = useState<ChatAnnouncement | null>(
    null,
  );
  const observedRef = useRef<ReadonlyMap<string, RowAnnouncementState> | null>(
    null,
  );
  const baselineEpochRef = useRef<number | null>(null);
  const sequenceRef = useRef(0);

  useLayoutEffect(() => {
    const observed = new Map<string, RowAnnouncementState>();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      observed.set(message.id, rowAnnouncementState(message));
    }
    const previous = observedRef.current;
    const previousEpoch = baselineEpochRef.current;
    observedRef.current = observed;
    baselineEpochRef.current = baselineEpoch;
    // First observation, or a snapshot that re-established the transcript:
    // absorb it as the baseline. History never announces.
    if (previous === null || previousEpoch !== baselineEpoch) return;
    let kind: ChatAnnouncementKind | null = null;
    for (const message of messages) {
      const next = observed.get(message.id);
      if (next === undefined) continue;
      const candidate = announcementKindFor(previous.get(message.id), next);
      // Last announceable row wins: a batch that settles one turn while
      // appending the next running one announces the settled turn.
      if (candidate !== null) kind = candidate;
    }
    if (kind === null) return;
    sequenceRef.current += 1;
    const sequence = sequenceRef.current;
    // Deferred out of the layout pass: the announcement drives a sibling
    // latch and a live-region child, neither of which belongs in the commit
    // that produced the rows.
    queueMicrotask(() => setAnnouncement({ sequence, kind }));
  }, [messages, baselineEpoch]);

  return announcement;
}
