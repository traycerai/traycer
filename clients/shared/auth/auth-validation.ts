/**
 * Stateless boundary helpers that turn a raw bearer token into a full
 * `AuthenticatedUser` identity, refresh a token pair, or exchange a PKCE code.
 *
 * Lives under `shared/auth/` because it is the auth-boundary conversion
 * point: raw bearer strings are allowed here only inside validation/refresh
 * helpers, and everything past the boundary trades them for a
 * `RequestContext`. Keeping these helpers stateless and platform-neutral
 * means they can run from Electron main, mobile native, browser preview,
 * or unit tests without any DI or singleton state.
 *
 * Validation is ACCESS-ONLY (credentials-file token-store tech plan §3): the
 * `validateAuthTokenIdentity*` helpers do a single identity lookup with NO
 * refresh-on-401, so they can never spend a refresh token. Every *spend* runs
 * inside the credentials file lock via the mutation store's `rotate`, which
 * injects the single-attempt `refreshOnceAbortable` below as its `RefreshFn`.
 *
 * ## Which identity route, and why there are two
 *
 * The user record is versioned, and `APPLE` widened a closed enum that every
 * released client validates `GET /api/v3/user` against - so that route is
 * frozen at record major 1 forever and a NEW route serves the negotiated
 * shape. This client advertises the majors it can parse, reads the major the
 * server chose off the response, and upgrades to its own latest through the
 * registry's bridges.
 *
 * The frozen route is still reached, as a recovery and never as a retry - see
 * {@link fetchIdentityOnce}. Against an authn-v3 that predates the negotiated
 * route that costs two requests per validation, which is accepted: authn-v3
 * ships before the clients, and the alternative is a released-server 404
 * reading as a dead credential.
 */
import {
  authRecordRegistry,
  type AuthRecordRegistry,
} from "@traycer/protocol/auth/registry";
import {
  getLatestRecordContract,
  loadRecord,
  type SchemaVersion,
} from "@traycer/protocol/framework/index";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  AuthTokenRefreshResult,
  StoredCredentials,
} from "../platform/runner-host";
import type {
  AuthIdentityValidationResult,
  AuthServerTimeObservation,
} from "./auth-validation-types";

export type {
  AuthIdentityValidationResult,
  AuthIdentityValidResult,
  AuthServerTimeObservation,
} from "./auth-validation-types";
export type { AuthTokenRefreshResult } from "../platform/runner-host";

/**
 * The negotiated identity route and the two headers it is negotiated with.
 *
 * COPIED, not imported: these are owned by authn-v3
 * (`src/utils/users/user-record-version.ts`) and an OSS client cannot reach
 * an internal package. They are a wire contract on both sides - a rename in
 * either repo breaks negotiation silently, degrading every validation onto
 * the frozen route.
 */
const NEGOTIATED_USER_PATH = "api/v3/user/negotiated";
const USER_RECORD_MAJORS_REQUEST_HEADER = "x-traycer-user-record-majors";
const USER_RECORD_VERSION_RESPONSE_HEADER = "x-traycer-user-record-version";

/**
 * The frozen route. It pins the record to major 1 whatever a caller
 * advertises, so this client never reads a served-version header off it: the
 * parse version is {@link FROZEN_RECORD_VERSION} by construction, which also
 * keeps the recovery request byte-identical to the one this file has always
 * sent.
 */
const FROZEN_USER_PATH = "api/v3/user";

const AUTHENTICATED_USER_RESPONSE_RECORD =
  authRecordRegistry["authenticated-user-response"];

type AuthenticatedUserResponseMajor =
  keyof AuthRecordRegistry["authenticated-user-response"] & number;

/**
 * The record majors this build advertises, and can therefore be served.
 *
 * Restated rather than derived from `Object.keys`, the same way authn-v3's
 * `SUPPORTED_USER_RECORD_MAJORS` is: a runtime list cannot be narrowed back
 * to the union without a hand-written guard that restates the same thing one
 * level down. The annotation rejects a major that is not installed, and
 * `auth-validation.test.ts` pins the list against the registry so a NEW major
 * fails a test instead of going silently unadvertised.
 *
 * The majors are the ENVELOPE's, not the nested `user` the header is named
 * after. Both move together by construction - an envelope gains a major
 * precisely because the user inside it did - and advertising what can
 * actually be PARSED is the safer of the two if they ever drift.
 */
export const SUPPORTED_USER_RECORD_MAJORS: readonly AuthenticatedUserResponseMajor[] =
  [1, 2];

const ADVERTISED_USER_RECORD_MAJORS = SUPPORTED_USER_RECORD_MAJORS.join(",");

const SUPPORTED_MAJOR_BY_NUMBER: ReadonlyMap<
  number,
  AuthenticatedUserResponseMajor
> = new Map(SUPPORTED_USER_RECORD_MAJORS.map((major) => [major, major]));

/** Major 1's installed version - the only shape the frozen route serves. */
const FROZEN_RECORD_VERSION: SchemaVersion = getLatestRecordContract(
  AUTHENTICATED_USER_RESPONSE_RECORD,
  1,
).schemaVersion;

/**
 * Resolves `x-traycer-user-record-version` onto an installed version of the
 * record, or `null` when this build cannot use it.
 *
 * `null` is NOT a rejection. Absent, malformed and "a major this build does
 * not have" all mean one thing here - this response cannot be parsed safely -
 * and the caller recovers on the frozen route instead. Letting any of them
 * reach the parse would surface as a credential rejection, and a rejection
 * can spend a refresh token and demote the session.
 *
 * The MINOR is checked for shape and then deliberately ignored: minors are
 * additive by the framework's rules, so this build's latest installed minor
 * for that major parses a body from any minor of it - an older server omits
 * fields a newer minor added (which are optional), a newer one sends fields
 * this schema drops.
 */
function resolveServedRecordVersion(
  header: string | null,
): SchemaVersion | null {
  if (header === null) {
    return null;
  }
  const match = /^(\d{1,4})\.(\d{1,6})$/.exec(header.trim());
  if (match === null) {
    return null;
  }
  const major = SUPPORTED_MAJOR_BY_NUMBER.get(Number(match[1]));
  if (major === undefined) {
    return null;
  }
  return getLatestRecordContract(AUTHENTICATED_USER_RESPONSE_RECORD, major)
    .schemaVersion;
}

/**
 * Per-attempt ceiling and bounded exponential-backoff retry for the auth
 * boundary's HTTP calls (the identity routes, `/api/v3/auth/refresh`).
 *
 * Every attempt is time-boxed with `AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS)`
 * so a stalled/half-open socket can no longer hang the caller indefinitely -
 * previously an un-timed-out `fetch` here could block `auth.start()` (and, through
 * it, the renderer's "Loading Traycer…" gate) until the OS TCP timeout,
 * i.e. many minutes. A fired timeout rejects the `fetch`, which the surrounding
 * `catch` already collapses to `network-error`; that outcome (plus a 5xx or a 409
 * refresh-grace race) is the only one re-driven. A terminal `rejected`/`valid`
 * returns on the first attempt.
 *
 * Total wall-clock is bounded to `AUTH_FETCH_MAX_ATTEMPTS` attempts spaced by an
 * exponential backoff capped at `AUTH_FETCH_RETRY_MAX_DELAY_MS`.
 */
export const AUTH_FETCH_MAX_ATTEMPTS = 3;
const AUTH_FETCH_TIMEOUT_MS = 10_000;
const AUTH_FETCH_RETRY_BASE_DELAY_MS = 500;
const AUTH_FETCH_RETRY_MAX_DELAY_MS = 4_000;

/**
 * Runs `attempt`, then re-drives it while `isTransient(outcome)` holds, up to
 * `AUTH_FETCH_MAX_ATTEMPTS` total invocations. Never throws: `attempt` is a
 * boundary helper that already maps every transport failure (including a fired
 * per-attempt timeout) to a typed outcome, so there is nothing to catch here.
 */
async function withAuthNetworkRetry<T>(
  attempt: () => Promise<T>,
  isTransient: (outcome: T) => boolean,
): Promise<T> {
  let outcome = await attempt();
  for (
    let retry = 1;
    retry < AUTH_FETCH_MAX_ATTEMPTS && isTransient(outcome);
    retry += 1
  ) {
    await delayFor(authRetryDelayMs(retry));
    outcome = await attempt();
  }
  return outcome;
}

export function authRetryDelayMs(retry: number): number {
  const candidate = AUTH_FETCH_RETRY_BASE_DELAY_MS * 2 ** (retry - 1);
  return Math.min(candidate, AUTH_FETCH_RETRY_MAX_DELAY_MS);
}

function delayFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * True for an abort/timeout thrown while reading a response body *after* the
 * headers arrived - the per-attempt `AbortSignal.timeout` (a `TimeoutError`) or
 * a caller abort (`AbortError`) firing during `response.json()`. Such a failure
 * is transient/retriable and must surface as `network-error`, NOT be collapsed
 * into a terminal `rejected`/invalid body the way a genuine parse failure is.
 */
function isAbortOrTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * Access-only full-identity validation (credentials-file token-store tech plan
 * §3): a single identity lookup with NO refresh-on-401 fallback, so it can
 * never spend a refresh token. This is the validator the desktop renderer's
 * `AuthService` uses everywhere it checks a bearer (startup rehydration, reactive
 * 401 revalidation, device-flow finalization, cross-window projection): a stale
 * access token comes back `rejected`/`network-error` and the caller routes the
 * *spend* through the locked `rotate` op instead. `valid` never carries a
 * `refreshedToken` — the pair on hand is unchanged.
 */
export function validateAuthTokenIdentityAccessOnly(
  authnBaseUrl: string,
  token: string,
): Promise<AuthIdentityValidationResult> {
  return validateAuthTokenIdentityFetch(authnBaseUrl, token);
}

/**
 * Single-attempt, ~10s, abort-aware access-only identity probe — the migration
 * counterpart to {@link validateAuthTokenIdentityAccessOnly} (tech plan §6).
 * ONE identity lookup with NO refresh-on-401 (never spends) and NO internal
 * retry: the migration state machine owns bounded re-entry and threads its
 * deadline `signal` through here, so a slow probe cannot outlive the migration
 * budget or blur its "L unspent" accounting the way the 3×10s stack would. The
 * `signal` is combined with a fresh ~10s timeout (à la {@link refreshOnceAbortable});
 * either firing collapses to `network-error`.
 *
 * "ONE lookup" is one ATTEMPT, which may include the frozen-route recovery
 * {@link fetchIdentityOnce} owns. That recovery rides this same combined
 * signal, so the pair shares one deadline and one abort - the budget this
 * entry point exists to bound is unchanged.
 */
export async function validateAuthTokenIdentityAccessOnceAbortable(args: {
  readonly authnBaseUrl: string;
  readonly token: string;
  readonly signal: AbortSignal | null;
}): Promise<AuthIdentityValidationResult> {
  const timeout = AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS);
  const signal =
    args.signal === null ? timeout : AbortSignal.any([args.signal, timeout]);
  const result = await fetchIdentityOnce(args.authnBaseUrl, args.token, signal);
  return toIdentityValidationResult(result);
}

async function validateAuthTokenIdentityFetch(
  authnBaseUrl: string,
  token: string,
): Promise<AuthIdentityValidationResult> {
  return toIdentityValidationResult(
    await fetchUserResponse(authnBaseUrl, token),
  );
}

/**
 * Projects an identity fetch onto the caller-facing result, re-attaching the
 * response's server-time observation to every outcome that had one. The
 * projection is shared by the retrying and single-attempt validators so the
 * clock-skew tracker sees the same sample whichever one ran.
 *
 * The body is parsed against the version the SERVER said it served and then
 * migrated to this build's latest through the registry's upgrade chain, so a
 * major-1 body from the frozen route and a major-2 body from the negotiated
 * one reach `applySignedIn` as the same shape. A failure here is still a
 * terminal `rejected`, exactly as a bad body always was: the version was
 * resolved to an installed one before the request's body was even read, so
 * what is left is a 2xx that does not match the contract it claims.
 */
function toIdentityValidationResult(
  result: UserFetchResult,
): AuthIdentityValidationResult {
  const serverTime = serverTimeFields(result.serverTime);
  if (result.kind !== "ok") {
    return result.result.kind === "rejected"
      ? { kind: "rejected", ...serverTime }
      : { kind: "network-error" };
  }
  let user: AuthenticatedUser;
  try {
    user = loadRecord(
      authRecordRegistry,
      "authenticated-user-response",
      result.body,
      result.recordVersion,
    );
  } catch {
    return { kind: "rejected", ...serverTime };
  }
  return { kind: "valid", user, ...serverTime };
}

/**
 * Spreads to nothing when there is no observation, so an absent `Date` header
 * leaves the property off entirely rather than setting it to `undefined`.
 */
function serverTimeFields(serverTime: AuthServerTimeObservation | null): {
  readonly serverTime?: AuthServerTimeObservation;
} {
  return serverTime === null ? {} : { serverTime };
}

/**
 * Reads the response's HTTP `Date` header as a server-time sample, paired with
 * the local clock right now. Opportunistic: an absent or unparseable header
 * yields `null`, never a guess.
 */
function readServerTimeObservation(
  response: Response,
): AuthServerTimeObservation | null {
  const header = response.headers.get("date");
  if (header === null) {
    return null;
  }
  const serverEpochMs = Date.parse(header);
  if (Number.isNaN(serverEpochMs)) {
    return null;
  }
  return { serverEpochMs, observedAtMs: Date.now() };
}

/**
 * Projects a validated `AuthenticatedUser` onto the `StoredCredentials.user`
 * identity block persisted in the credentials file. Shared so the device-flow
 * sign-in (renderer) and the §6 migration `/user` probe (main) stamp identical
 * identity shapes; `email`/`name` fall back exactly as the file's decoder
 * tolerates.
 *
 * NB: distinct from protocol's `identityFromAuthenticatedUser`, which projects
 * onto the `AuthenticatedIdentity` (`{ userId, username, providerHandle }`) a
 * `RequestContext` carries — a different shape for a different consumer.
 */
export function credentialsIdentityFromAuthenticatedUser(
  user: AuthenticatedUser,
): StoredCredentials["user"] {
  return {
    id: user.user.id,
    email: user.user.email ?? "",
    name: user.user.name ?? user.user.providerHandle,
  };
}

type UserFetchResult =
  | {
      readonly kind: "ok";
      readonly body: unknown;
      /** The installed version `body` is to be parsed at. */
      readonly recordVersion: SchemaVersion;
      readonly serverTime: AuthServerTimeObservation | null;
    }
  | {
      readonly kind: "failed";
      readonly result:
        | { readonly kind: "rejected" }
        | { readonly kind: "network-error" };
      // `null` whenever no response arrived (transport failure / timeout) or
      // the response carried no usable `Date`.
      readonly serverTime: AuthServerTimeObservation | null;
    };

async function fetchUserResponse(
  authnBaseUrl: string,
  token: string,
): Promise<UserFetchResult> {
  return withAuthNetworkRetry(
    () =>
      fetchIdentityOnce(
        authnBaseUrl,
        token,
        AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
      ),
    isUserFetchTransient,
  );
}

function isUserFetchTransient(result: UserFetchResult): boolean {
  return result.kind === "failed" && result.result.kind === "network-error";
}

/** One route's answer, before endpoint selection has had its say. */
type UserRouteAttempt =
  | {
      readonly kind: "ok";
      readonly body: unknown;
      readonly recordVersion: SchemaVersion;
      readonly serverTime: AuthServerTimeObservation | null;
    }
  // A 2xx this build cannot label: the served-version header was absent,
  // malformed, or named a major it does not have. Distinct from every failure
  // below, because nothing about the CREDENTIAL went wrong.
  | {
      readonly kind: "unversioned";
      readonly serverTime: AuthServerTimeObservation | null;
    }
  | {
      readonly kind: "rejected";
      // Carried so endpoint selection can tell a 404 (which may mean "this
      // deployment has no such route") from a 401/403 (a verdict about the
      // credential, identical on either route).
      readonly status: number;
      readonly serverTime: AuthServerTimeObservation | null;
    }
  | {
      readonly kind: "network-error";
      readonly serverTime: AuthServerTimeObservation | null;
    };

/**
 * One identity validation attempt: the negotiated route, and at most one
 * recovery on the frozen route, both under the caller's `signal`.
 *
 * The recovery is ENDPOINT SELECTION, not a retry. That is why it lives
 * inside the unit `withAuthNetworkRetry` re-drives rather than beside it, and
 * why both requests share one abort and one deadline - a fallback that
 * multiplied with the retry ceiling would turn a 3-request budget into 6 on
 * every validation. Exactly two answers reach it:
 *
 * - **a 404.** It may mean the negotiated route does not exist on this
 *   deployment. It may equally mean a deleted user or a missing subscription:
 *   the same resolver answers 404 for both, and a gateway can invent one. So
 *   the frozen route's own classification is then applied IN FULL, its own
 *   404 included, which stays `rejected` exactly as today.
 * - **a 2xx this build cannot label** (see {@link resolveServedRecordVersion}).
 *
 * A 401 or a 403 is never recovered from: it is a verdict about the
 * credential, and the frozen route would answer the same one request later.
 * Neither is any other non-2xx - a 5xx on the new route is an outage, which
 * the transient retry above already owns.
 */
async function fetchIdentityOnce(
  authnBaseUrl: string,
  token: string,
  signal: AbortSignal,
): Promise<UserFetchResult> {
  const negotiated = await fetchUserRouteOnce(authnBaseUrl, token, signal, {
    path: NEGOTIATED_USER_PATH,
    pinnedRecordVersion: null,
  });
  if (negotiated.kind === "ok") {
    return {
      kind: "ok",
      body: negotiated.body,
      recordVersion: negotiated.recordVersion,
      serverTime: negotiated.serverTime,
    };
  }
  if (negotiated.kind === "network-error") {
    return {
      kind: "failed",
      result: { kind: "network-error" },
      serverTime: negotiated.serverTime,
    };
  }
  if (negotiated.kind === "rejected" && negotiated.status !== 404) {
    return {
      kind: "failed",
      result: { kind: "rejected" },
      serverTime: negotiated.serverTime,
    };
  }

  const frozen = await fetchUserRouteOnce(authnBaseUrl, token, signal, {
    path: FROZEN_USER_PATH,
    pinnedRecordVersion: FROZEN_RECORD_VERSION,
  });
  switch (frozen.kind) {
    case "ok":
      return {
        kind: "ok",
        body: frozen.body,
        recordVersion: frozen.recordVersion,
        serverTime: frozen.serverTime,
      };
    case "rejected":
      return {
        kind: "failed",
        result: { kind: "rejected" },
        serverTime: frozen.serverTime,
      };
    case "unversioned":
    // Unreachable: the frozen route's version is pinned, so its header is
    // never consulted. Grouped with the transport failure rather than with
    // the rejection, because "this build could not label the response" must
    // never be the thing that spends a refresh token.
    case "network-error":
      return {
        kind: "failed",
        result: { kind: "network-error" },
        serverTime: frozen.serverTime,
      };
  }
}

async function fetchUserRouteOnce(
  authnBaseUrl: string,
  token: string,
  signal: AbortSignal,
  route: {
    readonly path: string;
    /**
     * `null` reads the served version off the response - the negotiated
     * route. A version here pins the parse and the response header is not
     * consulted at all, which is what keeps the frozen route frozen.
     */
    readonly pinnedRecordVersion: SchemaVersion | null;
  },
): Promise<UserRouteAttempt> {
  let response: Response;
  try {
    response = await fetch(authnApiUrl(authnBaseUrl, route.path), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(route.pinnedRecordVersion === null
          ? {
              [USER_RECORD_MAJORS_REQUEST_HEADER]:
                ADVERTISED_USER_RECORD_MAJORS,
            }
          : {}),
      },
      signal,
    });
  } catch {
    // A thrown `fetch` - a transport failure OR the per-attempt
    // `AbortSignal.timeout` firing (a `TimeoutError`) - is transient and
    // retriable, so both collapse to `network-error`.
    return { kind: "network-error", serverTime: null };
  }

  // Read BEFORE any status branching: a 401 response is a server-time sample
  // exactly as good as a 200, and it is the one a badly skewed client actually
  // gets back.
  const serverTime = readServerTimeObservation(response);

  // 403 joins 401/404 here, closing an asymmetry that predates this ticket and
  // was invisible because the two halves are read separately: the REFRESH path
  // has always treated 403 as a rejection, while this one let it fall through
  // to `network-error` below - so a forbidden identity lookup was retried into
  // the recovery backoff FOREVER, never settling and never reaching the rotate
  // that would classify it. A 403 is a verdict, not an outage.
  //
  // This function reads ONLY `response.status` - it parses no error body - so it
  // deliberately does not try to say WHAT kind of verdict. That discrimination
  // happens on the refresh spend, where the payload carries `revocation_scope`;
  // `rejected` here just means "stop retrying and go ask the rotate".
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  ) {
    return { kind: "rejected", status: response.status, serverTime };
  }

  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error", serverTime };
  }

  // Before the body: an unlabelled response is not read at all, so a body-read
  // failure can never be confused with a header this build could not use.
  const recordVersion =
    route.pinnedRecordVersion ??
    resolveServedRecordVersion(
      response.headers.get(USER_RECORD_VERSION_RESPONSE_HEADER),
    );
  if (recordVersion === null) {
    return { kind: "unversioned", serverTime };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // A timeout/abort firing mid-body-read (after headers) is transient, not a
    // dead credential - classify it like a pre-headers abort. A genuinely
    // malformed 2xx body stays `rejected`, and `status` being a 2xx is what
    // keeps endpoint selection from reading it as a missing route.
    if (isAbortOrTimeout(error)) {
      return { kind: "network-error", serverTime };
    }
    return { kind: "rejected", status: response.status, serverTime };
  }
  return { kind: "ok", body, recordVersion, serverTime };
}

/**
 * Single-attempt, ~10s, abort-aware refresh — the exact shape the credentials
 * mutation store injects as its `RefreshFn` (tech plan §2/§3). It makes ONE
 * bounded attempt so it fits the "at most one refresh per lock hold" budget: the
 * locked rotate holds the credentials lock across this call, so a multi-attempt
 * helper would blow the lock hold time and starve a competing sign-out. The
 * caller's `signal` (the rotate/migration `AbortSignal`) is combined with a fresh
 * ~10s timeout, so either the caller aborting or the deadline firing collapses to
 * `network-error` (nothing spent — the retry re-enters under a fresh lock).
 */
export async function refreshOnceAbortable(args: {
  readonly authnBaseUrl: string;
  readonly token: string;
  readonly refreshToken: string;
  readonly clientKind: "cli" | "desktop" | null;
  readonly signal: AbortSignal | null;
}): Promise<AuthTokenRefreshResult> {
  const timeout = AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS);
  const signal =
    args.signal === null ? timeout : AbortSignal.any([args.signal, timeout]);
  return refreshAuthTokenOnceViaHttp(
    args.authnBaseUrl,
    args.token,
    args.refreshToken,
    args.clientKind,
    signal,
  );
}

/**
 * Narrowing guard for an unknown JSON body. A type predicate rather than the
 * `body as Record<string, unknown>` cast this file uses further down: the
 * predicate is checkable at every call site and needs no assertion at all.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Reads the additive `revocation_scope` off a `needs_reauth` refresh reject.
 *
 * authn stamps it ONLY on the per-user epoch gate — the routine "sign out
 * everywhere" tokenVersion bump — and deliberately omits it on the
 * fork-suspicious rejects (burned replay past grace, family kill), so ABSENCE
 * is itself the signal that something unusual happened.
 *
 * DIRECTION OF THE UNKNOWN CASE, and it is copied rather than re-derived. The
 * host already settled this at `traycer-host/src/coordination/coordination-api.ts`
 * (`readRevocationScope`): an exact match on `"user_epoch"`, and `null` for
 * absent, malformed OR unrecognised values — so an unknown scope falls in with
 * the fork-suspicious ones and fails toward paging. Writing this as
 * `scope === "user_epoch" ? routine : ...` and letting everything else read as
 * routine inverts that: a scope value added to authn tomorrow would silently
 * downgrade an unfamiliar rejection to the benign branch on every older client.
 * Two readers of one wire field disagreeing about the unknown case is the same
 * defect class as two surfaces disagreeing about entitlement.
 *
 * Body-read failures also return `null`. A rejection is already terminal for
 * this credential; being unable to parse its body must not upgrade the
 * classification, and it must never throw into the refresh path.
 */
async function readRefreshRejectionScope(
  response: Response,
): Promise<"user-epoch" | null> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (!isRecord(payload)) {
    return null;
  }
  if (payload.revocation_scope === "user_epoch") {
    return "user-epoch";
  }
  // The host reads a nested `error.revocation_scope` too - authn's error
  // serializer has emitted both shapes - so the client honours the same pair
  // rather than seeing a routine sign-out as unspecified on one of them.
  if (
    isRecord(payload.error) &&
    payload.error.revocation_scope === "user_epoch"
  ) {
    return "user-epoch";
  }
  return null;
}

async function refreshAuthTokenOnceViaHttp(
  authnBaseUrl: string,
  token: string,
  refreshToken: string,
  clientKind: "cli" | "desktop" | null,
  signal: AbortSignal,
): Promise<AuthTokenRefreshResult> {
  let response: Response;
  try {
    response = await fetch(authnApiUrl(authnBaseUrl, "api/v3/auth/refresh"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        refreshToken,
        ...(clientKind === null ? {} : { clientKind }),
      }),
      signal,
    });
  } catch {
    return { kind: "network-error" };
  }

  // A 409 means the authn refresh grace window is mid-rotation: a concurrent
  // refresher won the race and is minting the new pair. This is transient and
  // retriable, NOT a dead credential, so map it to `network-error` (a retry
  // re-drives and lands on the winner's replayed pair) rather than `rejected`,
  // which would sign the GUI out.
  if (response.status === 409) {
    return { kind: "network-error" };
  }

  // These four used to collapse into one `rejected`, and the collapse was the
  // defect: three layers up, the renderer has to decide whether to keep serving
  // this machine's own epics from disk, and by then the status is gone. What
  // the rejection is ABOUT is only knowable here.
  //
  //   401/400 -> CREDENTIAL. A dead or malformed token. The person at the
  //     keyboard is still whoever the stored identity names, so the local plane
  //     is held (`unverified`) and only the cloud session ends.
  //   403/404 -> ACCOUNT. Forbidden, or the user row is gone (authn's
  //     `UserNotFoundError` is a 404). There is no longer an identity on disk to
  //     hold a plane FOR, so it clears.
  //
  // Ambiguity resolves toward HOLDING, deliberately: wrongly clearing a
  // legitimate user's offline access is the severe error this ticket exists to
  // fix, while retaining read access to already-on-disk data slightly past a
  // termination is mild. 409 is handled above (mid-rotation, retriable) and
  // every other non-2xx falls through to `network-error`, which also holds.
  if (response.status === 403 || response.status === 404) {
    return { kind: "rejected", rejection: { kind: "account" } };
  }

  if (response.status === 400 || response.status === 401) {
    return {
      kind: "rejected",
      rejection: {
        kind: "credential",
        revocation: await readRefreshRejectionScope(response),
      },
    };
  }

  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }

  const rotated = await readRotatedTokens(response);
  if (rotated.kind === "transient") {
    return { kind: "network-error" };
  }
  if (rotated.kind === "invalid") {
    // A 2xx whose body is unusable. It stays `rejected` (a settled earlier
    // decision - the pair cannot be adopted, so this credential is finished),
    // and it classifies as CREDENTIAL: the server said nothing whatsoever about
    // the account, so the only honest reading is "this token got us nowhere".
    // Clearing local data on a response we could not even parse is precisely
    // the over-reaction the credential/account line exists to prevent.
    return {
      kind: "rejected",
      rejection: { kind: "credential", revocation: null },
    };
  }
  return {
    kind: "refreshed",
    token: rotated.token,
    refreshToken: rotated.refreshToken,
  };
}

export type AuthCodeExchangeResult =
  | {
      readonly kind: "exchanged";
      readonly token: string;
      readonly refreshToken: string;
    }
  | { readonly kind: "rejected" }
  | { readonly kind: "network-error" };

/**
 * Exchanges a one-time PKCE `code` + `codeVerifier` for the token pair at
 * `/api/v3/auth/exchange-code`. The shell calls this at its sign-in callback with
 * the verifier it generated (and kept in-memory) at sign-in start. Public
 * endpoint - no bearer; the code is the credential.
 *
 * A `4xx` is a terminal `rejected` (bad/expired/used code, or a PKCE mismatch);
 * any other non-2xx or a transport failure is a transient `network-error`. The
 * request is time-boxed by `AbortSignal.timeout` (a fired timeout surfaces as
 * `network-error` via the `catch`); unlike validation/refresh it is deliberately
 * NOT retried, because the `code` is single-use - replaying it after a lost
 * response would be rejected as already-consumed. The sign-in callback surfaces
 * the `network-error` as a retry CTA instead.
 */
export async function exchangeCodeForTokens(
  authnBaseUrl: string,
  code: string,
  codeVerifier: string,
): Promise<AuthCodeExchangeResult> {
  let response: Response;
  try {
    response = await fetch(
      authnApiUrl(authnBaseUrl, "api/v3/auth/exchange-code"),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code, code_verifier: codeVerifier }),
        signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
      },
    );
  } catch {
    return { kind: "network-error" };
  }

  if (
    response.status === 400 ||
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  ) {
    return { kind: "rejected" };
  }

  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }

  const tokens = await readRotatedTokens(response);
  if (tokens.kind === "transient") {
    return { kind: "network-error" };
  }
  if (tokens.kind === "invalid") {
    return { kind: "rejected" };
  }
  return {
    kind: "exchanged",
    token: tokens.token,
    refreshToken: tokens.refreshToken,
  };
}

/**
 * Outcome of reading the rotated `{ token, refreshToken }` pair from a 2xx
 * token-mint body:
 *   - `ok`        - a valid non-empty pair;
 *   - `invalid`   - the body is malformed or missing a field (terminal);
 *   - `transient` - the body read was aborted/timed out after headers arrived
 *                   (retriable; must NOT be treated as a bad body).
 */
export type RotatedTokensOutcome =
  | {
      readonly kind: "ok";
      readonly token: string;
      readonly refreshToken: string;
    }
  | { readonly kind: "invalid" }
  | { readonly kind: "transient" };

/**
 * Parses the rotated `{ token, refreshToken }` pair from a 2xx token-mint
 * response body. Exported so the device-flow client (`device-auth.ts`) can
 * reuse the exact same 200-body shape that `exchange-code` / `refresh` use,
 * without duplicating the field validation. A body-read abort/timeout is
 * reported as `transient` so callers keep it retriable instead of collapsing it
 * into a terminal bad-body outcome; a malformed/missing-field body is `invalid`.
 */
export async function readRotatedTokens(
  response: Response,
): Promise<RotatedTokensOutcome> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return isAbortOrTimeout(error)
      ? { kind: "transient" }
      : { kind: "invalid" };
  }

  if (body === null || typeof body !== "object") {
    return { kind: "invalid" };
  }

  const record = body as Record<string, unknown>;
  const token = record.token;
  const refreshToken = record.refreshToken;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0
  ) {
    return { kind: "invalid" };
  }

  return { kind: "ok", token, refreshToken };
}

function authnApiUrl(authnBaseUrl: string, path: string): string {
  return new URL(
    path,
    authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`,
  ).toString();
}
