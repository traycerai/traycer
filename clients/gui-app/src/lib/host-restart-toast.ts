import { toast } from "sonner";

// A `declined` restart result is not an error: the host deliberately was
// not restarted - it denied the shutdown claim to protect in-progress
// work, was removed by the user, or another Traycer process holds the
// management lock - and the condition clears on its own or on a later
// retry. Routing it through `toastFromRunnerError` gave it a "Report
// issue" affordance, inviting issue reports for a self-recovering state
// (field RCA 2026-07-28), so every restart surface renders it through
// this plain informational toast instead.
export function toastHostRestartDeclined(message: string): void {
  toast.info("Host not restarted", { description: message });
}

// The same self-clearing, retryable meaning as above, for the Doctor repairs
// that are NOT restarts. `runDoctorRepairIfIdle` refuses `host-install-latest`
// and `service-install` through the identical "nothing was enqueued" arm a
// declined restart uses, so they used to borrow this file's restart wording
// and told someone who clicked Install host that their host was "not
// restarted" - naming an action they never asked for. `action` is the button's
// own label (`fixActionLabel`), so the toast names exactly what was clicked.
export function toastHostRepairDeclined(action: string, message: string): void {
  toast.info(`${action} didn't run`, { description: message });
}

// One wording for every surface that requests a restart (tray, menu, doctor
// card, Overview panel) - the audit found three ("Host restart requested"
// from the tray/menu, "Restarting <host>" from the two Settings surfaces).
// The host name doesn't earn its place here: the surface the click came from
// already names the host being restarted, so this toast only has to confirm
// the click landed.
export function toastHostRestartRequested(): void {
  toast.success("Host restart requested");
}
