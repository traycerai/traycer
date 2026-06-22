import { describe, expect, it } from "vitest";
import { buildHostAvailableListing } from "../host-available";
import type {
  HostPlatformAsset,
  HostVersionEntry,
  HostVersionsManifest,
} from "../../registry";

const AVAILABLE_ASSET: HostPlatformAsset = {
  available: true,
  unavailableReason: null,
  url: "https://github.com/traycerai/traycer/releases/download/host-v1.2.0/traycer-host-macos-arm64.tar.gz",
  sizeBytes: 123,
  sha256: "a".repeat(64),
  signatureUrl:
    "https://github.com/traycerai/traycer/releases/download/host-v1.2.0/traycer-host-macos-arm64.tar.gz.minisig",
  signatureAlgorithm: "minisign",
  publicKeyId: "test-key",
};

function createEntry(version: string): HostVersionEntry {
  return {
    version,
    releasedAt: "2026-06-22T00:00:00.000Z",
    releaseNotesUrl: `https://github.com/traycerai/traycer/releases/tag/host-v${version}`,
    yanked: false,
    deprecationReason: null,
    requiredCliVersion: null,
    platforms: {
      "darwin-arm64": AVAILABLE_ASSET,
    },
  };
}

function createManifest(versions: readonly string[]): HostVersionsManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-22T01:00:00.000Z",
    latest: "1.2.0",
    versions: versions.map((version) => createEntry(version)),
  };
}

describe("buildHostAvailableListing", () => {
  it("hides prerelease host versions by default", () => {
    const listing = buildHostAvailableListing({
      manifest: createManifest([
        "1.3.0-rc.2",
        "1.2.0",
        "1.2.0-beta.1",
        "1.1.0+build.4",
      ]),
      manifestUrl:
        "https://github.com/traycerai/traycer/releases/download/released-host-versions/versions.json",
      platformKey: "darwin-arm64",
      includePreReleases: false,
    });

    expect(listing.manifest.versions.map((entry) => entry.version)).toEqual([
      "1.2.0",
      "1.1.0+build.4",
    ]);
    expect(listing.human).toContain(
      "  1.2.0  released 2026-06-22T00:00:00.000Z  [latest]",
    );
    expect(listing.human).toContain(
      "  1.1.0+build.4  released 2026-06-22T00:00:00.000Z",
    );
    expect(listing.human).not.toContain("1.3.0-rc.2");
    expect(listing.human).not.toContain("1.2.0-beta.1");
  });

  it("lists prerelease host versions when requested", () => {
    const listing = buildHostAvailableListing({
      manifest: createManifest(["1.3.0-rc.2", "1.2.0", "1.2.0-beta.1"]),
      manifestUrl:
        "https://github.com/traycerai/traycer/releases/download/released-host-versions/versions.json",
      platformKey: "darwin-arm64",
      includePreReleases: true,
    });

    expect(listing.manifest.versions.map((entry) => entry.version)).toEqual([
      "1.3.0-rc.2",
      "1.2.0",
      "1.2.0-beta.1",
    ]);
    expect(listing.human).toContain("1.3.0-rc.2");
    expect(listing.human).toContain("1.2.0-beta.1");
  });
});
