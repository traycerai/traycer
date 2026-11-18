import { CLI_ERROR_CODES } from "../runner/errors";
import type { ServiceLabel } from "./label";
import { readWindowsServiceTaskOwnership } from "./platforms/windows";
import {
  serviceTaskLeftInPlaceMessage,
  serviceTaskNotOwnedError,
  serviceTaskNotOwnedMessage,
  type WindowsTaskNotOwnedReason,
} from "./platforms/windows-task-gate";
import { SERVICE_REGISTRATION_DISABLED_MESSAGE } from "./registration-disabled";

/**
 * Whose service registration this is, for the commands that report it or
 * refuse on it before doing anything. Only Windows has a registration another
 * account can own (the machine-global Scheduled Task); every other platform
 * reads `own-or-none`.
 *
 * Its own module, not an export of `./index`, for `./registration-disabled`'s
 * reason: suites that replace the whole service facade keep working.
 */
export type ServiceRegistrationOwnership =
  | { readonly kind: "own-or-none" }
  | {
      readonly kind: "not-owned";
      readonly reason: WindowsTaskNotOwnedReason;
    };

export async function readServiceRegistrationOwnership(
  label: ServiceLabel,
  platform: NodeJS.Platform,
): Promise<ServiceRegistrationOwnership> {
  if (platform !== "win32") return { kind: "own-or-none" };
  const ownership = await readWindowsServiceTaskOwnership(label);
  return ownership.kind === "not-owned"
    ? { kind: "not-owned", reason: ownership.reason }
    : { kind: "own-or-none" };
}

/**
 * A notice a command that SUCCEEDED carries about the service registration it
 * left as it found it: the payload's `serviceWarning`, beside the result it
 * describes. A caller built before the field ignores it and sees the same
 * success it always did.
 */
export interface ServiceRegistrationWarning {
  readonly code: string;
  readonly message: string;
  /**
   * `E_SERVICE_TASK_NOT_OWNED`'s `details`, as its refusal carries them: why
   * the task is not this account's. `null` for every other code.
   */
  readonly details: { readonly reason: WindowsTaskNotOwnedReason } | null;
}

/**
 * `host uninstall` finished this account's teardown beside a task that is not
 * this account's, and says so by reason.
 */
export function serviceTaskLeftInPlaceWarning(
  reason: WindowsTaskNotOwnedReason,
): ServiceRegistrationWarning {
  return {
    code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
    message: serviceTaskLeftInPlaceMessage(reason),
    details: { reason },
  };
}

/**
 * A registration refused because it is not this account's, carried as a
 * warning by a command with its own work that finished (`host install`'s
 * bytes), in the refusal's own words for `reason`.
 */
export function serviceTaskNotOwnedWarning(
  reason: WindowsTaskNotOwnedReason,
): ServiceRegistrationWarning {
  return {
    code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
    message: serviceTaskNotOwnedMessage(reason),
    details: { reason },
  };
}

/**
 * An install that carried a disabled registration over: the bytes are in, the
 * task is still disabled, so nothing started the host.
 */
export const SERVICE_KEPT_DISABLED_WARNING: ServiceRegistrationWarning = {
  code: CLI_ERROR_CODES.SERVICE_REGISTRATION_DISABLED,
  message: `The host is stopped because ${SERVICE_REGISTRATION_DISABLED_MESSAGE}.`,
  details: null,
};

export { serviceTaskNotOwnedError };
