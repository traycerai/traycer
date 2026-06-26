import { config } from "../config";
import type { InstallSourceArg } from "../installer";
import { resolveBundledHostArchive } from "../installer/bundled-host";
import type { ProgressInfo } from "../runner/output";
import type { RuntimeContext } from "../runner/runtime";
import {
  provisionHost,
  type HostProvisionResult,
} from "./provision";
import { defaultRegistryHostVersionRequest } from "./supported-host-version";
import { installSourceLogFields } from "./install-source-log-fields";

// `host ensure` - the desktop's post-auth provisioning call. A thin
// source-resolving wrapper over the shared `provisionHost` core
// (host/provision.ts), which `maybeAutoBootstrap` (login / host status)
// also routes through.
//
// Source resolution order (offline-capable, self-contained when the host
// ships beside the CLI):
//   1. explicit `--from <path>`
//   2. explicit `--release <semver>`
//   3. packaged host archive next to the CLI binary
//   4. build-stamped `config.supportedHostVersion`
//   5. registry `latest` (dev/manual fallback)

// Result shape is identical to the shared core; re-exported under the
// command-facing name.
export type HostEnsureResult = HostProvisionResult;

export interface EnsureHostOptions {
  readonly runtime: RuntimeContext;
  // null means "use the build-stamped default" after checking for a
  // packaged archive. "latest" remains an explicit registry request.
  readonly versionRequest: string | null;
  readonly fromPath: string | null;
  readonly enableLinger: boolean;
  readonly allowSelfInvocation: boolean;
  // When true, install the host bytes only and leave OS-service
  // registration to the host (the desktop's SMAppService).
  readonly noServiceRegister: boolean;
  // Skip the busy probe and restart a running host unconditionally (the
  // desktop "Force restart"). Threaded into `provisionHost`.
  readonly force: boolean;
  readonly onProgress: ((info: ProgressInfo) => void) | null;
}

export async function ensureHost(
  opts: EnsureHostOptions,
): Promise<HostEnsureResult> {
  opts.runtime.logger.info("Host ensure started", {
    environment: opts.runtime.environment,
    hasExplicitVersion: opts.versionRequest !== null,
    hasFromPath: opts.fromPath !== null,
    enableLinger: opts.enableLinger,
    allowSelfInvocation: opts.allowSelfInvocation,
    noServiceRegister: opts.noServiceRegister,
    force: opts.force,
  });
  // Resolve the source up front (a cheap path probe - no network/download)
  // so we can key idempotency on it. Our own bundled host resolves to a
  // local-file; it shares this build's `config.version`, so we stamp that as
  // both the target and the recorded version. A rebuilt host (new stamp,
  // same channel) then differs from the install record and is reinstalled,
  // while an unchanged build is a no-op. An explicit `--release <semver>`
  // resolves to a registry source and keeps the real semver as its target.
  const source = await resolveEnsureSource(opts);
  opts.runtime.logger.info("Host ensure source resolved", {
    environment: opts.runtime.environment,
    ...installSourceLogFields(source),
  });
  const isOwnBuild = source.kind === "local-file";
  const targetVersion = isOwnBuild
    ? config.version
    : source.kind === "registry" && source.versionRequest !== "latest"
      ? source.versionRequest
      : null;
  opts.runtime.logger.debug("Host ensure provisioning target computed", {
    environment: opts.runtime.environment,
    sourceKind: source.kind,
    targetVersion: targetVersion ?? "presence-only",
    recordVersionOverride: isOwnBuild ? "cli-build-version" : "none",
    registerService: !opts.noServiceRegister,
  });
  const result = await provisionHost({
    runtime: opts.runtime,
    resolveInstallSource: () => Promise.resolve(source),
    targetVersion,
    recordVersionOverride: isOwnBuild ? config.version : null,
    enableLinger: opts.enableLinger,
    allowSelfInvocation: opts.allowSelfInvocation,
    registerService: !opts.noServiceRegister,
    lockReason: "host-ensure",
    force: opts.force,
    onProgress: opts.onProgress,
  });
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
  const bundled = await resolveBundledHostArchive();
  if (bundled !== null) {
    return { kind: "local-file", path: bundled };
  }
  return {
    kind: "registry",
    versionRequest: defaultRegistryHostVersionRequest(),
  };
}
