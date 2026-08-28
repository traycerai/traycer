import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import {
  getPublishedProcessIdentityVerdict,
  type PublishedProcessIdentityVerdict,
} from "./process-identity";

/** Real-endpoint-reachability probe signature for host pid metadata. */
export type HostEndpointReachabilityProbe = (
  websocketUrl: string,
) => Promise<boolean>;

/**
 * How the publishing process's identity verdict is obtained.
 *
 * Injectable for exactly one reason: the verdict costs a CHILD PROCESS (`ps`
 * on POSIX, `tasklist` + `powershell` on Windows), and a caller that re-asks on
 * a fast timer - `HostLifecycle`'s re-probe ladder, which runs every 250ms
 * rising to 5s for as long as a host stays unreachable - has to be able to
 * throttle it. The default is the unthrottled read, so every other caller keeps
 * asking the OS afresh.
 *
 * `answered` is the endpoint probe's own result, handed to the reader because a
 * throttling caller must NOT serve a cached verdict on the path where the
 * handshake succeeded: a stale `current` paired with an impostor listener on
 * the same port is precisely the pairing the identity check exists to reject.
 */
export interface PublishedProcessIdentityQuery {
  readonly pid: number;
  readonly startIdentity: ProcessStartIdentity | null;
  readonly answered: boolean;
}

export type PublishedProcessIdentityVerdictReader = (
  query: PublishedProcessIdentityQuery,
) => Promise<PublishedProcessIdentityVerdict>;

/**
 * Three-valued verdict for a host advertised by pid metadata. See
 * {@link readPublishedHostPresence} for what separates the values and why the
 * middle one has to exist.
 */
export type PublishedHostPresence = "available" | "busy" | "absent";

// The committed WS-only endpoint published by the bundled host. Kept here
// with the single reachability predicate so status reads and lifecycle
// snapshots cannot disagree on whether a pid.json URL is even eligible to be
// probed.
const WS_RPC_PATH = "/rpc";
const WS_RPC_HOST = "127.0.0.1";

/**
 * Returns true only when `url` matches the committed host endpoint contract:
 * `ws://127.0.0.1:<port>/rpc` (or `wss://`).
 */
export function isCurrentHostWebsocketUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return false;
  }
  if (parsed.hostname !== WS_RPC_HOST || parsed.port === "") {
    return false;
  }
  return parsed.pathname === WS_RPC_PATH;
}

/**
 * The one Desktop authority for a host advertised by pid metadata. A valid
 * endpoint handshake is necessary but cannot authenticate a stale PID: a
 * confirmed-dead or recycled identity defeats even an impostor listener;
 * indeterminate identity evidence defers to the handshake.
 *
 * This is the complete Desktop reachability-authority set: renderer snapshot
 * publication (`HostLifecycle.toReachableSnapshot`), controller status
 * (`readRunningRuntimeVersion`), post-service-start readiness
 * (`waitForHostReady`), and steady-state health monitoring all call this
 * predicate. Other pid readers may report structural metadata, but must not
 * conclude that the host is live/reachable without this check.
 *
 * `startIdentity` is `pid.json`'s `processStartIdentity`. It replaced a
 * publication-timestamp comparison that a wall-clock adjustment could turn
 * into a false `"mismatch"` - which, because this predicate reads
 * `"mismatch"` as unreachable, is how traycerai/traycer#740 reported a host
 * answering in 8ms as down. The identity operands are kernel-recorded and
 * immune to that; when either is missing the verdict is `"indeterminate"` and
 * the successful handshake carries the decision, as documented above.
 */
export async function isPublishedHostEndpointReachable(
  websocketUrl: string,
  pid: number,
  startIdentity: ProcessStartIdentity | null,
  probe: HostEndpointReachabilityProbe,
): Promise<boolean> {
  return (
    (await readPublishedHostPresence(
      websocketUrl,
      pid,
      startIdentity,
      probe,
      undefined,
    )) === "available"
  );
}

/**
 * What the published pid metadata actually proves, with the two questions kept
 * APART instead of and-ed into one boolean:
 *
 *   available - the endpoint answered AND the process identity holds.
 *   busy      - the endpoint did not answer, but the process that published
 *               this metadata is still there with a matching kernel start
 *               identity. Alive, not serving THAT probe.
 *   absent    - nothing to bind to: the URL is not the committed host
 *               endpoint, or the pid is confirmed dead / positively recycled
 *               onto an unrelated process.
 *
 * {@link isPublishedHostEndpointReachable} is the `=== "available"` projection
 * of this, so there is still exactly one Desktop authority - callers that only
 * need "can I dial it right now" keep the boolean, and callers that publish a
 * verdict to the USER take the three-valued answer.
 *
 * ### Why the distinction has to survive to the renderer
 *
 * An endpoint probe answers "is the main thread serving this instant?", which a
 * merely BUSY host also fails - one un-yieldable `Y.applyUpdate` on a large
 * epic blocks it for tens of seconds. The desktop has always known this (see
 * `host-process-liveness.ts`, and the health monitor's "busy, holding the
 * snapshot" log line), but every consumer folded it back into a single boolean
 * on the way out, so the renderer only ever saw "reachable" or nothing. On
 * 2026-08-11 that lossy fold locked every chat on a healthy staging machine
 * read-only for two hours while the same host answered renderer RPCs in
 * milliseconds. Liveness is the authority; a failed probe may degrade the
 * verdict, never contradict it.
 *
 * The probe runs FIRST and the identity check only after, so the healthy path
 * costs exactly what it did before (one connect, then one liveness probe). The
 * extra liveness probe on the failure path is the whole point: it is the only
 * evidence that separates `busy` from `absent`, and it is spent only when
 * something already went wrong.
 */
export async function readPublishedHostPresence(
  websocketUrl: string,
  pid: number,
  startIdentity: ProcessStartIdentity | null,
  probe: HostEndpointReachabilityProbe,
  readIdentityVerdict: PublishedProcessIdentityVerdictReader | undefined,
): Promise<PublishedHostPresence> {
  if (!isCurrentHostWebsocketUrl(websocketUrl)) return "absent";
  const answered = await probe(websocketUrl);
  const identityVerdict = await (readIdentityVerdict ?? readIdentityVerdictNow)(
    { pid, startIdentity, answered },
  );
  // `dead` and `mismatch` are both POSITIVE evidence that the publishing
  // process is gone (mismatch = the pid was recycled onto something else), so
  // they outrank even a successful handshake - an impostor listener on the
  // same port must not read as our host. Everything else (`current`, and the
  // `indeterminate` verdict a refused `tasklist` produces) means the process
  // may well be alive, and the probe decides how well it is doing.
  if (identityVerdict === "dead" || identityVerdict === "mismatch") {
    return "absent";
  }
  return answered ? "available" : "busy";
}

/** The unthrottled default for {@link PublishedProcessIdentityVerdictReader}. */
function readIdentityVerdictNow(
  query: PublishedProcessIdentityQuery,
): Promise<PublishedProcessIdentityVerdict> {
  return getPublishedProcessIdentityVerdict(query.pid, query.startIdentity);
}
