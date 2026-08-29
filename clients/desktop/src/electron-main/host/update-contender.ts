import {
  verifyUpdateMutationCapability,
  withUpdateContender,
  type UpdateContenderAdmission,
  type UpdateContenderOutcome,
  type UpdateMutationCapability,
  type HostUpdateAttemptRead,
  type HostUpdateAttemptRecord,
  type LockMetadata,
} from "@traycer-clients/shared/host-update";
import {
  withDesktopCliLock,
  type DesktopCliLockHandle,
  type WithDesktopCliLockOutcome,
} from "./desktop-cli-lock";
import { DesktopAttemptCapabilityError } from "./update-mutation";

/**
 * Desktop's only direct-service mutation bridge. It deliberately obtains the
 * canonical update-attempt lock before the existing cross-process CLI lock,
 * matching the CLI bridge and preserving one global lock order.
 */
export interface WithDesktopUpdateContenderOptions {
  readonly hostHomeDir: string;
  readonly lockPath: string;
  readonly reason: string;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
  readonly admission: UpdateContenderAdmission;
}

export type DesktopUpdateContenderOutcome<T> =
  | { readonly kind: "acquired"; readonly result: T }
  | {
      readonly kind: "busy";
      readonly source: "attempt" | "cli";
      readonly holder: LockMetadata | null;
    }
  | {
      readonly kind: "nonterminal-attempt";
      readonly disposition: "yield" | "refuse";
      readonly admission: UpdateContenderAdmission;
      readonly record: HostUpdateAttemptRecord;
    }
  | {
      readonly kind: "record-fail-closed";
      readonly record: Exclude<
        HostUpdateAttemptRead,
        { readonly kind: "valid" } | { readonly kind: "absent" }
      >;
    }
  | {
      readonly kind: "capability-not-live";
      readonly verdict: string;
    };

type DesktopInnerResult<T> =
  | { readonly kind: "ran"; readonly result: T }
  | { readonly kind: "capability-not-live"; readonly verdict: string };

/**
 * Deliberately a separate union from {@link DesktopInnerResult}, not an extra
 * arm on it. The two wrappers differ in where the CLI lock sits: the
 * whole-callback wrapper learns "busy" from `withDesktopCliLock`'s own
 * outcome, while an execution segment can only learn it from an inner
 * acquisition several frames down. Sharing one union would force the older
 * wrapper to carry an arm it can never produce.
 */
type DesktopSegmentInnerResult<T> =
  | { readonly kind: "ran"; readonly result: T }
  | { readonly kind: "capability-not-live"; readonly verdict: string }
  | {
      readonly kind: "cli-lock-busy";
      readonly holder: LockMetadata | null;
    };

export async function withDesktopUpdateContender<T>(
  options: WithDesktopUpdateContenderOptions,
  run: (
    capability: UpdateMutationCapability,
    cliLock: DesktopCliLockHandle,
  ) => Promise<T>,
): Promise<DesktopUpdateContenderOutcome<T>> {
  const contender = await withUpdateContender(
    {
      hostHomeDir: options.hostHomeDir,
      reason: options.reason,
      waitMs: options.waitMs,
      pollIntervalMs: options.pollIntervalMs,
      admission: options.admission,
    },
    async (capability) =>
      withDesktopCliLock(
        {
          lockPath: options.lockPath,
          reason: options.reason,
          waitMs: options.waitMs,
          pollIntervalMs: options.pollIntervalMs,
        },
        async (cliLock): Promise<DesktopInnerResult<T>> => {
          const live = await verifyUpdateMutationCapability(
            capability,
            options.hostHomeDir,
          );
          if (live.kind !== "live") {
            return { kind: "capability-not-live", verdict: live.kind };
          }
          try {
            return { kind: "ran", result: await run(capability, cliLock) };
          } catch (err) {
            if (err instanceof DesktopAttemptCapabilityError) {
              return { kind: "capability-not-live", verdict: err.verdict };
            }
            throw err;
          }
        },
      ),
  );

  return mapDesktopContenderOutcome(contender);
}

/**
 * The desktop CLI lock was busy inside an already-admitted execution segment.
 *
 * Thrown rather than returned because it surfaces from the INNER boundary,
 * several frames below the callback the segment admitted, and the alternative
 * is threading a result union through every intermediate step until one of
 * them forgets. The segment wrapper below is the only catcher; nothing else
 * should handle it.
 */
export class DesktopCliLockBusyError extends Error {
  readonly holder: LockMetadata | null;

  constructor(holder: LockMetadata | null) {
    super("desktop cli lock was busy inside an update execution segment");
    this.holder = holder;
  }
}

export interface WithDesktopUpdateSegmentOptions {
  readonly hostHomeDir: string;
  /** Used only by {@link withDesktopAttemptMutation}'s inner acquisitions. */
  readonly lockPath: string;
  readonly reason: string;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
  readonly admission: UpdateContenderAdmission;
}

/**
 * Own the outer attempt capability for a whole execution segment, taking the
 * inner CLI lock only through {@link withDesktopAttemptMutation}.
 *
 * ## Why this cannot be `withDesktopUpdateContender`
 *
 * That wrapper nests `withDesktopCliLock` around the ENTIRE callback, which is
 * right for the short maintenance sections it serves and wrong for an executor
 * segment. An activation segment spans a readiness wait of up to a minute and
 * spawns bundled-CLI children that re-acquire this very lock - holding it
 * across that is the nested-lock deadlock Fixup A7 removed when it moved
 * `stampIfNullRuntime` outside the locked section ("CLI-locked and
 * desktop-locked sections are sequenced, not nested").
 *
 * The global order is unchanged and is the reason both wrappers exist:
 * `update-attempt.lock` outer, `cli-lock` inner, never the reverse.
 */
export async function withDesktopUpdateExecutionSegment<T>(
  options: WithDesktopUpdateSegmentOptions,
  run: (capability: UpdateMutationCapability) => Promise<T>,
): Promise<DesktopUpdateContenderOutcome<T>> {
  const contender = await withUpdateContender(
    {
      hostHomeDir: options.hostHomeDir,
      reason: options.reason,
      waitMs: options.waitMs,
      pollIntervalMs: options.pollIntervalMs,
      admission: options.admission,
    },
    async (capability): Promise<DesktopSegmentInnerResult<T>> => {
      try {
        return { kind: "ran", result: await run(capability) };
      } catch (err) {
        // Both inner-boundary failures resolve to an outcome rather than an
        // exception, so a caller cannot mistake "the lock moved under us" for
        // a failure of the work itself and retry the actuator.
        if (err instanceof DesktopAttemptCapabilityError) {
          return { kind: "capability-not-live", verdict: err.verdict };
        }
        if (err instanceof DesktopCliLockBusyError) {
          return { kind: "cli-lock-busy", holder: err.holder };
        }
        throw err;
      }
    },
  );
  return mapDesktopSegmentOutcome(contender);
}

/** The executor admission is forced; this entry cannot select another. */
export async function withDesktopAttemptExecutor<T>(
  options: Omit<WithDesktopUpdateSegmentOptions, "admission">,
  run: (capability: UpdateMutationCapability) => Promise<T>,
): Promise<DesktopUpdateContenderOutcome<T>> {
  return withDesktopUpdateExecutionSegment(
    { ...options, admission: "attempt-executor" },
    run,
  );
}

/**
 * Capability-consuming inner mutation boundary: the attempt capability stays
 * held by its segment while the CLI lock is taken for exactly one short
 * install-tree or service operation.
 *
 * Verified twice, and the second one is the load-bearing one: acquiring the
 * inner lock can wait, and a capability that was live when this was called can
 * be gone by the time the lock is won. Checking only up front would authorize
 * an actuator on evidence that has since expired.
 */
export async function withDesktopAttemptMutation<T>(
  capability: UpdateMutationCapability,
  options: WithDesktopUpdateSegmentOptions,
  run: (cliLock: DesktopCliLockHandle) => Promise<T>,
): Promise<T> {
  await requireLiveDesktopCapability(capability, options.hostHomeDir);
  const outcome = await withDesktopCliLock(
    {
      lockPath: options.lockPath,
      reason: options.reason,
      waitMs: options.waitMs,
      pollIntervalMs: options.pollIntervalMs,
    },
    async (cliLock) => {
      await requireLiveDesktopCapability(capability, options.hostHomeDir);
      return run(cliLock);
    },
  );
  if (outcome.kind === "busy") {
    throw new DesktopCliLockBusyError(outcome.holder);
  }
  return outcome.result;
}

async function requireLiveDesktopCapability(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
): Promise<void> {
  const verdict = await verifyUpdateMutationCapability(capability, hostHomeDir);
  if (verdict.kind !== "live") {
    throw new DesktopAttemptCapabilityError(verdict.kind);
  }
}

function mapDesktopSegmentOutcome<T>(
  outcome: UpdateContenderOutcome<DesktopSegmentInnerResult<T>>,
): DesktopUpdateContenderOutcome<T> {
  switch (outcome.kind) {
    case "ran":
      if (outcome.result.kind === "capability-not-live") {
        return {
          kind: "capability-not-live",
          verdict: outcome.result.verdict,
        };
      }
      if (outcome.result.kind === "cli-lock-busy") {
        return { kind: "busy", source: "cli", holder: outcome.result.holder };
      }
      return { kind: "acquired", result: outcome.result.result };
    case "busy":
    case "held-in-process":
      return { kind: "busy", source: "attempt", holder: outcome.holder };
    case "nonterminal-attempt":
      return outcome;
    case "record-fail-closed":
      return { kind: "record-fail-closed", record: outcome.record };
    case "lock-not-live":
      return { kind: "capability-not-live", verdict: outcome.verdict.kind };
  }
}

function mapDesktopContenderOutcome<T>(
  outcome: UpdateContenderOutcome<
    WithDesktopCliLockOutcome<DesktopInnerResult<T>>
  >,
): DesktopUpdateContenderOutcome<T> {
  switch (outcome.kind) {
    case "ran":
      if (outcome.result.kind === "busy") {
        return { kind: "busy", source: "cli", holder: outcome.result.holder };
      }
      if (outcome.result.result.kind === "capability-not-live") {
        return {
          kind: "capability-not-live",
          verdict: outcome.result.result.verdict,
        };
      }
      return { kind: "acquired", result: outcome.result.result.result };
    case "busy":
    case "held-in-process":
      return { kind: "busy", source: "attempt", holder: outcome.holder };
    case "nonterminal-attempt":
      return outcome;
    case "record-fail-closed":
      return { kind: "record-fail-closed", record: outcome.record };
    case "lock-not-live":
      return { kind: "capability-not-live", verdict: outcome.verdict.kind };
  }
}
