import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { releaseManifestUrl } from "../config";
import { fetchText } from "./fetch-resource";
import { currentHostPlatformKey } from "./platform-key";
import type { HostPlatformAsset, HostPlatformKey } from "./types";

// CLI registry - parallel to the host registry. The manifest is hosted
// as the `versions.json` asset on the rolling `cli-manifest` GitHub
// Release on the OSS repo (mirrors the released-host-versions release). The
// `update-cli-package-managers` GitHub workflow re-uploads this manifest
// after every successful CLI release so:
//
//   - Desktop's CLI bridge can detect when the package-manager-installed
//     CLI is newer than the bundled one.
//   - `traycer cli upgrade` (direct/manual installs) can pick the right
//     download URL + sha256 for the current platform.
//   - Package-manager taps (scoop's checkver) can detect when a new
//     version is available without scraping the GitHub Releases API.
//
// The shape is intentionally lighter than the host manifest - the CLI
// has no concept of "yanked" or per-version compat (compatibility
// surfaces as RPC errors at runtime, see Tech Plan Decision 8). The
// schema mirrors the per-version host entry so existing client code
// (signature verification, downloadAndVerify) can be reused.

export interface CliVersionsManifest {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly latest: string;
  readonly version: string;
  readonly platforms: Readonly<Record<string, HostPlatformAsset>>;
  readonly releaseNotesUrl: string;
}

// Single canonical URL - there is no per-environment CLI release stream. Dev
// CLIs are sourced from the working tree via the SEA build, not the registry.
// Package-manager installs (npm/brew/scoop/apt/rpm) self-update through the
// package manager; this path is the standalone/curl-SEA self-update probe.
//
// LOCKSTEP: config.releaseRepo MUST match the publisher side -
// `${{ vars.RELEASE_REPO || 'traycerai/traycer' }}` in
// update-cli-package-managers.yml, which uploads the `cli-manifest` asset.
const CLI_VERSIONS_URL = releaseManifestUrl("cli-manifest");

export async function fetchCliVersions(): Promise<CliVersionsManifest> {
  const url = CLI_VERSIONS_URL;
  const body = await fetchText(url, { signal: null, onHeartbeat: null });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw cliError({
      code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
      message: `cli registry: manifest at ${url} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      details: { url },
      exitCode: 1,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw cliError({
      code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
      message: `cli registry: manifest at ${url}: top-level must be an object`,
      details: { url },
      exitCode: 1,
    });
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.latest !== "string" ||
    typeof obj.version !== "string" ||
    typeof obj.releaseNotesUrl !== "string" ||
    typeof obj.generatedAt !== "string" ||
    obj.schemaVersion !== 1 ||
    typeof obj.platforms !== "object" ||
    obj.platforms === null
  ) {
    throw cliError({
      code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
      message: `cli registry: manifest at ${url} has invalid shape`,
      details: { url },
      exitCode: 1,
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: obj.generatedAt,
    latest: obj.latest,
    version: obj.version,
    platforms: obj.platforms as Readonly<Record<string, HostPlatformAsset>>,
    releaseNotesUrl: obj.releaseNotesUrl,
  };
}

export function resolveCliAsset(
  manifest: CliVersionsManifest,
  platformKey: HostPlatformKey,
): HostPlatformAsset {
  const asset = manifest.platforms[platformKey];
  if (asset === undefined || !asset.available) {
    throw cliError({
      code: CLI_ERROR_CODES.REGISTRY_VERSION_NOT_FOUND,
      message: `cli registry: no asset for ${platformKey} in version ${manifest.latest}`,
      details: { platformKey, latest: manifest.latest },
      exitCode: 1,
    });
  }
  return asset;
}

export function currentCliPlatformKey(): HostPlatformKey {
  return currentHostPlatformKey();
}
