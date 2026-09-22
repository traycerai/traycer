import { randomUUID } from "node:crypto";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createUpdateMutationCapabilityAdoption,
  readRegularFileNoFollow,
  validateUpdateMutationCapabilityAdoption,
  type UpdateMutationCapability,
  type UpdateMutationCapabilityAdoption,
} from "@traycer-clients/shared/host-update";
import type { Environment } from "../runner/environment";
import { SYSTEMCTL_JOB_TIMEOUT_MS } from "../service/platforms/linux";
import {
  LAUNCHCTL_CALL_TIMEOUT_MS,
  LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS,
  LAUNCHCTL_RECYCLE_TIMEOUT_MS,
} from "../service/platforms/macos";
import { WINDOWS_RUN_SPAWN_EDGE_BOUND_MS } from "../service/platforms/windows";
import { hostHomeDir } from "../store/paths";
import type { WithCliUpdateContenderOptions } from "./update-contender";

const HOST_START_ADOPTION_FILENAME = ".host-start-adoption.json";

/**
 * What one CLI cold start of the service launcher may cost. The dev wrapper
 * exec's `bun src/index.ts`, and a bun cold start across ~2500 TS files "can
 * comfortably exceed 10s on a loaded laptop" (the reason `installService`'s
 * kickstart gets 30s in platforms/macos.ts); a packaged SEA takes about a
 * second. The bound is the dev one, so a slow machine is not a false refusal.
 */
const LAUNCHER_CLI_COLD_START_MS = 10_000;

/**
 * CLI cold starts between the OS manager launching the service launcher and
 * the supervisor consuming its grant, on the nonce-bearing path every launcher
 * takes (`buildHostStartLauncherScript`, Desktop's
 * `inject-host-launch-agent.cjs`, the Windows VBS): `host capabilities --has
 * service-label`, `host capabilities --has host-start-adoption-v2`, `host
 * adoption-nonce`, and `host start` itself.
 */
const LAUNCHER_CLI_COLD_STARTS = 4;

/**
 * From the supervisor's launch to its consume: 4 x 10s = 40s. The ONE source
 * for the launch cost, used by both the grant window and the parent's ack
 * wait below.
 */
export const SUPERVISOR_LAUNCH_MARGIN_MS =
  LAUNCHER_CLI_COLD_STARTS * LAUNCHER_CLI_COLD_START_MS;

/**
 * From the consume to the acknowledgement: the supervisor's target resolution,
 * its synchronous `spawn()` of the host, the parent-liveness re-check and the
 * acknowledgement write. Local work inside the process that already paid its
 * cold start.
 */
export const SUPERVISOR_SPAWN_ACK_MARGIN_MS = 10_000;

/**
 * The longest any controller call takes from its first spawn edge (where the
 * grant is published, `service/spawn-edge.ts`) to the launch of the supervisor
 * that consumes it: the max over every platform's spawn-edge bound.
 *
 *   macOS install (bootstrap-reload race, 3 edges)   80s  the max
 *   Linux start / restart / enable --now job         52s
 *   Windows `/Run` + spawn-evidence verify           45s
 *   macOS recycle (`kickstart -k`)                   40s
 *   macOS plain kickstart                            10s
 *
 * Everything a call does BEFORE its first edge - ownership probes, a Desktop
 * host's cooperative stand-down, the Windows stop ladder, `/Create` - is off
 * the grant's clock, which is what makes this bound finite at all.
 */
export const HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS = Math.max(
  LAUNCHCTL_INSTALL_SPAWN_EDGE_BOUND_MS,
  SYSTEMCTL_JOB_TIMEOUT_MS,
  WINDOWS_RUN_SPAWN_EDGE_BOUND_MS,
  LAUNCHCTL_RECYCLE_TIMEOUT_MS,
  LAUNCHCTL_CALL_TIMEOUT_MS,
);

/**
 * How long a published grant stays usable: 80s + 40s = 120s. Derived, not
 * chosen - the latest a supervisor can be launched after its grant was
 * published, plus what its launcher takes to consume it.
 *
 * It was 60s, and a longer window used to cost something: a proof whose
 * publisher died refused every nonce-less launch until it expired, so doubling
 * the window doubled that wedge. The consumer now reads a proof whose parent
 * capability is not live as absent on exactly those paths (see
 * `consumeHostStartAdoption`), so the window no longer bounds any refusal - it
 * bounds only how long a LIVE publisher's grant can wait for its child.
 */
export const HOST_START_ADOPTION_MAX_AGE_MS =
  HOST_START_ADOPTION_SPAWN_EDGE_BOUND_MS + SUPERVISOR_LAUNCH_MARGIN_MS;

// The ONE grant-expiry predicate, shared by every reader of `issuedAtMs`.
//
// Symmetric on purpose: `now - issuedAtMs > MAX_AGE` alone never fires for a
// FUTURE-dated timestamp (the difference is negative), so a proof written
// after a backwards clock step - or with a corrupted `issuedAtMs` - would
// read as an outstanding grant until the wall clock caught up, refusing
// every launch for that whole window. A publisher and consumer live on the
// same machine within one grant window of each other, so any timestamp more
// than that window AWAY from now, in either direction, is not a grant anyone
// can still use.
function adoptionGrantExpired(issuedAtMs: number): boolean {
  return Math.abs(Date.now() - issuedAtMs) > HOST_START_ADOPTION_MAX_AGE_MS;
}

/**
 * How long the parent waits, after its controller call returns, for the
 * supervisor to acknowledge its spawn: 40s + 10s = 50s. The call returns at or
 * after the launch, so this has to cover the whole launcher and the
 * supervisor's own spawn - and never be shorter than the launch margin the
 * window above already grants. It was 30s: a launch the window admitted could
 * miss it, and the parent then cancelled a child it had just started.
 */
export const HOST_START_ADOPTION_ACK_WAIT_MS =
  SUPERVISOR_LAUNCH_MARGIN_MS + SUPERVISOR_SPAWN_ACK_MARGIN_MS;
const HOST_START_ADOPTION_POLL_MS = 25;

// Test-only synchronization point for the exact read-then-claim race.  The
// production path leaves it null; exposing a timer-based race would make this
// one-shot-authority regression flaky instead of proving the atomic outcome.
let beforeHostStartAdoptionClaimHookForTest: (() => Promise<void>) | null =
  null;

// Runs directly before the no-follow adoption read.  The durable reader
// performs the descriptor validation itself; this seam merely makes a
// replacement-at-open regression deterministic rather than timing-sensitive.
let beforeHostStartAdoptionReadHookForTest: (() => Promise<void>) | null = null;

export function __setBeforeHostStartAdoptionClaimHookForTest(
  hook: (() => Promise<void>) | null,
): (() => Promise<void>) | null {
  const previous = beforeHostStartAdoptionClaimHookForTest;
  beforeHostStartAdoptionClaimHookForTest = hook;
  return previous;
}

export function __setBeforeHostStartAdoptionReadHookForTest(
  hook: (() => Promise<void>) | null,
): (() => Promise<void>) | null {
  const previous = beforeHostStartAdoptionReadHookForTest;
  beforeHostStartAdoptionReadHookForTest = hook;
  return previous;
}

type HostStartAdoptionFile = {
  readonly version: 2;
  readonly issuedAtMs: number;
  readonly nonce: string;
  /** The current service manifest's identity, never a hand-run start. */
  readonly serviceLabel: string;
  readonly adoption: UpdateMutationCapabilityAdoption;
};

type HostStartAdoptionAcknowledgement = {
  readonly version: 2;
  readonly nonce: string;
  readonly childPid: number;
};

export interface HostStartAdoptionLease {
  /**
   * Keeps the parent attempt capability held through the exact supervisor's
   * synchronous target resolution and `spawn()`. A service manager returning
   * from kickstart/enable is not sufficient evidence of that edge.
   */
  waitForSpawn(): Promise<void>;
  /** Remove an unclaimed proof after the service edge fails or times out. */
  cancel(): Promise<void>;
}

export interface HostStartAdoptionGrant {
  /**
   * Called only after the supervisor has synchronously spawned its selected
   * target. It repeats the parent-holder check before acknowledging, so a
   * parent release between claim and spawn kills the unadmitted child rather
   * than turning a point-in-time proof into authority.
   */
  acknowledgeSpawn(): Promise<boolean>;
  abandon(): Promise<void>;
}

export type HostStartAdoptionConsumeResult =
  | { readonly kind: "absent" }
  | { readonly kind: "grant"; readonly grant: HostStartAdoptionGrant }
  /** A concrete proof was observed, but another service child claimed it. */
  | { readonly kind: "lost"; readonly reason: string }
  /** Discovery or atomic-claim I/O failed; this is never proof absence. */
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string };

export type HostStartAdoptionPublisher = (
  serviceLabel: string,
) => Promise<HostStartAdoptionLease | void>;

function adoptionPath(home: string): string {
  return join(resolve(home), HOST_START_ADOPTION_FILENAME);
}

function acknowledgementPath(home: string, nonce: string): string {
  return join(resolve(home), `.host-start-adoption.${nonce}.ack`);
}

/**
 * Publish a nonce-bound, one-supervisor grant. The caller MUST await the
 * returned lease after the OS start/restart action; doing so preserves the
 * parent's live attempt capability until the named child has acknowledged its
 * synchronous spawn. A completed service-controller call alone is not an
 * admission lease.
 */
export async function publishHostStartAdoption(
  capability: UpdateMutationCapability,
  options: WithCliUpdateContenderOptions,
  serviceLabel: string,
): Promise<HostStartAdoptionLease> {
  if (serviceLabel.length === 0) {
    throw new Error("host-start adoption requires a service label");
  }
  const home = options.hostHomeDir ?? hostHomeDir(options.environment);
  const adoption = await createUpdateMutationCapabilityAdoption(
    capability,
    home,
  );
  const nonce = randomUUID();
  const path = adoptionPath(home);
  const acknowledgement = acknowledgementPath(home, nonce);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(home, { recursive: true });
  try {
    await writeFile(
      temporary,
      JSON.stringify({
        version: 2,
        issuedAtMs: Date.now(),
        nonce,
        serviceLabel,
        adoption,
      } satisfies HostStartAdoptionFile),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return {
    waitForSpawn: async (): Promise<void> => {
      const deadline = Date.now() + HOST_START_ADOPTION_ACK_WAIT_MS;
      while (Date.now() < deadline) {
        const acknowledgementFile = await readAcknowledgement(acknowledgement);
        if (acknowledgementFile !== null) {
          if (acknowledgementFile.nonce !== nonce) {
            throw new Error(
              "host-start adoption acknowledgement nonce mismatched",
            );
          }
          const parentStillLive =
            await validateUpdateMutationCapabilityAdoption(adoption, home);
          if (!parentStillLive) {
            throw new Error("host-start adoption parent capability was lost");
          }
          return;
        }
        await waitForAdoptionPoll();
      }
      throw new Error("host-start supervisor did not acknowledge its spawn");
    },
    cancel: async (): Promise<void> => {
      // Do not delete a later service edge's proof if this holder happens to
      // issue launches serially across an async controller boundary. The
      // nonce is the lease identity; the fixed discovery path is not.
      await removeAdoptionIfNonce(path, nonce);
      await rm(acknowledgement, { force: true }).catch(() => undefined);
    },
  };
}

/**
 * Atomically claim the one grant intended for the service-manager launch.
 * Returning a grant rather than a boolean is essential: the caller must hold
 * it through its target resolution and spawn, then acknowledge under a fresh
 * parent-holder check. A claimed/invalid proof never falls back to a new
 * admission in this invocation.
 */
export async function consumeHostStartAdoption(
  environment: Environment,
  serviceLabel: string | null,
  expectedNonce: string | null,
): Promise<HostStartAdoptionConsumeResult> {
  const home = hostHomeDir(environment);
  const path = adoptionPath(home);
  // A proof is for the service-manager child alone. A hand-run host start,
  // a crash-loop invocation, or an N-1 manifest has no current service-label
  // capability and cannot steal the pending grant for a service child. If a
  // proof is outstanding, do not fall through to a fresh admission either:
  // that would recreate the parent-lock/child-lock cycle the proof exists to
  // avoid. Only a proof that is absent, expired, or orphaned (its parent no
  // longer holds the capability - `readOrphanedProof`) permits standalone
  // admission; none of those has a live parent to form that cycle with.
  if (serviceLabel === null || serviceLabel.length === 0) {
    const pending = await readPendingAdoption(path);
    if (pending.kind === "absent") return { kind: "absent" };
    if (pending.kind === "unreadable") {
      return { kind: "error", reason: "host-start adoption could not be read" };
    }
    // An EXPIRED proof is not an outstanding grant, and must not refuse a
    // standalone start forever.
    //
    // The age bound is applied on the other two paths that read this file (the
    // claimed-candidate check below, and `readHostStartAdoptionNonce`) and was
    // missing here. That gap is reachable: a publisher that dies between
    // publishing and consuming leaves the proof behind, and while the labelled
    // path erases an expired one on its next attempt, a bare `host start`
    // never takes that path — so a crash-loop with no service label is refused
    // on every iteration, indefinitely, by a grant nobody can still use.
    //
    // Treated as ABSENT rather than removed here on purpose. This caller holds
    // no service-label capability, and `removeAdoptionIfNonce`'s comment states
    // the discipline: a read-then-remove by a party without the nonce lets an
    // old lease erase a NEWER publisher's proof. Expiry is enough to unblock
    // admission; erasing is the labelled path's job, which already does it.
    if (
      pending.kind === "valid" &&
      adoptionGrantExpired(pending.file.issuedAtMs)
    ) {
      return { kind: "absent" };
    }
    if (pending.kind === "valid") {
      const orphan = await readOrphanedProof(pending.file, home);
      if (orphan !== null) return orphan;
    }
    return {
      kind: "refused",
      reason:
        pending.kind === "malformed"
          ? "host-start adoption is malformed"
          : "host-start adoption is reserved for a service-labelled launch",
    };
  }
  const pending = await readPendingAdoption(path);
  if (pending.kind === "unreadable") {
    return { kind: "error", reason: "host-start adoption could not be read" };
  }
  if (pending.kind === "malformed") {
    return { kind: "refused", reason: "host-start adoption is malformed" };
  }
  // An EXPIRED proof is not an outstanding grant on THIS path either, and the
  // age bound has to be applied BEFORE the label and nonce checks below.
  //
  // The standalone branch above got this bound first, and the comment there
  // named the other two readers that already had it — without noticing that
  // the labelled consume path is a THIRD reader that did not. The gap is not
  // theoretical, because expiry is exactly what steers a launch onto it:
  // `readHostStartAdoptionNonce` applies the age bound and returns null for an
  // expired proof, so `host adoption-nonce` yields nothing and the generated
  // launcher re-execs `host start --service-label <label>` with NO
  // `--adoption-nonce` (see the emitted launcher in
  // desktop/scripts/prepack/inject-host-launch-agent.cjs). That lands here with
  // `expectedNonce === null` against a pending read that is still "valid" —
  // `readPendingAdoption` deliberately does no age filtering — so the nonce
  // check below refuses it. Nothing on this path reaches the post-claim expiry
  // check, which sits after the claim the nonce check never lets us make, so
  // the refusal repeats on every service-manager retry, forever, on the
  // authority of a grant nobody can still use.
  //
  // Ordered ahead of the label-binding check on purpose: an expired proof bound
  // to a DIFFERENT label would otherwise wedge that launcher the same way, for
  // the same reason. Expiry is not a routing question.
  //
  // Treated as ABSENT rather than removed, for the reason `removeAdoptionIfNonce`
  // documents: a read-then-remove by a party that has not matched the nonce lets
  // a stale reader erase a NEWER publisher's proof. Expiry is enough to unblock
  // admission; erasing stays the job of the paths that hold the nonce.
  if (
    pending.kind === "valid" &&
    adoptionGrantExpired(pending.file.issuedAtMs)
  ) {
    return { kind: "absent" };
  }
  // The labelled launch WITHOUT a nonce is the other nonce-less path, and the
  // one a dead publisher steers launches onto: `readHostStartAdoptionNonce`
  // hands out no nonce for a proof whose parent is gone, so the launcher
  // re-execs `host start --service-label` bare and lands here. See
  // `readOrphanedProof`. Ahead of the label check for the reason expiry is:
  // whose grant a dead parent's proof was is not a routing question. A LIVE
  // parent still refuses below, nonce or no nonce.
  if (pending.kind === "valid" && expectedNonce === null) {
    const orphan = await readOrphanedProof(pending.file, home);
    if (orphan !== null) return orphan;
  }
  if (pending.kind === "valid" && pending.file.serviceLabel !== serviceLabel) {
    return {
      kind: "refused",
      reason: "host-start adoption is bound to a different service label",
    };
  }
  // A visible v2 proof is an exact launch grant, never merely routing by
  // service label.  An old labelled wrapper, a manual labelled start, or a
  // concurrent same-label launcher must not be able to consume a proof meant
  // for the nonce-bearing service-manager child.  When no proof exists an
  // older wrapper reaches ordinary canonical admission below; it simply
  // cannot adopt a live parent's authority.
  if (
    pending.kind === "valid" &&
    (expectedNonce === null ||
      !isNonce(expectedNonce) ||
      pending.file.nonce !== expectedNonce)
  ) {
    return {
      kind: "refused",
      reason:
        "host-start adoption nonce did not match the pending service launch",
    };
  }
  // This bit is intentionally retained across the rename. A claimant that
  // observed a concrete proof cannot reinterpret a competing claimant's
  // successful atomic rename as no proof and enter ordinary admission. The
  // proof is a one-shot exact-launch capability, not a best-effort hint.
  const observedPendingProof = pending.kind === "valid";
  if (beforeHostStartAdoptionClaimHookForTest !== null) {
    await beforeHostStartAdoptionClaimHookForTest();
  }
  const claimedCandidate = `${path}.${process.pid}.${randomUUID()}.claimed`;
  try {
    await rename(path, claimedCandidate);
  } catch (error) {
    if (isMissing(error)) {
      return observedPendingProof
        ? {
            kind: "lost",
            reason: "host-start adoption was claimed by another service launch",
          }
        : { kind: "absent" };
    }
    return { kind: "error", reason: "host-start adoption claim failed" };
  }
  let claimed = true;
  const abandon = async (): Promise<void> => {
    if (!claimed) return;
    claimed = false;
    await rm(claimedCandidate, { force: true }).catch(() => undefined);
  };
  const restoreClaimForBoundService = async (): Promise<void> => {
    if (!claimed) return;
    claimed = false;
    // A different labelled service may have raced a new proof into the fixed
    // discovery path. Restore only if it is still vacant; otherwise discard
    // this private old claim, never the current proof.
    await restoreClaimToVacantPath(claimedCandidate, path);
  };
  try {
    const claimedRead = await readRegularFileNoFollow(claimedCandidate);
    if (claimedRead.kind !== "text") {
      throw new Error("host-start adoption claim could not be read safely");
    }
    const parsed = parseAdoption(claimedRead.text);
    if (parsed === null || adoptionGrantExpired(parsed.issuedAtMs)) {
      await abandon();
      return {
        kind: "refused",
        reason: "host-start adoption was malformed or expired",
      };
    }
    if (
      parsed.serviceLabel !== serviceLabel ||
      expectedNonce === null ||
      !isNonce(expectedNonce) ||
      parsed.nonce !== expectedNonce
    ) {
      await restoreClaimForBoundService();
      return {
        kind: "refused",
        reason: "host-start adoption is bound to another service launch",
      };
    }
    const parentLive = await validateUpdateMutationCapabilityAdoption(
      parsed.adoption,
      home,
    );
    if (!parentLive) {
      await abandon();
      return {
        kind: "refused",
        reason: "host-start adoption parent was not live",
      };
    }
    return {
      kind: "grant",
      grant: {
        acknowledgeSpawn: async (): Promise<boolean> => {
          if (!claimed) return false;
          const parentStillLive =
            await validateUpdateMutationCapabilityAdoption(
              parsed.adoption,
              home,
            );
          if (!parentStillLive) {
            await abandon();
            return false;
          }
          const acknowledgement = acknowledgementPath(home, parsed.nonce);
          const temporary = `${acknowledgement}.${randomUUID()}.tmp`;
          try {
            await writeFile(
              temporary,
              JSON.stringify({
                version: 2,
                nonce: parsed.nonce,
                childPid: process.pid,
              } satisfies HostStartAdoptionAcknowledgement),
              { encoding: "utf8", mode: 0o600, flag: "wx" },
            );
            await rename(temporary, acknowledgement);
            return true;
          } finally {
            await rm(temporary, { force: true }).catch(() => undefined);
            await abandon();
          }
        },
        abandon,
      },
    };
  } catch {
    await abandon();
    return { kind: "error", reason: "host-start adoption could not be read" };
  }
}

/**
 * Read the opaque launch nonce for an installed service wrapper. This is not
 * an adoption operation: it cannot mint, consume, or validate a capability.
 * The caller must still present the returned nonce to the atomic consumer,
 * which repeats the parent-holder check after the actual child spawn.
 */
export async function readHostStartAdoptionNonce(
  environment: Environment,
  serviceLabel: string,
): Promise<string | null> {
  if (serviceLabel.length === 0) return null;
  const home = hostHomeDir(environment);
  const pending = await readPendingAdoption(adoptionPath(home));
  if (pending.kind !== "valid") return null;
  if (
    pending.file.serviceLabel !== serviceLabel ||
    adoptionGrantExpired(pending.file.issuedAtMs) ||
    !isNonce(pending.file.nonce)
  ) {
    return null;
  }
  return (await validateUpdateMutationCapabilityAdoption(
    pending.file.adoption,
    home,
  ))
    ? pending.file.nonce
    : null;
}

type PendingAdoptionRead =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly file: HostStartAdoptionFile }
  | { readonly kind: "malformed" }
  | { readonly kind: "unreadable" };

async function readPendingAdoption(path: string): Promise<PendingAdoptionRead> {
  if (beforeHostStartAdoptionReadHookForTest !== null) {
    await beforeHostStartAdoptionReadHookForTest();
  }
  const read = await readRegularFileNoFollow(path);
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "unreadable") return { kind: "unreadable" };
  const file = parseAdoption(read.text);
  return file === null ? { kind: "malformed" } : { kind: "valid", file };
}

/**
 * For a NONCE-LESS launch only: `absent` when the pending proof's publisher no
 * longer holds the capability it was issued under, `error` when that could not
 * be checked, `null` when the parent is live and the caller's refusal stands.
 *
 * A proof whose parent capability is not live cannot be a live publisher's
 * intent. Reading it as ABSENT sends the launch down the ordinary admission
 * path, which is exactly what a launch with no proof at all gets, so this
 * removes a refusal without granting anything a proof-less launch does not
 * already have. Without it, a publisher that died between publishing and its
 * child's consume refused every nonce-less launch until the proof expired -
 * and the grant window just doubled to 120s.
 *
 * Deliberately the predicate `readHostStartAdoptionNonce` applies before it
 * hands a launcher a nonce, so a launch that got no nonce BECAUSE the parent
 * was gone is not then refused for lacking one. "Not live" includes a lock
 * that cannot be read or parsed; that is safe for the same reason as the rest:
 * ordinary admission contends that very lock, so a live holder misread here
 * still stops the launch there.
 *
 * A nonce-BEARING launch never comes here. It was handed that nonce by a live
 * parent, and a mismatch against a live parent's proof still refuses.
 *
 * The proof is left in place. Removal belongs to its publisher's `cancel`,
 * and a dead publisher's proof expires by age (and the next publish replaces
 * it) - a consumer without the nonce that removed it could erase a NEWER
 * publisher's proof (see `removeAdoptionIfNonce`).
 */
async function readOrphanedProof(
  file: HostStartAdoptionFile,
  home: string,
): Promise<HostStartAdoptionConsumeResult | null> {
  let parentLive: boolean;
  try {
    parentLive = await validateUpdateMutationCapabilityAdoption(
      file.adoption,
      home,
    );
  } catch {
    return {
      kind: "error",
      reason: "host-start adoption parent could not be checked",
    };
  }
  return parentLive ? null : { kind: "absent" };
}

async function readAcknowledgement(
  path: string,
): Promise<HostStartAdoptionAcknowledgement | null> {
  const read = await readRegularFileNoFollow(path);
  if (read.kind === "absent") return null;
  if (read.kind === "unreadable") {
    throw new Error("host-start adoption acknowledgement could not be read");
  }
  return parseAcknowledgement(read.text);
}

async function removeAdoptionIfNonce(
  path: string,
  nonce: string,
): Promise<void> {
  const claimed = `${path}.${process.pid}.${randomUUID()}.cleanup`;
  try {
    // Rename is the same one-winner claim primitive used by the child. A
    // read-then-rm would let this old lease erase a newer publisher's proof.
    await rename(path, claimed);
  } catch (error) {
    if (isMissing(error)) return;
    return;
  }
  const claimedRead = await readRegularFileNoFollow(claimed);
  if (claimedRead.kind !== "text") {
    await rm(claimed, { force: true }).catch(() => undefined);
    return;
  }
  const parsed = parseAdoption(claimedRead.text);
  if (parsed?.nonce === nonce) {
    await rm(claimed, { force: true }).catch(() => undefined);
    return;
  }
  // A different publisher won the shared discovery name. Preserve its proof
  // if nobody has since supplied another one; otherwise discard only our
  // private cleanup claim, never the current canonical name.
  await restoreClaimToVacantPath(claimed, path);
}

// Put a privately-named claim back at the fixed discovery path ONLY if that
// path is still vacant. `rename` cannot express vacancy — it replaces an
// existing destination on POSIX and on Windows alike, which would let an old
// claim erase a newer publisher's proof. An exclusive hard `link` fails with
// EEXIST when the name is occupied, so the proof that was raced in survives;
// the private claim name is removed in either outcome.
async function restoreClaimToVacantPath(
  claimed: string,
  path: string,
): Promise<void> {
  try {
    await link(claimed, path);
  } catch {
    // Occupied by a newer proof (or the claim vanished): discard only the
    // private claim below, never the canonical name.
  }
  await rm(claimed, { force: true }).catch(() => undefined);
}

function parseAdoption(input: string): HostStartAdoptionFile | null {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const file = value as Record<string, unknown>;
  const adoption = file.adoption;
  if (
    file.version !== 2 ||
    typeof file.issuedAtMs !== "number" ||
    !Number.isSafeInteger(file.issuedAtMs) ||
    typeof file.nonce !== "string" ||
    !isNonce(file.nonce) ||
    typeof file.serviceLabel !== "string" ||
    file.serviceLabel.length === 0 ||
    adoption === null ||
    typeof adoption !== "object" ||
    Array.isArray(adoption)
  ) {
    return null;
  }
  const candidate = adoption as Record<string, unknown>;
  const holder = candidate.holder;
  if (
    typeof candidate.hostHomeDir !== "string" ||
    holder === null ||
    typeof holder !== "object" ||
    Array.isArray(holder)
  ) {
    return null;
  }
  return value as HostStartAdoptionFile;
}

function parseAcknowledgement(
  input: string,
): HostStartAdoptionAcknowledgement | null {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const acknowledgement = value as Record<string, unknown>;
  return acknowledgement.version === 2 &&
    typeof acknowledgement.nonce === "string" &&
    acknowledgement.nonce.length > 0 &&
    typeof acknowledgement.childPid === "number" &&
    Number.isSafeInteger(acknowledgement.childPid) &&
    acknowledgement.childPid > 0
    ? (value as HostStartAdoptionAcknowledgement)
    : null;
}

function isNonce(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function waitForAdoptionPoll(): Promise<void> {
  return new Promise((resolvePoll) =>
    setTimeout(resolvePoll, HOST_START_ADOPTION_POLL_MS),
  );
}
