import { toast } from "sonner";

// A `declined` restart result is not an error: the host deliberately was not restarted - it denied the shutdown claim to protect in-progress work, was removed by the user, or another Traycer process holds the management lock - and the condition clears on its.
export function toastHostRestartDeclined(message: string): void {
  toast.info("Host not restarted", { description: message });
}

// The same self-clearing, retryable meaning as above, for the Doctor repairs that are NOT restarts.
// `runDoctorRepairIfIdle` refuses `host-install-latest` and `service-install` through the identical "nothing was enqueued" arm a declined restart uses, so they used to borrow this file's restart wording and told someone who clicked Install host that their.
export function toastHostRepairDeclined(action: string, message: string): void {
  toast.info(`${action} didn't run`, { description: message });
}

// One wording for every surface that requests a restart (tray, menu, doctor card, Overview panel) - the audit found three ("Host restart requested" from the tray/menu, "Restarting <host>" from the two Settings surfaces).
export function toastHostRestartRequested(): void {
  toast.success("Host restart requested");
}
