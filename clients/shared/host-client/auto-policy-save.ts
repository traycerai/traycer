/**
 * `PUT /api/traycer/auto-policy` on traycer-server: the account's auto-approve
 * policy, saved by the app on the person's own sign-in, the body the host's
 * `autoPolicy.set` sent for it. A sibling of `environment-directory.ts`, and
 * it runs where that runs: desktop in Electron main (traycer-server's CORS
 * list does not take the app renderer), the phone through its native request.
 *
 * Sent once through the shell's `EnvironmentTransport`, which never follows a
 * redirect: a 3xx, or a browser's opaque redirect, is an answered
 * non-success. Nothing here throws, logs, or answers with any part of the
 * request or of the server's body.
 */
import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import type { EnvironmentTransport } from "../environment/environment-cloud";

/** The route runs on the server's `standard` forward tier (60 s); the margin lets its own answer arrive first. */
const AUTO_POLICY_SAVE_TIMEOUT_MS = 70_000;

/** traycer-server's answer: the record's new stamp, epoch milliseconds on its clock. */
const autoPolicySaveAnswerSchema = z.object({ updatedAt: z.number() });

/**
 * - `ok`: saved; `updatedAt` is the server's stamp, epoch milliseconds;
 * - `unauthorized`: the server refused the person's sign-in (401);
 * - `forbidden`: the server refused the person (403);
 * - `refused`: any other answer that is not a save: another status, a
 *   redirect, or a body this build cannot read;
 * - `no_response`: nothing answered in time.
 */
export type AutoPolicySaveResult =
  | { readonly kind: "ok"; readonly updatedAt: number }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "refused" }
  | { readonly kind: "no_response" };

/**
 * `proxyToken` is the Google IAP id-token a staging desktop's main process
 * mints, sent as `Proxy-Authorization` ahead of the person's `Authorization`;
 * every other caller passes `null`.
 */
export async function saveAutoPolicyViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  transport: EnvironmentTransport,
  body: string,
): Promise<AutoPolicySaveResult> {
  const base = serverBaseUrl.endsWith("/")
    ? serverBaseUrl
    : `${serverBaseUrl}/`;
  const headers: Record<string, string> =
    proxyToken === null
      ? {}
      : { "Proxy-Authorization": `Bearer ${proxyToken}` };
  headers.Authorization = `Bearer ${bearerToken}`;
  headers.Accept = "application/json";
  headers["Content-Type"] = "application/json";
  const abort = composeRequestAbort(null, AUTO_POLICY_SAVE_TIMEOUT_MS);
  let answer: { readonly status: number; readonly text: string | null };
  try {
    answer = await untilAborted(
      transport({
        url: new URL("api/traycer/auto-policy", base).toString(),
        method: "PUT",
        headers,
        body: { body },
        signal: abort.signal,
      }),
      abort.signal,
    );
  } catch {
    return { kind: "no_response" };
  } finally {
    abort.clear();
  }
  if (answer.status === 401) return { kind: "unauthorized" };
  if (answer.status === 403) return { kind: "forbidden" };
  if (answer.status < 200 || answer.status >= 300 || answer.text === null) {
    return { kind: "refused" };
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(answer.text);
  } catch {
    return { kind: "refused" };
  }
  const parsed = autoPolicySaveAnswerSchema.safeParse(parsedBody);
  return parsed.success
    ? { kind: "ok", updatedAt: parsed.data.updatedAt }
    : { kind: "refused" };
}
