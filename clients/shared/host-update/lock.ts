import {
  acquireLock,
  readLockHolder,
  rewriteLockLivenessIfToken,
  verifyLockHolderLiveness,
  type AcquireLockOptions,
  type LockHandle,
  type LockMetadata,
} from "@traycer-clients/shared/host-lock/cross-process-lock";
import {
  verifyProcessIdentityAsync,
  type ProcessIdentityVerdict,
} from "@traycer-clients/shared/host-lock/process-identity";
import { resolve } from "node:path";
import {
  attemptHolderFingerprint,
  classifyAttemptHolderVerdict,
  type AttemptHolderLivenessVerdict,
} from "@traycer/protocol/config/host-update-attempt-liveness";
import {
  readProcessStartIdentity,
  readProcessStartTimeMs,
} from "@traycer-clients/shared/host-lock/process-identity";
import { updateAttemptLockPath, updateAttemptRecordPath } from "./paths";

// `update-attempt.lock` - the execution authority for a host update segment
// (§1.1). A thin wrapper over the hardened `cross-process-lock` protocol,
// the SAME module the CLI's `cli-lock` and the desktop's held sections wrap,
// so the two locks can never drift apart on what "held" means.
//
// ============================================================================
// LOCK ORDER: `update-attempt.lock` is ALWAYS OUTER TO `cli-lock`.
// ============================================================================
//
//     acquire update-attempt.lock          <- coarse, whole segment
//         acquire cli-lock                 <- short, install-tree mutation
//         release cli-lock
//     release update-attempt.lock
//
// No actor may acquire them in the opposite order. The two locks answer
// different questions and have deliberately different lifetimes:
//
//   - `update-attempt.lock` is per EXECUTION SEGMENT. It is held across
//     download, stage, apply, and restart decisions - potentially minutes -
//     and its holder is the only process permitted to advance the durable
//     record.
//   - `cli-lock` is per INSTALL-TREE MUTATION. It is short by design and is
//     also taken by actors that have nothing to do with updating (a plain
//     `traycer host install`, uninstall, a CLI self-upgrade).
//
// Because `cli-lock` has those other, non-update holders, a process that
// took `cli-lock` first and then reached for the attempt lock would be
// holding the short lock for the whole duration of the coarse one - and two
// such processes, each holding one lock and waiting on the other, deadlock
// until one of them hits its wait deadline. Ordering coarse-outside-short
// removes the cycle by construction.
//
// An ADOPTER reading install evidence follows the same order: attempt lock
// first, then the short `cli-lock` only for as long as it takes to re-read
// `install.json` and the filesystem generation (§1.4).
//
// This module cannot enforce the rule across processes - it is a property of
// the callers, and the enforcement boundary is the shared install-mutation /
// host-restart facades that ticket 02 introduces. What it CAN do, and does
// below, is refuse a re-entrant acquisition inside one process.

export type { LockMetadata };

/**
 * A segment's proof that it holds the attempt lock.
 *
 * Structurally identical to the underlying `LockHandle`, but it is NOT
 * interchangeable with one: every handle this module issues is recorded in a
 * module-private `WeakSet`, and the mutation API refuses any object that is
 * not in it. That makes the handle unforgeable by an object literal, so
 * "callers must hold the lock" stops being an honour-system comment and
 * becomes something the write path checks.
 *
 * Holding a handle is still not sufficient on its own - see
 * `verifyAttemptLockOwnership`, which re-reads the lock file, because a
 * handle can outlive the lock it names (a stale-break by another contender,
 * or the segment's own release on a path a late callback still closes over).
 */
export interface UpdateAttemptLockHandle {
  /** The one host home this capability is authorized to mutate. */
  readonly hostHomeDir: string;
  readonly path: string;
  readonly metadata: LockMetadata;
  release(): Promise<void>;
}

export interface AcquireUpdateAttemptLockOptions {
  /**
   * The host home that owns both canonical attempt resources. Callers never
   * supply a sibling lock path: that would turn one record's authority into
   * authority for every filename next to it.
   */
  readonly hostHomeDir: string;
  /** What this segment is doing - written into the lock file for diagnostics. */
  readonly reason: string;
  /**
   * How long to wait for the lock.
   *
   * A CONTENDER passes `0`: §1.1 requires a successful contender to acquire
   * with no wait, so that losing the race resolves to `busy` immediately and
   * the loser attaches or refuses rather than queueing behind a segment that
   * may run for minutes.
   */
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}

export type AcquireUpdateAttemptLockOutcome =
  | { readonly kind: "acquired"; readonly handle: UpdateAttemptLockHandle }
  | { readonly kind: "busy"; readonly holder: LockMetadata | null }
  // This process already holds the lock at that exact path. Distinct from
  // `busy` because the remedy is entirely different: `busy` means wait or
  // attach, while this means the caller has an ordering bug and would
  // otherwise wait on itself. A path-based O_CREAT|O_EXCL lock is not
  // reentrant, and Desktop genuinely runs several would-be contenders in one
  // process (activation, pending revision repair, prefetch), so this is a
  // reachable mistake rather than a theoretical one.
  | { readonly kind: "held-in-process"; readonly holder: LockMetadata };

// Lock paths currently held by THIS process, with the metadata of the
// holding section. Keyed by path because one process can legitimately hold
// the attempt locks of two different host homes (a dev slot and production).
const heldInProcess = new Map<string, LockMetadata>();

/** Whether this process currently holds this host home's canonical lock. */
export function isUpdateAttemptLockHeldInProcess(hostHomeDir: string): boolean {
  return heldInProcess.has(resourceForHostHome(hostHomeDir).lockPath);
}

export async function acquireUpdateAttemptLock(
  options: AcquireUpdateAttemptLockOptions,
): Promise<AcquireUpdateAttemptLockOutcome> {
  const resource = resourceForHostHome(options.hostHomeDir);
  const selfHeld = heldInProcess.get(resource.lockPath);
  if (selfHeld !== undefined) {
    return { kind: "held-in-process", holder: selfHeld };
  }
  const request: AcquireLockOptions = {
    lockPath: resource.lockPath,
    reason: options.reason,
    waitMs: options.waitMs,
    pollIntervalMs: options.pollIntervalMs,
  };
  const outcome = await acquireLock(request);
  if (outcome.kind === "busy") {
    return { kind: "busy", holder: outcome.holder };
  }
  heldInProcess.set(resource.lockPath, outcome.handle.metadata);
  return { kind: "acquired", handle: trackedHandle(outcome.handle, resource) };
}

// Handle state is private capability state, rather than mutable public fields.
// In addition to making object-literal handles unforgeable, it carries the
// per-handle mutation lease which prevents a release from racing an in-flight
// rename or unlink.
const issuedHandles = new WeakSet<UpdateAttemptLockHandle>();

type AttemptResource = {
  readonly hostHomeDir: string;
  readonly lockPath: string;
  readonly recordPath: string;
};

type HandleState = {
  readonly resource: AttemptResource;
  readonly underlying: LockHandle;
  released: boolean;
  releasing: boolean;
  activeMutations: number;
  releasePromise: Promise<void> | null;
  mutationWaiters: Array<() => void>;
};

const handleStates = new WeakMap<UpdateAttemptLockHandle, HandleState>();

function resourceForHostHome(hostHomeDir: string): AttemptResource {
  const canonicalHome = resolve(hostHomeDir);
  return {
    hostHomeDir: canonicalHome,
    lockPath: updateAttemptLockPath(canonicalHome),
    recordPath: updateAttemptRecordPath(canonicalHome),
  };
}

function trackedHandle(
  handle: LockHandle,
  resource: AttemptResource,
): UpdateAttemptLockHandle {
  const state: HandleState = {
    resource,
    underlying: handle,
    released: false,
    releasing: false,
    activeMutations: 0,
    releasePromise: null,
    mutationWaiters: [],
  };
  const tracked: UpdateAttemptLockHandle = {
    hostHomeDir: resource.hostHomeDir,
    path: handle.path,
    metadata: handle.metadata,
    release: () => {
      if (state.releasePromise !== null) return state.releasePromise;

      // This runs synchronously before the first await. Once release starts,
      // no new mutation lease can enter. Existing leases are allowed to reach
      // their terminal filesystem operation while the lock remains present.
      state.releasing = true;
      state.releasePromise = (async () => {
        await waitForMutations(state);
        state.released = true;
        try {
          await state.underlying.release();
        } finally {
          heldInProcess.delete(resource.lockPath);
        }
      })();
      return state.releasePromise;
    },
  };
  issuedHandles.add(tracked);
  handleStates.set(tracked, state);
  return tracked;
}

function waitForMutations(state: HandleState): Promise<void> {
  if (state.activeMutations === 0) return Promise.resolve();
  return new Promise((resolveWaiter) =>
    state.mutationWaiters.push(resolveWaiter),
  );
}

function finishMutation(state: HandleState): void {
  state.activeMutations -= 1;
  if (state.activeMutations !== 0) return;
  for (const waiter of state.mutationWaiters.splice(0)) waiter();
}

export interface AttemptMutationLease {
  readonly hostHomeDir: string;
  /** Derived from `hostHomeDir`, never supplied by the mutator caller. */
  readonly recordPath: string;
  release(): void;
}

export type AttemptMutationLeaseOutcome =
  | { readonly kind: "leased"; readonly lease: AttemptMutationLease }
  | { readonly kind: "not-issued" }
  | { readonly kind: "released" };

/**
 * Acquire a synchronous, per-handle mutation lease. `release()` marks the
 * handle as releasing before it awaits this lease, then leaves the on-disk
 * lock in place until the lease is returned. That is the boundary preventing
 * a new holder from overtaking an older commit/prune after its final check.
 */
export function acquireAttemptMutationLease(
  handle: UpdateAttemptLockHandle,
): AttemptMutationLeaseOutcome {
  if (!issuedHandles.has(handle)) return { kind: "not-issued" };
  const state = handleStates.get(handle);
  if (state === undefined || state.released || state.releasing) {
    return { kind: "released" };
  }

  state.activeMutations += 1;
  let finished = false;
  return {
    kind: "leased",
    lease: {
      hostHomeDir: state.resource.hostHomeDir,
      recordPath: state.resource.recordPath,
      release: () => {
        if (finished) return;
        finished = true;
        finishMutation(state);
      },
    },
  };
}

/**
 * Whether `handle` still owns the lock it names, RIGHT NOW.
 *
 * Three independent facts, because each fails on its own:
 *
 *  1. the handle was issued by this module (not forged);
 *  2. it has not been released - the late-callback case, where a segment's
 *     continuation runs after its `finally` already let go;
 *  3. the lock file still carries this handle's per-acquisition token. A
 *     handle can outlive its lock without anyone releasing it: another
 *     contender that positively proved this process dead (or recycled onto
 *     this pid) breaks the lock and takes it, and nothing notifies the
 *     original holder.
 *
 * Only `owned` permits a write. `indeterminate` deliberately does not - the
 * only-positive-evidence rule the lock protocol applies to breaking applies
 * to writing too.
 */
export type AttemptLockOwnership =
  | { readonly kind: "owned" }
  | { readonly kind: "not-issued" }
  | { readonly kind: "released" }
  | { readonly kind: "lost"; readonly observed: LockMetadata | null }
  | { readonly kind: "indeterminate"; readonly cause: string };

export async function verifyAttemptLockOwnership(
  handle: UpdateAttemptLockHandle,
): Promise<AttemptLockOwnership> {
  if (!issuedHandles.has(handle)) return { kind: "not-issued" };
  const state = handleStates.get(handle);
  if (state === undefined || state.released || state.releasing) {
    return { kind: "released" };
  }

  // Do not use public handle fields for authority. JavaScript callers can
  // mutate a `readonly` property at runtime; the issuer-owned state is the
  // canonical lock resource and token.
  const token = state.underlying.metadata.token;
  if (token === null) {
    // Never written by this code - every acquisition mints a `randomUUID()`.
    // With nothing to compare, ownership cannot be positively established.
    return { kind: "indeterminate", cause: "handle-has-no-token" };
  }

  const probe = await readLockHolder(state.resource.lockPath);
  if (probe.kind === "absent") return { kind: "lost", observed: null };
  if (probe.kind === "read-error") {
    return { kind: "indeterminate", cause: "lock-read-error" };
  }
  if (probe.kind === "unparseable") {
    // Empty/corrupt bytes. A fresh holder still inside the
    // `open()`->`writeFile()` gap produces exactly this, so it is not proof
    // the lock was lost - but it is certainly not proof we still own it.
    return { kind: "indeterminate", cause: "lock-unparseable" };
  }
  return probe.holder.token === token
    ? { kind: "owned" }
    : { kind: "lost", observed: probe.holder };
}

/**
 * Transfer only the *liveness publication* of an already-owned attempt lock
 * to a supervised child process. The token remains unchanged, so no new
 * process gains mutation authority; this only prevents a live root actuator
 * from becoming concurrently breakable if its CLI supervisor dies.
 *
 * Callers must restore the publisher before returning to ordinary work. A
 * failed rewrite is fatal to the caller's operation: an unproven lock holder
 * is safer than presenting stale liveness evidence.
 */
export async function rebindAttemptLockLiveness(
  handle: UpdateAttemptLockHandle,
  pid: number,
  options: AttemptLockLivenessPublication,
): Promise<void> {
  if (!issuedHandles.has(handle)) {
    throw new Error("attempt lock handle was not issued");
  }
  const state = handleStates.get(handle);
  if (state === undefined || state.released || state.releasing) {
    throw new Error("attempt lock handle was released");
  }
  const token = state.underlying.metadata.token;
  if (token === null || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("attempt lock liveness publisher was invalid");
  }
  const current = await readLockHolder(state.resource.lockPath);
  if (current.kind !== "held" || current.holder.token !== token) {
    throw new Error("attempt lock ownership was lost before liveness rebind");
  }
  const {
    supervisedProcessGroupId: _priorProcessGroupId,
    retainOnPublisherDeath: _priorRetainOnPublisherDeath,
    ...immutableMetadata
  } = current.holder;
  const rewritten = await rewriteLockLivenessIfToken(
    state.resource.lockPath,
    token,
    {
      ...immutableMetadata,
      pid,
      processStartedAtMs: readProcessStartTimeMs(pid),
      processStartIdentity: readProcessStartIdentity(pid),
      ...(options.supervisedProcessGroupId === undefined
        ? {}
        : { supervisedProcessGroupId: options.supervisedProcessGroupId }),
      ...(options.retainOnPublisherDeath === true
        ? { retainOnPublisherDeath: true }
        : {}),
    },
  );
  if (!rewritten) {
    throw new Error("attempt lock ownership changed during liveness rebind");
  }
}

/**
 * Supplemental liveness published for a supervised root actuator. It cannot
 * transfer mutation authority: the immutable acquisition token remains the
 * only ownership proof. The optional detached group is consulted only after
 * the publisher identity is positively gone.
 */
export interface AttemptLockLivenessPublication {
  readonly supervisedProcessGroupId?: number;
  readonly retainOnPublisherDeath?: boolean;
}

export type WithUpdateAttemptLockOutcome<T> =
  | { readonly kind: "acquired"; readonly result: T }
  | { readonly kind: "busy"; readonly holder: LockMetadata | null }
  | { readonly kind: "held-in-process"; readonly holder: LockMetadata };

/** Acquire, run `fn`, release in `finally`. Never swallows `fn`'s error. */
export async function withUpdateAttemptLock<T>(
  options: AcquireUpdateAttemptLockOptions,
  fn: (handle: UpdateAttemptLockHandle) => Promise<T>,
): Promise<WithUpdateAttemptLockOutcome<T>> {
  const outcome = await acquireUpdateAttemptLock(options);
  if (outcome.kind !== "acquired") return outcome;
  try {
    return { kind: "acquired", result: await fn(outcome.handle) };
  } finally {
    await outcome.handle.release();
  }
}

// ---- Read-side holder evidence ---------------------------------------------

/**
 * What a READER can establish about the attempt lock's holder, and the only
 * input to `deriveAttemptLiveness` that can ever justify "interrupted".
 *
 * `no-holder` is the sole positive proof of absence. `holder-live` means a
 * segment is genuinely running. Everything else is `indeterminate`, which
 * never becomes interruption - a probe failure, a lock file caught
 * mid-creation, and a Windows `tasklist` that could not run all establish
 * exactly nothing.
 */
export type AttemptHolderEvidence =
  | { readonly kind: "no-holder" }
  | { readonly kind: "holder-live"; readonly holder: LockMetadata }
  | { readonly kind: "indeterminate"; readonly cause: string };

export interface ProbeAttemptHolderOptions {
  /** The host home whose canonical attempt lock is being observed. */
  readonly hostHomeDir: string;
  readonly nowMs: number;
  /**
   * How long a verdict may be reused for an UNCHANGED lock file.
   *
   * §1.5 requires this: the liveness probe shells out to `tasklist` on
   * Windows, and fleet status polling reads many hosts on a cadence, so an
   * uncached probe turns a read-only projection into per-read process
   * spawning. Callers that want no caching pass `0`.
   */
  readonly cacheTtlMs: number;
}

type CachedVerdict = {
  readonly fingerprint: string;
  readonly evidence: AttemptHolderEvidence;
  readonly atMs: number;
};

const holderCache = new Map<string, CachedVerdict>();

/**
 * Read-only probe of the attempt lock. Never acquires, never breaks, never
 * writes - a status projection must not become a mutator.
 *
 * The cache is keyed by lock path AND fingerprinted on the holder's own
 * identity, so it expires on content change as well as on time: a lock
 * released and re-taken by a different process is never served from a stale
 * entry however short the elapsed interval.
 */
export async function probeAttemptHolder(
  options: ProbeAttemptHolderOptions,
): Promise<AttemptHolderEvidence> {
  const lockPath = resourceForHostHome(options.hostHomeDir).lockPath;
  const probe = await readLockHolder(lockPath);
  if (probe.kind === "absent") {
    holderCache.delete(lockPath);
    return { kind: "no-holder" };
  }
  if (probe.kind === "read-error") {
    return { kind: "indeterminate", cause: "lock-read-error" };
  }
  if (probe.kind === "unparseable") {
    // A holder still inside the `open()` -> `writeFile()` gap produces
    // exactly these bytes, so this is not evidence of an abandoned lock.
    // Breaking it is the acquisition path's job (under arbitration, after a
    // grace window); a reader only reports that it cannot tell.
    return { kind: "indeterminate", cause: "lock-unparseable" };
  }

  const fingerprint = holderFingerprint(probe.holder);
  const cached = holderCache.get(lockPath);
  // The elapsed time must be NONNEGATIVE before it can satisfy any TTL: a
  // backward wall-clock step makes it negative, and a negative age passes
  // the strict `<` against every TTL — including `cacheTtlMs: 0`, the
  // value `verifyAdoptedCapability` passes precisely so each mutation
  // re-probes its parent. Without the floor, a child whose parent died
  // after a clock step kept reusing the cached live verdict and mutated
  // under a capability whose publisher was gone. A negative age is a cache
  // miss; the re-probe below rewrites `atMs` and self-heals.
  if (cached !== undefined && cached.fingerprint === fingerprint) {
    const elapsedMs = options.nowMs - cached.atMs;
    if (elapsedMs >= 0 && elapsedMs < options.cacheTtlMs) {
      return cached.evidence;
    }
  }

  const evidence = evidenceForVerdict(
    probe.holder,
    probe.holder.supervisedProcessGroupId === undefined &&
      probe.holder.retainOnPublisherDeath !== true
      ? await verifyProcessIdentityAsync({
          pid: probe.holder.pid,
          startedAtMs: probe.holder.processStartedAtMs,
          startIdentity: probe.holder.processStartIdentity,
        })
      : verifyLockHolderLiveness(probe.holder),
  );
  holderCache.set(lockPath, {
    fingerprint,
    evidence,
    atMs: options.nowMs,
  });
  return evidence;
}

// The verdict -> evidence MAPPING is decided by
// `@traycer/protocol/config/host-update-attempt-liveness`, because
// `traycer-host` classifies the same lock file for its `host.status`
// projection and cannot import this package. Only the payload is decided
// here: this side attaches the full `LockMetadata` it already read, the host
// attaches its own projection, and neither changes what the verdict MEANS.
//
// The arms are unchanged from when they lived here: `dead` and
// `alive-different` are both positive proof that the process that WROTE this
// lock is gone (the second because the pid was recycled onto an unrelated
// process), and `indeterminate` stays `indeterminate` - it is the arm that
// keeps a failed probe from ever becoming an `interrupted` verdict.
function evidenceForVerdict(
  holder: LockMetadata,
  verdict: ProcessIdentityVerdict,
): AttemptHolderEvidence {
  switch (classifyAttemptHolderVerdict(verdict)) {
    case "holder-live":
      return { kind: "holder-live", holder };
    case "no-holder":
      return { kind: "no-holder" };
    case "indeterminate":
      return { kind: "indeterminate", cause: "holder-liveness-indeterminate" };
  }
}

// The protocol module cannot import `ProcessIdentityVerdict` (this package is
// unreachable from `traycer-host`), so it declares a structurally identical
// union. These two assignments are the guard against that duplication
// drifting: if either side gains or loses an arm, one of them stops
// compiling at exactly the line that describes why.
type VerdictAssignableToProtocol =
  ProcessIdentityVerdict extends AttemptHolderLivenessVerdict ? true : never;
type ProtocolAssignableToVerdict =
  AttemptHolderLivenessVerdict extends ProcessIdentityVerdict ? true : never;
const _verdictUnionsAgree: [
  VerdictAssignableToProtocol,
  ProtocolAssignableToVerdict,
] = [true, true];
void _verdictUnionsAgree;

// Delegated for the same reason as `evidenceForVerdict` above: the host's
// projection caches holder verdicts too, and two fingerprint functions would
// mean two cache-expiry rules for one lock file.
const holderFingerprint = attemptHolderFingerprint;

/** Test seam: drops the cached liveness verdicts. */
export function __resetAttemptHolderCacheForTest(): void {
  holderCache.clear();
}

/** Test seam: drops this process's held-lock claims. */
export function __resetHeldInProcessForTest(): void {
  heldInProcess.clear();
}
