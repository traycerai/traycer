import { afterEach, describe, expect, it } from "vitest";
import { resolveManifestUrl } from "../manifest-url";
import { config } from "../../config";

const originalEnvironment = config.environment;
const originalCdnBaseUrl = config.releaseCdnBaseUrl;
const originalReleaseRepo = config.releaseRepo;
const originalHostFeedTag = config.hostDiscoveryTag;

afterEach(() => {
  config.environment = originalEnvironment;
  config.releaseCdnBaseUrl = originalCdnBaseUrl;
  config.releaseRepo = originalReleaseRepo;
  config.hostDiscoveryTag = originalHostFeedTag;
});

describe("resolveManifestUrl", () => {
  it("returns the ordered CDN and GitHub signed-feed origins", () => {
    expect(resolveManifestUrl().urls).toEqual([
      "https://releases.traycer.ai/host/versions.signed.json",
      "https://github.com/traycerai/traycer/releases/download/released-host-versions/versions.signed.json",
    ]);
    expect(resolveManifestUrl().url).toBe(
      "https://releases.traycer.ai/host/versions.signed.json",
    );
  });

  it("never points to the unsigned legacy document", () => {
    expect(
      resolveManifestUrl().urls?.every((url) =>
        url.endsWith("versions.signed.json"),
      ),
    ).toBe(true);
  });

  it("uses the stamped staging CDN before the private GitHub feed", () => {
    config.environment = "staging";
    config.releaseCdnBaseUrl = "https://releases.dev.traycer.ai";
    config.releaseRepo = "acme/private-traycer";
    config.hostDiscoveryTag = "released-host-versions-staging";

    expect(resolveManifestUrl().urls).toEqual([
      "https://releases.dev.traycer.ai/host/versions.signed.json",
      "https://github.com/acme/private-traycer/releases/download/released-host-versions-staging/versions.signed.json",
    ]);
  });
});
