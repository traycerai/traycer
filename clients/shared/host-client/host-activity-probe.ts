// The host's unauthenticated, loopback-only `GET /activity` side-channel:
// "is any work in progress?" Both restart paths probe it before tearing a
// running host down on a desktop update - the CLI before it reinstalls the
// bytes, and the desktop before its SMAppService unregister->register cycle on
// the macOS host-owned path (where the actual teardown happens after the CLI
// has already returned) - so neither drops in-progress chat/terminal/CLI work.
//
// Fail-safe: any reachable-but-unprobeable outcome (a pre-feature host's 404,
// a malformed body, a connect error, or a timeout) counts as BUSY, so an
// indeterminate answer never green-lights a teardown. Only an explicit
// `busy:false` is treated as idle. This is a plain HTTP GET - no WsRpcClient,
// manifest, or bearer - so an unauthenticated caller can always make the call.

const ACTIVITY_PROBE_TIMEOUT_MS = 1_500;

/**
 * Returns `true` when the host at `websocketUrl` reports work in progress, or
 * when its idle/busy state can't be determined (fail-safe). Returns `false`
 * only on an explicit `{ "busy": false }`. Callers must already know the host
 * is live (a stale/absent host has nothing to protect and should not be
 * probed).
 */
export async function probeHostActivityBusy(
  websocketUrl: string,
): Promise<boolean> {
  try {
    const response = await fetch(toActivityUrl(websocketUrl), {
      signal: AbortSignal.timeout(ACTIVITY_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return true;
    }
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "busy" in body &&
      typeof body.busy === "boolean"
    ) {
      return body.busy;
    }
    return true;
  } catch {
    return true;
  }
}

// `ws://127.0.0.1:<port>/rpc` -> `http://127.0.0.1:<port>/activity`. The host
// binds loopback HTTP (not TLS). A malformed URL throws and is caught above as
// the busy fail-safe.
function toActivityUrl(websocketUrl: string): string {
  const url = new URL(websocketUrl);
  return `http://${url.host}/activity`;
}
