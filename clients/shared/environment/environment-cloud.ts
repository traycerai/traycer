// The transport the environment calls share: one call on the person's bearer, its
// answer, and each outcome's error. Nothing here logs.
import { z } from "zod";
import type { CloudBearerSource } from "../auth/bearer-source";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";

export type EnvironmentHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface EnvironmentAnswer {
  readonly status: number;
  readonly body: unknown;
}

export type EnvironmentPurpose = "settings" | "secrets";

/**
 * `not_readable`: authn's `environment_not_found` or `environment_action_forbidden`
 * on a read. `refused`: a review, notice or Undo call authn did not take.
 * `no_response` also covers no sign-in, or a sign-in changed mid-operation.
 */
export type EnvironmentErrorKind =
  | "unauthorized"
  | "forbidden"
  | "invalid"
  | "not_readable"
  | "refused"
  | "unavailable"
  | "no_response";

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

export const NEEDS_PERMISSION_MESSAGE = "This change needs permission.";

export const SETTINGS_REFUSED_MESSAGE = "The settings request was refused.";

export const CLOUD_UNAVAILABLE_MESSAGE =
  "Cloud service is temporarily unavailable. Please try again shortly.";

const ENVIRONMENT_REQUEST_TIMEOUT_MS = 15_000;

/** A failure's body is read to this many bytes at most; a success is read whole. */
export const MAX_FAILURE_BODY_BYTES = 256 * 1024;

/**
 * `bearer` is asked at each call and never kept: a held token would outlive a
 * refresh or a sign-out. Null when signed out or unconfirmed.
 */
export interface EnvironmentCloud {
  readonly authnBaseUrl: string;
  readonly bearer: CloudBearerSource;
  readonly transport: EnvironmentTransport;
  /** Whether the operation's sign-in is still current; while false, nothing is sent. */
  readonly onOriginSignIn: () => boolean;
}

export type EnvironmentCloudSource = () => EnvironmentCloud;

export interface EnvironmentTransportRequest {
  readonly url: string;
  readonly method: EnvironmentHttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

/** `body` is null when a failure's body was over {@link MAX_FAILURE_BODY_BYTES}. */
export interface EnvironmentTransportAnswer {
  readonly status: number;
  readonly text: string | null;
}

/**
 * Sends once and never follows a redirect: a 3xx would resend the bearer and the
 * body. A 3xx or opaque status 0 is returned as a non-success; a rejection
 * carries nothing of the request or the answer's body.
 */
export type EnvironmentTransport = (
  request: EnvironmentTransportRequest,
) => Promise<EnvironmentTransportAnswer>;

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
  const success = response.status >= 200 && response.status < 300;
  return {
    status: response.status,
    text: success ? await response.text() : await boundedText(response),
  };
};

/** Past {@link MAX_FAILURE_BODY_BYTES} the stream is cancelled and the answer is null. */
async function boundedText(response: Response): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FAILURE_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function environmentPath(environmentId: string): string {
  return `api/v3/environments/${encodeURIComponent(environmentId)}`;
}

export function isSuccess(answer: EnvironmentAnswer): boolean {
  return answer.status >= 200 && answer.status < 300;
}

/** The transport follows no redirect, so authn never answered the request itself. */
export function isRedirect(answer: EnvironmentAnswer): boolean {
  return !isSuccess(answer) && answer.status < 400;
}

export function isCloudFailure(answer: EnvironmentAnswer): boolean {
  return isRedirect(answer) || answer.status >= 500;
}

function bodyOf(text: string | null): unknown {
  if (text === null || text.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

async function sendEnvironmentRequest(
  cloud: EnvironmentCloud,
  purpose: EnvironmentPurpose,
  method: EnvironmentHttpMethod,
  path: string,
  body: unknown,
): Promise<EnvironmentAnswer> {
  const sent = await sendEnvironmentRequestWithBearer(
    cloud,
    purpose,
    method,
    path,
    body,
  );
  return sent.answer;
}

/**
 * {@link sendEnvironmentRequest}, also answering the bearer the request
 * carried, for a caller that must keep it out of anything it shows. The
 * bearer is used for that comparison and never kept.
 */
export function sendEnvironmentRequestWithBearer(
  cloud: EnvironmentCloud,
  purpose: EnvironmentPurpose,
  method: EnvironmentHttpMethod,
  path: string,
  body: unknown,
): Promise<{ readonly answer: EnvironmentAnswer; readonly bearer: string }> {
  return sendWithHeaders(cloud, purpose, method, path, body, {});
}

async function sendWithHeaders(
  cloud: EnvironmentCloud,
  purpose: EnvironmentPurpose,
  method: EnvironmentHttpMethod,
  path: string,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>>,
): Promise<{ readonly answer: EnvironmentAnswer; readonly bearer: string }> {
  const bearer = cloud.onOriginSignIn() ? cloud.bearer.getBearerToken() : null;
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
          ...extraHeaders,
        },
        body,
        signal: abort.signal,
      }),
      abort.signal,
    );
    return {
      answer: { status: answer.status, body: bodyOf(answer.text) },
      bearer,
    };
  } catch {
    throw new EnvironmentCloudError(
      "no_response",
      NEEDS_CONNECTION_MESSAGE[purpose],
    );
  } finally {
    abort.clear();
  }
}

export function sendSettings(
  cloud: EnvironmentCloud,
  method: EnvironmentHttpMethod,
  path: string,
  body: unknown,
): Promise<EnvironmentAnswer> {
  return sendEnvironmentRequest(cloud, "settings", method, path, body);
}

/** Equals `HOST_CAPABILITIES_HEADER` in the internal repository. */
const CAPABILITIES_HEADER = "x-traycer-host-capabilities";

/** Without `capabilities`, authn answers only the released value shapes. */
export async function readSettingsWithCapabilities(
  cloud: EnvironmentCloud,
  path: string,
  capabilities: readonly string[],
): Promise<EnvironmentAnswer> {
  const sent = await sendWithHeaders(cloud, "settings", "GET", path, null, {
    [CAPABILITIES_HEADER]: capabilities.join(","),
  });
  return sent.answer;
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
    return new EnvironmentCloudError("forbidden", NEEDS_PERMISSION_MESSAGE);
  if (isCloudFailure(answer))
    return new EnvironmentCloudError("unavailable", CLOUD_UNAVAILABLE_MESSAGE);
  return new EnvironmentCloudError("invalid", SETTINGS_REFUSED_MESSAGE);
}

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

/** A code is compared against literals and never shown or logged. */
export function errorBodyCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("code" in body)) return null;
  const code: unknown = body.code;
  if (typeof code !== "string" || code.length === 0) return null;
  if (code.length > MAX_CODE_LENGTH) return null;
  return SAFE_CODE.test(code) ? code : null;
}
