/**
 * `GET /api/environments` on traycer-server: every environment the signed-in
 * person belongs to, in the protocol's own list shape. The app joins it with
 * authn's reads (the hosts' reports, the viewer's role) through
 * `enrichConfigurationList`, as the host's `environment.list` did.
 *
 * Reached only from desktop main or the phone's shell, which traycer-server
 * answers; the renderer asks through `IRunnerHost.listEnvironments`. The
 * sign-in token rides in the `Authorization` header only, and the request has
 * no body. It is sent once through the shell's `EnvironmentTransport`, which
 * never follows a redirect: a 3xx is a failure like any other.
 */
import {
  environmentListResponseSchema,
  type EnvironmentListResponse,
} from "@traycer/protocol/host/environment/contracts";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import type { EnvironmentTransport } from "../environment/environment-cloud";

const ENVIRONMENT_DIRECTORY_TIMEOUT_MS = 10_000;

/**
 * - `unauthorized`: traycer-server refused the person's sign-in (401);
 * - `unavailable`: it answered with anything but the list (another status, a
 *   redirect, or a body that is not the list);
 * - `no_response`: nothing answered in time.
 */
export type EnvironmentDirectoryResult =
  | { readonly kind: "ok"; readonly list: EnvironmentListResponse }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "no_response" };

export async function listEnvironmentsViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  transport: EnvironmentTransport,
): Promise<EnvironmentDirectoryResult> {
  const base = serverBaseUrl.endsWith("/")
    ? serverBaseUrl
    : `${serverBaseUrl}/`;
  const headers: Record<string, string> =
    proxyToken === null
      ? {}
      : { "Proxy-Authorization": `Bearer ${proxyToken}` };
  headers.Authorization = `Bearer ${bearerToken}`;
  headers.Accept = "application/json";
  const abort = composeRequestAbort(null, ENVIRONMENT_DIRECTORY_TIMEOUT_MS);
  let answer: { readonly status: number; readonly text: string | null };
  try {
    answer = await untilAborted(
      transport({
        url: new URL("api/environments", base).toString(),
        method: "GET",
        headers,
        body: null,
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
  if (answer.status < 200 || answer.status >= 300 || answer.text === null) {
    return { kind: "unavailable" };
  }
  let body: unknown;
  try {
    body = JSON.parse(answer.text);
  } catch {
    return { kind: "unavailable" };
  }
  const parsed = environmentListResponseSchema.safeParse(body);
  return parsed.success
    ? { kind: "ok", list: parsed.data }
    : { kind: "unavailable" };
}
