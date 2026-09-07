import {
  claimLinkLoginCodeResponseSchema,
  linkLoginStatusResponseSchema,
  linkLoginTokenResponseSchema,
  mintLinkLoginCodeResponseSchema,
  respondLinkLoginResponseSchema,
  type LinkLoginStatusResponse,
  type LinkLoginTokenResponse,
  type MintLinkLoginCodeResponse,
} from "@traycer/protocol/auth/link-login";
import type { z } from "zod";
import { parseRetryAfterSeconds } from "./device-auth";
import { composeRequestAbort } from "./request-abort";

/**
 * Link-login ("link mobile app") HTTP client for the confirm-gated flow: the desktop mints and approves; the phone claims and polls with the private secret its claim returned.
 */

const LINK_LOGIN_FETCH_TIMEOUT_MS = 10_000;

/**
 * QR payload format.
 * The superseded `traycer://link-login?code=` form is still parsed.
 */
const LINK_LOGIN_QR_SCHEME = "traycer:";
const LINK_LOGIN_QR_HOST = "link-login";
const LINK_LOGIN_HTTPS_SCHEME = "https:";
const LINK_LOGIN_LINK_PATH = "/link";
// The public code's canonical shape: 10 Crockford base32 chars (no I/L/O/U),
// matched after normalization.
const NORMALIZED_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/;

export type MintLinkLoginCodeFetchResult =
  | { readonly kind: "ok"; readonly response: MintLinkLoginCodeResponse }
  | { readonly kind: "unauthorized" }
  /**
   * A claim on the caller's chain is awaiting the human decision (409):
   * benign - the surface should show/await the claim state, not an error.
   */
  | { readonly kind: "claim-pending" }
  /** The caller's credential carries no session family (400): terminal. */
  | { readonly kind: "no-session-family" }
  | { readonly kind: "network-error" };

export type ClaimLinkLoginCodeFetchResult =
  | {
      readonly kind: "claimed";
      readonly secret: string;
      readonly pollIntervalSeconds: number;
      /**
       * The claim's match code, for the phone to show while it waits; `null` from a server that predates it, in which case the desktop's prompt is showing no code either.
       */
      readonly matchCode: string | null;
    }
  | { readonly kind: "invalid-code" }
  | { readonly kind: "rate-limited" }
  | { readonly kind: "network-error" };

export type LinkLoginTokenFetchResult =
  | { readonly kind: "authorized"; readonly response: LinkLoginTokenResponse }
  | { readonly kind: "authorization-pending" }
  | { readonly kind: "slow-down"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "access-denied" }
  | { readonly kind: "invalid-code" }
  | { readonly kind: "network-error" };

export type LinkLoginStatusFetchResult =
  | { readonly kind: "ok"; readonly response: LinkLoginStatusResponse }
  | { readonly kind: "gone" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

export type RespondLinkLoginFetchResult =
  | { readonly kind: "ok" }
  | { readonly kind: "already-decided" }
  | { readonly kind: "gone" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

function authnApiUrl(authnBaseUrl: string, path: string): string {
  return new URL(
    path.replace(/^\/+/, ""),
    authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`,
  ).toString();
}

export function normalizeLinkLoginCodeInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

export function buildLinkLoginQrPayload(
  platformBaseUrl: string,
  code: string,
): string {
  // Root-absolute against the base's origin: `/link` is a top-level route, so
  // a base carrying a path or a trailing slash resolves to the same URL.
  const url = new URL(LINK_LOGIN_LINK_PATH, platformBaseUrl);
  url.searchParams.set("code", code);
  return url.toString();
}

/**
 * Whether this URL is a link-login payload, in either encoding.
 * It costs nothing, because this function only extracts a code - the claim is always POSTed to the shell's own `authnBaseUrl`, so a host chosen by whoever printed the QR cannot redirect where the code is sent.
 */
function linkLoginPayloadCode(url: URL): string | null {
  if (url.protocol === LINK_LOGIN_QR_SCHEME) {
    // Custom-scheme URLs parse host-vs-path differently across engines; accept
    // the payload wherever `link-login` landed.
    if (
      url.host !== LINK_LOGIN_QR_HOST &&
      url.pathname.replace(/^\/+/, "") !== LINK_LOGIN_QR_HOST
    ) {
      return null;
    }
    return url.searchParams.get("code");
  }
  // `https:` only - an `http:` payload would be a downgrade no camera needs to be offered, and the universal link the entitlement claims is https by definition.
  if (url.protocol !== LINK_LOGIN_HTTPS_SCHEME) {
    return null;
  }
  if (url.pathname.replace(/\/+$/, "") !== LINK_LOGIN_LINK_PATH) {
    return null;
  }
  return url.searchParams.get("code");
}

/**
 * Extracts a public link code from scanned, deep-linked or pasted text: the https QR payload, the superseded `traycer://` payload, or the typed code itself (any dash/case variation the normalization accepts).
 * Returns the normalized code, or `null` when the text carries no plausible code - never a guess.
 */
export function parseLinkLoginInput(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const direct = normalizeLinkLoginCodeInput(trimmed);
  if (NORMALIZED_CODE_PATTERN.test(direct)) {
    return direct;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const code = linkLoginPayloadCode(url);
  if (code === null) {
    return null;
  }
  const normalized = normalizeLinkLoginCodeInput(code);
  return NORMALIZED_CODE_PATTERN.test(normalized) ? normalized : null;
}

/**
 * The generic device kinds a claimant can be bucketed into, with the article
 * each takes in running prose. A self-reported name is never one of these.
 */
const CLAIMANT_DEVICE_KINDS: ReadonlyMap<string, string> = new Map([
  ["iPhone", "an"],
  ["iPad", "an"],
  ["Android device", "an"],
  ["device", "a"],
]);

/** A self-reported name longer than this is UA-shaped, not a device name. */
const CLAIMANT_DEVICE_NAME_MAX = 40;

/**
 * C0 and C1 control characters, del included.
 * A self-reported name carrying one is not a name: it is a terminal control sequence aimed at the CLI's approval prompt, and it buckets to a family like any other unusable value.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * What the claimant is, as a bare noun phrase: "iPhone", "Pixel 8", "Android device", "device".
 * A browser or CFNetwork User-Agent is long and structured, and is only good for a family bucket.
 */
export function claimantDeviceName(userAgent: string | null): string {
  const value = userAgent ?? "";
  if (CLAIMANT_DEVICE_KINDS.has(value)) {
    return value;
  }
  if (
    value.length > 0 &&
    value.length <= CLAIMANT_DEVICE_NAME_MAX &&
    !hasControlCharacter(value) &&
    !value.includes("Mozilla/") &&
    !value.includes("CFNetwork") &&
    !value.includes("(")
  ) {
    return value;
  }
  if (value.includes("iPhone")) {
    return "iPhone";
  }
  if (value.includes("iPad")) {
    return "iPad";
  }
  if (value.includes("Android")) {
    return "Android device";
  }
  return "device";
}

/**
 * `claimantDeviceName` for running prose: a generic kind carries its article ("an iPhone", "a device") so it slots into "Approve sign-in from ___?", while a proper name ("Pixel 8") reads better bare and stays so.
 */
export function claimantDeviceLabel(userAgent: string | null): string {
  const name = claimantDeviceName(userAgent);
  const article = CLAIMANT_DEVICE_KINDS.get(name);
  return article === undefined ? name : `${article} ${name}`;
}

async function postJson(
  authnBaseUrl: string,
  path: string,
  bearerToken: string | null,
  body: object,
  signal: AbortSignal | null,
): Promise<Response | null> {
  const abort = composeRequestAbort(signal, LINK_LOGIN_FETCH_TIMEOUT_MS);
  try {
    return await fetch(authnApiUrl(authnBaseUrl, path), {
      method: "POST",
      headers: {
        ...(bearerToken === null
          ? {}
          : { Authorization: `Bearer ${bearerToken}` }),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch {
    return null;
  } finally {
    abort.clear();
  }
}

async function parseOk<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export async function mintLinkLoginCodeViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  signal: AbortSignal | null,
): Promise<MintLinkLoginCodeFetchResult> {
  const response = await postJson(
    authnBaseUrl,
    "api/v3/auth/link/mint",
    bearerToken,
    {},
    signal,
  );
  if (response === null) {
    return { kind: "network-error" };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status === 409) {
    return { kind: "claim-pending" };
  }
  if (response.status === 400) {
    return { kind: "no-session-family" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = await parseOk(response, mintLinkLoginCodeResponseSchema);
  return parsed === null
    ? { kind: "network-error" }
    : { kind: "ok", response: parsed };
}

/**
 * Declares that this client understands a `matchCode` in the response.
 * The response schemas are strict, so the server sends the field only to callers that ask for it - an older client keeps parsing today's exact shape.
 */
const ACCEPT_MATCH_CODE = { acceptMatchCode: true } as const;

/**
 * The phone attaches itself to a scanned/typed code.
 * First scan wins and only that response carries the polling secret; claiming grants nothing else.
 */
export async function claimLinkLoginCodeViaHttp(
  authnBaseUrl: string,
  code: string,
  // Self-reported device description for the approver's prompt (typically `navigator.userAgent`).
  deviceHint: string | null,
): Promise<ClaimLinkLoginCodeFetchResult> {
  const response = await postJson(
    authnBaseUrl,
    "api/v3/auth/link/claim",
    null,
    deviceHint === null
      ? { code, ...ACCEPT_MATCH_CODE }
      : { code, device: deviceHint, ...ACCEPT_MATCH_CODE },
    null,
  );
  if (response === null) {
    return { kind: "network-error" };
  }
  if (response.status === 401) {
    return { kind: "invalid-code" };
  }
  if (response.status === 429) {
    return { kind: "rate-limited" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = await parseOk(response, claimLinkLoginCodeResponseSchema);
  return parsed === null
    ? { kind: "network-error" }
    : {
        kind: "claimed",
        secret: parsed.secret,
        pollIntervalSeconds: parsed.interval,
        matchCode: parsed.matchCode ?? null,
      };
}

/** One result poll BY secret after a claim. */
export async function linkLoginTokenViaHttp(
  authnBaseUrl: string,
  secret: string,
): Promise<LinkLoginTokenFetchResult> {
  const response = await postJson(
    authnBaseUrl,
    "api/v3/auth/link/token",
    null,
    { secret },
    null,
  );
  if (response === null) {
    return { kind: "network-error" };
  }
  if (response.status === 428) {
    return { kind: "authorization-pending" };
  }
  if (response.status === 429) {
    // The endpoint's request budget and the engine's paced `slow_down` both land here; the caller just waits.
    return {
      kind: "slow-down",
      retryAfterSeconds: parseRetryAfterSeconds(
        response.headers.get("Retry-After"),
      ),
    };
  }
  if (response.status === 400) {
    const body: unknown = await response.json().catch(() => null);
    const error =
      body !== null && typeof body === "object" && "error" in body
        ? (body as { error: unknown }).error
        : null;
    return error === "access_denied"
      ? { kind: "access-denied" }
      : { kind: "network-error" };
  }
  if (response.status === 401) {
    return { kind: "invalid-code" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = await parseOk(response, linkLoginTokenResponseSchema);
  return parsed === null
    ? { kind: "network-error" }
    : { kind: "authorized", response: parsed };
}

export async function linkLoginStatusViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  code: string,
  signal: AbortSignal | null,
): Promise<LinkLoginStatusFetchResult> {
  const response = await postJson(
    authnBaseUrl,
    "api/v3/auth/link/status",
    bearerToken,
    // `acceptClaimExpiry` declares the same understanding for the claim's deadline as `acceptMatchCode` does for the code: strict schemas, so the server sends each field only to callers that asked.
    { code, ...ACCEPT_MATCH_CODE, acceptClaimExpiry: true },
    signal,
  );
  if (response === null) {
    return { kind: "network-error" };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status === 404) {
    return { kind: "gone" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = await parseOk(response, linkLoginStatusResponseSchema);
  return parsed === null
    ? { kind: "network-error" }
    : { kind: "ok", response: parsed };
}

export async function respondLinkLoginViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  code: string,
  approve: boolean,
): Promise<RespondLinkLoginFetchResult> {
  const response = await postJson(
    authnBaseUrl,
    "api/v3/auth/link/respond",
    bearerToken,
    { code, approve },
    null,
  );
  if (response === null) {
    return { kind: "network-error" };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status === 404) {
    return { kind: "gone" };
  }
  if (response.status === 409) {
    return { kind: "already-decided" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = await parseOk(response, respondLinkLoginResponseSchema);
  return parsed === null ? { kind: "network-error" } : { kind: "ok" };
}
