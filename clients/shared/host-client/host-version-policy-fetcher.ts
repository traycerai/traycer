import {
  hostVersionPolicyResponseSchema,
  type HostUpdatePolicy,
} from "@traycer/protocol/host/host-status";

/**
 * "Update now" / auto-policy toggle / "Apply now — ends N sessions"
 * (Architecture §13, T16). `updateHostVersionPolicyViaHttp` is the raw
 * `PATCH /api/v3/hosts/:hostId` call — transport-only, sibling to
 * `fetchRegisteredHostsViaHttp` in `remote-fetcher.ts`. Like the other host
 * HTTP helpers it may run wherever CORS permits: desktop runs it in Electron
 * main (renderer-origin CORS would otherwise block authn-v3), browser/dev
 * shells call it directly. The renderer reaches it through
 * `IRunnerHost.updateHostVersionPolicy(...)`.
 *
 * This write is a registry-only mutation picked up by the host on its next
 * heartbeat (≤ ~20s) — no live session to the host is required, which is the
 * whole point (it works even when the client and host have drifted apart).
 */

/** Per-request budget, mirrors `HOST_LIST_FETCH_TIMEOUT_MS`. */
const HOST_VERSION_POLICY_FETCH_TIMEOUT_MS = 10_000;

/**
 * Request body for `PATCH /api/v3/hosts/:hostId`. Every field is tri-state
 * (`undefined` = leave untouched) — mirrors authn-v3's own `PatchHostBody` /
 * `UpdateHostVersionPolicyInput` exactly, so the wire contract stays a single
 * source of truth. At least one field must be non-`undefined` (the server
 * 400s otherwise); callers are responsible for that invariant.
 */
export type UpdateHostVersionPolicyInput = {
  readonly updatePolicy: HostUpdatePolicy | undefined;
  /** `null` clears the desired version (hold — no pending update). */
  readonly desiredVersion: string | null | undefined;
  /**
   * "Apply now — ends N sessions" (the drain-gate force). `true` authorizes
   * the host to bypass waiting for open sessions for whatever
   * `desiredVersion` this call leaves in place; omitted/`false` is never an
   * implicit force.
   */
  readonly force: boolean | undefined;
};

export type HostVersionPolicyResult = {
  readonly hostId: string;
  readonly updatePolicy: HostUpdatePolicy;
  readonly desiredVersion: string | null;
};

/**
 * Outcome of a `PATCH /api/v3/hosts/:hostId` call. A discriminated,
 * structured-clone-safe shape (mirrors `HostListFetchResult`) so it crosses
 * the Electron IPC boundary unchanged:
 *  - `ok`            — the applied policy, echoed back by the server.
 *  - `not-found`      — the host doesn't exist or isn't owned by the caller
 *                       (404; never leaks existence across owners).
 *  - `invalid`        — the request body failed server-side validation
 *                       (400) — should not happen once the caller validates
 *                       client-side, but surfaced distinctly rather than
 *                       folded into `network-error` so a genuine bug isn't
 *                       mistaken for a transient outage.
 *  - `unauthorized`   — the bearer was rejected (401/403).
 *  - `network-error`  — transient transport/timeout/5xx or a malformed body.
 */
export type UpdateHostVersionPolicyFetchResult =
  | { readonly kind: "ok"; readonly result: HostVersionPolicyResult }
  | { readonly kind: "not-found" }
  | { readonly kind: "invalid" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

function hostPatchUrl(authnBaseUrl: string, hostId: string): string {
  const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
  return new URL(`api/v3/hosts/${encodeURIComponent(hostId)}`, base).toString();
}

/**
 * Applies a version-policy write for one host with the user bearer. Never
 * throws — every failure collapses into the discriminated result so callers
 * branch on `kind` instead of `try`/`catch`.
 */
export async function updateHostVersionPolicyViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  hostId: string,
  input: UpdateHostVersionPolicyInput,
): Promise<UpdateHostVersionPolicyFetchResult> {
  let response: Response;
  try {
    response = await fetch(hostPatchUrl(authnBaseUrl, hostId), {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      // `JSON.stringify` drops `undefined`-valued keys entirely, so an
      // untouched field never reaches the server — exactly the tri-state
      // contract `UpdateHostVersionPolicyInput` and authn-v3's parser share.
      body: JSON.stringify({
        updatePolicy: input.updatePolicy,
        desiredVersion: input.desiredVersion,
        force: input.force,
      }),
      signal: AbortSignal.timeout(HOST_VERSION_POLICY_FETCH_TIMEOUT_MS),
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
  if (response.status === 400) {
    return { kind: "invalid" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "network-error" };
  }

  const parsed = hostVersionPolicyResponseSchema.safeParse(body);
  if (!parsed.success) {
    // A 2xx that does not match the contract is treated as transient rather
    // than mis-rendered — fails closed like the other host HTTP helpers.
    return { kind: "network-error" };
  }
  return {
    kind: "ok",
    result: {
      hostId: parsed.data.host_id,
      updatePolicy: parsed.data.update_policy,
      desiredVersion: parsed.data.desired_version,
    },
  };
}
