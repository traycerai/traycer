import { attachGrantResponseSchema } from "@traycer/protocol/host/attach-grant";
import {
  SANDBOX_REFUSAL_CODE_FROZEN,
  sandboxRefusalBodySchema,
} from "@traycer/protocol/host/sandbox-control";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type {
  AttachGrant,
  AttachGrantFailure,
  AttachGrantProvider,
  AttachGrantProvision,
} from "@traycer/protocol/host-transport/remote/grant";
import { SANDBOX_FROZEN_MESSAGE } from "../../host-client/sandbox-control";

export type {
  AttachGrant,
  AttachGrantFailure,
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
 *  - `sandbox-frozen`  — authn refused the mint because the target is a
 *                        sandbox frozen for lack of credits (`402` with code
 *                        `sandbox_frozen`): a verdict, not a transient, so
 *                        the session ends on it instead of retrying.
 *  - `network-error`   — transient transport/timeout/5xx or a malformed body.
 *
 * Every non-`ok` result carries a human-readable `detail`. Not decoration: this mint is the first step of a silently
 * forever-retrying connect loop, and the detail is the only place the actual
 * fault (DNS? 401? 500 body?) survives into the session's `DialFailureLog`.
 */
export type AttachGrantResult =
  | {
      readonly kind: "ok";
      readonly grant: AttachGrant;
      /**
       * The host-bound session grant authn mints beside the attach grant for a
       * `kind: sandbox` target, or `null` for every other target. Presented in
       * `OPEN.authz` v2 instead of the user bearer; see
       * {@link createSandboxAttachGrantProvider}.
       */
      readonly sessionGrant: string | null;
    }
  | ({ readonly kind: "unauthorized" } & AttachGrantFailure)
  | ({ readonly kind: "sandbox-frozen" } & AttachGrantFailure)
  | ({ readonly kind: "network-error" } & AttachGrantFailure);

/**
 * How this client fills the protocol's `AttachGrantFailure` — the shape is
 * protocol-owned (`@traycer/protocol/host-transport/remote/grant`) because the
 * session core that consumes it lives there; the SEMANTICS below are this
 * client's, split along the line `DialFailureLog` dedups on.
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

/**
 * Hard cap on how much of a FAILURE body is pulled off the wire at all. Only
 * {@link BODY_SNIPPET_CAP} characters of it ever survive into a log line, and a
 * 5xx here enters the session's forever-retrying mint loop — so buffering a
 * whole error page or a proxy's HTML on every attempt allocates its full size
 * over and over inside the renderer for text nobody reads. Sized far above any
 * real authn error body.
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
    return {
      kind: "unauthorized",
      detail: `authn rejected the mint with HTTP ${response.status}`,
      context: authnSaid(bodyText),
    };
  }
  if (response.status === 402) {
    const bodyText = await readBodyText(response);
    if (isSandboxFrozenRefusal(bodyText)) {
      return {
        kind: "sandbox-frozen",
        detail: `authn refused the mint: the sandbox is frozen (HTTP 402 ${SANDBOX_REFUSAL_CODE_FROZEN})`,
        context: authnSaid(bodyText),
      };
    }
    return {
      kind: "network-error",
      detail: `authn answered HTTP ${response.status}`,
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
    sessionGrant: parsed.data.session_grant ?? null,
  };
}

/** Whether a `402` body is authn's typed frozen-sandbox refusal. */
function isSandboxFrozenRefusal(bodyText: string): boolean {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return false;
  }
  const parsed = sandboxRefusalBodySchema.safeParse(body);
  return parsed.success && parsed.data.code === SANDBOX_REFUSAL_CODE_FROZEN;
}

/**
 * The fatal a frozen sandbox's refused mint ends the session on: the same
 * typed `SANDBOX_FROZEN` refusal, and copy, the host itself answers a frozen
 * sandbox's calls with, so every surface renders it the same way.
 */
const SANDBOX_FROZEN_FATAL: FatalErrorDetails = {
  code: "SANDBOX_FROZEN",
  reason: SANDBOX_FROZEN_MESSAGE,
  incompatibleMethods: null,
  upgradeGuidance: null,
};

/** A failed mint as the session's provision: terminal only for a frozen sandbox. */
function provisionOfFailedMint(
  result: Exclude<AttachGrantResult, { readonly kind: "ok" }>,
): AttachGrantProvision {
  if (result.kind === "sandbox-frozen") {
    return {
      kind: "refused",
      fatal: SANDBOX_FROZEN_FATAL,
      detail: result.detail,
      context: result.context,
    };
  }
  return {
    kind: "unavailable",
    detail: result.detail,
    context: result.context,
  };
}

/**
 * Builds an `AttachGrantProvider` bound to a host + bearer source. Every
 * non-`ok` mint but one collapses to `unavailable` (reconnect backoff — a
 * transient CS blip must not hard-fail the session; the re-auth bound still
 * fail-closes a genuinely revoked host at its next relay deadline). The one is
 * a frozen sandbox, which is `refused`: no retry can mint for it until its
 * credits are topped up.
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
    return provisionOfFailedMint(result);
  };
}

/** A sandbox target's grant provider plus the session grant it last minted. */
export interface SandboxAttachGrantSource {
  readonly provider: AttachGrantProvider;
  /**
   * The session grant minted with the most recent attach grant, or `null`
   * before the first successful mint. The session calls the provider on every
   * attach and resume and only then builds its `OPEN`, so the grant read here
   * is always the one minted for the attach in progress.
   */
  readonly readSessionGrant: () => string | null;
}

/**
 * The attach-grant provider for a `kind: sandbox` target (seam C1).
 *
 * Differs from {@link createAttachGrantProvider} in two ways, both about
 * keeping the user's credential off a machine whose kernel the user does not
 * own:
 *
 *  1. The mint must come back with a session grant. A 2xx without one fails
 *     closed (`unavailable`) rather than falling back to the user bearer.
 *  2. The session grant, not the user bearer, is what `OPEN` presents (see
 *     `RemoteSessionOptions.sessionGrant`).
 *
 * Waking a suspended or stopped sandbox is NOT this provider's job: such a
 * host reads `offline` in the directory and is never dialed, so the wake runs
 * at tab open (`ensureSandboxAwake` in `host-client/sandbox-control.ts`) and
 * the dial follows once the host list says `awake`. A reconnect loop that
 * woke sandboxes would keep a forgotten tab's metered machine awake forever.
 */
export function createSandboxAttachGrantProvider(deps: {
  readonly authnBaseUrl: string;
  readonly hostId: string;
  readonly getBearerToken: () => string | null;
}): SandboxAttachGrantSource {
  let latestSessionGrant: string | null = null;
  const provider: AttachGrantProvider = async () => {
    const bearerToken = deps.getBearerToken();
    if (bearerToken === null) {
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
    if (result.kind !== "ok") {
      return provisionOfFailedMint(result);
    }
    if (result.sessionGrant === null) {
      return {
        kind: "unavailable",
        detail: "authn minted no session grant for a sandbox target",
        context: "",
      };
    }
    latestSessionGrant = result.sessionGrant;
    return { kind: "ok", grant: result.grant };
  };
  return {
    provider,
    readSessionGrant: () => latestSessionGrant,
  };
}
