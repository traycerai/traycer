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
  let method = (init.method ?? "GET").toUpperCase();
  let body: BodyInit | null = init.body ?? null;
  let bodyDropped = false;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const parsed = new URL(currentUrl);
    const authorized = isAuthorizedGitHubReleaseUrl(parsed, policy);
    const headers = new Headers(init.headers);
    // Never carry caller/global auth across a hop. Re-add the release token
    // only for the exact GitHub repository origins covered by the policy.
    headers.delete("authorization");
    if (bodyDropped) {
      headers.delete("content-type");
      headers.delete("content-length");
    }
    if (authorized) {
      const lease = await resolver.resolveOrThrow();
      headers.set("authorization", `token ${lease.token}`);
      headers.set("user-agent", "traycer-staging-release-auth");
    }
    const response = await fetch(currentUrl, {
      ...init,
      method,
      body,
      headers,
      redirect: "manual",
    });
    // The rate-limit exception is 403-ONLY. GitHub overloads 403 with "slow
    // down", but a 401 is always a credential verdict - rate-limit headers can
    // ride along on one, and honouring them there would retain a token the
    // server just rejected.
    if (
      authorized &&
      (response.status === 401 ||
        (response.status === 403 && !isRateLimited(response)))
    ) {
      await cancelBody(response);
      resolver.discardLease();
      throw new AuthenticationRequiredError(AUTHENTICATION_REQUIRED_MESSAGE);
    }
    if (!isRedirect(response.status)) return response;
    const location = response.headers.get("location");
    if (location === null) return response;
    await cancelBody(response);
    currentUrl = new URL(location, currentUrl).toString();
    // Browser redirect semantics: 301/302 turn only a POST into a GET, 303
    // turns everything but GET/HEAD into a GET, 307/308 preserve the request.
    // A request that became a GET carries no body.
    const becomesGet =
      response.status === 303
        ? method !== "GET" && method !== "HEAD"
        : (response.status === 301 || response.status === 302) &&
          method === "POST";
    if (becomesGet) {
      method = "GET";
      body = null;
      bodyDropped = true;
    }
  }
  throw new Error("GitHub release download exceeded the redirect limit");
}

/**
 * A 403 that means "slow down", not "your token is no good".
 *
 * GitHub answers 403 for BOTH a permission failure and a rate limit, and the
 * two want opposite handling: a permission failure should discard the lease and
 * tell the user to re-authenticate, while a rate limit should be retried with
 * the SAME credential. Reading a rate limit as a permission failure is the
 * worse direction - it discards a working token and puts an
 * `AuthenticationRequiredError` in front of a user whose only problem was
 * making too many requests.
 *
 * The two signals GitHub documents: `x-ratelimit-remaining: 0` for a primary
 * limit, and `retry-after` for a secondary one. Returning the response leaves
 * classification to the caller, which already retries a non-2xx with backoff.
 */
function isRateLimited(response: Response): boolean {
  if (response.headers.has("retry-after")) return true;
  return response.headers.get("x-ratelimit-remaining") === "0";
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

async function cancelBody(response: Response): Promise<void> {
  if (response.body !== null) await response.body.cancel();
}
