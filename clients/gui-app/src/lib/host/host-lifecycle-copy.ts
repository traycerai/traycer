import type { HostLifecycleMode } from "@traycer-clients/shared/platform/runner-host";
import type { HostBusyBreakdownV2 } from "@traycer/protocol/host/status/index";
import { busyWorkPhrase } from "@/components/host/host-restart-copy";
import { isMac, isWindows } from "@/lib/keybindings/platform";

/**
 * Copy for the host lifecycle surfaces: the Settings → General card, the quit
 * modal, the Overview mode line and the no-local-host card. The wording is the
 * UX artifact's ("Quit flow and settings UX"), kept in one module so the card,
 * the modal and the Overview cannot drift apart.
 */

/**
 * The five modes in the order the card lists them. Restated rather than
 * imported: `@traycer/protocol/config/host-lifecycle-policy` also imports
 * `node:path`, so the renderer may only import its TYPES. `satisfies` keeps
 * the list honest against the protocol's union.
 */
export const HOST_LIFECYCLE_MODE_ORDER = [
  "background",
  "ask",
  "stop-if-idle",
  "linked",
  "none",
] as const satisfies readonly HostLifecycleMode[];

/**
 * What this machine is called in host copy: "Mac", "PC", or "machine" on
 * Linux. Never "device" - that noun is reserved for UI chrome, and the host
 * identity is its `hostId`.
 */
export function hostMachineNoun(): string {
  if (isMac()) return "Mac";
  if (isWindows()) return "PC";
  return "machine";
}

export interface HostLifecycleOptionCopy {
  readonly mode: HostLifecycleMode;
  readonly label: string;
  readonly description: string;
}

export function hostLifecycleOptionCopy(
  machine: string,
): readonly HostLifecycleOptionCopy[] {
  return [
    {
      mode: "background",
      label: "Keep the host running in the background",
      description: `Agents keep working after you quit, and your phone can still reach this ${machine}. The host starts at login.`,
    },
    {
      mode: "ask",
      label: "Ask me each time",
      description:
        "If anything is running you choose whether to keep it going. The host starts with the app.",
    },
    {
      mode: "stop-if-idle",
      label: "Stop the host if nothing is running, otherwise ask",
      description:
        "Quit is instant when the host is idle. The host starts with the app.",
    },
    {
      mode: "linked",
      label: "Stop the host with the app",
      description:
        "Quitting ends any running agents. The host starts and stops with Traycer, like Docker Desktop's engine.",
    },
    {
      mode: "none",
      label: `Don't run a host on this ${machine}`,
      description:
        "Traycer connects only to remote hosts. Use this if your host runs in WSL or on another machine.",
    },
  ];
}

export function hostLifecycleCardSubtitle(machine: string): string {
  return `Choose what happens to the host on this ${machine}. Agents, terminals and shells run on the host.`;
}

/** Why the `none` option is disabled for a plan with no remote hosts. */
export const HOST_LIFECYCLE_NONE_PLAN_REASON =
  "Your plan doesn't include remote hosts, so Traycer needs a host on this machine.";

/** Short name of a mode, for the "Set to X" desired/applied line. */
export function hostLifecycleModeName(mode: HostLifecycleMode): string {
  switch (mode) {
    case "background":
      return "Background";
    case "ask":
      return "Ask";
    case "stop-if-idle":
      return "Stop if idle";
    case "linked":
      return "Linked";
    case "none":
      return "No local host";
  }
}

export const HOST_LIFECYCLE_PENDING_RESTART_HOST = "restart the host to apply";
export const HOST_LIFECYCLE_PENDING_RESTART_APP = "takes effect at next launch";

/**
 * The promise each mode makes about quitting, as the tray and the Overview
 * header show it after the running state ("Host: running · stops with app").
 * Word for word the tray's (`tray-host-lifecycle.ts` in the desktop shell), so
 * the two surfaces never describe one mode two ways. `none` has no promise:
 * there is no host here to make one about.
 */
export function hostLifecycleModePromise(
  mode: HostLifecycleMode,
): string | null {
  switch (mode) {
    case "background":
      return "keeps running after quit";
    case "linked":
      return "stops with app";
    case "ask":
      return "asks when you quit";
    case "stop-if-idle":
      return "stops at quit if idle";
    case "none":
      return null;
  }
}

/**
 * The no-local-host card, on a desktop launched in `none`: "This machine runs
 * without a local host. Add a remote host, or run `traycer host install` on
 * the machine that should host your work (for WSL, inside the distro)." Split
 * around the command so it renders as code.
 */
export const NO_LOCAL_HOST_DESKTOP_LEAD =
  "This machine runs without a local host. Add a remote host, or run";
export const NO_LOCAL_HOST_INSTALL_COMMAND = "traycer host install";
export const NO_LOCAL_HOST_DESKTOP_TAIL =
  "on the machine that should host your work (for WSL, inside the distro).";
export const NO_LOCAL_HOST_RUN_HERE_LABEL = "Run a host here instead";
export const NO_LOCAL_HOST_RUN_HERE_APPLIED =
  "A host will run on this machine from the next launch. Quit and reopen Traycer to start it.";

// ---------------------------------------------------------------------------
// Quit modal
// ---------------------------------------------------------------------------

export const HOST_QUIT_TITLE_BUSY = "The host is still working";
export const HOST_QUIT_TITLE_IDLE = "Keep the host running?";
export const HOST_QUIT_TITLE_UNKNOWN = "Can't tell what's running on the host";
export const HOST_QUIT_TITLE_CHECKING = "Checking the host…";
export const HOST_QUIT_TITLE_STOPPING = "Stopping the host";

export const HOST_QUIT_DESCRIPTION_BUSY =
  "Quitting Traycer can keep the host running so this work continues, or stop it now.";
export const HOST_QUIT_DESCRIPTION_BUSY_RETRY =
  "Something started on the host while it was stopping, so it was left running. Keep it running, or stop it now and end this work.";
export const HOST_QUIT_DESCRIPTION_IDLE =
  "Quitting Traycer can keep the host running so your phone can still reach it, or stop it now.";
export const HOST_QUIT_DESCRIPTION_STOPPING =
  "Traycer quits as soon as the host has stopped.";
export const HOST_QUIT_DESCRIPTION_CHECKING =
  "Traycer is asking this machine's host what it is running.";

/** Why the modal could not read the host, one sentence per cause. */
export type HostQuitUnknownReason = "unreachable" | "no-connection";

export function hostQuitUnknownDescription(
  reason: HostQuitUnknownReason,
): string {
  switch (reason) {
    case "unreachable":
      return "The host didn't answer, so Traycer can't list what it is running. Stopping it may end work in progress.";
    case "no-connection":
      return "Traycer couldn't open a connection to this machine's host - you may be signed out, or its credentials may be refreshing. Stopping it may end work in progress.";
  }
}

/** A click found this machine's host replaced under the open list. */
export const HOST_QUIT_HOST_CHANGED_TITLE = "Host changed";
export const HOST_QUIT_HOST_CHANGED_DESCRIPTION =
  "This machine's host was replaced while this dialog was open, so nothing was stopped. Check the new host's list and choose again.";

export const HOST_QUIT_KEEP_LABEL = "Keep running and quit";
export const HOST_QUIT_STOP_LABEL = "Stop host and quit";
export const HOST_QUIT_STOP_UNKNOWN_LABEL = "Stop host anyway and quit";
export const HOST_QUIT_CANCEL_LABEL = "Cancel";
export const HOST_QUIT_REMEMBER_LABEL =
  "Remember my choice (change it later in Settings → General)";

/** The `→ none` confirm: the same modal with Stop as its only action. */
export const HOST_NONE_CONFIRM_TITLE_BUSY = "The host is still working";
export const HOST_NONE_CONFIRM_TITLE_IDLE = "Stop the host on this machine?";
export const HOST_NONE_CONFIRM_DESCRIPTION =
  "Traycer will stop this machine's host and connect only to remote hosts from the next launch.";
export const HOST_NONE_CONFIRM_STOP_LABEL = "Stop host";
export const HOST_LIFECYCLE_SUPERSEDED_TITLE = "Nothing was changed";
export const HOST_LIFECYCLE_SUPERSEDED_DESCRIPTION =
  "The setting was changed from the command line while this was open, so that choice stands and the host was not stopped.";

export const HOST_LIFECYCLE_READ_FAILED =
  "Couldn't read this setting. Try again, or change it from the command line with `traycer host lifecycle set <mode>`.";
export const HOST_LIFECYCLE_RESTART_HOST_LABEL = "Restart host";

/** The card's footnote, split so the two commands render as code. */
export const HOST_LIFECYCLE_FOOTNOTE_START_COMMAND = "traycer host start";
export const HOST_LIFECYCLE_FOOTNOTE_SET_COMMAND =
  "traycer host lifecycle set <mode>";

/**
 * The progress line while main stops the host. `null` work means the modal
 * never read a list (Linked, or an unreadable host), so it names no subject.
 */
export function hostQuitStoppingLine(
  breakdown: HostBusyBreakdownV2 | null,
): string {
  const work = breakdown === null ? null : busyWorkPhrase(breakdown);
  return work === null ? "Stopping host…" : `Stopping host… ending ${work}`;
}

export interface HostQuitCountsInput {
  /** The host's own verdict (`host.status.busy`). */
  readonly busy: boolean;
  readonly busySessionCount: number | null;
  readonly breakdown: HostBusyBreakdownV2 | null;
  /**
   * The `host.status` minor the host negotiated, or `null` when unknown.
   * Separates "this host version cannot count them" from "this host did not
   * report them" - both arrive as `null` counts.
   */
  readonly statusMinor: number | null;
}

/**
 * The modal's counts line: what the host says is working, then the two
 * informational counts `host.status` @1.6 adds. Those two never change the
 * verdict, and a `null` is never rendered as zero.
 */
export function hostQuitCountsLine(input: HostQuitCountsInput): string {
  const lead = input.busy
    ? busyLead(input.breakdown, input.busySessionCount)
    : idleLead(input.breakdown);
  const extras = extrasSentence(input.breakdown, input.statusMinor);
  return extras === null ? lead : `${lead} ${extras}`;
}

function busyLead(
  breakdown: HostBusyBreakdownV2 | null,
  busySessionCount: number | null,
): string {
  const work = breakdown === null ? null : busyWorkPhrase(breakdown);
  if (work !== null) return `${capitalize(work)} working.`;
  if (busySessionCount !== null && busySessionCount > 0) {
    return busySessionCount === 1
      ? "1 session working."
      : `${busySessionCount} sessions working.`;
  }
  return "The host reports it is busy.";
}

function idleLead(breakdown: HostBusyBreakdownV2 | null): string {
  const extrasRunning =
    breakdown !== null &&
    ((breakdown.shells ?? 0) > 0 || (breakdown.scheduledWakes ?? 0) > 0);
  // "Nothing is running" would contradict the shells named right after it,
  // so an idle host with shells or wakes says what is idle instead.
  return extrasRunning
    ? "No agents or terminals are working on this host right now."
    : "Nothing is running on this host right now.";
}

function extrasSentence(
  breakdown: HostBusyBreakdownV2 | null,
  statusMinor: number | null,
): string | null {
  const shells = breakdown === null ? null : breakdown.shells;
  const wakes = breakdown === null ? null : breakdown.scheduledWakes;
  if (shells === null && wakes === null) {
    return statusMinor !== null && statusMinor >= 6
      ? "Shells and scheduled wakes: not reported by this host."
      : "Shells and scheduled wakes: unknown on this host version.";
  }
  const known = [
    countPhrase(shells, "shell", "shells"),
    countPhrase(wakes, "scheduled wake", "scheduled wakes"),
  ].filter((phrase): phrase is string => phrase !== null);
  const parts: string[] = [];
  if (known.length > 0) parts.push(`Also on this host: ${known.join(", ")}.`);
  if (shells === null) parts.push("Shells: not reported by this host.");
  if (wakes === null) parts.push("Scheduled wakes: not reported by this host.");
  return parts.length === 0 ? null : parts.join(" ");
}

/** "2 shells", or `null` for a zero or unreported count. */
function countPhrase(
  count: number | null,
  singular: string,
  plural: string,
): string | null {
  if (count === null || count <= 0) return null;
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
