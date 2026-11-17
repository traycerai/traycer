import { create } from "zustand";
import type { ToolCallFeedbackDraftStamp } from "@traycer/protocol/persistence/epic/content-blocks";

/** A draft block, the host whose chat holds it, and who decided it. */
export interface FeedbackDraftDecisionAddress {
  readonly hostId: string;
  readonly userId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly blockId: string;
}

interface HeldDecision {
  readonly address: FeedbackDraftDecisionAddress;
  readonly stamp: ToolCallFeedbackDraftStamp;
}

interface FeedbackDraftDecisionState {
  readonly decisions: ReadonlyMap<string, HeldDecision>;
  record: (
    address: FeedbackDraftDecisionAddress,
    stamp: ToolCallFeedbackDraftStamp,
  ) => void;
  /** Every account's decision on one draft: its authoritative state arrived. */
  retireDraft: (
    hostId: string,
    epicId: string,
    chatId: string,
    blockId: string,
  ) => void;
  /** Every decision on one host: its signed-in account changed. */
  retireHost: (hostId: string) => void;
}

export function feedbackDraftDecisionKey(
  address: FeedbackDraftDecisionAddress,
): string {
  return JSON.stringify([
    address.hostId,
    address.userId,
    address.epicId,
    address.chatId,
    address.blockId,
  ]);
}

function without(
  decisions: ReadonlyMap<string, HeldDecision>,
  drop: (held: HeldDecision) => boolean,
): ReadonlyMap<string, HeldDecision> | null {
  const next = new Map(Array.from(decisions).filter(([, held]) => !drop(held)));
  return next.size === decisions.size ? null : next;
}

/**
 * The answer that sent or skipped a draft, held from that answer until the
 * draft's notification row resolves or its host's account changes.
 *
 * A decision made on the draft's card must keep its notification row settled
 * after the card closes, and the row's own resolve has no time bound. Only
 * the deciding stamp is held, never the request that produced it, and it is
 * keyed by the account that decided, so another account reads nothing here.
 */
export const useFeedbackDraftDecisionStore = create<FeedbackDraftDecisionState>(
  (set) => ({
    decisions: new Map(),
    record: (address, stamp) =>
      set((state) => {
        const next = new Map(state.decisions);
        next.set(feedbackDraftDecisionKey(address), { address, stamp });
        return { decisions: next };
      }),
    retireDraft: (hostId, epicId, chatId, blockId) =>
      set((state) => {
        const next = without(
          state.decisions,
          ({ address }) =>
            address.hostId === hostId &&
            address.epicId === epicId &&
            address.chatId === chatId &&
            address.blockId === blockId,
        );
        return next === null ? state : { decisions: next };
      }),
    retireHost: (hostId) =>
      set((state) => {
        const next = without(
          state.decisions,
          ({ address }) => address.hostId === hostId,
        );
        return next === null ? state : { decisions: next };
      }),
  }),
);
