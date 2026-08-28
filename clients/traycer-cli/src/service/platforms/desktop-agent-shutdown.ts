import { randomUUID } from "node:crypto";
import {
  SHUTDOWN_FORCE_EXIT_MS,
  STOP_EXIT_GRACE_MARGIN_MS,
} from "@traycer/protocol/host/lifecycle-constants";
import {
  SHUTDOWN_CLAIM_MAX_TTL_MS,
  type ShutdownClaimIntent,
} from "@traycer/protocol/host/lifecycle/schemas";
import {
  isValidLocalHostWebsocketUrl,
  readHostPidMetadata,
  removeHostPidMetadata,
  type HostPidMetadata,
} from "../../host/pid-metadata";
import { isProcessAlive } from "../../store/cli-lock";
import { getPublishedProcessIdentityVerdict } from "../../store/process-identity";
import { callHostRpcAtEndpoint } from "../../internal/host-rpc";
import { createCliLogger, type ILogger } from "../../logger";
import type { Environment } from "../../runner/environment";

// Cooperative shutdown of a Desktop-managed host, through the host's own
// lifecycle-claim RPCs instead of launchd. Who registered the OS service is
// irrelevant here by design: we ask the RUNNING HOST to stand down
// (claim -> commit -> wait for real exit), which protects in-flight work
// (a busy host denies the claim) and mutates no registration the CLI does
// not own. This is what turns "Traycer Desktop owns host registration" from
// a refusal into a routing decision.

export type CooperativeShutdownOutcome =
  // Claim granted, commit acknowledged, and the pid was observed to exit.
  | { readonly kind: "stopped" }
  // PROVEN absent: pid metadata was read and the process it names is gone.
  | { readonly kind: "no-host" }
  // Pid metadata could not be read at all - absent, unreadable, or
  // malformed. This is NOT proof that no host is running, and conflating
  // the two is how a host that is still booting (loaded agent, endpoint not
  // published yet) gets reported as successfully stopped: `host stop`
  // returns success while it keeps serving, and an install swaps bytes
  // underneath it. Callers pick the safe direction for their operation
  // rather than inheriting a guess.
  | { readonly kind: "no-metadata" }
  // The host denied the claim: it has work in progress. Callers must
  // surface this rather than escalate - a denied claim is retryable, a
  // killed working host is not.
  | { readonly kind: "busy" }
  // Commit acknowledged but the process outlived the shutdown grace plus
  // the host's own force-exit watchdog.
  | { readonly kind: "hung"; readonly pid: number }
  // The claim path could not run at all (RPC dial/auth failure, invalid
  // endpoint, or a commit denial after expiry). The live process may or
  // may not be serving; callers choose the escalation appropriate to
  // their operation.
  | { readonly kind: "unreachable"; readonly cause: string };

const EXIT_POLL_MS = 150;
// The host SIGTERMs itself on commit and force-exits after
// SHUTDOWN_FORCE_EXIT_MS; the margin mirrors macOS `stopService`.
const EXIT_TIMEOUT_MS = SHUTDOWN_FORCE_EXIT_MS + STOP_EXIT_GRACE_MARGIN_MS;
// The claim must outlive the whole exit wait or the host could expire it
// mid-shutdown; comfortably under the schema's hard ceiling.
const CLAIM_TTL_MS = Math.min(
  EXIT_TIMEOUT_MS + 30_000,
  SHUTDOWN_CLAIM_MAX_TTL_MS,
);

/**
 * `intent` tells the host what happens AFTER it exits, which is the one thing
 * it cannot see for itself: a cooperative stop and the stop half of a restart
 * are byte-identical from inside the process. A host told `"restart"`
 * publishes a restart tombstone to every attached client so a deliberate
 * bounce does not read as death in every window on every machine (D5/M1);
 * one told `"shutdown"` behaves exactly as it always has.
 *
 * Required rather than derived from `operation`: that string is a free-form
 * diagnostic label carried in `transitionId`, and making a debugging
 * affordance load-bearing is how it silently stops being true.
 */
export async function requestCooperativeShutdown(
  environment: Environment,
  operation: string,
  intent: ShutdownClaimIntent,
): Promise<CooperativeShutdownOutcome> {
  const logger = createCliLogger(environment);
  const metadata = await readHostPidMetadata(environment);
  if (metadata === null) {
    return { kind: "no-metadata" };
  }
  if (!isProcessAlive(metadata.pid)) {
    return { kind: "no-host" };
  }
  if (!isValidLocalHostWebsocketUrl(metadata.websocketUrl)) {
    return {
      kind: "unreachable",
      cause: "pid metadata advertises an invalid local WebSocket endpoint",
    };
  }
  const endpoint = {
    hostId: metadata.hostId,
    websocketUrl: metadata.websocketUrl,
  };
  /**
   * Best-effort return of a granted claim. Deliberately swallows its own
   * failure: we are already on an abort path, and the caller's outcome is
   * about the shutdown, not about the cleanup. A release that cannot be
   * delivered costs the claim's remaining TTL, which is the same position we
   * would be in without this call — never worse.
   */
  const releaseClaim = async (token: string | null): Promise<void> => {
    if (token === null) return;
    try {
      await callHostRpcAtEndpoint(
        "lifecycle.releaseShutdown",
        { token },
        endpoint,
      );
    } catch (releaseError) {
      logger.debug("Releasing the abandoned shutdown claim failed", {
        environment,
        operation,
        cause:
          releaseError instanceof Error
            ? releaseError.message
            : String(releaseError),
      });
    }
  };
  const transitionId = `cli-${operation}-${randomUUID()}`;
  // A granted claim closes the host to new work until it is committed,
  // released, or expires. Every abort path below therefore has to hand the
  // token back: `CLAIM_TTL_MS` is ~62s, so a transient dial failure between
  // claim and commit would otherwise leave a HEALTHY host refusing work for a
  // full minute - a self-inflicted outage produced by the code that exists to
  // shut down cleanly. `lifecycle.releaseShutdown` is the abort leg of the
  // contract; not calling it is the bug.
  let grantedToken: string | null = null;
  try {
    const claimed = await callHostRpcAtEndpoint(
      "lifecycle.claimShutdown",
      { transitionId, ttl: CLAIM_TTL_MS, intent },
      endpoint,
    );
    if ("denied" in claimed) {
      return { kind: "busy" };
    }
    grantedToken = claimed.granted.token;
    const committed = await callHostRpcAtEndpoint(
      "lifecycle.commitShutdown",
      { token: claimed.granted.token },
      endpoint,
    );
    if ("denied" in committed) {
      await releaseClaim(grantedToken);
      return {
        kind: "unreachable",
        cause: `commit denied (${committed.denied})`,
      };
    }
    // Committed: the claim has done its job and must NOT be released - the
    // host is shutting down on the strength of it.
    grantedToken = null;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    await releaseClaim(grantedToken);
    logger.warn("Cooperative shutdown RPC failed", {
      environment,
      operation,
      transitionId,
      hostId: metadata.hostId,
      pid: metadata.pid,
      cause,
    });
    return { kind: "unreachable", cause };
  }
  const exited = await waitForCooperativeExit(metadata.pid);
  if (!exited) {
    return { kind: "hung", pid: metadata.pid };
  }
  return { kind: "stopped" };
}

async function waitForCooperativeExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, EXIT_POLL_MS);
    });
  }
  // The process may have exited during the last poll sleep, right as the
  // deadline elapsed.
  return !isProcessAlive(pid);
}

export type ForcedShutdownOutcome =
  // The host process was observed to exit (or was already gone by the time
  // the signal landed).
  | { readonly kind: "stopped" }
  // PROVEN absent: pid metadata was read and the process it names is gone -
  // either nothing occupies the pid, or an identity comparison proved the
  // occupant is an unrelated process on a recycled pid.
  | { readonly kind: "no-host" }
  // Pid metadata could not be read at all, so there is no process to signal.
  // Same non-proof caveat as `CooperativeShutdownOutcome`: a booting host may
  // not have published its endpoint yet.
  | { readonly kind: "no-metadata" }
  // pid.json RECORDS a start identity but the live occupant's could not be
  // read/compared right now. Something holds the pid and we cannot prove it
  // is the host, so nothing may be signalled: the error directions are not
  // symmetric - a refused force stop is retryable, a SIGKILL delivered to a
  // recycled pid's unrelated occupant is not. Can arise before the first
  // signal OR at the pre-SIGKILL revalidation (SIGTERM was already delivered
  // to a then-verified occupant; only the escalation is refused).
  | { readonly kind: "identity-unverified"; readonly pid: number }
  // The process survived SIGTERM through the exit grace AND a follow-up
  // SIGKILL - it is unkillable from here (uninterruptible sleep, or not ours).
  | { readonly kind: "hung"; readonly pid: number };

/**
 * Forced shutdown of a Desktop-managed host: kill the HOST CHILD process
 * directly instead of asking it to stand down.
 *
 * This deliberately signals the child named by pid.json and never touches
 * launchd: the SMAppService registration stays exactly as Desktop left it,
 * and the supervisor - which reads the stop-intent record the calling
 * command's `withStopIntent` decorator wrote before this ran - treats the
 * death as asked-for rather than a crash, so nothing relaunches the host.
 *
 * No RPC is involved at any point, which is the other half of the contract:
 * force works identically against a busy host, a wedged host, and a host
 * whose endpoint is unreachable, on every host version.
 *
 * SIGTERM first: the host's own handler runs its graceful shutdown (with its
 * force-exit watchdog), so in-flight persistence gets the same drain a
 * cooperative commit gives it. SIGKILL only after the full exit grace.
 */
export async function forceStopHostProcess(
  environment: Environment,
  operation: string,
): Promise<ForcedShutdownOutcome> {
  const logger = createCliLogger(environment);
  const { outcome, actedOn } = await signalHostForForcedStop(
    environment,
    operation,
    logger,
  );
  // A force stop's success must not leave a resurrect signal behind. The
  // desktop health monitor reads pid.json AFTER its endpoint probe fails and
  // treats ABSENCE as "deliberate stop" - metadata still present with a dead
  // endpoint is read as a crash and respawned. Only a graceful, un-wedged
  // shutdown lets the host's own handler unlink the file, so every success
  // here has to complete the writer contract on the host's behalf: `stopped`
  // covers a SIGKILL (handler never ran) and a wedged-then-dead SIGTERM;
  // `no-host` covers the stale record naming a dead or recycled pid, which
  // is precisely the state that invites the resurrection.
  //
  // Purge ONLY the instance this stop acted on. A supervisor relaunched
  // mid-stop (its predecessor crashed for its own reasons) snapshots the
  // pre-existing stop intent as already served and may publish a REPLACEMENT
  // host's pid.json inside this window - an unconditional unlink would
  // delete the replacement's record, leaving that host running but
  // undiscoverable, with the absence read as a deliberate stop nothing will
  // recover. Re-read and remove only on an exact instance match (pid + start
  // identity, the same pair that gated the signals). Best-effort either way:
  // the stop itself already succeeded.
  if (outcome.kind === "stopped" || outcome.kind === "no-host") {
    try {
      const current = await readHostPidMetadata(environment);
      if (
        current !== null &&
        actedOn !== null &&
        current.pid === actedOn.pid &&
        current.processStartIdentity === actedOn.processStartIdentity
      ) {
        await removeHostPidMetadata(environment);
      }
    } catch (error) {
      logger.warn("Could not remove pid.json after a forced stop", {
        environment,
        operation,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcome;
}

// The outcome plus the pid.json record the signals were aimed at (`null`
// only for `no-metadata`). The caller's purge needs the record to guarantee
// it removes the STOPPED instance's file and never a replacement's.
interface ForcedStopSignalResult {
  readonly outcome: ForcedShutdownOutcome;
  readonly actedOn: HostPidMetadata | null;
}

async function signalHostForForcedStop(
  environment: Environment,
  operation: string,
  logger: ILogger,
): Promise<ForcedStopSignalResult> {
  const metadata = await readHostPidMetadata(environment);
  if (metadata === null) {
    return { outcome: { kind: "no-metadata" }, actedOn: null };
  }
  // Identity before signal. A pid.json that survived a host crash can name a
  // RECYCLED pid, and liveness alone would aim SIGTERM/SIGKILL at whatever
  // unrelated process occupies it now. When the record carries the kernel's
  // start identity, require a byte-for-byte match ("current") before any
  // signal; "mismatch" proves the host is gone (only an impostor holds the
  // pid) and "indeterminate" means we cannot tell, which forbids killing.
  // A pre-identity pid.json (null field) degrades to the liveness check -
  // the best answer available for those hosts, same as every other reader.
  if (metadata.processStartIdentity !== null) {
    const identity = await getPublishedProcessIdentityVerdict(
      metadata.pid,
      metadata.processStartIdentity,
    );
    if (identity === "dead" || identity === "mismatch") {
      return { outcome: { kind: "no-host" }, actedOn: metadata };
    }
    if (identity === "indeterminate") {
      return {
        outcome: { kind: "identity-unverified", pid: metadata.pid },
        actedOn: metadata,
      };
    }
  } else if (!isProcessAlive(metadata.pid)) {
    return { outcome: { kind: "no-host" }, actedOn: metadata };
  }
  logger.warn("Force-stopping the running host", {
    environment,
    operation,
    hostId: metadata.hostId,
    pid: metadata.pid,
  });
  if (!signalPid(metadata.pid, "SIGTERM")) {
    return { outcome: { kind: "stopped" }, actedOn: metadata };
  }
  if (await waitForCooperativeExit(metadata.pid)) {
    return { outcome: { kind: "stopped" }, actedOn: metadata };
  }
  logger.warn(
    "Host survived SIGTERM through the exit grace; escalating to SIGKILL",
    { environment, operation, pid: metadata.pid },
  );
  // The invariant that gated the first signal gates the second. The host can
  // exit in the last instants of the SIGTERM grace and the OS can hand its
  // pid to a stranger before the final liveness poll - at which point "still
  // alive" describes the STRANGER, and this SIGKILL is the irreversible one.
  // Revalidate immediately before it: "dead"/"mismatch" mean the host DID
  // exit after SIGTERM (the occupant, if any, is not ours), and an occupant
  // that cannot be verified must not be killed.
  if (metadata.processStartIdentity !== null) {
    const verdict = await getPublishedProcessIdentityVerdict(
      metadata.pid,
      metadata.processStartIdentity,
    );
    if (verdict === "dead" || verdict === "mismatch") {
      return { outcome: { kind: "stopped" }, actedOn: metadata };
    }
    if (verdict === "indeterminate") {
      return {
        outcome: { kind: "identity-unverified", pid: metadata.pid },
        actedOn: metadata,
      };
    }
  }
  if (!signalPid(metadata.pid, "SIGKILL")) {
    return { outcome: { kind: "stopped" }, actedOn: metadata };
  }
  if (await waitForCooperativeExit(metadata.pid)) {
    return { outcome: { kind: "stopped" }, actedOn: metadata };
  }
  return { outcome: { kind: "hung", pid: metadata.pid }, actedOn: metadata };
}

/**
 * `true` when the signal was delivered; `false` when the process is already
 * gone (ESRCH). Any OTHER failure - EPERM most plausibly - throws: the
 * process is still alive and unsignalable, and reporting it "stopped" would
 * be the one lie this path must never tell.
 */
function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}
