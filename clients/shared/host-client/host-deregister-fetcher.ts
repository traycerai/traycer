/**
 * "Remove from account" - the raw `post /api/v3/hosts/:hostId/deregister` call.
 * A live host does not come back on its own, and the copy must not imply it does.
 */

const HOST_DEREGISTER_FETCH_TIMEOUT_MS = 10_000;

/**
 * Outcome of the call.
 * A discriminated, structured-clone-safe shape (mirrors `UpdateHostVersionPolicyFetchResult`) so it crosses the Electron IPC boundary unchanged: - `ok` - the host is no longer listed under this account.
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
 * Removes one host from the signed-in account with the user bearer.
 * Never throws - every failure collapses into the discriminated result so callers branch on `kind` instead of `try`/`catch`.
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
  // A thrown `fetch` - transport failure or the per-attempt timeout - is
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
  // The 200 body (`{host_id, deregistered}`) carries nothing a caller needs that it did not already know, so a body that fails to parse is not a reason to report failure for a removal the server has already committed.
  return { kind: "ok" };
}
