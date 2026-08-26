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
  readHostInstallRecordMock: vi.fn(),
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

// The derived default is the one thing this command reads off local disk, so
// the install record is mocked rather than materialized: these cases are about
// what the CLI CONCLUDES from a version string (and from a read that fails),
// not about `install.json` parsing, which `manifest/host-install` owns.
vi.mock("../../manifest/host-install", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../manifest/host-install")>();
  return {
    ...actual,
    readHostInstallRecord: mocks.readHostInstallRecordMock,
  };
});

import {
  buildHostAvailableCommand,
  buildHostAvailableListing,
  resolveIncludePreReleases,
} from "../host-available";
import type { HostInstallRecord } from "../../manifest/host-install";
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
    minimumEpoch: null,
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
  it("marks a version above this CLI's floor unavailable, with the floor in the reason", () => {
    // The registry client rejects a floored target only at download time,
    // AFTER the RPC answered accepted - so the LISTING must carry the floor,
    // or the GUI advertises installs that can only terminate as floor
    // failures. Same evaluator as the client, so the two cannot disagree.
    const floored = {
      ...createEntry("1.2.0"),
      requiredCliVersion: "10.0.0",
      minimumEpoch: null,
    };
    const manifest: HostVersionsManifest = {
      schemaVersion: 1,
      generatedAt: "2026-06-22T01:00:00.000Z",
      latest: "1.2.0",
      versions: [floored, createEntry("1.1.0")],
    };
    const listing = buildHostAvailableListing({
      manifest,
      manifestUrl: "https://example.com/versions.json",
      platformKey: "darwin-arm64",
      includePreReleases: false,
      includePreReleasesSource: "explicit-exclude",
      cliVersion: "9.9.9",
    });

    const asset = listing.manifest.versions[0].platforms["darwin-arm64"];
    expect(asset?.available).toBe(false);
    expect(asset?.unavailableReason).toContain("10.0.0");
    // The unfloored sibling stays untouched.
    expect(
      listing.manifest.versions[1].platforms["darwin-arm64"]?.available,
    ).toBe(true);
  });

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
      includePreReleasesSource: "explicit-exclude",
      cliVersion: "9.9.9",
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
      includePreReleasesSource: "explicit-include",
      cliVersion: "9.9.9",
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

// The catalog default is derived, not stored, and the CLI is the only process
// that can derive it - it is the one that can read this environment's install
// record. These cases pin all four provenances plus the fail-closed rule that
// keeps a corrupt record from breaking the listing.
describe("resolveIncludePreReleases", () => {
  it("honours an explicit include regardless of what is installed", () => {
    expect(
      resolveIncludePreReleases({
        override: true,
        installedHostVersion: "1.2.0",
      }),
    ).toEqual({ includePreReleases: true, source: "explicit-include" });
  });

  it("honours an explicit exclude even on an RC host - the whole point of the negative flag", () => {
    // Without a negative flag an RC host could never be shown a stable-only
    // catalog: its derived default includes RCs, and "unchecked" would be
    // indistinguishable from "never touched".
    expect(
      resolveIncludePreReleases({
        override: false,
        installedHostVersion: "2.0.0-rc.1",
      }),
    ).toEqual({ includePreReleases: false, source: "explicit-exclude" });
  });

  it("derives inclusion from a canonical RC install", () => {
    expect(
      resolveIncludePreReleases({
        override: null,
        installedHostVersion: "2.0.0-rc.1",
      }),
    ).toEqual({ includePreReleases: true, source: "installed-rc" });
  });

  it("derives stable-default for every non-canonical installed version", () => {
    // Canonical `X.Y.Z-rc.N` is the ONLY prerelease shape that activates
    // implicit following; everything else - including a version that merely
    // contains a hyphen - fails closed to the stable catalog.
    for (const installedHostVersion of [
      "1.2.0",
      "2.0.0-beta.1",
      "2.0.0-alpha",
      "2.0.0-nightly.3",
      "2.0.0-rc",
      "2.0.0-rc.01",
      "2.0.0-rc.1.2",
      "2.0.0-rc.1+build.7",
      "local-traycer-host-1730000000",
      "not-a-version",
      "",
    ]) {
      expect(
        resolveIncludePreReleases({ override: null, installedHostVersion }),
      ).toEqual({ includePreReleases: false, source: "stable-default" });
    }
  });

  it("derives stable-default when nothing is installed or the record was unreadable", () => {
    expect(
      resolveIncludePreReleases({ override: null, installedHostVersion: null }),
    ).toEqual({ includePreReleases: false, source: "stable-default" });
  });
});

function installRecord(version: string): HostInstallRecord {
  return {
    installId: "install-1",
    version,
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-06-22T00:00:00.000Z",
    source: { kind: "registry", value: "https://example.com/host.tar.gz" },
    archiveSha256: null,
    signatureVerifiedAt: "2026-06-22T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: "/opt/traycer/host",
  };
}

describe("buildHostAvailableCommand's derived catalog default", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("lists an RC host's own line with no flag passed, and says why", async () => {
    mocks.fetchManifestMock.mockResolvedValue(
      createManifest(["2.0.0-rc.2", "1.2.0"]),
    );
    mocks.readHostInstallRecordMock.mockResolvedValue(
      installRecord("2.0.0-rc.1"),
    );

    const command = buildHostAvailableCommand({ includePreReleases: null });
    const result = await command(fakeCtx());

    expect(result.data).toMatchObject({
      includePreReleases: true,
      includePreReleasesSource: "installed-rc",
    });
    expect(parseAvailableSnapshotLikeDesktop(result.data).versions).toEqual([
      { version: "2.0.0-rc.2", available: true },
      { version: "1.2.0", available: true },
    ]);
    expect(result.human).toContain(
      "pre-releases: included (following the installed release candidate's line)",
    );
  });

  it("keeps a stable host on the stable catalog with no flag passed", async () => {
    mocks.fetchManifestMock.mockResolvedValue(
      createManifest(["2.0.0-rc.2", "1.2.0"]),
    );
    mocks.readHostInstallRecordMock.mockResolvedValue(installRecord("1.2.0"));

    const command = buildHostAvailableCommand({ includePreReleases: null });
    const result = await command(fakeCtx());

    expect(result.data).toMatchObject({
      includePreReleases: false,
      includePreReleasesSource: "stable-default",
    });
    expect(parseAvailableSnapshotLikeDesktop(result.data).versions).toEqual([
      { version: "1.2.0", available: true },
    ]);
  });

  it("still lists the registry when the install record is corrupt", async () => {
    // A corrupt `install.json` is exactly when someone needs to see which
    // versions exist. `readHostInstallRecord` throws rather than overwrite a
    // suspect record - right for the install path, wrong for a listing - so
    // this must fail closed to stable-default, not propagate.
    mocks.fetchManifestMock.mockResolvedValue(
      createManifest(["2.0.0-rc.2", "1.2.0"]),
    );
    mocks.readHostInstallRecordMock.mockRejectedValue(
      Object.assign(new Error("host install record is invalid"), {
        code: "E_HOST_INSTALL_RECORD_INVALID",
      }),
    );

    const command = buildHostAvailableCommand({ includePreReleases: null });
    const result = await command(fakeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      includePreReleases: false,
      includePreReleasesSource: "stable-default",
    });
    expect(parseAvailableSnapshotLikeDesktop(result.data).versions).toEqual([
      { version: "1.2.0", available: true },
    ]);
  });

  it("filters RC rows off an RC host when the negative flag is passed, without reading the record", async () => {
    mocks.fetchManifestMock.mockResolvedValue(
      createManifest(["2.0.0-rc.2", "1.2.0"]),
    );
    mocks.readHostInstallRecordMock.mockResolvedValue(
      installRecord("2.0.0-rc.1"),
    );

    const command = buildHostAvailableCommand({ includePreReleases: false });
    const result = await command(fakeCtx());

    expect(result.data).toMatchObject({
      includePreReleases: false,
      includePreReleasesSource: "explicit-exclude",
    });
    expect(parseAvailableSnapshotLikeDesktop(result.data).versions).toEqual([
      { version: "1.2.0", available: true },
    ]);
    // An explicit answer must not depend on a disk read that can fail.
    expect(mocks.readHostInstallRecordMock).not.toHaveBeenCalled();
  });

  it("includes RCs on a stable host when the positive flag is passed", async () => {
    mocks.fetchManifestMock.mockResolvedValue(
      createManifest(["2.0.0-rc.2", "1.2.0"]),
    );
    mocks.readHostInstallRecordMock.mockResolvedValue(installRecord("1.2.0"));

    const command = buildHostAvailableCommand({ includePreReleases: true });
    const result = await command(fakeCtx());

    expect(result.data).toMatchObject({
      includePreReleases: true,
      includePreReleasesSource: "explicit-include",
    });
    expect(mocks.readHostInstallRecordMock).not.toHaveBeenCalled();
  });
});

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
          minimumEpoch: null,
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

// The registry manifest carries an asset per supported platform on every
// version entry, but nothing downstream of this command can use an asset for
// a platform it is not running on - both consumers do a single-key lookup and
// discard the rest. `host available` therefore emits only the running
// platform's asset, which cut the payload 3.2x (70,331 -> 21,689 bytes across
// 31 real versions). This payload is ONE unsplittable JSON line, so its width
// is a standing liability: it is what carried it past the 64 KiB pipe buffer
// (see runner/std-write.ts).
//
// The fixtures above are single-platform, so they cannot observe scoping at
// all - these use a genuinely multi-platform manifest.
const OTHER_PLATFORM_ASSET: HostPlatformAsset = {
  ...AVAILABLE_ASSET,
  url: "https://github.com/traycerai/traycer/releases/download/host-v1.2.0/traycer-host-linux-x64.tar.gz",
  sha256: "b".repeat(64),
  signatureUrl:
    "https://github.com/traycerai/traycer/releases/download/host-v1.2.0/traycer-host-linux-x64.tar.gz.minisig",
};

function createMultiPlatformManifest(
  platforms: Readonly<Record<string, HostPlatformAsset>>,
): HostVersionsManifest {
  return {
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
        minimumEpoch: null,
        platforms,
      },
    ],
  };
}

describe("buildHostAvailableListing platform scoping", () => {
  it("emits only the running platform's asset and drops every other platform", () => {
    const listing = buildHostAvailableListing({
      manifest: createMultiPlatformManifest({
        "darwin-arm64": AVAILABLE_ASSET,
        "linux-x64": OTHER_PLATFORM_ASSET,
        "win32-x64": OTHER_PLATFORM_ASSET,
      }),
      manifestUrl: "https://example.com/versions.json",
      platformKey: "darwin-arm64",
      includePreReleases: false,
      includePreReleasesSource: "explicit-exclude",
      cliVersion: "9.9.9",
    });

    const entry = listing.manifest.versions[0];
    expect(Object.keys(entry.platforms)).toEqual(["darwin-arm64"]);
    // The surviving asset is the real one, not a stub: a projection that
    // dropped the wrong key would still satisfy the key-count assertion.
    expect(entry.platforms["darwin-arm64"]).toEqual(AVAILABLE_ASSET);
  });

  it("keeps a version with no asset for this platform, with an empty platforms map", () => {
    const listing = buildHostAvailableListing({
      manifest: createMultiPlatformManifest({
        "linux-x64": OTHER_PLATFORM_ASSET,
      }),
      manifestUrl: "https://example.com/versions.json",
      platformKey: "darwin-arm64",
      includePreReleases: false,
      includePreReleasesSource: "explicit-exclude",
      cliVersion: "9.9.9",
    });

    // Dropped assets must not drop the VERSION - callers distinguish
    // "exists but not for you" (rendered, tagged no-asset) from "does not
    // exist at all".
    expect(listing.manifest.versions.map((e) => e.version)).toEqual(["1.2.0"]);
    expect(listing.manifest.versions[0].platforms).toEqual({});
    expect(listing.human).toContain("no-asset");
  });

  it("still resolves availability through desktop's parser after scoping", async () => {
    mocks.fetchManifestMock.mockResolvedValue(
      createMultiPlatformManifest({
        "darwin-arm64": AVAILABLE_ASSET,
        "linux-x64": OTHER_PLATFORM_ASSET,
      }),
    );

    const command = buildHostAvailableCommand({ includePreReleases: false });
    const result = await command(fakeCtx());

    // The whole point of the projection is that this is unchanged.
    expect(parseAvailableSnapshotLikeDesktop(result.data)).toEqual({
      latest: "1.2.0",
      versions: [{ version: "1.2.0", available: true }],
    });
  });
});
