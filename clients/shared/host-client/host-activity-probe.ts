// Fail-safe: any reachable-but-unprobeable outcome (a pre-feature host's 404, a malformed body, a connect error, or a timeout) counts as busy, so an indeterminate answer never green-lights a teardown.
// Only an explicit `busy:false` is treated as idle.

const ACTIVITY_PROBE_TIMEOUT_MS = 1_500;

/**
 * Returns `true` when the host at `websocketUrl` reports work in progress, or when its idle/busy state can't be determined (fail-safe).
 * Returns `false` only on an explicit `{ "busy": false }`.
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

/**
 * Returns `true` when something is serving HTTP on the host's loopback endpoint - any status code counts, including a pre-feature host's 404.
 * Deliberately not `probeHostActivityBusy`: that one folds "unreachable" into "busy" so an indeterminate answer can never green-light a teardown.
 */
export async function probeHostReachable(
  websocketUrl: string,
): Promise<boolean> {
  try {
    await fetch(toActivityUrl(websocketUrl), {
      signal: AbortSignal.timeout(ACTIVITY_PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

// `ws://127.0.0.1:<port>/rpc` -> `http://127.0.0.1:<port>/activity`.
function toActivityUrl(websocketUrl: string): string {
  const url = new URL(websocketUrl);
  return `http://${url.host}/activity`;
}
