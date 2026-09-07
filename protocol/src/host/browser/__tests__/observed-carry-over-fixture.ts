import {
  browserSessionsClientFrameSchema,
  browserSessionsServerFrameSchema,
  type BrowserForgetLedger,
  type BrowserSessionsClientFrame,
  type BrowserSessionsServerFrame,
  type BrowserStorageCookie,
} from "../contracts";

/**
 * The one artifact the two halves of the universal-sign-in carry-over loop share, and the reason neither half is allowed to invent the other's bytes.
 * The one question that still cannot be answered here is ticket 07's live check: a field that drifts only between real Chromium and real Playwright reads as equal on both sides of this file.
 */

/** The site the whole scenario signs into. */
export const CARRY_OVER_DOMAIN = "example.com";

/** A fixed far-future expiry (2100-01-01) rather than a clock offset. */
export const CARRY_OVER_PERSISTENT_EXPIRES = 4_102_444_800;

function cookie(input: {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly expires: number;
}): BrowserStorageCookie {
  return {
    name: input.name,
    value: input.value,
    domain: input.domain,
    path: "/",
    expires: input.expires,
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
    partitionKey: null,
  };
}

/**
 * The jar a headless sign-in leaves behind on a host: one session cookie on the registrable domain itself, one persistent cookie on a subdomain.
 * The session cookie carries the `-1` sentinel the expired-cookie rejection must not mistake for a past time, and the subdomain cookie is what proves a frame is scoped by REGISTRABLE domain on both ends rather than by.
 */
export function carryOverSignInCookies(): readonly BrowserStorageCookie[] {
  return [
    cookie({
      name: "sid",
      value: "signed-in",
      domain: CARRY_OVER_DOMAIN,
      expires: -1,
    }),
    cookie({
      name: "csrf",
      value: "token",
      domain: `www.${CARRY_OVER_DOMAIN}`,
      expires: CARRY_OVER_PERSISTENT_EXPIRES,
    }),
  ];
}

/**
 * The same sign-in as the desktop's cookie-change observer reports it back, after Chromium has taken it: the ECHO half of the round trip.
 */
export function carryOverEchoCookies(): readonly BrowserStorageCookie[] {
  return carryOverSignInCookies();
}

/** The narrowed `primaryProfileObserved` arm, as both suites read it. */
export type ObservedServerFrame = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "primaryProfileObserved" }
>;

export function observedFrame(input: {
  readonly domain: string;
  readonly cookies: readonly BrowserStorageCookie[];
}): ObservedServerFrame {
  const parsed = browserSessionsServerFrameSchema.parse({
    kind: "primaryProfileObserved",
    hasBinaryPayload: false,
    domain: input.domain,
    cookies: input.cookies,
  });
  if (parsed.kind !== "primaryProfileObserved") {
    throw new Error("expected a primaryProfileObserved frame");
  }
  return parsed;
}

/** The scenario's own observation: the headless sign-in, on its own domain. */
export function carryOverObservedFrame(): ObservedServerFrame {
  return observedFrame({
    domain: CARRY_OVER_DOMAIN,
    cookies: carryOverSignInCookies(),
  });
}

/** The desktop's echo of an applied observation, through the real client-frame union. */
export function echoDeltaFrame(input: {
  readonly issuedAt: number;
  readonly domain: string;
  readonly cookies: readonly BrowserStorageCookie[];
}): Extract<
  BrowserSessionsClientFrame,
  { readonly kind: "primaryProfileDelta" }
> {
  const parsed = browserSessionsClientFrameSchema.parse({
    kind: "primaryProfileDelta",
    hasBinaryPayload: false,
    domain: input.domain,
    cookies: input.cookies,
    removedKeys: [],
    issuedAt: input.issuedAt,
  });
  if (parsed.kind !== "primaryProfileDelta") {
    throw new Error("expected a primaryProfileDelta frame");
  }
  return parsed;
}

/**
 * The digest a desktop owes a host it could not reach when the user forgot {@link CARRY_OVER_DOMAIN}: the offline-forget scenario, as the ledger projects it.
 */
export function carryOverForgetLedgerDigest(
  forgottenAt: number,
): BrowserForgetLedger {
  return {
    forgetAllAt: null,
    domains: [{ domain: CARRY_OVER_DOMAIN, forgottenAt }],
    revision: 1,
  };
}

/** One forget-ledger digest, through the real client-frame union. */
export function forgetLedgerFrame(
  ledger: BrowserForgetLedger,
): Extract<
  BrowserSessionsClientFrame,
  { readonly kind: "primaryProfileForgetLedger" }
> {
  const parsed = browserSessionsClientFrameSchema.parse({
    kind: "primaryProfileForgetLedger",
    hasBinaryPayload: false,
    ...ledger,
  });
  if (parsed.kind !== "primaryProfileForgetLedger") {
    throw new Error("expected a primaryProfileForgetLedger frame");
  }
  return parsed;
}
