import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import {
  commitHostInstallSource,
  discardStagedHostInstallSource,
  stageHostInstallSource,
  type InstallSourceArg,
  type StagedHostInstallSource,
} from "../installer";
import { readHostInstallRecord } from "../manifest/host-install";
import type { Environment } from "../runner/environment";
import type { ProgressInfo } from "../runner/output";
import type { RuntimeContext } from "../runner/runtime";
import { errorFromUnknown } from "../logger";
import {
  createServiceController,
  serviceLabelFor,
  type ServiceController,
  type ServiceLabel,
  type ServiceState,
} from "../service";
import { resolveServiceCliInvocation } from "../service/cli-binary";
import {
  createBytesOnlyInstallLifecycle,
  createServiceInstallLifecycle,
} from "../service/install-lifecycle";
import { withCliLock } from "../store/cli-lock";
import {
  createRegistryYankLookup,
  type RegistryYankLookup,
} from "../registry/client";
import { compareHostVersions } from "@traycer-clients/shared/host-version/compare-host-versions";
import { CLI_ERROR_CODES, CliError } from "../runner/errors";
import { assertHostNotBusy } from "./busy-check";

// The single host-provisioning core shared by `host ensure` (the
// desktop's post-auth call) and `maybeAutoBootstrap` (the standalone CLI
// first-run path used by `login` / `host status`). It reads the current
// state, then does the minimal work to reach installed + registered +
// running, reporting exactly what it did.
//
// Source resolution and idempotency policy differ per caller, so both are
// injected: `resolveInstallSource` is only invoked on the install branch,
// and `satisfaction` (presence / exact / implicit-registry-minimum, finding
// D) controls the fast no-op.

export type HostProvisionAction =
  "noop" | "installed" | "service-registered" | "started";

export interface HostProvisionServiceLifecycle {
  readonly priorServiceState: ServiceState;
  readonly stoppedBeforeSwap: boolean;
  // Wider than `service/install-lifecycle.ts`'s own
  // `ServiceInstallLifecycleState.postSwapAction` (`"install" | "none"` -
  // narrowed there because a binary swap must never plain start/restart a
  // cached macOS launchd definition). The install branch's value here is
  // still transitively constrained to that narrower set (it's copied
  // straight from the lifecycle handle below), but `runServiceRegister`/
  // `runStart` never touch a swap at all - `"install"` accurately reports
  // a first-time register+start, and `"start"` accurately reports a plain
  // start of an already-correctly-configured, already-registered service.
  // Neither is the unsafe post-swap case the narrower type guards against;
  // `"restart"` is omitted because nothing on this path ever produces it.
  readonly postSwapAction: "start" | "install" | "none";
  readonly postSwapError: string | null;
}

export interface HostProvisionResult {
  readonly installed: boolean;
  readonly registered: boolean;
  readonly running: boolean;
  readonly version: string | null;
  // The installed archive's own build stamp (install record
  // `runtimeVersion`) - what the running host will actually report. Display
  // truth only; `version` remains the idempotency identity.
  readonly runtimeVersion: string | null;
  readonly action: HostProvisionAction;
  // Present on every branch that starts or cycles the service (install,
  // service-register, start) so the caller can attribute a subsequent
  // readiness observation to THIS command's cycle; `null` only on noop,
  // where nothing was touched (Tech Plan, "Attested generation in
  // results": ensure's cycle/start outcome extends this payload beyond
  // the install branch it was previously scoped to).
  readonly serviceLifecycle: HostProvisionServiceLifecycle | null;
  readonly postSwapError: string | null;
  // The canonical install-generation fingerprint, read/minted under the
  // lock on every branch that starts or cycles the service - never a
  // later disk re-read, so the controller can't race a subsequent
  // mutation. `null` on noop: nothing was attested because nothing ran.
  readonly installGeneration: string | null;
}

// The installed-version predicate for a provisioning run (RCA finding D).
// Local files and an explicit `--release` request demand an exact match;
// the build-stamped registry default accepts an installed version NEWER
// than the target (a host updated out-of-band must not be downgraded back
// to the stamped build), yank-checked against the manifest and fail-open.
export type HostSatisfactionPolicy =
  | { readonly kind: "presence" }
  | { readonly kind: "exact"; readonly version: string }
  | { readonly kind: "implicit-registry-minimum"; readonly version: string };

export interface ProvisionHostOptions {
  readonly runtime: RuntimeContext;
  // Invoked only when an install is actually required.
  readonly resolveInstallSource: () => Promise<InstallSourceArg>;
  // The idempotency predicate. `exact`/`presence` behave like the old
  // `targetVersion` concrete/`null`; the bundled-host callers pass this
  // build's `config.version` as `exact` so a rebuilt (same-channel) host is
  // detected and replaced even without a semver bump. The registry default
  // uses `implicit-registry-minimum` so a newer non-yanked install is kept.
  readonly satisfaction: HostSatisfactionPolicy;
  // Recorded as the install version for a local-file install (the
  // bundled-host callers pass `config.version` so the recorded version
  // matches the exact satisfaction policy and the next launch is a no-op
  // until the build changes). `null` keeps the installer's derived default.
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
  readonly runtimeVersion: string | null;
}

export async function provisionHost(
  opts: ProvisionHostOptions,
): Promise<HostProvisionResult> {
  const progress = opts.onProgress ?? noopProgress;
  const controller = createServiceController();
  const label = serviceLabelFor(opts.runtime.environment);
  // The manifest fetch is shareable across state snapshots within this run
  // (finding D). Created once and threaded through the locked re-reads so a
  // lock-race loser re-evaluates the winner's install record without a
  // second network probe.
  const yankLookup = createRegistryYankLookup(opts.runtime.environment);
  opts.runtime.logger.info("Host provisioning started", {
    environment: opts.runtime.environment,
    registerService: opts.registerService,
    force: opts.force,
    satisfactionKind: opts.satisfaction.kind,
    satisfactionVersion:
      opts.satisfaction.kind === "presence"
        ? "presence-only"
        : opts.satisfaction.version,
    recordVersionOverride: opts.recordVersionOverride !== null,
    lockReason: opts.lockReason,
  });

  // Lock-free fast path: a healthy, already-provisioned host is the
  // overwhelmingly common case (persistent service across launches).
  const fast = await readProvisionState(controller, label, opts.runtime);
  opts.runtime.logger.debug("Host provisioning fast-path state read", {
    environment: opts.runtime.environment,
    installed: fast.installed,
    registered: fast.registered,
    running: fast.running,
    hasVersion: fast.version !== null,
  });
  // `--force` (the desktop "Force restart", D5) must reinstall + restart even
  // when the install record already matches, so it never takes the satisfied
  // no-op fast path.
  if (
    !opts.force &&
    (await isSatisfied(
      fast,
      opts.satisfaction,
      opts.registerService,
      yankLookup,
    ))
  ) {
    opts.runtime.logger.debug("Host provisioning fast-path satisfied", {
      environment: opts.runtime.environment,
      installed: fast.installed,
      registered: fast.registered,
      running: fast.running,
      registerService: opts.registerService,
    });
    return noopResult(fast);
  }
  // Lock-scope restructure (Tech Plan): when the fast read already predicts
  // the install branch will run, resolve + stage (download/verify/extract)
  // OUTSIDE cli-lock, into an owner-tokened temp - the same split `host
  // install` uses - so a long download never blocks a concurrent CLI/
  // Desktop operation. The prediction is re-verified against a locked
  // re-read below.
  const predictedInstall =
    opts.force ||
    !fast.installed ||
    !(await versionSatisfied(fast, opts.satisfaction, yankLookup));
  const preStaged = predictedInstall
    ? await prepareInstallStage(opts, progress)
    : null;

  return provisionUnderLock(
    opts,
    controller,
    label,
    progress,
    preStaged,
    yankLookup,
  );
}

// A lost prediction ("no install needed" at the fast read, but the locked
// re-read now selects the install branch - only possible via a genuinely
// concurrent provisioning actor) must never fall back to staging INSIDE
// cli-lock: staging is a network transfer, and the plan's no-transfer-in-
// a-critical-section rule is absolute, not "vanishingly rare so it's fine
// to bend once." So a lost prediction returns a `"need-stage"` signal from
// the locked callback instead of staging there; the lock is released,
// staging happens outside it (same as the initial prediction), and the
// whole attempt retries with the freshly staged source - at most one
// retry, since the retry's `preStaged` is never null, so `"need-stage"`
// cannot recur.
type ProvisionAttemptOutcome =
  | { readonly kind: "result"; readonly result: HostProvisionResult }
  | { readonly kind: "need-stage" };

async function provisionUnderLock(
  opts: ProvisionHostOptions,
  controller: ServiceController,
  label: ServiceLabel,
  progress: (info: ProgressInfo) => void,
  preStaged: StagedHostInstallSource | null,
  yankLookup: RegistryYankLookup,
): Promise<HostProvisionResult> {
  let stagedConsumed = false;
  opts.runtime.logger.debug("Host provisioning entering CLI lock", {
    environment: opts.runtime.environment,
    lockReason: opts.lockReason,
    force: opts.force,
    preStaged: preStaged !== null,
  });
  try {
    const outcome = await withCliLock(
      {
        environment: opts.runtime.environment,
        reason: opts.lockReason,
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      async (): Promise<ProvisionAttemptOutcome> => {
        // Re-read inside the lock so a caller that lost the race observes the
        // now-provisioned state and short-circuits instead of redundantly
        // downloading.
        const state = await readProvisionState(controller, label, opts.runtime);
        opts.runtime.logger.debug("Host provisioning locked state read", {
          environment: opts.runtime.environment,
          installed: state.installed,
          registered: state.registered,
          running: state.running,
          hasVersion: state.version !== null,
        });
        if (
          !opts.force &&
          (await isSatisfied(
            state,
            opts.satisfaction,
            opts.registerService,
            yankLookup,
          ))
        ) {
          opts.runtime.logger.debug(
            "Host provisioning satisfied after lock recheck",
            {
              environment: opts.runtime.environment,
              installed: state.installed,
              registered: state.registered,
              running: state.running,
            },
          );
          return { kind: "result", result: noopResult(state) };
        }
        // Bytes present + at target with host-owned registration: there is
        // nothing to cycle, so no teardown and no busy check are needed.
        if (
          !opts.force &&
          state.installed &&
          (await versionSatisfied(state, opts.satisfaction, yankLookup)) &&
          !opts.registerService
        ) {
          opts.runtime.logger.debug(
            "Host provisioning no-op for host-owned service registration",
            {
              environment: opts.runtime.environment,
              installed: state.installed,
              hasVersion: state.version !== null,
            },
          );
          return { kind: "result", result: noopResult(state) };
        }
        // Every remaining path replaces or cycles a LIVE host - reinstall
        // (forced, or bytes absent/stale), (re)register, or (re)start - so the
        // busy guard must cover ALL of them, not just the install branch.
        // Unless forced, refuse if a live host reports busy (or can't be
        // confirmed idle - fail safe). `assertHostNotBusy` returns when there
        // is no live host to protect, judging liveness from pid.json + the
        // process rather than the OS service-controller `running` flag
        // (unreliable on the macOS host-owned path where the CLI does not own
        // the service registration, and on a status drift where the
        // controller reports stopped while a process is still live and busy).
        if (!opts.force) {
          opts.runtime.logger.debug("Host provisioning running busy guard", {
            environment: opts.runtime.environment,
            reason: opts.lockReason,
          });
          await assertHostNotBusy(opts.runtime.environment);
        } else {
          opts.runtime.logger.warn(
            "Host provisioning skipped busy guard because force=true",
            {
              environment: opts.runtime.environment,
              reason: opts.lockReason,
            },
          );
        }
        // Reinstall when the bytes are absent/stale, OR when forced (D5: Force =
        // reinstall + restart onto this build even if the install record matches).
        // Evaluate the (async, yank-checked) predicate once and reuse it for
        // both the branch decision and the log so the manifest lookup runs at
        // most once here.
        const reinstallVersionSatisfied = await versionSatisfied(
          state,
          opts.satisfaction,
          yankLookup,
        );
        if (opts.force || !state.installed || !reinstallVersionSatisfied) {
          if (preStaged === null) {
            opts.runtime.logger.debug(
              "Host provisioning lost the fast-path prediction; releasing the lock to stage outside it",
              { environment: opts.runtime.environment },
            );
            return { kind: "need-stage" };
          }
          opts.runtime.logger.debug(
            "Host provisioning selected install branch",
            {
              environment: opts.runtime.environment,
              force: opts.force,
              installed: state.installed,
              versionSatisfied: reinstallVersionSatisfied,
            },
          );
          stagedConsumed = true;
          return {
            kind: "result",
            result: await commitInstall(
              opts,
              controller,
              label,
              progress,
              preStaged,
            ),
          };
        }
        if (!state.registered) {
          opts.runtime.logger.debug(
            "Host provisioning selected service-register branch",
            {
              environment: opts.runtime.environment,
            },
          );
          return {
            kind: "result",
            result: await runServiceRegister(opts, controller, label, progress),
          };
        }
        // installed + registered + stopped → start.
        opts.runtime.logger.debug(
          "Host provisioning selected service-start branch",
          {
            environment: opts.runtime.environment,
          },
        );
        return {
          kind: "result",
          result: await runStart(opts, controller, label, state, progress),
        };
      },
    );
    if (outcome.kind === "result") {
      return outcome.result;
    }
    // Lock released. Stage outside it (network transfer never runs inside
    // cli-lock), then reacquire and retry - `preStaged` is non-null on this
    // retry, so the callback above cannot select `"need-stage"` again.
    const staged = await prepareInstallStage(opts, progress);
    return provisionUnderLock(
      opts,
      controller,
      label,
      progress,
      staged,
      yankLookup,
    );
  } finally {
    // Anything staged in anticipation of the install branch that the lock
    // callback never consumed (raced to noop/register/start, or an earlier
    // step inside the callback threw before reaching `commitInstall`) must
    // be scrubbed here. Once `commitInstall` runs, `commitHostInstallSource`
    // owns cleanup itself - never double-discard.
    if (preStaged !== null && !stagedConsumed) {
      await discardStagedHostInstallSource(opts.runtime.environment, preStaged);
    }
  }
}

async function prepareInstallStage(
  opts: ProvisionHostOptions,
  progress: (info: ProgressInfo) => void,
): Promise<StagedHostInstallSource> {
  const source = await opts.resolveInstallSource();
  opts.runtime.logger.debug("Host provisioning install source resolved", {
    environment: opts.runtime.environment,
    sourceKind: source.kind,
    versionRequest:
      source.kind === "registry" ? source.versionRequest : "local-file",
    registerService: opts.registerService,
  });
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
  return stageHostInstallSource({
    environment: opts.runtime.environment,
    source,
    onProgress: progress,
    recordVersionOverride: opts.recordVersionOverride,
  });
}

async function commitInstall(
  opts: ProvisionHostOptions,
  controller: ServiceController,
  label: ServiceLabel,
  progress: (info: ProgressInfo) => void,
  staged: StagedHostInstallSource,
): Promise<HostProvisionResult> {
  // When the host owns service registration, install the bytes without service
  // bootstrap. On Windows, still stop the slot first so stale processes do not
  // keep the install directory open during the swap.
  const handle = opts.registerService
    ? createServiceInstallLifecycle({
        environment: opts.runtime.environment,
        bootstrap: {
          enableLinger: opts.enableLinger,
          allowSelfInvocation: opts.allowSelfInvocation,
        },
      })
    : null;
  const lifecycle =
    handle !== null
      ? handle.lifecycle
      : createBytesOnlyInstallLifecycle(controller, label);
  opts.runtime.logger.debug("Host provisioning install lifecycle prepared", {
    environment: opts.runtime.environment,
    lifecycleEnabled: handle !== null,
    preSwapCleanupEnabled: handle === null && process.platform === "win32",
  });
  // Already inside the per-environment CLI lock - commit the pre-staged
  // source directly (it expects the caller to hold the lock). Reconcile
  // wiring (Tech Plan: "Install/ensure re-run reconcile after a successful
  // commit") comes from `commitHostInstallSource` itself.
  const result = await commitHostInstallSource({
    environment: opts.runtime.environment,
    staged,
    onProgress: progress,
    lifecycle,
  });
  const post = await readProvisionState(controller, label, opts.runtime);
  opts.runtime.logger.info("Host provisioning install branch completed", {
    environment: opts.runtime.environment,
    version: result.record.version,
    previousVersion: result.previous?.version ?? null,
    registered: post.registered,
    running: post.running,
    postSwapAction: handle !== null ? handle.state.postSwapAction : "none",
    hasPostSwapError: handle !== null && handle.state.postSwapError !== null,
  });
  return {
    installed: true,
    registered: post.registered,
    running: post.running,
    version: result.record.version,
    runtimeVersion: result.record.runtimeVersion,
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
    installGeneration: result.installGeneration,
  };
}

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
  opts.runtime.logger.debug(
    "Host provisioning service CLI invocation resolved",
    {
      environment: opts.runtime.environment,
      argCount: cli.args.length,
      enableLinger: opts.enableLinger,
      allowSelfInvocation: opts.allowSelfInvocation,
    },
  );
  await controller.install({ label, cli, enableLinger: opts.enableLinger });
  const post = await readProvisionState(controller, label, opts.runtime);
  const installGeneration = await attestedGenerationFromCurrentRecord(
    opts.runtime.environment,
  );
  opts.runtime.logger.info(
    "Host provisioning service-register branch completed",
    {
      environment: opts.runtime.environment,
      registered: post.registered,
      running: post.running,
    },
  );
  return {
    installed: true,
    registered: post.registered,
    running: post.running,
    version: post.version,
    runtimeVersion: post.runtimeVersion,
    action: "service-registered",
    // `controller.install` both registers and starts the service -
    // `postSwapAction: "install"` mirrors the install branch's own
    // bootstrap-registration facts (`service/install-lifecycle.ts`'s
    // `afterSwap`) for the same first-registration case.
    serviceLifecycle: {
      priorServiceState: "not-installed",
      stoppedBeforeSwap: false,
      postSwapAction: "install",
      postSwapError: null,
    },
    postSwapError: null,
    installGeneration,
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
  // First attempt: plain start (on win32 this already polls for post-baseline
  // spawn evidence and surfaces Last Run Result on failure - finding F).
  try {
    await controller.start(label);
  } catch (firstError) {
    // Escalate once: full task/launcher rewrite (the install-branch
    // registration - the field-proven manual recovery "we had to manually
    // `service install`") -> retry start -> then an honest error. Exactly one
    // rewrite; a second failure does not loop.
    opts.runtime.logger.warn(
      "Host provisioning start failed; escalating once with full service re-register",
      {
        environment: opts.runtime.environment,
        errorName: errorFromUnknown(firstError).name,
        errorMessage: errorFromUnknown(firstError).message,
      },
    );
    progress({
      stage: "host-provision",
      message: "repairing host service definition and retrying start",
      percent: null,
      bytes: null,
      totalBytes: null,
    });
    const cli = await resolveServiceCliInvocation({
      environment: opts.runtime.environment,
      override: null,
      allowSelfInvocation: opts.allowSelfInvocation,
    });
    let rewriteError: unknown = null;
    try {
      await controller.install({
        label,
        cli,
        enableLinger: opts.enableLinger,
      });
    } catch (cause) {
      // A retry is valid only after the rewritten task was successfully
      // registered and its own `/Run`/verification failed. Retrying after a
      // failed definition write would start the stale task and mask the repair
      // failure as success.
      if (
        !(cause instanceof CliError) ||
        cause.code !== CLI_ERROR_CODES.SERVICE_CONTROL_FAILED
      ) {
        opts.runtime.logger.error(
          "Host provisioning service definition rewrite failed after start failure",
          {
            environment: opts.runtime.environment,
            firstErrorName: errorFromUnknown(firstError).name,
            firstErrorMessage: errorFromUnknown(firstError).message,
          },
          errorFromUnknown(cause),
        );
        throw cause;
      }
      rewriteError = cause;
      opts.runtime.logger.error(
        "Host provisioning service rewrite launch failed after start failure; retrying the rewritten service once",
        {
          environment: opts.runtime.environment,
          firstErrorName: errorFromUnknown(firstError).name,
          firstErrorMessage: errorFromUnknown(firstError).message,
        },
        errorFromUnknown(cause),
      );
    }
    // Service installation is itself the recovery launch: Windows verifies
    // the `/Run` issued while recreating its task, and the other controllers
    // start as part of registration. A second Windows `/Run` would baseline
    // after that evidence; IgnoreNew then suppresses it and reports a healthy
    // repaired host as failed. Only retry when install's own launch failed.
    if (rewriteError !== null) {
      try {
        await controller.start(label);
      } catch (retryError) {
        opts.runtime.logger.error(
          "Host provisioning start still failed after service rewrite",
          {
            environment: opts.runtime.environment,
            firstErrorName: errorFromUnknown(firstError).name,
            firstErrorMessage: errorFromUnknown(firstError).message,
          },
          errorFromUnknown(retryError),
        );
        throw retryError;
      }
    }
    opts.runtime.logger.info(
      "Host provisioning start recovered via one-shot service rewrite",
      {
        environment: opts.runtime.environment,
      },
    );
  }
  const post = await readProvisionState(controller, label, opts.runtime);
  const installGeneration = await attestedGenerationFromCurrentRecord(
    opts.runtime.environment,
  );
  opts.runtime.logger.info("Host provisioning service-start branch completed", {
    environment: opts.runtime.environment,
    registered: post.registered,
    running: post.running,
  });
  return {
    installed: true,
    registered: post.registered,
    running: post.running,
    version: state.version,
    runtimeVersion: state.runtimeVersion,
    action: "started",
    // Reached only when installed + registered + stopped (see the branch
    // selection above) - the service was registered but not running before
    // this call.
    serviceLifecycle: {
      priorServiceState: "stopped",
      stoppedBeforeSwap: false,
      postSwapAction: "start",
      postSwapError: null,
    },
    postSwapError: null,
    installGeneration,
  };
}

// Reads the current install record under the caller's already-held
// cli-lock and encodes its canonical generation - used by the
// service-register/start branches, which don't touch install bytes but
// still owe the caller an attested generation for the record that is
// about to start/cycle (Tech Plan: "Attested generation in results").
async function attestedGenerationFromCurrentRecord(
  environment: Environment,
): Promise<string | null> {
  const record = await readHostInstallRecord(environment);
  if (record === null) return null;
  return encodeInstallGeneration({
    installId: record.installId,
    installedAt: record.installedAt,
    archiveSha256: record.archiveSha256,
    version: record.version,
  });
}

async function readProvisionState(
  controller: ServiceController,
  label: ServiceLabel,
  runtime: RuntimeContext,
): Promise<ProvisionState> {
  // A malformed install record (or status probe failure) is treated as
  // "not present" so provisioning self-heals rather than wedging.
  let recordVersion: string | null = null;
  let recordRuntimeVersion: string | null = null;
  let installed = false;
  try {
    const record = await readHostInstallRecord(runtime.environment);
    if (record !== null) {
      installed = true;
      recordVersion = record.version;
      recordRuntimeVersion = record.runtimeVersion;
    }
  } catch (err) {
    runtime.logger.warn("Host provisioning install record probe failed", {
      environment: runtime.environment,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    installed = false;
  }
  let registered = false;
  let running = false;
  try {
    const status = await controller.status(label);
    registered = status.state !== "not-installed";
    running = status.state === "running";
  } catch (err) {
    runtime.logger.warn("Host provisioning service status probe failed", {
      environment: runtime.environment,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    registered = false;
    running = false;
  }
  return {
    installed,
    registered,
    running,
    version: recordVersion,
    runtimeVersion: recordRuntimeVersion,
  };
}

// The installed-version predicate (RCA finding D). "latest"/`--from`/the
// packaged archive carry synthetic local versions and use `presence`; an
// explicit `--release` or the bundled build use `exact`; the registry
// default uses `implicit-registry-minimum`, which accepts an installed
// version NEWER than the target (an out-of-band host update must not be
// downgraded) unless the manifest has explicitly yanked it - an absent
// entry or a failed/expired lookup deliberately fails open.
async function versionSatisfied(
  state: ProvisionState,
  satisfaction: HostSatisfactionPolicy,
  yankLookup: RegistryYankLookup,
): Promise<boolean> {
  if (!state.installed) return false;
  if (satisfaction.kind === "presence") return true;
  if (satisfaction.kind === "exact") {
    return state.version === satisfaction.version;
  }
  if (state.version === null) return false;
  const comparison = compareHostVersions(state.version, satisfaction.version);
  // `comparable: false` = a malformed version on either side; never let an
  // install record we can't reason about look current.
  if (!comparison.comparable) return false;
  if (comparison.ordering === "less") return false;
  if (comparison.ordering === "equal") return true;
  // A newer install is normally accepted; only an explicit yank rejects it.
  return !(await yankLookup.isVersionYanked(state.version));
}

async function isSatisfied(
  state: ProvisionState,
  satisfaction: HostSatisfactionPolicy,
  registerService: boolean,
  yankLookup: RegistryYankLookup,
): Promise<boolean> {
  if (!(await versionSatisfied(state, satisfaction, yankLookup))) {
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
    runtimeVersion: state.runtimeVersion,
    action: "noop",
    serviceLifecycle: null,
    postSwapError: null,
    installGeneration: null,
  };
}

function noopProgress(_info: ProgressInfo): void {
  // Default sink - provisioning should never be louder than the command
  // that triggered it.
}
