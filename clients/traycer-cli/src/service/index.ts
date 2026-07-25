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

export interface ServiceController {
  install(options: InstallServiceOptions): Promise<void>;
  uninstall(options: UninstallServiceOptions): Promise<void>;
  status(label: ServiceLabel): Promise<ServiceStatus>;
  stop(label: ServiceLabel): Promise<void>;
  start(label: ServiceLabel): Promise<void>;
  restart(label: ServiceLabel): Promise<void>;
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
