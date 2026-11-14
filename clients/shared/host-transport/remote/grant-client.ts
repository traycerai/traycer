import { z } from "zod";
import { attachGrantResponseSchema } from "@traycer/protocol/host/attach-grant";
import { hostSessionGrantResponseSchema } from "@traycer/protocol/host/session-grant";
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
import { composeRequestAbort, untilAborted } from "../../auth/request-abort";
import type { HostTokenMintOutcome } from "../../auth/host-token-source";
import type { HostToken } from "../../auth/host-token-store";
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
       * sandbox or team-principal target, or `null` for a personal computer. Presented in
       * `OPEN.authz` v2 instead of the user bearer; see
       * {@link createSandboxAttachGrantProvider}.
       */
      readonly sessionGrant: string | null;
    }
  | ({ readonly kind: "unauthorized" } & AttachGrantFailure)
  | ({ readonly kind: "team-membership-required" } & AttachGrantFailure)
  | ({ readonly kind: "team-membership-unavailable" } & AttachGrantFailure)
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
async function readBodyText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const body = response.body;
  if (body === null || body === undefined) {
    try {
      return await untilAborted(response.text(), signal);
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
      const chunk = await untilAborted(reader.read(), signal);
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
  return mintAttachGrantForPurpose(
    authnBaseUrl,
    hostId,
    bearerToken,
    "remote",
    null,
  );
}

type AttachGrantPurpose = "remote" | "local";

async function mintAttachGrantForPurpose(
  authnBaseUrl: string,
  hostId: string,
  bearerToken: string,
  purpose: AttachGrantPurpose,
  signal: AbortSignal | null,
): Promise<AttachGrantResult> {
  // Not `AbortSignal.timeout`, which the iOS WebView floor lacks; see
  // `request-abort.ts`. Cleared once the body is read, which the timeout also
  // bounds.
  const abort = composeRequestAbort(signal, GRANT_FETCH_TIMEOUT_MS);
  try {
    return await mintAttachGrantWithSignal(
      authnBaseUrl,
      hostId,
      bearerToken,
      purpose,
      abort.signal,
    );
  } finally {
    abort.clear();
  }
}

async function mintAttachGrantWithSignal(
  authnBaseUrl: string,
  hostId: string,
  bearerToken: string,
  purpose: AttachGrantPurpose,
  signal: AbortSignal,
): Promise<AttachGrantResult> {
  let response: Response;
  try {
    response = await untilAborted(
      fetch(attachGrantUrl(authnBaseUrl, hostId), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(
          purpose === "local"
            ? { role: "client", purpose: "local" }
            : { role: "client" },
        ),
        signal,
      }),
      signal,
    );
  } catch (error) {
    const failure = describeFetchFailure(error);
    return {
      kind: "network-error",
      detail: `the mint request never completed (${failure.classification})`,
      context: failure.message,
    };
  }

  // Membership codes precede generic auth statuses; 404 stays nondisclosing.
  if (response.status < 200 || response.status >= 300) {
    const bodyText = await readBodyText(response, signal);
    const code = membershipRefusalCode(bodyText);
    if (response.status === 404 || code === "team_membership_required") {
      return {
        kind: "team-membership-required",
        detail: "membership refused",
        context: "",
      };
    }
    if (code === "team_membership_unavailable") {
      return {
        kind: "team-membership-unavailable",
        detail: "membership could not be checked",
        context: "",
      };
    }
    return classifyOtherRefusal(response.status, bodyText);
  }

  // NOTE: no body snippet from here down — a 2xx body carries the grant.
  let body: unknown;
  try {
    body = await untilAborted(response.json(), signal);
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

function membershipRefusalCode(bodyText: string): string | null {
  try {
    const body: unknown = JSON.parse(bodyText);
    return typeof body === "object" &&
      body !== null &&
      "code" in body &&
      typeof body.code === "string"
      ? body.code
      : null;
  } catch {
    return null;
  }
}

function classifyOtherRefusal(
  status: number,
  bodyText: string,
): Exclude<AttachGrantResult, { readonly kind: "ok" }> {
  if (status === 401 || status === 403) {
    return {
      kind: "unauthorized",
      detail: `authn rejected the mint with HTTP ${status}`,
      context: authnSaid(bodyText),
    };
  }
  if (status === 402 && isSandboxFrozenRefusal(bodyText)) {
    return {
      kind: "sandbox-frozen",
      detail: `authn refused the mint: the sandbox is frozen (HTTP 402 ${SANDBOX_REFUSAL_CODE_FROZEN})`,
      context: authnSaid(bodyText),
    };
  }
  return {
    kind: "network-error",
    detail: `authn answered HTTP ${status}`,
    context: authnSaid(bodyText),
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

const TEAM_MEMBERSHIP_REQUIRED: FatalErrorDetails = {
  code: "TEAM_MEMBERSHIP_REQUIRED",
  reason:
    "This account cannot access this computer. Switch accounts to use it.",
  retryable: false,
  incompatibleMethods: null,
  upgradeGuidance: null,
};

const TEAM_MEMBERSHIP_UNAVAILABLE: FatalErrorDetails = {
  code: "TEAM_MEMBERSHIP_UNAVAILABLE",
  reason:
    "Membership could not be checked. Check your connection and try again.",
  retryable: true,
  incompatibleMethods: null,
  upgradeGuidance: null,
};

/** Preserve a membership verdict instead of retrying it as a network failure. */
function provisionOfFailedMint(
  result: Exclude<AttachGrantResult, { readonly kind: "ok" }>,
): AttachGrantProvision {
  if (result.kind === "team-membership-required") {
    return {
      kind: "refused",
      fatal: TEAM_MEMBERSHIP_REQUIRED,
      detail: result.detail,
      context: "",
    };
  }
  if (result.kind === "team-membership-unavailable") {
    return {
      kind: "unavailable",
      retryCause: TEAM_MEMBERSHIP_UNAVAILABLE,
      detail: result.detail,
      context: "",
    };
  }
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
 * Builds an attach-grant source. Membership and frozen-sandbox verdicts are
 * terminal; an authn outage retains reconnect backoff.
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

/** A sandbox or team computer's provider and its latest session grant. */
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
 * The session-grant provider for a sandbox or a team-owned computer.
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
  readonly purpose: AttachGrantPurpose;
  readonly signal?: AbortSignal;
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
    const result = await mintAttachGrantForPurpose(
      deps.authnBaseUrl,
      deps.hostId,
      bearerToken,
      deps.purpose,
      deps.signal ?? null,
    );
    if (result.kind !== "ok") {
      const provision = provisionOfFailedMint(result);
      return provision.kind === "unavailable"
        ? { ...provision, retryCause: TEAM_MEMBERSHIP_UNAVAILABLE }
        : provision;
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

/** The attach-grant answer to `session_grant_version: 2`: the pass and the token both. */
const relayPassWithHostTokenSchema = z.object({
  grant: z.string().min(1),
  expires_in: z.number(),
  session_grant: z.string().min(1),
  session_grant_expires_in: z.number().positive(),
});

const TEAM_MEMBERSHIP_REQUIRED_CODE = "team_membership_required";

function hostRouteUrl(
  authnBaseUrl: string,
  hostId: string,
  route: "session-grant" | "attach-grant",
): string {
  const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
  return new URL(
    `api/v3/hosts/${encodeURIComponent(hostId)}/${route}`,
    base,
  ).toString();
}

type HostRouteAnswer =
  | { readonly kind: "answered"; readonly body: unknown }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly bodyText: string;
    }
  | { readonly kind: "unavailable"; readonly detail: string };

async function postHostRoute(
  url: string,
  signInToken: string,
  body: string | null,
  signal: AbortSignal | null,
): Promise<HostRouteAnswer> {
  const abort = composeRequestAbort(signal, GRANT_FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await untilAborted(
        fetch(url, {
          method: "POST",
          headers:
            body === null
              ? {
                  Authorization: `Bearer ${signInToken}`,
                  Accept: "application/json",
                }
              : {
                  Authorization: `Bearer ${signInToken}`,
                  "Content-Type": "application/json",
                  Accept: "application/json",
                },
          ...(body === null ? {} : { body }),
          signal: abort.signal,
        }),
        abort.signal,
      );
    } catch (error) {
      return {
        kind: "unavailable",
        detail: `the mint request never completed (${describeFetchFailure(error).classification})`,
      };
    }
    if (response.status < 200 || response.status >= 300)
      return {
        kind: "refused",
        status: response.status,
        bodyText: await readBodyText(response, abort.signal),
      };
    try {
      return {
        kind: "answered",
        body: await untilAborted(response.json(), abort.signal),
      };
    } catch {
      return {
        kind: "unavailable",
        detail: `authn answered HTTP ${response.status} with a body that is not valid JSON`,
      };
    }
  } finally {
    abort.clear();
  }
}

function hostTokenOf(seconds: number, token: string): HostToken {
  return { token, expiresAtMs: Date.now() + seconds * 1000 };
}

/**
 * The local route's refusals. Only `team_membership_required` (403) says the
 * computer is a team's; a bare 404 covers every other computer the person may
 * not open. Nothing else is expected as a 403 here: one reads as not admitted
 * and its status is logged.
 */
function localMintRefusal(
  status: number,
  bodyText: string,
): Exclude<HostTokenMintOutcome, { readonly kind: "ok" }> {
  if (status === 404) return { kind: "not-admitted" };
  if (status === 403) {
    if (membershipRefusalCode(bodyText) === TEAM_MEMBERSHIP_REQUIRED_CODE)
      return { kind: "not-a-member" };
    console.warn(
      `[host-token] authn refused a host-only token mint with an unexpected HTTP ${status}`,
    );
    return { kind: "not-admitted" };
  }
  if (status === 401) return { kind: "sign-in-rejected" };
  if (status === 402 && isSandboxFrozenRefusal(bodyText))
    return { kind: "sandbox-frozen" };
  return { kind: "unavailable", detail: `authn answered HTTP ${status}` };
}

/** `POST /api/v3/hosts/:hostId/session-grant`: a local open's host-only token. */
export async function mintHostTokenViaHttp(
  authnBaseUrl: string,
  hostId: string,
  signInToken: string,
  signal: AbortSignal | null,
): Promise<HostTokenMintOutcome> {
  const answer = await postHostRoute(
    hostRouteUrl(authnBaseUrl, hostId, "session-grant"),
    signInToken,
    null,
    signal,
  );
  if (answer.kind === "unavailable") return answer;
  if (answer.kind === "refused")
    return localMintRefusal(answer.status, answer.bodyText);
  const parsed = hostSessionGrantResponseSchema.safeParse(answer.body);
  if (!parsed.success)
    return {
      kind: "unavailable",
      detail: "authn answered but the body is not a host-only token",
    };
  return {
    kind: "ok",
    token: hostTokenOf(
      parsed.data.session_grant_expires_in,
      parsed.data.session_grant,
    ),
  };
}

export type RelayPassMintOutcome =
  | {
      readonly kind: "ok";
      readonly grant: AttachGrant;
      readonly hostToken: HostToken;
    }
  /** A bare 404, any computer this person may not open: refused as today. */
  | { readonly kind: "not-admitted"; readonly provision: AttachGrantProvision }
  /** authn could not be reached (a transport failure or a 5xx). */
  | { readonly kind: "unreachable"; readonly provision: AttachGrantProvision }
  /** Every other refusal, handled exactly as a relay pass mint is today. */
  | { readonly kind: "as-today"; readonly provision: AttachGrantProvision };

/**
 * A remote open's one call: the relay pass and, beside it, the host-only
 * token (`session_grant_version: 2`). Never sends `purpose`. A revoked
 * computer (403) and an owner's computer with remote access off (403
 * `remote_access_off`) are answered as they are today.
 */
export async function mintRelayPassWithHostTokenViaHttp(
  authnBaseUrl: string,
  hostId: string,
  signInToken: string,
): Promise<RelayPassMintOutcome> {
  const answer = await postHostRoute(
    hostRouteUrl(authnBaseUrl, hostId, "attach-grant"),
    signInToken,
    JSON.stringify({ role: "client", session_grant_version: 2 }),
    null,
  );
  if (answer.kind === "unavailable")
    return {
      kind: "unreachable",
      provision: { kind: "unavailable", detail: answer.detail, context: "" },
    };
  if (answer.kind === "refused") {
    if (answer.status === 404)
      return {
        kind: "not-admitted",
        provision: provisionOfFailedMint({
          kind: "team-membership-required",
          detail: "membership refused",
          context: "",
        }),
      };
    const refusal = classifyOtherRefusal(answer.status, answer.bodyText);
    return {
      kind: answer.status >= 500 ? "unreachable" : "as-today",
      provision: provisionOfFailedMint(refusal),
    };
  }
  const parsed = relayPassWithHostTokenSchema.safeParse(answer.body);
  if (!parsed.success)
    return {
      kind: "as-today",
      provision: {
        kind: "unavailable",
        detail:
          "authn answered but the body carries no relay pass and host-only token",
        context: "",
      },
    };
  return {
    kind: "ok",
    grant: {
      grant: parsed.data.grant,
      expiresInSeconds: parsed.data.expires_in,
    },
    hostToken: hostTokenOf(
      parsed.data.session_grant_expires_in,
      parsed.data.session_grant,
    ),
  };
}
