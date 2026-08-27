import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  commitAttemptMutation,
  commitExecutorOnlyAttemptMutation,
  pruneTerminalAttemptRecord,
  readUpdateAttemptRecord,
  type AttemptCommitOutcome,
  type AttemptMutationIntent,
  type PublicAttemptMutationIntent,
} from "./store";
import type { HostUpdateAttemptRead } from "./decode";
import {
  acquireUpdateAttemptLock,
  probeAttemptHolder,
  verifyAttemptLockOwnership,
  rebindAttemptLockLiveness,
  type AttemptLockLivenessPublication,
  type LockMetadata,
  type UpdateAttemptLockHandle,
} from "./lock";
import { readLockHolder } from "../host-lock/cross-process-lock";
import type { HostUpdateAttemptRecord } from "./record";
import { attemptIdentityOf, sameAttemptIdentity } from "./record";
import { updateAttemptLockPath } from "./paths";

/**
 * The only non-update paths allowed through the contender boundary.
 *
 * New names are intentionally a source change here, rather than an arbitrary
 * string at a caller. Every exemption must state what it does when a durable
 * nonterminal attempt exists; that keeps a future repair or prefetch from
 * silently becoming a parallel updater.
 */
export type UpdateMaintenanceExemption =
  | "stage-maintenance"
  | "uninstall-maintenance"
  | "service-maintenance"
  | "desktop-activation-maintenance"
  | "runtime-repair-maintenance"
  /**
   * User-confirmed restart/doctor recovery. This performs only the existing
   * service/process recovery edge; it neither creates nor advances a v2
   * attempt and is deliberately distinct from Desktop activation.
   */
  | "recovery-maintenance";

/**
 * The compatibility bridge while legacy update execution remains selected.
 * It is deliberately distinct from a maintenance exemption: Ticket 03 must
 * remove this route when schema-v2 execution becomes eligible.
 */
export type UpdateContenderAdmission =
  | "legacy-update-shadow"
  /**
   * The Ticket 03 executor is the only non-legacy actor allowed to claim or
   * reconcile schema-v2 evidence. Its capability is still opaque; only the
   * capability-consuming executor mutation facade below can reach the core.
   */
  | "attempt-executor"
  | UpdateMaintenanceExemption;

export type ActiveAttemptDisposition = "yield" | "refuse" | "allow";

/**
 * A non-mutating policy fact supplied with a live contender capability.
 * Recovery callers must use this instead of re-reading a record after they
 * have decided to act: the action choice is therefore tied to the exact
 * durable attempt evidence admitted under the canonical lock.
 */
export type UpdateRecoveryAction = "restart-current" | "stop-only";

export interface UpdateContenderExecutionContext {
  readonly activeAttempt: HostUpdateAttemptRecord | null;
  readonly recoveryAction: UpdateRecoveryAction;
}

export interface WithUpdateContenderOptions {
  /** Canonical home for both update-attempt resources. */
  readonly hostHomeDir: string;
  /** Diagnostic lock reason. */
  readonly reason: string;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
  readonly admission: UpdateContenderAdmission;
}

/**
 * A proof that the callback currently owns the canonical attempt lock.
 *
 * It has no public constructor. Membership in `issuedCapabilities`, plus a
 * fresh token check, closes both object-literal forgery and stale/released
 * handle reuse. It conveys no raw lock handle or arbitrary record authority:
 * only an `attempt-executor` capability may consume it through
 * `commitExecutorAttemptMutation`, which remains canonical-read/recompute
 * bound inside the core.
 */
export interface UpdateMutationCapability {
  readonly hostHomeDir: string;
}

/**
 * One-shot parent-to-supervisor proof. It conveys no mutation authority to
 * the supervisor: it merely proves that the named parent still owns the
 * canonical lock while the OS service manager reaches `host start`.
 */
export interface UpdateMutationCapabilityAdoption {
  readonly hostHomeDir: string;
  readonly holder: LockMetadata;
}

/** Facts held only inside the CLI verifier's lexical completion callback. */
interface ExecutorCompletionObservation {
  readonly expected: {
    readonly attemptId: string;
    readonly generation: number;
    readonly sequence: number;
  };
  readonly targetVersion: string;
  readonly runningVersion: string;
  readonly runningOwner: "host-home-bound";
  readonly nowIso: string;
}

declare const verifiedExecutorCompletionProofBrand: unique symbol;

/**
 * A single-use runtime-branded terminal proof. It remains private with its
 * facts in this module's `WeakMap`; no caller can manufacture, retain, or
 * consume it outside the immediate session-owned write.
 */
interface VerifiedExecutorCompletionProof {
  readonly [verifiedExecutorCompletionProofBrand]: true;
}

/**
 * Internal capability-scoped terminal writer supplied only to the CLI's
 * trusted executor bridge. It is intentionally absent from the public barrel;
 * architecture enforcement permits its direct import only in that bridge.
 */
export interface ExecutorCompletionSession {
  complete(
    observation: ExecutorCompletionObservation,
  ): Promise<AttemptCommitOutcome>;
  revoke(): Promise<void>;
}

/**
 * How a capability holds its authority.
 *
 * `held` owns the canonical lock through a handle. `adopted` owns nothing: it
 * carries only a one-shot proof that some OTHER live process holds the lock,
 * and it re-validates that proof against disk on every verification.
 *
 * Making these two arms of one union - rather than one shape with a nullable
 * handle - is what enforces Ruling 1 structurally. Every record writer below
 * reaches its handle through `heldCapabilityState`, so an adopted capability
 * cannot reach a writer at all: not by policy, but because there is no handle
 * on that arm to pass. The child also has no way to release, break, or rebind
 * the parent's lock for the same reason.
 */
type CapabilityState =
  | {
      readonly kind: "held";
      readonly handle: UpdateAttemptLockHandle;
      readonly hostHomeDir: string;
      readonly admission: UpdateContenderAdmission;
    }
  | {
      readonly kind: "adopted";
      readonly adoption: UpdateMutationCapabilityAdoption;
      readonly hostHomeDir: string;
      /**
       * `attempt-executor` is unrepresentable here. An adopted child performs
       * install-tree and service work under its parent's segment; the parent
       * remains the sole author of the durable record.
       */
      readonly admission: Exclude<UpdateContenderAdmission, "attempt-executor">;
    };

type HeldCapabilityState = Extract<CapabilityState, { readonly kind: "held" }>;

const issuedCapabilities = new WeakSet<UpdateMutationCapability>();
const capabilityStates = new WeakMap<
  UpdateMutationCapability,
  CapabilityState
>();
const verifiedExecutorCompletionProofs = new WeakMap<
  object,
  ExecutorCompletionObservation
>();

export type UpdateMutationCapabilityVerdict =
  | { readonly kind: "live" }
  | { readonly kind: "not-issued" }
  | { readonly kind: "wrong-host-home" }
  | { readonly kind: "released" }
  | { readonly kind: "lost" }
  | { readonly kind: "indeterminate"; readonly cause: string };

function heldCapabilityState(
  capability: UpdateMutationCapability,
): HeldCapabilityState | null {
  if (!issuedCapabilities.has(capability)) return null;
  const state = capabilityStates.get(capability);
  return state === undefined || state.kind !== "held" ? null : state;
}

/**
 * An adopted capability is live only on CONJUNCTIVE positive proof, re-taken
 * on every call:
 *
 *  1. the recorded holder identity still matches the lock on disk, token, pid,
 *     start time and start identity included; and
 *  2. that holder is still a LIVE process.
 *
 * (1) alone is the trap. A parent that died leaves its lock file behind, so
 * identity keeps matching a holder that no longer exists, and a child would
 * happily actuate on a segment nobody is running. (2) alone is not enough
 * either: a different process could hold the lock by then.
 *
 * The liveness probe is uncached (`cacheTtlMs: 0`) and that is not a
 * performance oversight. `probeAttemptHolder`'s cache exists so fleet status
 * polling does not spawn `tasklist` per host per read - it is sized for a
 * read-only projection. A cached positive verdict can outlive the parent's
 * death by its whole TTL, and authorizing an install-tree mutation on one
 * would be authorizing it on a memory of liveness rather than liveness.
 *
 * Every non-positive shape - no holder, indeterminate, unparseable lock,
 * token mismatch - resolves to not-live. There is no arm here that admits on
 * the absence of contrary evidence.
 */
async function verifyAdoptedCapability(
  state: Extract<CapabilityState, { readonly kind: "adopted" }>,
): Promise<UpdateMutationCapabilityVerdict> {
  const matches = await validateUpdateMutationCapabilityAdoption(
    state.adoption,
    state.hostHomeDir,
  );
  if (!matches) return { kind: "lost" };
  const holder = await probeAttemptHolder({
    hostHomeDir: state.hostHomeDir,
    nowMs: Date.now(),
    cacheTtlMs: 0,
  });
  if (holder.kind === "no-holder") return { kind: "lost" };
  if (holder.kind === "indeterminate") {
    return { kind: "indeterminate", cause: holder.cause };
  }
  const token = state.adoption.holder.token;
  return token !== null && holder.holder.token === token
    ? { kind: "live" }
    : { kind: "lost" };
}

/**
 * Re-check capability ownership at the final mutation/restart boundary.
 * Callers must use this immediately before their injected install-tree or
 * service actuator, not merely when they first planned the operation.
 */
export async function verifyUpdateMutationCapability(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
): Promise<UpdateMutationCapabilityVerdict> {
  if (!issuedCapabilities.has(capability)) return { kind: "not-issued" };
  const state = capabilityStates.get(capability);
  if (state === undefined) return { kind: "not-issued" };
  if (state.hostHomeDir !== resolve(hostHomeDir)) {
    return { kind: "wrong-host-home" };
  }

  if (state.kind === "adopted") return verifyAdoptedCapability(state);

  const ownership = await verifyAttemptLockOwnership(state.handle);
  switch (ownership.kind) {
    case "owned":
      return { kind: "live" };
    case "not-issued":
      return { kind: "not-issued" };
    case "released":
      return { kind: "released" };
    case "lost":
      return { kind: "lost" };
    case "indeterminate":
      return { kind: "indeterminate", cause: ownership.cause };
  }
}

/** Internal supervisor hook; does not mint or transfer capability authority. */
export async function rebindUpdateMutationCapabilityLiveness(
  capability: UpdateMutationCapability,
  pid: number,
  publication: AttemptLockLivenessPublication,
): Promise<void> {
  if (!issuedCapabilities.has(capability)) {
    throw new Error("update mutation capability was not issued");
  }
  const state = heldCapabilityState(capability);
  if (state === null) {
    throw new Error("update mutation capability state was unavailable");
  }
  await rebindAttemptLockLiveness(state.handle, pid, publication);
}

/**
 * The record-write boundary for an executor that holds a capability but no
 * lock handle - which is every executor outside this package, because
 * `withUpdateContender` deliberately hands out the former and never the
 * latter.
 *
 * ## Why it takes `PublicAttemptMutationIntent` and nothing wider
 *
 * The three executor-only intents (`recover`, `advance -> complete`, and a
 * recovery-provenance `supersede`) are absent from this signature by
 * construction, not by a runtime check that a future edit could soften. Each
 * of them is legal only against evidence gathered under an inner lock by the
 * actor that owns the verification segment, and each is reachable only through
 * the two facades below.
 *
 * That split is what lets a second executor exist without a second terminal
 * writer. A packaged-macOS Desktop segment can claim, advance, park and fail
 * its own attempt through here; the terminal states remain the property of an
 * executor that has done the evidence work, and stay unreachable from this
 * entry no matter which admission a caller holds.
 *
 * `attempt-executor` admission is still required: a maintenance or legacy
 * capability must not become a record writer merely because the intent it
 * carries happens to be a public one.
 */
export async function commitAttemptMutationWithCapability(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
  intent: PublicAttemptMutationIntent,
): Promise<AttemptCommitOutcome> {
  if (!issuedCapabilities.has(capability)) {
    throw new Error("update executor capability was not issued");
  }
  const state = heldCapabilityState(capability);
  if (state === null || state.admission !== "attempt-executor") {
    throw new Error("update executor capability was not admitted");
  }
  const verdict = await verifyUpdateMutationCapability(capability, hostHomeDir);
  if (verdict.kind !== "live") {
    throw new Error(`update executor capability is not live (${verdict.kind})`);
  }
  // The public store channel, never the executor-only one. The core still
  // re-reads canonical bytes under the handle lease and recomputes the record
  // from the intent, so this facade contributes the live-capability check and
  // nothing else - it cannot widen what the intent is allowed to express.
  return commitAttemptMutation({ handle: state.handle, intent });
}

/**
 * Capability-consuming durable mutation boundary for the schema-v2 executor.
 *
 * This is intentionally narrower than `commitAttemptMutation`: callers never
 * receive the lock handle and maintenance/legacy capabilities cannot turn
 * into record writers. The core rechecks ownership and recomputes the intent
 * from canonical bytes; this facade supplies the final live-capability check
 * that binds that write to the executor's outer segment.
 */
export async function commitExecutorAttemptMutation(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
  intent: Exclude<AttemptMutationIntent, { readonly kind: "recover" }>,
): Promise<AttemptCommitOutcome> {
  if (!issuedCapabilities.has(capability)) {
    throw new Error("update executor capability was not issued");
  }
  const state = heldCapabilityState(capability);
  if (state === null || state.admission !== "attempt-executor") {
    throw new Error("update executor capability was not admitted");
  }
  const verdict = await verifyUpdateMutationCapability(capability, hostHomeDir);
  if (verdict.kind !== "live") {
    throw new Error(`update executor capability is not live (${verdict.kind})`);
  }
  if (intent.kind === "advance") {
    if (intent.advance.phase === "complete") {
      throw new Error(
        "executor completion requires exact running-version verification",
      );
    }
    return commitAttemptMutation({
      handle: state.handle,
      intent: {
        kind: "advance",
        held: intent.held,
        advance: {
          ...intent.advance,
          phase: intent.advance.phase,
        },
      },
    });
  }
  if (intent.kind === "supersede") {
    if (intent.recovery !== undefined) {
      return commitExecutorOnlyAttemptMutation({
        handle: state.handle,
        intent: {
          kind: "supersede",
          request: intent.request,
          recovery: intent.recovery,
        },
      });
    }
    return commitAttemptMutation({
      handle: state.handle,
      intent: { kind: "supersede", request: intent.request },
    });
  }
  return commitAttemptMutation({ handle: state.handle, intent });
}

/**
 * Internal recovery writer. It deliberately stays out of the public barrel:
 * only the CLI executor's verifier-owned bridge may submit the evidence-bound
 * `recover` intent after its inner CLI-lock observation.
 */
export async function commitExecutorRecoveryMutation(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
  intent: Extract<AttemptMutationIntent, { readonly kind: "recover" }>,
): Promise<AttemptCommitOutcome> {
  if (!issuedCapabilities.has(capability)) {
    throw new Error("update executor capability was not issued");
  }
  const state = heldCapabilityState(capability);
  if (state === null || state.admission !== "attempt-executor") {
    throw new Error("update executor capability was not admitted");
  }
  const verdict = await verifyUpdateMutationCapability(capability, hostHomeDir);
  if (verdict.kind !== "live") {
    throw new Error(`update executor capability is not live (${verdict.kind})`);
  }
  return commitExecutorOnlyAttemptMutation({ handle: state.handle, intent });
}

/**
 * Seal facts that the live CLI verifier just derived under its inner CLI lock.
 * The opaque result contains no readable evidence and is valid exactly once
 * for the same issued executor capability/host-home pair.
 */
async function sealVerifiedExecutorCompletion(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
  evidence: ExecutorCompletionObservation,
): Promise<VerifiedExecutorCompletionProof> {
  if (!issuedCapabilities.has(capability)) {
    throw new Error("update executor capability was not issued");
  }
  const state = heldCapabilityState(capability);
  if (state === null || state.admission !== "attempt-executor") {
    throw new Error("update executor capability was not admitted");
  }
  const verdict = await verifyUpdateMutationCapability(capability, hostHomeDir);
  if (verdict.kind !== "live") {
    throw new Error(`update executor capability is not live (${verdict.kind})`);
  }
  if (
    evidence.runningVersion !== evidence.targetVersion ||
    evidence.runningOwner !== "host-home-bound"
  ) {
    throw new Error("executor completion evidence was not exact");
  }
  const proof = Object.freeze({}) as VerifiedExecutorCompletionProof;
  verifiedExecutorCompletionProofs.set(proof, evidence);
  return proof;
}

/**
 * The sole normal-completion writer. It consumes a proof sealed by the live
 * verifier above, so structural literals and casts cannot supply terminal
 * evidence. It still rechecks the capability and canonical record at the
 * durable write edge.
 */
async function commitVerifiedExecutorCompletion(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
  proof: VerifiedExecutorCompletionProof,
): Promise<AttemptCommitOutcome> {
  const evidence = verifiedExecutorCompletionProofs.get(proof);
  if (evidence === undefined) {
    throw new Error("executor completion proof was not issued");
  }
  // Consume before any effect. A retry must obtain fresh live evidence; it
  // can never reuse a proof observed before a crash or lock loss.
  verifiedExecutorCompletionProofs.delete(proof);
  if (!issuedCapabilities.has(capability)) {
    throw new Error("update executor capability was not issued");
  }
  const state = heldCapabilityState(capability);
  if (state === null || state.admission !== "attempt-executor") {
    throw new Error("update executor capability was not admitted");
  }
  const verdict = await verifyUpdateMutationCapability(capability, hostHomeDir);
  if (verdict.kind !== "live") {
    throw new Error(`update executor capability is not live (${verdict.kind})`);
  }
  const canonical = await readUpdateAttemptRecord(state.hostHomeDir);
  if (
    canonical.kind !== "valid" ||
    canonical.value.phase !== "verifying" ||
    !sameAttemptIdentity(
      attemptIdentityOf(canonical.value),
      evidence.expected,
    ) ||
    canonical.value.targetVersion !== evidence.targetVersion ||
    evidence.runningVersion !== evidence.targetVersion ||
    evidence.runningOwner !== "host-home-bound"
  ) {
    return {
      kind: "rejected",
      reason: "intent-not-legal",
      canonical,
    };
  }
  return commitExecutorOnlyAttemptMutation({
    handle: state.handle,
    intent: {
      kind: "advance",
      held: evidence.expected,
      advance: {
        phase: "complete",
        continuation: null,
        progress: canonical.value.progress,
        error: null,
        nowIso: evidence.nowIso,
      },
    },
  });
}

export async function createUpdateMutationCapabilityAdoption(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
): Promise<UpdateMutationCapabilityAdoption> {
  const verdict = await verifyUpdateMutationCapability(capability, hostHomeDir);
  if (verdict.kind !== "live") {
    throw new Error(`update mutation capability is not live (${verdict.kind})`);
  }
  const state = heldCapabilityState(capability);
  if (state === null) {
    throw new Error("update mutation capability state was unavailable");
  }
  const holder = await readLockHolder(state.handle.path);
  const token = state.handle.metadata.token;
  if (
    holder.kind !== "held" ||
    token === null ||
    holder.holder.token !== token
  ) {
    throw new Error(
      "update mutation capability lost ownership before adoption",
    );
  }
  return { hostHomeDir: state.hostHomeDir, holder: holder.holder };
}

/** Validate a consumed supervisor proof against the live canonical holder. */
export async function validateUpdateMutationCapabilityAdoption(
  adoption: UpdateMutationCapabilityAdoption,
  hostHomeDir: string,
): Promise<boolean> {
  if (resolve(adoption.hostHomeDir) !== resolve(hostHomeDir)) return false;
  const holder = await readLockHolder(
    updateAttemptLockPath(resolve(adoption.hostHomeDir)),
  );
  if (holder.kind !== "held") return false;
  return (
    holder.holder.token !== null &&
    holder.holder.token === adoption.holder.token &&
    holder.holder.pid === adoption.holder.pid &&
    holder.holder.processStartedAtMs === adoption.holder.processStartedAtMs &&
    JSON.stringify(holder.holder.processStartIdentity) ===
      JSON.stringify(adoption.holder.processStartIdentity)
  );
}

export type UpdateContenderOutcome<T> =
  | { readonly kind: "ran"; readonly result: T }
  | { readonly kind: "busy"; readonly holder: LockMetadata | null }
  | { readonly kind: "held-in-process"; readonly holder: LockMetadata }
  | {
      /**
       * `allow` is deliberately not representable here. An admission that
       * allows an active attempt does not produce this outcome at all - it
       * runs the callback (see the `disposition !== "allow"` gate in
       * `withUpdateContenderInternal`) - so a caller that had to handle an
       * `allow` arm would be writing a branch this module can never take, and
       * would have to invent a meaning for it.
       *
       * Stating the narrowing on the type is what lets a consumer exhaust
       * `yield | refuse` honestly instead of widening its own union to keep
       * the compiler quiet.
       */
      readonly kind: "nonterminal-attempt";
      readonly disposition: Exclude<ActiveAttemptDisposition, "allow">;
      readonly admission: UpdateContenderAdmission;
      readonly record: HostUpdateAttemptRecord;
    }
  | {
      readonly kind: "record-fail-closed";
      readonly admission: UpdateContenderAdmission;
      readonly record: Exclude<
        HostUpdateAttemptRead,
        { readonly kind: "valid" } | { readonly kind: "absent" }
      >;
    }
  | {
      readonly kind: "lock-not-live";
      readonly verdict: Exclude<
        UpdateMutationCapabilityVerdict,
        { readonly kind: "live" }
      >;
    };

/** The executor-only option shape intentionally cannot select another admission. */
export type WithUpdateExecutorCompletionSegmentOptions = Omit<
  WithUpdateContenderOptions,
  "admission"
>;

/**
 * The shared enforcement/shadow boundary for all current contenders.
 *
 * It acquires update-attempt before a caller can acquire the existing
 * `cli-lock`, reads durable attempt evidence under that lock, and passes an
 * opaque live capability to the admitted operation. With no schema-v2
 * executor selected, absence and terminal evidence preserve the legacy path;
 * nonterminal or faulted evidence never gets silently replaced by a legacy
 * mutation.
 */
export async function withUpdateContender<T>(
  options: WithUpdateContenderOptions,
  run: (
    capability: UpdateMutationCapability,
    context: UpdateContenderExecutionContext,
  ) => Promise<T>,
): Promise<UpdateContenderOutcome<T>> {
  return withUpdateContenderInternal(options, (capability, context) =>
    run(capability, context),
  );
}

/**
 * Internal executor bridge. It forces executor admission and hands the
 * revocable completion closure only to the trusted CLI bridge; generic shadow
 * and maintenance callers cannot obtain it through the public barrel.
 */
export async function withUpdateExecutorCompletionSegment<T>(
  options: WithUpdateExecutorCompletionSegmentOptions,
  run: (
    capability: UpdateMutationCapability,
    context: UpdateContenderExecutionContext,
    completion: ExecutorCompletionSession,
  ) => Promise<T>,
): Promise<UpdateContenderOutcome<T>> {
  return withUpdateContenderInternal(
    { ...options, admission: "attempt-executor" },
    async (capability, context, completion) => {
      if (completion === null) {
        throw new Error("attempt executor completion session was unavailable");
      }
      try {
        return await run(capability, context, completion);
      } finally {
        // AsyncLocalStorage propagates to detached work. An explicit revocable
        // session instead makes a completion callback unusable the instant the
        // admitted executor callback settles, before the outer lock releases.
        await completion.revoke();
      }
    },
  );
}

/**
 * Run work under a proof that ANOTHER live process holds the canonical lock.
 *
 * This is the second half of Ruling 1. The packaged-macOS executor holds the
 * attempt lock for its whole segment, but the byte-placement steps it needs -
 * `host apply --no-service`, `host install`, `host stamp-runtime` - are
 * bundled-CLI children that each call `withUpdateContender` themselves. A
 * child that tries to ACQUIRE deadlocks against its own parent, waits out the
 * lock timeout, and fails the segment that spawned it.
 *
 * So the child validates instead of acquiring. What it gets is a capability
 * that behaves identically at every consumer - the same
 * `verifyUpdateMutationCapability`, the same facades, the same architecture
 * gates - and differs only in how it proves liveness. Adoption is another way
 * to HOLD authority, never a way to bypass the checks that authority gates.
 *
 * Two things it deliberately cannot do, both structural rather than policed:
 *
 *  - **Write the record.** Its admission cannot be `attempt-executor`, and the
 *    record writers reach their handle through `heldCapabilityState`, which
 *    has nothing to return on this arm. The parent stays the sole author.
 *  - **Touch the parent's lock.** No handle is ever constructed here, so there
 *    is no release, no break, and no liveness rebind to call.
 *
 * A caller with no proof keeps `withUpdateContender` and today's
 * acquire-or-refuse behaviour, unchanged.
 */
export async function withUpdateContenderAdoption<T>(
  adoption: UpdateMutationCapabilityAdoption,
  options: Omit<WithUpdateContenderOptions, "admission"> & {
    readonly admission: Exclude<UpdateContenderAdmission, "attempt-executor">;
  },
  run: (capability: UpdateMutationCapability) => Promise<T>,
): Promise<UpdateContenderOutcome<T>> {
  const hostHomeDir = resolve(options.hostHomeDir);
  if (resolve(adoption.hostHomeDir) !== hostHomeDir) {
    return { kind: "lock-not-live", verdict: { kind: "wrong-host-home" } };
  }
  const capability: UpdateMutationCapability = { hostHomeDir };
  issuedCapabilities.add(capability);
  capabilityStates.set(capability, {
    kind: "adopted",
    adoption,
    hostHomeDir,
    admission: options.admission,
  });

  // Verified before the callback and again after it, exactly as the acquiring
  // path does. The parent can die mid-segment, and a child that reported
  // success on work it finished after that would be reporting success for a
  // segment that no longer existed to own it.
  //
  // The `finally` is the LIFETIME BOUNDARY, and it was missing.
  //
  // The acquiring path loses authority when its lock handle releases in its own
  // `finally`; the adopted path had no equivalent, so the capability stayed in
  // `capabilityStates` after the callback returned. A callback that captured it
  // and scheduled work outliving the segment could then re-verify `live` - the
  // parent's lock is still held, which is exactly what the adopted verdict
  // checks - and enter an install or service actuator *outside* the segment and
  // without the inner CLI lock that was meant to serialize it against
  // mixed-version CLI work.
  //
  // No current callback detaches work, so this closes a future/accidental
  // trigger rather than an observed escape. That is the right time to close an
  // authority hole: the alternative is discovering it from the one caller who
  // eventually does.
  try {
    const before = await verifyUpdateMutationCapability(
      capability,
      hostHomeDir,
    );
    if (before.kind !== "live") {
      return { kind: "lock-not-live", verdict: before };
    }
    const result = await run(capability);
    const after = await verifyUpdateMutationCapability(capability, hostHomeDir);
    if (after.kind !== "live") {
      return { kind: "lock-not-live", verdict: after };
    }
    return { kind: "ran", result };
  } finally {
    // Authority ends with the segment, on every exit path - return, refusal,
    // or throw. An escaped capability verifies dead from here on.
    capabilityStates.delete(capability);
    issuedCapabilities.delete(capability);
  }
}

async function withUpdateContenderInternal<T>(
  options: WithUpdateContenderOptions,
  run: (
    capability: UpdateMutationCapability,
    context: UpdateContenderExecutionContext,
    completion: ExecutorCompletionSession | null,
  ) => Promise<T>,
): Promise<UpdateContenderOutcome<T>> {
  // The attempt lock lives directly under the canonical host home. First-run
  // install and Desktop activation legitimately contend before a legacy
  // installer has created that directory, so establish only this parent
  // before taking the outer lock. No install/stage record is created here.
  await mkdir(options.hostHomeDir, { recursive: true });
  const acquisition = await acquireUpdateAttemptLock({
    hostHomeDir: options.hostHomeDir,
    reason: options.reason,
    waitMs: options.waitMs,
    pollIntervalMs: options.pollIntervalMs,
  });
  if (acquisition.kind === "busy") return acquisition;
  if (acquisition.kind === "held-in-process") return acquisition;

  try {
    const capability = issueCapability(acquisition.handle, options.admission);
    const live = await verifyUpdateMutationCapability(
      capability,
      options.hostHomeDir,
    );
    if (live.kind !== "live") return { kind: "lock-not-live", verdict: live };

    const record = await readUpdateAttemptRecord(options.hostHomeDir);
    if (record.kind !== "absent" && record.kind !== "valid") {
      return {
        kind: "record-fail-closed",
        admission: options.admission,
        record,
      };
    }
    const activeAttempt =
      record.kind === "valid" && record.value.execution !== "terminal"
        ? record.value
        : null;
    // Retention cleanup runs HERE, at attempt-store open, and this is the only
    // place it can run. `pruneTerminalAttemptRecord` is handle-bound by design,
    // and a handle exists at a lock acquisition and nowhere on the read paths -
    // so `host.status`, which is what surfaces the stale record, is structurally
    // unable to expire it. Without this call `TERMINAL_ATTEMPT_RETENTION_MS` was
    // dead policy: a terminal attempt that no newer attempt replaced projected
    // forever, and the Overview kept showing an old failure with no expiry.
    //
    // Per acquisition rather than on a timer: bounded, deterministic, and it
    // adds no scheduling to a module whose whole contract is explicit
    // lock-scoped mutation. A terminal record cannot be an `activeAttempt`
    // (that requires `execution !== "terminal"`), so this never interacts with
    // the disposition gate below.
    //
    // The expiry decision is deliberately NOT made here. `prune` re-reads under
    // its own lease and applies `isTerminalRetentionExpired` itself; this
    // caller supplies only observation time, which is the boundary
    // `PruneTerminalAttemptRecordOptions` documents ("the caller controls only
    // observation time, never retention policy"). Gating on `terminal` alone is
    // a cheap read of data already in hand and keeps policy in one place.
    //
    // Best-effort by intent: a rejection - lost ownership, a racing writer, a
    // record that changed under the lease - must never fail an admission that
    // was otherwise granted. The record simply survives to the next
    // acquisition, which is the same eventual outcome one tick later.
    if (record.kind === "valid" && record.value.execution === "terminal") {
      await pruneTerminalAttemptRecord({
        handle: acquisition.handle,
        expected: attemptIdentityOf(record.value),
        nowMs: Date.now(),
      });
    }
    if (activeAttempt !== null) {
      const disposition = dispositionFor(options.admission);
      // Update state is not a global host-action mutex. A direct, confirmed
      // recovery restart/doctor action remains available while a logical
      // update is active or parked, provided this contender won the physical
      // execution lock. It is a legacy service/process edge only: no record
      // transition, promotion, or parked-byte activation is authorized here.
      if (disposition !== "allow") {
        return {
          kind: "nonterminal-attempt",
          disposition,
          admission: options.admission,
          record: activeAttempt,
        };
      }
    }
    // `readUpdateAttemptRecord` can perform I/O, so the capability used to
    // admit the callback must be freshly live at the mutation boundary, not
    // merely at lock acquisition. Adapters repeat this check after their
    // inner cli-lock acquisition as well.
    const beforeRun = await verifyUpdateMutationCapability(
      capability,
      options.hostHomeDir,
    );
    if (beforeRun.kind !== "live") {
      return { kind: "lock-not-live", verdict: beforeRun };
    }
    const completion =
      options.admission === "attempt-executor"
        ? executorCompletionSession(capability, options.hostHomeDir)
        : null;
    const result = await run(
      capability,
      {
        activeAttempt,
        recoveryAction: recoveryActionFor(activeAttempt),
      },
      completion,
    );
    // A callback is allowed to contain lengthy, non-actuating work. It must
    // nevertheless not be able to report success after the evidence it was
    // admitted on has disappeared. Concrete mutation facades perform the
    // same check immediately before their rename/service call; this final
    // check closes the return-value half of a lock-loss race as well.
    const afterRun = await verifyUpdateMutationCapability(
      capability,
      options.hostHomeDir,
    );
    if (afterRun.kind !== "live") {
      return { kind: "lock-not-live", verdict: afterRun };
    }
    return { kind: "ran", result };
  } finally {
    await acquisition.handle.release();
  }
}

/**
 * Created inside one admitted executor callback only. The closure captures
 * the issued capability and canonical home rather than accepting either from
 * a future caller, so it becomes unusable immediately after the outer lock
 * releases even if somebody retains the session object.
 */
function executorCompletionSession(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
): ExecutorCompletionSession {
  let state: "active" | "completing" | "closed" = "active";
  let completionSettled: Promise<void> | null = null;
  return {
    async complete(
      observation: ExecutorCompletionObservation,
    ): Promise<AttemptCommitOutcome> {
      if (state !== "active") {
        throw new Error(
          "executor terminal completion was called outside its session",
        );
      }
      state = "completing";
      const completionDeferred = {
        settle(): void {},
      };
      completionSettled = new Promise<void>((resolve) => {
        completionDeferred.settle = resolve;
      });
      try {
        const proof = await sealVerifiedExecutorCompletion(
          capability,
          hostHomeDir,
          observation,
        );
        return await commitVerifiedExecutorCompletion(
          capability,
          hostHomeDir,
          proof,
        );
      } finally {
        state = "closed";
        completionDeferred.settle();
      }
    },
    async revoke(): Promise<void> {
      if (state === "active") {
        state = "closed";
        return;
      }
      if (completionSettled !== null) await completionSettled;
    },
  };
}

function recoveryActionFor(
  activeAttempt: HostUpdateAttemptRecord | null,
): UpdateRecoveryAction {
  if (activeAttempt === null) return "restart-current";
  // `applying` is the durable write-ahead checkpoint for byte placement. A
  // crash can leave it recorded after the canonical swap but before the
  // executor publishes `waiting-to-activate`, whether it was a fresh apply
  // (`null`) or a resumed apply (`resume-apply`). A generic `host start`
  // would resolve those possibly-new bytes and activate them outside the
  // attempt's continuation, so an independent recovery may only stop.
  if (activeAttempt.phase === "applying") return "stop-only";
  // A resumed packaged-Mac activation deliberately returns to
  // `preparing/activate` after bytes are placed, while it performs the final
  // drain before the sole legal restart edge.  Restarting the generic
  // supervisor here would activate those bytes outside that continuation.
  // `preparing/resume-apply` has not reached the placed-byte handoff.
  if (
    activeAttempt.phase === "preparing" &&
    activeAttempt.continuation === "activate"
  ) {
    return "stop-only";
  }
  // This parked checkpoint proves the same fact explicitly: bytes are placed
  // and activation belongs only to the named continuation. In contrast a
  // `verifying/activate` record has already crossed the restart boundary, so
  // user-confirmed recovery may restart the current installed target.
  return activeAttempt.phase === "waiting-to-activate"
    ? "stop-only"
    : "restart-current";
}

function issueCapability(
  handle: UpdateAttemptLockHandle,
  admission: UpdateContenderAdmission,
): UpdateMutationCapability {
  const capability: UpdateMutationCapability = {
    hostHomeDir: handle.hostHomeDir,
  };
  issuedCapabilities.add(capability);
  capabilityStates.set(capability, {
    kind: "held",
    handle,
    hostHomeDir: handle.hostHomeDir,
    admission,
  });
  return capability;
}

function dispositionFor(
  admission: UpdateContenderAdmission,
): ActiveAttemptDisposition {
  switch (admission) {
    case "legacy-update-shadow":
    case "stage-maintenance":
      return "yield";
    case "uninstall-maintenance":
    case "service-maintenance":
    case "desktop-activation-maintenance":
    case "runtime-repair-maintenance":
      return "refuse";
    case "recovery-maintenance":
    case "attempt-executor":
      return "allow";
  }
}
