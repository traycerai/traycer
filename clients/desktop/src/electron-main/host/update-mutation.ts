import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createUpdateMutationCapabilityAdoption,
  verifyUpdateMutationCapability,
  writeAdoptionProof,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import {
  registerHostLoginItem,
  retireCompetingCliRegistrationAtLaunchGuarded,
  unregisterHostLoginItemGuarded,
  type LaunchCompetingRegistrationRepair,
  type RegisterHostLoginItemResult,
} from "../app/host-login-item";
import {
  hostStopIntentPath,
  type StopIntent,
} from "@traycer/protocol/config/host-stop-intent";
import type { HostServiceSubstrate } from "./host-owner";
import type { HostFsLayout } from "./host-paths";
import { SUBSTRATE_RECORD_WRITE_VERSION } from "@traycer-clients/shared/host-lifecycle";

export class DesktopAttemptCapabilityError extends Error {
  readonly verdict: string;

  constructor(verdict: string) {
    super("desktop update attempt capability is not live");
    this.verdict = verdict;
  }
}

async function requireLiveCapability(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
): Promise<void> {
  const verdict = await verifyUpdateMutationCapability(capability, hostHomeDir);
  if (verdict.kind !== "live") {
    throw new DesktopAttemptCapabilityError(verdict.kind);
  }
}

/**
 * Capability-consuming SMAppService registration. The existing registration
 * function invokes our predicate immediately before its bootout, so a stale
 * capability cannot get as far as the destructive side of the cycle.
 */
export async function registerHostLoginItemWithAttempt(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
  revalidateBeforeBootout: () => Promise<boolean>,
): Promise<RegisterHostLoginItemResult> {
  await requireLiveCapability(capability, hostHomeDir);
  const result = await registerHostLoginItem(async () => {
    const verdict = await verifyUpdateMutationCapability(
      capability,
      hostHomeDir,
    );
    return verdict.kind === "live" && (await revalidateBeforeBootout());
  });
  await requireLiveCapability(capability, hostHomeDir);
  return result;
}

/** Capability-consuming SMAppService deregistration/bootout. */
export async function unregisterHostLoginItemWithAttempt(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
): Promise<void> {
  await requireLiveCapability(capability, hostHomeDir);
  const ran = await unregisterHostLoginItemGuarded(async () => {
    const verdict = await verifyUpdateMutationCapability(
      capability,
      hostHomeDir,
    );
    return verdict.kind === "live";
  });
  if (!ran) {
    const verdict = await verifyUpdateMutationCapability(
      capability,
      hostHomeDir,
    );
    throw new DesktopAttemptCapabilityError(
      verdict.kind === "live" ? "indeterminate" : verdict.kind,
    );
  }
  await requireLiveCapability(capability, hostHomeDir);
}

/**
 * The durable schema `substrate.json` carries. `v` is the version gate the
 * shared decoder reads; the shape must stay byte-compatible with
 * `SubstrateRecord` (`@traycer-clients/shared/host-lifecycle`), which is the
 * only decoder either side uses. The version comes FROM that module — a
 * local literal here could emit a `v` the decoder's supported list no
 * longer accepts, and the host would then reject every `substrate.json`
 * this writer produced.
 */
const SUBSTRATE_RECORD_VERSION = SUBSTRATE_RECORD_WRITE_VERSION;

/**
 * The record shape and its path both come from `@traycer/protocol/config`,
 * never from a literal here. That module exists precisely because two repos
 * must resolve the same file and agree on the same bytes: the host reads this
 * record with its own parser, and a filename duplicated on this side is a
 * second source of truth that drifts silently the first time either moves.
 */
const STOP_INTENT_VERSION = 1;

export type RestartTombstoneOutcome =
  | { readonly kind: "published" }
  /**
   * The record did not durably land. The caller MUST NOT boot out: without it
   * the host cannot tell this teardown from death, and every other client
   * fails over on an outage that was going to last seconds.
   */
  | { readonly kind: "not-published"; readonly cause: string };

/**
 * The publish budget for the restart tombstone.
 *
 * Deliberately far below the reader's `EXTERNAL_RESTART_INTENT_FRESH_MS` (30s)
 * acceptance window: a marker that consumes most of its own freshness while
 * being flushed is useless to the host that has to read it after teardown.
 */
const TOMBSTONE_FLUSH_DEADLINE_MS = 5_000;

/**
 * Why the flush did not publish - as three distinct facts, not one boolean.
 *
 * Collapsing "the disk rejected the write" into the same `false` as "the
 * deadline expired" made every immediate `EIO`/`ENOSPC`/permission failure
 * durable as `restart tombstone flush exceeded 5000ms`. That text is not a
 * summary of the failure, it is a DIFFERENT failure: it sends an operator
 * reading the terminal attempt record toward latency and lock contention while
 * the actual fault is a full or failing disk.
 *
 * A boolean cannot carry a cause, so the cause had to be invented at the call
 * site. That is the shape of the bug, and it is why the fix is a discriminated
 * outcome rather than a better string.
 */
type FlushOutcome =
  | { readonly kind: "flushed" }
  /** `sync()` rejected - `cause` is the real error, never a fabricated one. */
  | { readonly kind: "rejected"; readonly cause: string }
  /** Still pending at the deadline. The only arm that may claim a timeout. */
  | { readonly kind: "expired" };

/**
 * Resolve how the flush ended, within the budget.
 *
 * The losing `sync()` is deliberately left unawaited rather than cancelled -
 * an in-flight `fsync` cannot be cancelled, and the alternative (awaiting it)
 * is the unbounded hold this exists to prevent.
 *
 * CAVEAT THE CALLER MUST HONOUR, and the reason this is spelled out here: a
 * deadline on the sync alone bounds NOTHING if the caller then awaits
 * `handle.close()`. `FileHandle.close()` waits for pending operations on the
 * handle, so awaiting it transitively awaits the very `fsync` this raced. An
 * earlier version of this comment claimed the caller's `finally` avoided that
 * - the opposite of Node's documented contract. On deadline loss the caller
 * MUST detach the close (`void handle.close()`), not await it.
 */
async function withFlushDeadline(flush: Promise<void>): Promise<FlushOutcome> {
  let timer: NodeJS.Timeout | null = null;
  const expiry = new Promise<FlushOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "expired" }),
      TOMBSTONE_FLUSH_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([
      // The handler is attached BEFORE the race, so a rejection that arrives
      // after the deadline already won is still consumed here rather than
      // surfacing as an unhandled rejection.
      flush
        .then((): FlushOutcome => ({ kind: "flushed" }))
        .catch((err: unknown): FlushOutcome => ({
          kind: "rejected",
          cause: describeFlushError(err),
        })),
      expiry,
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * The error's own message, never a substitute for it.
 *
 * A non-`Error` throw still yields SOMETHING specific to what happened;
 * `String(err)` on a plain object is uninformative but honest, which is the
 * property that matters in a durable diagnostic.
 */
function describeFlushError(err: unknown): string {
  if (err instanceof Error) {
    const code = Reflect.get(err, "code");
    return typeof code === "string" ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

/**
 * Publish the expected-restart tombstone immediately before a Desktop-owned
 * SMAppService bootout, and flush it.
 *
 * ## What this closes
 *
 * `stop-intent.json` is how a host answers "is the SIGTERM I am handling the
 * stop half of a deliberate restart?" - it reads the record at teardown and
 * publishes `restarting-expected` to every connected client
 * (`traycer-host/src/lifecycle/external-restart-intent.ts`). The CLI writes it
 * before every kill it performs. **Desktop's bootout never has**: it goes
 * through `launchctl bootout` and Electron's `setLoginItemSettings`, with no
 * CLI leg to carry the intent. So every Desktop-owned activation to date has
 * presented to other windows as death -> failover -> recovery.
 *
 * ## `restart`, not `install-swap`
 *
 * `install-swap` deliberately promises no comeback, because a CLI swap's
 * relaunch is unbounded. Desktop activation is the other case: it boots out and
 * immediately re-registers, so it does promise a supervised relaunch, and
 * `restart` is the honest reason even though an update triggered it.
 *
 * ## Why the flush is bounded and why failure is not "best effort"
 *
 * The host only honours a record inside a 30s freshness window, so the write
 * must be adjacent to the bootout rather than merely earlier than it. And an
 * unflushed record is indistinguishable from an absent one to the reader, so a
 * write this function could not confirm is reported as `not-published` rather
 * than shrugged off - the activation returns to a truthful parked state
 * instead of tearing the host down with no tombstone behind it.
 */
export async function publishRestartTombstoneWithAttempt(
  capability: UpdateMutationCapability,
  layout: HostFsLayout,
): Promise<RestartTombstoneOutcome> {
  await requireLiveCapability(capability, layout.rootDir);
  const target = hostStopIntentPath(layout.rootDir);
  const temp = join(
    layout.rootDir,
    `.stop-intent.${process.pid}.${Date.now()}.tmp`,
  );
  // Stamped ONCE, before the write, and reused by the post-flush freshness
  // check so the two cannot drift.
  const requestedAtMs = Date.now();
  try {
    await mkdir(layout.rootDir, { recursive: true });
    const handle = await open(temp, "w", 0o600);
    // Tracks whether the deadline arm already detached the close.
    let closed = false;
    try {
      // Typed against the protocol contract, so a field the host's parser
      // requires cannot be dropped here without a compile error.
      const intent: StopIntent = {
        v: STOP_INTENT_VERSION,
        requestedAt: new Date(requestedAtMs).toISOString(),
        requestedByPid: process.pid,
        reason: "restart",
      };
      await handle.writeFile(`${JSON.stringify(intent)}\n`, "utf8");
      // The durability barrier the contract needs. A rename publishes the
      // name; it does not promise the bytes behind it survived, and the
      // reader of this record is a process that starts after a teardown.
      //
      // BOUNDED, and both halves of the bound are load-bearing:
      //
      //  - Without a deadline, an `fsync` that never resolves leaves the
      //    executor holding the attempt lock in `restarting` FOREVER, so every
      //    later updater and restart contender sees a live busy owner. That is
      //    the original stuck-updating failure class - rebuilt inside the
      //    rebuild that exists to eliminate it.
      //  - A slow-but-successful sync is just as wrong in the other direction:
      //    `requestedAt` was stamped before the flush, so a sync that outlives
      //    the reader's freshness window publishes an ALREADY-STALE marker.
      //    The terminating host then rejects it and reports ordinary death,
      //    and every client fails over on what was a planned restart.
      const flush = await withFlushDeadline(handle.sync());
      if (flush.kind !== "flushed") {
        // ---- DETACH the close. Awaiting it re-creates the unbounded hold.
        //
        // `FileHandle.close()` waits for pending operations on that handle
        // (Node's documented contract). So the previous shape - race the sync,
        // then `finally { await handle.close() }` - only changed WHICH promise
        // was awaited, not how long the segment was held: an `fsync` that never
        // settles was still awaited, transitively, inside `close()`. The
        // deadline was decorative and the attempt lock stayed live in
        // `restarting` forever. That is the stuck-updating class this epic
        // exists to remove, rebuilt inside the removal.
        //
        // Why the detached settlement cannot resurrect anything, reasoned
        // rather than assumed:
        //  - `rename(temp, target)` is never reached on this arm, so the
        //    PUBLISHED path is never written. A late sync flushes bytes to
        //    `temp`, which no reader ever looks at.
        //  - `temp` is unlinked immediately below. On POSIX the unlink
        //    succeeds while the descriptor is open, and a late `fsync` then
        //    flushes to an inode with no directory entry - inert by
        //    construction, and reclaimed when the descriptor closes.
        //  - The freshness re-check and the capability re-check both sit after
        //    this return, so a late success cannot re-enter the publish path.
        void handle.close().catch(() => undefined);
        closed = true;
        // Finding 6: this arm returns past the outer `catch`, so it must do
        // its own cleanup or it leaks a `.stop-intent.<pid>.<time>.tmp` on
        // every flush failure - which the reviewer reproduced.
        await rm(temp, { force: true }).catch(() => undefined);
        return {
          kind: "not-published",
          // Only the `expired` arm may claim a timeout. A rejection reports
          // what the filesystem actually said, because this string is what a
          // terminal attempt record persists and an operator reads.
          cause:
            flush.kind === "rejected"
              ? `restart tombstone flush failed: ${flush.cause}`
              : `restart tombstone flush exceeded ${TOMBSTONE_FLUSH_DEADLINE_MS}ms`,
        };
      }
    } finally {
      // Only when the deadline did NOT expire. On the detached arm the handle
      // is already closing and awaiting it here would restore the hold.
      if (!closed) await handle.close();
    }
    // Re-check freshness AFTER the flush resolved. Publishing a marker the
    // reader will discard is worse than not publishing: the caller would treat
    // it as a kept promise and proceed to bootout.
    //
    // SYMMETRIC, like the host-start adoption expiry: the reader's
    // `isStopIntentWithin` applies an absolute window, so a marker made
    // FUTURE-dated by a backward clock step is just as discarded as a stale
    // one — and a signed check here (negative age passes) would publish
    // exactly that marker, then bootout on the strength of it.
    const ageMs = Math.abs(Date.now() - requestedAtMs);
    if (ageMs > TOMBSTONE_FLUSH_DEADLINE_MS) {
      // THE SECOND early return past the outer `catch`, and it needs the same
      // cleanup the flush-failure arm above got for Finding 6. That fix was
      // applied to the arm the reviewer reproduced; this one has the identical
      // shape — a `return` from inside the `try`, so the `catch` that unlinks
      // `temp` never runs — and the temp name carries a pid and a timestamp, so
      // every stale-flush leaves a NEW `.stop-intent.<pid>.<time>.tmp` rather
      // than overwriting the last one. A host that keeps missing the freshness
      // window accumulates one per restart attempt, forever.
      await rm(temp, { force: true }).catch(() => undefined);
      return {
        kind: "not-published",
        cause: `restart tombstone went stale during flush (${ageMs}ms)`,
      };
    }
    await requireLiveCapability(capability, layout.rootDir);
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    return {
      kind: "not-published",
      cause: err instanceof Error ? err.message : String(err),
    };
  }
  return { kind: "published" };
}

/**
 * Run a bundled-CLI invocation as an adopted child of this held segment.
 *
 * ## The problem this exists for
 *
 * A packaged-macOS executor holds `update-attempt.lock` for its whole segment,
 * but the steps it performs — `host apply --no-service`, `host install`,
 * `host ensure`, `host stamp-runtime`, `host service install --takeover` — are
 * bundled-CLI children that each call `withUpdateContender` themselves. A child
 * that tries to ACQUIRE deadlocks against its own parent, waits out the lock
 * timeout, and fails the segment that spawned it.
 *
 * So the child validates instead of acquiring: it is handed a nonce naming a
 * proof that this parent still holds the lock, and the shared verifier
 * re-checks that proof against the live lock — identity AND an uncached
 * liveness probe — at every mutation edge.
 *
 * ## Minting is composed here, not delegated
 *
 * `createUpdateMutationCapabilityAdoption` throws unless the capability is live
 * and still owns the lock on disk, so a proof cannot be minted from a released
 * or forged capability. Composing it with `writeAdoptionProof` at the call site
 * (rather than inside the transport) is what keeps that transport free of any
 * reference to the capability module, and therefore out of its pinned importer
 * set.
 *
 * ## The proof does not outlive the call
 *
 * `cancel()` runs in `finally`. The proof is age-bounded and consumed on read
 * anyway, but an unconsumed one — a spawn that failed, a child that exited
 * before reading it — must not sit in the host home waiting to be found. The
 * argv fragment carries only the nonce; the parent's lock token never reaches
 * a command line, which `ps` exposes.
 */
export async function withMintedAdoption<T>(
  capability: UpdateMutationCapability,
  layout: HostFsLayout,
  run: (adoptionArgs: readonly string[]) => Promise<T>,
): Promise<T> {
  await requireLiveCapability(capability, layout.rootDir);
  const adoption = await createUpdateMutationCapabilityAdoption(
    capability,
    layout.rootDir,
  );
  const proof = await writeAdoptionProof(adoption, layout.rootDir, Date.now());
  try {
    return await run(["--attempt-adoption", proof.nonce]);
  } finally {
    await proof.cancel();
  }
}

/**
 * Withdraw a tombstone whose promised bootout did not happen.
 *
 * Publishing one is a promise that this host is coming back in seconds. If the
 * SMAppService cycle then declines - a busy re-check inside the registration
 * lock, a failed register - the promise is false, and leaving it on disk makes
 * every connected client hold an expected-restart episode for a restart nobody
 * performed. §4: "retain diagnostics and explicitly close the expected-restart
 * episode rather than leaving selection held until expiry."
 *
 * Removing our own record is the writer's prerogative and mirrors the CLI's
 * `clearStopIntent`. The prohibition on writing this file binds the HOST, which
 * is strictly a reader of it.
 *
 * Best-effort by design: the record self-expires after 30s, so a failed
 * withdrawal costs one bounded stale episode, whereas throwing here would mask
 * the activation failure that is the actual news.
 */
export async function clearRestartTombstoneWithAttempt(
  capability: UpdateMutationCapability,
  layout: HostFsLayout,
): Promise<void> {
  await requireLiveCapability(capability, layout.rootDir);
  await rm(hostStopIntentPath(layout.rootDir), { force: true }).catch(
    () => undefined,
  );
}

/**
 * Capability-consuming write of the current service-registration owner.
 *
 * Desktop is the named writer for `smappservice` (the CLI writes
 * `raw-fallback`, and only after a positively attested takeover). The write
 * is temp+rename so a reader never observes a half-record - the shared
 * decoder is total, but a torn read would resolve to `corrupt`, and `corrupt`
 * is a fail-closed `unknown` rather than a harmless retry.
 *
 * Ownership is a durable fact about the machine, so the capability is
 * re-verified immediately before the rename that publishes it and again after
 * - the same discipline as every other edge in this module. A capability lost
 * while the temp file was being written must not publish an ownership claim
 * on behalf of a segment that no longer exists.
 */
export async function writeSubstrateOwnerWithAttempt(
  capability: UpdateMutationCapability,
  layout: HostFsLayout,
  active: HostServiceSubstrate,
  reason: string,
): Promise<void> {
  await requireLiveCapability(capability, layout.rootDir);
  const target = layout.substrateFile;
  const temp = join(
    dirname(target),
    `.substrate.${process.pid}.${Date.now()}.tmp`,
  );
  await mkdir(dirname(target), { recursive: true });
  // Cleaned up on EVERY failing exit, matching `stampUpdateDispatchAck` and
  // `lifecycle-probe`'s writer. The capability re-check between the write and
  // the rename is the throw that matters: losing the capability there is the
  // documented reason this function exists in this shape, so it is a path the
  // design EXPECTS to take, and it left `.substrate.<pid>.<time>.tmp` behind
  // every time. Launch-time backfill retries the publication, so those
  // accumulate in the host root — the name is unique per attempt, so nothing
  // ever overwrites an earlier one.
  try {
    await writeFile(
      temp,
      `${JSON.stringify({
        v: SUBSTRATE_RECORD_VERSION,
        active,
        since: new Date().toISOString(),
        reason,
        attestation: null,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await requireLiveCapability(capability, layout.rootDir);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await requireLiveCapability(capability, layout.rootDir);
}

/** Capability-consuming launch-time CLI-registration retirement. */
export async function retireCompetingCliRegistrationWithAttempt(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
): Promise<LaunchCompetingRegistrationRepair> {
  await requireLiveCapability(capability, hostHomeDir);
  const result = await retireCompetingCliRegistrationAtLaunchGuarded(
    async () => {
      const verdict = await verifyUpdateMutationCapability(
        capability,
        hostHomeDir,
      );
      return verdict.kind === "live";
    },
  );
  if (result === null) {
    const verdict = await verifyUpdateMutationCapability(
      capability,
      hostHomeDir,
    );
    throw new DesktopAttemptCapabilityError(
      verdict.kind === "live" ? "indeterminate" : verdict.kind,
    );
  }
  await requireLiveCapability(capability, hostHomeDir);
  return result;
}
