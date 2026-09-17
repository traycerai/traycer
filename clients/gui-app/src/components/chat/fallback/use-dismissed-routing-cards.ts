import { create } from "zustand";

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
   * `"<chatId>:<traversalId>:<card>"` for every card waved away this session.
   */
  readonly dismissed: ReadonlySet<string>;
  readonly dismiss: (
    chatId: string,
    traversalId: string,
    card: RoutingCardKind,
  ) => void;
}

// A ":" separator over anything that could be mistyped invisibly, and the
// segments are ids and a closed union - none of which can contain one.
function cardKey(
  chatId: string,
  traversalId: string,
  card: RoutingCardKind,
): string {
  return `${chatId}:${traversalId}:${card}`;
}

export const useDismissedRoutingCardsStore =
  create<DismissedRoutingCardsState>()((set) => ({
    dismissed: new Set<string>(),
    dismiss: (chatId, traversalId, card) => {
      set((state) => {
        const key = cardKey(chatId, traversalId, card);
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
): boolean {
  return useDismissedRoutingCardsStore((state) =>
    state.dismissed.has(cardKey(chatId, traversalId, card)),
  );
}

/** The dismiss action, stable across renders. */
export function useDismissRoutingCard(): (
  chatId: string,
  traversalId: string,
  card: RoutingCardKind,
) => void {
  return useDismissedRoutingCardsStore((state) => state.dismiss);
}
