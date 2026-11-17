// Reached only from desktop main or the phone's shell; the renderer asks through
// `IRunnerHost.listEnvironments`. Sent once, following no redirect.
import {
  environmentListResponseSchema,
  type EnvironmentListResponse,
} from "@traycer/protocol/host/environment/contracts";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import type { EnvironmentTransport } from "../environment/environment-cloud";

const ENVIRONMENT_DIRECTORY_TIMEOUT_MS = 10_000;

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
