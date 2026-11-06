import { SANDBOX_REFUSAL_CODE_TEAM_HOST_EXISTS } from "@traycer/protocol/host/sandbox-control";
import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import type { SlackAppFailure } from "./slack-app";

/**
 * The raw call to traycer-server's team-host route
 * (`/api/environments/{id}/team-host/install-token`) with the person's bearer:
 * mints the one-time token that enrolls a team environment's bot host. A
 * sibling of `slack-app.ts` and `sandbox-control.ts`, and it runs where they
 * run: desktop calls it from Electron main (traycer-server's CORS allow-list
 * is the web dashboard origin, not the app renderer), mobile through the
 * native HTTP layer.
 *
 * Never throws: transport failures, non-2xx answers and malformed bodies
 * collapse into a discriminated, structured-clone-safe result so it crosses
 * the Electron IPC boundary unchanged. Nothing here logs, and the install
 * token is a credential: it appears only in an `ok` result, never in a
 * failure's `detail`.
 */

/**
 * A mint writes one row on the server's `standard` forward tier (60 s); a
 * margin over it lets the server's own answer arrive first.
 */
const TEAM_HOST_INSTALL_TOKEN_TIMEOUT_MS = 70_000;

/**
 * Why a build that cannot reach traycer-server (staging mobile, whose server
 * is fronted by IAP: see `SANDBOXES_UNAVAILABLE_IN_STAGING`) offers no team
 * host setup.
 */
export const TEAM_HOST_UNAVAILABLE_IN_STAGING =
  "Setting up a team host isn't available in this app. Use the desktop app.";

const TEAM_HOST_UNAVAILABLE_NOW =
  "The service is unavailable right now. Try again shortly.";

const teamHostInstallTokenResponseSchema = z.object({
  hostId: z.uuid(),
  installToken: z.string().min(1),
  expiresAt: z.number().int(),
});

const teamHostRefusalBodySchema = z.object({ code: z.string().min(1) });

/**
 * The route's answer:
 *  - `ok`               - the host's id, its one-time install token and when
 *                         the token lapses (epoch ms).
 *  - `team-host-exists` - `409 team_host_exists`: the environment already has
 *                         its bot host.
 *  - `not-found`        - `404`: an environment the caller may not create into,
 *                         or a personal one.
 *  - the failures `slack-app.ts` defines, with the same meanings: `unauthorized`
 *    (401/403), `unavailable` (the server's `503`, or a build that cannot reach
 *    the server at all, answered by `AuthService` before any request),
 *    `refused` (a typed error body this call has no word for) and
 *    `network-error`.
 */
export type TeamHostInstallTokenResult =
  | {
      readonly kind: "ok";
      readonly hostId: string;
      readonly installToken: string;
      readonly expiresAt: number;
    }
  | { readonly kind: "team-host-exists" }
  | { readonly kind: "not-found" }
  | SlackAppFailure;

function teamHostInstallTokenUrl(
  serverBaseUrl: string,
  environmentId: string,
): string {
  const base = serverBaseUrl.endsWith("/")
    ? serverBaseUrl
    : `${serverBaseUrl}/`;
  return new URL(
    `api/environments/${encodeURIComponent(environmentId)}/team-host/install-token`,
    base,
  ).toString();
}

/** An empty or non-JSON body (a proxy's HTML page) reads as `null`. */
function parseJsonOrNull(text: string): unknown {
  if (text.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * `POST /api/environments/{environmentId}/team-host/install-token`: mints the
 * install token for the team environment's bot host. `proxyToken` is the
 * Google IAP id-token a staging desktop's main process mints, sent as
 * `Proxy-Authorization` ahead of the person's `Authorization`; every other
 * caller passes `null`.
 */
export async function mintTeamHostInstallTokenViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  environmentId: string,
): Promise<TeamHostInstallTokenResult> {
  const headers: Record<string, string> =
    proxyToken === null
      ? {}
      : { "Proxy-Authorization": `Bearer ${proxyToken}` };
  headers.Authorization = `Bearer ${bearerToken}`;
  headers.Accept = "application/json";
  headers["Content-Type"] = "application/json";
  // Not `AbortSignal.timeout`, which the iOS WebView floor does not have; see
  // `request-abort.ts`. Cleared once the body is read, which the timeout also
  // bounds.
  const abort = composeRequestAbort(null, TEAM_HOST_INSTALL_TOKEN_TIMEOUT_MS);
  let status: number;
  let parsedBody: unknown;
  try {
    const response = await untilAborted(
      fetch(teamHostInstallTokenUrl(serverBaseUrl, environmentId), {
        method: "POST",
        headers,
        body: "{}",
        signal: abort.signal,
      }),
      abort.signal,
    );
    status = response.status;
    parsedBody = parseJsonOrNull(
      await untilAborted(response.text(), abort.signal),
    );
  } catch (error: unknown) {
    return {
      kind: "network-error",
      detail:
        error instanceof Error
          ? `the request never completed (${error.name})`
          : "the request never completed",
    };
  } finally {
    abort.clear();
  }
  if (status === 401 || status === 403) return { kind: "unauthorized" };
  if (status === 404) return { kind: "not-found" };
  if (status === 503) {
    return { kind: "unavailable", reason: TEAM_HOST_UNAVAILABLE_NOW };
  }
  if (status < 200 || status >= 300) {
    const refusal = teamHostRefusalBodySchema.safeParse(parsedBody);
    if (!refusal.success) {
      return {
        kind: "network-error",
        detail: `the server answered HTTP ${status} without a typed refusal`,
      };
    }
    return status === 409 &&
      refusal.data.code === SANDBOX_REFUSAL_CODE_TEAM_HOST_EXISTS
      ? { kind: "team-host-exists" }
      : { kind: "refused", status, code: refusal.data.code };
  }
  const parsed = teamHostInstallTokenResponseSchema.safeParse(parsedBody);
  if (!parsed.success) {
    return {
      kind: "network-error",
      detail: "the team host install token answer did not match the contract",
    };
  }
  return { kind: "ok", ...parsed.data };
}
