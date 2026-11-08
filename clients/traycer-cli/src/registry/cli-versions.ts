import { isValidCompatibilityEpoch } from "@traycer/protocol/framework/index";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { signedFeedUrls } from "../config";
import { readSignedFeed } from "./signed-feed";
import { parsePlatformAsset } from "./manifest-schema";
import { currentHostPlatformKey } from "./platform-key";
import type { HostPlatformAsset, HostPlatformKey } from "./types";

// The signed CLI feed carries one rolling version. Return the established
// manifest API after verifying the common feed policy and its watermark.

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

export async function fetchCliVersions(): Promise<CliVersionsManifest> {
  return fetchCliVersionsWithSignal(null);
}

async function fetchCliVersionsWithSignal(
  signal: AbortSignal | null,
): Promise<CliVersionsManifest> {
  const urls = signedFeedUrls("cli");
  const parsed = await readSignedFeed({
    feed: "cli",
    urls,
    fetchDocument: null,
    signal,
    onHeartbeat: null,
    validatePayload: (payload, url) => {
      parseCliFeed(payload, url);
    },
  });
  return parseCliFeed(parsed, urls[0] ?? "cli feed");
}

function parseCliFeed(
  obj: Record<string, unknown>,
  url: string,
): CliVersionsManifest {
  if (
    obj.schemaVersion !== 2 ||
    typeof obj.generatedAt !== "string" ||
    typeof obj.latest !== "string" ||
    !Array.isArray(obj.versions) ||
    obj.versions.length !== 1
  ) {
    throw invalidCliFeed(url);
  }
  const entry: unknown = obj.versions[0];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry))
    throw invalidCliFeed(url);
  const version = entry as Record<string, unknown>;
  if (
    typeof version.version !== "string" ||
    version.version !== obj.latest ||
    typeof version.releaseNotesUrl !== "string" ||
    version.platforms === null ||
    typeof version.platforms !== "object" ||
    Array.isArray(version.platforms)
  ) {
    throw invalidCliFeed(url);
  }
  return {
    schemaVersion: 1,
    generatedAt: obj.generatedAt,
    latest: obj.latest,
    version: version.version,
    platforms: Object.fromEntries(
      Object.entries(version.platforms).map(([key, value]) => [
        key,
        parsePlatformAsset(value, `${url}.platforms.${key}`),
      ]),
    ),
    releaseNotesUrl: version.releaseNotesUrl,
    compatibilityEpoch: readCompatibilityEpoch(version.compatibilityEpoch),
  };
}

function invalidCliFeed(url: string): Error {
  return cliError({
    code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
    message: `cli registry: manifest at ${url} has invalid shape`,
    details: { url },
    exitCode: 1,
  });
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
