import { composeRequestAbort, untilAborted } from "../auth/request-abort";

export type TeamComputerReleaseResult =
  | { readonly kind: "ok" }
  | { readonly kind: "not-found" }
  | { readonly kind: "not-computer" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

/** Runs in Electron main on desktop, like host-deregister-fetcher, for CORS. */
export async function releaseTeamComputerViaHttp(
  authnBaseUrl: string,
  bearer: string,
  hostId: string,
  environmentId: string,
): Promise<TeamComputerReleaseResult> {
  const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
  const url = new URL(
    `api/v3/hosts/${encodeURIComponent(hostId)}/team-release`,
    base,
  );
  const abort = composeRequestAbort(null, 10_000);
  try {
    const response = await untilAborted(
      fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ environmentId }),
        signal: abort.signal,
      }),
      abort.signal,
    );
    if (response.status === 204) return { kind: "ok" };
    if (response.status === 401 || response.status === 403)
      return { kind: "unauthorized" };
    if (response.status === 404) return { kind: "not-found" };
    if (response.status === 409) {
      const text = await untilAborted(response.text(), abort.signal);
      const body: unknown = JSON.parse(text);
      if (
        typeof body === "object" &&
        body !== null &&
        "code" in body &&
        body.code === "host_return_not_computer"
      ) {
        return { kind: "not-computer" };
      }
    }
    return { kind: "network-error" };
  } catch {
    return { kind: "network-error" };
  } finally {
    abort.clear();
  }
}
