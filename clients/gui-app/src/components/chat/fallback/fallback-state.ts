import type {
  PendingFallback,
  PendingReturn,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * A chat's provider-fallback surface state, as the tile hands it down.
 *
 * One group rather than two peer props because the surfaces appear and vanish
 * together and travel through the same three hops of the tile's prop chain.
 *
 * Named "provider fallback" wherever it is threaded, never bare "fallback": the
 * composer already has a `fallbackSettingsSeed` meaning "the settings to use
 * when there is no seed", and two unrelated senses of the word one prop apart
 * is how the wrong one gets read.
 *
 * **Both fields are read BY VALUE, never by key presence.** On a live
 * `chat.subscribe@1.9` frame the host sets both keys unconditionally, with
 * `undefined` meaning "there is nothing here" - so `"pendingReturn" in state`
 * is true for a chat that has never had a fallback, and a surface gated on
 * presence renders forever.
 */
export interface ChatProviderFallbackState {
  /** The live traversal holding this chat's dispatch, or `undefined`. */
  readonly pending: PendingFallback | undefined;
  /** The surfaced switch-back offer, or `undefined`. */
  readonly pendingReturn: PendingReturn | undefined;
}

/**
 * The empty state, for surfaces that render outside a chat with a host stream
 * (the home composer) and for tests that do not exercise fallback.
 *
 * A shared frozen value rather than a fresh object literal per call site: these
 * flow through `useShallow` comparisons, and a new `{}` each render would make
 * every consumer re-render on every frame.
 */
export const NO_PROVIDER_FALLBACK: ChatProviderFallbackState = {
  pending: undefined,
  pendingReturn: undefined,
};

/**
 * The traversal states the grace card renders.
 *
 * `retrying` has its own transient row at the turn tail and `waiting` has its
 * own card - both say something different enough that folding them in would
 * need a second set of copy inside one component.
 */
const GRACE_CARD_STATES: ReadonlySet<PendingFallback["state"]> = new Set([
  "hold",
  "choosing",
  "switching",
]);

export function fallbackGraceCardVisible(
  pending: PendingFallback | undefined,
): boolean {
  return pending !== undefined && GRACE_CARD_STATES.has(pending.state);
}

export function fallbackWaitingCardVisible(
  pending: PendingFallback | undefined,
): boolean {
  return pending !== undefined && pending.state === "waiting";
}

/**
 * Whether the composer's banner slot holds a fallback card at all.
 *
 * The union of the two predicates above, and it exists ONLY to answer the
 * banner-precedence question - which slot wins. It is deliberately not what
 * decides which card renders: the two predicates stay separate and are each
 * checked on their own, so a traversal state that neither claims renders
 * nothing rather than falling through to whichever branch happens to be last.
 * A `waiting ? A : B` ternary reads as equivalent and is not - it hands every
 * unclaimed state to `B`.
 */
export function fallbackComposerCardVisible(
  pending: PendingFallback | undefined,
): boolean {
  return (
    fallbackGraceCardVisible(pending) || fallbackWaitingCardVisible(pending)
  );
}
