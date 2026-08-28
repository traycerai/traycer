import {
  compareProcessStartIdentity,
  isProcessStartIdentity,
} from "@traycer/protocol/host/lifecycle/process-start-identity";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle/process-start-identity";
import type {
  HostUpdateAttemptRead,
  HostUpdateAttemptRecord,
} from "@traycer/protocol/config/host-update-attempt";

// Read-side interruption derivation (§1.5), plus the pure half of the
// attempt-lock holder probe.
//
// "Interruption is a read-side conclusion only for a stale, non-terminal,
// non-parked record with positive proof that no holder exists." Every clause
// of that sentence is a guard below, and the whole function is pure so each
// one can be exercised on its own.
//
// The failure this exists to prevent is a projection that turns absence of
// information into a verdict: a poll that did not happen, a liveness probe
// that could not run, or a parked attempt doing exactly what it is supposed
// to do must all read as "we do not know" or "parked", never "interrupted".
//
// ### Why the holder probe is split down the middle
//
// `@traycer-clients/shared/host-update/lock.ts` owns the probe for the CLI
// and the desktop; it sits on `host-lock/cross-process-lock` +
// `host-lock/process-identity`, which `traycer-host` cannot import. Moving
// those two modules was considered and rejected: they are the acquisition
// protocol, and a status projection has no business owning them.
//
// So the split is PURE-vs-PROBE, not client-vs-host. Everything in this file
// is a decision; nothing in it queries the OS. Each side supplies its own
// bytes and its own liveness probe and routes them through these same
// functions, so the two readers can disagree about what they OBSERVED but
// never about what an observation MEANS. A writer-driven conformance test in
// the shared suite feeds bytes from the real lock writer through
// `parseAttemptLockHolder` and asserts field-for-field agreement with
// `LockMetadata`, so a rename in the lock format fails a test instead of
// silently degrading a reader to permanent `indeterminate`.

/**
 * How long an ACTIVE record may go without a write before a missing holder
 * is allowed to mean interruption.
 *
 * Recommended, not enforced - callers pass the value they want, because a
 * fleet poller and an on-host reconciler are asking on different cadences.
 * It only ever gates the interrupted verdict; nothing terminalizes on it.
 */
export const RECOMMENDED_ATTEMPT_STALENESS_MS = 120_000;

export type AttemptLiveness =
  /** No attempt on disk. */
  | { readonly kind: "none" }
  /** A segment is running, or recently was and may still be. */
  | { readonly kind: "active"; readonly record: HostUpdateAttemptRecord }
  /** Holder absence is intentional. Never interrupted, at any age. */
  | { readonly kind: "parked"; readonly record: HostUpdateAttemptRecord }
  | { readonly kind: "terminal"; readonly record: HostUpdateAttemptRecord }
  /** Stale, active, and positively unheld. */
  | { readonly kind: "interrupted"; readonly record: HostUpdateAttemptRecord }
  /**
   * Nothing could be established. Covers a fail-closed record (corrupt,
   * unreadable, unsupported version) and an active record whose holder
   * could not be judged either way.
   */
  | {
      readonly kind: "indeterminate";
      readonly cause: string;
      readonly record: HostUpdateAttemptRecord | null;
    };

/**
 * The minimum `deriveAttemptLiveness` reads of a holder observation.
 *
 * Deliberately narrower than either side's own evidence type: the shared
 * client attaches the full `LockMetadata` to its `holder-live` arm and the
 * host attaches its own projection, and neither payload changes what the
 * derivation concludes. Keeping the parameter structural means both richer
 * types are assignable with no adapter and no shared public type has to
 * change to route through this module.
 */
export type AttemptHolderObservation =
  | { readonly kind: "no-holder" }
  | { readonly kind: "holder-live" }
  | { readonly kind: "indeterminate"; readonly cause: string };

export interface AttemptLivenessInput {
  readonly current: HostUpdateAttemptRead;
  readonly holder: AttemptHolderObservation;
  readonly nowMs: number;
  readonly stalenessMs: number;
}

export function deriveAttemptLiveness(
  input: AttemptLivenessInput,
): AttemptLiveness {
  const { current, holder, nowMs, stalenessMs } = input;

  if (current.kind === "absent") return { kind: "none" };
  if (current.kind === "corrupt") {
    return { kind: "indeterminate", cause: "record-corrupt", record: null };
  }
  if (current.kind === "unreadable") {
    return { kind: "indeterminate", cause: current.cause, record: null };
  }
  if (current.kind === "unsupported-version") {
    return {
      kind: "indeterminate",
      cause: `record-unsupported-version-${current.version}`,
      record: null,
    };
  }

  const record = current.value;
  if (record.execution === "terminal") return { kind: "terminal", record };
  // Checked BEFORE staleness and before the holder is consulted, because a
  // park is defined by the absence of a holder. A `waiting-to-activate`
  // attempt that survives a reboot and sits for a week is still parked, and
  // the whole point of §1.5 is that nothing about its age changes that.
  if (record.execution === "parked") return { kind: "parked", record };

  if (holder.kind === "holder-live") return { kind: "active", record };
  if (holder.kind === "indeterminate") {
    return { kind: "indeterminate", cause: holder.cause, record };
  }

  // `no-holder`: positive proof. Staleness is the second, independent clause
  // - a record written moments ago has simply not had time to look wrong,
  // and the window between an executor's record write and its next one is
  // legitimately holder-free on no path but a crash.
  const updatedAtMs = Date.parse(record.updatedAt);
  if (Number.isNaN(updatedAtMs)) {
    return {
      kind: "indeterminate",
      cause: "record-updated-at-unparseable",
      record,
    };
  }
  // A future-dated stamp (clock step, skewed writer) is not stale. Failing
  // toward `active` keeps a live attempt visible; the alternative declares a
  // running update interrupted because a clock moved.
  if (nowMs - updatedAtMs < stalenessMs) return { kind: "active", record };

  return { kind: "interrupted", record };
}

/**
 * Whether the holder probe may be skipped entirely for this read.
 *
 * `deriveAttemptLiveness` resolves `absent`, `corrupt`, `unreadable`,
 * `unsupported-version`, `terminal`, and `parked` WITHOUT looking at the
 * holder at all, so for those a probe cannot change the answer. On a healthy
 * host the record is absent or terminal, which is why fleet polling costs
 * zero liveness probes in the steady state - the expense exists only while an
 * update is genuinely in flight.
 *
 * Callers must treat a `false` here as "probe now", never as "assume live":
 * the whole point is that the skip is provably answer-preserving, and the
 * moment it stops being provable the probe has to run.
 */
export function attemptHolderProbeRequired(
  current: HostUpdateAttemptRead,
): boolean {
  return current.kind === "valid" && current.value.execution === "active";
}

// ---- Holder projection ------------------------------------------------------

/**
 * The identity-only projection of an `update-attempt.lock` file - what a
 * READER needs to judge whether the holder is still alive, and deliberately
 * nothing more.
 *
 * `reason`, `startedAt`, and `hostname` are omitted: they are acquisition
 * observability, and a projection that could reconstruct the writer's whole
 * record is one refactor away from someone writing one.
 */
export type AttemptLockHolder = {
  readonly pid: number;
  readonly token: string | null;
  readonly processStartIdentity: ProcessStartIdentity | null;
  readonly processStartedAtMs: number | null;
  /** `null`, not `undefined` - absence is a fact this reader states. */
  readonly supervisedProcessGroupId: number | null;
  readonly retainOnPublisherDeath: boolean;
};

/**
 * Parse the lock file's bytes, or `null` when they are not a well-formed
 * holder record.
 *
 * The REQUIRED set (`pid`, `reason`, `startedAt`) matches
 * `cross-process-lock`'s own parser exactly, even though this projection
 * discards two of the three. That is the point: "unparseable" has to mean the
 * same thing to both readers, or the host would treat a file the acquisition
 * side rejects as a live holder. The tolerances match for the same reason - a
 * lock written by a pre-token or pre-identity version still parses as a
 * live-checkable holder with an unverifiable identity, rather than being
 * mistaken for corruption.
 *
 * Returning `null` is NOT evidence that no holder exists: a writer still
 * inside `open()` -> `writeFile()` produces exactly these bytes, which is why
 * every caller routes it to `indeterminate`.
 */
export function parseAttemptLockHolder(text: string): AttemptLockHolder | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.pid !== "number" ||
    typeof obj.reason !== "string" ||
    typeof obj.startedAt !== "string"
  ) {
    return null;
  }
  return {
    pid: obj.pid,
    token: typeof obj.token === "string" ? obj.token : null,
    processStartIdentity: isProcessStartIdentity(obj.processStartIdentity)
      ? obj.processStartIdentity
      : null,
    processStartedAtMs:
      typeof obj.processStartedAtMs === "number"
        ? obj.processStartedAtMs
        : null,
    supervisedProcessGroupId:
      // `> 1`, matching the canonical parser in
      // clients/shared/host-lock/cross-process-lock.ts: probing group 1 asks
      // `kill(-1, 0)` — "is there ANY signalable process" — so a record
      // carrying 1 must read as carrying no group at all, or this reader and
      // the contenders' reader disagree about the same lock's liveness.
      typeof obj.supervisedProcessGroupId === "number" &&
      Number.isSafeInteger(obj.supervisedProcessGroupId) &&
      obj.supervisedProcessGroupId > 1
        ? obj.supervisedProcessGroupId
        : null,
    retainOnPublisherDeath: obj.retainOnPublisherDeath === true,
  };
}

/**
 * Cache key for one holder observation.
 *
 * Fingerprinted on the holder's OWN identity, not merely on elapsed time, so
 * a verdict expires on content change as well: a lock released and re-taken
 * by a different process is never served from a stale entry however short the
 * interval. A TTL alone would let a dead holder read as live across a
 * re-acquisition.
 */
export function attemptHolderFingerprint(
  // Only the identity fields, so the clients' richer `LockMetadata` is
  // accepted here directly. Widening this to the whole `AttemptLockHolder`
  // would force the shared lock module to project before it can fingerprint,
  // which is work with no purpose: the supervised-group and retain flags say
  // nothing about WHICH process holds the lock, and folding them in would
  // expire a perfectly good cached verdict every time a supervisor published
  // supplemental liveness for the same holder.
  holder: Pick<AttemptLockHolder, "pid" | "token" | "processStartIdentity">,
): string {
  const identity =
    holder.processStartIdentity === null
      ? "none"
      : JSON.stringify(holder.processStartIdentity);
  return `${String(holder.pid)}|${holder.token ?? "none"}|${identity}`;
}

/**
 * Whether this holder can be judged by the plain publisher-identity probe.
 *
 * `false` means the holder published supplemental liveness - a supervised
 * detached process group, or a Windows tree whose membership Node cannot
 * enumerate - and judging it requires the group probe that
 * `cross-process-lock.verifyLockHolderLiveness` performs. A reader that
 * cannot perform it must answer `indeterminate`; it must never fall back to
 * the publisher verdict alone, because a dead supervisor is NOT stale while
 * its actuator group survives, and treating it as unheld is how a projection
 * declares an irreversible operation abandoned while it is still running.
 */
export function attemptHolderUsesPlainIdentityProbe(
  holder: AttemptLockHolder,
): boolean {
  return (
    holder.supervisedProcessGroupId === null && !holder.retainOnPublisherDeath
  );
}

/**
 * The liveness verdict vocabulary, structurally identical to
 * `@traycer-clients/shared/host-lock/process-identity`'s
 * `ProcessIdentityVerdict`.
 *
 * Declared rather than imported because that module is not reachable from
 * `traycer-host`. A bidirectional type-equality assertion in the shared
 * `lock.ts` delegation fails compilation if either union grows an arm the
 * other lacks, so the duplication cannot drift silently.
 */
export type AttemptHolderLivenessVerdict =
  | "dead"
  | "alive-same"
  | "alive-different"
  | "indeterminate";

/**
 * Tri-state OS liveness for a pid. NOT a boolean, and that is the entire
 * point.
 *
 * `dead` is reserved for POSITIVE proof the pid is gone - on POSIX, `ESRCH`
 * and nothing else. Every other failure to answer (`EIO`, an unexpected
 * errno, a probe that could not run) is `indeterminate`, because "I could not
 * ask" is not "it is not there". Collapsing this to a boolean is how a
 * transient probe error becomes death evidence, and death evidence is what
 * `deriveAttemptLiveness` turns into `interrupted`.
 *
 * `EPERM` is `alive`: the signal was refused by permissions, which only a
 * process that exists can do.
 */
export type AttemptHolderProcessLiveness = "alive" | "dead" | "indeterminate";

/**
 * Combine a tri-state liveness result with an INDEPENDENT identity read.
 *
 * Mirrors `@traycer-clients/shared/host-lock/process-identity`'s
 * `computeProcessIdentityVerdict`, which is the approved contract; it lives
 * here too because `traycer-host` cannot import that package and this is a
 * decision, not a probe.
 *
 * Two properties are load-bearing:
 *
 * - Only `dead` short-circuits. An `indeterminate` liveness still consults
 *   the identity read, because the two are separate OS queries and one can
 *   fail while the other succeeds - a matching creation stamp is positive
 *   evidence the holder is alive even when the liveness probe could not
 *   answer. That is the epic's "indeterminate counts as alive" invariant.
 * - An unknown identity comparison yields `indeterminate`, never
 *   `alive-different`. Treating "cannot compare" as "recycled pid" is what
 *   would let a reader declare a live holder an impostor.
 */
export function composeAttemptHolderVerdict(
  liveness: AttemptHolderProcessLiveness,
  recordedIdentity: ProcessStartIdentity | null,
  observedIdentity: ProcessStartIdentity | null,
): AttemptHolderLivenessVerdict {
  if (liveness === "dead") return "dead";
  switch (compareProcessStartIdentity(recordedIdentity, observedIdentity)) {
    case "same":
      return "alive-same";
    case "different":
      return "alive-different";
    case "unknown":
      return "indeterminate";
  }
}

/**
 * The one mapping from a liveness verdict to holder evidence, shared by every
 * reader.
 *
 * `dead` and `alive-different` are BOTH positive proof the process that wrote
 * this lock is gone - the second because the pid was recycled onto an
 * unrelated process - so both are `no-holder`. `indeterminate` stays
 * `indeterminate`: it is the arm that keeps a failed probe from becoming an
 * `interrupted` verdict, and collapsing it into `no-holder` is precisely the
 * bug this whole layer is built to refuse.
 */
export function classifyAttemptHolderVerdict(
  verdict: AttemptHolderLivenessVerdict,
): AttemptHolderObservation["kind"] {
  switch (verdict) {
    case "alive-same":
      return "holder-live";
    case "dead":
    case "alive-different":
      return "no-holder";
    case "indeterminate":
      return "indeterminate";
  }
}
