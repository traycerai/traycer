import { baseDispatchAckReason } from "./host-update-ack-reason";

/**
 * The reason vocabularies of the two BOUND update dispatches,
 * `host.update.activate` and `host.update.continue` — **one tuple per wire
 * field**, because a single list keyed by "who minted it" cannot be
 * partitioned by any consumer's arm.
 *
 * The bound response has two arms that carry a `reason`, and their domains are
 * not the same set and not even the same KIND of set: `cli-failed.reason` is
 * closed and host-minted, while `dispatch-indeterminate.reason` is open,
 * because one of its producers GENERATES values. A consumer must know which
 * field it is reading before it can know whether an exhaustive branch over the
 * values is honest.
 *
 * Nothing here validates a wire value. Both `reason` fields are
 * `z.string().min(1)` (`../host/maintenance/schemas.ts`) and the ACK's is a
 * kebab PATTERN, not an enum (`./host-update-ack.ts`) — all deliberately open,
 * so a host can always report a reason a client predates. These tuples exist so
 * the host, the CLI and the renderer name the same values, so a consumer that
 * CAN close a branch does, and so one that cannot is told here rather than
 * discovering it in production.
 *
 * Dependency-free apart from the sibling ACK-grammar leaf: no zod, no `node:*`.
 * The renderer imports this module directly, the same way it imports
 * `./log-level`.
 */

/**
 * Every literal a producer puts on `dispatch-indeterminate.reason` **by name**.
 *
 * # THIS FIELD IS OPEN. A `default`-less switch over this tuple is a lie.
 *
 * `refusedAckReason` (`clients/traycer-cli/src/host/update-run.ts:617-621`)
 * BUILDS a reason rather than choosing one:
 *
 * ```ts
 * `refused-${err.code.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`
 * ```
 *
 * Its image is `refused-<lowercased CLI error code>` over every member of
 * `CLI_ERROR_CODES` (`clients/traycer-cli/src/runner/errors.ts`), plus
 * `refused-unexpected` for a non-`CliError` and for anything past 64
 * characters. It is called at `update-run.ts:454`, one of only two
 * `settlement.refused(...)` sites, and the host echoes an ACK's `no-attempt`
 * reason verbatim into this field (`update-dispatch-ack.ts`,
 * `projectDispatchDecisionForPeer`). Every value below and every generated one
 * may additionally arrive suffixed — see
 * {@link narrowKnownIndeterminateDispatchReason}.
 *
 * So a consumer needs THREE branches, not two: a known reason, the recognised
 * generated family ({@link isGeneratedCliErrorRefusal}), and a genuine
 * fallback that renders the raw string. `refused-install-changed` is an
 * instance of the second and is deliberately absent below — no producer mints
 * that literal, and listing it would misrepresent a generated value as an
 * enumerated one.
 *
 * # Two facts a reader will otherwise "fix"
 *
 * `refused-unverifiable` is ONE STRING WITH TWO MEANINGS. The host mints it
 * when the record cannot be decoded at all; the CLI mints it at three CONSENT
 * failures (`update-run.ts:1282`, a claim-less activation park; `:1298`, a
 * claim-less park that is not an upgrade over the live install; `:1316`, a park
 * whose baseline shows neither `allowDowngrade` nor a strict upgrade). The
 * CLI's undecodable case is `record-fail-closed` (`:931`), not this one.
 *
 * `nothing-to-do` is ABSENT ON PURPOSE. Its three sites (`update-run.ts:958`,
 * `:991`, `:1044`) all sit below the `install` marker at `:945`, which a bound
 * intent never reaches — `selectClaim:940-943` routes every bound intent to
 * `selectBoundResume` first — and all three carry `boundAttemptId: null`. It
 * reaches a renderer from the INSTALL path, so a surface serving both paths
 * needs it and this tuple must not have it.
 */
export const HOST_UPDATE_KNOWN_INDETERMINATE_DISPATCH_REASONS = [
  /** Updates are supervised outside the CLI's canonical service label. Host. */
  "externally-managed",
  /** The record is absent, terminal, or a DIFFERENT attempt. Host and CLI. */
  "refused-attempt-gone",
  /**
   * The record IS that attempt, at a position the caller did not authorize: it
   * advanced and parked again between the observation the user confirmed and
   * this dispatch (P1 window A).
   *
   * Deliberately not folded into `refused-attempt-gone`. That one says "there
   * is nothing here to act on"; this one says "what is here is not what you
   * were shown", and only the second has a correct next action.
   */
  "refused-attempt-moved",
  /** Undecodable (host) or a consent failure (CLI) — see the note above. */
  "refused-unverifiable",
  /** The CLI could not decode the record at all. `update-run.ts:931`. */
  "record-fail-closed",
  /**
   * A recovery terminalized the attempt and the reselect declined. Reachable
   * from a bound verb: `selectBoundResume`'s non-parked arm claims through
   * `interruptedResume`, and under the run's `afterRecovery: "reselect"`
   * (`update-run.ts:431`) `afterTerminalizingRecovery` overrides the
   * selector's own reason with these (`update-executor.ts:1046-1050`).
   */
  "recovered-complete",
  "recovered-failed",
  // The host's own wait and projection outcomes
  // (`DISPATCH_INDETERMINATE_REASONS`, `update-dispatch-ack.ts`). They are the
  // dispatcher's answers rather than any child's, which is why they appear in
  // no CLI or host refusal constant and were missed by a census keyed on those.
  /** The bounded wait elapsed with no ACK naming this dispatch. */
  "ack-timeout",
  /** The child ended before its claim was durable. */
  "child-exited-before-ack",
  /** An ACK was present and could not be read. */
  "attempt-record-invalid",
  /** An ACK named a reason outside the grammar, so the host will not repeat it. */
  "refused-unprintable",
  /** A projection said `accepted` for a bound method without an attempt id. */
  "unnamed-attempt",
] as const;

export type HostUpdateKnownIndeterminateDispatchReason =
  (typeof HOST_UPDATE_KNOWN_INDETERMINATE_DISPATCH_REASONS)[number];

/**
 * Every literal a producer puts on `cli-failed.reason`. **Closed**: all three
 * are host-minted, none is generated, and no ACK reason reaches this arm — so
 * an exhaustive switch over this one IS honest, and no suffix strip applies.
 *
 * All three sites are in the host's bound dispatch resolver: `cli-unavailable`
 * when no CLI invocation resolves and when the spawn fails with a missing
 * executable, `cli-too-old` from both the preflight and the authoritative
 * parser-rejection check after the wait, `spawn-failed` for any other spawn
 * failure.
 */
export const HOST_UPDATE_CLI_FAILED_REASONS = [
  "cli-unavailable",
  "cli-too-old",
  "spawn-failed",
] as const;

export type HostUpdateCliFailedReason =
  (typeof HOST_UPDATE_CLI_FAILED_REASONS)[number];

/**
 * The prefix `refusedAckReason` builds its values with.
 *
 * Exported so a consumer can recognise the generated FAMILY without
 * enumerating it — which is impossible, because the family grows with
 * `CLI_ERROR_CODES` in another package and another repository's release
 * cadence.
 */
export const GENERATED_CLI_ERROR_REFUSAL_PREFIX = "refused-e-";

/**
 * Whether a reason is one the CLI generated from an error code.
 *
 * `refused-e-` because every `CLI_ERROR_CODES` value is `E_`-prefixed, so the
 * generator's image is `refused-e-…`. A caller can use this for a single "the
 * CLI refused with an error" branch instead of a fallback that says nothing —
 * but it is a FAMILY test, not a membership test, and the correct shape
 * downstream is still: known reason, then this family, then a genuine fallback
 * that renders the raw string.
 *
 * Pass a base reason: this does not strip, and a generated reason can carry
 * the closure suffix like any other.
 */
export function isGeneratedCliErrorRefusal(value: string): boolean {
  return value.startsWith(GENERATED_CLI_ERROR_REFUSAL_PREFIX);
}

/**
 * Narrows a `dispatch-indeterminate.reason` to the known vocabulary, stripping
 * the closure decoration first.
 *
 * The strip is not optional. `staleAttemptClosedReason` appends
 * `-stale-attempt-closed` when the same run also closed a stranded attempt, so
 * `refused-attempt-gone-stale-attempt-closed` is a legitimate value naming a
 * reason in the tuple; a consumer matching raw values with `===` or a `switch`
 * loses a live arm with no error and no visible fallthrough. That defect has
 * been found twice already. The rule has ONE spelling in this repository —
 * {@link baseDispatchAckReason} — and this function calls it rather than
 * carrying a second copy of the suffix.
 *
 * Returns the narrowed BASE reason, or `null` when it is not one this build
 * knows. `null` is not an error: it is the open field doing what it is for.
 * Ask {@link isGeneratedCliErrorRefusal} next, and render the raw string after
 * that — never drop it, because it is the only thing the host managed to say.
 */
export function narrowKnownIndeterminateDispatchReason(
  value: string,
): HostUpdateKnownIndeterminateDispatchReason | null {
  const base = baseDispatchAckReason(value);
  return (
    HOST_UPDATE_KNOWN_INDETERMINATE_DISPATCH_REASONS as readonly string[]
  ).includes(base)
    ? (base as HostUpdateKnownIndeterminateDispatchReason)
    : null;
}

/**
 * Narrows a `cli-failed.reason`. No strip: these three are minted by the host
 * as its own answer and are never echoed from an ACK, so the closure
 * decoration — an ACK-base phenomenon — cannot reach them.
 */
export function isHostUpdateCliFailedReason(
  value: string,
): value is HostUpdateCliFailedReason {
  return (HOST_UPDATE_CLI_FAILED_REASONS as readonly string[]).includes(value);
}
