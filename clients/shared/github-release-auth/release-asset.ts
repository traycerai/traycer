import { fetchWithGitHubReleaseAuth } from "./authenticated-fetch";
import { isAuthorizedGitHubReleaseUrl } from "./policy";
import type { GitHubReleaseCredentialResolver } from "./resolver";
import type { GitHubReleaseAuthPolicy } from "./types";

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
  // A missing release reads exactly like a missing asset would have on the
  // browser URL; the caller already classifies non-2xx responses.
  if (!listing.ok) return listing;
  const assetUrl = releaseAssetApiUrl(
    await listing.json(),
    ref.assetName,
    policy,
  );
  if (assetUrl === null) {
    return new Response(null, { status: 404, statusText: "Not Found" });
  }
  const headers = new Headers(init.headers);
  headers.set("accept", "application/octet-stream");
  return fetchWithGitHubReleaseAuth(resolver, policy, assetUrl, {
    ...init,
    headers,
  });
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
