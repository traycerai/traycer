import { isValidCompatibilityEpoch } from "@traycer/protocol/framework/index";
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
  /**
   * The client-compatibility EPOCH of the build this manifest resolves,
   * stamped by the release pipeline beside `version`.
   *
   * ADDITIVE, and `schemaVersion` deliberately stays `1`: the key is one more
   * top-level member of a document whose reader already drops what it does not
   * recognize, so an older CLI reading a stamped manifest is unaffected and a
   * newer CLI reading an unstamped one gets `null`.
   *
   * `null` covers absent, malformed, and unreadable alike, and every consumer
   * must treat all three as INSUFFICIENT. It does NOT mean epoch 1 - mapping a
   * missing declaration to the legacy generation is honest only for a client a
   * host observed on the wire, never for a build nobody has run yet. A stale
   * or lagging CDN copy can therefore only under-report, which routes
   * conservatively; it can never over-report a build into being offered as a
   * remedy the host will refuse.
   */
  readonly compatibilityEpoch: number | null;
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
  return fetchCliVersionsWithSignal(null);
}

async function fetchCliVersionsWithSignal(
  signal: AbortSignal | null,
): Promise<CliVersionsManifest> {
  const url = CLI_VERSIONS_URL;
  const body = await fetchText(url, { signal, onHeartbeat: null });
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
    compatibilityEpoch: readCompatibilityEpoch(obj.compatibilityEpoch),
  };
}

/**
 * The stamped epoch, or `null` for anything this build cannot read as one.
 *
 * LENIENT ON PURPOSE, unlike the shape checks above which throw. Those members
 * are what `cli upgrade` needs to function at all, so a manifest missing them
 * is genuinely unusable. This one only informs a RECOVERY HINT: refusing the
 * whole manifest over a bad stamp would break self-upgrade for every user to
 * improve one sentence of advice, and the conservative reading (`null`, which
 * every consumer treats as insufficient) already fails in the safe direction.
 */
function readCompatibilityEpoch(value: unknown): number | null {
  // Same scalar rule the host's admission gate applies, from the same place -
  // see the desktop carrier reader for why this is not re-derived per client.
  return typeof value === "number" && isValidCompatibilityEpoch(value)
    ? value
    : null;
}

/**
 * The CLI feed's stamped epoch, for the recovery hint - never throwing.
 *
 * The caller is already on an error path (a host refused this CLI), and a
 * network failure there must degrade the ADVICE, not replace the rejection
 * with a registry error. `null` from an unreachable feed and `null` from an
 * unstamped one route identically, which is exactly right: in both cases we
 * cannot establish that `cli upgrade` would deliver a build that clears the
 * floor.
 */
export async function readCliFeedCompatibilityEpoch(
  signal: AbortSignal,
): Promise<number | null> {
  try {
    return (await fetchCliVersionsWithSignal(signal)).compatibilityEpoch;
  } catch {
    return null;
  }
}

/**
 * The version the feed's `platforms` map actually describes.
 *
 * The feed is ROLLING: it carries exactly one build's platform assets, and the
 * publisher writes `latest` and `version` from the same value (see
 * `scripts/native-packaging/publish-cli-package-managers.cjs`). `version` is
 * the one that is definitionally tied to the assets, so every caller that
 * stamps a version alongside downloaded bytes must read it from here rather
 * than from `latest` - a lagging or hand-edited feed where the two disagree
 * would otherwise install `version`'s bytes and record `latest`'s number,
 * which is the divergence the audit's CLI-013 describes.
 */
export function cliAssetVersion(manifest: CliVersionsManifest): string {
  return manifest.version;
}

export function resolveCliAsset(
  manifest: CliVersionsManifest,
  platformKey: HostPlatformKey,
): HostPlatformAsset {
  const asset = manifest.platforms[platformKey];
  if (asset === undefined || !asset.available) {
    throw cliError({
      code: CLI_ERROR_CODES.REGISTRY_VERSION_NOT_FOUND,
      message: `cli registry: no asset for ${platformKey} in version ${manifest.version}`,
      details: { platformKey, version: manifest.version },
      exitCode: 1,
    });
  }
  return asset;
}

export function currentCliPlatformKey(): HostPlatformKey {
  return currentHostPlatformKey();
}
