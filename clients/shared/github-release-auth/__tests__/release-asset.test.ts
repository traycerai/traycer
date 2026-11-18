import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearGitHubReleaseListingCache,
  fetchGitHubReleaseAssetWithAuth,
  parseGitHubReleaseDownloadUrl,
} from "../release-asset";
import { createStagingGitHubReleaseAuthPolicy } from "../policy";
import { AuthenticationRequiredError } from "../redact";
import { GitHubReleaseCredentialResolver } from "../resolver";
import { STAGING_RELEASE_TOKEN_ENV } from "../types";

const repo = "traycerai/traycer-internal";
const policy = createStagingGitHubReleaseAuthPolicy(repo);
if (policy === null) throw new Error("invalid release-asset test policy");
const testPolicy = policy;
const releaseUrl =
  "https://github.com/traycerai/traycer-internal/releases/download/desktop-v1.2.3-staging.4.gabcdef1/Traycer%20Staging.zip";
const apiAssetUrl =
  "https://api.github.com/repos/traycerai/traycer-internal/releases/assets/42";
const originalToken = process.env[STAGING_RELEASE_TOKEN_ENV];

afterEach(() => {
  vi.unstubAllGlobals();
  // The release listing is memoized per (repo, tag) for the life of the
  // PROCESS, which is one CLI command in production and the whole file here.
  // Without this every case after the first would silently reuse the first
  // one's listing and assert call counts that no longer describe it.
  clearGitHubReleaseListingCache();
  if (originalToken === undefined) {
    Reflect.deleteProperty(process.env, STAGING_RELEASE_TOKEN_ENV);
  } else {
    process.env[STAGING_RELEASE_TOKEN_ENV] = originalToken;
  }
});

describe("GitHub release asset URL resolution", () => {
  it("parses only the policy repository's browser download URL", () => {
    expect(
      parseGitHubReleaseDownloadUrl(new URL(releaseUrl), testPolicy),
    ).toEqual({
      tag: "desktop-v1.2.3-staging.4.gabcdef1",
      assetName: "Traycer Staging.zip",
    });
    expect(
      parseGitHubReleaseDownloadUrl(
        new URL(
          releaseUrl.replace(
            "traycerai/traycer-internal",
            "TRayCerAI/TRAYCER-INTERNAL",
          ),
        ),
        testPolicy,
      ),
    ).toEqual({
      tag: "desktop-v1.2.3-staging.4.gabcdef1",
      assetName: "Traycer Staging.zip",
    });
    expect(
      parseGitHubReleaseDownloadUrl(
        new URL(releaseUrl.replace("traycerai", "other")),
        testPolicy,
      ),
    ).toBeNull();
    expect(
      parseGitHubReleaseDownloadUrl(
        new URL(
          releaseUrl.replace("https://github.com", "https://api.github.com"),
        ),
        testPolicy,
      ),
    ).toBeNull();
  });

  it("lists the release through the API then fetches its matching asset with octet-stream and Range", async () => {
    process.env[STAGING_RELEASE_TOKEN_ENV] = "asset-token";
    const resolver = new GitHubReleaseCredentialResolver();
    const calls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      accept: string | null;
      range: string | null;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit | undefined) => {
        const headers = new Headers(init?.headers);
        const url = typeof input === "string" ? input : input.toString();
        calls.push({
          url,
          method: init?.method ?? "GET",
          authorization: headers.get("authorization"),
          accept: headers.get("accept"),
          range: headers.get("range"),
        });
        if (calls.length === 1) {
          return new Response(
            JSON.stringify({
              assets: [{ name: "Traycer Staging.zip", url: apiAssetUrl }],
            }),
            { status: 200 },
          );
        }
        return new Response("asset", { status: 200 });
      }),
    );

    const response = await fetchGitHubReleaseAssetWithAuth(
      resolver,
      testPolicy,
      releaseUrl,
      { method: "GET", headers: { range: "bytes=0-99" } },
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/traycerai/traycer-internal/releases/tags/desktop-v1.2.3-staging.4.gabcdef1",
        method: "GET",
        authorization: "token asset-token",
        accept: "application/vnd.github+json",
        range: null,
      },
      {
        url: apiAssetUrl,
        method: "GET",
        authorization: "token asset-token",
        accept: "application/octet-stream",
        range: "bytes=0-99",
      },
    ]);
  });

  it("returns a non-ok, non-404 release listing response unchanged", async () => {
    process.env[STAGING_RELEASE_TOKEN_ENV] = "asset-token";
    const resolver = new GitHubReleaseCredentialResolver();
    const fetch = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const response = await fetchGitHubReleaseAssetWithAuth(
      resolver,
      testPolicy,
      releaseUrl,
      {},
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("boom");
    // No repository probe: only a 404 is ambiguous about access.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a 404 listing a 404 when the repository IS visible", async () => {
    // The realistic 404: the tag simply is not published yet (a rolling
    // discovery tag before its first release, or a manifest naming a deleted
    // one). The token is fine, so the caller must see the 404 it would have
    // seen before - telling this user to re-authenticate would be a lie, and
    // downstream it would discard a resumable partial download.
    process.env[STAGING_RELEASE_TOKEN_ENV] = "asset-token";
    const resolver = new GitHubReleaseCredentialResolver();
    const urls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);
      return url.endsWith("/traycer-internal")
        ? new Response("{}", { status: 200 })
        : new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    const response = await fetchGitHubReleaseAssetWithAuth(
      resolver,
      testPolicy,
      releaseUrl,
      {},
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("missing");
    expect(urls).toEqual([
      "https://api.github.com/repos/traycerai/traycer-internal/releases/tags/desktop-v1.2.3-staging.4.gabcdef1",
      "https://api.github.com/repos/traycerai/traycer-internal",
    ]);
  });

  it("turns a 404 listing into an auth failure when the repository is invisible", async () => {
    // GitHub masks a private repository the token cannot see behind the same
    // 404 a missing tag returns, so only the repository probe separates them.
    // Without this the user is told the registry is unavailable and never sees
    // the remedy that would actually work.
    process.env[STAGING_RELEASE_TOKEN_ENV] = "asset-token";
    const resolver = new GitHubReleaseCredentialResolver();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );
    await expect(
      fetchGitHubReleaseAssetWithAuth(resolver, testPolicy, releaseUrl, {}),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });

  it("lists the release ONCE across repeated asset fetches", async () => {
    // A resumed archive download retries up to `MAX_DOWNLOAD_ATTEMPTS` times.
    // Re-listing per attempt is what turned a slow download into hundreds of
    // api.github.com calls and, eventually, a rate-limit 403.
    process.env[STAGING_RELEASE_TOKEN_ENV] = "asset-token";
    const resolver = new GitHubReleaseCredentialResolver();
    const listingCalls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/releases/tags/")) {
        listingCalls.push(url);
        return new Response(
          JSON.stringify({
            assets: [{ name: "Traycer Staging.zip", url: apiAssetUrl }],
          }),
          { status: 200 },
        );
      }
      return new Response("bytes", { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetchGitHubReleaseAssetWithAuth(
        resolver,
        testPolicy,
        releaseUrl,
        {},
      );
      expect(response.status).toBe(200);
    }
    expect(listingCalls).toHaveLength(1);
    // Three asset fetches, one listing.
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("returns synthetic 404 for a missing or off-repository asset and passes non-download URLs through", async () => {
    process.env[STAGING_RELEASE_TOKEN_ENV] = "asset-token";
    const resolver = new GitHubReleaseCredentialResolver();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ assets: [{ name: "other.zip", url: apiAssetUrl }] }),
          {
            status: 200,
          },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const missing = await fetchGitHubReleaseAssetWithAuth(
      resolver,
      testPolicy,
      releaseUrl,
      {},
    );
    expect(missing.status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);

    const plain = await fetchGitHubReleaseAssetWithAuth(
      resolver,
      testPolicy,
      "https://example.test/not-a-download",
      {},
    );
    expect(plain.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns synthetic 404 when a matching asset points outside the policy repository", async () => {
    process.env[STAGING_RELEASE_TOKEN_ENV] = "asset-token";
    const resolver = new GitHubReleaseCredentialResolver();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            assets: [
              {
                name: "Traycer Staging.zip",
                url: "https://api.github.com/repos/other/repo/releases/assets/42",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const response = await fetchGitHubReleaseAssetWithAuth(
      resolver,
      testPolicy,
      releaseUrl,
      {},
    );
    expect(response.status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("a failing probe-body cancellation cannot rewrite the verdict", () => {
  // The probe reaches its answer from `status` alone and then releases the
  // socket. That release sat one line ABOVE the verdict, un-guarded, so a
  // rejecting `cancel()` replaced whatever the probe had just decided. It
  // rejects precisely when the connection has already errored - the same
  // condition that makes a probe worth doing - so this is the reachable case,
  // not a contrived one.
  function bodyThatFailsToCancel(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        throw new Error("cancel failed: connection already gone");
      },
    });
  }

  function stubListing404ThenProbe(probeStatus: number): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/releases/tags/")) {
          return new Response("no such tag", { status: 404 });
        }
        return new Response(bodyThatFailsToCancel(), { status: probeStatus });
      }),
    );
  }

  it.each([
    ["access is proven", 200],
    ["the probe itself fails", 500],
  ])(
    "keeps the caller's 404 when %s and the probe body will not cancel",
    async (_label, probeStatus) => {
      process.env[STAGING_RELEASE_TOKEN_ENV] = "asset-token";
      const resolver = new GitHubReleaseCredentialResolver();
      const discard = vi.spyOn(resolver, "discardLease");
      stubListing404ThenProbe(probeStatus);

      const response = await fetchGitHubReleaseAssetWithAuth(
        resolver,
        testPolicy,
        releaseUrl,
        {},
      );

      // The 404 the caller asked about, not the cleanup's exception.
      expect(response.status).toBe(404);
      expect(discard).not.toHaveBeenCalled();
    },
  );

  it("still discards the lease and raises the auth error when the probe 404s", async () => {
    process.env[STAGING_RELEASE_TOKEN_ENV] = "asset-token";
    const resolver = new GitHubReleaseCredentialResolver();
    const discard = vi.spyOn(resolver, "discardLease");
    stubListing404ThenProbe(404);

    // The severe arm: a rejecting cancel used to skip BOTH the discard and the
    // throw, so a credential that can no longer see the repository stayed
    // cached for the process lifetime and the CLI reported a generic registry
    // failure instead of asking the user to re-authenticate.
    await expect(
      fetchGitHubReleaseAssetWithAuth(resolver, testPolicy, releaseUrl, {}),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(discard).toHaveBeenCalledTimes(1);
  });
});
