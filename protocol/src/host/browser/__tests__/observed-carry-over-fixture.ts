import {
  browserSessionsClientFrameSchema,
  browserSessionsServerFrameSchema,
  type BrowserForgetLedger,
  type BrowserSessionsClientFrame,
  type BrowserSessionsServerFrame,
  type BrowserStorageCookie,
} from "../contracts";

/**
 * The one artifact the two halves of the universal-sign-in carry-over loop
 * share, and the reason neither half is allowed to invent the other's bytes.
 *
 * The loop crosses a REPO boundary - the host plane lives in the internal
 * monorepo, the desktop plane in this one - so no single process can run it end
 * to end. What can be shared is the wire, and this is it: every frame below is
 * built and then handed to the REAL `browser.sessions` union schema, so a
 * producer's shape is proven wire-legal at construction and a consumer is fed
 * exactly what the schema would have handed it.
 *
 * Each artifact is PRODUCED-pinned on one side and CONSUMED on the other, which
 * is what keeps this from becoming the mocked-both-sides fixture it exists to
 * replace:
 *
 * | Artifact                            | Pinned against the real producer | Consumed by                    |
 * | ----------------------------------- | -------------------------------- | ------------------------------ |
 * | {@link carryOverSignInCookies}      | host capture plane + store       | desktop applier                |
 * | {@link carryOverEchoCookies}        | desktop cookie-change observer   | host store, via a delta        |
 * | {@link carryOverForgetLedgerDigest} | desktop forget ledger            | host forget-ledger prune plane |
 *
 * WHICH HALVES ARE REAL, stated exactly, because the whole value of this file
 * is in not overclaiming it. On the desktop side both mappers run for real: the
 * applier writes through `cookies.set` and the change observer reads back out,
 * so the round trip is Chromium-shaped. On the host side the PLANE is real -
 * the store's grouping, its no-change gate, and the wire legality of what comes
 * out - but the Playwright mapper is not exercised anywhere, because a stub
 * driver echoes the object it was seeded with.
 *
 * That asymmetry is what {@link carryOverEchoCookies} is for. It is defined as
 * being IDENTICAL to {@link carryOverSignInCookies}, which forces the desktop's
 * real observer to reproduce the sign-in byte for byte - so the values in this
 * file are anchored by a real mapper even though the host half only pins the
 * plane around them.
 *
 * The one question that still cannot be answered here is ticket 07's live
 * check: a field that drifts only between real Chromium and real Playwright
 * reads as equal on both sides of this file. Pinning the echo makes such a
 * drift visible the moment either mapper changes; it is not proof that neither
 * already differs from the browser.
 *
 * Following the `chunk-reassembler-conformance` precedent: a `__tests__` module
 * exported from `package.json` so both repos import the same source, with no
 * `vitest` import of its own.
 */

/** The site the whole scenario signs into. */
export const CARRY_OVER_DOMAIN = "example.com";

/**
 * A fixed far-future expiry (2100-01-01) rather than a clock offset. The
 * desktop's applier compares `expires` against RECEIVE time, so a persistent
 * cookie in a shared fixture has to be unambiguously live on both sides of the
 * wire without either end agreeing on a clock first.
 */
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
 * The jar a headless sign-in leaves behind on a host: one session cookie on the
 * registrable domain itself, one persistent cookie on a subdomain.
 *
 * Both shapes are load-bearing. The session cookie carries the `-1` sentinel
 * the expired-cookie rejection must not mistake for a past time, and the
 * subdomain cookie is what proves a frame is scoped by REGISTRABLE domain on
 * both ends rather than by hostname.
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
 * The same sign-in as the desktop's cookie-change observer reports it back,
 * after Chromium has taken it: the ECHO half of the round trip.
 *
 * Identical to {@link carryOverSignInCookies} by design, and that identity is
 * the assertion rather than a shortcut. It is what makes the host's next
 * headless capture a no-op merge, which is the loop's only terminator - the
 * epic has no clocks, watermarks or hop counts to fall back on. The desktop
 * suite pins its real observer's output against this list, so a mapper that
 * starts spelling one field differently fails there instead of turning into an
 * unbounded emit/apply/echo cycle in production.
 */
export function carryOverEchoCookies(): readonly BrowserStorageCookie[] {
  return carryOverSignInCookies();
}

/** The narrowed `primaryProfileObserved` arm, as both suites read it. */
export type ObservedServerFrame = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "primaryProfileObserved" }
>;

/**
 * One `primaryProfileObserved` frame, through the real server-frame union - so
 * a producer's payload is proven wire-legal and a consumer is fed exactly what
 * the schema would have handed it.
 */
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

/**
 * The desktop's echo of an applied observation, through the real client-frame
 * union. `removedKeys` is empty because an applied observation only ever SETS -
 * a merge that removed something would be the implicit sign-out channel the
 * frame's shape is built to deny.
 */
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
 * The digest a desktop owes a host it could not reach when the user forgot
 * {@link CARRY_OVER_DOMAIN}: the offline-forget scenario, as the ledger
 * projects it.
 *
 * `forgottenAt` is a parameter because it is the desktop's own wall clock and
 * nothing else here is. The desktop suite pins its real digest against this
 * function applied to the timestamp that digest carries, so every other field -
 * the domain set, the absent forget-all, the revision - is the real producer's,
 * not this file's guess.
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
