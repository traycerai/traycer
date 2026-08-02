import type { Environment } from "../runner/environment";
import type { ProgressInfo } from "../runner/output";
import { createCliLogger, errorFromUnknown } from "../logger";
import { CLI_ERROR_CODES, CliError, cliError } from "../runner/errors";
import {
  acquireDownloadSlot,
  releaseDownloadSlot,
  releaseDownloadSlotOwnership,
} from "./download-cache";
import {
  downloadToFile,
  fetchText,
  type NetworkHeartbeat,
  type NetworkHeartbeatListener,
} from "./fetch-resource";
import { resolveCliVersion } from "../cli-version";
import {
  evaluateHostClientFloor,
  hostClientFloorRefusalMessage,
  isHostClientFloorRefusal,
} from "./client-floor";
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
      // The client floor, checked HERE because this is the one place a host
      // version is selected - both `install` and `download-stage` come
      // through it, so neither can acquire a path around it. Ordered after
      // the yank refusal (a withdrawn version's floor is beside the point)
      // and before the platform-asset lookup, so the answer is about the CLI
      // rather than about which archives happened to publish.
      const floor = evaluateHostClientFloor({
        cliVersion: resolveCliVersion(process.env),
        requiredCliVersion: entry.requiredCliVersion,
      });
      if (floor.kind === "unreleased-cli") {
        // Named exemption, and loud on purpose: a dev build IS below every
        // floor by SemVer, and refusing it would leave `make dev-desktop`
        // unable to install a floored host at all. The machine that hits this
        // is the one best placed to understand the consequence.
        logger.warn("Registry client floor waived for an unreleased CLI", {
          environment: opts.environment,
          resolvedVersion,
          requiredCliVersion: floor.requiredCliVersion,
        });
      }
      if (isHostClientFloorRefusal(floor)) {
        logger.warn("Registry refused a version this CLI cannot run", {
          environment: opts.environment,
          resolvedVersion,
          requiredCliVersion: floor.requiredCliVersion,
          verdict: floor.kind,
        });
        throw cliError({
          code: CLI_ERROR_CODES.HOST_CLIENT_FLOOR_UNMET,
          message: hostClientFloorRefusalMessage(floor, resolvedVersion),
          details: {
            resolvedVersion,
            requiredCliVersion: floor.requiredCliVersion,
            cliVersion: resolveCliVersion(process.env),
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
      // The archive path is stable across CLI invocations (keyed by
      // version + sha256) so a re-spawned CLI resumes the previous
      // process's partial file instead of starting from zero - the whole
      // point of traycer#585/#588. `acquireDownloadSlot` owns the
      // concurrency + sweep policy for that shared location.
      const slot = await acquireDownloadSlot({
        environment: opts.environment,
        version: entry.version,
        sha256: asset.sha256,
        urlBasename: archiveBasenameFromUrl(asset.url),
      });
      const archivePath = slot.archivePath;
      logger.debug("Registry download started", {
        environment: opts.environment,
        resumable: slot.resumable,
      });
      // The `finally` has to tell three outcomes apart, and it needs BOTH
      // of these to do it. `transferred` says the bytes are complete and
      // sha256-verified; `failure` says whether what went wrong afterwards
      // condemns them.
      //
      // Only a TRUST failure condemns an archive: a bad signature, or a
      // keyId that does not match the manifest. Those reproduce on every
      // retry, so the file must go. Everything else after the transfer -
      // above all fetching the sub-1KB `.minisig`, which gives up after
      // four attempts and would fail routinely on the throttled links this
      // work exists for - is a transport failure, and deleting a fully
      // verified 700MB archive because a tiny signature fetch flaked is
      // exactly the "downloads forever, never finishes" loop being fixed.
      let succeeded = false;
      let transferred = false;
      let failure: unknown = null;
      try {
        const download = await transport.downloadToFile({
          url: asset.url,
          destPath: archivePath,
          expectedSizeBytes: asset.sizeBytes,
          expectedSha256: asset.sha256,
          onProgress: (info) => onProgress(info),
          onHeartbeat: (heartbeat) =>
            emitRegistryHeartbeat(opts.onProgress, "archive", heartbeat),
        });
        transferred = true;
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
      } catch (err) {
        failure = err;
        throw err;
      } finally {
        // On success the caller owns the verified archive until it has
        // extracted it, and releases the slot itself.
        //
        // Both releases are `.catch`-guarded. Today neither can reject -
        // download-cache.ts swallows its own fs errors - but that is its
        // internal detail, and an unguarded await in a `finally` would let a
        // future change there replace the error being propagated. Callers
        // route on `REGISTRY_UNAVAILABLE` vs `HOST_VERIFY_FAILED`; losing
        // that code to a cleanup failure would turn a retryable download
        // into an unrecognized one.
        if (!succeeded && transferred && isTrustFailure(failure)) {
          // Complete bytes that the trust chain rejected. Resuming into
          // them would just reproduce the same verdict, so drop the file
          // with the claim.
          await releaseDownloadSlot(opts.environment, archivePath).catch(
            () => undefined,
          );
          logger.warn("Registry discarded an unverifiable download", {
            environment: opts.environment,
          });
        } else if (!succeeded) {
          // Keep whatever landed on disk and drop only the ownership
          // claim, so the next invocation resumes it. Covers both a failed
          // transfer (the case a throttled connection hits over and over)
          // and a post-transfer transport failure, where the archive is
          // complete and sha256-verified and only the signature fetch has
          // yet to succeed - the next run re-verifies it over one 416
          // round-trip instead of re-downloading it.
          await releaseDownloadSlotOwnership(
            opts.environment,
            archivePath,
          ).catch(() => undefined);
          logger.warn("Registry left a resumable download in place", {
            environment: opts.environment,
            transferComplete: transferred,
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
    // Attempt counters belong in the message, not in the byte fields. A
    // heartbeat is a liveness tick, not a transfer measurement: putting
    // `attempt`/`maxAttempts` here made Desktop's progress bar redraw as
    // "1 byte of 4" every time a retry fired mid-download. All three
    // numeric fields stay null so the renderer holds the last real values.
    bytes: null,
    totalBytes: null,
  });
}

function registryHeartbeatMessage(
  resourceLabel: string,
  heartbeat: NetworkHeartbeat,
): string {
  if (heartbeat.phase === "attempt") {
    // No denominator when the counter has no ceiling worth quoting - an
    // archive download is bounded by consecutive stalls, not by attempts,
    // so "attempt 41/200" would read as a countdown that is not running.
    const of =
      heartbeat.maxAttempts === null ? "" : `/${heartbeat.maxAttempts}`;
    return `fetching ${resourceLabel} (attempt ${heartbeat.attempt}${of})`;
  }
  if (heartbeat.phase === "watchdog") {
    return `fetching ${resourceLabel} stalled; retrying`;
  }
  return `retrying ${resourceLabel} shortly`;
}

// Whether a post-transfer failure condemns the bytes on disk. The verify
// chain reports `HOST_VERIFY_FAILED` for everything that makes an archive
// untrustworthy (a signature that does not check out, a keyId the manifest
// does not pin); a network failure fetching the signature reports
// `REGISTRY_UNAVAILABLE` and says nothing about the archive itself.
function isTrustFailure(err: unknown): boolean {
  return (
    err instanceof CliError && err.code === CLI_ERROR_CODES.HOST_VERIFY_FAILED
  );
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
