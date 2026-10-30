import {
  slackAppInstallUrlResponseSchema,
  slackAppManifestResponseSchema,
  slackAppReadResponseSchema,
  slackAppRefusalBodySchema,
  slackAppResponseSchema,
  type SlackAppRegisterRequest,
  type SlackAppView,
} from "@traycer/protocol/host/slack-app";
import type { z } from "zod";
import { composeRequestAbort } from "../auth/request-abort";

/**
 * The raw calls to traycer-server's Slack app routes (`/api/slack/apps/*`)
 * with the person's bearer: a bot's members register its app, read it, take
 * its manifest, mint an install URL and disconnect it. A sibling of
 * `sandbox-control.ts`, and it runs where that runs: desktop calls it from
 * Electron main (traycer-server's CORS allow-list is the web dashboard
 * origin, not the app renderer), mobile through the native HTTP layer.
 *
 * Every function here never throws: transport failures, non-2xx answers and
 * malformed bodies collapse into a discriminated, structured-clone-safe result
 * so it crosses the Electron IPC boundary unchanged. Nothing here logs, and a
 * failure never echoes a body: the register request carries the app's
 * secrets.
 */

/**
 * The reads answer from the server's own replica; the writes run on its
 * `standard` forward tier (60 s), and a margin over it lets the server's own
 * answer arrive first.
 */
const SLACK_APP_READ_TIMEOUT_MS = 10_000;
const SLACK_APP_WRITE_TIMEOUT_MS = 70_000;

/**
 * A non-`ok` answer:
 *  - `unauthorized`  — the bearer was rejected (401/403).
 *  - `refused`       — the server answered with its typed error body; `code`
 *                      is its word (`slack_not_configured`, `NOT_FOUND`, ...;
 *                      see `@traycer/protocol/host/slack-app`).
 *  - `network-error` — transport/timeout, a non-2xx without a typed body, or
 *                      a body this build cannot parse. `detail` is a stable
 *                      classification, never a raw server body.
 */
export type SlackAppFailure =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "refused"; readonly status: number; readonly code: string }
  | { readonly kind: "network-error"; readonly detail: string };

export type SlackAppReadResult =
  | { readonly kind: "ok"; readonly app: SlackAppView | null }
  | SlackAppFailure;

/** `register` and `disconnect`: the app as the write left it. */
export type SlackAppWriteResult =
  | { readonly kind: "ok"; readonly app: SlackAppView }
  | SlackAppFailure;

export type SlackAppManifestResult =
  | { readonly kind: "ok"; readonly manifest: string }
  | SlackAppFailure;

export type SlackAppInstallUrlResult =
  | { readonly kind: "ok"; readonly url: string; readonly expiresAt: number }
  | SlackAppFailure;

type SlackAppRoute =
  | "register"
  | "read"
  | "manifest"
  | "install-url"
  | "disconnect";

function slackAppsUrl(serverBaseUrl: string, route: SlackAppRoute): string {
  const base = serverBaseUrl.endsWith("/")
    ? serverBaseUrl
    : `${serverBaseUrl}/`;
  return new URL(`api/slack/apps/${route}`, base).toString();
}

type PostResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | SlackAppFailure;

/**
 * `proxyToken` is the Google IAP id-token a staging desktop's main process
 * mints, sent as `Proxy-Authorization` ahead of the person's `Authorization`;
 * every other caller passes `null`.
 */
async function post<T>(
  serverBaseUrl: string,
  route: SlackAppRoute,
  body: object,
  bearerToken: string,
  proxyToken: string | null,
  timeoutMs: number,
  schema: z.ZodType<T>,
): Promise<PostResult<T>> {
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
  const abort = composeRequestAbort(null, timeoutMs);
  let status: number;
  let parsedBody: unknown;
  try {
    const response = await fetch(slackAppsUrl(serverBaseUrl, route), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    status = response.status;
    parsedBody = parseJsonOrNull(await response.text());
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
  if (status < 200 || status >= 300) {
    const refusal = slackAppRefusalBodySchema.safeParse(parsedBody);
    return refusal.success
      ? { kind: "refused", status, code: refusal.data.code }
      : {
          kind: "network-error",
          detail: `the server answered HTTP ${status} without a typed refusal`,
        };
  }
  const parsed = schema.safeParse(parsedBody);
  if (!parsed.success) {
    return {
      kind: "network-error",
      detail: `the Slack app ${route} answer did not match the contract`,
    };
  }
  return { kind: "ok", value: parsed.data };
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

/** `POST /api/slack/apps/register`: stores the app's credentials; a new registration replaces the old one. */
export async function registerSlackAppViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  request: SlackAppRegisterRequest,
): Promise<SlackAppWriteResult> {
  const result = await post(
    serverBaseUrl,
    "register",
    request,
    bearerToken,
    proxyToken,
    SLACK_APP_WRITE_TIMEOUT_MS,
    slackAppResponseSchema,
  );
  return result.kind === "ok" ? { kind: "ok", app: result.value.app } : result;
}

/** `POST /api/slack/apps/read`: the bot's app, or `null` when none is registered. */
export async function readSlackAppViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  botId: string,
): Promise<SlackAppReadResult> {
  const result = await post(
    serverBaseUrl,
    "read",
    { botId },
    bearerToken,
    proxyToken,
    SLACK_APP_READ_TIMEOUT_MS,
    slackAppReadResponseSchema,
  );
  return result.kind === "ok" ? { kind: "ok", app: result.value.app } : result;
}

/** `POST /api/slack/apps/manifest`: the JSON text the bot's app is created from. */
export async function fetchSlackAppManifestViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  botId: string,
): Promise<SlackAppManifestResult> {
  const result = await post(
    serverBaseUrl,
    "manifest",
    { botId },
    bearerToken,
    proxyToken,
    SLACK_APP_READ_TIMEOUT_MS,
    slackAppManifestResponseSchema,
  );
  return result.kind === "ok"
    ? { kind: "ok", manifest: result.value.manifest }
    : result;
}

/** `POST /api/slack/apps/install-url`: Slack's consent URL; minting another retires the previous one. */
export async function mintSlackAppInstallUrlViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  botId: string,
): Promise<SlackAppInstallUrlResult> {
  const result = await post(
    serverBaseUrl,
    "install-url",
    { botId },
    bearerToken,
    proxyToken,
    SLACK_APP_WRITE_TIMEOUT_MS,
    slackAppInstallUrlResponseSchema,
  );
  return result.kind === "ok"
    ? { kind: "ok", url: result.value.url, expiresAt: result.value.expiresAt }
    : result;
}

/** `POST /api/slack/apps/disconnect`: clears and revokes the install; the registration stays. */
export async function disconnectSlackAppViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  botId: string,
): Promise<SlackAppWriteResult> {
  const result = await post(
    serverBaseUrl,
    "disconnect",
    { botId },
    bearerToken,
    proxyToken,
    SLACK_APP_WRITE_TIMEOUT_MS,
    slackAppResponseSchema,
  );
  return result.kind === "ok" ? { kind: "ok", app: result.value.app } : result;
}
