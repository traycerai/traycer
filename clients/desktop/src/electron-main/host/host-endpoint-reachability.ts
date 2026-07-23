import { getPublishedProcessIdentityVerdict } from "./process-identity";

/** Real-endpoint-reachability probe signature for host pid metadata. */
export type HostEndpointReachabilityProbe = (
  websocketUrl: string,
) => Promise<boolean>;

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
 */
export async function isPublishedHostEndpointReachable(
  websocketUrl: string,
  pid: number,
  publishedAt: string | null,
  probe: HostEndpointReachabilityProbe,
): Promise<boolean> {
  if (!isCurrentHostWebsocketUrl(websocketUrl)) return false;
  if (!(await probe(websocketUrl))) return false;
  const identityVerdict = await getPublishedProcessIdentityVerdict(
    pid,
    publishedAt,
  );
  return identityVerdict !== "dead" && identityVerdict !== "mismatch";
}
