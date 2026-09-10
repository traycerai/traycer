export type ComposerTopBannerKind =
  | "fallback"
  | "reauth"
  | "fallback-return"
  | "ambient-drift"
  | "rate-limit"
  | "none";

/**
 * Which single banner the composer shows above itself.
 *
 * Strictly one at a time, and the ORDER is the contract - this is an
 * early-return chain, not a slot registry, so a branch's position is the whole
 * of its priority.
 *
 * Two things about the fallback entries are deliberate and easy to undo by
 * accident:
 *
 * **`fallbackVisible` is checked FIRST, above the `profileDisabled`
 * short-circuit.** A profile disabled mid-hold is a plausible sequel to a
 * billing failure, and under the old ordering that would return `"none"` and
 * make a counting-down card vanish while the host was still counting - leaving
 * the user with no way to reach "Don't switch" before the switch fired. A
 * branch added anywhere below that short-circuit can never fire for this case.
 * `ProfileDisabledRecovery` and the send gating are independent of this chain
 * and still render, so nothing about the disabled profile is hidden.
 *
 * **The return banner sits between `reauth` and `ambient-drift`,** and absorbs
 * the rate-limit advisory case: when the preferred profile has reset and the
 * current one is also running low, that is one situation and gets one banner,
 * not a collision between two.
 *
 * "Absorbs" is a claim about the SENTENCE, not just the slot, and this chain
 * cannot keep it - winning here only silences the advisory. The other half is
 * `chat/fallback/fallback-return-low-usage.ts`, which carries the advisory's
 * own words into the offer. Reorder this chain without moving that and the
 * paragraph above becomes false again (MF09).
 */
export function resolveComposerTopBannerKind({
  fallbackVisible,
  profileDisabled,
  reauthVisible,
  fallbackReturnVisible,
  ambientDriftVisible,
  rateLimitVisible,
}: {
  /** A live traversal in `hold` / `choosing` / `switching` - the grace card. */
  readonly fallbackVisible: boolean;
  readonly profileDisabled: boolean;
  readonly reauthVisible: boolean;
  /** A surfaced switch-back offer - `pendingReturn` present BY VALUE. */
  readonly fallbackReturnVisible: boolean;
  readonly ambientDriftVisible: boolean;
  readonly rateLimitVisible: boolean;
}): ComposerTopBannerKind {
  if (fallbackVisible) return "fallback";
  if (profileDisabled) return "none";
  if (reauthVisible) return "reauth";
  if (fallbackReturnVisible) return "fallback-return";
  if (ambientDriftVisible) return "ambient-drift";
  if (rateLimitVisible) return "rate-limit";
  return "none";
}
