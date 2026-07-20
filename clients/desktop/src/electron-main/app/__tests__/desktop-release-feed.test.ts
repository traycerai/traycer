import type { RequestOptions } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import type { UpdateInfo } from "electron-updater/out/types";
import {
  buildDesktopReleaseFeed,
  ExactReleaseAssetProvider,
  filterMacFilesForArch,
  isPlatformCompatibleRelease,
  platformChannelFile,
  projectDesktopRelease,
  validateDesktopReleaseManifest,
  type DesktopReleaseAsset,
  type DesktopReleaseCandidate,
} from "../desktop-release-feed";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);
const originalArch = process.env.TEST_UPDATER_ARCH;

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { configurable: true, value });
}

beforeEach(() => {
  setPlatform("darwin");
});

afterEach(() => {
  if (originalPlatformDescriptor !== undefined) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  if (originalArch === undefined) {
    Reflect.deleteProperty(process.env, "TEST_UPDATER_ARCH");
  } else {
    process.env.TEST_UPDATER_ARCH = originalArch;
  }
});

// A GitHub release payload carrying the macOS channel manifest + the ZIP the
// updater actually applies (plus the install-only DMG) - the shape
// `projectDesktopRelease` reads directly off a `GET /releases` response entry.
function macReleaseAsset(tag: string): readonly DesktopReleaseAsset[] {
  const version = tag.replace(/^desktop-v/, "");
  return [
    {
      name: "latest-mac.yml",
      url: `https://api.github.com/repos/traycerai/traycer/releases/assets/${tag}-manifest`,
    },
    {
      name: `Traycer-${version}-mac.zip`,
      url: `https://api.github.com/repos/traycerai/traycer/releases/assets/${tag}-zip`,
    },
    {
      name: `Traycer-${version}-mac.dmg`,
      url: `https://api.github.com/repos/traycerai/traycer/releases/assets/${tag}-dmg`,
    },
  ];
}

function releasePayload(
  tagName: unknown,
  draft: unknown,
  prerelease: unknown,
  assets: unknown,
): Record<string, unknown> {
  return { tag_name: tagName, draft, prerelease, assets };
}

describe("projectDesktopRelease", () => {
  it("accepts a stable desktop release and retains its assets", () => {
    const assets = macReleaseAsset("desktop-v1.4.0");
    const result = projectDesktopRelease(
      releasePayload("desktop-v1.4.0", false, false, assets),
    );

    expect(result).toEqual([
      { tag: "desktop-v1.4.0", version: "1.4.0", assets },
    ]);
  });

  it("accepts an exact rc.N desktop release", () => {
    const assets = macReleaseAsset("desktop-v1.4.0-rc.2");
    const result = projectDesktopRelease(
      releasePayload("desktop-v1.4.0-rc.2", false, true, assets),
    );

    expect(result).toEqual([
      { tag: "desktop-v1.4.0-rc.2", version: "1.4.0-rc.2", assets },
    ]);
  });

  it.each([
    "desktop-v2.0.0-alpha.1",
    "desktop-v2.0.0-beta.1",
    "desktop-v2.0.0-nightly.1",
  ])("rejects a non-rc prerelease tag form: %s", (tag) => {
    const result = projectDesktopRelease(
      releasePayload(tag, false, true, macReleaseAsset(tag)),
    );

    expect(result).toEqual([]);
  });

  it("rejects a non-desktop tag", () => {
    const result = projectDesktopRelease(
      releasePayload(
        "host-v1.4.0",
        false,
        false,
        macReleaseAsset("host-v1.4.0"),
      ),
    );

    expect(result).toEqual([]);
  });

  it("rejects a draft release", () => {
    const result = projectDesktopRelease(
      releasePayload(
        "desktop-v1.4.0",
        true,
        false,
        macReleaseAsset("desktop-v1.4.0"),
      ),
    );

    expect(result).toEqual([]);
  });

  it("rejects a release with a missing prerelease field", () => {
    const result = projectDesktopRelease({
      tag_name: "desktop-v1.4.0",
      draft: false,
      assets: macReleaseAsset("desktop-v1.4.0"),
    });

    expect(result).toEqual([]);
  });

  it("rejects a release with a non-boolean prerelease field", () => {
    const result = projectDesktopRelease(
      releasePayload(
        "desktop-v1.4.0",
        false,
        "true",
        macReleaseAsset("desktop-v1.4.0"),
      ),
    );

    expect(result).toEqual([]);
  });

  it("rejects a stable tag flagged prerelease by GitHub", () => {
    const result = projectDesktopRelease(
      releasePayload(
        "desktop-v1.4.0",
        false,
        true,
        macReleaseAsset("desktop-v1.4.0"),
      ),
    );

    expect(result).toEqual([]);
  });

  it("rejects an rc tag flagged stable by GitHub", () => {
    const result = projectDesktopRelease(
      releasePayload(
        "desktop-v1.4.0-rc.2",
        false,
        false,
        macReleaseAsset("desktop-v1.4.0-rc.2"),
      ),
    );

    expect(result).toEqual([]);
  });

  // Strict SemVer: numeric identifiers must not carry leading zeros, so a
  // lenient `\d+` tag like `01.2.3` or `rc.01` is not a valid version and must
  // never select a feed.
  it.each<[string, boolean]>([
    ["desktop-v01.2.3", false],
    ["desktop-v1.02.3", false],
    ["desktop-v1.2.03", false],
    ["desktop-v1.2.3-rc.01", true],
  ])("rejects a leading-zero numeric identifier: %s", (tag, prerelease) => {
    const result = projectDesktopRelease(
      releasePayload(tag, false, prerelease, macReleaseAsset(tag)),
    );

    expect(result).toEqual([]);
  });

  it("accepts rc.0 (a valid zero identifier)", () => {
    const assets = macReleaseAsset("desktop-v1.2.3-rc.0");
    const result = projectDesktopRelease(
      releasePayload("desktop-v1.2.3-rc.0", false, true, assets),
    );

    expect(result).toEqual([
      { tag: "desktop-v1.2.3-rc.0", version: "1.2.3-rc.0", assets },
    ]);
  });

  it("accepts a multi-digit rc identifier", () => {
    const assets = macReleaseAsset("desktop-v1.2.3-rc.10");
    const result = projectDesktopRelease(
      releasePayload("desktop-v1.2.3-rc.10", false, true, assets),
    );

    expect(result).toEqual([
      { tag: "desktop-v1.2.3-rc.10", version: "1.2.3-rc.10", assets },
    ]);
  });
});

describe("isPlatformCompatibleRelease", () => {
  const candidate = (
    assets: readonly DesktopReleaseAsset[],
  ): DesktopReleaseCandidate => ({
    tag: "desktop-v1.4.0",
    version: "1.4.0",
    assets,
  });

  it("is true when both the platform manifest and the ZIP are present (darwin)", () => {
    expect(
      isPlatformCompatibleRelease(
        candidate(macReleaseAsset("desktop-v1.4.0")),
        null,
      ),
    ).toBe(true);
  });

  it("is false when the platform manifest is missing", () => {
    const assets = macReleaseAsset("desktop-v1.4.0").filter(
      (asset) => asset.name !== "latest-mac.yml",
    );
    expect(isPlatformCompatibleRelease(candidate(assets), null)).toBe(false);
  });

  it("is false on macOS when only the install-only DMG is present (no updatable ZIP)", () => {
    const assets = macReleaseAsset("desktop-v1.4.0").filter(
      (asset) => !asset.name.endsWith(".zip"),
    );
    expect(isPlatformCompatibleRelease(candidate(assets), null)).toBe(false);
  });

  it("is true on win32 with a windows manifest + installer", () => {
    setPlatform("win32");
    const assets: readonly DesktopReleaseAsset[] = [
      { name: "latest.yml", url: "https://api.github.com/x/manifest" },
      { name: "Traycer-Setup-1.4.0.exe", url: "https://api.github.com/x/exe" },
    ];
    expect(isPlatformCompatibleRelease(candidate(assets), null)).toBe(true);
  });

  it("is false on win32 when only mac assets are present", () => {
    setPlatform("win32");
    expect(
      isPlatformCompatibleRelease(
        candidate(macReleaseAsset("desktop-v1.4.0")),
        null,
      ),
    ).toBe(false);
  });

  it("is true on linux AppImage (no package type) with a linux manifest + AppImage", () => {
    setPlatform("linux");
    process.env.TEST_UPDATER_ARCH = "x64";
    const assets: readonly DesktopReleaseAsset[] = [
      { name: "latest-linux.yml", url: "https://api.github.com/x/manifest" },
      {
        name: "traycer-1.4.0.appimage",
        url: "https://api.github.com/x/appimage",
      },
    ];
    expect(isPlatformCompatibleRelease(candidate(assets), null)).toBe(true);
  });

  it("requires the detected linux package type: a .rpm-only release is incompatible on a .deb host", () => {
    setPlatform("linux");
    process.env.TEST_UPDATER_ARCH = "x64";
    const rpmOnly: readonly DesktopReleaseAsset[] = [
      { name: "latest-linux.yml", url: "https://api.github.com/x/manifest" },
      { name: "traycer-1.4.0.rpm", url: "https://api.github.com/x/rpm" },
    ];
    expect(isPlatformCompatibleRelease(candidate(rpmOnly), "deb")).toBe(false);
    expect(isPlatformCompatibleRelease(candidate(rpmOnly), "rpm")).toBe(true);
  });
});

describe("validateDesktopReleaseManifest", () => {
  const manifestCandidate: DesktopReleaseCandidate = {
    tag: "desktop-v1.4.0",
    version: "1.4.0",
    assets: macReleaseAsset("desktop-v1.4.0"),
  };
  const manifestUrl =
    "https://github.com/traycerai/traycer/releases/download/desktop-v1.4.0/latest-mac.yml";
  const validManifest = [
    "version: 1.4.0",
    "files:",
    "  - url: Traycer-1.4.0-mac.zip",
    "    sha512: aGVsbG8=",
    "    size: 1024",
    "path: Traycer-1.4.0-mac.zip",
    "sha512: aGVsbG8=",
    "releaseDate: '2026-01-01T00:00:00.000Z'",
  ].join("\n");

  it("rejects an unparseable manifest", () => {
    const result = validateDesktopReleaseManifest(
      "version: 1.0.0\nfiles: [1, 2",
      "latest-mac.yml",
      manifestUrl,
      manifestCandidate,
      null,
      "23.5.0",
      false,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects when the manifest version disagrees with the release tag", () => {
    const manifest = validManifest.replace("version: 1.4.0", "version: 1.5.0");

    const result = validateDesktopReleaseManifest(
      manifest,
      "latest-mac.yml",
      manifestUrl,
      manifestCandidate,
      null,
      "23.5.0",
      false,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects when a referenced file is missing from the release assets", () => {
    const manifest = [
      "version: 1.4.0",
      "files:",
      "  - url: Traycer-1.4.0-mac-missing.zip",
      "    sha512: aGVsbG8=",
      "path: Traycer-1.4.0-mac-missing.zip",
      "sha512: aGVsbG8=",
    ].join("\n");

    const result = validateDesktopReleaseManifest(
      manifest,
      "latest-mac.yml",
      manifestUrl,
      manifestCandidate,
      null,
      "23.5.0",
      false,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects when a referenced file is missing a checksum", () => {
    const manifest = [
      "version: 1.4.0",
      "files:",
      "  - url: Traycer-1.4.0-mac.zip",
      "    size: 1024",
      "path: Traycer-1.4.0-mac.zip",
    ].join("\n");

    const result = validateDesktopReleaseManifest(
      manifest,
      "latest-mac.yml",
      manifestUrl,
      manifestCandidate,
      null,
      "23.5.0",
      false,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects when no referenced file matches the applicable installer extension", () => {
    const manifest = [
      "version: 1.4.0",
      "files:",
      "  - url: Traycer-1.4.0-mac.dmg",
      "    sha512: aGVsbG8=",
      "path: Traycer-1.4.0-mac.dmg",
      "sha512: aGVsbG8=",
    ].join("\n");

    const result = validateDesktopReleaseManifest(
      manifest,
      "latest-mac.yml",
      manifestUrl,
      manifestCandidate,
      null,
      "23.5.0",
      false,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a minimumSystemVersion above the running OS", () => {
    const manifest = `${validManifest}\nminimumSystemVersion: 999.0.0`;

    const result = validateDesktopReleaseManifest(
      manifest,
      "latest-mac.yml",
      manifestUrl,
      manifestCandidate,
      null,
      "23.5.0",
      false,
    );

    expect(result.ok).toBe(false);
  });

  it("accepts when minimumSystemVersion is absent", () => {
    const result = validateDesktopReleaseManifest(
      validManifest,
      "latest-mac.yml",
      manifestUrl,
      manifestCandidate,
      null,
      "23.5.0",
      false,
    );

    expect(result).toEqual({ ok: true });
  });

  it("accepts when minimumSystemVersion is at or below the running OS", () => {
    const manifest = `${validManifest}\nminimumSystemVersion: 10.0.0`;

    const result = validateDesktopReleaseManifest(
      manifest,
      "latest-mac.yml",
      manifestUrl,
      manifestCandidate,
      null,
      "23.5.0",
      false,
    );

    expect(result).toEqual({ ok: true });
  });

  it("accepts a fully valid manifest", () => {
    const result = validateDesktopReleaseManifest(
      validManifest,
      "latest-mac.yml",
      manifestUrl,
      manifestCandidate,
      null,
      "23.5.0",
      false,
    );

    expect(result).toEqual({ ok: true });
  });
});

describe("validateDesktopReleaseManifest macOS architecture filtering", () => {
  const manifestUrl =
    "https://github.com/traycerai/traycer/releases/download/desktop-v1.5.0/latest-mac.yml";
  const arm64ZipName = "Traycer-1.5.0-arm64-mac.zip";
  const x64ZipName = "Traycer-1.5.0-mac.zip";
  const manifestAsset: DesktopReleaseAsset = {
    name: "latest-mac.yml",
    url: "https://api.github.com/repos/traycerai/traycer/releases/assets/desktop-v1.5.0-manifest",
  };
  const arm64ZipAsset: DesktopReleaseAsset = {
    name: arm64ZipName,
    url: "https://api.github.com/repos/traycerai/traycer/releases/assets/desktop-v1.5.0-arm64-zip",
  };
  const x64ZipAsset: DesktopReleaseAsset = {
    name: x64ZipName,
    url: "https://api.github.com/repos/traycerai/traycer/releases/assets/desktop-v1.5.0-zip",
  };

  function manifestFor(zipNames: readonly string[]): string {
    return [
      "version: 1.5.0",
      "files:",
      ...zipNames.flatMap((name) => [
        `  - url: ${name}`,
        "    sha512: aGVsbG8=",
        "    size: 1024",
      ]),
      `path: ${zipNames[0]}`,
      "sha512: aGVsbG8=",
      "releaseDate: '2026-01-01T00:00:00.000Z'",
    ].join("\n");
  }

  function candidateFor(
    assets: readonly DesktopReleaseAsset[],
  ): DesktopReleaseCandidate {
    return { tag: "desktop-v1.5.0", version: "1.5.0", assets };
  }

  it("rejects an arm64-only ZIP on an x64 Mac", () => {
    const result = validateDesktopReleaseManifest(
      manifestFor([arm64ZipName]),
      "latest-mac.yml",
      manifestUrl,
      candidateFor([manifestAsset, arm64ZipAsset]),
      null,
      "23.5.0",
      false,
    );

    expect(result.ok).toBe(false);
  });

  it("accepts the x64 ZIP on an x64 Mac when both architectures are published", () => {
    const result = validateDesktopReleaseManifest(
      manifestFor([arm64ZipName, x64ZipName]),
      "latest-mac.yml",
      manifestUrl,
      candidateFor([manifestAsset, arm64ZipAsset, x64ZipAsset]),
      null,
      "23.5.0",
      false,
    );

    expect(result).toEqual({ ok: true });
  });

  it("prefers (and accepts) the arm64 ZIP on an arm64 Mac", () => {
    const result = validateDesktopReleaseManifest(
      manifestFor([arm64ZipName, x64ZipName]),
      "latest-mac.yml",
      manifestUrl,
      candidateFor([manifestAsset, arm64ZipAsset, x64ZipAsset]),
      null,
      "23.5.0",
      true,
    );

    expect(result).toEqual({ ok: true });
  });

  it("accepts a non-arm64 ZIP on an arm64 Mac when no arm64 ZIP is published", () => {
    const result = validateDesktopReleaseManifest(
      manifestFor([x64ZipName]),
      "latest-mac.yml",
      manifestUrl,
      candidateFor([manifestAsset, x64ZipAsset]),
      null,
      "23.5.0",
      true,
    );

    expect(result).toEqual({ ok: true });
  });
});

describe("filterMacFilesForArch", () => {
  const arm64Zip = "Traycer-1.5.0-arm64-mac.zip";
  const x64Zip = "Traycer-1.5.0-mac.zip";

  it("drops arm64 files on an x64 Mac", () => {
    expect(filterMacFilesForArch([arm64Zip, x64Zip], false)).toEqual([x64Zip]);
  });

  it("keeps only arm64 files on an arm64 Mac when any are published", () => {
    expect(filterMacFilesForArch([arm64Zip, x64Zip], true)).toEqual([arm64Zip]);
  });

  it("keeps non-arm64 files on an arm64 Mac when none are arm64", () => {
    expect(filterMacFilesForArch([x64Zip], true)).toEqual([x64Zip]);
  });
});

describe("platformChannelFile", () => {
  it("resolves latest-mac.yml on darwin", () => {
    setPlatform("darwin");
    expect(platformChannelFile()).toBe("latest-mac.yml");
  });

  it("resolves latest.yml on win32", () => {
    setPlatform("win32");
    expect(platformChannelFile()).toBe("latest.yml");
  });

  it("resolves latest-linux.yml on linux x64", () => {
    setPlatform("linux");
    process.env.TEST_UPDATER_ARCH = "x64";
    expect(platformChannelFile()).toBe("latest-linux.yml");
  });

  it("resolves latest-linux-arm64.yml on linux arm64", () => {
    setPlatform("linux");
    process.env.TEST_UPDATER_ARCH = "arm64";
    expect(platformChannelFile()).toBe("latest-linux-arm64.yml");
  });
});

describe("buildDesktopReleaseFeed", () => {
  const release: DesktopReleaseCandidate = {
    tag: "desktop-v1.4.0-rc.2",
    version: "1.4.0-rc.2",
    assets: macReleaseAsset("desktop-v1.4.0-rc.2"),
  };

  it("builds a generic exact-release URL when no token is configured", () => {
    const feed = buildDesktopReleaseFeed("traycerai", "traycer", release, "");

    expect(feed).toEqual({
      provider: "generic",
      url: `https://github.com/traycerai/traycer/releases/download/${encodeURIComponent(release.tag)}/`,
    });
  });

  it("builds the authenticated custom provider config when a token is configured", () => {
    const feed = buildDesktopReleaseFeed(
      "traycerai",
      "private-traycer",
      release,
      "secret-token",
    );

    expect(feed).toEqual({
      provider: "custom",
      updateProvider: ExactReleaseAssetProvider,
      assets: release.assets,
      token: "secret-token",
    });
  });
});

// Overrides only `request` (the sole method `Provider`/`ExactReleaseAssetProvider`
// call) so tests never touch a real `electron.net` session; every other
// inherited method is left as-is (unused by the code under test).
class FakeHttpExecutor extends ElectronHttpExecutor {
  readonly calls: RequestOptions[] = [];
  response: string | null = null;

  override async request(options: RequestOptions): Promise<string | null> {
    this.calls.push(options);
    return this.response;
  }
}

function buildRuntimeOptions(
  executor: FakeHttpExecutor,
): ProviderRuntimeOptions {
  return {
    isUseMultipleRangeRequest: false,
    platform: "darwin",
    executor,
  };
}

describe("ExactReleaseAssetProvider", () => {
  const manifestAssetUrl =
    "https://api.github.com/repos/traycerai/private-traycer/releases/assets/1001";
  const installerAssetUrl =
    "https://api.github.com/repos/traycerai/private-traycer/releases/assets/1002";
  const manifestYaml = [
    "version: 1.6.0-rc.3",
    "files:",
    "  - url: Traycer-1.6.0-rc.3-mac.zip",
    "    sha512: abcDEF123==",
    "    size: 12345",
    "path: Traycer-1.6.0-rc.3-mac.zip",
    "sha512: abcDEF123==",
    "releaseDate: '2026-07-01T00:00:00.000Z'",
    "",
  ].join("\n");

  function buildProvider(assets: readonly DesktopReleaseAsset[]): {
    readonly executor: FakeHttpExecutor;
    readonly provider: ExactReleaseAssetProvider;
  } {
    const executor = new FakeHttpExecutor();
    const provider = new ExactReleaseAssetProvider(
      {
        provider: "custom",
        updateProvider: ExactReleaseAssetProvider,
        assets,
        token: "secret-token",
      },
      undefined,
      buildRuntimeOptions(executor),
    );
    return { executor, provider };
  }

  it("resolves the platform manifest asset with authenticated, non-following headers", async () => {
    const { executor, provider } = buildProvider([
      { name: "latest-mac.yml", url: manifestAssetUrl },
      { name: "Traycer-1.6.0-rc.3-mac.zip", url: installerAssetUrl },
    ]);
    executor.response = manifestYaml;

    const info = await provider.getLatestVersion();

    expect(info.version).toBe("1.6.0-rc.3");
    expect(executor.calls).toHaveLength(1);
    const [options] = executor.calls;
    expect(options).toMatchObject({
      redirect: "manual",
      headers: {
        accept: "application/octet-stream",
        authorization: "token secret-token",
      },
      hostname: "api.github.com",
    });
    expect(String(options.path)).toContain("/releases/assets/1001");
  });

  it("resolves each manifest file to its matching asset's api URL", async () => {
    const { executor, provider } = buildProvider([
      { name: "latest-mac.yml", url: manifestAssetUrl },
      { name: "Traycer-1.6.0-rc.3-mac.zip", url: installerAssetUrl },
    ]);
    executor.response = manifestYaml;
    const info = await provider.getLatestVersion();

    const files = provider.resolveFiles(info);

    expect(files).toHaveLength(1);
    expect(files[0].url.toString()).toBe(installerAssetUrl);
    expect(files[0].info.url).toBe("Traycer-1.6.0-rc.3-mac.zip");
  });

  it("throws when the platform manifest asset is absent from the release", async () => {
    const { provider } = buildProvider([
      { name: "Traycer-1.6.0-rc.3-mac.zip", url: installerAssetUrl },
    ]);

    await expect(provider.getLatestVersion()).rejects.toThrow(
      /latest-mac\.yml/,
    );
  });

  it("throws when a referenced installer asset is absent from the release", () => {
    const { provider } = buildProvider([
      { name: "latest-mac.yml", url: manifestAssetUrl },
    ]);
    const updateInfo: UpdateInfo = {
      version: "1.6.0-rc.3",
      files: [{ url: "Traycer-1.6.0-rc.3-mac.zip", sha512: "abcDEF123==" }],
      path: "Traycer-1.6.0-rc.3-mac.zip",
      sha512: "abcDEF123==",
      releaseDate: "2026-07-01T00:00:00.000Z",
    };

    expect(() => provider.resolveFiles(updateInfo)).toThrow(
      /Traycer-1\.6\.0-rc\.3-mac\.zip/,
    );
  });
});
