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

export type ServiceState = "running" | "stopped" | "not-installed";

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

export interface ServiceController {
  install(options: InstallServiceOptions): Promise<void>;
  uninstall(options: UninstallServiceOptions): Promise<void>;
  status(label: ServiceLabel): Promise<ServiceStatus>;
  stop(label: ServiceLabel): Promise<void>;
  start(label: ServiceLabel): Promise<void>;
  restart(label: ServiceLabel): Promise<void>;
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
