import { composeRequestAbort, untilAborted } from "../auth/request-abort";

/**
 * The raw call behind the voice router: one model request through
 * traycer-server's inference passthrough (`POST /inference/openai/responses`)
 * with the user bearer. The server swaps the bearer for its own key,
 * forwards the body verbatim and charges the person's own account for the
 * call (no account-context header is sent, so the passthrough bills the
 * personal account). Transport-only, a sibling of `voice-sessions.ts`, and it
 * runs where that runs: desktop calls it from Electron main
 * (traycer-server's CORS allow-list is the web dashboard origin, not the app
 * renderer), mobile through the native HTTP layer, browser/dev shells
 * directly.
 *
 * The request body is built by the app (the model, the prompt, the schema
 * and the directory live beside each other there); this helper never reads
 * it. The answer is returned as parsed JSON for the caller's structured-output
 * parser and nothing else: it is data, never instructions.
 *
 * Never throws: transport failures, non-2xx answers and malformed bodies
 * collapse into discriminated, structured-clone-safe results so they cross
 * the Electron IPC boundary unchanged.
 */

/** The router answers in about 1.6 s (probe); a stalled call is given up well before the person repeats. */
const VOICE_ROUTE_FETCH_TIMEOUT_MS = 10_000;

/**
 * The outcome of one router call:
 *  - `ok`                — the provider answered 2xx; `body` is its JSON,
 *                          opaque here.
 *  - `credits-exhausted` — 402: the person's account cannot pay for it.
 *  - `unauthorized`      — the bearer was rejected (401/403).
 *  - `network-error`     — transport/timeout, any other status, or a body
 *                          that is not JSON. `detail` is a stable
 *                          classification, never a raw server body.
 */
export type VoiceRouteFetchResult =
  | { readonly kind: "ok"; readonly body: unknown }
  | { readonly kind: "credits-exhausted" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error"; readonly detail: string };

function routerUrl(serverBaseUrl: string): string {
  return new URL(
    "inference/openai/responses",
    serverBaseUrl.endsWith("/") ? serverBaseUrl : `${serverBaseUrl}/`,
  ).toString();
}

/**
 * `POST /inference/openai/responses` with `requestBody` (a JSON document the
 * app built). The IAP proxy token rides beside the bearer where a staging
 * build has one.
 */
export async function voiceRouteViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  requestBody: string,
): Promise<VoiceRouteFetchResult> {
  const abort = composeRequestAbort(null, VOICE_ROUTE_FETCH_TIMEOUT_MS);
  let status: number;
  let text: string;
  try {
    const response = await untilAborted(
      fetch(routerUrl(serverBaseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(proxyToken === null
            ? {}
            : { "Proxy-Authorization": `Bearer ${proxyToken}` }),
        },
        body: requestBody,
        signal: abort.signal,
      }),
      abort.signal,
    );
    status = response.status;
    text = await untilAborted(response.text(), abort.signal);
  } catch {
    return {
      kind: "network-error",
      detail: "the voice router request did not complete",
    };
  } finally {
    abort.clear();
  }
  if (status === 401 || status === 403) return { kind: "unauthorized" };
  if (status === 402) return { kind: "credits-exhausted" };
  if (status < 200 || status >= 300) {
    return {
      kind: "network-error",
      detail: `the voice router answered HTTP ${status}`,
    };
  }
  try {
    const body: unknown = JSON.parse(text);
    return { kind: "ok", body };
  } catch {
    return {
      kind: "network-error",
      detail: "the voice router answer was not JSON",
    };
  }
}
