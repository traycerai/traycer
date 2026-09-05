import { fetchWithGitHubReleaseAuth } from "./authenticated-fetch";
import { isAuthorizedGitHubReleaseUrl } from "./policy";
import { AuthenticationRequiredError } from "./redact";
import type { GitHubReleaseCredentialResolver } from "./resolver";
import {
  AUTHENTICATION_REQUIRED_MESSAGE,
  type GitHubReleaseAuthPolicy,
} from "./types";

export interface GitHubReleaseDownloadRef {
  readonly tag: string;
  readonly assetName: string;
}

/**
 * `https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>` for the
 * policy's repository; null for every other URL.
 */
export function parseGitHubReleaseDownloadUrl(
  url: URL,
  policy: GitHubReleaseAuthPolicy,
): GitHubReleaseDownloadRef | null {
  if (url.origin !== "https://github.com") return null;
  const segments = url.pathname.split("/").slice(1);
  if (
    segments.length !== 6 ||
    segments[2] !== "releases" ||
    segments[3] !== "download"
  ) {
    return null;
  }
  const [owner, repo, , , tag, assetName] = segments;
  if (
    owner.toLowerCase() !== policy.repository.owner.toLowerCase() ||
    repo.toLowerCase() !== policy.repository.repo.toLowerCase()
  ) {
    return null;
  }
  try {
    return {
      tag: decodeURIComponent(tag),
      assetName: decodeURIComponent(assetName),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a release asset of the policy's repository with the release token.
 *
 * GitHub's browser download URL honours only a browser session: on a private
 * repository it answers 404 to a token header. The supported authenticated
 * path is the release-assets API, which 302-redirects to a signed object-store
 * URL. A browser download URL is therefore resolved through
 * `releases/tags/<tag>` to the asset's `releases/assets/<id>` URL and fetched
 * from there with `application/octet-stream`; the caller's headers (a `Range`,
 * for instance) travel with it. Any other URL is fetched as given.
 */
export async function fetchGitHubReleaseAssetWithAuth(
  resolver: GitHubReleaseCredentialResolver,
  policy: GitHubReleaseAuthPolicy,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const ref = parseGitHubReleaseDownloadUrl(new URL(url), policy);
  if (ref === null) {
    return fetchWithGitHubReleaseAuth(resolver, policy, url, init);
  }
  const { owner, repo } = policy.repository;
  const listingUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(ref.tag)}`;
  // ONE listing per (repo, tag) per process, not one per download attempt. A
  // resumed archive download retries up to `MAX_DOWNLOAD_ATTEMPTS` times, and
  // without this each retry re-listed the release - turning a slow download
  // into hundreds of api.github.com calls and eventually into the rate-limit
  // 403 that `isRateLimited` now has to disentangle from a real auth failure.
  // A release's asset set does not change under a download.
  const cacheKey = `${owner.toLowerCase()}/${repo.toLowerCase()}#${ref.tag}`;
  let release = releaseListingCache.get(cacheKey);
  if (release === undefined) {
    const listing = await fetchWithGitHubReleaseAuth(
      resolver,
      policy,
      listingUrl,
      {
        method: "GET",
        headers: { accept: "application/vnd.github+json" },
        signal: init.signal ?? null,
      },
    );
    if (!listing.ok) {
      // A 404 here is ambiguous: GitHub masks a repository the token cannot
      // see behind the same status a genuinely missing tag returns. Only the
      // repository probe can tell them apart, and only the "no access" answer
      // is an authentication problem - a missing tag with a perfectly good
      // token must keep its 404, or the user is told to re-authenticate for a
      // release that simply was not published.
      if (listing.status === 404) {
        await assertRepositoryVisible(resolver, policy, init.signal ?? null);
      }
      return listing;
    }
    release = await listing.json();
    releaseListingCache.set(cacheKey, release);
  }
  const assetUrl = releaseAssetApiUrl(release, ref.assetName, policy);
  if (assetUrl === null) {
    // A 200 listing is proof of access, so this 404 can only mean the asset is
    // absent. Never routed through the probe above.
    return new Response(null, { status: 404, statusText: "Not Found" });
  }
  const headers = new Headers(init.headers);
  headers.set("accept", "application/octet-stream");
  return fetchWithGitHubReleaseAuth(resolver, policy, assetUrl, {
    ...init,
    headers,
  });
}

/**
 * Resolved release payloads, keyed by repository and tag. Module-level to match
 * the resolver's own lifetime: both are per-process, and a CLI process is one
 * command.
 */
const releaseListingCache = new Map<string, unknown>();

/** Test seam: a new process starts with no cache, and a test should too. */
export function clearGitHubReleaseListingCache(): void {
  releaseListingCache.clear();
}

/**
 * Turn a 404 from release discovery into an authentication error IF, and only
 * if, the repository itself is invisible to this token.
 *
 * `GET /repos/<owner>/<repo>` is the one request whose 404 cannot mean
 * "missing tag" or "missing asset" - the repository coordinate is baked at
 * build time, so a 404 means the credential cannot see it. A 2xx proves access
 * and the caller's original 404 stands on its own.
 *
 * Deliberately best-effort: a probe that fails for any other reason (offline,
 * 5xx) must not manufacture an authentication verdict out of a network blip.
 * `fetchWithGitHubReleaseAuth` already throws `AuthenticationRequiredError` on
 * a 401/403 that is not a rate limit, so that path needs no help here.
 */
async function assertRepositoryVisible(
  resolver: GitHubReleaseCredentialResolver,
  policy: GitHubReleaseAuthPolicy,
  signal: AbortSignal | null,
): Promise<void> {
  const { owner, repo } = policy.repository;
  const probeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const probe = await fetchWithGitHubReleaseAuth(resolver, policy, probeUrl, {
    method: "GET",
    headers: { accept: "application/vnd.github+json" },
    signal,
  });
  if (probe.body !== null) await probe.body.cancel();
  if (probe.status !== 404) return;
  resolver.discardLease();
  throw new AuthenticationRequiredError(AUTHENTICATION_REQUIRED_MESSAGE);
}

function releaseAssetApiUrl(
  release: unknown,
  assetName: string,
  policy: GitHubReleaseAuthPolicy,
): string | null {
  if (release === null || typeof release !== "object") return null;
  const assets: unknown = Reflect.get(release, "assets");
  if (!Array.isArray(assets)) return null;
  for (const asset of assets) {
    if (asset === null || typeof asset !== "object") continue;
    const name: unknown = Reflect.get(asset, "name");
    const apiUrl: unknown = Reflect.get(asset, "url");
    if (name !== assetName || typeof apiUrl !== "string") continue;
    let parsed: URL;
    try {
      parsed = new URL(apiUrl);
    } catch {
      return null;
    }
    // The token is attached only to the repository's own API origin; an
    // asset URL pointing anywhere else is not one GitHub issued for it.
    return isAuthorizedGitHubReleaseUrl(parsed, policy) ? apiUrl : null;
  }
  return null;
}
