import type { UpdateMutationCapabilityAdoption } from "@traycer-clients/shared/host-update";
import { config } from "../config";
import { currentInstallPlatform, type InstallSourceArg } from "../installer";
import { readBundledHostDescriptor } from "../installer/bundled-descriptor";
import { resolveBundledHostArchive } from "../installer/bundled-host";
import { readHostInstallRecord } from "../manifest/host-install";
import {
  createDefaultRegistryClient,
  currentHostPlatformKey,
} from "../registry";
import { createRegistryYankLookup } from "../registry/client";
import { compareHostVersions } from "@traycer-clients/shared/host-version/compare-host-versions";
import { isHiddenFromDefaultCatalog } from "@traycer-clients/shared/host-version/release-line";
import { CLI_ERROR_CODES, CliError, cliError } from "../runner/errors";
import type { RegistryYankLookup } from "../registry/client";
import type { ProgressInfo } from "../runner/output";
import type { RuntimeContext } from "../runner/runtime";
import {
  provisionHost,
  type HostProvisionResult,
  type HostSatisfactionPolicy,
} from "./provision";
import {
  configuredSupportedHostVersion,
  defaultRegistryHostVersionRequest,
} from "./supported-host-version";
import { installSourceLogFields } from "./install-source-log-fields";
import type { HostStartOrigin } from "./lifecycle-origin";

// `host ensure` resolves an acquisition path and delegates state comparison,
// staging and service convergence to provisionHost. Signed bundles use the
// registry minimum policy at their pin; operator --from and unpinned dogfood
// retain own-build semantics. --keep-installed asks only for viability.
//
// Explicit --from / --release / --bundled are mutually exclusive at the parser.
// An explicit release wins over implicit bundle discovery; absent either, use
// the bundled archive, then the build-stamped registry pin, then latest.

// Result shape is identical to the shared core; re-exported under the
// command-facing name.
export type HostEnsureResult = HostProvisionResult;

export interface EnsureHostOptions {
  readonly runtime: RuntimeContext;
  // null means "use the build-stamped default" after checking for a
  // packaged archive. "latest" remains an explicit registry request.
  readonly versionRequest: string | null;
  readonly fromPath: string | null;
  readonly bundledPath?: string | null;
  readonly enableLinger: boolean;
  readonly allowSelfInvocation: boolean;
  // When true, install the host bytes only and leave OS-service
  // registration to the host (the desktop's SMAppService).
  readonly noServiceRegister: boolean;
  // Skip the busy probe and restart a running host unconditionally (the
  // desktop "Force restart"). Threaded into `provisionHost`.
  readonly force: boolean;
  /** See `ProvisionHostOptions.acceptStoreFormatLoss`. Forwarded verbatim. */
  readonly acceptStoreFormatLoss: boolean;
  /** See `ProvisionHostOptions.yankLookup`. Forwarded verbatim. */
  readonly yankLookup: RegistryYankLookup | null;
  // Liveness-only convergence: keep ANY installed, non-yanked host whatever
  // its version, instead of converging to this build's preferred pin. The
  // desktop passes it for its BACKGROUND intent (the selection authority's
  // "host down" ensure, the launch boot ladder, a Doctor repair over a
  // deliberately held version), so an out-of-band downgrade is not silently
  // reverted by a convergence nobody asked for (the downgrade-revert RCA). An
  // explicit `--release` still wins - a named version is an exact request;
  // `--from`/`--bundled` only supply the FIRST-INSTALL source, so
  // `--keep-installed --from <archive>` keeps a viable install and bootstraps
  // from the archive only when nothing is installed.
  readonly keepInstalled: boolean;
  readonly onProgress: ((info: ProgressInfo) => void) | null;
  // Forwarded to `provisionHost`: runs only once this call has committed to
  // installing, registering or starting a host, never on the no-op fast
  // path. `host ensure` hangs its sign-in pre-flight here.
  readonly beforeMutate: (() => Promise<void>) | null;
  /** See `ProvisionHostOptions.adoption`. Forwarded verbatim. */
  readonly adoption: UpdateMutationCapabilityAdoption | undefined;
  /** See `ProvisionHostOptions.lifecycleOrigin`. Forwarded verbatim. */
  readonly lifecycleOrigin: HostStartOrigin;
}

export async function ensureHost(
  opts: EnsureHostOptions,
): Promise<HostEnsureResult> {
  if (opts.noServiceRegister && currentInstallPlatform() === "win32") {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "host ensure: --no-service-register is not supported on Windows",
      details: { environment: opts.runtime.environment },
      exitCode: 1,
    });
  }
  opts.runtime.logger.info("Host ensure started", {
    environment: opts.runtime.environment,
    hasExplicitVersion: opts.versionRequest !== null,
    hasFromPath: opts.fromPath !== null,
    keepInstalled: opts.keepInstalled,
    enableLinger: opts.enableLinger,
    allowSelfInvocation: opts.allowSelfInvocation,
    noServiceRegister: opts.noServiceRegister,
    force: opts.force,
  });
  // The signed bundle provides its own version and published floor evidence.
  // Unpinned dogfood and operator --from retain own-build repair semantics.
  const resolved = await resolveEnsureSource(opts);
  const yankLookup =
    opts.yankLookup ?? createRegistryYankLookup(opts.runtime.environment);
  let source = resolved;
  let keepWithdrawn = false;
  let repairingWithdrawn = false;
  // A first install stays entirely offline. Once installed, even an equal
  // pin must be checked: reinstalling a withdrawn bundle cannot repair it.
  if (resolved.kind === "bundled") {
    const installed = await readHostInstallRecord(opts.runtime.environment);
    if (
      installed !== null &&
      (await yankLookup.isVersionYanked(installed.version))
    ) {
      try {
        const replacement = await newestBundledRepair(
          opts,
          resolved.descriptor.version,
        );
        if (replacement === null) keepWithdrawn = true;
        else {
          source = { kind: "registry", versionRequest: replacement };
          repairingWithdrawn = true;
        }
      } catch (cause) {
        opts.runtime.logger.warn(
          "Bundled host yank repair unavailable; keeping installed host",
          { errorName: cause instanceof Error ? cause.name : "Error" },
        );
        keepWithdrawn = true;
      }
    }
  }
  opts.runtime.logger.debug("Host ensure source resolved", {
    environment: opts.runtime.environment,
    ...installSourceLogFields(source),
  });
  const isOwnBuild = source.kind === "local-file";
  const satisfaction: HostSatisfactionPolicy = keepWithdrawn
    ? { kind: "presence" }
    : repairingWithdrawn && source.kind === "registry"
      ? { kind: "exact", version: source.versionRequest }
      : opts.keepInstalled && opts.versionRequest === null
        ? { kind: "viability" }
        : isOwnBuild
          ? { kind: "own-build-minimum", version: config.version }
          : source.kind === "bundled"
            ? {
                kind: "implicit-registry-minimum",
                version: source.descriptor.version,
              }
            : opts.versionRequest !== null &&
                source.kind === "registry" &&
                source.versionRequest !== "latest"
              ? { kind: "exact", version: source.versionRequest }
              : source.kind === "registry" && source.versionRequest !== "latest"
                ? {
                    kind: "implicit-registry-minimum",
                    version: source.versionRequest,
                  }
                : { kind: "presence" };
  opts.runtime.logger.debug("Host ensure provisioning target computed", {
    environment: opts.runtime.environment,
    sourceKind: source.kind,
    satisfactionKind: satisfaction.kind,
    satisfactionVersion:
      satisfaction.kind === "presence" || satisfaction.kind === "viability"
        ? satisfaction.kind
        : satisfaction.version,
    recordVersionOverride: isOwnBuild ? "cli-build-version" : "none",
    registerService: !opts.noServiceRegister,
  });
  // An explicit concrete `--release X` is the one ensure path that is a
  // deliberate version selection (the `exact` policy) and can therefore be a
  // deliberate DOWNGRADE - so its committed install records a hold, decided
  // inside `provisionHost` UNDER the CLI lock on the actual committed records.
  // Derived from the effective explicit target, NOT from `keepInstalled`:
  // `--keep-installed --release <older>` still selects `exact` above and
  // installs the downgrade, so it must still be held. Every implicit source
  // (packaged/`--from` own-build, the build-stamped pin default, `latest`,
  // viability) leaves this false and never creates a hold.
  const holdExplicitDowngrade =
    opts.versionRequest !== null && opts.versionRequest !== "latest";
  const provisionOptions = {
    adoption: opts.adoption,
    lifecycleOrigin: opts.lifecycleOrigin,
    runtime: opts.runtime,
    resolveInstallSource: async (): Promise<InstallSourceArg> => {
      if (keepWithdrawn) {
        throw cliError({
          code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
          message:
            "host ensure: no non-yanked registry replacement is available",
          details: null,
          exitCode: 1,
        });
      }
      return source;
    },
    satisfaction,
    bundledSource: source.kind === "bundled" ? source : null,
    recordVersionOverride: isOwnBuild ? config.version : null,
    enableLinger: opts.enableLinger,
    allowSelfInvocation: opts.allowSelfInvocation,
    registerService: !opts.noServiceRegister,
    lockReason: "host-ensure",
    force: keepWithdrawn ? false : opts.force,
    acceptStoreFormatLoss: opts.acceptStoreFormatLoss,
    yankLookup,
    // The real clock and budget: `host ensure` (and the desktop's ensure
    // through it) is the caller whose wait for a relaunching supervisor
    // matters most, and it has no reason to shorten it.
    supervisorRelaunchWait: null,
    holdExplicitDowngrade,
    onProgress: opts.onProgress,
    beforeMutate: opts.beforeMutate,
  };
  let result: HostEnsureResult;
  try {
    result = await provisionHost(provisionOptions);
  } catch (cause) {
    // These failures occur during acquisition, before the installed bytes or
    // service are touched. Floor, busy and commit failures remain refusals.
    if (
      !repairingWithdrawn ||
      !(cause instanceof CliError) ||
      !new Set<string>([
        CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
        CLI_ERROR_CODES.REGISTRY_VERSION_NOT_FOUND,
        CLI_ERROR_CODES.HOST_VERIFY_FAILED,
      ]).has(cause.code)
    )
      throw cause;
    opts.runtime.logger.warn(
      "Bundled host yank repair download failed; keeping installed host",
      { errorCode: cause.code },
    );
    result = await provisionHost({
      ...provisionOptions,
      satisfaction: { kind: "presence" },
      force: false,
    });
  }
  if (keepWithdrawn)
    opts.runtime.logger.warn(
      "Installed host is withdrawn; no registry replacement is available",
      { environment: opts.runtime.environment },
    );
  opts.runtime.logger.info("Host ensure completed", {
    environment: opts.runtime.environment,
    action: result.action,
    installed: result.installed,
    registered: result.registered,
    running: result.running,
    hasPostSwapError: result.postSwapError !== null,
  });
  return result;
}

async function resolveEnsureSource(
  opts: EnsureHostOptions,
): Promise<InstallSourceArg> {
  if (opts.fromPath !== null) {
    return { kind: "local-file", path: opts.fromPath };
  }
  if (opts.versionRequest !== null) {
    return { kind: "registry", versionRequest: opts.versionRequest };
  }
  const bundled = opts.bundledPath ?? (await resolveBundledHostArchive());
  if (bundled !== null) {
    if (configuredSupportedHostVersion() === null) {
      return { kind: "local-file", path: bundled };
    }
    return {
      kind: "bundled",
      path: bundled,
      descriptor: await readBundledHostDescriptor(bundled),
    };
  }
  return {
    kind: "registry",
    versionRequest: defaultRegistryHostVersionRequest(),
  };
}

async function newestBundledRepair(
  opts: EnsureHostOptions,
  minimumVersion: string,
): Promise<string | null> {
  const client = await createDefaultRegistryClient(
    opts.runtime.environment,
    opts.onProgress,
  );
  const manifest = await client.fetchManifest();
  // A stable floor uses the default catalog, so repair cannot move onto an
  // RC. An RC floor is already outside that catalog and may repair to a newer
  // RC. Staging stays eligible on a stable floor: the default catalog shows it.
  const allowHiddenCatalog = isHiddenFromDefaultCatalog(minimumVersion);
  let newest: string | null = null;
  for (const entry of manifest.versions) {
    if (entry.yanked || !entry.platforms[currentHostPlatformKey()]?.available)
      continue;
    if (!allowHiddenCatalog && isHiddenFromDefaultCatalog(entry.version))
      continue;
    const minimum = compareHostVersions(entry.version, minimumVersion);
    if (!minimum.comparable || minimum.ordering === "less") continue;
    const candidate =
      newest === null ? null : compareHostVersions(entry.version, newest);
    if (
      newest === null ||
      (candidate?.comparable && candidate.ordering === "greater")
    )
      newest = entry.version;
  }
  return newest;
}
