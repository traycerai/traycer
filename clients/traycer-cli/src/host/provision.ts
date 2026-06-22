import { installHost, type InstallSourceArg } from "../installer";
import { readHostInstallRecord } from "../manifest/host-install";
import type { ProgressInfo } from "../runner/output";
import type { RuntimeContext } from "../runner/runtime";
import {
  createServiceController,
  serviceLabelFor,
  type ServiceController,
  type ServiceLabel,
  type ServiceState,
} from "../service";
import { resolveServiceCliInvocation } from "../service/cli-binary";
import { createServiceInstallLifecycle } from "../service/install-lifecycle";
import { withCliLock } from "../store/cli-lock";
import { assertHostNotBusy } from "./busy-check";

// The single host-provisioning core shared by `host ensure` (the
// desktop's post-auth call) and `maybeAutoBootstrap` (the standalone CLI
// first-run path used by `login` / `host status`). It reads the current
// state, then does the minimal work to reach installed + registered +
// running, reporting exactly what it did.
//
// Source resolution and idempotency policy differ per caller, so both are
// injected: `resolveInstallSource` is only invoked on the install branch,
// and `targetVersion` (null = presence-based) controls the fast no-op.

export type HostProvisionAction =
  | "noop"
  | "installed"
  | "service-registered"
  | "started";

export interface HostProvisionServiceLifecycle {
  readonly priorServiceState: ServiceState;
  readonly stoppedBeforeSwap: boolean;
  readonly postSwapAction: "restart" | "start" | "install" | "none";
  readonly postSwapError: string | null;
}

export interface HostProvisionResult {
  readonly installed: boolean;
  readonly registered: boolean;
  readonly running: boolean;
  readonly version: string | null;
  readonly action: HostProvisionAction;
  // Present only for the full-install branch; null for noop / start /
  // service-only so the caller can tell which path ran.
  readonly serviceLifecycle: HostProvisionServiceLifecycle | null;
  readonly postSwapError: string | null;
}

export interface ProvisionHostOptions {
  readonly runtime: RuntimeContext;
  // Invoked only when an install is actually required.
  readonly resolveInstallSource: () => Promise<InstallSourceArg>;
  // The idempotency key. A concrete value re-installs whenever the install
  // record's version differs; `null` falls back to presence-only. The
  // bundled-host callers pass this build's `config.version` so a rebuilt
  // (same-channel) host is detected and replaced even though there is no
  // semver bump. A registry `--release <semver>` passes that semver.
  readonly targetVersion: string | null;
  // Recorded as the install version for a local-file install (the
  // bundled-host callers pass `config.version` so the recorded version
  // equals `targetVersion` and the next launch is a no-op until the build
  // changes). `null` keeps the installer's derived default.
  readonly recordVersionOverride: string | null;
  readonly enableLinger: boolean;
  readonly allowSelfInvocation: boolean;
  // When false, install the host BYTES only and never touch the OS service
  // (no plist write, no launchctl, no start). The desktop sets this because
  // it registers the macOS login item via SMAppService itself; otherwise the
  // CLI registers and starts the service.
  readonly registerService: boolean;
  readonly lockReason: string;
  readonly onProgress: ((info: ProgressInfo) => void) | null;
  // When true, skip the pre-reinstall busy probe and replace a running host
  // unconditionally (the desktop's "Force restart"). Default callers pass
  // false so in-progress chat/terminal/CLI work is protected.
  readonly force: boolean;
}

interface ProvisionState {
  readonly installed: boolean;
  readonly registered: boolean;
  readonly running: boolean;
  readonly version: string | null;
}

export async function provisionHost(
  opts: ProvisionHostOptions,
): Promise<HostProvisionResult> {
  const progress = opts.onProgress ?? noopProgress;
  const controller = createServiceController();
  const label = serviceLabelFor(opts.runtime.environment);

  // Lock-free fast path: a healthy, already-provisioned host is the
  // overwhelmingly common case (persistent service across launches).
  const fast = await readProvisionState(controller, label, opts.runtime.environment);
  // `--force` (the desktop "Force restart", D5) must reinstall + restart even
  // when the install record already matches, so it never takes the satisfied
  // no-op fast path.
  if (!opts.force && isSatisfied(fast, opts.targetVersion, opts.registerService)) {
    return noopResult(fast);
  }

  return withCliLock(
    {
      environment: opts.runtime.environment,
      reason: opts.lockReason,
      waitMs: 30_000,
      pollIntervalMs: 100,
    },
    async () => {
      // Re-read inside the lock so a caller that lost the race observes the
      // now-provisioned state and short-circuits instead of redundantly
      // downloading.
      const state = await readProvisionState(
        controller,
        label,
        opts.runtime.environment,
      );
      if (
        !opts.force &&
        isSatisfied(state, opts.targetVersion, opts.registerService)
      ) {
        return noopResult(state);
      }
      // Bytes present + at target with host-owned registration: there is
      // nothing to cycle, so no teardown and no busy check are needed.
      if (
        !opts.force &&
        state.installed &&
        versionSatisfied(state, opts.targetVersion) &&
        !opts.registerService
      ) {
        return noopResult(state);
      }
      // Every remaining path replaces or cycles a LIVE host - reinstall
      // (forced, or bytes absent/stale), (re)register, or (re)start - so the
      // busy guard must cover ALL of them, not just `runInstall`. Unless forced,
      // refuse if a live host reports busy (or can't be confirmed idle - fail
      // safe). `assertHostNotBusy` returns when there is no live host to
      // protect, judging liveness from pid.json + the process rather than the OS
      // service-controller `running` flag (unreliable on the macOS host-owned
      // path where the CLI does not own the service registration, and on a
      // status drift where the controller reports stopped while a process is
      // still live and busy).
      if (!opts.force) {
        await assertHostNotBusy(opts.runtime.environment);
      }
      // Reinstall when the bytes are absent/stale, OR when forced (D5: Force =
      // reinstall + restart onto this build even if the install record matches).
      if (
        opts.force ||
        !state.installed ||
        !versionSatisfied(state, opts.targetVersion)
      ) {
        return runInstall(opts, controller, label, progress);
      }
      if (!state.registered) {
        return runServiceRegister(opts, controller, label, progress);
      }
      // installed + registered + stopped → start.
      return runStart(opts, controller, label, state, progress);
    },
  );
}

async function runInstall(
  opts: ProvisionHostOptions,
  controller: ServiceController,
  label: ServiceLabel,
  progress: (info: ProgressInfo) => void,
): Promise<HostProvisionResult> {
  const source = await opts.resolveInstallSource();
  progress({
    stage: "host-provision",
    message:
      source.kind === "local-file"
        ? `installing host from ${source.path}`
        : `installing host (${source.versionRequest})`,
    percent: null,
    bytes: null,
    totalBytes: null,
  });
  // When the host owns service registration, install the bytes with an
  // inert lifecycle that never touches the OS service. Otherwise bootstrap
  // the service post-swap (clean-machine register + start).
  const handle = opts.registerService
    ? createServiceInstallLifecycle({
        environment: opts.runtime.environment,
        bootstrap: {
          enableLinger: opts.enableLinger,
          allowSelfInvocation: opts.allowSelfInvocation,
        },
      })
    : null;
  // Already inside the per-environment CLI lock - call installHost directly
  // (it expects the caller to hold the lock).
  const result = await installHost({
    environment: opts.runtime.environment,
    source,
    onProgress: progress,
    lifecycle: handle !== null ? handle.lifecycle : INERT_LIFECYCLE,
    recordVersionOverride: opts.recordVersionOverride,
  });
  const post = await readProvisionState(controller, label, opts.runtime.environment);
  return {
    installed: true,
    registered: post.registered,
    running: post.running,
    version: result.record.version,
    action: "installed",
    serviceLifecycle:
      handle !== null
        ? {
            priorServiceState: handle.state.priorState,
            stoppedBeforeSwap: handle.state.stoppedBeforeSwap,
            postSwapAction: handle.state.postSwapAction,
            postSwapError: handle.state.postSwapError,
          }
        : null,
    postSwapError: handle !== null ? handle.state.postSwapError : null,
  };
}

// Lifecycle that leaves the OS service entirely untouched - the host
// (desktop SMAppService) owns registration + start.
const INERT_LIFECYCLE = {
  beforeSwap: (): Promise<void> => Promise.resolve(),
  afterSwap: (): Promise<void> => Promise.resolve(),
};

async function runServiceRegister(
  opts: ProvisionHostOptions,
  controller: ServiceController,
  label: ServiceLabel,
  progress: (info: ProgressInfo) => void,
): Promise<HostProvisionResult> {
  progress({
    stage: "host-provision",
    message: "registering OS service for installed host",
    percent: null,
    bytes: null,
    totalBytes: null,
  });
  const cli = await resolveServiceCliInvocation({
    environment: opts.runtime.environment,
    override: null,
    allowSelfInvocation: opts.allowSelfInvocation,
  });
  await controller.install({ label, cli, enableLinger: opts.enableLinger });
  const post = await readProvisionState(controller, label, opts.runtime.environment);
  return {
    installed: true,
    registered: post.registered,
    running: post.running,
    version: post.version,
    action: "service-registered",
    serviceLifecycle: null,
    postSwapError: null,
  };
}

async function runStart(
  opts: ProvisionHostOptions,
  controller: ServiceController,
  label: ServiceLabel,
  state: ProvisionState,
  progress: (info: ProgressInfo) => void,
): Promise<HostProvisionResult> {
  progress({
    stage: "host-provision",
    message: "starting the registered host service",
    percent: null,
    bytes: null,
    totalBytes: null,
  });
  await controller.start(label);
  const post = await readProvisionState(controller, label, opts.runtime.environment);
  return {
    installed: true,
    registered: post.registered,
    running: post.running,
    version: state.version,
    action: "started",
    serviceLifecycle: null,
    postSwapError: null,
  };
}

async function readProvisionState(
  controller: ServiceController,
  label: ServiceLabel,
  environment: RuntimeContext["environment"],
): Promise<ProvisionState> {
  // A malformed install record (or status probe failure) is treated as
  // "not present" so provisioning self-heals rather than wedging.
  let recordVersion: string | null = null;
  let installed = false;
  try {
    const record = await readHostInstallRecord(environment);
    if (record !== null) {
      installed = true;
      recordVersion = record.version;
    }
  } catch {
    installed = false;
  }
  let registered = false;
  let running = false;
  try {
    const status = await controller.status(label);
    registered = status.state !== "not-installed";
    running = status.state === "running";
  } catch {
    registered = false;
    running = false;
  }
  return { installed, registered, running, version: recordVersion };
}

// "latest", `--from`, and the packaged archive carry synthetic local
// versions that can't be string-compared, so presence is the only
// idempotency signal for them (targetVersion === null). A concrete semver
// can be matched against the install record without a registry probe.
function versionSatisfied(
  state: ProvisionState,
  targetVersion: string | null,
): boolean {
  if (!state.installed) return false;
  if (targetVersion === null) return true;
  return state.version === targetVersion;
}

function isSatisfied(
  state: ProvisionState,
  targetVersion: string | null,
  registerService: boolean,
): boolean {
  if (!versionSatisfied(state, targetVersion)) {
    return false;
  }
  // Host-owned registration: only the bytes are the CLI's concern.
  if (!registerService) {
    return state.installed;
  }
  return state.installed && state.registered && state.running;
}

function noopResult(state: ProvisionState): HostProvisionResult {
  return {
    installed: state.installed,
    registered: state.registered,
    running: state.running,
    version: state.version,
    action: "noop",
    serviceLifecycle: null,
    postSwapError: null,
  };
}

function noopProgress(_info: ProgressInfo): void {
  // Default sink - provisioning should never be louder than the command
  // that triggered it.
}
