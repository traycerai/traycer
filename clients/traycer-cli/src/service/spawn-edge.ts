import { AsyncLocalStorage } from "node:async_hooks";
import { cliError, type CliError, type CliErrorCode } from "../runner/errors";
import { didServiceRegistrationCommit } from "./cli-invocation-record";
import {
  isServiceMutationAuthorityError,
  verifyServiceMutationAuthority,
} from "./mutation-authority";

/**
 * The spawn edge: the point inside a platform controller immediately before
 * the one call that can make the OS service manager launch a supervisor -
 * macOS `launchctl bootstrap` (RunAtLoad) and `kickstart` / `kickstart -k`,
 * Linux `systemctl enable --now` / `start` / `restart`, Windows `schtasks
 * /Run`. Every such call awaits {@link atServiceSpawnEdge} first; nothing else
 * does. Calls that only stop, signal, read or register without launching
 * (`bootout`, `print`, `launchctl kill`, `systemctl stop` / `kill` /
 * `daemon-reload`, `schtasks /Create` / `/End` / `/Query`) are not edges.
 *
 * Same request-scoped shape as `mutation-authority.ts`: a facade arms a hook
 * once around a controller call, and the controller never learns what the hook
 * does. Outside an armed scope the edge is a no-op, so a bare controller call
 * behaves exactly as before.
 */
const spawnEdgeHook = new AsyncLocalStorage<() => Promise<void>>();

/**
 * Publication failures that nothing has yet turned into an operator report.
 * Identity-keyed like the mutation-authority failures, so a caller further out
 * that KNOWS what state the refusal left (it stopped the host itself) can
 * report it, and one that does not propagates it as itself.
 */
const unreportedRefusals = new WeakSet<object>();

export async function atServiceSpawnEdge(): Promise<void> {
  const hook = spawnEdgeHook.getStore();
  if (hook === undefined) return;
  await hook();
}

/**
 * Whether `error` is a publication refused at a spawn edge that no layer has
 * reported yet. An authority loss is never one: that is its own hard stop.
 */
export function isUnreportedSpawnEdgeRefusal(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && unreportedRefusals.has(error)
  );
}

/**
 * What a controller call - or the caller around it - has done by the time a
 * spawn edge can refuse, and so what a refusal there must undo and tell the
 * operator.
 */
export interface RefusedSpawnEdgeReport {
  readonly code: CliErrorCode;
  /** Names the call and its target: "service install for 'ai.traycer.host'". */
  readonly operation: string;
  /** Undoes what the call wrote before the edge; `null` if it wrote nothing. */
  readonly rollBack: (() => Promise<void>) | null;
  /** The state the refusal leaves (after a successful rollback), as a sentence. */
  readonly leaves: string;
  /** The command that brings the host back, as a sentence. */
  readonly recovery: string;
}

/**
 * The operator error for a refused publication: what was refused, the state it
 * leaves - not registered, or stopped - and the command that brings the host
 * back. The refusal travels in `details.cause`.
 */
export function refusedSpawnEdgeError(
  refusal: unknown,
  report: RefusedSpawnEdgeReport,
  rollBackFailure: string | null,
): CliError {
  const state =
    rollBackFailure === null
      ? report.leaves
      : `Undoing what it wrote before the launch failed too (${rollBackFailure}), so its registration may be half-written.`;
  return cliError({
    code: report.code,
    message: `${report.operation}: the host-start grant could not be published (${describeRefusal(refusal)}), so no start was requested. ${state} ${report.recovery}`,
    details: { cause: describeRefusal(refusal), rollBackFailure },
    exitCode: 1,
  });
}

/**
 * {@link atServiceSpawnEdge} for a call whose first edge comes AFTER it has
 * already changed something - registered the service (every install), or
 * stopped the host (the Windows restart ladder). Publishing at the edge makes
 * a refusal there a new stopping point, after that work, so it is not
 * reported as a bare publication error:
 *
 *  - what the call wrote is rolled back (best effort). A registration left
 *    behind is not inert: launchd loads a LaunchAgents plist at the next
 *    login, Task Scheduler runs a task at the next logon, and systemd starts
 *    an enabled unit - the reason Linux's `installService` already rolls
 *    back a failed `enable --now`;
 *  - the error says what state that leaves and names the command that
 *    brings the host back (`refusedSpawnEdgeError`).
 *
 * Not for an authority loss, which is rethrown as itself. That is a hard stop
 * callers classify by identity: every rollback write would be refused by the
 * same check, recovery belongs to whoever holds the authority now, and the
 * state it leaves is exactly what the controller's own per-command check in
 * front of the spawn call already leaves. A rollback that itself loses the
 * authority surfaces that loss instead, the harder of the two stops.
 */
export async function atServiceSpawnEdgeReporting(
  report: RefusedSpawnEdgeReport,
): Promise<void> {
  try {
    await atServiceSpawnEdge();
  } catch (refusal) {
    if (isServiceMutationAuthorityError(refusal)) throw refusal;
    let rollBackFailure: string | null = null;
    if (report.rollBack !== null) {
      try {
        await report.rollBack();
      } catch (cause) {
        if (isServiceMutationAuthorityError(cause)) throw cause;
        rollBackFailure = describeRefusal(cause);
      }
    }
    throw refusedSpawnEdgeError(refusal, report, rollBackFailure);
  }
}

function describeRefusal(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** What the lease-publishing facades hand back from their publisher. */
export interface ServiceSpawnEdgeLease {
  waitForSpawn(): Promise<void>;
  cancel(): Promise<void>;
}

/**
 * Run `start` (one service-controller call) with `publish` armed at its
 * spawn edges, then hold the published lease through the child's spawn.
 *
 * `publish` runs ONCE, at the first edge the call reaches, and before that
 * edge's spawn-triggering call is issued - so a supervisor the call launches
 * can never arrive ahead of its grant. A call that reaches several edges (the
 * macOS bootstrap-reload race bootstraps twice and then kickstarts) shares the
 * one lease: later edges await the same publication, and a publication that
 * failed fails them too, so no edge ever launches ungranted inside a scope
 * that was meant to grant.
 *
 * Publishing at the edge rather than before the call is what makes the
 * grant's age bound derivable: everything the call does before its first
 * edge - probes, a Desktop host's cooperative stand-down, the Windows stop
 * ladder - no longer runs on the grant's clock.
 *
 * A call that reaches no edge publishes nothing, waits for nothing and cancels
 * nothing; its error, if any, propagates unchanged.
 */
export async function runWithLeaseAtServiceSpawnEdge(
  publish: () => Promise<ServiceSpawnEdgeLease | null>,
  start: () => Promise<void>,
): Promise<void> {
  // A holder rather than a `let`: the lease is assigned inside the hook, which
  // control-flow narrowing cannot see.
  const held: { lease: ServiceSpawnEdgeLease | null } = { lease: null };
  let publication: Promise<void> | null = null;
  const hook = (): Promise<void> => {
    publication ??= (async () => {
      // A capability lost before the edge is reported as the authority loss
      // it is - the same refusal the controller's own check in front of the
      // spawn call would give - rather than as a publication failure.
      await verifyServiceMutationAuthority();
      try {
        held.lease = await publish();
      } catch (refusal) {
        if (
          !isServiceMutationAuthorityError(refusal) &&
          typeof refusal === "object" &&
          refusal !== null
        ) {
          unreportedRefusals.add(refusal);
        }
        throw refusal;
      }
      // Publishing can take long enough for a released or forged capability
      // to surface. Revalidate at the edge itself, AFTER the lease is held, so
      // a refusal here still reaches the `finally` that cancels it.
      await verifyServiceMutationAuthority();
    })();
    return publication;
  };
  try {
    await spawnEdgeHook.run(hook, start);
    await held.lease?.waitForSpawn();
  } catch (error) {
    // A record-step failure after the service manager accepted the
    // registration means the supervisor is already launching and will present
    // this lease; cancelling first would refuse an admitted child. Honour the
    // lease, then surface the record error unchanged (a failed wait must not
    // replace it - see the cleanup rule below).
    if (didServiceRegistrationCommit(error)) {
      await held.lease?.waitForSpawn().catch(() => undefined);
    }
    throw error;
  } finally {
    // Cleanup must never replace the actuator error: callers classify it to
    // choose between park/abort and an ordinary busy refusal, and a rejected
    // cancel() propagating out of this `finally` would swap in its own error.
    await held.lease?.cancel().catch(() => undefined);
  }
}
