import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Environment } from "../runner/environment";
import type { ProgressInfo } from "../runner/output";
import { createCliLogger, errorFromUnknown } from "../logger";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import {
  downloadToFile,
  fetchText,
  type NetworkHeartbeat,
  type NetworkHeartbeatListener,
} from "./fetch-resource";
import { parseHostVersionsManifestWithWarnings } from "./manifest-schema";
import { resolveManifestUrl } from "./manifest-url";
import { verifyMinisignArchive } from "./minisign";
import { loadTrustedKeys } from "./trusted-keys";
import type {
  HostPlatformAsset,
  HostPlatformKey,
  HostVersionEntry,
  HostVersionsManifest,
  RegistryClient,
} from "./types";

const YANK_LOOKUP_TIMEOUT_MS = 10_000;

export interface RegistryYankLookup {
  // Returns false for an entry missing from the manifest and for every
  // registry failure. Those conditions must preserve a newer installed host.
  isVersionYanked(version: string): Promise<boolean>;
}

// Real registry client. Replaces the NP-2 stub now that NP-4 ships the
// hosted versions.json fetcher, asset resolver, and minisign + sha256
// verification chain.
//
// Lifecycle is unchanged for callers:
//
//   client.fetchManifest()             → versions.json (validated)
//   client.resolveAsset(ver, platKey)  → manifest entry + platform asset
//   client.downloadAndVerify(entry, a) → archive on disk, verified
//
// The installer (src/installer/install.ts) keeps owning the staging
// directory + atomic swap; this module owns the trust + network layer.

export interface CreateRegistryClientOptions {
  readonly environment: Environment;
  // Optional override so tests / scripts can inject a fake fetcher
  // without monkey-patching globals. Null = use the default
  // `fetchText` / `downloadToFile`.
  readonly transport: RegistryTransport | null;
  // Whether construction must fail if no trusted minisign keys are
  // configured. Production callers (`createDefaultRegistryClient`)
  // pass `true` so an accidentally-shipped binary without baked keys
  // fails loudly at construction; tests pass `false` because the fake
  // transport substitutes the verify chain wholesale.
  readonly requireTrustedKeys: boolean;
  readonly onProgress: ((info: ProgressInfo) => void) | null;
}

export interface RegistryTransport {
  fetchText(opts: RegistryFetchTextOptions): Promise<string>;
  downloadToFile(opts: {
    readonly url: string;
    readonly destPath: string;
    readonly expectedSizeBytes: number;
    readonly expectedSha256: string;
    readonly onProgress: (info: {
      readonly downloadedBytes: number;
      readonly totalBytes: number;
    }) => void;
    readonly onHeartbeat: NetworkHeartbeatListener | null;
  }): Promise<{ readonly downloadedBytes: number; readonly sha256: string }>;
}

export interface RegistryFetchTextOptions {
  readonly url: string;
  readonly onHeartbeat: NetworkHeartbeatListener | null;
}

const DEFAULT_TRANSPORT: RegistryTransport = {
  fetchText: ({ url, onHeartbeat }) =>
    fetchText(url, { signal: null, onHeartbeat }),
  downloadToFile: (opts) =>
    downloadToFile({
      ...opts,
      signal: null,
    }),
};

export async function createRegistryClient(
  opts: CreateRegistryClientOptions,
): Promise<RegistryClient> {
  const logger = createCliLogger(opts.environment);
  const transport = opts.transport ?? DEFAULT_TRANSPORT;
  const manifestUrlInfo = resolveManifestUrl();
  const trustedKeySet = await loadTrustedKeys();
  logger.debug("Registry client created", {
    environment: opts.environment,
    customTransport: opts.transport !== null,
    requireTrustedKeys: opts.requireTrustedKeys,
    trustedKeyCount: trustedKeySet.keys.length,
    trustedKeySourceCount: trustedKeySet.sources.length,
    manifestUrl: manifestUrlInfo.url,
  });

  // Fail loudly at construction time, not at the first verify call:
  // if no trusted keys are configured for a real environment, every
  // signature verify would fail anyway and the user-facing error would
  // come *after* an unnecessary network round-trip. Callers opt out via
  // `requireTrustedKeys: false` (only legitimate in unit tests that
  // substitute the verify chain via a fake transport).
  if (trustedKeySet.keys.length === 0 && opts.requireTrustedKeys) {
    logger.error(
      "Registry client missing trusted signing keys",
      {
        environment: opts.environment,
        sourceCount: trustedKeySet.sources.length,
      },
      null,
    );
    throw cliError({
      code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
      message:
        "host registry: no trusted signing keys are configured for this build, " +
        "so host versions cannot be verified. This is expected for local/dev " +
        "builds; install from a local archive with 'traycer host install --from <path>'.",
      details: {
        sources: trustedKeySet.sources,
        environment: opts.environment,
      },
      exitCode: 1,
    });
  }

  let cachedManifest: HostVersionsManifest | null = null;

  return {
    async fetchManifest(): Promise<HostVersionsManifest> {
      if (cachedManifest !== null) {
        logger.debug("Registry manifest cache hit", {
          environment: opts.environment,
          versionCount: cachedManifest.versions.length,
        });
        return cachedManifest;
      }
      logger.debug("Registry manifest fetch started", {
        environment: opts.environment,
        manifestUrl: manifestUrlInfo.url,
      });
      const body = await transport.fetchText({
        url: manifestUrlInfo.url,
        onHeartbeat: (heartbeat) =>
          emitRegistryHeartbeat(opts.onProgress, "manifest", heartbeat),
      });
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(body);
      } catch (err) {
        logger.error(
          "Registry manifest JSON parse failed",
          {
            environment: opts.environment,
            manifestUrl: manifestUrlInfo.url,
          },
          errorFromUnknown(err),
        );
        throw cliError({
          code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
          message: `host registry: manifest at ${manifestUrlInfo.url} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          details: { url: manifestUrlInfo.url },
          exitCode: 1,
        });
      }
      const parseResult = parseHostVersionsManifestWithWarnings(
        parsedJson,
        manifestUrlInfo.url,
      );
      const { manifest } = parseResult;
      parseResult.warnings.forEach((warning) => {
        logger.warn("Registry manifest entry skipped", {
          environment: opts.environment,
          manifestUrl: manifestUrlInfo.url,
          entryIndex: warning.entryIndex,
          entryLabel: warning.entryLabel,
          warning: warning.message,
        });
      });
      cachedManifest = manifest;
      logger.debug("Registry manifest parsed", {
        environment: opts.environment,
        hasLatest: manifest.latest.length > 0,
        versionCount: manifest.versions.length,
        warningCount: parseResult.warnings.length,
      });
      return manifest;
    },

    async resolveAsset(
      versionRequest: string,
      platformKey: HostPlatformKey,
    ): Promise<{
      readonly entry: HostVersionEntry;
      readonly asset: HostPlatformAsset;
    }> {
      const manifest =
        cachedManifest ?? (await (this as RegistryClient).fetchManifest());
      const requestedLatest = versionRequest === "latest";
      const resolvedVersion = requestedLatest
        ? manifest.latest
        : versionRequest;
      logger.debug("Registry asset resolution started", {
        environment: opts.environment,
        requestedLatest,
        platformKey,
      });
      const entry = manifest.versions.find(
        (v) => v.version === resolvedVersion,
      );
      if (entry === undefined) {
        logger.warn("Registry version not found", {
          environment: opts.environment,
          requestedLatest,
          availableVersionCount: manifest.versions.length,
        });
        throw cliError({
          code: CLI_ERROR_CODES.REGISTRY_VERSION_NOT_FOUND,
          message: `host registry: version '${resolvedVersion}' not found in manifest at ${manifestUrlInfo.url}`,
          details: {
            versionRequest,
            resolvedVersion,
            availableVersions: manifest.versions.map((v) => v.version),
          },
          exitCode: 1,
        });
      }
      if (entry.yanked) {
        logger.warn("Registry refused yanked version", {
          environment: opts.environment,
          requestedLatest,
          hasDeprecationReason: entry.deprecationReason !== null,
        });
        // Yanked versions are refused for install. The Tech Plan reserves
        // a future `--force` repair path; until that lands we fail with
        // a clean code so Desktop can route to the failure card.
        throw cliError({
          code: CLI_ERROR_CODES.REGISTRY_VERSION_NOT_FOUND,
          message: `host registry: version '${resolvedVersion}' is yanked${entry.deprecationReason !== null ? ` (${entry.deprecationReason})` : ""}; pick a non-yanked version`,
          details: {
            resolvedVersion,
            deprecationReason: entry.deprecationReason,
          },
          exitCode: 1,
        });
      }
      const asset = entry.platforms[platformKey];
      if (asset === undefined || !asset.available) {
        const reason =
          asset?.unavailableReason ?? "no asset published for this platform";
        logger.warn("Registry asset unavailable for platform", {
          environment: opts.environment,
          requestedLatest,
          platformKey,
          hasUnavailableReason:
            asset !== undefined && asset.unavailableReason !== null,
        });
        throw cliError({
          code: CLI_ERROR_CODES.REGISTRY_VERSION_NOT_FOUND,
          message: `host registry: version '${resolvedVersion}' has no available asset for ${platformKey}: ${reason}`,
          details: {
            resolvedVersion,
            platformKey,
            unavailableReason: asset?.unavailableReason ?? null,
          },
          exitCode: 1,
        });
      }
      logger.debug("Registry asset resolved", {
        environment: opts.environment,
        requestedLatest,
        platformKey,
      });
      return { entry, asset };
    },

    async downloadAndVerify(
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
    }> {
      if (!asset.available) {
        logger.warn("Registry download refused unavailable asset", {
          environment: opts.environment,
          hasUnavailableReason: asset.unavailableReason !== null,
        });
        throw cliError({
          code: CLI_ERROR_CODES.REGISTRY_VERSION_NOT_FOUND,
          message: `host registry: asset for version '${entry.version}' is marked unavailable`,
          details: {
            version: entry.version,
            unavailableReason: asset.unavailableReason,
          },
          exitCode: 1,
        });
      }
      const tmpDir = await mkdtemp(join(tmpdir(), "traycer-host-dl-"));
      logger.debug("Registry download started", {
        environment: opts.environment,
      });
      // Track whether we succeeded so the `finally` block can clean up
      // the tmpdir on failure. On success the caller (installer) is
      // responsible for moving the archive out and removing the dir.
      let succeeded = false;
      try {
        const archivePath = join(tmpDir, archiveBasenameFromUrl(asset.url));
        const download = await transport.downloadToFile({
          url: asset.url,
          destPath: archivePath,
          expectedSizeBytes: asset.sizeBytes,
          expectedSha256: asset.sha256,
          onProgress: (info) => onProgress(info),
          onHeartbeat: (heartbeat) =>
            emitRegistryHeartbeat(opts.onProgress, "archive", heartbeat),
        });
        const signatureText = await transport.fetchText({
          url: asset.signatureUrl,
          onHeartbeat: (heartbeat) =>
            emitRegistryHeartbeat(opts.onProgress, "signature", heartbeat),
        });
        const verifyResult = await verifyMinisignArchive({
          archivePath,
          signatureText,
          signatureSourceLabel: asset.signatureUrl,
          trustedKeys: trustedKeySet.keys,
        });
        // The publicKeyId pinned in the manifest must match the keyId of
        // the signature itself - otherwise the publisher could swap the
        // signing key after the fact without changing the manifest.
        if (verifyResult.keyId !== asset.publicKeyId) {
          logger.error(
            "Registry signature key mismatch",
            {
              environment: opts.environment,
            },
            null,
          );
          throw cliError({
            code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
            message: `host registry: signature key id '${verifyResult.keyId}' does not match manifest publicKeyId '${asset.publicKeyId}'`,
            details: {
              signatureKeyId: verifyResult.keyId,
              manifestPublicKeyId: asset.publicKeyId,
            },
            exitCode: 1,
          });
        }
        succeeded = true;
        logger.info("Registry download and verification completed", {
          environment: opts.environment,
          downloadedExpectedBytes: download.downloadedBytes === asset.sizeBytes,
        });
        return {
          archivePath,
          archiveSha256: download.sha256,
          signatureKeyId: verifyResult.keyId,
          signatureVerifiedAt: new Date().toISOString(),
        };
      } finally {
        // On failure, scrub the tmpdir so we don't leak the partial
        // archive (downloadToFile aborts on size-cap / stream error
        // without unlinking) or an empty tmpdir. Best-effort: rm errors
        // are swallowed so they don't mask the original throw - the
        // pathological case (rm fails on a tmpdir) leaves at worst the
        // empty dir behind, which the OS cleans up on reboot anyway.
        if (!succeeded) {
          await rm(tmpDir, { recursive: true, force: true }).catch((err) => {
            logger.warn(
              "Registry failed to clean temporary download directory",
              {
                environment: opts.environment,
                errorName: errorFromUnknown(err).name,
              },
            );
          });
          logger.warn("Registry cleaned failed download attempt", {
            environment: opts.environment,
          });
        }
      }
    },
  };
}

// Production call-site helper: build a registry client wired to the
// real `process.env` and the default fetch/download transport. This
// exists as its own export (rather than as default values on
// CreateRegistryClientOptions) because the project style forbids
// default parameter values and "pseudo-optional" rest-tuple shims -
// every argument must be passed explicitly. Forcing call-sites to
// thread `environment` here keeps the prod/dev distinction visible and
// prevents an accidental no-arg construction from typing as
// `RegistryClient` and crashing later when the transport sentinel is
// dereferenced.
export async function createDefaultRegistryClient(
  environment: Environment,
  onProgress: ((info: ProgressInfo) => void) | null,
): Promise<RegistryClient> {
  return createRegistryClient({
    environment,
    transport: null,
    requireTrustedKeys: true,
    onProgress,
  });
}

// Create one lookup per provisioning run. It shares only a manifest promise
// and its result; every state snapshot still asks whether its installed
// version is yanked. This read is advisory, unlike installer manifest fetches:
// offline, malformed, and timed-out responses all intentionally fail open.
export function createRegistryYankLookup(
  environment: Environment,
): RegistryYankLookup {
  const logger = createCliLogger(environment);
  const manifestUrl = resolveManifestUrl().url;
  let manifestPromise: Promise<HostVersionsManifest | null> | null = null;

  const fetchManifest = async (): Promise<HostVersionsManifest | null> => {
    const controller = new AbortController();
    let watchdogExpired = false;
    const watchdog = setTimeout(() => {
      watchdogExpired = true;
      controller.abort();
    }, YANK_LOOKUP_TIMEOUT_MS);
    try {
      const body = await fetchText(manifestUrl, {
        signal: controller.signal,
        onHeartbeat: null,
      });
      const parsed: unknown = JSON.parse(body);
      return parseHostVersionsManifestWithWarnings(parsed, manifestUrl)
        .manifest;
    } catch (err) {
      logger.warn("Registry yank lookup failed open", {
        environment,
        manifestUrl,
        watchdogExpired,
        errorName: errorFromUnknown(err).name,
      });
      return null;
    } finally {
      clearTimeout(watchdog);
    }
  };

  return {
    async isVersionYanked(version: string): Promise<boolean> {
      manifestPromise ??= fetchManifest();
      const manifest = await manifestPromise;
      return (
        manifest?.versions.find((entry) => entry.version === version)
          ?.yanked === true
      );
    },
  };
}

function emitRegistryHeartbeat(
  onProgress: ((info: ProgressInfo) => void) | null,
  resource: "manifest" | "archive" | "signature",
  heartbeat: NetworkHeartbeat,
): void {
  if (onProgress === null) return;
  const resourceLabel = resource === "archive" ? "host archive" : resource;
  onProgress({
    stage: `registry-${resource}-${heartbeat.phase}`,
    message: registryHeartbeatMessage(resourceLabel, heartbeat),
    percent: null,
    bytes: heartbeat.attempt,
    totalBytes: heartbeat.maxAttempts,
  });
}

function registryHeartbeatMessage(
  resourceLabel: string,
  heartbeat: NetworkHeartbeat,
): string {
  if (heartbeat.phase === "attempt") {
    return `fetching ${resourceLabel} (attempt ${heartbeat.attempt}/${heartbeat.maxAttempts})`;
  }
  if (heartbeat.phase === "watchdog") {
    return `fetching ${resourceLabel} stalled; retrying`;
  }
  return `retrying ${resourceLabel} shortly`;
}

function archiveBasenameFromUrl(url: string): string {
  // Best-effort: pull the last path segment from the URL so the temp
  // file name reflects the publisher's archive name (helps debugging
  // when an install fails mid-flight). Falls back to a generic name.
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/");
    const last = segments[segments.length - 1];
    if (last !== undefined && last.length > 0) return last;
  } catch {
    // Fall through to default.
  }
  return "host-archive";
}
