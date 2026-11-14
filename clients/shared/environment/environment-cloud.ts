/**
 * The app's own calls to authn's environment routes, on the person's sign-in:
 * a team's or Personal's configuration read and written with no host and no
 * server pool in the path, on desktop and on a phone alike.
 *
 * The functions beside this file give each call the answer the host's and the
 * pool's forwarder gave for the same method (the protocol's response shapes),
 * with the same words for each failure, so a screen that read through a host
 * reads the same answer here. This file is the transport they share: one call
 * on the person's bearer, its answer, and the error each outcome is.
 *
 * Nothing here logs: no account identifier, value or body is written anywhere.
 */
import { z } from "zod";
import type { CloudBearerSource } from "../auth/bearer-source";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";

export type EnvironmentHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** authn's answer: its status and its parsed body (null when it had none). */
export interface EnvironmentAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** Which page a call serves, for the words of a missing connection or a refused credential. */
export type EnvironmentPurpose = "settings" | "secrets";

/**
 * The caller-facing failures:
 * - `unauthorized`: authn refused the person's credential (401);
 * - `forbidden`: the person's role does not allow it (403);
 * - `invalid`: authn refused the request, or it names nothing it can serve;
 * - `unavailable`: the cloud failed, or answered in a shape this cannot read;
 * - `no_response`: nothing answered, or no sign-in to send.
 */
export type EnvironmentErrorKind =
  | "unauthorized"
  | "forbidden"
  | "invalid"
  | "unavailable"
  | "no_response";

/** A call's failure, typed by {@link EnvironmentErrorKind}; its message is the person's words. */
export class EnvironmentCloudError extends Error {
  readonly kind: EnvironmentErrorKind;

  constructor(kind: EnvironmentErrorKind, message: string) {
    super(message);
    this.name = "EnvironmentCloudError";
    this.kind = kind;
  }
}

export const NEEDS_CONNECTION_MESSAGE: Readonly<
  Record<EnvironmentPurpose, string>
> = {
  settings: "Connect to manage settings.",
  secrets: "Connect to manage secrets.",
};

export const SIGN_IN_AGAIN_MESSAGE: Readonly<
  Record<EnvironmentPurpose, string>
> = {
  settings: "Sign in again to manage settings.",
  secrets: "Sign in again to manage secrets.",
};

/** The words of an `unavailable` failure, as the host's cloud errors say them. */
export const CLOUD_UNAVAILABLE_MESSAGE =
  "Cloud service is temporarily unavailable. Please try again shortly.";

/** One call's deadline. */
export const ENVIRONMENT_REQUEST_TIMEOUT_MS = 15_000;

/** A failure body longer than this is not read: only its status counts. */
const MAX_BODY_CHARS = 256 * 1024;

/**
 * Where a call goes and on whose sign-in.
 *
 * Invariant: `bearer` answers the person's verified sign-in, refreshed as the
 * session refreshes it, and null when there is none (signed out, or a token
 * authn has not confirmed). It is asked at each call and its answer is never
 * kept by a caller: a token held past its call would outlive a refresh or a
 * sign-out.
 */
export interface EnvironmentCloud {
  readonly authnBaseUrl: string;
  readonly bearer: CloudBearerSource;
  readonly transport: EnvironmentTransport;
}

/** One request as the transport sends it; `body` is the JSON value, or null. */
export interface EnvironmentTransportRequest {
  readonly url: string;
  readonly method: EnvironmentHttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

/** The answer as received: its status and its body's text. */
export interface EnvironmentTransportAnswer {
  readonly status: number;
  readonly text: string;
}

/**
 * Sends one request exactly once and never follows a redirect: a 3xx would
 * resend the bearer, and a body that may hold a credential, to wherever it
 * points. A 3xx (or a browser's opaque redirect, status 0) is returned as the
 * answer, which every caller reads as a non-success. It rejects only when
 * nothing answered, and its rejection carries nothing of the request.
 */
export type EnvironmentTransport = (
  request: EnvironmentTransportRequest,
) => Promise<EnvironmentTransportAnswer>;

/** The platform `fetch`, with `redirect: "manual"`: desktop and the browser. */
export const fetchEnvironmentTransport: EnvironmentTransport = async (
  request,
) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body === null ? undefined : JSON.stringify(request.body),
    redirect: "manual",
    signal: request.signal,
  });
  return { status: response.status, text: await response.text() };
};

export function environmentPath(environmentId: string): string {
  return `api/v3/environments/${encodeURIComponent(environmentId)}`;
}

export function isSuccess(answer: EnvironmentAnswer): boolean {
  return answer.status >= 200 && answer.status < 300;
}

function bodyOf(text: string): unknown {
  if (text.length === 0 || text.length > MAX_BODY_CHARS) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * One authn call on the person's bearer. Throws `no_response` with
 * {@link NEEDS_CONNECTION_MESSAGE} of `purpose` when nothing answered (or not
 * in time), or there is no sign-in to send.
 */
export async function sendEnvironmentRequest(
  cloud: EnvironmentCloud,
  purpose: EnvironmentPurpose,
  method: EnvironmentHttpMethod,
  path: string,
  body: unknown,
): Promise<EnvironmentAnswer> {
  const bearer = cloud.bearer.getBearerToken();
  if (bearer === null || bearer.length === 0) {
    throw new EnvironmentCloudError(
      "no_response",
      NEEDS_CONNECTION_MESSAGE[purpose],
    );
  }
  const base = cloud.authnBaseUrl.endsWith("/")
    ? cloud.authnBaseUrl
    : `${cloud.authnBaseUrl}/`;
  const abort = composeRequestAbort(null, ENVIRONMENT_REQUEST_TIMEOUT_MS);
  try {
    const answer = await untilAborted(
      cloud.transport({
        url: new URL(path, base).toString(),
        method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "application/json",
          ...(body === null ? {} : { "Content-Type": "application/json" }),
        },
        body,
        signal: abort.signal,
      }),
      abort.signal,
    );
    return { status: answer.status, body: bodyOf(answer.text) };
  } catch {
    throw new EnvironmentCloudError(
      "no_response",
      NEEDS_CONNECTION_MESSAGE[purpose],
    );
  } finally {
    abort.clear();
  }
}

/** A settings call on the person's bearer. */
export function sendSettings(
  cloud: EnvironmentCloud,
  method: EnvironmentHttpMethod,
  path: string,
  body: unknown,
): Promise<EnvironmentAnswer> {
  return sendEnvironmentRequest(cloud, "settings", method, path, body);
}

/** A settings answer authn refused, as the caller's error. */
export function settingsRefusal(
  answer: EnvironmentAnswer,
): EnvironmentCloudError {
  if (answer.status === 401)
    return new EnvironmentCloudError(
      "unauthorized",
      SIGN_IN_AGAIN_MESSAGE.settings,
    );
  if (answer.status === 403)
    return new EnvironmentCloudError(
      "forbidden",
      "This change needs permission.",
    );
  if (answer.status >= 500)
    return new EnvironmentCloudError("unavailable", CLOUD_UNAVAILABLE_MESSAGE);
  return new EnvironmentCloudError(
    "invalid",
    "The settings request was refused.",
  );
}

/** A settings answer parsed with `schema`, or the caller's error. */
export function parseSettings<T>(
  answer: EnvironmentAnswer,
  schema: z.ZodType<T>,
): T {
  if (!isSuccess(answer)) throw settingsRefusal(answer);
  const parsed = schema.safeParse(answer.body);
  if (!parsed.success)
    throw new EnvironmentCloudError("unavailable", CLOUD_UNAVAILABLE_MESSAGE);
  return parsed.data;
}

const SAFE_CODE = /^[A-Za-z0-9_.-]+$/u;
const MAX_CODE_LENGTH = 64;

/**
 * The `code` of an error body, when it is a short word; null otherwise. A
 * code is compared against literals and never shown or logged.
 */
export function errorBodyCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("code" in body)) return null;
  const code: unknown = body.code;
  if (typeof code !== "string" || code.length === 0) return null;
  if (code.length > MAX_CODE_LENGTH) return null;
  return SAFE_CODE.test(code) ? code : null;
}
