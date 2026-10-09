import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError, type CliError } from "../runner/errors";
import { windowsTaskName, type ServiceLabel } from "./label";
import { readWindowsTaskEnabledState } from "./platforms/windows";
import { SERVICE_REINSTALL_COMMAND } from "./service-definition";

/**
 * A service registration its owner switched off: today the Windows task
 * disabled in Task Scheduler. It is the user's setting, so nothing the CLI
 * does on its own re-enables it - a re-registration (`/Create /F` from
 * `buildTaskXmlForUser`) would, silently, so a failed start over one reports
 * this instead of escalating, and `host doctor` names the same two repairs.
 *
 * Its own module, not an export of `./index`: suites that replace the whole
 * service facade keep working without knowing it exists.
 */
export type ServiceRegistrationDisabled =
  | { readonly kind: "disabled" }
  | { readonly kind: "not-disabled" }
  | { readonly kind: "unknown"; readonly reason: string };

/** What a start refused over a disabled registration reports, exactly. */
export const SERVICE_REGISTRATION_DISABLED_MESSAGE = `the Traycer Host task is disabled in Task Scheduler; enable it or run \`${SERVICE_REINSTALL_COMMAND}\``;

/**
 * Read-only. Only Windows has a switch to read: a macOS or Linux
 * registration reads `not-disabled`, and so does a task that is not
 * registered at all.
 */
export async function readServiceRegistrationDisabled(
  label: ServiceLabel,
  platform: NodeJS.Platform,
): Promise<ServiceRegistrationDisabled> {
  if (platform !== "win32") return { kind: "not-disabled" };
  const state = await readWindowsTaskEnabledState(label);
  switch (state.kind) {
    case "disabled":
      return { kind: "disabled" };
    case "enabled":
    case "not-registered":
      return { kind: "not-disabled" };
    case "unknown":
      return { kind: "unknown", reason: state.reason };
  }
}

export function serviceRegistrationDisabledError(
  environment: Environment,
  label: ServiceLabel,
  cause: string,
): CliError {
  return cliError({
    code: CLI_ERROR_CODES.SERVICE_REGISTRATION_DISABLED,
    message: SERVICE_REGISTRATION_DISABLED_MESSAGE,
    details: { environment, task: windowsTaskName(label), cause },
    exitCode: 1,
  });
}
