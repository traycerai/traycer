import {
  listUserSessionsResponseSchema,
  mintHostCredentialResponseSchema,
  revokeAllSessionsResponseSchema,
  revokeUserSessionResponseSchema,
  stepUpChallengeResponseSchema,
  verifyStepUpResponseSchema,
  type ListUserSessionsResponse,
  type MintHostCredentialRequest,
  type MintHostCredentialResponse,
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

/**
 * Outcomes of the delegated host-credential mint.
 *
 * `superseded` is the 409: another client provisioned this same host
 * concurrently and won the server's ordering, so THIS request's row was retired
 * server-side. There is no credential to hand over - the caller must treat it as
 * retry-WITHOUT-handoff and never pass a 409 body to a host. The winner's
 * credential is already on its way, so the honest recovery is to do nothing and
 * let the next connection's `hostCredentialState` report `active`.
 */
export type MintHostCredentialFetchResult =
  | { readonly kind: "ok"; readonly response: MintHostCredentialResponse }
  | { readonly kind: "step-up-required" }
  | { readonly kind: "superseded" }
  | { readonly kind: "rejected" }
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

export type RetainedStepUpVerifyResponse = {
  readonly expires_in: number;
};

export type RetainedStepUpVerifyFetchResult =
  | { readonly kind: "ok"; readonly response: RetainedStepUpVerifyResponse }
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

/**
 * Mints a device credential for `hostId` on the caller's behalf. Always
 * step-up-gated server-side, including for a host that already has one - the
 * re-mint path is exactly the shape a stolen bearer's attack takes, so it is not
 * exempted.
 *
 * `bearerToken` must be the step-up-fresh token when one is held; on desktop
 * that swap happens in the main process, so the renderer never sees it.
 */
export async function mintHostCredentialViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  request: MintHostCredentialRequest,
): Promise<MintHostCredentialFetchResult> {
  const response = await fetchAuthn(
    authnBaseUrl,
    "api/v3/hosts/token",
    bearerToken,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  if (response === null) {
    return { kind: "network-error" };
  }
  if (await isStepUpRequired(response)) {
    return { kind: "step-up-required" };
  }
  if (response.status === 409) {
    return { kind: "superseded" };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status === 400) {
    // The server refused this hostId outright (not a UUID, or oversized). No
    // retry can fix it, and a host that cannot hold a delegated credential is
    // meant to stay on the client-lease fallback - so this is terminal for the
    // host, not an error to surface to the user.
    return { kind: "rejected" };
  }
  if (response.status < 200 || response.status >= 300) {
    // Includes 429 (the per-user mint budget): transient from the client's
    // point of view, and the fallback while it lasts is simply no host
    // credential.
    return { kind: "network-error" };
  }
  const parsed = await parseOk(response, mintHostCredentialResponseSchema);
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

export function toRetainedStepUpVerifyResult(
  result: StepUpVerifyFetchResult,
): RetainedStepUpVerifyFetchResult {
  if (result.kind === "ok") {
    return {
      kind: "ok",
      response: { expires_in: result.response.expires_in },
    };
  }
  return result;
}
