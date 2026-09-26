import type {
  ChatRunSettings,
  PendingFallback,
  PendingReturn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { pendingFallbackResumesFailedTuple } from "./fallback-identity";

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
 * `chat.subscribe@1.10` frame the host sets both keys unconditionally, with
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
 * The traversal states the countdown card renders.
 *
 * `retrying` has its own transient row at the turn tail and `waiting` is the
 * routing card's waiting state - both say something different enough that
 * folding them into the countdown would need a second set of copy.
 */
const GRACE_CARD_STATES: ReadonlySet<PendingFallback["state"]> = new Set([
  "hold",
  "choosing",
  "switching",
]);

/**
 * What the host's plan for a countdown is, as the card names it.
 *
 * - `switch`: a destination is named (committed, or planned for when the
 *   window ends) and it is somewhere else.
 * - `resume`: the destination IS the tuple that failed - the wait rung's
 *   resume, which runs the switching phases onto the account it never left.
 * - `wait`: park on the failed tuple until its reset - the rung that moves
 *   nothing.
 * - `deciding`: the host has not resolved the plan yet (the candidate walk or
 *   a reset check is out, or a switch rung has no target yet).
 * - `nothing`: the host can name no takeable step - the traversal is about to
 *   settle.
 *
 * There is no `retry` plan. The rung enum carries `retry` for the transient
 * pre-retry series, and that series arms straight into `retrying` with no
 * grace window - a `hold` never plans one, so a countdown never offers
 * "Retry now".
 */
export type RoutingCountdownPlan =
  | { readonly kind: "switch"; readonly destination: ChatRunSettings }
  | { readonly kind: "resume" }
  | { readonly kind: "wait"; readonly resumesAt: number | null }
  | { readonly kind: "deciding" }
  | { readonly kind: "nothing" };

/**
 * The countdown's plan, read off one frame. The committed target first and the
 * host's prediction second - the order `fallback-identity.ts` fixes for every
 * surface that names a destination.
 */
export function routingCountdownPlan(
  pending: PendingFallback,
): RoutingCountdownPlan {
  const impending = pending.impendingAction;
  const destination = pending.targetTuple ?? impending?.target ?? null;
  if (destination !== null && pendingFallbackResumesFailedTuple(pending)) {
    return { kind: "resume" };
  }
  if (impending === null) {
    return destination === null
      ? { kind: "nothing" }
      : { kind: "switch", destination };
  }
  if (impending.pending !== null) return { kind: "deciding" };
  switch (impending.rung) {
    case "wait":
      return { kind: "wait", resumesAt: impending.resumesAt };
    // Not a plan a countdown carries (see the type): the neutral arm, so a
    // frame that ever did carry one names nothing it cannot back.
    case "retry":
      return { kind: "deciding" };
    case "notify":
      return { kind: "nothing" };
    case "profile":
    case "tier":
      return destination === null
        ? { kind: "deciding" }
        : { kind: "switch", destination };
  }
}

/**
 * Whether the countdown card renders for this frame.
 *
 * Not for a countdown with NOTHING to try (spec Flow 1: "no countdown card;
 * the failed-turn card shows instead"). The host does not arm such a hold -
 * a walk that comes up empty refuses to arm - and ends a window early when a
 * probe's answer leaves nothing to take, so this is the moment between that
 * answer and the settle. A card whose only true headline is "nothing else to
 * try" over a refusal that refuses nothing is the dead end the spec removed.
 * `switching` still renders whatever the plan: it has committed, and its
 * "Switching…" is the one frame the user sees before the result.
 */
export function fallbackGraceCardVisible(
  pending: PendingFallback | undefined,
): boolean {
  if (pending === undefined || !GRACE_CARD_STATES.has(pending.state)) {
    return false;
  }
  return (
    pending.state === "switching" ||
    routingCountdownPlan(pending).kind !== "nothing"
  );
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
