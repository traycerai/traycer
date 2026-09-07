import { useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/stores/composer/chat-store";

/** Polite-announcement deriver for the chat transcript (decision #24). */

export type ChatAnnouncementKind =
  | "turn-completed"
  | "background-completion"
  | "background-update";

export interface ChatAnnouncement {
  /** Monotonic per-transcript counter. */
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
  /** Content version of the row's resume notification. */
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

/** Copy selection for a settled row. */
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

/** The announceable transitions, all on a stable row id: */
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
   * `ChatSessionState.transcriptBaselineEpoch` - the connection whose authoritative snapshot
   * established the current transcript.
   */
  readonly baselineEpoch: number;
  /**
   * `ChatSessionState.transcriptHydrationSequence` - bumped when a range response seated rows the
   * reader scrolled to. A change means "rows that just appeared are unloaded history, not arrivals".
   */
  readonly hydrationSequence: number;
  /**
   * `ChatSessionState.coldRewrittenMessageIds` - rows the store rewrote while their span was
   * EVICTED, and therefore could not publish at the time.
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
  /** Cold-rewrite ids this hook has already spent its exemption on. */
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
      // The store clears its own set on a rebase, so the consumption record has to go with it -
      // otherwise an id reused across epochs would find its exemption already spent.
      consumedColdRewritesRef.current = new Set();
      return;
    }
    // A range response seated rows the reader scrolled to.
    const hydrating = previousHydration !== hydrationSequence;
    // Spends this row's exemption, if it has one.
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
      // ANNOUNCEABLE first, then the exemption - and the order is the whole fix.
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
    // Deferred out of the layout pass: the announcement drives a sibling latch and a live-region
    // child, neither of which belongs in the commit that produced the rows.
    queueMicrotask(() => setAnnouncement({ sequence, kind }));
  }, [messages, baselineEpoch, coldRewrittenMessageIds, hydrationSequence]);

  return announcement;
}
