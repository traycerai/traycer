import { config } from "../config";
import type { InstallSourceArg } from "../installer";
import { resolveBundledHostArchive } from "../installer/bundled-host";
import { errorFromUnknown } from "../logger";
import { readHostInstallRecord } from "../manifest/host-install";
import { CliError } from "../runner/errors";
import type { ProgressInfo } from "../runner/output";
import type { RuntimeContext } from "../runner/runtime";
import { createServiceController, serviceLabelFor } from "../service";
import { provisionHost, type HostProvisionResult } from "./provision";
import { defaultRegistryHostVersionRequest } from "./supported-host-version";
import { installSourceLogFields } from "./install-source-log-fields";

// Centralized auto-bootstrap for the standalone CLI. Per Core Flow 7
// (Standalone CLI First-Run), commands like `traycer login` and any
// host-dependent read auto-install the host + register the OS service
// on first run.
//
// The actual install/register/start orchestration is shared with
// `host ensure` via `provisionHost` (host/provision.ts) - this module
// only adds the auto-bootstrap policy (skip in CI / `--no-bootstrap`, env-
// driven offline source) and projects the shared result back into the
// `AutoBootstrapDecision` shape that `login` / `host status` render.
//
// Behavior matrix:
//   noBootstrap=true                 → status="skipped"
//   nonInteractive AND not ready     → status="skipped" (can't prompt in CI)
//   install record present + svc     → status="ready"
//   install record present, no svc   → service-only registration (no
//                                       download, no install-dir swap)
//   otherwise                        → install bundled/supported host +
//                                       register/start

export type AutoBootstrapReason =
  | "explicit-no-bootstrap"
  | "noninteractive-cannot-prompt"
  | "already-installed"
  | "installed"
  | "service-registered"
  | "install-failed"
  | "service-registration-failed"
  | "service-registration-warning";

export type AutoBootstrapStatus =
  "skipped" | "ready" | "installed" | "service-registered" | "failed";

export interface AutoBootstrapDecision {
  readonly status: AutoBootstrapStatus;
  readonly reason: AutoBootstrapReason;
  readonly hostInstalled: boolean;
  readonly serviceRegistered: boolean;
  readonly installedVersion: string | null;
  readonly postSwapError: string | null;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details: Record<string, unknown> | null;
  } | null;
}

export interface AutoBootstrapOptions {
  readonly runtime: RuntimeContext;
  readonly trigger: "login" | "host-status" | "other";
  readonly onProgress: ((info: ProgressInfo) => void) | null;
}

export async function detectBootstrapState(runtime: RuntimeContext): Promise<{
  readonly hostInstalled: boolean;
  readonly serviceRegistered: boolean;
}> {
  let hostInstalled = false;
  try {
    hostInstalled = (await readHostInstallRecord(runtime.environment)) !== null;
  } catch (err) {
    runtime.logger.warn("Auto-bootstrap install record probe failed", {
      environment: runtime.environment,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    hostInstalled = false;
  }

  let serviceRegistered = false;
  try {
    const label = serviceLabelFor(runtime.environment);
    const status = await createServiceController().status(label);
    // `externally-managed` (Desktop-owned SMAppService label) counts as
    // registered: a registration exists, it just isn't the CLI's to repair.
    // Treating it as unregistered used to send every `traycer login` on a
    // Desktop-managed machine into the "service repair" branch, straight
    // into `installService`'s SMAppService refusal.
    serviceRegistered = status.state !== "not-installed";
  } catch (err) {
    runtime.logger.warn("Auto-bootstrap service status probe failed", {
      environment: runtime.environment,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    serviceRegistered = false;
  }

  runtime.logger.debug("Auto-bootstrap state detected", {
    environment: runtime.environment,
    hostInstalled,
    serviceRegistered,
  });
  return { hostInstalled, serviceRegistered };
}

// Pure data - no side effects. Decides whether bootstrap should run, be
// skipped, or whether the host is already up. Used by callers that want
// to inspect the decision before invoking the install pipeline (e.g. tests),
// and by `maybeAutoBootstrap` to gate the shared `provisionHost` call.
export async function evaluateAutoBootstrap(
  opts: AutoBootstrapOptions,
): Promise<AutoBootstrapDecision> {
  opts.runtime.logger.debug("Auto-bootstrap evaluation started", {
    environment: opts.runtime.environment,
    trigger: opts.trigger,
    noBootstrap: opts.runtime.noBootstrap,
    nonInteractive: opts.runtime.nonInteractive,
  });
  const state = await detectBootstrapState(opts.runtime);

  if (state.hostInstalled && state.serviceRegistered) {
    opts.runtime.logger.debug("Auto-bootstrap skipped; host already ready", {
      environment: opts.runtime.environment,
      trigger: opts.trigger,
    });
    return {
      status: "ready",
      reason: "already-installed",
      hostInstalled: true,
      serviceRegistered: true,
      installedVersion: null,
      postSwapError: null,
      error: null,
    };
  }

  if (opts.runtime.noBootstrap) {
    opts.runtime.logger.debug("Auto-bootstrap skipped by flag", {
      environment: opts.runtime.environment,
      trigger: opts.trigger,
      hostInstalled: state.hostInstalled,
      serviceRegistered: state.serviceRegistered,
    });
    return {
      status: "skipped",
      reason: "explicit-no-bootstrap",
      hostInstalled: state.hostInstalled,
      serviceRegistered: state.serviceRegistered,
      installedVersion: null,
      postSwapError: null,
      error: null,
    };
  }

  if (opts.runtime.nonInteractive) {
    opts.runtime.logger.debug(
      "Auto-bootstrap skipped in non-interactive runtime",
      {
        environment: opts.runtime.environment,
        trigger: opts.trigger,
        hostInstalled: state.hostInstalled,
        serviceRegistered: state.serviceRegistered,
      },
    );
    return {
      status: "skipped",
      reason: "noninteractive-cannot-prompt",
      hostInstalled: state.hostInstalled,
      serviceRegistered: state.serviceRegistered,
      installedVersion: null,
      postSwapError: null,
      error: null,
    };
  }

  // Host installed but the OS service is missing - repair the service
  // registration without touching the install dir. The caller invokes
  // `maybeAutoBootstrap` so the shared core actually fires; this evaluator
  // stays pure.
  if (state.hostInstalled && !state.serviceRegistered) {
    opts.runtime.logger.info("Auto-bootstrap selected service repair", {
      environment: opts.runtime.environment,
      trigger: opts.trigger,
    });
    return {
      status: "service-registered",
      reason: "service-registered",
      hostInstalled: true,
      serviceRegistered: false,
      installedVersion: null,
      postSwapError: null,
      error: null,
    };
  }

  // "would proceed to a full install" placeholder.
  opts.runtime.logger.info("Auto-bootstrap selected full install", {
    environment: opts.runtime.environment,
    trigger: opts.trigger,
    hostInstalled: state.hostInstalled,
    serviceRegistered: state.serviceRegistered,
  });
  return {
    status: "installed",
    reason: "installed",
    hostInstalled: state.hostInstalled,
    serviceRegistered: state.serviceRegistered,
    installedVersion: null,
    postSwapError: null,
    error: null,
  };
}

// Drive the shared provisioning core when bootstrap should proceed. This is
// the surface `login` and `host status` call.
//   - "ready" / "skipped" decisions are returned unchanged.
//   - otherwise: run `provisionHost` (env-driven offline source, no
//     source policy) and project its result back to an
//     `AutoBootstrapDecision`.
//
// Failures are converted to a stable machine-readable decision rather than
// thrown - callers want to render their payload AND surface the outcome.
export async function maybeAutoBootstrap(
  opts: AutoBootstrapOptions,
): Promise<AutoBootstrapDecision> {
  const decision = await evaluateAutoBootstrap(opts);
  if (
    decision.status !== "service-registered" &&
    decision.status !== "installed"
  ) {
    // "skipped" or "ready" - nothing to do.
    opts.runtime.logger.debug("Auto-bootstrap returning without provisioning", {
      environment: opts.runtime.environment,
      trigger: opts.trigger,
      status: decision.status,
      reason: decision.reason,
    });
    return decision;
  }
  const isServiceOnly = decision.status === "service-registered";
  try {
    // Pre-resolve so we can key idempotency on our own bundled host (a
    // local-file source carrying this build's `config.version`). A rebuilt
    // host then differs from the install record and is replaced; a pinned
    // registry fallback uses the CLI's stamped supported host version when
    // present.
    const source = await resolveAutoBootstrapSource();
    opts.runtime.logger.debug("Auto-bootstrap source resolved", {
      environment: opts.runtime.environment,
      trigger: opts.trigger,
      serviceOnly: isServiceOnly,
      ...installSourceLogFields(source),
    });
    const isOwnBuild = source.kind === "local-file";
    const targetVersion =
      source.kind === "registry" && source.versionRequest !== "latest"
        ? source.versionRequest
        : null;
    const installTargetVersion = isServiceOnly
      ? null
      : isOwnBuild
        ? config.version
        : targetVersion;
    const recordVersionOverride =
      isServiceOnly || !isOwnBuild ? null : config.version;
    const result = await provisionHost({
      runtime: opts.runtime,
      resolveInstallSource: () => Promise.resolve(source),
      targetVersion: installTargetVersion,
      recordVersionOverride,
      enableLinger: true,
      // First-run via standalone CLI: the SEA binary is the running
      // process, so allow registering the service against it when no CLI
      // manifest exists yet.
      allowSelfInvocation: true,
      // Standalone CLI first-run owns the full lifecycle, including OS
      // service registration (there is no .app/SMAppService here).
      registerService: true,
      lockReason: `auto-bootstrap:${opts.trigger}`,
      // Auto-bootstrap only runs when no host is installed/registered yet,
      // so there is never in-progress work to protect; the busy probe would
      // be a no-op anyway.
      force: false,
      onProgress: opts.onProgress,
    });
    const projected = projectProvisionResult(result);
    opts.runtime.logger.info("Auto-bootstrap provisioning completed", {
      environment: opts.runtime.environment,
      trigger: opts.trigger,
      status: projected.status,
      reason: projected.reason,
      action: result.action,
      hostInstalled: projected.hostInstalled,
      serviceRegistered: projected.serviceRegistered,
      hasPostSwapError: projected.postSwapError !== null,
    });
    return projected;
  } catch (cause) {
    opts.runtime.logger.error(
      "Auto-bootstrap provisioning failed",
      {
        environment: opts.runtime.environment,
        trigger: opts.trigger,
        serviceOnly: isServiceOnly,
      },
      errorFromUnknown(cause),
    );
    const post = await detectBootstrapState(opts.runtime);
    const error = toErrorPayload(cause);
    return {
      status: "failed",
      reason: isServiceOnly ? "service-registration-failed" : "install-failed",
      hostInstalled: post.hostInstalled,
      serviceRegistered: post.serviceRegistered,
      installedVersion: null,
      postSwapError: error.message,
      error,
    };
  }
}

function projectProvisionResult(
  result: HostProvisionResult,
): AutoBootstrapDecision {
  if (result.action === "service-registered") {
    return {
      status: "service-registered",
      reason: "service-registered",
      hostInstalled: result.installed,
      serviceRegistered: result.registered,
      installedVersion: result.version,
      postSwapError: null,
      error: null,
    };
  }
  if (result.action === "installed") {
    return {
      status: "installed",
      reason:
        result.postSwapError !== null
          ? "service-registration-warning"
          : "installed",
      hostInstalled: result.installed,
      serviceRegistered: result.registered,
      installedVersion: result.version,
      postSwapError: result.postSwapError,
      error: null,
    };
  }
  // "noop" or "started" - the host is up.
  return {
    status: "ready",
    reason: "already-installed",
    hostInstalled: result.installed,
    serviceRegistered: result.registered,
    installedVersion: result.version,
    postSwapError: null,
    error: null,
  };
}

// Dogfood / offline iteration (Core Flow 10): when a host-runtime archive
// is packaged alongside the CLI (`resolveBundledHostArchive()`), install
// from it; otherwise fetch the CLI build's supported host version when one is
// stamped, falling back to `latest` for dev/manual CLI builds. Lets
// `traycer login` / `host status` bootstrap a self-contained, offline host.
async function resolveAutoBootstrapSource(): Promise<InstallSourceArg> {
  const bundled = await resolveBundledHostArchive();
  return bundled !== null
    ? { kind: "local-file", path: bundled }
    : { kind: "registry", versionRequest: defaultRegistryHostVersionRequest() };
}

function toErrorPayload(cause: unknown): {
  readonly code: string;
  readonly message: string;
  readonly details: Record<string, unknown> | null;
} {
  if (cause instanceof CliError) {
    return {
      code: cause.code,
      message: cause.message,
      details: cause.details,
    };
  }
  if (cause instanceof Error) {
    return { code: "E_UNEXPECTED", message: cause.message, details: null };
  }
  return { code: "E_UNEXPECTED", message: String(cause), details: null };
}
