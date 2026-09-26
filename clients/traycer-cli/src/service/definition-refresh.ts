import { platform as osPlatform } from "node:os";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { ServiceLabel } from "./label";
import { verifyServiceMutationAuthority } from "./mutation-authority";
import {
  inspectLinuxServiceDefinition,
  refreshLinuxServiceDefinition,
} from "./platforms/linux";
import {
  inspectMacosServiceDefinition,
  refreshMacosServiceDefinition,
} from "./platforms/macos";
import {
  inspectWindowsServiceDefinition,
  refreshWindowsServiceDefinition,
} from "./platforms/windows";
import { runCommand } from "./process-runner";
import type {
  ServiceDefinitionRefresh,
  ServiceDefinitionState,
} from "./service-definition";

// The one implementation of "bring the registered service definition to the
// current launcher form without disturbing a running host" (host lifecycle
// ruling M1). Reached from `traycer host service refresh` - which the desktop
// runs after its own mode writes - and in-process from
// `traycer host lifecycle set`; the doctor asks `inspect` the same question.
// The per-platform read-back, predicate and write live beside each
// installer; see `service-definition.ts` for the shared contract.

export interface ServiceDefinitionRefresher {
  /** Read-only. Never writes and never calls a mutating service verb. */
  inspect(label: ServiceLabel): Promise<ServiceDefinitionState>;
  /**
   * Rewrite a stale definition, and only the definition. Zero mutating
   * service-manager calls when it is already current. Throws
   * `E_SERVICE_DEFINITION_REFRESH_FAILED` when it cannot.
   */
  refresh(label: ServiceLabel): Promise<ServiceDefinitionRefresh>;
}

type ProcessRunner = typeof runCommand;

/**
 * `runner` is the test seam (`null` selects the real `runCommand`), wrapped,
 * like every controller's, so each service-manager call re-checks the
 * caller's mutation authority first.
 */
export function createServiceDefinitionRefresher(
  runner: ProcessRunner | null,
): ServiceDefinitionRefresher {
  const unverifiedRun: ProcessRunner = runner ?? runCommand;
  const run: ProcessRunner = async (command, args, options) => {
    await verifyServiceMutationAuthority();
    return unverifiedRun(command, args, options);
  };
  const platform = osPlatform();
  if (platform === "darwin") {
    return {
      inspect: inspectMacosServiceDefinition,
      refresh: refreshMacosServiceDefinition,
    };
  }
  if (platform === "linux") {
    return {
      inspect: inspectLinuxServiceDefinition,
      refresh: (label) => refreshLinuxServiceDefinition(label, run),
    };
  }
  if (platform === "win32") {
    return {
      inspect: inspectWindowsServiceDefinition,
      refresh: (label) => refreshWindowsServiceDefinition(label, run),
    };
  }
  throw cliError({
    code: CLI_ERROR_CODES.SERVICE_UNSUPPORTED_PLATFORM,
    message: `service definition refresh: unsupported platform '${platform}' (expected darwin|linux|win32)`,
    details: { platform },
    exitCode: 1,
  });
}
