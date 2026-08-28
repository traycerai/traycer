import type { InstallHostLifecycle, SwapLockRecovery } from "../installer";
import { createCliLogger } from "../logger";
import { CLI_ERROR_CODES, CliError } from "../runner/errors";
import { resolveServiceCliInvocation, type CliInvocation } from "./cli-binary";
import { isSelfNamingCliInvocation } from "./cli-invocation-shape";
import {
  createServiceController,
  serviceLabelFor,
  type ServiceController,
  type ServiceLabel,
  type ServiceState,
} from "./index";
import { readRegisteredCliInvocation } from "./platforms/macos";
import {
  describeSlotLockHolders,
  killLingeringSlotProcesses,
} from "./platforms/windows";
import type { Environment } from "../runner/environment";

// Windows only: the pre-swap stop kills every process the slot scan can
// see, but a handle it cannot (an orphaned child whose CWD is inside
// `install/`, an AV scan) still fails the swap rename with EBUSY. This
// seam lets the installer re-kill between rename attempts and, when the
// retries exhaust anyway, name the processes still matching the slot in
// the error it throws. POSIX renames don't contend with open handles, so
// other platforms carry no recovery.
function swapLockRecoveryFor(label: ServiceLabel): SwapLockRecovery | null {
  if (process.platform !== "win32") return null;
  return {
    killLingeringProcesses: () => killLingeringSlotProcesses(label, null),
    describeLockHolders: () => describeSlotLockHolders(label, null),
  };
}

// State captured by the lifecycle hooks so the command can render an
// accurate `serviceLifecycle` block in its result.
//
//   - `priorState` - the service state observed *before* the swap.
//     `not-installed` means the bootstrap path: depending on the
//     lifecycle's `bootstrap` option we either register the service
//     post-swap (Core Flow 1 / Flow 7 - `host install` on a clean
//     machine) or skip touching the service (`host update`, which
//     assumes the service is already there). `externally-managed`
//     (macOS, SMAppService-owned label) always skips the service work:
//     Desktop owns that registration and the CLI must not touch it.
//   - `stoppedBeforeSwap` - true iff we issued `controller.stop()`
//     because the service was running (or because Windows needs a
//     force-kill of stray host processes before the install-dir
//     rename). Used for reporting only; the post-swap path no longer
//     branches on it.
//   - `postSwapAction` - what we actually attempted after the swap.
//     `install` when we rewrote/re-registered the OS service manifest
//     (fresh bootstrap or an existing registration that needs the
//     regenerated definition), `none` if not registered and bootstrap
//     was off. Plain start/restart is intentionally not used after a
//     binary swap: on macOS those only kickstart launchd's cached
//     definition and would leave SoftResourceLimits / ProgramArguments
//     stale.
//   - `postSwapError` - non-null iff the post-swap install threw. Per
//     the Tech Plan we do NOT rollback in this case; the new host
//     stays installed and the operator is steered toward
//     `traycer host doctor`.
export interface ServiceInstallLifecycleState {
  priorState: ServiceState;
  stoppedBeforeSwap: boolean;
  // `install` (manifest rewrite + re-register) for CLI-owned registrations -
  // plain start/restart there was removed deliberately (macOS kickstart runs
  // launchd's cached definition and would leave a regenerated plist stale).
  // `start` is used ONLY on the Desktop-managed path: the agent label's
  // definition lives in the app bundle and a host-bytes swap does not
  // change it, so kickstarting it after the swap runs the current
  // definition on the new bytes. Renderer-side consumers keep tolerating
  // the historical `restart`/`start` strings from older CLIs.
  postSwapAction: "start" | "install" | "none";
  postSwapError: string | null;
}

export interface ServiceInstallLifecycleHandle {
  readonly state: ServiceInstallLifecycleState;
  readonly lifecycle: InstallHostLifecycle;
}

// Opt-in payload for bootstrapping the OS service when there is no
// prior registration. `host install` passes this so a clean machine
// (Core Flow 1) ends with a registered, running host without an
// extra `traycer host service install` step. `host update` leaves it
// null - an update implies the service should already be wired up.
export interface BootstrapServiceOptions {
  // Whether to attempt `loginctl enable-linger $USER` on Linux. Mirrors
  // `service install --no-linger` (negated).
  readonly enableLinger: boolean;
  // When true and no CLI manifest is available, register the service
  // against the running process. Used by the dev orchestrator and
  // local-file installs before the packaged CLI is on disk.
  readonly allowSelfInvocation: boolean;
}

export interface CreateServiceInstallLifecycleOptions {
  readonly environment: Environment;
  // When non-null, the lifecycle will register and start the OS
  // service after a successful swap if `priorState === "not-installed"`.
  // When null, the lifecycle leaves an unregistered service alone
  // (legacy `host update` behaviour).
  readonly bootstrap: BootstrapServiceOptions | null;
  // Forwarded to the pre-swap `controller.stop`. `false` keeps the
  // cooperative contract: a busy host denies the shutdown claim and the
  // install aborts with `E_HOST_BUSY` before anything is touched. `true`
  // is the caller's stated consent (`--force`) to kill in-flight work:
  // the stop skips the claim and force-stops the host process, exactly
  // like `host stop --force`. Without this, the `--force` on
  // ensure/update/apply only skipped the busy PRE-check and the
  // cooperative stop's own busy denial still aborted the install.
  readonly force: boolean;
}

// Build the lifecycle hooks `installHost` needs to keep the OS
// service in sync with the install dir swap. The returned `state` is
// mutated by the hooks; the command reads it after `installHost`
// resolves to populate its result payload.
export function createServiceInstallLifecycle(
  options: CreateServiceInstallLifecycleOptions,
): ServiceInstallLifecycleHandle {
  const controller = createServiceController();
  const label = serviceLabelFor(options.environment);
  const state: ServiceInstallLifecycleState = {
    priorState: "not-installed",
    stoppedBeforeSwap: false,
    postSwapAction: "none",
    postSwapError: null,
  };
  const lifecycle: InstallHostLifecycle = {
    swapLockRecovery: swapLockRecoveryFor(label),
    beforeSwap: async () => {
      const status = await controller.status(label);
      state.priorState = status.state;
      // Only stop a host we actually saw running. A
      // registered-but-stopped service has no process to evict, and
      // `not-installed` means there's no service to talk to at all -
      // we'll register it post-swap if bootstrap was requested. Windows is
      // the exception: its stop also force-kills stray host processes whose
      // open handles inside the install dir would fail the swap rename, so
      // it runs even when the service wasn't observed running.
      if (status.state === "running" || process.platform === "win32") {
        await controller.stop(label, { force: options.force });
        state.stoppedBeforeSwap = true;
        return;
      }
      // Desktop-managed macOS machines report `externally-managed` even
      // while a host is live underneath. This used to skip the stop
      // silently - the install printed "stopping service", swapped under
      // the running host, and the new bytes went live only at Desktop's
      // next register cycle, which users reasonably read as "the install
      // fixed it". `controller.stop` performs a cooperative shutdown
      // through the host's own lifecycle RPCs - or, when the caller
      // passed `--force`, a forced kill of the host child - so use it: a
      // busy denial still aborts (never swap over live work without the
      // user's stated `--force` consent), while a host that cannot be
      // stopped - already gone with its pid metadata purged, or too
      // broken to answer its RPC - degrades to swapping anyway.
      // Installing is strictly better than refusing there, and
      // `afterSwap` kickstarts the agent either way, so the degrade never
      // leaves the machine hostless.
      if (
        status.state === "externally-managed" &&
        process.platform === "darwin"
      ) {
        try {
          await controller.stop(label, { force: options.force });
          state.stoppedBeforeSwap = true;
        } catch (cause) {
          if (
            cause instanceof CliError &&
            cause.code === CLI_ERROR_CODES.HOST_BUSY
          ) {
            throw cause;
          }
          createCliLogger(options.environment).warn(
            "Stopping the Desktop-managed host was unavailable; swapping the install anyway (the post-swap kickstart starts a stopped host; a live one picks the new bytes up at its next restart).",
            {
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          );
        }
      }
    },
    afterSwap: async () => {
      if (state.priorState === "externally-managed") {
        // Traycer Desktop's SMAppService owns registration here. Any
        // launchctl bootstrap/bootout (or manifest rewrite) against ITS
        // label would corrupt the BTM registration it manages -
        // `installService` refuses exactly that. Leave the service alone:
        // the swapped bytes go live at Desktop's next SMAppService register
        // cycle (ensure fast path / pending-revision monitor / relaunch).
        state.postSwapAction = "none";
        // ...but a COMPETING CLI-label registration is a different object
        // from the one Desktop owns, and leaving it alone is what produced
        // the dual-host bug. Retire it here rather than merely declining to
        // add another: this is the one routine flow that both reaches a
        // poisoned machine (`host install` / `host update` on a
        // desktop-owned host) and is already an explicit host-lifecycle
        // operation the user asked for. `retireCompetingRegistration`
        // re-probes ownership itself and no-ops unless Desktop's agent is
        // the registered owner and the CLI label is genuinely a competitor
        // - `externally-managed` alone cannot distinguish that from a
        // pre-split machine whose CLI label IS Desktop's registration.
        // Contractually non-throwing - but caught anyway rather than trusted:
        // the install's bytes are already swapped in at this point, so an
        // opportunistic cleanup must not be able to abort the lifecycle no
        // matter how a future platform implementation behaves.
        //
        // Its outcome is deliberately NOT recorded on `state`: nothing builds
        // a `serviceLifecycle` payload from it (every caller assembles that
        // field-by-field), so a field here would be dead state. The repair
        // reports itself through the CLI logger, which is where a field
        // diagnosis for "my host went away after an install" starts.
        await controller
          .retireCompetingRegistration(label)
          .catch((cause: unknown) => {
            // Logged HERE rather than swallowed: every failure the repair
            // anticipates is already reported at its own seam, so the only
            // way to land in this catch is an unforeseen throw - precisely
            // the case that escaped that logging. A silent swallow would
            // make it invisible everywhere.
            createCliLogger(options.environment).warn(
              "Competing-registration repair threw unexpectedly; the host install itself was unaffected.",
              { cause: cause instanceof Error ? cause.message : String(cause) },
            );
          });
        if (process.platform === "darwin") {
          // Bring the host up on the NEW bytes now instead of leaving the
          // machine hostless until Desktop's next register cycle. Both
          // routes kickstart the agent label - the bundle-owned definition
          // is unchanged by a host-bytes swap, so this is not the cached-
          // definition staleness case that forbids start-after-swap on
          // CLI-owned registrations.
          //
          // Unconditional on purpose, NOT gated on whether beforeSwap's
          // stop stopped anything. The gated version left a machine whose
          // host was already down (a prior `host stop --force` purges
          // pid.json, so the pre-swap stop throws no-metadata and degrades)
          // with a completed install, a printed "starting service", and no
          // host until someone ran `host restart` by hand.
          //
          // Which kickstart depends on what the stop PROVED, and the split
          // is `stoppedBeforeSwap` exactly:
          //   - the stop RESOLVED: the host child is proven gone, but its
          //     supervisor can outlive it through the whole post-mortem
          //     (stderr drain; crash-report scan after a forced kill), and
          //     a plain kickstart against a job launchd still considers
          //     running is a silent no-op - the machine would stay
          //     hostless. Recycle (`kickstart -k`) instead: it starts a
          //     stopped job and replaces a winding-down supervisor, and
          //     the only thing it can kill is a supervisor whose child is
          //     already dead (same reasoning as `stopServiceForRestart`).
          //   - the stop THREW (degraded): a host MAY still be live and
          //     was never asked/consented to die, so recycling would kill
          //     live work. Plain kickstart: starts a genuinely stopped
          //     job, silent no-op on a live one, which then picks the new
          //     bytes up at its next restart.
          //
          // A failure must not abort the completed install - record it and
          // steer to doctor like every other post-swap error.
          try {
            if (state.stoppedBeforeSwap) {
              await controller.relaunchAfterRestart(label, {
                forcedRecycle: true,
              });
            } else {
              await controller.start(label);
            }
            state.postSwapAction = "start";
          } catch (cause) {
            state.postSwapError =
              cause instanceof Error ? cause.message : String(cause);
          }
        }
        return;
      }
      if (state.priorState === "not-installed") {
        if (options.bootstrap === null) {
          // Update / non-bootstrap callers leave registration to the
          // operator (`traycer host service install`).
          state.postSwapAction = "none";
          return;
        }
        state.postSwapAction = "install";
        try {
          await registerService({
            controller,
            label,
            environment: options.environment,
            bootstrap: options.bootstrap,
            preservedCli: null,
          });
        } catch (cause) {
          // No rollback - the new host stays in place. The command
          // surfaces this as a warning and steers the user toward
          // `traycer host doctor` / `traycer host service install`
          // for recovery.
          state.postSwapError =
            cause instanceof Error ? cause.message : String(cause);
        }
        return;
      }
      // Existing registration: rewrite the OS service manifest and
      // re-load it so the supervisor picks up definition changes
      // (descriptor soft limits, ProgramArguments, env, ...). Plain
      // start/restart only instructs the already-loaded job to run -
      // on macOS that is launchctl kickstart of a cached definition.
      // Linux/Windows install paths already daemon-reload / recreate
      // the unit/task, so re-registering is the common cross-platform
      // post-swap action for both stopped and previously-running
      // services (the process was stopped in beforeSwap when needed).
      state.postSwapAction = "install";
      try {
        // `host update` (bootstrap null) refreshes the DEFINITION of an
        // existing registration (descriptor limits, env), but must not
        // silently REPOINT it: on macOS, re-resolving the CLI here can
        // prefer a stale staged `~/.traycer/cli` binary over the brew /
        // manual binary the registered plist actually invokes. Reuse the
        // registered command when it still exists; fall through to normal
        // resolution when the manifest is missing/unreadable or its
        // command is gone. Explicit `host install` (bootstrap non-null)
        // keeps re-resolving - a reinstall is allowed to repoint.
        //
        // Deliberately darwin-only (accepted trade-off, not an oversight):
        // Linux/Windows updates DO re-resolve, so the same repoint hazard
        // exists there in principle - but the affected cohort (a manual /
        // package-manager CLI install that ALSO once ran Desktop's setup,
        // leaving a stale staged binary) is overwhelmingly a
        // macOS/Homebrew phenomenon, and preserving would need bespoke
        // systemd-unit / Scheduled-Task-XML parsers for a failure mode
        // whose worst case is the service running a stale-but-functional
        // CLI. Revisit with real parsers if a non-macOS cohort surfaces.
        //
        // One registration is never worth preserving: the self-naming
        // `<SEA> traycer host start` vector the pre-fix packaged fallback
        // emitted, which cannot launch at all. Preserving it is how a
        // machine that registered under `cli-v1.2.0-rc.1` would stay broken
        // across every subsequent `host update` - `launchctl kickstart`
        // reports success as soon as the binary spawns, so no failure path
        // downstream ever rewrites it. Dropping it here falls through to
        // normal resolution, which emits the corrected vector.
        const registeredCli =
          options.bootstrap === null && process.platform === "darwin"
            ? await readRegisteredCliInvocation(label)
            : null;
        const preservedCli =
          registeredCli !== null &&
          (await isSelfNamingCliInvocation(registeredCli))
            ? null
            : registeredCli;
        await registerService({
          controller,
          label,
          environment: options.environment,
          // host update leaves bootstrap null (it must not invent a
          // registration on a clean machine). For an already-registered
          // service, reuse the caller's bootstrap flags when present;
          // otherwise re-resolve the CLI with linger off and self-
          // invocation permitted. Manifest / well-known bin still win
          // when present (cli-binary.ts steps 1–2); self-invocation is
          // only the Brew/manual fallback documented there. Without it,
          // host update stops an existing service and then fails to
          // re-register on installs that never staged ~/.traycer/cli.
          bootstrap: options.bootstrap ?? {
            enableLinger: false,
            allowSelfInvocation: true,
          },
          preservedCli,
        });
      } catch (cause) {
        // No rollback. New host is in place; surface the failure
        // so the command can warn the user and Doctor can flag it.
        state.postSwapError =
          cause instanceof Error ? cause.message : String(cause);
      }
    },
  };
  return { state, lifecycle };
}

// The truly-bytes-only counterpart to `createServiceInstallLifecycle`: no
// status probe, no register/rewrite, no start - ever, on any prior service
// state. The single exception is Windows, where a stray host process
// holding the install dir open would fail the swap rename regardless of
// whether the caller wants the service touched, so `beforeSwap` still force-
// stops there. Used by callers whose bytes-only contract must hold even
// when a service is already registered (`host install --no-service-
// register`, `host ensure` with `registerService: false`) - unlike
// `createServiceInstallLifecycle`'s `bootstrap: null`, which still rewrites
// and re-loads an EXISTING registration post-swap.
export function createBytesOnlyInstallLifecycle(
  controller: ServiceController,
  label: ServiceLabel,
): InstallHostLifecycle {
  return {
    swapLockRecovery: swapLockRecoveryFor(label),
    beforeSwap: (): Promise<void> =>
      process.platform === "win32"
        ? controller.stop(label, { force: false })
        : Promise.resolve(),
    afterSwap: (): Promise<void> => Promise.resolve(),
  };
}

interface RegisterServiceOptions {
  readonly controller: ServiceController;
  readonly label: ServiceLabel;
  readonly environment: Environment;
  readonly bootstrap: BootstrapServiceOptions;
  // Non-null when the caller wants the registered manifest's existing CLI
  // invocation kept verbatim (host update's no-repoint contract) instead of
  // re-resolving it.
  readonly preservedCli: CliInvocation | null;
}

async function registerService(opts: RegisterServiceOptions): Promise<void> {
  // CLI invocation resolution happens here (post-swap) so an unresolvable
  // path becomes a `postSwapError` rather than rolling back a successful
  // host install. Doctor + `traycer host service install` are the recovery
  // paths.
  const cli =
    opts.preservedCli ??
    (await resolveServiceCliInvocation({
      environment: opts.environment,
      override: null,
      allowSelfInvocation: opts.bootstrap.allowSelfInvocation,
    }));
  // `ServiceController.install` writes the manifest, registers with the
  // OS service manager, and starts the host - matching Core Flow 1
  // / Flow 7 expectations that first-launch ends with a running host,
  // and matching the existing-registration update path that must
  // re-load the regenerated definition rather than kickstart a cache.
  await opts.controller.install({
    label: opts.label,
    cli,
    enableLinger: opts.bootstrap.enableLinger,
  });
}
