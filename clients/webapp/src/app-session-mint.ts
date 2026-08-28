import {
  credentialsIdentityFromAuthenticatedUser,
  exchangeCodeForTokens,
  validateAuthTokenIdentityAccessOnly,
  type AuthCodeExchangeResult,
} from "@traycer-clients/shared/auth/auth-validation";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";
import {
  CODE_CHALLENGE_METHOD,
  deriveCodeChallenge,
  generateCodeVerifier,
} from "@traycer-clients/shared/auth/pkce";
import type { ITokenStore } from "@traycer-clients/shared/platform/runner-host";

/**
 * The deployed dashboard route this shell hands off to. Same origin by
 * construction - this bundle is served from the web dashboard's own origin
 * (see `vite.config.ts`), which is also the only origin authn's CORS admits.
 *
 * The seam is the NAVIGATION, not the session. A tab cannot read the
 * dashboard's credential: it lives in that app's own storage under a private
 * schema with no public accessor. `/login/app` is the piece that already knows
 * how to read it - it calls `issue-code` with its own live session and bounces
 * back to a validated `redirect_uri` carrying a one-time `code`.
 */
const LOGIN_APP_PATH = "/login/app";

/** The query parameter the deployed `/login/app` appends on its way back. */
const RETURN_CODE_PARAM = "code";

/**
 * Total silent-mint navigations one tab will ever issue: the first attempt and
 * exactly one retry.
 *
 * This is the loop bound, and it is counted over NAVIGATIONS rather than over
 * observed failures on purpose. Every way this handoff can disappoint looks
 * the same from here - a code that is expired, already spent, or never
 * appended at all because the dashboard resolved a different continuation -
 * and only a counter that survives the round trip can tell the second landing
 * from the first. A tab that has spent both lands on the device flow instead,
 * which needs no dashboard session at all.
 */
const MAX_MINT_NAVIGATIONS = 2;

/**
 * Where the PKCE verifier and the attempt counter live for the length of the
 * round trip.
 *
 * `sessionStorage`, not `localStorage`: the bundle's own credential is
 * origin-wide because a browser holds ONE session, but a mint in flight
 * belongs to the tab that started it. A second tab minting at the same moment
 * has its own verifier and its own budget, and neither can consume the
 * other's. It also disposes itself - closing the tab ends the attempt - which
 * a durable slot would not.
 */
export const WEB_MINT_VERIFIER_KEY = "traycer.webapp.mint.verifier";
export const WEB_MINT_NAVIGATION_KEY = "traycer.webapp.mint.navigations";

/**
 * The document's URL and the two ways this flow changes it, as a seam.
 *
 * Injected rather than reached for because both writes are unobservable in a
 * test that owns no browser: `navigate` unloads the document (jsdom refuses
 * it) and `rewrite` is the history entry the address bar shows. The
 * distinction between them is load-bearing - one leaves, one does not - so it
 * is named here rather than left to a call site to get right.
 */
export interface MintLocation {
  /** Absolute href of this document, query and fragment included. */
  readonly href: string;
  /** Leaves this document for `url`. Nothing after this call runs to effect. */
  navigate(url: string): void;
  /** Replaces the current history entry in place, without navigating. */
  rewrite(url: string): void;
}

/** Tab-scoped string slots; `sessionStorage`'s surface, narrowed. */
export interface MintScratchpad {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

/** The PKCE pair generator, injectable so a test can pin the challenge. */
export interface MintPkce {
  generateVerifier(): string;
  deriveChallenge(verifier: string): Promise<string>;
}

export interface AppSessionMintOptions {
  readonly location: MintLocation;
  readonly scratchpad: MintScratchpad;
  readonly tokenStore: ITokenStore;
  readonly authnBaseUrl: string;
  readonly exchange: (
    code: string,
    codeVerifier: string,
  ) => Promise<AuthCodeExchangeResult>;
  readonly probeIdentity: (
    token: string,
  ) => Promise<AuthIdentityValidationResult>;
  readonly pkce: MintPkce;
}

/**
 * What the boot sequence should do next.
 *
 * `navigating` is the one arm that is not a state: the document is on its way
 * out, so the caller must render nothing rather than mount an app that is
 * about to be torn down mid-paint.
 */
export type AppSessionMintOutcome =
  | { readonly kind: "stored-credential" }
  | { readonly kind: "navigating" }
  | { readonly kind: "minted" }
  | {
      readonly kind: "device-flow-fallback";
      readonly reason: MintGiveUpReason;
    };

/**
 * Why a mint stopped short of a credential. Every value here routes to the
 * same place - the shell's device flow - and exists to be logged, not
 * branched on.
 */
export type MintGiveUpReason =
  | "no-code-returned"
  | "verifier-missing"
  | "code-rejected"
  | "exchange-unreachable"
  | "identity-unresolved";

/**
 * Mints an independent app credential from the dashboard's session, with no
 * interaction beyond a same-origin redirect bounce.
 *
 * The round trip, once:
 *
 * 1. Generate a PKCE verifier and its S256 challenge, keep the verifier in
 *    this tab, and navigate to `/login/app` with the challenge and a RELATIVE
 *    `redirect_uri` pointing back at the exact page the visitor asked for.
 * 2. `/login/app` reads its own dashboard session, calls `issue-code`, and
 *    sends the browser back to that `redirect_uri` with `?code=...`.
 * 3. This function runs again on that landing, spends the code against
 *    `exchange-code` with the verifier it kept, and commits the resulting pair
 *    to the shell's own token store.
 *
 * Signed out, step 2 becomes a full sign-in first, and the handoff survives it
 * ONLY because both parameters travel together - see {@link loginAppUrl}.
 *
 * The credential this produces is a sibling of the dashboard's, not a view
 * onto it: its own family, revoked and refreshed on its own, so signing out of
 * one leaves the other alone.
 */
export async function runAppSessionMint(
  options: AppSessionMintOptions,
): Promise<AppSessionMintOutcome> {
  const returning = await consumeReturnedCode(options);
  if (returning !== null) {
    return returning;
  }
  if ((await options.tokenStore.get()) !== null) {
    return { kind: "stored-credential" };
  }
  return beginMint(options, "no-code-returned");
}

/**
 * Spends a `code` this landing carries, or reports that there was none to
 * spend (`null`).
 *
 * The code leaves the address bar BEFORE it is spent, and the verifier leaves
 * the scratchpad in the same breath. Both are single-use, and the failure that
 * matters is not losing them - it is keeping them: a reload that re-presents a
 * spent code, or a retry that pairs a fresh challenge with a stale verifier.
 * Removing them first makes every path below - success, rejection, a closed
 * tab mid-exchange - land on the same "nothing to replay" state.
 */
async function consumeReturnedCode(
  options: AppSessionMintOptions,
): Promise<AppSessionMintOutcome | null> {
  const url = new URL(options.location.href);
  const code = url.searchParams.get(RETURN_CODE_PARAM);
  if (code === null || code.length === 0) {
    return null;
  }
  const verifier = options.scratchpad.read(WEB_MINT_VERIFIER_KEY);
  options.scratchpad.remove(WEB_MINT_VERIFIER_KEY);
  url.searchParams.delete(RETURN_CODE_PARAM);
  options.location.rewrite(relativeReference(url));

  // A code with no verifier cannot be spent by this tab - it belongs to a
  // round trip that started somewhere else (another tab, or a page life this
  // one does not remember). Spending it is not merely futile, it would burn a
  // code that its own tab may still be waiting to use.
  if (verifier === null || verifier.length === 0) {
    return beginMint(options, "verifier-missing");
  }
  // A credential committed while this tab was away (a sibling's mint, or its
  // own earlier one) outranks the code: adopt it and let the code expire.
  if ((await options.tokenStore.get()) !== null) {
    return { kind: "stored-credential" };
  }

  const exchanged = await options.exchange(code, verifier);
  if (exchanged.kind === "rejected") {
    return beginMint(options, "code-rejected");
  }
  if (exchanged.kind === "network-error") {
    return beginMint(options, "exchange-unreachable");
  }

  // `signIn` needs an identity, and the pair is the only thing the exchange
  // returns. Read it the way the store's own legacy migration does: an
  // access-only probe, which cannot spend the refresh token that has just been
  // minted alongside it.
  const probe = await options.probeIdentity(exchanged.token);
  if (probe.kind !== "valid") {
    return beginMint(options, "identity-unresolved");
  }
  await options.tokenStore.signIn(
    { token: exchanged.token, refreshToken: exchanged.refreshToken },
    credentialsIdentityFromAuthenticatedUser(probe.user),
  );
  options.scratchpad.remove(WEB_MINT_NAVIGATION_KEY);
  return { kind: "minted" };
}

/**
 * Starts (or retries) the handoff, or gives up to the device flow once this
 * tab has spent its navigation budget.
 */
async function beginMint(
  options: AppSessionMintOptions,
  reason: MintGiveUpReason,
): Promise<AppSessionMintOutcome> {
  const spent = readNavigationCount(options.scratchpad);
  if (spent >= MAX_MINT_NAVIGATIONS) {
    return { kind: "device-flow-fallback", reason };
  }

  const verifier = options.pkce.generateVerifier();
  const challenge = await options.pkce.deriveChallenge(verifier);
  // Re-read after the derivation: a sibling tab of this origin may have
  // committed a credential while we hashed, and this tab shares that storage.
  // Navigating anyway would take a signed-in visitor away from the page they
  // are already entitled to see.
  if ((await options.tokenStore.get()) !== null) {
    return { kind: "stored-credential" };
  }

  options.scratchpad.write(WEB_MINT_VERIFIER_KEY, verifier);
  options.scratchpad.write(WEB_MINT_NAVIGATION_KEY, String(spent + 1));
  options.location.navigate(
    loginAppUrl(new URL(options.location.href), challenge),
  );
  return { kind: "navigating" };
}

/**
 * The `/login/app` URL for one attempt.
 *
 * BOTH PKCE parameters travel with the redirect uri, always, and that is the
 * whole reason a signed-out visitor completes this flow instead of looping.
 * `/login/app` persists what it is given before the auth gate turns a
 * signed-out visitor around, and the dashboard's post-session continuation
 * then reads those persisted values back to decide where a freshly minted
 * session goes: a redirect uri WITH a challenge is the app handoff, a redirect
 * uri WITHOUT one is the editor-extension handoff, which returns a token in
 * the URL and never a `code` this shell can spend. So dropping the challenge
 * does not degrade the flow, it silently selects a different one - and the
 * visitor comes back to a page that still has no credential.
 *
 * The redirect uri is a RELATIVE reference carrying the whole destination -
 * path, query and fragment. Relative because the dashboard's validator admits
 * a same-origin relative uri directly, and whole because the query and
 * fragment ARE the page: returning a visitor to the bare path returns them
 * somewhere else, silently.
 */
function loginAppUrl(current: URL, codeChallenge: string): string {
  const target = new URL(LOGIN_APP_PATH, current.origin);
  target.searchParams.set("redirect_uri", relativeReference(current));
  target.searchParams.set("code_challenge", codeChallenge);
  target.searchParams.set("code_challenge_method", CODE_CHALLENGE_METHOD);
  return target.toString();
}

/** `/path?query#fragment` - the destination as the dashboard accepts it. */
function relativeReference(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * A malformed or absent counter reads as "none spent". The slot is written
 * only by this module and only with a small integer, so anything else is a
 * foreign write - and treating it as a spent budget would strand a tab on the
 * device flow for a value it never wrote.
 */
function readNavigationCount(scratchpad: MintScratchpad): number {
  const raw = scratchpad.read(WEB_MINT_NAVIGATION_KEY);
  if (raw === null) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/** `window.location` / `history`, as the seam above. */
export function createWindowMintLocation(): MintLocation {
  return {
    get href(): string {
      return window.location.href;
    },
    navigate: (url) => {
      // `assign`, not `replace`: the entry being left is the app's own deep
      // link, and it is where Back should come back to.
      window.location.assign(url);
    },
    rewrite: (url) => {
      window.history.replaceState(window.history.state, "", url);
    },
  };
}

/** `sessionStorage`, as the seam above. */
export function createSessionScratchpad(): MintScratchpad {
  return {
    read: (key) => window.sessionStorage.getItem(key),
    write: (key, value) => {
      window.sessionStorage.setItem(key, value);
    },
    remove: (key) => {
      window.sessionStorage.removeItem(key);
    },
  };
}

/**
 * The deployed exchange, and the client kind it assigns.
 *
 * Nothing in this request names a client: `exchange-code` mints with a
 * `desktop` client kind of its own accord, so a tab currently appears in
 * Devices & Sessions as a desktop app. Making it honest is a two-sided change
 * and BOTH sides are outside this module - authn's mint has to learn a web
 * kind, and this shell's OTHER sign-in path, the device flow, passes its own
 * `client_id` (`web-runner-host.ts`). Neither is a constant this file could
 * flip.
 */
export function exchangeAppCode(
  authnBaseUrl: string,
): (code: string, codeVerifier: string) => Promise<AuthCodeExchangeResult> {
  return (code, codeVerifier) =>
    exchangeCodeForTokens(authnBaseUrl, code, codeVerifier);
}

/** The access-only identity read, bound to one authn. */
export function probeAppIdentity(
  authnBaseUrl: string,
): (token: string) => Promise<AuthIdentityValidationResult> {
  return (token) => validateAuthTokenIdentityAccessOnly(authnBaseUrl, token);
}

/** The real PKCE pair, from the shared browser-safe helpers. */
export const webCryptoPkce: MintPkce = {
  generateVerifier: generateCodeVerifier,
  deriveChallenge: deriveCodeChallenge,
};
