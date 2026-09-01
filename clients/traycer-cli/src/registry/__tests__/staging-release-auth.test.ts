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
});
