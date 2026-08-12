/**
 * "Remove from account" — the raw `POST /api/v3/hosts/:hostId/deregister` call.
 * Transport-only, a sibling of `fetchRegisteredHostsViaHttp`
 * (`remote-fetcher.ts`) and `updateHostVersionPolicyViaHttp`
 * (`host-version-policy-fetcher.ts`), and it runs where they run: desktop calls
 * it from Electron main because authn-v3's CORS allow-list is the web dashboard
 * origin, not the app renderer; browser/dev shells call it directly.
 *
 * WHAT THE ROUTE ACTUALLY DOES, because the UI copy has to be true of it:
 * it stamps `deregisteredAt` and clears the presence lease. It does NOT revoke.
 * The `hostId` survives, so nothing about the machine changes and no data is
 * deleted; the row simply stops being listed (`GET /api/v3/hosts` filters
 * `deregisteredAt: null`) and its heartbeats start coming back 404. A host that
 * is still running reads that 404 as "not registered", drops to unprovisioned,
 * and re-enrolls on its next reconcile — returning under the SAME id with its
 * policy preserved. Removing a live host from the account is therefore not by
 * itself durable, which the confirmation copy says out loud.
 *
 * Deliberately never called "deregister" in user-facing copy: the GUI already
 * uses that word for OS-SERVICE deregistration (`HostController.deregisterService`),
 * which is a different machine-local operation entirely.
 */

/** Per-request budget, mirrors `HOST_LIST_FETCH_TIMEOUT_MS`. */
const HOST_DEREGISTER_FETCH_TIMEOUT_MS = 10_000;

/**
 * Outcome of the call. A discriminated, structured-clone-safe shape (mirrors
 * `UpdateHostVersionPolicyFetchResult`) so it crosses the Electron IPC boundary
 * unchanged:
 *  - `ok`            — the host is no longer listed under this account. The
 *                      route is idempotent, so a host that was ALREADY removed
 *                      also lands here rather than as an error.
 *  - `not-found`     — no such host, or not owned by the caller (404; never
 *                      leaks existence across owners).
 *  - `revoked`       — the row is a revoked tombstone (409). Removing it is
 *                      meaningless and must not read as a benign removal.
 *  - `unauthorized`  — the bearer was rejected (401/403).
 *  - `network-error` — transient transport/timeout/5xx, or a malformed body.
 */
export type DeregisterHostFetchResult =
  | { readonly kind: "ok" }
  | { readonly kind: "not-found" }
  | { readonly kind: "revoked" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

function hostDeregisterUrl(authnBaseUrl: string, hostId: string): string {
  const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
  return new URL(
    `api/v3/hosts/${encodeURIComponent(hostId)}/deregister`,
    base,
  ).toString();
}

/**
 * Removes one host from the signed-in account with the user bearer. Never
 * throws — every failure collapses into the discriminated result so callers
 * branch on `kind` instead of `try`/`catch`.
 */
export async function deregisterHostViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  hostId: string,
): Promise<DeregisterHostFetchResult> {
  let response: Response;
  try {
    response = await fetch(hostDeregisterUrl(authnBaseUrl, hostId), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(HOST_DEREGISTER_FETCH_TIMEOUT_MS),
    });
  } catch {
    // A thrown `fetch` — transport failure or the per-attempt timeout — is
    // transient and retriable.
    return { kind: "network-error" };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status === 404) {
    return { kind: "not-found" };
  }
  if (response.status === 409) {
    return { kind: "revoked" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  // The 200 body (`{host_id, deregistered}`) carries nothing a caller needs
  // that it did not already know, so a body that fails to parse is not a
  // reason to report failure for a removal the server has already committed.
  return { kind: "ok" };
}
