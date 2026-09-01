import { isAuthorizedGitHubReleaseUrl } from "./policy";
import { AuthenticationRequiredError } from "./redact";
import type { GitHubReleaseCredentialResolver } from "./resolver";
import {
  AUTHENTICATION_REQUIRED_MESSAGE,
  type GitHubReleaseAuthPolicy,
} from "./types";

const MAX_REDIRECTS = 10;

export async function fetchWithGitHubReleaseAuth(
  resolver: GitHubReleaseCredentialResolver,
  policy: GitHubReleaseAuthPolicy,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let currentUrl = url;
  let method = init.method ?? "GET";
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const parsed = new URL(currentUrl);
    const authorized = isAuthorizedGitHubReleaseUrl(parsed, policy);
    const headers = new Headers(init.headers);
    // Never carry caller/global auth across a hop. Re-add the release token
    // only for the exact GitHub repository origins covered by the policy.
    headers.delete("authorization");
    if (authorized) {
      const lease = await resolver.resolveOrThrow();
      headers.set("authorization", `token ${lease.token}`);
      headers.set("user-agent", "traycer-staging-release-auth");
    }
    const response = await fetch(currentUrl, {
      ...init,
      method,
      headers,
      redirect: "manual",
    });
    if (authorized && (response.status === 401 || response.status === 403)) {
      await cancelBody(response);
      resolver.discardLease();
      throw new AuthenticationRequiredError(AUTHENTICATION_REQUIRED_MESSAGE);
    }
    if (!isRedirect(response.status)) return response;
    const location = response.headers.get("location");
    if (location === null) return response;
    await cancelBody(response);
    currentUrl = new URL(location, currentUrl).toString();
    if (
      response.status === 301 ||
      response.status === 302 ||
      response.status === 303
    ) {
      method = "GET";
    }
  }
  throw new Error("GitHub release download exceeded the redirect limit");
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

async function cancelBody(response: Response): Promise<void> {
  if (response.body !== null) await response.body.cancel();
}
