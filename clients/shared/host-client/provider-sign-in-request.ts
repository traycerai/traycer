import type { ProviderLoginSignInRequest } from "@traycer/protocol/host/provider-schemas";
import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import { PATH_ID_PATTERN } from "./path-id";

/**
 * A person's sign-in request, recorded at authn by the person's own app or
 * CLI on its own session, between two `providers.awaitLogin` calls: the
 * computer uploads the completed sign-in only against it. The route, the body
 * and every answer this client reads live here, so a change to the route is
 * a change to this file.
 */

/** Bounds either call; each is a single write or read of one row. */
const SIGN_IN_REQUEST_FETCH_TIMEOUT_MS = 15_000;

const PROVIDER_SIGN_IN_KIND = "provider_sign_in";

/** The record route's refusal for an operation id that names another request. */
const DUPLICATE_OPERATION_CODE = "move_acceptance_conflict";

/** What the record call answered. */
export type SignInRequestRecordAnswer =
  | { readonly kind: "recorded" }
  /** The operation id names a request already; read it back once. */
  | { readonly kind: "duplicate" }
  /** 401: the session that sent it has ended. */
  | { readonly kind: "unauthorized" }
  /** 403: the person may not sign in for this environment. */
  | { readonly kind: "forbidden" }
  /** 404, any other answer, or no answer. */
  | { readonly kind: "failed" };

/** What the recorder's read of its own request answered. */
export type SignInRequestReadAnswer =
  | { readonly kind: "pending" }
  /** An upload under this id already committed against it. */
  | { readonly kind: "consumed" }
  | { readonly kind: "ended" }
  /** Any other answer, or no answer. */
  | { readonly kind: "failed" };

/**
 * The two calls on the person's own session. The app's auth service and the
 * CLI's own sign-in implement it, so no bearer passes anywhere else.
 */
export interface SignInRequestClient {
  recordSignInRequest(
    request: ProviderLoginSignInRequest,
    signal: AbortSignal,
  ): Promise<SignInRequestRecordAnswer>;
  readSignInRequest(
    request: ProviderLoginSignInRequest,
    signal: AbortSignal,
  ): Promise<SignInRequestReadAnswer>;
}

/**
 * How the recording step ended. `recorded`: await again on the same handle
 * with `recordedOperationId`. Otherwise the sign-in ends, and the caller
 * shows the existing sentence for the reason: `forbidden` is a team's 3a,
 * `unavailable` a team's 3b; every other reason on a team's dialog, and
 * every reason on a person's own, is "Sign-in did not finish. Retry when you
 * are ready.". `unconfirmed`: the read after a duplicate id failed.
 */
export type SignInRecording =
  | { readonly kind: "recorded"; readonly recordedOperationId: string }
  | {
      readonly kind: "ended";
      readonly reason:
        | "forbidden"
        | "unavailable"
        | "unconfirmed"
        | "session-ended"
        | "already-recorded";
    };

/**
 * Records `request` once. `recorded` holds every operation id this caller
 * has already recorded and sent back: a computer that answers the same id
 * again has ignored it, so the step ends instead of recording again. A
 * duplicate-id refusal is followed by one read of the request, never more:
 * `pending` goes on, and so does `consumed`, for which the computer answers
 * its kept final outcome.
 */
export async function recordSignInRequestOnce(
  client: SignInRequestClient,
  recorded: Set<string>,
  request: ProviderLoginSignInRequest,
  signal: AbortSignal,
): Promise<SignInRecording> {
  if (recorded.has(request.operationId)) {
    return { kind: "ended", reason: "already-recorded" };
  }
  recorded.add(request.operationId);
  const answer = await client.recordSignInRequest(request, signal);
  switch (answer.kind) {
    case "recorded":
      return { kind: "recorded", recordedOperationId: request.operationId };
    case "duplicate": {
      const state = await client.readSignInRequest(request, signal);
      switch (state.kind) {
        case "pending":
        case "consumed":
          return { kind: "recorded", recordedOperationId: request.operationId };
        case "ended":
          return { kind: "ended", reason: "unavailable" };
        case "failed":
          return { kind: "ended", reason: "unconfirmed" };
      }
    }
    case "unauthorized":
      return { kind: "ended", reason: "session-ended" };
    case "forbidden":
      return { kind: "ended", reason: "forbidden" };
    case "failed":
      return { kind: "ended", reason: "unavailable" };
  }
}

const recordAnswerSchema = z.object({
  operationId: z.string(),
  endsAt: z.number(),
});
const codedBodySchema = z.object({ code: z.string() });
const intentStateSchema = z.object({ state: z.string() });

type RawCall =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly body: unknown;
    }
  | { readonly kind: "no-answer" };

function intentsUrl(authnBaseUrl: string, environmentId: string): string {
  const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
  return new URL(
    `api/v3/environments/${encodeURIComponent(environmentId)}/profile-records/intents`,
    base,
  ).toString();
}

function isPathSafe(request: ProviderLoginSignInRequest): boolean {
  return (
    PATH_ID_PATTERN.test(request.environmentId) &&
    PATH_ID_PATTERN.test(request.operationId)
  );
}

async function call(
  url: string,
  method: "GET" | "POST",
  body: string | null,
  bearerToken: string,
  callerSignal: AbortSignal,
): Promise<RawCall> {
  const abort = composeRequestAbort(
    callerSignal,
    SIGN_IN_REQUEST_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await untilAborted(
      fetch(url, {
        method,
        headers:
          body === null
            ? {
                Authorization: `Bearer ${bearerToken}`,
                Accept: "application/json",
              }
            : {
                Authorization: `Bearer ${bearerToken}`,
                Accept: "application/json",
                "Content-Type": "application/json",
              },
        body,
        redirect: "error",
        signal: abort.signal,
      }),
      abort.signal,
    );
    const text = await untilAborted(response.text(), abort.signal);
    let parsed: unknown = null;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      // A proxy's page or an empty body reads as no body; only the status
      // and a parsed body are ever read.
    }
    return { kind: "response", status: response.status, body: parsed };
  } catch {
    return { kind: "no-answer" };
  } finally {
    abort.clear();
  }
}

/** The record call on `bearerToken`'s session. Nothing is queued or retried. */
export async function recordSignInRequestViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  request: ProviderLoginSignInRequest,
  signal: AbortSignal,
): Promise<SignInRequestRecordAnswer> {
  if (!isPathSafe(request)) return { kind: "failed" };
  const raw = await call(
    intentsUrl(authnBaseUrl, request.environmentId),
    "POST",
    JSON.stringify({
      operationId: request.operationId,
      kind: PROVIDER_SIGN_IN_KIND,
      sourceHostId: request.sourceHostId,
      sourceSharingGeneration: request.sourceSharingGeneration,
      harnessId: request.harnessId,
    }),
    bearerToken,
    signal,
  );
  if (raw.kind === "no-answer") return { kind: "failed" };
  if (raw.status === 401) return { kind: "unauthorized" };
  if (raw.status === 403) return { kind: "forbidden" };
  if (raw.status === 409) {
    const coded = codedBodySchema.safeParse(raw.body);
    return coded.success && coded.data.code === DUPLICATE_OPERATION_CODE
      ? { kind: "duplicate" }
      : { kind: "failed" };
  }
  const answer = recordAnswerSchema.safeParse(raw.body);
  return raw.status === 200 &&
    answer.success &&
    answer.data.operationId === request.operationId
    ? { kind: "recorded" }
    : { kind: "failed" };
}

/** The recorder's read of its own request on `bearerToken`'s session. */
export async function readSignInRequestViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  request: ProviderLoginSignInRequest,
  signal: AbortSignal,
): Promise<SignInRequestReadAnswer> {
  if (!isPathSafe(request)) return { kind: "failed" };
  const raw = await call(
    `${intentsUrl(authnBaseUrl, request.environmentId)}/${encodeURIComponent(request.operationId)}`,
    "GET",
    null,
    bearerToken,
    signal,
  );
  if (raw.kind === "no-answer" || raw.status !== 200) return { kind: "failed" };
  const state = intentStateSchema.safeParse(raw.body);
  if (!state.success) return { kind: "failed" };
  switch (state.data.state) {
    case "pending":
      return { kind: "pending" };
    case "consumed":
      return { kind: "consumed" };
    case "ended":
      return { kind: "ended" };
    default:
      return { kind: "failed" };
  }
}
