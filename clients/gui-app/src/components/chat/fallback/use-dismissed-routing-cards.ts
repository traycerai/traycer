import { create } from "zustand";
import type { PendingFallback } from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * The two cards that render a dismiss ×, and therefore the two things a
 * dismissal can be ABOUT.
 *
 * `countdown` is `<FallbackGraceCard>` across all three of its states;
 * `waiting` is `<FallbackWaitingCard>`.
 */
export type RoutingCardKind = "countdown" | "waiting";

/**
 * Which routing cards the user has waved away, per chat and per traversal.
 *
 * ## What a dismissal is NOT
 *
 * It is not "Don't switch", and the distinction is the whole reason this store
 * exists rather than the × reusing the cancel mutation. "Don't switch" is an
 * ANSWER: it ends the traversal, keeps the error, and leaves the queue paused.
 * A dismissal is the user saying *I have read this, stop occupying my
 * composer* - the countdown keeps running, the switch still happens, and the
 * transcript notice still records it afterwards. Wiring the × to cancel would
 * silently turn "get this out of my way" into "abandon the recovery", which is
 * the most expensive misreading available on this card.
 *
 * ## Why the key carries the traversal AND the card
 *
 * A dismissal is about ONE episode, not about the chat. Keyed by chat alone,
 * waving away today's rate-limit countdown would also swallow the card for a
 * different failure three turns later - the user would have muted a feature by
 * tidying a banner. `traversalId` scopes it to the episode in front of them,
 * and a new failure opens a new traversal and therefore a new card.
 *
 * The traversal alone is still too WIDE, because one traversal walks a whole
 * ladder under a single id: a switch whose replacement fails advances to a wait
 * on the SAME `traversalId`. Keyed by the episode alone, waving away the
 * countdown would also swallow the wait card that the next rung raises - and
 * the wait card is the one surface telling the user their chat is parked until
 * a provider's limit resets, about a state they have never been shown. So the
 * key carries which CARD was waved away.
 *
 * Card identity rather than `PendingFallbackState`, and the difference is the
 * point: `hold`, `choosing` and `switching` are three states of ONE card, so
 * keying by state would resurrect the countdown the user just dismissed a
 * second later when the grace window expired into `switching`. The two values
 * here are exactly the two components that render a ×, which is what the user
 * is actually dismissing.
 *
 * ## Why the card kind is still not enough, and the ACTION is the last segment
 *
 * One traversal can raise the same KIND of card twice about different things.
 * A hold planning a switch to Codex can be re-planned onto Gemini inside the
 * same traversal - a new `impendingAction`, a new destination, a new countdown
 * to cancel - and both are `countdown` cards. Keyed by kind alone, waving away
 * the first also swallowed the second, so the user lost the intervention
 * window for a destination they had never been shown and never agreed to. A
 * dismissal is the user answering "not this", not "nothing from now on".
 *
 * `planId` is the host's own answer to "is this the same action", and it is
 * why this segment is that and not the destination tuple. The protocol commits
 * it to change if and only if the rung, target, target family, resume time or
 * probe changes, and to stay put across every countdown tick, every
 * `siblingSwitching` change and every revision bump that moved nothing else.
 * So it retains the dismissal across `hold` -> `choosing` -> `switching` for
 * ONE plan - the phases the paragraph above exists to protect - while a
 * genuinely different plan gets a genuinely new card.
 *
 * ## Why it is not persisted
 *
 * Session-scoped on purpose. A countdown that survives an app restart is a
 * countdown still holding the chat's dispatch, and the card is how the user
 * finds out; restoring a dismissal across that boundary would hide a live hold
 * from someone who has lost every other cue that it exists. Within a session
 * the user has just seen it, which is what makes hiding it safe.
 */
interface DismissedRoutingCardsState {
  /**
   * `"<chatId>:<traversalId>:<card>:<action>"` for every card waved away this
   * session.
   */
  readonly dismissed: ReadonlySet<string>;
  readonly dismiss: (
    chatId: string,
    traversalId: string,
    card: RoutingCardKind,
    action: string,
  ) => void;
}

/**
 * The action segment of the key, derived from the frame the card is drawn from.
 *
 * Exported and used by BOTH the gate and the × handlers for the same reason
 * `dismissibleCardKind` is: the value a dismissal is written under and the
 * value it is looked up under have to be decided by one function, or a card
 * could be dismissed under one key and gated on another and never close.
 *
 * `"none"` where the host names no action. That is its own bucket rather than
 * an error: a frame with nothing planned is one thing to dismiss, and it
 * cannot collide with a real plan id.
 */
export function routingCardActionKey(
  pending: PendingFallback | undefined,
): string {
  return pending?.impendingAction?.planId ?? "none";
}

// A ":" separator over anything that could be mistyped invisibly. The first
// three segments are ids and a closed union, none of which can contain one;
// the last is an opaque host string, so it goes LAST, where a ":" inside it
// cannot shift the meaning of any segment before it.
function cardKey(
  chatId: string,
  traversalId: string,
  card: RoutingCardKind,
  action: string,
): string {
  return `${chatId}:${traversalId}:${card}:${action}`;
}

export const useDismissedRoutingCardsStore =
  create<DismissedRoutingCardsState>()((set) => ({
    dismissed: new Set<string>(),
    dismiss: (chatId, traversalId, card, action) => {
      set((state) => {
        const key = cardKey(chatId, traversalId, card, action);
        if (state.dismissed.has(key)) return state;
        const next = new Set(state.dismissed);
        next.add(key);
        return { dismissed: next };
      });
    },
  }));

/**
 * Whether this chat's given card for this traversal has been waved away.
 *
 * A boolean selector rather than handing the caller the Set: the Set is
 * replaced on every dismissal anywhere in the app, so subscribing to it would
 * re-render every mounted routing card whenever any one of them was dismissed.
 */
export function useRoutingCardDismissed(
  chatId: string,
  traversalId: string,
  card: RoutingCardKind,
  action: string,
): boolean {
  return useDismissedRoutingCardsStore((state) =>
    state.dismissed.has(cardKey(chatId, traversalId, card, action)),
  );
}

/** The dismiss action, stable across renders. */
export function useDismissRoutingCard(): (
  chatId: string,
  traversalId: string,
  card: RoutingCardKind,
  action: string,
) => void {
  return useDismissedRoutingCardsStore((state) => state.dismiss);
}
