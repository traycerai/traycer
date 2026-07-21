import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HostPlatformAsset,
  HostVersionEntry,
  HostVersionsManifest,
  RegistryClient,
} from "../../registry";

// Fixup A1 (Host Update Layer Redesign, ticket "Desktop main:
// HostController" cold review): `HostController.parseAvailableSnapshot`
// expected a flat `{latest, versions[].platformAsset}` shape while the real
// `traycer host available --json` envelope (below) nests assets under
// `manifest.versions[].platforms[platformKey]` - every desktop-side test
// fixture used the same wrong shape, so 34/34 green validated the bug.
// This suite runs the REAL command (registry client mocked, everything
// else genuine) and pins a mirror of desktop's FIXED parser against its
// actual `result.data` output, so a future wire-shape drift fails here
// first.
const mocks = vi.hoisted(() => ({
  fetchManifestMock: vi.fn(),
}));

vi.mock("../../registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../registry")>();
  return {
    ...actual,
    createDefaultRegistryClient: async (): Promise<RegistryClient> => ({
      fetchManifest: mocks.fetchManifestMock,
      resolveAsset: vi.fn(),
      downloadAndVerify: vi.fn(),
    }),
    // Pin the platform key so this suite's assertions (keyed off
    // `darwin-arm64` fixtures below) are deterministic regardless of the
    // machine actually running the test.
    currentHostPlatformKey: () => "darwin-arm64",
  };
});

import {
  buildHostAvailableCommand,
  buildHostAvailableListing,
} from "../host-available";
import type { CommandContext } from "../../runner/runner";

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

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

// Exact mirror of the FIXED `parseAvailableSnapshot` in
// `clients/desktop/src/electron-main/host/host-controller.ts` - kept
// duplicated (not imported) since Desktop must not depend on
// `clients/traycer-cli/` internals at runtime; this copy exists solely to
// pin the contract from the CLI side, matching the
// `projectInstallResultLikeDesktop` pattern in `host-update.test.ts`.
function isPlainObjectLikeDesktop(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAvailableSnapshotLikeDesktop(raw: unknown): {
  readonly latest: string;
  readonly versions: ReadonlyArray<{
    readonly version: string;
    readonly available: boolean;
  }>;
} {
  if (!isPlainObjectLikeDesktop(raw) || typeof raw.platformKey !== "string") {
    return { latest: "", versions: [] };
  }
  const platformKey = raw.platformKey;
  const manifest = isPlainObjectLikeDesktop(raw.manifest) ? raw.manifest : null;
  if (
    manifest === null ||
    typeof manifest.latest !== "string" ||
    !Array.isArray(manifest.versions)
  ) {
    return { latest: "", versions: [] };
  }
  const versions = manifest.versions.flatMap((entry) => {
    if (!isPlainObjectLikeDesktop(entry) || typeof entry.version !== "string")
      return [];
    const platforms = isPlainObjectLikeDesktop(entry.platforms)
      ? entry.platforms
      : null;
    const asset = platforms !== null ? platforms[platformKey] : null;
    return [
      {
        version: entry.version,
        available: isPlainObjectLikeDesktop(asset) && asset.available === true,
      },
    ];
  });
  return { latest: manifest.latest, versions };
}

describe("buildHostAvailableCommand's real data envelope against desktop's parse contract", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("desktop's parser extracts latest + per-platform availability from the command's real result.data", async () => {
    mocks.fetchManifestMock.mockResolvedValue(
      createManifest(["1.3.0", "1.2.0"]),
    );

    const command = buildHostAvailableCommand({ includePreReleases: false });
    const result = await command(fakeCtx());

    const parsed = parseAvailableSnapshotLikeDesktop(result.data);
    expect(parsed).toEqual({
      latest: "1.2.0",
      versions: [
        { version: "1.3.0", available: true },
        { version: "1.2.0", available: true },
      ],
    });
  });

  it("desktop's parser reports unavailable for a version with no asset for the current platform", async () => {
    const manifest: HostVersionsManifest = {
      schemaVersion: 1,
      generatedAt: "2026-06-22T01:00:00.000Z",
      latest: "1.2.0",
      versions: [
        {
          version: "1.2.0",
          releasedAt: "2026-06-22T00:00:00.000Z",
          releaseNotesUrl: "https://example.com/1.2.0",
          yanked: false,
          deprecationReason: null,
          requiredCliVersion: null,
          platforms: {
            "linux-x64": AVAILABLE_ASSET,
          },
        },
      ],
    };
    mocks.fetchManifestMock.mockResolvedValue(manifest);

    const command = buildHostAvailableCommand({ includePreReleases: false });
    const result = await command(fakeCtx());

    const parsed = parseAvailableSnapshotLikeDesktop(result.data);
    expect(parsed).toEqual({
      latest: "1.2.0",
      versions: [{ version: "1.2.0", available: false }],
    });
  });
});
