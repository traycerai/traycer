import { attachGrantResponseSchema } from "@traycer/protocol/host/attach-grant";

/**
 * Client-leg attach-grant acquisition (Architecture §2, §4b; relay-do README).
 *
 * The client calls `POST /api/v3/hosts/:id/attach-grant` with its user bearer to
 * mint a fresh, single-use, offline-verifiable `role:"client"` attach grant
 * (`{aud:"relay", typ:"attach-grant", rendezvousId, role, exp≤5m, jti}`). The
 * grant authorizes the relay to bridge this session — nothing else. The bearer
 * NEVER touches the relay (MUST NOT); it authorizes identity in-channel via the
 * mux `open{bearer}` frame instead (R4-A2 bridging-never-identity).
 *
 * A fresh grant is minted for every attach AND every resume (grants stay
 * one-time; v1 has no resume tickets, R4-E3).
 *
 * Response shape matches the live T9 endpoint
 * (`authn-v3/.../hosts/_hostId/attach-grant`): `{ grant: string, role: string,
 * expires_in: number }` (snake_case, seconds). The client ignores `role` — it
 * just presents the opaque `grant` to the relay. `rendezvousId` is opaque to the
 * client (the relay reads it from the verified grant, R4-A5), so it is not
 * returned here.
 */

const GRANT_FETCH_TIMEOUT_MS = 10_000;

/** A minted attach grant ready to present to the relay. */
export interface AttachGrant {
  readonly grant: string;
  /** Grant lifetime in seconds, from T9's `expires_in`. */
  readonly expiresInSeconds: number;
}

/**
 * Outcome of an attach-grant mint. Discriminated + structured-clone-safe, so it
 * can cross the Electron IPC boundary unchanged (mirrors `HostListFetchResult`):
 *  - `ok`              — the grant to present to the relay.
 *  - `unauthorized`    — the bearer was rejected OR the host is revoked / not
 *                        owned (401/403); the caller decides whether to revalidate.
 *  - `plan-restricted` — 403 with `reason: "plan_restricted"`: the account's
 *                        plan does not include remote host connectivity. The
 *                        bearer is VALID — never treat this as an auth failure
 *                        or retry it; it clears only when the owner upgrades.
 *  - `network-error`   — transient transport/timeout/5xx or a malformed body.
 */
export type AttachGrantResult =
  | { readonly kind: "ok"; readonly grant: AttachGrant }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "plan-restricted" }
  | { readonly kind: "network-error" };

/**
 * Reads a 401/403 body looking for the attach-grant entitlement denial
 * (`reason: "plan_restricted"` — CS's `HOST_CONNECTIVITY_DENIAL_REASON`).
 * Any read/parse failure means "not plan-restricted": the caller then treats
 * the status as an ordinary credential rejection, the safe default.
 */
async function isPlanRestrictedBody(response: Response): Promise<boolean> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return false;
  }
  if (typeof body !== "object" || body === null) {
    return false;
  }
  return (body as Record<string, unknown>).reason === "plan_restricted";
}

function attachGrantUrl(authnBaseUrl: string, hostId: string): string {
  const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
  return new URL(
    `api/v3/hosts/${encodeURIComponent(hostId)}/attach-grant`,
    base,
  ).toString();
}

/**
 * Mints a fresh `role:"client"` attach grant for `hostId`. Never throws — every
 * failure collapses into the discriminated result so callers branch on `kind`.
 */
export async function mintAttachGrantViaHttp(
  authnBaseUrl: string,
  hostId: string,
  bearerToken: string,
): Promise<AttachGrantResult> {
  let response: Response;
  try {
    response = await fetch(attachGrantUrl(authnBaseUrl, hostId), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ role: "client" }),
      signal: AbortSignal.timeout(GRANT_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { kind: "network-error" };
  }

  if (response.status === 401 || response.status === 403) {
    if (await isPlanRestrictedBody(response)) {
      return { kind: "plan-restricted" };
    }
    return { kind: "unauthorized" };
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

  const parsed = attachGrantResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { kind: "network-error" };
  }
  return {
    kind: "ok",
    grant: {
      grant: parsed.data.grant,
      expiresInSeconds: parsed.data.expires_in,
    },
  };
}

/** What a grant-provider call yielded — the session picks its response by kind. */
export type AttachGrantProvision =
  | { readonly kind: "ok"; readonly grant: AttachGrant }
  /**
   * Entitlement denial (`plan_restricted`): the account's plan lacks remote
   * connectivity. The session goes terminal-fatal — backoff cannot fix a plan.
   */
  | { readonly kind: "plan-restricted" }
  /** Signed out / revoked / transient failure — stay in reconnect backoff. */
  | { readonly kind: "unavailable" };

/** Injectable grant source the session calls on attach + resume + re-auth. */
export type AttachGrantProvider = () => Promise<AttachGrantProvision>;

/**
 * Builds an `AttachGrantProvider` bound to a host + bearer source. Every
 * non-`ok` mint collapses to `unavailable` (reconnect backoff — a transient CS
 * blip must not hard-fail the session; the re-auth bound still fail-closes a
 * genuinely revoked host at its next relay deadline) EXCEPT the
 * plan-restricted entitlement denial, which is surfaced so the session can go
 * terminal instead of dialing a relay it will never be granted.
 */
export function createAttachGrantProvider(deps: {
  readonly authnBaseUrl: string;
  readonly hostId: string;
  readonly getBearerToken: () => string | null;
}): AttachGrantProvider {
  return async () => {
    const bearerToken = deps.getBearerToken();
    if (bearerToken === null) {
      return { kind: "unavailable" };
    }
    const result = await mintAttachGrantViaHttp(
      deps.authnBaseUrl,
      deps.hostId,
      bearerToken,
    );
    if (result.kind === "ok") {
      return { kind: "ok", grant: result.grant };
    }
    if (result.kind === "plan-restricted") {
      return { kind: "plan-restricted" };
    }
    return { kind: "unavailable" };
  };
}
