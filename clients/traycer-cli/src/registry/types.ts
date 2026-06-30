// Host registry types per the Native Packaging Tech Plan. The CLI
// reads `versions.json` from a Traycer-hosted CDN to discover available
// host releases; downloads each archive from the URL recorded in the
// per-platform entry, verifies its sha256 + minisign signature, and
// only then unpacks/replaces the install directory.
//
// NP-2 ships the type seam + a stub `RegistryClient` so the installer
// can be wired up end-to-end against local-file sources. NP-4 fills in
// the actual HTTP fetch + minisign verifier.

export type HostPlatformKey =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "win32-arm64"
  | "win32-x64";

export interface HostPlatformAsset {
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly url: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly signatureUrl: string;
  readonly signatureAlgorithm: "minisign";
  readonly publicKeyId: string;
}

export interface HostVersionEntry {
  readonly version: string;
  readonly releasedAt: string;
  readonly releaseNotesUrl: string;
  readonly yanked: boolean;
  readonly deprecationReason: string | null;
  readonly requiredCliVersion: string | null;
  readonly platforms: Readonly<Record<string, HostPlatformAsset>>;
}

export interface HostVersionsManifest {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly latest: string;
  readonly versions: readonly HostVersionEntry[];
}

export interface RegistryClient {
  // Fetch the canonical versions.json manifest. NP-4 implements this
  // against the production CDN; NP-2 returns a NotImplemented error so
  // commands that depend on the registry surface a clean message and
  // doctor can flag the gap.
  fetchManifest(): Promise<HostVersionsManifest>;
  // Resolve a version string ("latest" or an explicit semver) against
  // the manifest, returning the platform-appropriate asset. NP-2 stub
  // returns a NotImplemented error.
  resolveAsset(
    versionRequest: string,
    platformKey: HostPlatformKey,
  ): Promise<{
    readonly entry: HostVersionEntry;
    readonly asset: HostPlatformAsset;
  }>;
  // Download + verify a previously-resolved asset, returning the path
  // of the verified archive on local disk (typically a temp file). NP-4
  // implements the minisign + sha256 chain; NP-2 returns a
  // NotImplemented error.
  downloadAndVerify(
    entry: HostVersionEntry,
    asset: HostPlatformAsset,
    onProgress: (progress: {
      downloadedBytes: number;
      totalBytes: number;
    }) => void,
  ): Promise<{
    readonly archivePath: string;
    readonly archiveSha256: string;
    readonly signatureKeyId: string;
    readonly signatureVerifiedAt: string;
  }>;
}
