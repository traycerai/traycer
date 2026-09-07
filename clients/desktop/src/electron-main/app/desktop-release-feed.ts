import type { OutgoingHttpHeaders, RequestOptions } from "node:http";
import { posix } from "node:path";
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
import { isValidCompatibilityEpoch } from "@traycer/protocol/framework/index";
import type { LinuxPackageType } from "./linux-update-guidance";
import { isCanonicalReleaseCandidate } from "@traycer-clients/shared/host-version/release-line";

type RedirectRequestOptions = RequestOptions & {
  redirect?: "manual" | "follow" | "error";
};

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

// Projects a raw GitHub release into a desktop candidate, enforcing RC-only consent: only stable `desktop-vX.Y.Z` and the exact `desktop-vX.Y.Z-rc.N` form are accepted.
// This rejects malformed tags like `desktop-v01.2.3` or `desktop-v1.2.3-rc.01` that a lenient `\d+` would smuggle through.
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
  const isReleaseCandidate = isCanonicalReleaseCandidate(version);
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
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

// electron-updater only discovers those once it parses the manifest at check/download time - by which point discovery has already committed the feed and cannot fall back.
// `isArm64Mac` is resolved by the caller consistently with `MacUpdater` and passed in so this stays pure.
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
  // Tag/version agreement: the release is pinned by its `desktop-v*` tag, but electron-updater installs whatever the manifest names.
  // A mismatch is a publishing error - refuse it rather than install a version discovery never vetted for RC-only consent.
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
    // Every referenced file must actually be a published release asset, or the download 404s.
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

/**
 * Two callers with genuinely different shapes in hand.
 * `null` is returned for absent, non-numeric, non-integer, and non-positive alike, and the caller must treat all of them as INSUFFICIENT rather than as "legacy".
 */
export function readCompatibilityEpoch(value: unknown): number | null {
  if (!isRecord(value)) {
    return null;
  }
  const candidate: unknown = value["compatibilityEpoch"];
  return typeof candidate === "number" && isValidCompatibilityEpoch(candidate)
    ? candidate
    : null;
}

/** Going through {@link parseManifest} rather than a local YAML read is the point: the RC probe must see the document exactly as the updater would if the feed were pointed at this. */
export function readManifestCompatibilityEpoch(
  rawManifest: string,
  channelFile: string,
  manifestUrl: string,
): number | null {
  return readCompatibilityEpoch(
    parseManifest(rawManifest, channelFile, manifestUrl),
  );
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

// An absent minimum, or a version pair we can't compare, fails open (electron-updater catches the compare error and treats it as supported), so this never invents an OS gate.
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

export interface ExactReleaseFeedConfig {
  readonly provider: "custom";
  readonly updateProvider: new (
    options: ExactReleaseFeedConfig,
    updater: unknown,
    runtimeOptions: ProviderRuntimeOptions,
  ) => ExactReleaseAssetProvider;
  readonly assets: readonly DesktopReleaseAsset[];
  readonly token: string;
  // Needed to resolve the PREVIOUS release's assets when the differential
  // downloader asks for its blockmap; the pinned `assets` above describe the
  // new release alone. See `ExactReleaseAssetProvider.getBlockMapFiles`.
  readonly owner: string;
  readonly repo: string;
}

/** One definition of the convention, so the blockmap lookup below cannot drift from it. */
export function desktopReleaseTag(version: string): string {
  return `desktop-v${version}`;
}

// A resolved desktop feed: the generic exact-release provider for public repos,
// or the custom authenticated provider for private/staging repos.
export type DesktopUpdateFeed =
  | { readonly provider: "generic"; readonly url: string }
  | ExactReleaseFeedConfig;

// Builds the feed for a pinned desktop release.
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
  return privateExactReleaseFeed(release.assets, token, owner, repo);
}

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
  owner: string,
  repo: string,
): ExactReleaseFeedConfig {
  return {
    provider: "custom",
    updateProvider: ExactReleaseAssetProvider,
    assets,
    token,
    owner,
    repo,
  };
}

export class ExactReleaseAssetProvider extends Provider<UpdateInfo> {
  private readonly assets: readonly DesktopReleaseAsset[];
  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;

  constructor(
    options: ExactReleaseFeedConfig,
    _updater: unknown,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super(runtimeOptions);
    this.assets = options.assets;
    this.token = options.token;
    this.owner = options.owner;
    this.repo = options.repo;
  }

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

  /** So this provider must never be pointed at a platform that publishes more than one installer format in one channel manifest. */
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

  /** Do not look the blockmap name up in the pinned set; that would hand back the new file for both sides. */
  async getBlockMapFiles(
    baseUrl: URL,
    oldVersion: string,
    newVersion: string,
  ): Promise<URL[]> {
    const blockMapName = `${this.assetNameForUrl(baseUrl)}.blockmap`;
    const newBlockMap = this.assets.find((it) => it.name === blockMapName);
    if (newBlockMap === undefined) {
      throw new Error(
        `Blockmap "${blockMapName}" is not published on the ${newVersion} release`,
      );
    }
    const previous = await this.fetchReleaseAssets(
      desktopReleaseTag(oldVersion),
    );
    const oldBlockMap = previous.find((it) => it.name === blockMapName);
    if (oldBlockMap === undefined) {
      throw new Error(
        `Blockmap "${blockMapName}" is not published on the ${oldVersion} release`,
      );
    }
    return [new URL(oldBlockMap.url), new URL(newBlockMap.url)];
  }

  // An asset-API URL carries only an opaque id, so the pinned asset set is the
  // one place it can be mapped back to a filename. Both sides are normalized
  // through `URL` so the comparison can't fail on incidental spelling.
  private assetNameForUrl(url: URL): string {
    const asset = this.assets.find((it) => new URL(it.url).href === url.href);
    if (asset === undefined) {
      throw new Error(
        `Update file "${url.href}" is not among the desktop release assets`,
      );
    }
    return asset.name;
  }

  private async fetchReleaseAssets(
    tag: string,
  ): Promise<DesktopReleaseAsset[]> {
    const url = new URL(
      `https://api.github.com/repos/${this.owner}/${this.repo}/releases/tags/${encodeURIComponent(tag)}`,
    );
    const raw = await this.httpRequest(
      url,
      this.assetHeaders("application/vnd.github+json"),
    );
    if (raw === null) {
      throw new Error(`Release "${tag}" returned no body`);
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error(`Release "${tag}" returned a malformed response`);
    }
    return readReleaseAssets(parsed.assets);
  }

  private assetHeaders(accept: string): OutgoingHttpHeaders {
    return { accept, authorization: `token ${this.token}` };
  }
}
