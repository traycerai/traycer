import { describe, expect, it } from "vitest";
import type { HostAvailableSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { projectAppHostAvailableSnapshot } from "../host-settings-panel-model";

function makeSnapshot(
  versions: readonly string[],
  latest: string,
): HostAvailableSnapshot {
  return {
    generatedAt: "2026-05-15T00:00:00Z",
    latest,
    platformKey: "darwin-arm64",
    manifestUrl: "https://example.invalid/versions.json",
    versions: versions.map((version) => ({
      version,
      releasedAt: "2026-05-15T00:00:00Z",
      releaseNotesUrl: "https://example.invalid/notes",
      yanked: false,
      deprecationReason: null,
      platformAsset: {
        available: true,
        unavailableReason: null,
        url: "https://example.invalid/host.tar.gz",
        sizeBytes: 1024,
        sha256: "abc",
        signatureUrl: "https://example.invalid/host.tar.gz.minisig",
        signatureAlgorithm: "minisign",
        publicKeyId: "test-key",
      },
    })),
  };
}

// Cold-review finding 6: `host available --include-pre-releases` is broad for
// CLI operators, but the app Host picker is RC-consent only.
describe("projectAppHostAvailableSnapshot", () => {
  it("keeps only stable versions when prereleases are off", () => {
    const projected = projectAppHostAvailableSnapshot(
      makeSnapshot(
        [
          "1.7.0",
          "1.7.0-rc.2",
          "1.7.0-alpha.1",
          "1.7.0-beta.3",
          "1.7.0-nightly.20260515",
        ],
        "1.7.0",
      ),
      false,
    );

    expect(projected.versions.map((entry) => entry.version)).toEqual(["1.7.0"]);
  });

  it("keeps stable and X.Y.Z-rc.N when prereleases are on, excluding alpha/beta/nightly", () => {
    const projected = projectAppHostAvailableSnapshot(
      makeSnapshot(
        [
          "1.7.0",
          "1.7.0-rc.2",
          "1.7.0-rc.1",
          "1.7.0-alpha.1",
          "1.7.0-beta.3",
          "1.7.0-nightly.20260515",
          "2.0.0-dev.4",
        ],
        "1.7.0",
      ),
      true,
    );

    expect(projected.versions.map((entry) => entry.version)).toEqual([
      "1.7.0",
      "1.7.0-rc.2",
      "1.7.0-rc.1",
    ]);
  });

  it("preserves build metadata on consented stable and rc forms", () => {
    const projected = projectAppHostAvailableSnapshot(
      makeSnapshot(
        ["1.7.0+build.1", "1.7.0-rc.2+meta", "1.7.0-alpha.1+meta"],
        "1.7.0+build.1",
      ),
      true,
    );

    expect(projected.versions.map((entry) => entry.version)).toEqual([
      "1.7.0+build.1",
      "1.7.0-rc.2+meta",
    ]);
  });
});
