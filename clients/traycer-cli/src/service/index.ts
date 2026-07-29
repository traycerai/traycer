import { platform as osPlatform } from "node:os";
import { config } from "../config";
import { createCliLogger } from "../logger";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CliInvocation } from "./cli-binary";
import type { ServiceLabel } from "./label";
import { createLinuxController } from "./platforms/linux";
import { createMacosController } from "./platforms/macos";
import { createWindowsController } from "./platforms/windows";

export type { ServiceLabel } from "./label";
export { serviceLabelFor, serviceManifestPath, windowsTaskName } from "./label";
export type { CliInvocation } from "./cli-binary";
export { resolveServiceCliInvocation } from "./cli-binary";

// `externally-managed` (macOS only): the label is loaded in launchd from an
// SMAppService in-bundle plist - Traycer Desktop owns the registration, not
// the CLI. A registration EXISTS (so auto-bootstrap must not select "service
// repair" and doctor must not render a not-registered error), but every CLI
// service mutation (bootstrap/bootout/manifest rewrite) must leave it alone;
// `installService` refuses it outright. Run-state is deliberately not folded
// in: liveness checks key off pid metadata (`busy-check.ts`), never off this.
export type ServiceState =
  "running" | "stopped" | "not-installed" | "externally-managed";

export interface ServiceStatus {
  readonly state: ServiceState;
  readonly version: string | null;
  readonly listenUrl: string | null;
  readonly pid: number | null;
}

export interface InstallServiceOptions {
  readonly label: ServiceLabel;
  // Resolved CLI invocation the manifest will reference. The supervisor
  // is always `<cli.command> <cli.args...> host start` (no slot flag -
  // the CLI build bakes the slot via `config.environment`).
  readonly cli: CliInvocation;
  // Whether to attempt `loginctl enable-linger $USER` on Linux so the
  // host survives logout. Silent failure (logged as a doctor issue
  // later) is acceptable per Flow 1.
  readonly enableLinger: boolean;
}

export interface UninstallServiceOptions {
  readonly label: ServiceLabel;
}

// Outcome of `ServiceController.retireCompetingRegistration`.
//
//   - `not-applicable` - there is nothing to repair, either because the
//     platform has no SMAppService at all (Linux/Windows) or because
//     Desktop does not own registration on this machine. Also the answer
//     when the CLI label ITSELF is SMAppService-owned: that is Desktop's
//     own registration on a pre-label-split machine, not a competitor, and
//     the CLI must never bootout/delete it.
//   - `retired` - Desktop owns registration under the agent label AND a
//     competing CLI-label registration existed; it has now been booted out
//     and/or its manifest removed. `bootedOut` / `manifestRemoved` say
//     which halves actually applied, and `agentStartRequested` whether the
//     surviving agent job was asked to start after an eviction. "Requested",
//     not "started": `launchctl kickstart` returns once launchd accepts the
//     request, so a job that is registered but unspawnable (e.g. wedged by a
//     stale BTM code requirement) still reports success here.
//   - `nothing-to-retire` - Desktop owns registration and the CLI label is
//     already clean. The healthy post-split steady state.
//   - `retire-failed` - there WAS something to retire and an operation on it
//     failed hard. Distinct from `nothing-to-retire` on purpose: a loaded job
//     whose manifest is already gone (now a normal steady state, since
//     Desktop's launch repair removes manifests without booting out) plus a
//     failed bootout would otherwise be indistinguishable from a clean
//     machine.
export type CompetingRegistrationRetirement =
  | { readonly kind: "not-applicable" }
  // Desktop owns registration, but its agent is loaded and (possibly)
  // unspawnable - so the competing CLI registration may be the only host
  // this machine can run and is deliberately KEPT. Distinct from
  // `not-applicable` on purpose: that means "nothing here to repair", this
  // means "there was, and repairing it would have been the damage".
  // `probe` carries which arm fired, since an unreadable probe and positive
  // wedge markers are different machines with the same safe answer.
  | {
      readonly kind: "kept-agent-possibly-wedged";
      readonly probe: "wedged" | "unknown";
    }
  | { readonly kind: "nothing-to-retire" }
  | {
      readonly kind: "retired";
      readonly bootedOut: boolean;
      readonly manifestRemoved: boolean;
      readonly agentStartRequested: boolean;
    }
  | {
      readonly kind: "retire-failed";
      readonly bootoutFailed: boolean;
      readonly manifestRemovalFailed: boolean;
    };

// Outcome of `ServiceController.takeoverDesktopRegistration`.
export type DesktopRegistrationTakeover =
  | {
      readonly kind: "took-over";
      readonly agentLabelId: string;
      // How the running host was handled: "stopped" through its own
      // lifecycle RPCs, "no-host" when nothing was running,
      // "skipped-unreachable" when the host could not be asked (it is the
      // broken part - the takeover IS the recovery) and the job was booted
      // out underneath it.
      readonly cooperativeStop: "stopped" | "no-host" | "skipped-unreachable";
    }
  | { readonly kind: "not-applicable" };

// Carried from `stopForRestart` to `relaunchAfterRestart` so the relaunch
// knows whether the old process was actually asked to exit.
export interface RestartStop {
  // True when the host could not be asked to stand down - its RPC endpoint
  // was unreachable, or it acknowledged the claim and then outlived its own
  // force-exit watchdog. The old process may still be running, so the
  // relaunch has to RECYCLE the job rather than kickstart it: launchd treats
  // a kickstart of an already-running job as satisfied and no-ops, which
  // would leave the host up on the old bytes after a "successful" restart.
  readonly forcedRecycle: boolean;
}

export interface ServiceController {
  install(options: InstallServiceOptions): Promise<void>;
  uninstall(options: UninstallServiceOptions): Promise<void>;
  status(label: ServiceLabel): Promise<ServiceStatus>;
  stop(label: ServiceLabel): Promise<void>;
  start(label: ServiceLabel): Promise<void>;
  restart(label: ServiceLabel): Promise<void>;
  // The two halves of a restart, for the one caller that needs to do work
  // between them: `host restart` finalises a pending CLI upgrade while the
  // supervisor's lock on the binary is released, which only happens after
  // the stop and before the relaunch.
  //
  // This exists because that command may NOT be spelled `stop()` then
  // `start()`. On a Desktop-managed machine `stop()` treats a host that
  // cannot be asked to stand down as a terminal error, so the command would
  // exit before ever relaunching - which is precisely the broken-host state
  // an explicit `host restart` is supposed to repair. `restart()` handles it
  // (by recycling the job) but leaves no window in the middle. So the halves
  // are named, and the recycle decision stays inside the platform.
  //
  // `stopForRestart` still throws on a busy host: an explicit restart never
  // escalates over live work.
  stopForRestart(label: ServiceLabel): Promise<RestartStop>;
  relaunchAfterRestart(label: ServiceLabel, stop: RestartStop): Promise<void>;
  // Explicit-consent counterpart to `install`'s SMAppService refusal
  // (macOS): move host management from the Desktop app to the CLI. Stops
  // the Desktop-managed host cooperatively first (a busy denial throws
  // E_HOST_BUSY - never a takeover over live work), boots out the agent
  // registration with a verify-after re-probe, and leaves the machine
  // ready for a plain `install`. Resolves `not-applicable` on platforms
  // without SMAppService and on machines where Desktop does not own an
  // agent registration. Throws E_SERVICE_INSTALL_FAILED on
  // pre-label-split machines where the CLI label IS Desktop's own
  // registration (bootout there corrupts the BTM state the app manages;
  // `service uninstall` is the intended route).
  takeoverDesktopRegistration(
    label: ServiceLabel,
  ): Promise<DesktopRegistrationTakeover>;
  // Repair, not refusal: remove a CLI-label registration that would run a
  // SECOND host beside Desktop's SMAppService agent. The v1.1.7 label split
  // let both coexist, and until v1.1.8 the ownership probe was blind to the
  // current `launchctl print` format - so machines in the field carry a
  // dual registration that nothing else removes (`installService` now
  // refuses to CREATE one, but a refusal cannot clean up what already
  // exists, and Desktop's `retireLegacyLabelRegistrations` only runs inside
  // a full SMAppService register cycle).
  //
  // Best-effort by contract: never throws. A launchctl that hangs or cannot
  // spawn reads as "not loaded" and the repair is skipped, exactly like the
  // advisory probes in `uninstallService` / `assertNotDesktopAgentManaged`.
  retireCompetingRegistration(
    label: ServiceLabel,
  ): Promise<CompetingRegistrationRetirement>;
}

// Shared human-readable warning suffix for the host install/update
// commands when the post-swap service action (start/restart/install)
// fails. The host bytes are in place but the OS service didn't come
// back up cleanly - direct the operator at the doctor.
export function formatServiceLifecycleWarning(
  action: "restart" | "start" | "install" | "none",
  error: string,
): string {
  return `warning: service ${action} failed: ${error} - run 'traycer host doctor'`;
}

// Cross-platform service-controller facade. Lifted from the Desktop
// implementation and re-shaped around the CLI's "manifest invokes the
// CLI binary with `host start`" model - there is no Electron
// `SMAppService` path here. The dispatch is fixed at construction time
// so callers don't re-resolve per call.
export function createServiceController(): ServiceController {
  const platform = osPlatform();
  const logger = createCliLogger(config.environment);
  logger.debug("Service controller resolving platform backend", {
    environment: config.environment,
    platform,
  });
  if (platform === "darwin") {
    logger.debug("Service controller selected macOS backend", {
      environment: config.environment,
    });
    return createMacosController(null);
  }
  if (platform === "linux") {
    logger.debug("Service controller selected Linux backend", {
      environment: config.environment,
    });
    return createLinuxController(null);
  }
  if (platform === "win32") {
    logger.debug("Service controller selected Windows backend", {
      environment: config.environment,
    });
    return createWindowsController(null);
  }
  logger.error(
    "Service controller unsupported platform",
    {
      environment: config.environment,
      platform,
    },
    null,
  );
  throw cliError({
    code: CLI_ERROR_CODES.SERVICE_UNSUPPORTED_PLATFORM,
    message: `service controller: unsupported platform '${platform}' (expected darwin|linux|win32)`,
    details: { platform },
    exitCode: 1,
  });
}
