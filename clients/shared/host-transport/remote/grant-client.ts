import { attachGrantResponseSchema } from "@traycer/protocol/host/attach-grant";

/**
 * Client-leg attach-grant acquisition (Architecture §2, §4b; relay-do readme).
 * The bearer never touches the relay (must not); it authorizes identity in-channel via the mux `open{bearer}` frame instead (R4-A2 bridging-never-identity).
 */

const GRANT_FETCH_TIMEOUT_MS = 10_000;

export interface AttachGrant {
  readonly grant: string;
  /** Grant lifetime in seconds, from T9's `expires_in`. */
  readonly expiresInSeconds: number;
}

/**
 * Outcome of an attach-grant mint.
 * Discriminated + structured-clone-safe, so it can cross the Electron IPC boundary unchanged (mirrors `HostListFetchResult`): - `ok` - the grant to present to the relay.
 */
export type AttachGrantResult =
  | { readonly kind: "ok"; readonly grant: AttachGrant }
  | ({ readonly kind: "unauthorized" } & AttachGrantFailure)
  | { readonly kind: "plan-restricted" }
  | ({ readonly kind: "network-error" } & AttachGrantFailure);

  /**
   * Why a mint failed, split along the line `DialFailureLog` dedups on.
   * `detail` is the stable classification (the status, the failure class) and doubles as that log's dedup key, so it must stay identical across retries of the same fault.
   */
interface AttachGrantFailure {
  readonly detail: string;
  readonly context: string;
}

/**
 * Reads a 401/403 body text looking for the attach-grant entitlement denial (`reason: "plan_restricted"` - CS's `HOST_CONNECTIVITY_DENIAL_REASON`).
 * Takes the already-read text (not the `Response`) so the same single body read also feeds the failure detail - a `Response` body can only be consumed once.
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

const BODY_READ_CAP_BYTES = 64 * 1024;

/**
 * The response body as text, or `""` when it cannot be read.
 * Never throws.
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
      // Decode at most the remaining budget, not the whole chunk.
      // The loop only re-checks the cap between reads, so a single oversized chunk would otherwise be decoded in full - into a JS string, which is the expensive half - and the advertised hard cap would bound nothing.
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
 * A failure body, flattened onto one line and capped, for a log detail.
 * Never applied to a 2xx body: that carries the grant itself and must not reach a log line.
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
 * Node/Chromium `fetch` throws a bare `TypeError: fetch failed`-style error and hangs the discriminating reason (dns, refused, TLS, the timeout signal) off `cause` where one exists.
 */
interface FetchFailureDescription {
  /** Error class plus the cause's `code` - stable across retries of one fault. */
  readonly classification: string;
  /** The human text, addresses and all. Reported, never compared. */
  readonly message: string;
}

function describeFetchFailure(error: unknown): FetchFailureDescription {
  if (!(error instanceof Error)) {
    // Nothing here is trustworthy as a key: a thrown string or object has no class to speak of, so the whole value is context and the key is the fact that something non-Error came out.
    return { classification: "a non-Error throw", message: String(error) };
  }
  const cause: unknown = error.cause;
  if (!(cause instanceof Error)) {
    return { classification: error.name, message: error.message };
  }
  // `code` is the stable discriminator (`econnrefused` / `enotfound` / the TLS error code); `cause.name` is the fallback when the platform did not attach one, and is stable for the same reason `error.name` is.
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
 * Mints a fresh `role:"client"` attach grant for `hostId`. Never throws - every
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

  // NOTE: no body snippet from here down - a 2xx body carries the grant.
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

export type AttachGrantProvision =
  | { readonly kind: "ok"; readonly grant: AttachGrant }
  /**
   * Entitlement denial (`plan_restricted`): the account's plan lacks remote
   * connectivity. The session goes terminal-fatal - backoff cannot fix a plan.
   */
  | { readonly kind: "plan-restricted" }
  /**
   * Signed out / revoked / transient failure - stay in reconnect backoff.
   * `detail` says which, in words, for the session's `DialFailureLog`: the retry cadence is the same for all of them, so this is the only place the distinction survives.
   */
  | ({ readonly kind: "unavailable" } & AttachGrantFailure);

export type AttachGrantProvider = () => Promise<AttachGrantProvision>;

/** Builds an `AttachGrantProvider` bound to a host + bearer source. */
export function createAttachGrantProvider(deps: {
  readonly authnBaseUrl: string;
  readonly hostId: string;
  readonly getBearerToken: () => string | null;
}): AttachGrantProvider {
  return async () => {
    const bearerToken = deps.getBearerToken();
    if (bearerToken === null) {
    // Not a mint failure at all - there is no user bearer to mint with.
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
