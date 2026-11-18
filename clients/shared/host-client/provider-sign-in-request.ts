import type { ProviderLoginSignInRequest } from "@traycer/protocol/host/provider-schemas";
import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import { isRedirectAnswer } from "../auth/redirect-answer";
import { PATH_ID_PATTERN } from "./path-id";

// Recorded between two `providers.awaitLogin` calls; the computer uploads the
// completed sign-in only against it.

const SIGN_IN_REQUEST_FETCH_TIMEOUT_MS = 15_000;

const PROVIDER_SIGN_IN_KIND = "provider_sign_in";

/** An exact repeat answers 200; an id naming another request is this 409. */
const DUPLICATE_OPERATION_CODE = "move_acceptance_conflict";

export type SignInRequestRecordAnswer =
  | { readonly kind: "recorded" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "failed" };

/** Implemented on the person's own session, so no bearer passes anywhere else. */
export interface SignInRequestClient {
  recordSignInRequest(
    request: ProviderLoginSignInRequest,
    signal: AbortSignal,
  ): Promise<SignInRequestRecordAnswer>;
}

/**
 * `recorded`: await again with `recordedOperationId`. Otherwise the sign-in ends;
 * the reason carries no sentence.
 */
export type SignInRecording =
  | { readonly kind: "recorded"; readonly recordedOperationId: string }
  | {
      readonly kind: "ended";
      readonly reason:
        | "forbidden"
        | "unavailable"
        | "session-ended"
        | "already-recorded";
    };

/**
 * A computer that answers an id already recorded has ignored it, so the step ends
 * instead of recording again; a duplicate-id refusal ends as `already-recorded`.
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
    case "duplicate":
      return { kind: "ended", reason: "already-recorded" };
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

async function post(
  url: string,
  body: string,
  bearerToken: string,
  callerSignal: AbortSignal,
): Promise<RawCall> {
  const abort = composeRequestAbort(
    callerSignal,
    SIGN_IN_REQUEST_FETCH_TIMEOUT_MS,
  );
  try {
    let response: Response;
    try {
      response = await untilAborted(
        fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body,
          redirect: "manual",
          signal: abort.signal,
        }),
        abort.signal,
      );
    } catch {
      return { kind: "no-answer" };
    }
    if (isRedirectAnswer(response.status)) {
      return { kind: "response", status: response.status, body: null };
    }
    // The status is the answer: an unreadable body still lets a 401 or 403 classify.
    let parsed: unknown = null;
    try {
      const text = await untilAborted(response.text(), abort.signal);
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { kind: "response", status: response.status, body: parsed };
  } finally {
    abort.clear();
  }
}

export async function recordSignInRequestViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  request: ProviderLoginSignInRequest,
  signal: AbortSignal,
): Promise<SignInRequestRecordAnswer> {
  if (!isPathSafe(request)) return { kind: "failed" };
  const raw = await post(
    intentsUrl(authnBaseUrl, request.environmentId),
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
