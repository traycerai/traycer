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

// `update-attempt.lock` - the execution authority for a host update segment (§1.1).
// A thin wrapper over the hardened `cross-process-lock` protocol, the same module the CLI's `cli-lock` and the desktop's held sections wrap, so the two locks can never drift apart on what "held" means.

export type { LockMetadata };

/**
 * A segment's proof that it holds the attempt lock.
 * That makes the handle unforgeable by an object literal, so "callers must hold the lock" stops being an honour-system comment and becomes something the write path checks.
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
   * The host home that owns both canonical attempt resources.
   * Callers never supply a sibling lock path: that would turn one record's authority into authority for every filename next to it.
   */
  readonly hostHomeDir: string;
  /** What this segment is doing - written into the lock file for diagnostics. */
  readonly reason: string;
  /** How long to wait for the lock. */
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}

export type AcquireUpdateAttemptLockOutcome =
  | { readonly kind: "acquired"; readonly handle: UpdateAttemptLockHandle }
  | { readonly kind: "busy"; readonly holder: LockMetadata | null }
  // This process already holds the lock at that exact path.
  | { readonly kind: "held-in-process"; readonly holder: LockMetadata };

  // Lock paths currently held by this process, with the metadata of the holding section.
const heldInProcess = new Map<string, LockMetadata>();

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

      // This runs synchronously before the first await.
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
   * Acquire a synchronous, per-handle mutation lease.
   * `release()` marks the handle as releasing before it awaits this lease, then leaves the on-disk lock in place until the lease is returned.
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
 * Whether `handle` still owns the lock it names, right now.
 * it has not been released - the late-callback case, where a segment's continuation runs after its `finally` already let go; 3.
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

  // Do not use public handle fields for authority.
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
    // Empty/corrupt bytes.
    return { kind: "indeterminate", cause: "lock-unparseable" };
  }
  return probe.holder.token === token
    ? { kind: "owned" }
    : { kind: "lost", observed: probe.holder };
}

/**
 * Transfer only the *liveness publication* of an already-owned attempt lock to a supervised child process.
 * The token remains unchanged, so no new process gains mutation authority; this only prevents a live root actuator from becoming concurrently breakable if its CLI supervisor dies.
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
 * Supplemental liveness published for a supervised root actuator.
 * It cannot transfer mutation authority: the immutable acquisition token remains the only ownership proof.
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
 * What a reader can establish about the attempt lock's holder, and the only input to `deriveAttemptLiveness` that can ever justify "interrupted".
 * Everything else is `indeterminate`, which never becomes interruption - a probe failure, a lock file caught mid-creation, and a Windows `tasklist` that could not run all establish exactly nothing.
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
   * How long a verdict may be reused for an unchanged lock file.
   * §1.5 requires this: the liveness probe shells out to `tasklist` on Windows, and fleet status polling reads many hosts on a cadence, so an uncached probe turns a read-only projection into per-read process spawning.
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
 * Read-only probe of the attempt lock.
 * Never acquires, never breaks, never writes - a status projection must not become a mutator.
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
    // A holder still inside the `open()` -> `writeFile()` gap produces exactly these bytes, so this is not evidence of an abandoned lock.
    // Breaking it is the acquisition path's job (under arbitration, after a grace window); a reader only reports that it cannot tell.
    return { kind: "indeterminate", cause: "lock-unparseable" };
  }

  const fingerprint = holderFingerprint(probe.holder);
  const cached = holderCache.get(lockPath);
  // Without the floor, a child whose parent died after a clock step kept reusing the cached live verdict and mutated under a capability whose publisher was gone.
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

// The verdict -> evidence mapping is decided by `@traycer/protocol/config/host-update-attempt-liveness`, because `traycer-host` classifies the same lock file for its `host.status` projection and cannot import this package.
// Only the payload is decided here: this side attaches the full `LockMetadata` it already read, the host attaches its own projection, and neither changes what the verdict means.
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

// The protocol module cannot import `ProcessIdentityVerdict` (this package is unreachable from `traycer-host`), so it declares a structurally identical union.
type VerdictAssignableToProtocol =
  ProcessIdentityVerdict extends AttemptHolderLivenessVerdict ? true : never;
type ProtocolAssignableToVerdict =
  AttemptHolderLivenessVerdict extends ProcessIdentityVerdict ? true : never;
const _verdictUnionsAgree: [
  VerdictAssignableToProtocol,
  ProtocolAssignableToVerdict,
] = [true, true];
void _verdictUnionsAgree;

// Delegated for the same reason as `evidenceForVerdict` above: the host's projection caches holder verdicts too, and two fingerprint functions would mean two cache-expiry rules for one lock file.
const holderFingerprint = attemptHolderFingerprint;

export function __resetAttemptHolderCacheForTest(): void {
  holderCache.clear();
}

export function __resetHeldInProcessForTest(): void {
  heldInProcess.clear();
}
