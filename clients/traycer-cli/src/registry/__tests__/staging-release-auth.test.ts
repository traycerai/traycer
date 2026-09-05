import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI_ERROR_CODES } from "../../runner/errors";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalToken = process.env.TRAYCER_STAGING_RELEASE_TOKEN;
const originalPath = process.env.PATH;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("../../config");
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  if (originalToken === undefined) {
    Reflect.deleteProperty(process.env, "TRAYCER_STAGING_RELEASE_TOKEN");
  } else {
    process.env.TRAYCER_STAGING_RELEASE_TOKEN = originalToken;
  }
  if (originalPath === undefined) {
    Reflect.deleteProperty(process.env, "PATH");
  } else {
    process.env.PATH = originalPath;
  }
});

async function loadRegistryFetch(environment: "production" | "staging") {
  vi.doMock("../../config", () => ({
    config: { environment, releaseRepo: "traycerai/traycer-internal" },
    configuredReleaseRepo: () => "traycerai/traycer-internal",
  }));
  return (await import("../staging-release-auth")).registryFetch;
}

describe("registryFetch staging authentication", () => {
  it("passes non-staging requests through to fetch untouched", async () => {
    const fetch = vi.fn(
      async (input: string | URL | Request, init: RequestInit | undefined) => {
        expect(input).toBe("https://example.test/manifest");
        expect(init).toEqual({ method: "GET" });
        return new Response("ok", { status: 200 });
      },
    );
    vi.stubGlobal("fetch", fetch);
    const registryFetch = await loadRegistryFetch("production");
    await expect(
      registryFetch("https://example.test/manifest", { method: "GET" }),
    ).resolves.toHaveProperty("status", 200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps missing staging credentials to E_RELEASE_AUTHENTICATION_REQUIRED", async () => {
    Reflect.deleteProperty(process.env, "TRAYCER_STAGING_RELEASE_TOKEN");
    process.env.PATH = "/path/that/does/not/exist";
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    const registryFetch = await loadRegistryFetch("staging");
    let thrown: unknown;
    try {
      await registryFetch(
        "https://api.github.com/repos/traycerai/traycer-internal/releases",
        {},
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: CLI_ERROR_CODES.RELEASE_AUTHENTICATION_REQUIRED,
    });
  });

  it("resolves staging browser download URLs through the tag listing and API asset", async () => {
    process.env.TRAYCER_STAGING_RELEASE_TOKEN = "registry-token";
    const registryFetch = await loadRegistryFetch("staging");
    const calls: Array<{
      url: string;
      method: string;
      accept: string | null;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit | undefined) => {
        const headers = new Headers(init?.headers);
        const url = typeof input === "string" ? input : input.toString();
        calls.push({
          url,
          method: init?.method ?? "GET",
          accept: headers.get("accept"),
        });
        if (calls.length === 1) {
          return new Response(
            JSON.stringify({
              assets: [
                {
                  name: "versions.json",
                  url: "https://api.github.com/repos/traycerai/traycer-internal/releases/assets/17",
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const response = await registryFetch(
      "https://github.com/traycerai/traycer-internal/releases/download/host-v1.2.3/versions.json",
      {},
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/traycerai/traycer-internal/releases/tags/host-v1.2.3",
        method: "GET",
        accept: "application/vnd.github+json",
      },
      {
        url: "https://api.github.com/repos/traycerai/traycer-internal/releases/assets/17",
        method: "GET",
        accept: "application/octet-stream",
      },
    ]);
  });
});
