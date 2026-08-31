import type { UpdateMutationCapabilityAdoption } from "@traycer-clients/shared/host-update";
import { config } from "../config";
import { currentInstallPlatform, type InstallSourceArg } from "../installer";
import { resolveBundledHostArchive } from "../installer/bundled-host";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { ProgressInfo } from "../runner/output";
import type { RuntimeContext } from "../runner/runtime";
import {
  provisionHost,
  type HostProvisionResult,
  type HostSatisfactionPolicy,
} from "./provision";
import { defaultRegistryHostVersionRequest } from "./supported-host-version";
import { installSourceLogFields } from "./install-source-log-fields";

// `host ensure` - the desktop's post-auth provisioning call, and now the
// CLI's ONLY convergent install/register/start path. A thin source-resolving
// wrapper over the shared `provisionHost` core (host/provision.ts).
//
// It used to share that core with `maybeAutoBootstrap`, which ran the same
// pipeline implicitly off `traycer host status`. That was removed (audit
// finding CLI-001): a status read must not install software. Anything that
// wants a host to exist asks for it here, or via `host install` /
// `host service install`.
//
// ONE SEMANTIC DIFFERENCE FROM AUTO-BOOTSTRAP IS DELIBERATE, and is the point
// rather than an oversight. When bytes were already installed but the OS
// service registration was missing, auto-bootstrap forced `satisfaction:
// presence` so a registration repair could never replace the installed host.
// `ensureHost` does NOT: it derives satisfaction from the resolved source, so
// bytes that differ from this CLI's expected version are reinstalled even
// when the only visible gap was the registration.
//
// That asymmetry tracks implicit vs explicit. Auto-bootstrap ran off a READ,
// where swapping a user's host bytes as a side effect is indefensible;
// `ensure` is a convergence verb someone typed, and converging to the
// expected version is what it promises (Desktop's post-auth call depends on
// exactly that). Do not "restore" presence-only semantics here to match the
// deleted module - it would break that contract. A caller that wants
// registration repaired WITHOUT touching bytes wants `host service install`,
// which is the narrower tool and still has that behaviour.
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
  // Forwarded to `provisionHost`: runs only once this call has committed to
  // installing, registering or starting a host, never on the no-op fast
  // path. `host ensure` hangs its sign-in pre-flight here.
  readonly beforeMutate: (() => Promise<void>) | null;
  /** See `ProvisionHostOptions.adoption`. Forwarded verbatim. */
  readonly adoption: UpdateMutationCapabilityAdoption | undefined;
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
  opts.runtime.logger.debug("Host ensure source resolved", {
    environment: opts.runtime.environment,
    ...installSourceLogFields(source),
  });
  const isOwnBuild = source.kind === "local-file";
  const satisfaction: HostSatisfactionPolicy = isOwnBuild
    ? { kind: "exact", version: config.version }
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
      satisfaction.kind === "presence" ? "presence-only" : satisfaction.version,
    recordVersionOverride: isOwnBuild ? "cli-build-version" : "none",
    registerService: !opts.noServiceRegister,
  });
  const result = await provisionHost({
    adoption: opts.adoption,
    runtime: opts.runtime,
    resolveInstallSource: () => Promise.resolve(source),
    satisfaction,
    recordVersionOverride: isOwnBuild ? config.version : null,
    enableLinger: opts.enableLinger,
    allowSelfInvocation: opts.allowSelfInvocation,
    registerService: !opts.noServiceRegister,
    lockReason: "host-ensure",
    force: opts.force,
    onProgress: opts.onProgress,
    beforeMutate: opts.beforeMutate,
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
