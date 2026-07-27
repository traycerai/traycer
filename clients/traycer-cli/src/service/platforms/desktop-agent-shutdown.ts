import { randomUUID } from "node:crypto";
import {
  SHUTDOWN_FORCE_EXIT_MS,
  STOP_EXIT_GRACE_MARGIN_MS,
} from "@traycer/protocol/host/lifecycle-constants";
import { SHUTDOWN_CLAIM_MAX_TTL_MS } from "@traycer/protocol/host/lifecycle/schemas";
import {
  isValidLocalHostWebsocketUrl,
  readHostPidMetadata,
} from "../../host/pid-metadata";
import { isProcessAlive } from "../../store/cli-lock";
import { callHostRpcAtEndpoint } from "../../internal/host-rpc";
import { createCliLogger } from "../../logger";
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

export async function requestCooperativeShutdown(
  environment: Environment,
  operation: string,
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
      { transitionId, ttl: CLAIM_TTL_MS },
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
