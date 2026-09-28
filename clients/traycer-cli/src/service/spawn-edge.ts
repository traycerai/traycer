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
 * Every install has one more edge, in front of its first write
 * ({@link atServiceInstallEdge}), so a publication an install cannot make
 * touches nothing.
 *
 * Same request-scoped shape as `mutation-authority.ts`: a facade arms a hook
 * once around a controller call, and the controller never learns what the hook
 * does. Outside an armed scope the edge is a no-op, so a bare controller call
 * behaves exactly as before. The bounds each path runs on after its first edge
 * are in `spawn-edge-bounds.ts`.
 */
const spawnEdgeHook = new AsyncLocalStorage<() => Promise<void>>();

/**
 * Whether the call inside a lease scope withdrew its publication: see
 * {@link withdrawServiceSpawnEdge}. One holder per scope, set by the call and
 * read by the scope once the call returns.
 */
const spawnEdgeWithdrawal = new AsyncLocalStorage<{ withdrawn: boolean }>();

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
 * An install's FIRST edge, awaited in front of its first write rather than its
 * first launch: before macOS writes the launcher and plist (and boots out a
 * loaded registration), before Linux writes the unit, before Windows writes
 * the launcher and `/Create`s the task. A publication refused here has touched
 * nothing - the previous registration, and a host it runs, stay exactly as
 * they were - so the refusal propagates as itself and nothing is rolled back.
 * The install's spawn edges after it return the same publication.
 *
 * That costs the grant's clock the install's own registration calls (the
 * bare `bootout`, `daemon-reload`, `/Create`), which each platform's install
 * bound counts (`spawn-edge-bounds.ts`).
 */
export async function atServiceInstallEdge(): Promise<void> {
  await atServiceSpawnEdge();
}

/**
 * The call published at an edge and then, finding it will launch nothing after
 * all, returns without one: the enclosing lease scope cancels the lease
 * instead of waiting its whole acknowledgement window for a supervisor that
 * is not coming. Outside a scope it does nothing.
 *
 * One caller: a Windows install whose confirm-read found the task disabled by
 * its owner DURING staging. The install edge had already published - it sits
 * in front of the first write, and the disable landed after it - and a
 * disabled task refuses `/Run`, so the install ends as a carried-over disable
 * does: registered, not started, reported kept-disabled. A call that returns
 * normally is otherwise read as "a child is coming" and waited for.
 */
export function withdrawServiceSpawnEdge(): void {
  const scope = spawnEdgeWithdrawal.getStore();
  if (scope !== undefined) scope.withdrawn = true;
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
 * What a call had already done to the host by the time its spawn edge
 * refused, and so what the operator has to be told.
 */
export interface RefusedSpawnEdgeReport {
  readonly code: CliErrorCode;
  /** Names the call and its target: "start of 'Traycer Host' after its stop". */
  readonly operation: string;
  /** The state the refusal leaves, as a sentence. */
  readonly leaves: string;
  /** The command that brings the host back, as a sentence. */
  readonly recovery: string;
}

/**
 * The operator error for a refused publication: what was refused, the state it
 * leaves, and the command that brings the host back. The refusal travels in
 * `details.cause`.
 */
export function refusedSpawnEdgeError(
  refusal: unknown,
  report: RefusedSpawnEdgeReport,
): CliError {
  return cliError({
    code: report.code,
    message: `${report.operation}: the host-start grant could not be published (${describeRefusal(refusal)}), so no start was requested. ${report.leaves} ${report.recovery}`,
    details: { cause: describeRefusal(refusal) },
    exitCode: 1,
  });
}

/**
 * {@link atServiceSpawnEdge} for a start that follows the caller's own stop -
 * the Windows restart ladder, and a relaunch after a stop. Publishing at the
 * edge makes a refusal there a stopping point AFTER the host was stopped, so
 * it is reported with the state that leaves and the command that brings the
 * host back (`refusedSpawnEdgeError`), not as a bare publication error. It
 * writes nothing before its edge, so there is nothing to roll back.
 *
 * Not for an authority loss, which is rethrown as itself: a hard stop callers
 * classify by identity, and the state it leaves is exactly what the
 * controller's own per-command check in front of the spawn call already
 * leaves.
 */
export async function atServiceSpawnEdgeReporting(
  report: RefusedSpawnEdgeReport,
): Promise<void> {
  try {
    await atServiceSpawnEdge();
  } catch (refusal) {
    if (isServiceMutationAuthorityError(refusal)) throw refusal;
    throw refusedSpawnEdgeError(refusal, report);
  }
}

function describeRefusal(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** What the lease-publishing facades hand back from their publisher. */
export interface ServiceSpawnEdgeLease {
  /**
   * Resolves once the launched supervisor acknowledged the grant; rejects with
   * {@link SpawnAcknowledgementTimeoutError} when none did in time.
   */
  waitForSpawn(): Promise<void>;
  cancel(): Promise<void>;
}

/**
 * No supervisor acknowledged a published grant in time. Its own class so the
 * start paths that may try again (`isUnacknowledgedSpawn`, read by
 * `startRetryingUnacknowledged` in `host/update-mutation.ts`) can tell it
 * from every other start failure.
 */
export class SpawnAcknowledgementTimeoutError extends Error {
  constructor() {
    super("host-start supervisor did not acknowledge its spawn");
    this.name = "SpawnAcknowledgementTimeoutError";
  }
}

/**
 * Post-registration failures whose lease then waited the ack out in vain
 * (see the catch in {@link runWithLeaseAtServiceSpawnEdge}). Identity-keyed,
 * like the refusals above, so the error itself propagates unchanged.
 */
const unacknowledgedSpawns = new WeakSet<object>();

/**
 * Whether `error` ended a call whose published grant no supervisor
 * acknowledged: the ack wait's own timeout, or a failure after the service
 * manager accepted the call - the Windows `/Run` whose spawn evidence never
 * came - whose lease then waited the ack out without one.
 */
export function isUnacknowledgedSpawn(error: unknown): boolean {
  if (error instanceof SpawnAcknowledgementTimeoutError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    unacknowledgedSpawns.has(error)
  );
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
 * ladder - no longer runs on the grant's clock. An install's first edge is its
 * install edge, in front of its first write, so a refused publication never
 * leaves an install half-done.
 *
 * A call that reaches no edge publishes nothing, waits for nothing and cancels
 * nothing; its error, if any, propagates unchanged. A call that published and
 * then withdrew (`withdrawServiceSpawnEdge`) waits for nothing either: its
 * lease is cancelled.
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
  const withdrawal = { withdrawn: false };
  try {
    await spawnEdgeHook.run(hook, () =>
      spawnEdgeWithdrawal.run(withdrawal, start),
    );
    // A withdrawn publication has no child coming: the `finally` below
    // cancels the lease without this wait ever being entered.
    if (!withdrawal.withdrawn) await held.lease?.waitForSpawn();
  } catch (error) {
    // A record-step failure after the service manager accepted the
    // registration means the supervisor is already launching and will present
    // this lease; cancelling first would refuse an admitted child. Honour the
    // lease, then surface the record error unchanged (a failed wait must not
    // replace it - see the cleanup rule below). Unless the call withdrew its
    // publication first: what it registered launches nothing (a disabled
    // task), so no child is coming whatever failed after the registration.
    if (didServiceRegistrationCommit(error) && !withdrawal.withdrawn) {
      await held.lease?.waitForSpawn().catch((waited: unknown) => {
        if (
          waited instanceof SpawnAcknowledgementTimeoutError &&
          typeof error === "object" &&
          error !== null
        ) {
          unacknowledgedSpawns.add(error);
        }
      });
    }
    throw error;
  } finally {
    // Cleanup must never replace the actuator error: callers classify it to
    // choose between park/abort and an ordinary busy refusal, and a rejected
    // cancel() propagating out of this `finally` would swap in its own error.
    await held.lease?.cancel().catch(() => undefined);
  }
}
