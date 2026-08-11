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
