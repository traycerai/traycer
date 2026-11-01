import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";

/** The move an awake sandbox still reads as, until its host first reports. */
export type SandboxWakeWait = "resuming" | "starting";

/** What can show a host has reported since its row turned awake. */
export interface SandboxWakeEvidence {
  /** A ready session here, or the relay holding the host's own leg. */
  readonly answers: boolean;
  /** The `lastTransitionAt` of the wake this device last saw it answer in. */
  readonly answeredWake: number | null;
}

/**
 * The wait for a waking row's host to first report, or `null` once it has, or
 * on a row that does not wait: a failed configuration has its own line, and
 * an Automations pod its own clock. A row the list still calls `resuming` or
 * `starting` waits by its state.
 *
 * Nothing but the row ends this wait when a host never reports: its idle
 * clock runs from the wake, and the idle pass then stops or destroys it.
 *
 * A device that was not watching still has the cloud's word for a host that
 * came up and then went quiet: the activity it reported, later than the wake.
 * An idle host posts nothing, so one that came up, did nothing and died reads
 * as this wait here, and that same silence is what lets the idle pass end it.
 */
export function sandboxWakeWait(
  summary: SandboxSummary,
  evidence: SandboxWakeEvidence,
): SandboxWakeWait | null {
  if (
    summary.frozen ||
    summary.kind === "automation" ||
    summary.guestConfigured === false
  ) {
    return null;
  }
  if (summary.state === "resuming" || summary.state === "starting") {
    return summary.state;
  }
  if (summary.state !== "awake") return null;
  const wake = summary.lastTransitionAt;
  if (
    evidence.answers ||
    evidence.answeredWake === wake ||
    (summary.lastActivityAt !== null && summary.lastActivityAt > wake)
  ) {
    return null;
  }
  return sandboxWakeMove(summary);
}

/** How the row came awake; a row with no wake on record was just created. */
function sandboxWakeMove(summary: SandboxSummary): SandboxWakeWait {
  return summary.operation?.fromState === "suspended" ? "resuming" : "starting";
}
