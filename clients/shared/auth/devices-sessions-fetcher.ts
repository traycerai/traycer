import {
  listUserSessionsResponseSchema,
  revokeAllSessionsResponseSchema,
  revokeUserSessionResponseSchema,
  stepUpChallengeResponseSchema,
  verifyStepUpResponseSchema,
  type ListUserSessionsResponse,
  type RevokeAllSessionsResponse,
  type RevokeUserSessionResponse,
  type StepUpChallengeResponse,
  type VerifyStepUpResponse,
} from "@traycer/protocol/auth/devices-sessions";
import type { z } from "zod";

const DEVICES_SESSIONS_FETCH_TIMEOUT_MS = 10_000;
const STEP_UP_REQUIRED_REASON = "step_up_required";

export type ListUserSessionsFetchResult =
  | { readonly kind: "ok"; readonly response: ListUserSessionsResponse }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

export type RevokeUserSessionFetchResult =
  | { readonly kind: "ok"; readonly response: RevokeUserSessionResponse }
  | { readonly kind: "step-up-required" }
  | { readonly kind: "not-found" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

export type RevokeAllSessionsFetchResult =
  | { readonly kind: "ok"; readonly response: RevokeAllSessionsResponse }
  | { readonly kind: "step-up-required" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

export type StepUpChallengeFetchResult =
  | { readonly kind: "ok"; readonly response: StepUpChallengeResponse }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

export type StepUpVerifyFetchResult =
  | { readonly kind: "ok"; readonly response: VerifyStepUpResponse }
  | { readonly kind: "invalid" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

function authnApiUrl(authnBaseUrl: string, path: string): string {
  return new URL(
    path.replace(/^\/+/, ""),
    authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`,
  ).toString();
}

function jsonHeaders(bearerToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearerToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function fetchAuthn(
  authnBaseUrl: string,
  path: string,
  bearerToken: string,
  init: Omit<RequestInit, "headers" | "signal">,
): Promise<Response | null> {
  try {
    return await fetch(authnApiUrl(authnBaseUrl, path), {
      ...init,
      headers: jsonHeaders(bearerToken),
      signal: AbortSignal.timeout(DEVICES_SESSIONS_FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<unknown | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorReason(body: unknown): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const reason = (body as Record<string, unknown>).reason;
  return typeof reason === "string" ? reason : null;
}

async function isStepUpRequired(response: Response): Promise<boolean> {
  if (response.status !== 401) {
    return false;
  }
  return errorReason(await readJson(response)) === STEP_UP_REQUIRED_REASON;
}

async function parseOk<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const body = await readJson(response);
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export async function listUserSessionsViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
): Promise<ListUserSessionsFetchResult> {
  const response = await fetchAuthn(
    authnBaseUrl,
    "api/v3/user/sessions",
    bearerToken,
    {
      method: "GET",
    },
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
  const parsed = await parseOk(response, listUserSessionsResponseSchema);
  return parsed === null
    ? { kind: "network-error" }
    : { kind: "ok", response: parsed };
}

export async function revokeUserSessionViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  familyId: string,
): Promise<RevokeUserSessionFetchResult> {
  const path = `api/v3/user/sessions/${encodeURIComponent(familyId)}`;
  const response = await fetchAuthn(authnBaseUrl, path, bearerToken, {
    method: "DELETE",
  });
  if (response === null) {
    return { kind: "network-error" };
  }
  if (await isStepUpRequired(response)) {
    return { kind: "step-up-required" };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status === 404) {
    return { kind: "not-found" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = await parseOk(response, revokeUserSessionResponseSchema);
  return parsed === null
    ? { kind: "network-error" }
    : { kind: "ok", response: parsed };
}

export async function revokeAllSessionsViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
): Promise<RevokeAllSessionsFetchResult> {
  const response = await fetchAuthn(
    authnBaseUrl,
    "api/v3/user/revoke-sessions",
    bearerToken,
    {
      method: "POST",
      body: "{}",
    },
  );
  if (response === null) {
    return { kind: "network-error" };
  }
  if (await isStepUpRequired(response)) {
    return { kind: "step-up-required" };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = await parseOk(response, revokeAllSessionsResponseSchema);
  return parsed === null
    ? { kind: "network-error" }
    : { kind: "ok", response: parsed };
}

export async function requestStepUpChallengeViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
): Promise<StepUpChallengeFetchResult> {
  const response = await fetchAuthn(
    authnBaseUrl,
    "api/v3/user/step-up/challenge",
    bearerToken,
    {
      method: "POST",
      body: "{}",
    },
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
  const parsed = await parseOk(response, stepUpChallengeResponseSchema);
  return parsed === null
    ? { kind: "network-error" }
    : { kind: "ok", response: parsed };
}

export async function verifyStepUpChallengeViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  code: string,
): Promise<StepUpVerifyFetchResult> {
  const response = await fetchAuthn(
    authnBaseUrl,
    "api/v3/user/step-up/verify",
    bearerToken,
    {
      method: "POST",
      body: JSON.stringify({ code }),
    },
  );
  if (response === null) {
    return { kind: "network-error" };
  }
  if (response.status === 400) {
    return { kind: "invalid" };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }
  const parsed = await parseOk(response, verifyStepUpResponseSchema);
  return parsed === null
    ? { kind: "network-error" }
    : { kind: "ok", response: parsed };
}
