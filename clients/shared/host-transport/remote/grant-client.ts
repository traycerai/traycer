import { attachGrantResponseSchema } from "@traycer/protocol/host/attach-grant";
import type {
  AttachGrant,
  AttachGrantProvider,
} from "@traycer/protocol/host-transport/remote/grant";

export type {
  AttachGrant,
  AttachGrantProvider,
  AttachGrantProvision,
} from "@traycer/protocol/host-transport/remote/grant";

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
 *
 * Every non-`ok`, non-`plan-restricted` result carries a human-readable
 * `detail`. Not decoration: this mint is the first step of a silently
 * forever-retrying connect loop, and the detail is the only place the actual
 * fault (DNS? 401? 500 body?) survives into the session's `DialFailureLog`.
 */
export type AttachGrantResult =
  | { readonly kind: "ok"; readonly grant: AttachGrant }
  | ({ readonly kind: "unauthorized" } & AttachGrantFailure)
  | { readonly kind: "plan-restricted" }
  | ({ readonly kind: "network-error" } & AttachGrantFailure);

/**
 * Why a mint failed, split along the line `DialFailureLog` dedups on.
 *
 * `detail` is the STABLE classification (the status, the failure class) and
 * doubles as that log's dedup key, so it must stay identical across retries of
 * the same fault. `context` is the per-attempt text — whatever the server said
 * (a proxy request id, a timestamp, a varying backend message) or, for a
 * transport-level throw, the address THIS attempt happened to resolve.
 * Folding the two together would make every single retry look like a cause
 * change, bypass the log's throttle, and re-create the ~120-lines-per-hour
 * flood it exists to prevent.
 *
 * `context` is a COMPLETE phrase, not a fragment: it names its own source
 * ("authn said: …" vs "connect ECONNREFUSED …"), because the two failure
 * families reach the log through the same field and attributing a DNS failure
 * to something authn said would be worse than saying nothing. `""` when there
 * is nothing to add beyond `detail`.
 */
interface AttachGrantFailure {
  readonly detail: string;
  readonly context: string;
}

/**
 * Reads a 401/403 body TEXT looking for the attach-grant entitlement denial
 * (`reason: "plan_restricted"` — CS's `HOST_CONNECTIVITY_DENIAL_REASON`).
 * Any parse failure means "not plan-restricted": the caller then treats the
 * status as an ordinary credential rejection, the safe default. Takes the
 * already-read text (not the `Response`) so the same single body read also
 * feeds the failure detail — a `Response` body can only be consumed once.
 */
function isPlanRestrictedBody(bodyText: string): boolean {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return false;
  }
  if (typeof body !== "object" || body === null) {
    return false;
  }
  return (body as Record<string, unknown>).reason === "plan_restricted";
}

/**
 * Hard cap on how much of a FAILURE body is pulled off the wire at all. Only
 * {@link BODY_SNIPPET_CAP} characters of it ever survive into a log line, and a
 * 5xx here enters the session's forever-retrying mint loop — so buffering a
 * whole error page or a proxy's HTML on every attempt allocates its full size
 * over and over inside the renderer for text nobody reads. Sized far above any
 * real authn error body so {@link isPlanRestrictedBody} still parses a
 * complete JSON document.
 */
const BODY_READ_CAP_BYTES = 64 * 1024;

/**
 * The response body as text, or `""` when it cannot be read. Never throws.
 *
 * Reads from the body STREAM and stops at {@link BODY_READ_CAP_BYTES} rather
 * than calling `response.text()`, which would materialize and decode the whole
 * body before anything downstream got the chance to truncate it. The remainder
 * is cancelled, not drained.
 *
 * `response.text()` is used only when the response exposes no stream at all (a
 * body-less response) — there is nothing to bound in that case.
 */
async function readBodyText(response: Response): Promise<string> {
  const body = response.body;
  if (body === null || body === undefined) {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  try {
    while (bytesRead < BODY_READ_CAP_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      // Decode at most the REMAINING budget, not the whole chunk. The loop
      // only re-checks the cap between reads, so a single oversized chunk
      // would otherwise be decoded in full — into a JS string, which is the
      // expensive half — and the advertised hard cap would bound nothing.
      const remaining = BODY_READ_CAP_BYTES - bytesRead;
      bytesRead += chunk.value.byteLength;
      text += decoder.decode(
        chunk.value.byteLength > remaining
          ? chunk.value.subarray(0, remaining)
          : chunk.value,
        { stream: true },
      );
    }
    text += decoder.decode();
  } catch {
    // Whatever arrived before the stream broke is still worth logging.
  } finally {
    // Releases the connection instead of leaving the rest of an oversized
    // body to be drained into memory we just decided not to read.
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/**
 * A failure body, flattened onto one line and capped, for a log detail. A
 * server error body frequently names the whole outage on its own (an authn
 * missing-signing-key 500 did exactly that), so it is worth carrying — capped
 * because it comes off the wire. NEVER applied to a 2xx body: that carries
 * the grant itself and must not reach a log line.
 *
 * Returned as a complete, self-attributing phrase — see the `context` note on
 * {@link AttachGrantFailure} for why the source is named here rather than
 * bolted on by the log.
 */
const BODY_SNIPPET_CAP = 200;

function authnSaid(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return "";
  }
  const snippet =
    collapsed.length <= BODY_SNIPPET_CAP
      ? collapsed
      : `${collapsed.slice(0, BODY_SNIPPET_CAP)}...`;
  return `authn said: ${snippet}`;
}

/**
 * Node/Chromium `fetch` throws a bare `TypeError: fetch failed`-style error
 * and hangs the discriminating reason (DNS, refused, TLS, the timeout signal)
 * off `cause` where one exists. Unwrap one level so those read differently.
 *
 * Split, for the same reason the response path is: the cause's MESSAGE carries
 * per-attempt text — `connect ECONNREFUSED 10.0.0.1:443` names the address this
 * attempt happened to resolve, so a multi-address endpoint rotates it on every
 * retry of ONE unchanged outage. Only `classification` may reach the dedup key;
 * the message rides along as context nothing compares.
 */
interface FetchFailureDescription {
  /** Error class plus the cause's `code` — stable across retries of one fault. */
  readonly classification: string;
  /** The human text, addresses and all. Reported, never compared. */
  readonly message: string;
}

function describeFetchFailure(error: unknown): FetchFailureDescription {
  if (!(error instanceof Error)) {
    // Nothing here is trustworthy as a key: a thrown string or object has no
    // class to speak of, so the whole value is context and the key is the fact
    // that something non-Error came out.
    return { classification: "a non-Error throw", message: String(error) };
  }
  const cause: unknown = error.cause;
  if (!(cause instanceof Error)) {
    return { classification: error.name, message: error.message };
  }
  // `code` is the stable discriminator (`ECONNREFUSED` / `ENOTFOUND` / the TLS
  // error code); `cause.name` is the fallback when the platform did not attach
  // one, and is stable for the same reason `error.name` is.
  const code = readErrorCode(cause);
  return {
    classification: `${error.name} [${code ?? cause.name}]`,
    message: `${error.message}: ${cause.message}`,
  };
}

function readErrorCode(error: Error): string | null {
  if (!("code" in error)) {
    return null;
  }
  const code: unknown = error.code;
  return typeof code === "string" ? code : null;
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
  } catch (error) {
    const failure = describeFetchFailure(error);
    return {
      kind: "network-error",
      detail: `the mint request never completed (${failure.classification})`,
      context: failure.message,
    };
  }

  if (response.status === 401 || response.status === 403) {
    const bodyText = await readBodyText(response);
    if (isPlanRestrictedBody(bodyText)) {
      return { kind: "plan-restricted" };
    }
    return {
      kind: "unauthorized",
      detail: `authn rejected the mint with HTTP ${response.status}`,
      context: authnSaid(bodyText),
    };
  }
  if (response.status < 200 || response.status >= 300) {
    const bodyText = await readBodyText(response);
    return {
      kind: "network-error",
      detail: `authn answered HTTP ${response.status}`,
      context: authnSaid(bodyText),
    };
  }

  // NOTE: no body snippet from here down — a 2xx body carries the grant.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      kind: "network-error",
      detail: `authn answered HTTP ${response.status} with a body that is not valid JSON`,
      context: "",
    };
  }

  const parsed = attachGrantResponseSchema.safeParse(body);
  if (!parsed.success) {
    return {
      kind: "network-error",
      detail: `authn answered HTTP ${response.status} but the body is not an attach grant`,
      context: "",
    };
  }
  return {
    kind: "ok",
    grant: {
      grant: parsed.data.grant,
      expiresInSeconds: parsed.data.expires_in,
    },
  };
}

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
      // Not a mint failure at all — there is no user bearer to mint WITH.
      // Worth its own wording: it points at sign-in/token state, not authn.
      return {
        kind: "unavailable",
        detail: "no user bearer available (signed out?)",
        context: "",
      };
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
    return {
      kind: "unavailable",
      detail: result.detail,
      context: result.context,
    };
  };
}
