import { z } from "zod";
import { composeRequestAbort } from "../auth/request-abort";

/**
 * The raw calls to traycer-server's voice session routes with the user
 * bearer: `POST /api/voice/sessions` (the SDP exchange that opens a voice
 * session, billed to the person's own account) and
 * `POST /api/voice/sessions/:id/end`. Transport-only, a sibling of
 * `sandbox-control.ts`, and it runs where that runs: desktop calls it from
 * Electron main (traycer-server's CORS allow-list is the web dashboard
 * origin, not the app renderer), mobile through the native HTTP layer,
 * browser/dev shells directly.
 *
 * Never throws: transport failures, non-2xx answers and malformed bodies
 * collapse into discriminated, structured-clone-safe results so they cross
 * the Electron IPC boundary unchanged.
 */

/**
 * A mint waits for the server's credit pre-flight and the vendor's session
 * create (under a second in the probe, a few on a cold start).
 */
const VOICE_MINT_FETCH_TIMEOUT_MS = 20_000;
const VOICE_END_FETCH_TIMEOUT_MS = 10_000;

const VOICE_CREDITS_EXHAUSTED = "VOICE_CREDITS_EXHAUSTED";
const VOICE_UNAVAILABLE = "VOICE_UNAVAILABLE";
const VOICE_SESSION_NOT_FOUND = "VOICE_SESSION_NOT_FOUND";

/** What the app sends to open a session. */
export interface VoiceSessionMintRequest {
  /** The WebRTC offer the app's peer produced. */
  readonly offerSdp: string;
  /**
   * What the session opens knowing (the briefing): spoken first, truncated
   * server-side at 4,000 characters.
   */
  readonly input: string;
}

/** A minted session: the answer to the offer and when the vendor ends it. */
export interface VoiceSessionMinted {
  readonly voiceSessionId: string;
  readonly answerSdp: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

const voiceSessionMintedSchema = z.object({
  voiceSessionId: z.string().min(1),
  answerSdp: z.string().min(1),
  expiresAt: z.number(),
});

const voiceSessionEndedSchema = z.object({
  closedAt: z.number(),
});

const errorBodySchema = z.object({ error: z.string() });

/**
 * The outcome of a mint:
 *  - `ok`                — the session is open; connect the peer with the answer.
 *  - `dormant`           — the server has no voice key: an empty 200. The
 *                          feature is off for this deployment and Talk hides.
 *  - `credits-exhausted` — 402: the person's account cannot pay for a
 *                          session; said once, never retried.
 *  - `unavailable`       — 502: the vendor refused or failed. Transient; Talk
 *                          stays and the person may try again.
 *  - `unauthorized`      — the bearer was rejected (401/403).
 *  - `network-error`     — transport/timeout, an unexpected status, or a body
 *                          this build cannot parse. `detail` is a stable
 *                          classification, never a raw server body.
 */
export type VoiceSessionMintFetchResult =
  | { readonly kind: "ok"; readonly session: VoiceSessionMinted }
  | { readonly kind: "dormant" }
  | { readonly kind: "credits-exhausted" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error"; readonly detail: string };

/**
 * The outcome of an end. A 404 (`VOICE_SESSION_NOT_FOUND`: an unknown id, or
 * another member's session) reads as already closed: the route is
 * idempotent and the app's own close over the data channel ended the vendor
 * session either way.
 */
export type VoiceSessionEndFetchResult =
  | { readonly kind: "ok"; readonly closedAt: number | null }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error"; readonly detail: string };

interface RawResponse {
  readonly status: number;
  readonly body: unknown;
  /** The body as text, so an empty 200 can be told from an unparseable one. */
  readonly text: string;
}

type RawResult =
  | RawResponse
  | { readonly kind: "network-error"; readonly detail: string };

function voiceSessionsUrl(serverBaseUrl: string, path: string): string {
  return new URL(
    `api/voice/sessions${path}`,
    serverBaseUrl.endsWith("/") ? serverBaseUrl : `${serverBaseUrl}/`,
  ).toString();
}

/**
 * One request under one timeout, its body read before the abort is cleared so
 * a server that sends headers and then stalls still times out. The IAP proxy
 * token rides beside the bearer where a staging build has one.
 */
async function call(
  url: string,
  body: string,
  timeoutMs: number,
  bearerToken: string,
  proxyToken: string | null,
): Promise<RawResult> {
  const abort = composeRequestAbort(null, timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(proxyToken === null
          ? {}
          : { "Proxy-Authorization": `Bearer ${proxyToken}` }),
      },
      body,
      signal: abort.signal,
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text.trim().length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return { status: response.status, body: parsed, text };
  } catch {
    return {
      kind: "network-error",
      detail: "the voice session request did not complete",
    };
  } finally {
    abort.clear();
  }
}

function isRawResponse(result: RawResult): result is RawResponse {
  return "status" in result;
}

function errorCodeOf(body: unknown): string | null {
  const parsed = errorBodySchema.safeParse(body);
  return parsed.success ? parsed.data.error : null;
}

/**
 * Whether a 200 is the dormant answer: no body, or a body that is an empty
 * JSON object. Anything else on a 200 is a session or a contract drift.
 */
function isDormantBody(response: RawResponse): boolean {
  if (response.text.trim().length === 0) return true;
  return (
    typeof response.body === "object" &&
    response.body !== null &&
    !Array.isArray(response.body) &&
    Object.keys(response.body).length === 0
  );
}

/**
 * `POST /api/voice/sessions`: opens a voice session for the signed-in
 * person. The server pre-flights their credits, creates the vendor session
 * with the offer and `input`, and answers the SDP that completes the peer.
 */
export async function voiceSessionsMintViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  request: VoiceSessionMintRequest,
): Promise<VoiceSessionMintFetchResult> {
  const raw = await call(
    voiceSessionsUrl(serverBaseUrl, ""),
    JSON.stringify({ offerSdp: request.offerSdp, input: request.input }),
    VOICE_MINT_FETCH_TIMEOUT_MS,
    bearerToken,
    proxyToken,
  );
  if (!isRawResponse(raw)) return raw;
  if (raw.status === 401 || raw.status === 403) return { kind: "unauthorized" };
  if (raw.status === 402) {
    return errorCodeOf(raw.body) === VOICE_CREDITS_EXHAUSTED
      ? { kind: "credits-exhausted" }
      : {
          kind: "network-error",
          detail: "the voice route refused payment without its code",
        };
  }
  if (raw.status === 502 && errorCodeOf(raw.body) === VOICE_UNAVAILABLE) {
    return { kind: "unavailable" };
  }
  if (raw.status < 200 || raw.status >= 300) {
    return {
      kind: "network-error",
      detail: `the voice route answered HTTP ${raw.status}`,
    };
  }
  if (isDormantBody(raw)) return { kind: "dormant" };
  const parsed = voiceSessionMintedSchema.safeParse(raw.body);
  if (!parsed.success) {
    return {
      kind: "network-error",
      detail: "the minted voice session did not match the contract",
    };
  }
  return { kind: "ok", session: parsed.data };
}

/** Whether `id` is one plain path segment, so no URL is built from anything else. */
function isPathSegmentId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/**
 * `POST /api/voice/sessions/:id/end`: tells the server the person ended the
 * session, so it closes the vendor session if its sideband is still live and
 * marks the row closed. Idempotent; an unknown or foreign id (404) is read as
 * already closed.
 */
export async function voiceSessionsEndViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  voiceSessionId: string,
): Promise<VoiceSessionEndFetchResult> {
  if (!isPathSegmentId(voiceSessionId)) {
    return {
      kind: "network-error",
      detail: "the voice session id is not one the server mints",
    };
  }
  const raw = await call(
    voiceSessionsUrl(
      serverBaseUrl,
      `/${encodeURIComponent(voiceSessionId)}/end`,
    ),
    "{}",
    VOICE_END_FETCH_TIMEOUT_MS,
    bearerToken,
    proxyToken,
  );
  if (!isRawResponse(raw)) return raw;
  if (raw.status === 401 || raw.status === 403) return { kind: "unauthorized" };
  if (raw.status === 404 && errorCodeOf(raw.body) === VOICE_SESSION_NOT_FOUND) {
    return { kind: "ok", closedAt: null };
  }
  if (raw.status < 200 || raw.status >= 300) {
    return {
      kind: "network-error",
      detail: `the voice end route answered HTTP ${raw.status}`,
    };
  }
  const parsed = voiceSessionEndedSchema.safeParse(raw.body);
  return {
    kind: "ok",
    closedAt: parsed.success ? parsed.data.closedAt : null,
  };
}
