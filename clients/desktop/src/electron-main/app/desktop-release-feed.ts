import type { OutgoingHttpHeaders, RequestOptions } from "node:http";
import { posix } from "node:path";
// Value imports intentionally target electron-updater's concrete provider
// module (not the package root) so this file keeps the *real* `Provider` base
// class even in the updater unit tests, which mock the `electron-updater`
// package root. electron-updater ships no `exports` map, so the deep path
// resolves under both `moduleResolution: bundler` and the esbuild main bundle.
import {
  getFileList,
  parseUpdateInfo,
  Provider,
  type ProviderRuntimeOptions,
} from "electron-updater/out/providers/Provider";
import type {
  ResolvedUpdateFileInfo,
  UpdateFileInfo,
  UpdateInfo,
} from "electron-updater/out/types";
import type { LinuxPackageType } from "./linux-update-guidance";

// electron-updater's HTTP executor reads a `redirect` field the node `http`
// `RequestOptions` type doesn't declare; model that augmentation locally rather
// than depend on builder-util-runtime's internal types (not resolvable from
// this workspace's module graph).
type RedirectRequestOptions = RequestOptions & {
  redirect?: "manual" | "follow" | "error";
};

// A single GitHub release asset, reduced to the two fields the desktop feed
// needs: the file name (to match channel manifests / installers) and the
// authenticated `api.github.com/.../releases/assets/<id>` URL used to fetch it
// on private repositories.
export interface DesktopReleaseAsset {
  readonly name: string;
  readonly url: string;
}

// A `desktop-v*` GitHub release that passed RC-only consent and metadata
// validation, with its assets retained so platform compatibility can be
// checked and, on private feeds, resolved through the release-asset API.
export interface DesktopReleaseCandidate {
  readonly tag: string;
  readonly version: string;
  readonly assets: readonly DesktopReleaseAsset[];
}

// electron-updater derives the platform channel manifest name the same way in
// `Provider.getChannelFilePrefix`; we mirror it exactly (including the
// `TEST_UPDATER_ARCH` override it honors) so discovery filters on, and the
// private provider fetches, the identical file the updater will request.
export function platformChannelFile(): string {
  if (process.platform === "linux") {
    const arch = process.env.TEST_UPDATER_ARCH ?? process.arch;
    const archSuffix = arch === "x64" ? "" : `-${arch}`;
    return `latest-linux${archSuffix}.yml`;
  }
  if (process.platform === "darwin") {
    return "latest-mac.yml";
  }
  return "latest.yml";
}

// Lower-cased suffix(es) of the installer artifact the *running* updater can
// actually apply - not merely any installer electron-builder produced. This
// gates discovery on an applicable release: a DMG-only macOS release, or a
// `.deb` release on an `.rpm` host, is treated as incompatible so an older but
// applicable candidate is chosen instead.
//   - macOS: Squirrel.Mac updates from the ZIP; the DMG is install-only.
//   - Windows: the NSIS `.exe`.
//   - Linux: the artifact matching the detected package type - `.deb`/`.rpm`
//     for a package install, else the AppImage.
export function platformInstallerExtensions(
  linuxPackageType: LinuxPackageType | null,
): readonly string[] {
  if (process.platform === "darwin") {
    return [".zip"];
  }
  if (process.platform === "linux") {
    if (linuxPackageType === "deb") {
      return [".deb"];
    }
    if (linuxPackageType === "rpm") {
      return [".rpm"];
    }
    return [".appimage"];
  }
  return [".exe"];
}

// Projects a raw GitHub release into a desktop candidate, enforcing RC-only
// consent: only stable `desktop-vX.Y.Z` and the exact `desktop-vX.Y.Z-rc.N`
// form are accepted (alpha/beta/nightly/other prereleases are rejected), the
// GitHub `prerelease` flag must agree with the tag form, and drafts are
// dropped. Returns `[]` for anything that fails so it composes with `flatMap`.
//
// Each numeric identifier is strict SemVer: `0` or a non-zero-leading run of
// digits (`0|[1-9]\d*`). This rejects malformed tags like `desktop-v01.2.3` or
// `desktop-v1.2.3-rc.01` that a lenient `\d+` would smuggle through - a
// leading-zero identifier is not a valid SemVer version and must not select a
// feed.
export function projectDesktopRelease(
  value: unknown,
): DesktopReleaseCandidate[] {
  if (!isRecord(value) || value.draft === true) {
    return [];
  }
  if (
    typeof value.tag_name !== "string" ||
    typeof value.prerelease !== "boolean"
  ) {
    return [];
  }
  const match =
    /^desktop-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.(?:0|[1-9]\d*))?)$/.exec(
      value.tag_name,
    );
  if (match === null) {
    return [];
  }
  const version = match[1];
  const isReleaseCandidate = version.includes("-rc.");
  // Reject inconsistent metadata rather than trusting the tag: a stable tag
  // flagged `prerelease`, or an rc tag flagged stable, is a publishing mistake
  // that must not silently ship.
  if (value.prerelease !== isReleaseCandidate) {
    return [];
  }
  return [
    { tag: value.tag_name, version, assets: readReleaseAssets(value.assets) },
  ];
}

// A candidate is only usable on this machine when it carries both the
// platform's channel manifest and the applicable installer artifact for the
// running updater (see `platformInstallerExtensions`); otherwise selecting it
// would 404 or fail to apply, masking an older usable candidate.
export function isPlatformCompatibleRelease(
  candidate: DesktopReleaseCandidate,
  linuxPackageType: LinuxPackageType | null,
): boolean {
  const channelFile = platformChannelFile();
  const hasManifest = candidate.assets.some(
    (asset) => asset.name === channelFile,
  );
  if (!hasManifest) {
    return false;
  }
  const installerExtensions = platformInstallerExtensions(linuxPackageType);
  return candidate.assets.some((asset) => {
    const name = asset.name.toLowerCase();
    return installerExtensions.some((extension) => name.endsWith(extension));
  });
}

// Outcome of validating a fetched channel manifest against the release it was
// drawn from. `reason` is a log-only diagnostic; it is never surfaced to the
// user (the updater sanitizes all update failures).
export type DesktopReleaseManifestValidation =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

// Deep, network-informed compatibility check run during discovery: the cheap
// `isPlatformCompatibleRelease` gate only proves the manifest/installer *assets
// exist by name*, but the manifest itself can still be broken, describe a
// different version than its tag, reference an installer that isn't published,
// omit a checksum, or require a newer OS. electron-updater only discovers those
// once it parses the manifest at check/download time - by which point discovery
// has already committed the feed and cannot fall back. This mirrors the checks
// electron-updater performs (`parseUpdateInfo`, `getFileList`'s checksum
// requirement, `checkIfUpdateSupported`'s `minimumSystemVersion` gate,
// `MacUpdater.filterFilesForArch`'s architecture filter) so an unusable
// candidate is rejected up front and discovery falls back to an older applicable
// release (cold-review finding 4).
//
// Architecture applicability is enforced exactly where electron-updater enforces
// it: on macOS via `MacUpdater.filterFilesForArch` (an x64 Mac drops every
// arm64 ZIP; an arm64 Mac - including Rosetta - keeps only arm64 ZIPs when any
// exist, else a non-arm64/universal ZIP) followed by its requirement that a ZIP
// survive, and on Linux via the arch-specific channel-manifest name
// (`platformChannelFile`) plus the detected package type. Windows carries no
// hard arch filter in electron-updater (`findFile` prefers a `process.arch`
// match but falls back), so neither do we. `isArm64Mac` is resolved by the
// caller consistently with `MacUpdater` and passed in so this stays pure.
export function validateDesktopReleaseManifest(
  rawManifest: string,
  channelFile: string,
  manifestUrl: string,
  candidate: DesktopReleaseCandidate,
  linuxPackageType: LinuxPackageType | null,
  currentOsRelease: string,
  isArm64Mac: boolean,
): DesktopReleaseManifestValidation {
  const updateInfo = parseManifest(rawManifest, channelFile, manifestUrl);
  if (updateInfo === null) {
    return {
      ok: false,
      reason: `channel manifest ${channelFile} could not be parsed`,
    };
  }
  const version = readManifestString(updateInfo, "version");
  if (version === null) {
    return {
      ok: false,
      reason: `channel manifest ${channelFile} carries no version`,
    };
  }
  // Tag/version agreement: the release is pinned by its `desktop-v*` tag, but
  // electron-updater installs whatever the manifest names. A mismatch is a
  // publishing error - refuse it rather than install a version discovery never
  // vetted for RC-only consent.
  if (version !== candidate.version) {
    return {
      ok: false,
      reason: `channel manifest version ${version} disagrees with release tag ${candidate.tag}`,
    };
  }
  if (
    !isOsVersionSupported(
      readManifestString(updateInfo, "minimumSystemVersion"),
      currentOsRelease,
    )
  ) {
    return {
      ok: false,
      reason: `release requires a newer OS than ${currentOsRelease}`,
    };
  }
  const files = readManifestFiles(updateInfo);
  if (files === null || files.length === 0) {
    return {
      ok: false,
      reason: `channel manifest ${channelFile} lists no update files`,
    };
  }
  const assetNames = new Set(candidate.assets.map((asset) => asset.name));
  const fileNames: string[] = [];
  for (const file of files) {
    const fileName = manifestFileName(file);
    if (fileName === null) {
      return {
        ok: false,
        reason: `channel manifest ${channelFile} references a file with no name`,
      };
    }
    // Mirror electron-updater's `resolveFiles`, which throws
    // ERR_UPDATER_NO_CHECKSUM for any referenced file lacking sha512/sha2.
    if (!hasManifestChecksum(file)) {
      return {
        ok: false,
        reason: `referenced file ${fileName} is missing a checksum`,
      };
    }
    // Every referenced file must actually be a published release asset, or the
    // download 404s. The generic (public) provider resolves file URLs relative
    // to the release download base and the custom (private) provider looks each
    // file up in the asset set, so a referenced-but-unpublished file is fatal
    // for both.
    if (!assetNames.has(fileName)) {
      return {
        ok: false,
        reason: `referenced file ${fileName} is not among the published release assets`,
      };
    }
    fileNames.push(fileName);
  }
  if (!releaseHasApplicableInstaller(fileNames, linuxPackageType, isArm64Mac)) {
    return {
      ok: false,
      reason: `channel manifest ${channelFile} references no installer this platform/architecture can apply`,
    };
  }
  return { ok: true };
}

// Mirrors `electron-updater@6.8.9`'s `MacUpdater.filterFilesForArch`: on an
// arm64 Mac (including Rosetta) arm64 files are preferred when any exist,
// otherwise every arm64 file is dropped (an x64 Mac can't run an arm64 build).
// Case-sensitive `arm64` match, matching MacUpdater's own substring test.
export function filterMacFilesForArch(
  fileNames: readonly string[],
  isArm64Mac: boolean,
): string[] {
  const isArm64File = (name: string) => name.includes("arm64");
  if (isArm64Mac && fileNames.some(isArm64File)) {
    return fileNames.filter(isArm64File);
  }
  return fileNames.filter((name) => !isArm64File(name));
}

// Whether the running updater could actually apply one of the manifest's
// referenced files. On macOS this replays `MacUpdater`'s pipeline - filter the
// files by architecture, then require a ZIP to survive (it throws
// ERR_UPDATER_ZIP_FILE_NOT_FOUND otherwise) - so an arm64-only release is
// rejected on an x64 Mac and discovery falls back. On other platforms the
// applicable installer extension(s) alone decide.
function releaseHasApplicableInstaller(
  fileNames: readonly string[],
  linuxPackageType: LinuxPackageType | null,
  isArm64Mac: boolean,
): boolean {
  if (process.platform === "darwin") {
    return filterMacFilesForArch(fileNames, isArm64Mac).some((name) =>
      name.toLowerCase().endsWith(".zip"),
    );
  }
  const installerExtensions = platformInstallerExtensions(linuxPackageType);
  return fileNames.some((name) => {
    const lowerName = name.toLowerCase();
    return installerExtensions.some((extension) =>
      lowerName.endsWith(extension),
    );
  });
}

export function readReleaseAssets(value: unknown): DesktopReleaseAsset[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    if (typeof entry.name !== "string" || typeof entry.url !== "string") {
      return [];
    }
    return [{ name: entry.name, url: entry.url }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Parses a channel manifest with electron-updater's own `parseUpdateInfo` (the
// same YAML load path it uses at check time), returning null on any parse
// failure so discovery can fall back rather than throw. This is the sole
// boundary where a manifest's malformed bytes are handled; every other consumer
// works off the validated result.
function parseManifest(
  rawManifest: string,
  channelFile: string,
  manifestUrl: string,
): UpdateInfo | null {
  try {
    return parseUpdateInfo(rawManifest, channelFile, new URL(manifestUrl));
  } catch {
    return null;
  }
}

// Reads `updateInfo.files` via electron-updater's `getFileList` (which also
// honors the legacy top-level `path`/`sha512` shape), returning null when the
// manifest carries no resolvable files instead of throwing.
function readManifestFiles(updateInfo: UpdateInfo): UpdateFileInfo[] | null {
  try {
    return getFileList(updateInfo);
  } catch {
    return null;
  }
}

function readManifestString(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

// The manifest names each file by a repo-relative path/filename; the published
// GitHub asset is its basename with spaces normalized to `-` (mirrors the
// custom provider's `resolveFiles`).
function manifestFileName(file: unknown): string | null {
  if (!isRecord(file)) {
    return null;
  }
  const url = file.url;
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }
  return posix.basename(url).replace(/ /g, "-");
}

function hasManifestChecksum(file: unknown): boolean {
  if (!isRecord(file)) {
    return false;
  }
  const sha512 = file.sha512;
  const sha2 = file.sha2;
  return (
    (typeof sha512 === "string" && sha512.length > 0) ||
    (typeof sha2 === "string" && sha2.length > 0)
  );
}

// Mirrors electron-updater's `checkIfUpdateSupported`: block a release only when
// we can positively determine the running OS is older than its
// `minimumSystemVersion`. An absent minimum, or a version pair we can't compare,
// fails open (electron-updater catches the compare error and treats it as
// supported), so this never invents an OS gate electron-updater would not apply.
function isOsVersionSupported(
  minimumSystemVersion: string | null,
  currentOsRelease: string,
): boolean {
  if (minimumSystemVersion === null) {
    return true;
  }
  const comparison = compareNumericVersion(
    currentOsRelease,
    minimumSystemVersion,
  );
  return comparison === null || comparison >= 0;
}

// Compares the leading `major.minor.patch` triplet of two OS/kernel version
// strings (e.g. macOS `23.5.0`, Windows `10.0.22631`). Returns null when either
// side has no parseable triplet so the caller can fail open.
function compareNumericVersion(a: string, b: string): number | null {
  const pa = parseNumericTriplet(a);
  const pb = parseNumericTriplet(b);
  if (pa === null || pb === null) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (pa[index] !== pb[index]) {
      return pa[index] > pb[index] ? 1 : -1;
    }
  }
  return 0;
}

function parseNumericTriplet(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// The `provider: "custom"` config electron-updater's `createClient` routes to
// `ExactReleaseAssetProvider`. Modelled locally (rather than importing
// builder-util-runtime's `CustomPublishOptions`, unresolvable from this
// workspace) - it structurally satisfies that type via its index signature.
export interface ExactReleaseFeedConfig {
  readonly provider: "custom";
  readonly updateProvider: new (
    options: ExactReleaseFeedConfig,
    updater: unknown,
    runtimeOptions: ProviderRuntimeOptions,
  ) => ExactReleaseAssetProvider;
  readonly assets: readonly DesktopReleaseAsset[];
  readonly token: string;
}

// A resolved desktop feed: the generic exact-release provider for public repos,
// or the custom authenticated provider for private/staging repos.
export type DesktopUpdateFeed =
  | { readonly provider: "generic"; readonly url: string }
  | ExactReleaseFeedConfig;

// Builds the feed for a pinned desktop release. Public repos use the generic
// exact-release provider - the `releases/download/<tag>/` browser URLs are
// unauthenticated and resolve the channel manifest + installers by name.
// Private/staging repos (token set) can't use those browser URLs (they need a
// session cookie, not a token header), so they route through the authenticated
// release-asset API via the custom provider.
export function buildDesktopReleaseFeed(
  owner: string,
  repo: string,
  release: DesktopReleaseCandidate,
  token: string,
): DesktopUpdateFeed {
  if (token.length === 0) {
    return {
      provider: "generic",
      url: `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(release.tag)}/`,
    };
  }
  return privateExactReleaseFeed(release.assets, token);
}

// The URL + headers used to fetch a candidate's channel manifest during
// discovery-time validation, mirroring `buildDesktopReleaseFeed`'s public/private
// split: public repos read the unauthenticated `releases/download/<tag>/`
// browser URL, private repos read the manifest asset's authenticated
// `api.github.com/.../releases/assets/<id>` URL with `application/octet-stream`.
// Returns null on a private feed whose manifest asset isn't published (nothing
// to fetch → the candidate is unusable and discovery falls back).
export function resolveDesktopManifestRequest(
  owner: string,
  repo: string,
  release: DesktopReleaseCandidate,
  token: string,
): { readonly url: string; readonly headers: Record<string, string> } | null {
  const channelFile = platformChannelFile();
  if (token.length === 0) {
    return {
      url: `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(release.tag)}/${channelFile}`,
      headers: { accept: "application/octet-stream" },
    };
  }
  const asset = release.assets.find((it) => it.name === channelFile);
  if (asset === undefined) {
    return null;
  }
  return {
    url: asset.url,
    headers: {
      accept: "application/octet-stream",
      authorization: `token ${token}`,
    },
  };
}

function privateExactReleaseFeed(
  assets: readonly DesktopReleaseAsset[],
  token: string,
): ExactReleaseFeedConfig {
  return {
    provider: "custom",
    updateProvider: ExactReleaseAssetProvider,
    assets,
    token,
  };
}

// Authenticated exact-release provider for private/staging desktop feeds. Unlike
// electron-updater's built-in `PrivateGitHubProvider` (which always resolves the
// *latest* release and so can't be trusted in a repo that also ships
// `host-v*`/`cli-v*` prereleases), this provider is pinned to a specific
// desktop release's asset set and resolves both the channel manifest and every
// installer through their `api.github.com/.../releases/assets/<id>` URLs, which
// is GitHub's supported authenticated download path.
export class ExactReleaseAssetProvider extends Provider<UpdateInfo> {
  private readonly assets: readonly DesktopReleaseAsset[];
  private readonly token: string;

  constructor(
    options: ExactReleaseFeedConfig,
    _updater: unknown,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super(runtimeOptions);
    this.assets = options.assets;
    this.token = options.token;
  }

  // GitHub's asset API 302-redirects to a signed object-store URL; mirror
  // `PrivateGitHubProvider` and redirect manually so the executor drops the
  // `authorization` header on the cross-origin hop (it would otherwise leak the
  // token to, or be rejected by, the object store).
  protected createRequestOptions(
    url: URL,
    headers: OutgoingHttpHeaders | null | undefined,
  ): RequestOptions {
    const result: RedirectRequestOptions = super.createRequestOptions(
      url,
      headers,
    );
    result.redirect = "manual";
    return result;
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    const channelFile = platformChannelFile();
    const asset = this.assets.find((it) => it.name === channelFile);
    if (asset === undefined) {
      throw new Error(
        `Update manifest "${channelFile}" is not among the desktop release assets`,
      );
    }
    const url = new URL(asset.url);
    const raw = await this.httpRequest(
      url,
      this.assetHeaders("application/octet-stream"),
    );
    return parseUpdateInfo(raw, channelFile, url);
  }

  get fileExtraDownloadHeaders(): OutgoingHttpHeaders {
    return this.assetHeaders("application/octet-stream");
  }

  resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    return getFileList(updateInfo).map((file) => {
      const name = posix.basename(file.url).replace(/ /g, "-");
      const asset = this.assets.find((it) => it.name === name);
      if (asset === undefined) {
        throw new Error(
          `Installer asset "${name}" is not among the desktop release assets`,
        );
      }
      return { url: new URL(asset.url), info: file };
    });
  }

  private assetHeaders(accept: string): OutgoingHttpHeaders {
    return { accept, authorization: `token ${this.token}` };
  }
}
