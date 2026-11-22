import { composeRequestAbort, untilAborted } from "../auth/request-abort";

export type TeamComputerReleaseResult =
  | { readonly kind: "ok" }
  | { readonly kind: "not-found" }
  | { readonly kind: "not-computer" }
  | { readonly kind: "read-only-seat" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

/** What the HTTP call returns: a refusal also says whether authn sent 401 or 403. */
export type TeamComputerReleaseHttpResult =
  | Exclude<TeamComputerReleaseResult, { readonly kind: "unauthorized" }>
  | { readonly kind: "unauthorized"; readonly status: 401 | 403 };

/**
 * Claims the computer for the signed-in team member. The existing team-release
 * route runs in Electron main on desktop, like host-deregister-fetcher, for CORS.
 */
export async function releaseTeamComputerViaHttp(
  authnBaseUrl: string,
  bearer: string,
  hostId: string,
  environmentId: string,
): Promise<TeamComputerReleaseHttpResult> {
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
        redirect: "manual",
        signal: abort.signal,
      }),
      abort.signal,
    );
    if (response.status === 204) return { kind: "ok" };
    if (response.status === 401) return { kind: "unauthorized", status: 401 };
    if (response.status === 403)
      return (await refusalCode(response, abort.signal)) ===
        "host_return_seat_read_only"
        ? { kind: "read-only-seat" }
        : { kind: "unauthorized", status: 403 };
    if (response.status === 404) return { kind: "not-found" };
    if (
      response.status === 409 &&
      (await refusalCode(response, abort.signal)) === "host_return_not_computer"
    )
      return { kind: "not-computer" };
    return { kind: "network-error" };
  } catch {
    return { kind: "network-error" };
  } finally {
    abort.clear();
  }
}

async function refusalCode(
  response: Response,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const body: unknown = JSON.parse(
      await untilAborted(response.text(), signal),
    );
    return typeof body === "object" &&
      body !== null &&
      "code" in body &&
      typeof body.code === "string"
      ? body.code
      : null;
  } catch {
    return null;
  }
}
