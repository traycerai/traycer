import {
  REASON_ELIGIBLE_RUNGS,
  type FallbackPolicy,
  type FallbackRungKind,
} from "@traycer/protocol/host/fallback-policy";
import type { HostNotificationStoppedReason } from "@traycer/protocol/host/notifications/payloads";

/**
 * A chip's three states, and the distinction the whole matrix exists to make.
 *
 *  - `runs` - eligible for this failure and in the ladder this failure walks;
 *  - `off` - eligible, but the user has taken it out for this failure;
 *  - `impossible` - the step cannot change the outcome of this failure, whatever
 *    the user prefers. Not clickable: ineligibility is a fact about the failure,
 *    not a preference, and offering a switch for it would promise something the
 *    engine will never do.
 */
export type OverrideChipState = "runs" | "off" | "impossible";

/**
 * The ladder this failure actually walks, given the policy.
 *
 * `"off"` is a third thing, not an empty ladder: it means no traversal arms at
 * all - no cancel window, no notify hold - while an empty ARRAY still arms and
 * exhausts. The panel never writes `"off"` (the matrix has no control for it),
 * but the wire allows it and a programmatic writer can produce it, so this
 * answers it distinctly rather than rendering it as "everything turned off".
 */
export function effectiveLadderFor(
  policy: FallbackPolicy,
  reason: HostNotificationStoppedReason,
): readonly FallbackRungKind[] | "off" {
  return policy.reasonOverrides?.[reason] ?? policy.ladder;
}

export function overrideChipState(
  policy: FallbackPolicy,
  reason: HostNotificationStoppedReason,
  rung: FallbackRungKind,
): OverrideChipState {
  if (!REASON_ELIGIBLE_RUNGS[reason].includes(rung)) return "impossible";
  const ladder = effectiveLadderFor(policy, reason);
  if (ladder === "off") return "off";
  return ladder.includes(rung) ? "runs" : "off";
}

/**
 * The policy after toggling one chip.
 *
 * Three things this has to get right, each of which was a way to lose data:
 *
 *  1. **`notify` is carried through.** It has no column, so rebuilding the row
 *     from the chips on screen would silently drop it and turn a failure that
 *     holds and notifies into one that just exhausts.
 *  2. **Order comes from `rungOrder`, not from the row.** The user's step order
 *     is a preference they set once; a per-failure narrowing must not reorder
 *     it. `rungOrder` is the editor's four-row order, so a step the base ladder
 *     does not contain can still be placed correctly when it is turned ON here.
 *  3. **An override equal to the base ladder is REMOVED, not stored.** Storing
 *     it would freeze this failure at today's ladder, so a later change to the
 *     main order would silently stop applying to it - a divergence with no
 *     visible cause, since the row would look identical either way.
 */
export function togglePolicyOverrideRung(input: {
  readonly policy: FallbackPolicy;
  readonly reason: HostNotificationStoppedReason;
  readonly rung: FallbackRungKind;
  readonly rungOrder: readonly FallbackRungKind[];
}): FallbackPolicy {
  const { policy, reason, rung, rungOrder } = input;
  const current = effectiveLadderFor(policy, reason);
  // `"off"` starts from nothing: the user is turning a step back on for a
  // failure that had been opted out entirely, and the honest reading of that
  // click is "run this one step", not "restore the whole ladder".
  const desired = new Set<FallbackRungKind>(current === "off" ? [] : current);
  if (desired.has(rung)) {
    desired.delete(rung);
  } else {
    desired.add(rung);
  }
  const next = rungOrder.filter((candidate) => desired.has(candidate));
  const rest = withoutReason(policy.reasonOverrides, reason);
  if (rungListsEqual(next, policy.ladder)) {
    return withOverrides(policy, rest);
  }
  return withOverrides(policy, { ...rest, [reason]: next });
}

/** "Reset overrides only" - every row returns to following the main order. */
export function clearPolicyOverrides(policy: FallbackPolicy): FallbackPolicy {
  return withOverrides(policy, {});
}

export function policyHasOverrides(policy: FallbackPolicy): boolean {
  return Object.keys(policy.reasonOverrides ?? {}).length > 0;
}

type ReasonOverrides = NonNullable<FallbackPolicy["reasonOverrides"]>;

/**
 * An empty override map is written as ABSENT rather than as `{}`.
 *
 * The two are equivalent to the engine, but not to a reader: `reasonOverrides:
 * {}` in a stored policy looks like a user who configured something, and the
 * next person to debug a failure would go looking for what.
 */
function withOverrides(
  policy: FallbackPolicy,
  overrides: ReasonOverrides,
): FallbackPolicy {
  if (Object.keys(overrides).length === 0) {
    const { reasonOverrides: _dropped, ...rest } = policy;
    return rest;
  }
  return { ...policy, reasonOverrides: overrides };
}

function withoutReason(
  overrides: ReasonOverrides | undefined,
  reason: HostNotificationStoppedReason,
): ReasonOverrides {
  if (overrides === undefined) return {};
  const { [reason]: _dropped, ...rest } = overrides;
  return rest;
}

function rungListsEqual(
  left: readonly FallbackRungKind[],
  right: readonly FallbackRungKind[],
): boolean {
  return (
    left.length === right.length &&
    left.every((rung, index) => rung === right[index])
  );
}
