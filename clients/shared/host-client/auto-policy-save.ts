// Runs in desktop main or the phone's shell: traycer-server's CORS list does not
// take the app renderer. Sent once, following no redirect; nothing here throws,
// logs or answers with any part of the request or the server's body.
import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import type { EnvironmentTransport } from "../environment/environment-cloud";

/** The route runs on the server's `standard` forward tier (60 s); the margin lets its own answer arrive first. */
const AUTO_POLICY_SAVE_TIMEOUT_MS = 70_000;

/** Epoch milliseconds on the server's clock. */
const autoPolicySaveAnswerSchema = z.object({ updatedAt: z.number() });

export type AutoPolicySaveResult =
  | { readonly kind: "ok"; readonly updatedAt: number }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "refused" }
  | { readonly kind: "no_response" };

/**
 * `proxyToken`: the IAP id-token a staging desktop's main mints, sent as
 * `Proxy-Authorization`; every other caller passes `null`.
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
