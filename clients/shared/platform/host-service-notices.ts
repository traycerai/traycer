// The desktop's words for the two service-registration states a person cannot
// fix by retrying, shared by main (which emits them as outcome messages and
// status fields) and the renderer (which recognises them to render a notice
// with the right action instead of a failure). Main owns the copy; the CLI's
// own text is never relayed, so an older bundled CLI cannot change it. None of
// it names an account: a task's owner is "another Windows user", always, and
// only when the CLI confirmed that it is.

/**
 * The CLI's refusal of any write to a Scheduled Task that is not this
 * account's. The task name is machine-global, so the second account on a PC
 * finds the first one's task and gets no background host of its own.
 */
export const SERVICE_TASK_NOT_OWNED_CODE = "E_SERVICE_TASK_NOT_OWNED";

/**
 * Why the CLI treated the task as not this account's, as it sends it in
 * `details.reason` - on the `E_SERVICE_TASK_NOT_OWNED` refusal, and on a
 * `serviceWarning` or `postSwapWarning` of that code. `other-owner`: the
 * task's principal is another account's. `unconfirmed`: nothing could confirm
 * whose it is - the task, its principal or this account's own SID could not
 * be read or resolved - and the CLI failed closed. The behaviour is the same
 * (nothing is written); only the words differ.
 */
export type ServiceTaskNotOwnedReason = "other-owner" | "unconfirmed";

/** Another account's task. */
export const SERVICE_TASK_NOT_OWNED_MESSAGE =
  "The Traycer Host task on this PC is owned by another Windows user, so Traycer can't run a background host for you here. Connect to a remote host, or ask that user to remove Traycer from their account first.";
/**
 * A task whose owner could not be confirmed. It names no owner, because none
 * was found. The CLI's refusal says this same sentence, so a desktop that
 * relays the CLI's text verbatim shows it too.
 */
export const SERVICE_TASK_OWNER_UNCONFIRMED_MESSAGE =
  "Traycer couldn't confirm that the Traycer Host task on this PC belongs to your Windows account, so it left the task alone. Try again, or run `traycer host doctor`.";

/** A removal that finished this account's teardown beside another's task. */
export const SERVICE_TASK_LEFT_IN_PLACE_MESSAGE =
  "The Traycer Host task on this PC is owned by another Windows user, so it was left in place; everything of yours was removed.";
/** The same, beside a task whose owner could not be confirmed. */
export const SERVICE_TASK_OWNER_UNCONFIRMED_LEFT_IN_PLACE_MESSAGE =
  "Traycer couldn't confirm that the Traycer Host task on this PC belongs to your Windows account, so it left the task in place; everything of yours was removed.";

/**
 * The reason a CLI payload's `details` carries. Anything but an explicit
 * `other-owner` reads as `unconfirmed`, so this app names another user only
 * when the CLI said so.
 */
export function serviceTaskNotOwnedReason(
  details: unknown,
): ServiceTaskNotOwnedReason {
  if (typeof details !== "object" || details === null) return "unconfirmed";
  return Reflect.get(details, "reason") === "other-owner"
    ? "other-owner"
    : "unconfirmed";
}

/** What a refused write, or a host this account cannot run, says. */
export function serviceTaskNotOwnedMessage(
  reason: ServiceTaskNotOwnedReason,
): string {
  return reason === "other-owner"
    ? SERVICE_TASK_NOT_OWNED_MESSAGE
    : SERVICE_TASK_OWNER_UNCONFIRMED_MESSAGE;
}

/** What a removal that left the task in place says. */
export function serviceTaskLeftInPlaceMessage(
  reason: ServiceTaskNotOwnedReason,
): string {
  return reason === "other-owner"
    ? SERVICE_TASK_LEFT_IN_PLACE_MESSAGE
    : SERVICE_TASK_OWNER_UNCONFIRMED_LEFT_IN_PLACE_MESSAGE;
}

/** Whether an outcome's message is either reason's not-owned notice. */
export function isServiceTaskNotOwnedMessage(message: string): boolean {
  return (
    message === SERVICE_TASK_NOT_OWNED_MESSAGE ||
    message === SERVICE_TASK_OWNER_UNCONFIRMED_MESSAGE
  );
}

/**
 * The CLI's code for a service registration its owner switched off (Windows:
 * the host's Scheduled Task disabled in Task Scheduler). Only the named repair
 * - `traycer host service install`, Doctor's Register service, the update
 * row's enable action - turns it back on.
 */
export const SERVICE_REGISTRATION_DISABLED_CODE =
  "E_SERVICE_REGISTRATION_DISABLED";
/** The launch apply left the stage in place over it: the update is waiting. */
export const HOST_UPDATE_SERVICE_DISABLED_MESSAGE =
  "This update is waiting because the Traycer Host task is disabled in Task Scheduler. Enable the background service to install it.";
/** A person's Update now applied the bytes and left the task off. */
export const HOST_UPDATED_SERVICE_DISABLED_MESSAGE =
  "The host was updated, but the Traycer Host task is disabled in Task Scheduler, so the host was not started. Enable the background service to start it.";
/** The action that turns the task back on (`host service install`). */
export const ENABLE_BACKGROUND_SERVICE_LABEL = "Enable background service";
