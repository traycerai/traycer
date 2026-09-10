// The ACK reason vocabulary, and the one construction that decorates it.
//
// ## Why this is a LEAF of its own
//
// Browser-safety in `protocol/config` is a per-FILE property: there is no
// barrel, the renderer imports individual modules, and a module that reaches
// for `node:` anything is unusable from one. `host-update-ack.ts` imports
// `node:path`, so the reason vocabulary could not live there and be readable
// by the GUI - which is the consumer that needs it most. Same split, and the
// same reason, as `installation-records.ts` beside `installation.ts`.
//
// `host-update-ack.ts` re-exports everything below, so no existing importer
// moves. NOTHING HERE MAY IMPORT `node:` - a pin below reads this file's own
// source and enforces it, because the failure it prevents is invisible to
// both `tsgo` and a vitest run under node: the renderer type-checks, the unit
// suite passes, and the production bundle is what breaks.

/**
 * Reasons a `no-attempt` result may carry.
 *
 * A closed grammar rather than free text, and — unlike the nonce pattern above
 * — an EXPORTED one. The reason crosses a repository boundary: the CLI writes
 * it and the host re-checks it before it reaches a log line or an RPC
 * response, and that re-check has to be against this exact grammar rather than
 * some wider "safe characters" predicate on the host's side. A superset would
 * accept values this contract can never produce, which makes it a check that
 * can never refuse anything — and the one thing worth refusing here is a
 * reason no producer in this contract could have written.
 *
 * Lowercase kebab, 1–64 characters. Long enough for `refused-e-host-not-installed`,
 * closed enough that a reason can be pasted into a log, a URL or a JSX label
 * without escaping.
 */
export const UPDATE_DISPATCH_ACK_REASON_PATTERN = /^[a-z0-9-]{1,64}$/;

export function isValidUpdateDispatchAckReason(value: string): boolean {
  return UPDATE_DISPATCH_ACK_REASON_PATTERN.test(value);
}

// ---- Q26: the closure suffix, and reading a reason through it --------------
//
// This lives HERE, beside the pattern that validates a reason, because this
// file IS the ACK reason vocabulary: the CLI mints these values, the
// dispatching host forwards them, and the GUI renders a sentence from each one
// (`update-executor.ts`: "the ACK reason is what the GUI renders"). It is also
// the only home every consumer can reach - `clients/shared/host-update`'s
// barrel pulls in `node:fs`/`node:crypto`, so a renderer importing from there
// type-checks and passes vitest under node while the production build fails
// (26f0b9d7). Protocol config is renderer-safe by construction.
//
// ## The defect this exists to prevent, which has now happened twice
//
// `staleAttemptClosedReason` GENERATES reasons by concatenation: any base
// reason that still fits the pattern above comes back with the suffix
// appended. The vocabulary is therefore not a list someone wrote down, it is
// ~2N values produced by a rule, and every base reason in play today fits the
// budget. A consumer comparing a reason with `===` against a literal silently
// stops matching the moment a run also closes a stranded attempt - no error,
// no visible fallthrough, just an arm that quietly stops running.
//
// That bit `update-run.ts`'s marker-aftercare guard (Q26), and the same shape
// is live in the GUI at `host-overview-updates-state.ts`'s
// `describeIndeterminateDispatch`, which compares SIX reasons with `===` and
// drops a suffixed decline into its generic sentence. THAT CONSUMER IS WHY
// THIS IS EXPORTED: if it looks unused from here, it is not.

/**
 * The suffix `staleAttemptClosedReason` appends when a decline ALSO closed an
 * interrupted attempt it would otherwise have stranded.
 *
 * Defined here and imported by the generator, so there is one spelling of it
 * in the repository. A second copy is how a strip and a build drift apart.
 */
export const STALE_ATTEMPT_CLOSED_SUFFIX = "-stale-attempt-closed";

/**
 * The reason with the closure decoration removed; anything else unchanged.
 *
 * Consumers that ask "what happened" want the BASE reason: the suffix answers
 * a different question (was an unrelated stranded record cleaned up on the way
 * out) and is additive by design, so a branch keyed on the base keeps working
 * when a run happens to do both.
 *
 * `endsWith` is unambiguous against the reason grammar. The pattern is
 * `^[a-z0-9-]{1,64}$`, the suffix begins with the only separator that grammar
 * has, and no base reason minted anywhere in this repository ends with it —
 * `nothing-to-do`, `record-fail-closed`, `refused-attempt-gone`,
 * `refused-unverifiable`, `recovered-complete`, `recovered-failed`,
 * `intent-not-legal`, `cohort-disabled`. A base reason that one day DID end
 * this way would still strip to something no consumer branches on, so the
 * failure mode is a missed arm rather than a wrong one.
 *
 * Not idempotent by intent: the generator never double-suffixes, because it
 * appends once to a selector's reason.
 */
export function baseDispatchAckReason(reason: string): string {
  return reason.endsWith(STALE_ATTEMPT_CLOSED_SUFFIX)
    ? reason.slice(0, -STALE_ATTEMPT_CLOSED_SUFFIX.length)
    : reason;
}

/**
 * Whether the reason says a stranded attempt was CLOSED by this run.
 *
 * The half of the reason that `baseDispatchAckReason` discards, kept as its
 * own question so a consumer can ask either one without re-deriving the
 * suffix rule.
 */
export function dispatchAckReasonClosedStaleAttempt(reason: string): boolean {
  return reason.endsWith(STALE_ATTEMPT_CLOSED_SUFFIX);
}

/**
 * ## Deliberately NOT here: "did this release conclude a record as DONE"
 *
 * A `dispatchAckReasonConcludesRecord` predicate was drafted here and RULED
 * OUT (cold review C), because it cannot be answered from a reason string.
 * The suffix records THAT a stranded attempt was closed and never HOW it
 * settled — `staleAttemptClosedReason` appends the same 21 characters over a
 * record that ended `complete` and one that ended `failed`, both of which
 * `recoverInterruptedAttempt` can produce. A consumer asking the done-ness
 * question must read the record: `ExecutorClaimOutcome`'s `released` variant
 * carries the terminal record the recovery wrote (`outcome`), and its
 * `terminalized` variant carries `"complete" | "failed"` directly.
 *
 * The CLI's marker aftercare does exactly that (`update-run.ts`, Q16 arm).
 * This note stays so the predicate is not re-added by someone who sees the
 * suffix and assumes it means success.
 */
