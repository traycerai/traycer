import { connect, type Socket } from "node:net";
import type { Environment } from "../runner/environment";
import { createCliLogger } from "../logger";
import {
  isValidLocalHostWebsocketUrl,
  publishedHostProcessGone,
  readHostPidMetadata,
  type HostPidMetadata,
} from "../host/pid-metadata";

// Bounded, purely-local health probe `commands/host-update.ts` runs after
// the install-dir swap + service restart to decide whether the new host
// is actually alive before it deletes the update-progress marker - and,
// on failure, whether to roll back to the previous version.
//
// Deliberately narrower than Doctor's `probeHostRpc` (`doctor/engine.ts`):
// it never resolves auth credentials, never opens an authenticated RPC
// round-trip, and never talks to anything but 127.0.0.1. That is the
// binary-health / coordination-server(CS)-reachability separation the
// rollback decision depends on - a CS blip (or an auth/token-refresh
// hiccup, which would otherwise dial `authnBaseUrl` on an UNAUTHORIZED
// retry) must never look like "the new binary is broken" and trigger an
// unnecessary rollback. This module makes ZERO network calls beyond a
// loopback TCP dial: it reads local pid metadata, checks the pid is
// alive, and opens a raw TCP connection to the host's own loopback port.
// It does not import `internal/host-rpc.ts`, `internal/host-auth.ts`, or
// anything that could reach `authnBaseUrl` / the coordination server.

export interface HealthProbeResult {
  readonly healthy: boolean;
  readonly detail: string;
}

export interface HealthProbeOptions {
  readonly environment: Environment;
  // Injectable for tests so they don't need a real process/socket.
  // `null` uses the real local checks: the pid's liveness AND, for a record
  // that carries the host's creation stamp, that the live pid is still that
  // process (`publishedHostProcessGone`) - a crashed host's pid recycled onto
  // an unrelated process beside a listener on the old port must never read
  // as a healthy new host, because the caller clears its progress marker
  // and reports the update a success on this answer. A test seam sees the
  // pid alone.
  readonly checkProcessAlive: ((pid: number) => boolean) | null;
  readonly checkTcpReachable:
    | ((host: string, port: number) => Promise<boolean>)
    | null;
  // Total wall-clock budget across all retries. `null` uses the default
  // (45s, inside the ticket's suggested 30-60s window).
  readonly totalBudgetMs: number | null;
  readonly retryDelayMs: number | null;
}

const DEFAULT_TOTAL_BUDGET_MS = 45_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const TCP_PROBE_TIMEOUT_MS = 1_500;

export async function probeHostHealth(
  opts: HealthProbeOptions,
): Promise<HealthProbeResult> {
  const logger = createCliLogger(opts.environment);
  const checkProcessAlive: (metadata: HostPidMetadata) => boolean =
    opts.checkProcessAlive === null
      ? (metadata) => !publishedHostProcessGone(metadata)
      : liveByPidOnly(opts.checkProcessAlive);
  const checkTcpReachable = opts.checkTcpReachable ?? probeLoopbackTcp;
  const totalBudgetMs = opts.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const deadline = Date.now() + totalBudgetMs;

  let lastResult: HealthProbeResult = {
    healthy: false,
    detail: "no attempt made",
  };
  // Always attempt at least once, even with a zero/negative budget (tests
  // rely on this for deterministic single-shot probing).
  for (;;) {
    lastResult = await attemptOnce(
      opts.environment,
      checkProcessAlive,
      checkTcpReachable,
    );
    if (lastResult.healthy) {
      logger.info("Host update health probe succeeded", {
        environment: opts.environment,
      });
      return lastResult;
    }
    if (Date.now() >= deadline) {
      logger.warn("Host update health probe exhausted retry budget", {
        environment: opts.environment,
        detail: lastResult.detail,
      });
      return lastResult;
    }
    const remaining = deadline - Date.now();
    await sleep(Math.max(0, Math.min(retryDelayMs, remaining)));
  }
}

function liveByPidOnly(
  checkPid: (pid: number) => boolean,
): (metadata: HostPidMetadata) => boolean {
  return (metadata) => checkPid(metadata.pid);
}

async function attemptOnce(
  environment: Environment,
  checkProcessAlive: (metadata: HostPidMetadata) => boolean,
  checkTcpReachable: (host: string, port: number) => Promise<boolean>,
): Promise<HealthProbeResult> {
  const metadata = await readHostPidMetadata(environment);
  if (metadata === null) {
    return {
      healthy: false,
      detail: "no host pid metadata found after restart",
    };
  }
  if (!isValidLocalHostWebsocketUrl(metadata.websocketUrl)) {
    return {
      healthy: false,
      detail: "host pid metadata advertises an invalid local websocket URL",
    };
  }
  if (!checkProcessAlive(metadata)) {
    return {
      healthy: false,
      detail: `host process (pid ${metadata.pid}) is not alive, or the pid now belongs to another process`,
    };
  }
  const parsed = new URL(metadata.websocketUrl);
  const port = Number(parsed.port);
  const host = parsed.hostname.length > 0 ? parsed.hostname : "127.0.0.1";
  const reachable = await checkTcpReachable(host, port);
  if (!reachable) {
    return {
      healthy: false,
      detail: `host loopback port ${port} did not accept a TCP connection`,
    };
  }
  return {
    healthy: true,
    detail: "process alive and loopback port reachable",
  };
}

function probeLoopbackTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const socket: Socket = connect(port, host);
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(TCP_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
