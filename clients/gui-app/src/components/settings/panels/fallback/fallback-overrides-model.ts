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
 * `"off"` is a third thing, not an empty ladder - but NOT for the reason this
 * comment used to give. It claimed `"off"` armed nothing "while an empty ARRAY
 * still arms and exhausts", and the second half was never true: an empty array
 * hits the host's own `ladder.length === 0` refusal and arms nothing either.
 * The engine now reports the difference in its refusal reason and nowhere else
 * - `reason_override_off` for this value, `empty_ladder` for `[]`, and
 * `notify_only` for a non-transient failure left with `Notify` alone. Three
 * distinct diagnoses, one identical outcome.
 *
 * So the distinction this function keeps is about AUTHORSHIP, not behaviour:
 * `"off"` is a statement the user made about this failure, `[]` is a row that
 * happens to be empty, and rendering the first as "everything turned off" would
 * put words in their mouth. The panel never writes `"off"` (the matrix has no
 * control for it), but the wire allows it and a programmatic writer can produce
 * it, so this answers it distinctly.
 *
 * The one thing `Notify`'s presence still buys, and the only behavioural
 * difference left in this area: a TRANSIENT reason (`provider_unavailable`,
 * `provider_connection_failed`) with `["notify"]` does arm, for its short
 * same-tuple retry series, and settles at `notify` with no countdown. Empty it
 * and those retries are gone.
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
 *     from the chips on screen would silently drop it - and the cost of that is
 *     not what this note used to say. "Turn a failure that holds and notifies
 *     into one that just exhausts" described an engine that armed a hold for a
 *     notify-only plan; it no longer does. What dropping it actually costs is
 *     the two TRANSIENT failures (an outage, a connection failure): their row
 *     narrows to `notify` alone, so losing it takes the row to `[]` and their
 *     short same-tuple retry series stops arming at all. For every other
 *     failure the loss is invisible today - and that is the weaker reason to
 *     keep it, not a reason to stop. `FALLBACK_OVERRIDES_DISCLOSURE` promises
 *     the user in writing that "Notify stays last", and a promise on screen is
 *     its own requirement regardless of what the engine currently does with it.
 *     On BOTH entry paths: from a ladder it rides in on `current`, and from a
 *     stored `"off"` it is seeded from the base ladder below. The `"off"` path
 *     used to seed nothing at all, which reached the same loss in ONE click and
 *     left it there - see the note on `desired`.
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
  // `"off"` starts from nothing BUT THE TERMINAL STEP: the user is turning a
  // step back on for a failure that had been opted out entirely, and the honest
  // reading of that click is "run this one step", not "restore the whole
  // ladder".
  //
  // `notify` is the one exception, because it is the one rung with no chip
  // (`REASON_ELIGIBLE_RUNGS`' own doc: "notify never appears in a row"). Seeding
  // it out here dropped it permanently: nothing on this page writes `notify` or
  // `"off"` back, so a single click on a stored `"off"` row removed the terminal
  // step for good, with no control left to undo it. For the two transient
  // failures that is the loss of their same-tuple retry series (see claim 1);
  // for the rest it is invisible in today's engine and still breaks
  // `FALLBACK_OVERRIDES_DISCLOSURE`'s "Notify stays last" - a promise this
  // surface makes to the user in writing, and one that must hold whether or not
  // the engine currently acts on the step.
  //
  // Read off the BASE ladder rather than added unconditionally: the row is being
  // rebuilt out of the user's own step order, and a user who took the terminal
  // hold out of that order did not ask for it back here.
  const desired = new Set<FallbackRungKind>(
    current === "off"
      ? policy.ladder.filter((candidate) => candidate === "notify")
      : current,
  );
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
