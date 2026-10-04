import { toast } from "sonner";
import {
  HOST_UPDATED_SERVICE_DISABLED_MESSAGE,
  HOST_UPDATE_SERVICE_DISABLED_MESSAGE,
  isServiceTaskNotOwnedMessage,
  SERVICE_TASK_NOT_OWNED_MESSAGE,
  SERVICE_TASK_OWNER_UNCONFIRMED_MESSAGE,
} from "@traycer-clients/shared/platform/host-service-notices";

// The deferrals desktop main resolves for a service registration no retry can
// change: a task its owner disabled (the update waits, or it applied and left
// the host stopped) and a task that is not this account's - another Windows
// user's, or one whose owner could not be confirmed. They are notices, not
// failed updates - no "Update failed", no failure analytics, no Retry - and
// every surface that runs an update tells them apart the same way.
const HOST_SERVICE_NOTICE_MESSAGES: ReadonlySet<string> = new Set([
  HOST_UPDATE_SERVICE_DISABLED_MESSAGE,
  HOST_UPDATED_SERVICE_DISABLED_MESSAGE,
  SERVICE_TASK_NOT_OWNED_MESSAGE,
  SERVICE_TASK_OWNER_UNCONFIRMED_MESSAGE,
]);

/** Whether a `deferred` outcome's message is one of those notices. */
export function isHostServiceNotice(message: string): boolean {
  return HOST_SERVICE_NOTICE_MESSAGES.has(message);
}

/**
 * The notice as a toast: informational for a task that is not this account's
 * (nothing here can change it), a warning for a disabled task.
 */
export function toastHostServiceNotice(message: string): void {
  if (isServiceTaskNotOwnedMessage(message)) {
    toast.info(message);
    return;
  }
  toast.warning(message);
}
