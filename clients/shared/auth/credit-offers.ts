import {
  claimCreditOfferResponseSchema,
  listCreditOffersResponseSchema,
  type CreditOffer,
} from "@traycer/protocol/auth/credit-offers";
import { composeRequestAbort } from "./request-abort";

/**
 * Credit offers HTTP client: the offers a signed-in user can claim, and the
 * claim itself. Zero DI, ambient `fetch` only, like the link-login client, so
 * the desktop renderer and the phone's WebView call authn the same way.
 *
 * Every refusal is a result kind, never a throw and never a sign-out: a 401
 * or 403 here says this one surface cannot be served, not that the session is
 * gone, and the session's own validation decides that elsewhere.
 */

const CREDIT_OFFERS_FETCH_TIMEOUT_MS = 10_000;
const CREDIT_OFFERS_PATH = "api/user/credit-campaigns";

export type ListCreditOffersFetchResult =
  | { readonly kind: "ok"; readonly offers: ReadonlyArray<CreditOffer> }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

/** Why an offer cannot be claimed; the list is out of date in every case. */
export type CreditOfferUnavailableReason =
  | "sold-out"
  /** Not started, ended, or gone (404). */
  | "not-running"
  /** The caller's plan cannot claim offers. */
  | "ineligible";

export type ClaimCreditOfferFetchResult =
  | {
      readonly kind: "ok";
      /** `null` when the claim took but its card could not be read. */
      readonly offer: CreditOffer | null;
    }
  /** The caller already holds this offer (409). */
  | { readonly kind: "conflict" }
  | {
      readonly kind: "unavailable";
      readonly reason: CreditOfferUnavailableReason;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

/** authn answers a refusal with the bare code as its `error` message. */
const ALREADY_CLAIMED = "CREDIT_CAMPAIGN_ALREADY_CLAIMED";
const SOLD_OUT = "CREDIT_CAMPAIGN_SOLD_OUT";
const NOT_ACTIVE = "CREDIT_CAMPAIGN_NOT_ACTIVE";
const PLAN_INELIGIBLE = "CREDIT_CAMPAIGN_PLAN_INELIGIBLE";

function authnApiUrl(authnBaseUrl: string, path: string): string {
  return new URL(
    path,
    authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`,
  ).toString();
}

/** A response read to the end: its status and its JSON body, or `null`. */
interface ReadResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * One request, its body included, under one timeout. The body is read before
 * the abort is cleared: a server that sends headers and then stalls must
 * still time out, or a claim would stay pending, and every Claim button
 * disabled, for good. A body that cannot be read, a timed-out one included,
 * is `null`.
 */
async function request(
  url: string,
  init: { method: "GET" | "POST"; body: string | null },
  bearerToken: string,
  signal: AbortSignal | null,
): Promise<ReadResponse | null> {
  const abort = composeRequestAbort(signal, CREDIT_OFFERS_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/json",
        ...(init.body === null ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body,
      signal: abort.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch {
    return null;
  } finally {
    abort.clear();
  }
}

function errorCode(body: unknown): string | null {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    return null;
  }
  return typeof body.error === "string" ? body.error : null;
}

/** The offers the signed-in user can see, claimed or not. */
export async function listCreditOffersViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  signal: AbortSignal | null,
): Promise<ListCreditOffersFetchResult> {
  const response = await request(
    authnApiUrl(authnBaseUrl, CREDIT_OFFERS_PATH),
    { method: "GET", body: null },
    bearerToken,
    signal,
  );
  if (response === null) {
    return { kind: "network-error" };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = listCreditOffersResponseSchema.safeParse(response.body);
  return parsed.success
    ? { kind: "ok", offers: parsed.data.campaigns }
    : { kind: "network-error" };
}

/** Claims one offer for the signed-in user. */
export async function claimCreditOfferViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  campaignId: string,
): Promise<ClaimCreditOfferFetchResult> {
  const response = await request(
    authnApiUrl(authnBaseUrl, `${CREDIT_OFFERS_PATH}/claim`),
    { method: "POST", body: JSON.stringify({ campaignId }) },
    bearerToken,
    null,
  );
  if (response === null) {
    return { kind: "network-error" };
  }
  if (response.status === 401) {
    return { kind: "unauthorized" };
  }
  if (response.status === 403) {
    // A plan refusal is a 403 too; only its code tells it from an auth one.
    return errorCode(response.body) === PLAN_INELIGIBLE
      ? { kind: "unavailable", reason: "ineligible" }
      : { kind: "unauthorized" };
  }
  if (response.status === 404) {
    return { kind: "unavailable", reason: "not-running" };
  }
  if (response.status === 409) {
    switch (errorCode(response.body)) {
      case ALREADY_CLAIMED:
        return { kind: "conflict" };
      case SOLD_OUT:
        return { kind: "unavailable", reason: "sold-out" };
      case NOT_ACTIVE:
        return { kind: "unavailable", reason: "not-running" };
      default:
        return { kind: "network-error" };
    }
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = claimCreditOfferResponseSchema.safeParse(response.body);
  // The body is read only for the card: a 2xx means the claim took, even when
  // the card never arrived.
  return { kind: "ok", offer: parsed.success ? parsed.data.campaign : null };
}
