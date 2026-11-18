import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";

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
const VOICE_AVAILABILITY_FETCH_TIMEOUT_MS = 10_000;

const VOICE_CREDITS_EXHAUSTED = "VOICE_CREDITS_EXHAUSTED";
const VOICE_UNAVAILABLE = "VOICE_UNAVAILABLE";
const VOICE_SESSION_NOT_FOUND = "VOICE_SESSION_NOT_FOUND";
const VOICE_SELECTION_UNAVAILABLE = "VOICE_SELECTION_UNAVAILABLE";

/** The most voices an offered list may name; a longer one is not read. */
const VOICE_SELECTION_MAX_VOICES = 256;

const VOICE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * A voice as the server names it: lower-case letters, digits, `_` and `-`,
 * starting with a letter or digit, at most 64. The server's mint request
 * schema holds the same bound.
 */
export function isVoiceName(value: unknown): value is string {
  return typeof value === "string" && VOICE_NAME.test(value);
}

/**
 * What a mint does with a requested voice the server does not offer:
 * `fallback` speaks the server's default instead; `exact` refuses the mint
 * before any session is made (`voice-unavailable`), for a call renewing the
 * voice it already speaks in.
 */
export type VoiceSelectionPolicy = "fallback" | "exact";

/** What the app sends to open a session. */
export interface VoiceSessionMintRequest {
  /** The WebRTC offer the app's peer produced. */
  readonly offerSdp: string;
  /**
   * What the session opens knowing (the briefing): spoken first, truncated
   * server-side at 4,000 characters.
   */
  readonly input: string;
  /** The voice asked for; `null` sends none, and the server's default speaks. */
  readonly voice: string | null;
  /** `null` sends none, which a server reads as `fallback`. */
  readonly voicePolicy: VoiceSelectionPolicy | null;
}

/**
 * The voices a deployment offers for calls (`GET /api/voice/availability`),
 * and the one that speaks when a call names none. `exactVoiceRenewal` says
 * the mint honours the `exact` policy.
 */
export interface VoiceSelectionCapability {
  readonly version: 1;
  readonly defaultVoice: string;
  readonly voices: ReadonlyArray<string>;
  readonly exactVoiceRenewal: true;
}

/**
 * Which voice the server asked the vendor for, as its answer says it.
 * `absent` from a server that names none; `invalid` when the answer names it
 * in a shape this build cannot read. Either way the session beside it still
 * parses, so its id can be ended.
 */
export type MintedVoiceSelection =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "valid";
      /** The request's `voice`; `null` when it named none. */
      readonly requestedVoice: string | null;
      readonly effectiveVoice: string;
      readonly reason: "selected" | "default" | "unavailable";
    };

/** A minted session: the answer to the offer and when the vendor ends it. */
export interface VoiceSessionMinted {
  readonly voiceSessionId: string;
  readonly answerSdp: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  /**
   * The lines the voice says, word for word, when the person finishes
   * speaking: what tells the app an utterance ended. `null` from a server
   * that does not name them, or names them as anything but a list of
   * strings: the session itself still parses, so the app can end it.
   */
  readonly acknowledgementLines: ReadonlyArray<string> | null;
  readonly voiceSelection: MintedVoiceSelection;
}

const voiceSessionMintedSchema = z.object({
  voiceSessionId: z.string().min(1),
  answerSdp: z.string().min(1),
  expiresAt: z.number(),
});

const acknowledgementLinesSchema = z.object({
  acknowledgementLines: z.array(z.string()),
});

const voiceNameSchema = z.string().refine(isVoiceName);

const mintedVoiceSelectionSchema = z.object({
  requestedVoice: voiceNameSchema.nullable(),
  effectiveVoice: voiceNameSchema,
  reason: z.enum(["selected", "default", "unavailable"]),
});

const voiceSessionEndedSchema = z.object({
  closedAt: z.number(),
});

const voiceAvailabilitySchema = z.object({
  available: z.boolean(),
});

const voiceSelectionCapabilitySchema = z
  .object({
    version: z.literal(1),
    defaultVoice: voiceNameSchema,
    voices: z
      .array(voiceNameSchema)
      .min(1)
      .max(VOICE_SELECTION_MAX_VOICES)
      .refine((voices) => new Set(voices).size === voices.length),
    exactVoiceRenewal: z.literal(true),
  })
  .refine((capability) => capability.voices.includes(capability.defaultVoice));

/**
 * The outcome of the availability read. `available: false` is the dormant
 * deployment (no voice key), answered without opening a microphone or a
 * session; Talk hides on it. `voiceSelection` is `null` from a server that
 * offers no choice of voice, or offers one this build cannot read: calls
 * there name no voice.
 */
export type VoiceAvailabilityFetchResult =
  | {
      readonly kind: "ok";
      readonly available: boolean;
      readonly voiceSelection: VoiceSelectionCapability | null;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error"; readonly detail: string };

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
 *  - `voice-unavailable` — 409: an `exact` request named a voice the server
 *                          no longer offers. No session was made.
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
  | { readonly kind: "voice-unavailable" }
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

/**
 * What a live session's shell item shows (the desktop's menu-bar and
 * notification-area item): whether the person muted the session, and
 * whether it is paused for dictation.
 */
export interface VoiceSessionIndicator {
  readonly muted: boolean;
  readonly pausedForDictation: boolean;
}

/** What the shell item asks of the window whose session it shows. */
export type VoiceTrayAction =
  | { readonly kind: "setMuted"; readonly muted: boolean }
  | { readonly kind: "end" };

interface RawResponse {
  readonly status: number;
  readonly body: unknown;
  /** The body as text, so an empty 200 can be told from an unparseable one. */
  readonly text: string;
}

type RawResult =
  | RawResponse
  | { readonly kind: "network-error"; readonly detail: string };

function voiceUrl(serverBaseUrl: string, path: string): string {
  return new URL(
    `api/voice${path}`,
    serverBaseUrl.endsWith("/") ? serverBaseUrl : `${serverBaseUrl}/`,
  ).toString();
}

function voiceSessionsUrl(serverBaseUrl: string, path: string): string {
  return voiceUrl(serverBaseUrl, `/sessions${path}`);
}

/**
 * One request under one timeout, its body read before the abort is cleared so
 * a server that sends headers and then stalls still times out. The IAP proxy
 * token rides beside the bearer where a staging build has one. A `null` body
 * is a GET.
 */
async function call(
  url: string,
  body: string | null,
  timeoutMs: number,
  bearerToken: string,
  proxyToken: string | null,
): Promise<RawResult> {
  const abort = composeRequestAbort(null, timeoutMs);
  try {
    const response = await untilAborted(
      fetch(url, {
        method: body === null ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Accept: "application/json",
          ...(body === null ? {} : { "Content-Type": "application/json" }),
          ...(proxyToken === null
            ? {}
            : { "Proxy-Authorization": `Bearer ${proxyToken}` }),
        },
        body,
        signal: abort.signal,
      }),
      abort.signal,
    );
    const text = await untilAborted(response.text(), abort.signal);
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
    // Each field named, so nothing else the caller's object carries is sent;
    // the voice fields only when set, so a request naming no voice is the
    // body every server version reads.
    JSON.stringify({
      offerSdp: request.offerSdp,
      input: request.input,
      ...(request.voice === null ? {} : { voice: request.voice }),
      ...(request.voicePolicy === null
        ? {}
        : { voicePolicy: request.voicePolicy }),
    }),
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
  if (
    raw.status === 409 &&
    errorCodeOf(raw.body) === VOICE_SELECTION_UNAVAILABLE
  ) {
    return { kind: "voice-unavailable" };
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
  const lines = acknowledgementLinesSchema.safeParse(raw.body);
  return {
    kind: "ok",
    session: {
      ...parsed.data,
      acknowledgementLines: lines.success
        ? lines.data.acknowledgementLines
        : null,
      voiceSelection: mintedVoiceSelectionOf(raw.body),
    },
  };
}

/**
 * The answer's `voiceSelection`, read apart from the session it comes with:
 * an unreadable one is `invalid`, never a reason to lose the session's id.
 */
function mintedVoiceSelectionOf(body: unknown): MintedVoiceSelection {
  const value = voiceSelectionField(body);
  if (value === undefined) return { kind: "absent" };
  const parsed = mintedVoiceSelectionSchema.safeParse(value);
  return parsed.success
    ? { kind: "valid", ...parsed.data }
    : { kind: "invalid" };
}

/** A body's `voiceSelection`, which the schemas beside it do not keep. */
function voiceSelectionField(body: unknown): unknown {
  return typeof body === "object" && body !== null
    ? Reflect.get(body, "voiceSelection")
    : undefined;
}

/**
 * `GET /api/voice/availability`: whether this deployment offers voice at all
 * (a voice key is set), read once per window before Talk is drawn, so a
 * person on a server without voice never opens a microphone to learn so.
 */
export async function voiceSessionsAvailabilityViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
): Promise<VoiceAvailabilityFetchResult> {
  const raw = await call(
    voiceUrl(serverBaseUrl, "/availability"),
    null,
    VOICE_AVAILABILITY_FETCH_TIMEOUT_MS,
    bearerToken,
    proxyToken,
  );
  if (!isRawResponse(raw)) return raw;
  if (raw.status === 401 || raw.status === 403) return { kind: "unauthorized" };
  if (raw.status < 200 || raw.status >= 300) {
    return {
      kind: "network-error",
      detail: `the voice availability route answered HTTP ${raw.status}`,
    };
  }
  const parsed = voiceAvailabilitySchema.safeParse(raw.body);
  if (!parsed.success) {
    return {
      kind: "network-error",
      detail: "the voice availability answer did not match the contract",
    };
  }
  // Read apart from `available`: a capability this build cannot read means
  // calls name no voice there, not that voice is off.
  const capability = voiceSelectionCapabilitySchema.safeParse(
    voiceSelectionField(raw.body),
  );
  return {
    kind: "ok",
    available: parsed.data.available,
    voiceSelection: capability.success ? capability.data : null,
  };
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
