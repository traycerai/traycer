import type { UpdateMutationCapabilityAdoption } from "@traycer-clients/shared/host-update";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import {
  discardStagedHostInstallSource,
  NO_INSTALL_PHASE_HOOKS,
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
import {
  requireCliUpdateMutationCapability,
  withCliAttemptMutation,
  withCliUpdateExecutionSegment,
} from "./update-contender";
import {
  commitHostInstallSourceWithAttempt,
  installHostServiceWithAttempt,
  startHostServiceWithAttempt,
} from "./update-mutation";
import type { UpdateMutationCapability } from "@traycer-clients/shared/host-update";
import {
  createRegistryYankLookup,
  type RegistryYankLookup,
} from "../registry/client";
import { compareHostVersions } from "@traycer-clients/shared/host-version/compare-host-versions";
import { CLI_ERROR_CODES, CliError } from "../runner/errors";
import { assertHostNotBusy } from "./busy-check";
import { hostHomeDir } from "../store/paths";
import {
  gateStoreFormatFloor,
  ungatedStoreFormatFloorEvidence,
  type StoreFormatFloorEvidence,
} from "./store-format-floor";

// The single host-provisioning core behind `host ensure` (the desktop's
// post-auth call and the CLI's convergent provisioning verb). It reads the
// current state, then does the minimal work to reach installed + registered
// + running, reporting exactly what it did.
//
// It once had a second caller, `maybeAutoBootstrap`, which ran this pipeline
// implicitly from `traycer login` and `traycer host status`. Both were
// removed - a sign-in and a status read must not install software (audit
// finding CLI-001) - so every entry point into this core is now a command
// that says provisioning is what it does.
//
// Source resolution and idempotency policy differ per caller, so both are
// injected: `resolveInstallSource` is only invoked on the install branch,
// and `satisfaction` (presence / exact / own-build-minimum /
// implicit-registry-minimum, finding D + Q7) controls the fast no-op.

export type HostProvisionAction =
  | "noop"
  | "installed"
  | "service-registered"
  | "started";

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
// An explicit `--release` request demands an exact match; the build-stamped
// registry default accepts an installed version NEWER than the target (a host
// updated out-of-band must not be downgraded back to the stamped build),
// yank-checked against the manifest and fail-open; an own build (the packaged
// archive, or an explicit `--from`) demands the exact stamp EXCEPT in that
// same newer direction, for the same reason - see `own-build-minimum`.
export type HostSatisfactionPolicy =
  | { readonly kind: "presence" }
  | { readonly kind: "exact"; readonly version: string }
  /**
   * This build's own host archive: converge to `version`, but never BACKWARDS
   * over a comparably newer install (Q7).
   *
   * It was `exact`, and equality could not express the one case that matters:
   * a user whose host had been updated out of band past the app's bundle had
   * it silently replaced by the older bundled build on the next convergence -
   * and, because a convergence is requested whenever the local host is down or
   * has not been dialed, that revert repeated after every outage and every
   * launch with a remote serving. The registry arm already states the rule
   * ("a host updated out-of-band must not be downgraded"); this applies it to
   * the source the desktop actually uses.
   *
   * Deliberately NOT the registry arm's predicate. That one also accepts a
   * comparator-EQUAL different build string (`2.0.0+bar` installed for
   * `2.0.0+foo`), and an own build promises the opposite: a rebuilt host of
   * the same release is replaced. Only the strictly-greater direction moves.
   */
  | { readonly kind: "own-build-minimum"; readonly version: string }
  | { readonly kind: "implicit-registry-minimum"; readonly version: string };

export interface ProvisionHostOptions {
  readonly runtime: RuntimeContext;
  // Invoked only when an install is actually required.
  readonly resolveInstallSource: () => Promise<InstallSourceArg>;
  // The idempotency predicate. `exact`/`presence` behave like the old
  // `targetVersion` concrete/`null`; the bundled-host callers pass this
  // build's `config.version` as `own-build-minimum`, so a rebuilt
  // (same-channel) host is still detected and replaced without a semver bump,
  // while a comparably NEWER install is kept rather than reverted (Q7). The
  // registry default uses `implicit-registry-minimum` so a newer non-yanked
  // install is kept there too.
  readonly satisfaction: HostSatisfactionPolicy;
  // Recorded as the install version for a local-file install (the
  // bundled-host callers pass `config.version` so the recorded version is the
  // one their satisfaction policy asks for, and the next launch is a no-op
  // until the build changes). `null` keeps the installer's derived default.
  //
  // It is only ever WRITTEN on the install branch, which is why a kept newer
  // install survives with its own record: nothing restamps a host this run
  // decided not to replace.
  readonly recordVersionOverride: string | null;
  readonly enableLinger: boolean;
  readonly allowSelfInvocation: boolean;
  // When false, install the host BYTES only and never touch the OS service
  // (no plist write, no launchctl, no start). The desktop sets this because
  // it registers the macOS login item via SMAppService itself; otherwise the
  // CLI registers and starts the service.
  readonly registerService: boolean;
  readonly lockReason: string;
  /**
   * A parent executor's live-lock proof, when this provision runs as one step
   * inside a held segment (Ticket 05, Ruling 1). `undefined` for every ordinary
   * invocation, which keeps the acquire-or-refuse path exactly as it was.
   */
  readonly adoption: UpdateMutationCapabilityAdoption | undefined;
  readonly onProgress: ((info: ProgressInfo) => void) | null;
  // When true, skip the pre-reinstall busy probe and replace a running host
  // unconditionally (the desktop's "Force restart"). Default callers pass
  // false so in-progress chat/terminal/CLI work is protected.
  readonly force: boolean;
  /**
   * Provision even when a chat store on this machine is stamped in a format
   * the target build cannot read, losing access to those chats.
   *
   * Deliberately NOT folded into `force`. `--force` is the desktop's "Force
   * restart" and the CLI's "replace a busy host", and Force restart is what a
   * user presses when their chats hang - which IS this failure's symptom. A
   * force that also waived the floor would make the recovery button the thing
   * that completes the data loss.
   */
  readonly acceptStoreFormatLoss: boolean;
  // Invoked once this call has committed to MUTATING the host (install,
  // register or start) and never on the no-op fast path - so a caller can
  // run a step that is only warranted when a host will actually be started.
  // `host ensure` hangs its sign-in pre-flight here: prompting a signed-out
  // operator before the no-op decision would interrogate them for a command
  // that then does nothing.
  //
  // The hook point is sound in the direction that matters: the fast path
  // above RETURNS on a satisfied read, so "no-op predicted" can never become
  // a start, and a caller that skips its step on no-op cannot be surprised
  // by one. The reverse (this fires, then the locked re-read finds the state
  // satisfied after all) needs a genuinely concurrent provisioner and costs
  // only a redundant call, never a missed one.
  //
  // Runs OUTSIDE cli-lock and before staging, so a hook that blocks on a
  // human neither holds the lock nor waits out a download.
  readonly beforeMutate: (() => Promise<void>) | null;
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
  const contenderOptions = {
    environment: opts.runtime.environment,
    reason: opts.lockReason,
    waitMs: 30_000,
    pollIntervalMs: 100,
    admission: "legacy-update-shadow" as const,
    adoption: opts.adoption,
  };
  return withCliUpdateExecutionSegment(contenderOptions, async (capability) => {
    // Past the no-op return: this call is going to install, register or
    // start something. Keep the outer capability from that decision through
    // source resolution and staging, while preserving the short CLI-lock
    // scope around only the final lifecycle mutation.
    if (opts.beforeMutate !== null) {
      await opts.beforeMutate();
    }
    const predictedInstall =
      opts.force ||
      !fast.installed ||
      !(await versionSatisfied(fast, opts.satisfaction, yankLookup));
    // THE STORE-FORMAT FLOOR, before staging - and reached on the `--force`
    // branch above like every other. This is the path the desktop's Force
    // restart drives (`host ensure --force`), and force is exactly what skips
    // the version check here, so without this gate the recovery button is an
    // ungated downgrade onto data the bundled build may not be able to read.
    const storeFormatFloor = predictedInstall
      ? await gateProvisionStoreFormatFloor(opts, fast)
      : ungatedStoreFormatFloorEvidence(
          "host ensure",
          opts.acceptStoreFormatLoss,
        );
    const preStaged = predictedInstall
      ? await prepareInstallStage(opts, progress, capability, contenderOptions)
      : null;

    return provisionUnderLock(
      opts,
      controller,
      label,
      progress,
      preStaged,
      yankLookup,
      capability,
      contenderOptions,
      storeFormatFloor,
    );
  });
}

/**
 * The floor's operands for a provisioning run, derived from the satisfaction
 * policy - the one place this core states which version it is converging to.
 *
 * `presence` (a registry `latest`) names no version, so nothing can be gated
 * before the manifest resolves and the run carries ungated evidence to the
 * commit tail. `own-build-minimum` is this CLI's own bundled/`--from` archive:
 * a build stamp with no manifest entry behind it, so the registry is not
 * consulted and the fixed table decides. The two registry policies name a real
 * catalog version and may have published formats.
 */
async function gateProvisionStoreFormatFloor(
  opts: ProvisionHostOptions,
  fast: ProvisionState,
): Promise<StoreFormatFloorEvidence> {
  if (opts.satisfaction.kind === "presence") {
    return ungatedStoreFormatFloorEvidence(
      "host ensure",
      opts.acceptStoreFormatLoss,
    );
  }
  return gateStoreFormatFloor({
    environment: opts.runtime.environment,
    hostHome: hostHomeDir(opts.runtime.environment),
    targetVersion: opts.satisfaction.version,
    // The fast read's record, not a fresh one: this runs outside the lock,
    // and the locked re-read below re-derives the install branch anyway. The
    // commit tail asks again against whatever record is there at the swap.
    installedVersion: fast.version,
    consultRegistry: opts.satisfaction.kind !== "own-build-minimum",
    acceptStoreFormatLoss: opts.acceptStoreFormatLoss,
    site: "host ensure",
    logger: opts.runtime.logger,
  });
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
  capability: UpdateMutationCapability,
  contenderOptions: {
    readonly environment: Environment;
    readonly reason: string;
    readonly waitMs: number;
    readonly pollIntervalMs: number;
    readonly admission: "legacy-update-shadow";
  },
  storeFormatFloor: StoreFormatFloorEvidence,
): Promise<HostProvisionResult> {
  let stagedConsumed = false;
  opts.runtime.logger.debug("Host provisioning entering CLI lock", {
    environment: opts.runtime.environment,
    lockReason: opts.lockReason,
    force: opts.force,
    preStaged: preStaged !== null,
  });
  try {
    const outcome = await withCliAttemptMutation(
      capability,
      contenderOptions,
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
        //
        // This is the SECOND of two independent guards on that outcome - the
        // first is `isSatisfied`'s own host-owned arm on the fast path above -
        // and it deliberately re-derives the predicate instead of calling
        // `isSatisfied`, because by here the service state is no longer the
        // question. The consequence for anyone editing either one: the pin
        // that covers this (`provision.test.ts`, "keeps a newer install when
        // the host is NOT running") stays GREEN under a single-conjunct
        // change to either guard, since the other still returns `noop`. A
        // green suite is not evidence that this branch still fires.
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
          // INFO, not debug, and BEFORE the swap: this is the one line that
          // says a host the user did not ask about is being replaced by a
          // DIFFERENT version. Q7 spent an afternoon of log archaeology
          // establishing after the fact that a background convergence had done
          // exactly this; the install branch's own completion line reports the
          // outcome, and by then the previous bytes are gone.
          //
          // Versions and the source kind only - no install id, no generation,
          // no path. A first install and a same-version reinstall (a rebuilt
          // stamp, or `--force`) are not replacements of anything a reader
          // would be surprised by, and stay quiet.
          if (state.installed && state.version !== preStaged.version) {
            opts.runtime.logger.info(
              "Host provisioning replacing a different installed version",
              {
                environment: opts.runtime.environment,
                installedVersion: state.version,
                targetVersion: preStaged.version,
                sourceKind: preStaged.source.kind,
              },
            );
          }
          stagedConsumed = true;
          return {
            kind: "result",
            result: await commitInstall(
              opts,
              controller,
              label,
              progress,
              preStaged,
              capability,
              contenderOptions,
              storeFormatFloor,
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
            result: await runServiceRegister(
              opts,
              controller,
              label,
              progress,
              capability,
              contenderOptions,
            ),
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
          result: await runStart(
            opts,
            controller,
            label,
            state,
            progress,
            capability,
            contenderOptions,
          ),
        };
      },
    );
    if (outcome.kind === "result") {
      return outcome.result;
    }
    // Lock released. Stage outside it (network transfer never runs inside
    // cli-lock), then reacquire and retry - `preStaged` is non-null on this
    // retry, so the callback above cannot select `"need-stage"` again.
    const staged = await prepareInstallStage(
      opts,
      progress,
      capability,
      contenderOptions,
    );
    return provisionUnderLock(
      opts,
      controller,
      label,
      progress,
      staged,
      yankLookup,
      capability,
      contenderOptions,
      storeFormatFloor,
    );
  } finally {
    // Anything staged in anticipation of the install branch that the lock
    // callback never consumed (raced to noop/register/start, or an earlier
    // step inside the callback threw before reaching `commitInstall`) must
    // be scrubbed here. Once `commitInstall` runs, `commitHostInstallSource`
    // owns cleanup itself - never double-discard.
    if (preStaged !== null && !stagedConsumed) {
      await discardStagedHostInstallSource(
        opts.runtime.environment,
        preStaged,
        () => requireCliUpdateMutationCapability(capability, contenderOptions),
      );
    }
  }
}

async function prepareInstallStage(
  opts: ProvisionHostOptions,
  progress: (info: ProgressInfo) => void,
  capability: UpdateMutationCapability,
  contenderOptions: {
    readonly environment: Environment;
    readonly reason: string;
    readonly waitMs: number;
    readonly pollIntervalMs: number;
    readonly admission: "legacy-update-shadow";
  },
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
    workUnits: null,
  });
  return stageHostInstallSource({
    environment: opts.runtime.environment,
    source,
    onProgress: progress,
    recordVersionOverride: opts.recordVersionOverride,
    verifyMutationCapability: () =>
      requireCliUpdateMutationCapability(capability, contenderOptions),
    // Provisioning advances no attempt record; see `hooks` at the commit.
    beforeExtract: async () => {},
  });
}

async function commitInstall(
  opts: ProvisionHostOptions,
  controller: ServiceController,
  label: ServiceLabel,
  progress: (info: ProgressInfo) => void,
  staged: StagedHostInstallSource,
  capability: UpdateMutationCapability,
  contenderOptions: {
    readonly environment: Environment;
    readonly reason: string;
    readonly waitMs: number;
    readonly pollIntervalMs: number;
    readonly admission: "legacy-update-shadow";
  },
  storeFormatFloor: StoreFormatFloorEvidence,
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
        // Threaded through to the pre-swap stop, not just the busy
        // pre-check above: without it, a busy Desktop-managed host still
        // denied the cooperative shutdown claim and `--force` aborted
        // anyway.
        force: opts.force,
        onWillStopHost: null,
        // `host ensure` provisions bytes; it drives no attempt record, so
        // it observes neither swap barrier.
        hooks: NO_INSTALL_PHASE_HOOKS,
      })
    : null;
  const lifecycle =
    handle !== null
      ? handle.lifecycle
      : createBytesOnlyInstallLifecycle(
          controller,
          label,
          NO_INSTALL_PHASE_HOOKS,
        );
  opts.runtime.logger.debug("Host provisioning install lifecycle prepared", {
    environment: opts.runtime.environment,
    lifecycleEnabled: handle !== null,
    preSwapCleanupEnabled: handle === null && process.platform === "win32",
  });
  // Already inside the per-environment CLI lock - commit the pre-staged
  // source directly (it expects the caller to hold the lock). Reconcile
  // wiring (Tech Plan: "Install/ensure re-run reconcile after a successful
  // commit") comes from `commitHostInstallSource` itself.
  const result = await commitHostInstallSourceWithAttempt(
    capability,
    contenderOptions,
    {
      environment: opts.runtime.environment,
      staged,
      onProgress: progress,
      lifecycle,
      onWillSwap: null,
      storeFormatFloor,
    },
  );
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
  capability: UpdateMutationCapability,
  contenderOptions: {
    readonly environment: Environment;
    readonly reason: string;
    readonly waitMs: number;
    readonly pollIntervalMs: number;
    readonly admission: "legacy-update-shadow";
  },
): Promise<HostProvisionResult> {
  progress({
    stage: "host-provision",
    message: "registering OS service for installed host",
    percent: null,
    bytes: null,
    totalBytes: null,
    workUnits: null,
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
  await installHostServiceWithAttempt(
    capability,
    contenderOptions,
    controller,
    {
      label,
      cli,
      enableLinger: opts.enableLinger,
    },
  );
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
  capability: UpdateMutationCapability,
  contenderOptions: {
    readonly environment: Environment;
    readonly reason: string;
    readonly waitMs: number;
    readonly pollIntervalMs: number;
    readonly admission: "legacy-update-shadow";
  },
): Promise<HostProvisionResult> {
  progress({
    stage: "host-provision",
    message: "starting the registered host service",
    percent: null,
    bytes: null,
    totalBytes: null,
    workUnits: null,
  });
  // First attempt: plain start (on win32 this already polls for post-baseline
  // spawn evidence and surfaces Last Run Result on failure - finding F).
  try {
    await startHostServiceWithAttempt(
      capability,
      contenderOptions,
      controller,
      label,
    );
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
      workUnits: null,
    });
    const cli = await resolveServiceCliInvocation({
      environment: opts.runtime.environment,
      override: null,
      allowSelfInvocation: opts.allowSelfInvocation,
    });
    let rewriteError: unknown = null;
    try {
      await installHostServiceWithAttempt(
        capability,
        contenderOptions,
        controller,
        {
          label,
          cli,
          enableLinger: opts.enableLinger,
        },
      );
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
        await startHostServiceWithAttempt(
          capability,
          contenderOptions,
          controller,
          label,
        );
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
  return encodeInstallGeneration(record);
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

// The installed-version predicate (RCA finding D, narrowed by Q7). Four
// policies, one per shape of request:
//
//   - `latest` carries no version to compare against, so it is `presence`;
//   - an explicit `--release <semver>` is `exact` - a pin is a pin;
//   - the build-stamped registry default is `implicit-registry-minimum`,
//     which accepts an installed version NEWER than the target (an
//     out-of-band host update must not be downgraded) unless the manifest has
//     explicitly yanked it - an absent entry or a failed/expired lookup
//     deliberately fails open;
//   - this build's OWN archive - packaged, or the `--from` the Windows
//     desktop passes for it - is `own-build-minimum`: `exact` in every
//     direction except that same newer one.
//
// The sentence this replaces said `--from` and the packaged archive carried
// synthetic local versions and used `presence`. They have not since
// `ensureHost` took over from auto-bootstrap, which stamps `config.version`
// on both and asked for `exact` against it - the very policy Q7 narrowed. It
// was wrong before this change and is corrected with it rather than left
// inherited: it heads the function whose branches it claims to describe.
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
  if (satisfaction.kind === "own-build-minimum") {
    // The requested stamp itself, decided BEFORE the comparator so a rebuilt
    // same-release host (another build string the comparator ranks equal) does
    // not slip through as satisfied - that case must still be replaced.
    if (state.version === satisfaction.version) return true;
    const ownComparison = compareHostVersions(
      state.version,
      satisfaction.version,
    );
    // Unordered stamps (`staging.<epoch>.<sha>`, a dev build) cannot be shown
    // to be newer, so they converge exactly as they did under `exact`. Only a
    // version this comparator positively ranks ABOVE the bundle is kept.
    if (!ownComparison.comparable) return false;
    if (ownComparison.ordering !== "greater") return false;
    return !(await yankLookup.isVersionYanked(state.version));
  }
  const comparison = compareHostVersions(state.version, satisfaction.version);
  // `comparable: false` = a malformed version on either side; never let an
  // install record we can't reason about look current.
  if (!comparison.comparable) return false;
  if (comparison.ordering === "less") return false;
  // The exact requested string is satisfied outright. Another build of the
  // same release (`2.0.0+bar` installed, `2.0.0+foo` asked for) is a
  // DIFFERENT artifact the comparator merely ranks equal: it is accepted the
  // way a newer install is, unless the registry has withdrawn it - the yank
  // check a comparator-equal shortcut used to skip.
  if (
    comparison.ordering === "equal" &&
    state.version === satisfaction.version
  ) {
    return true;
  }
  // A newer install, or another build of the requested release, is normally
  // accepted; only an explicit yank rejects it.
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
