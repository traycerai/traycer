import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGitHubReleaseAssetWithAuth,
  parseGitHubReleaseDownloadUrl,
} from "../release-asset";
import { createStagingGitHubReleaseAuthPolicy } from "../policy";
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

  it("returns a non-ok release listing response unchanged", async () => {
    process.env[STAGING_RELEASE_TOKEN_ENV] = "asset-token";
    const resolver = new GitHubReleaseCredentialResolver();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );
    const response = await fetchGitHubReleaseAssetWithAuth(
      resolver,
      testPolicy,
      releaseUrl,
      {},
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("missing");
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
