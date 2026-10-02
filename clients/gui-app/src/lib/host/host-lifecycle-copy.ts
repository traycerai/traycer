import type {
  HostLifecycleMode,
  HostLifecycleSetFailure,
  HostLifecycleStopRefusal,
  HostLifecycleView,
} from "@traycer-clients/shared/platform/runner-host";
import type { HostBusyBreakdownV2 } from "@traycer/protocol/host/status/index";
import { busyWorkPhrase } from "@/components/host/host-restart-copy";
import { isForegroundHostRun } from "@/lib/host/host-foreground-run";
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
      description: `Agents keep working after you quit Traycer. You can still connect to this ${machine} from your other devices. The host starts when you log in.`,
    },
    {
      mode: "ask",
      label: "Ask me each time",
      description:
        "When you quit Traycer, choose whether to keep work running or stop it. The host starts when you open Traycer.",
    },
    {
      mode: "stop-if-idle",
      label: "Stop the host if nothing is running, otherwise ask",
      description:
        "When you quit Traycer, the host stops if nothing is running. Otherwise, you choose whether to keep work running or stop it. The host starts when you open Traycer.",
    },
    {
      mode: "linked",
      label: "Stop the host with the app",
      description:
        "The host starts when you open Traycer and stops when you quit, ending work running on it. A host you started in a terminal keeps running.",
    },
    {
      mode: "none",
      label: `Don't run a host on this ${machine}`,
      description:
        "Traycer connects only to remote hosts, where your agents and terminals run. No host starts when you open Traycer on this machine.",
    },
  ];
}

export function hostLifecycleCardSubtitle(machine: string): string {
  return `Choose what happens to the host on this ${machine}. Agents, terminals and shells run on the host.`;
}

/** Why the `none` option is disabled while signed out. */
export const HOST_LIFECYCLE_NONE_SIGNED_OUT_REASON =
  "Sign in to use remote hosts. Until then, Traycer needs a host on this machine.";

/**
 * Why the modes that run a host here are held while the host's Scheduled Task
 * is not this account's: this account gets no background host on this PC, so
 * there is nothing for them to change. True of both reasons - another Windows
 * user's task, and one whose owner could not be confirmed - so it names no
 * owner; the card's notice above says which.
 */
export const HOST_LIFECYCLE_TASK_NOT_OWNED_REASON =
  "Unavailable while the Traycer Host task on this PC isn't confirmed as yours.";

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
 * A host a person started in a terminal: the mode does not govern it, so the
 * lines that state the mode's promise say this instead, whatever the mode. The
 * tray's words too ("Host: running · started in a terminal").
 */
export const HOST_STARTED_IN_A_TERMINAL = "started in a terminal";

/**
 * The Overview line after the running state: the mode's promise, or
 * {@link HOST_STARTED_IN_A_TERMINAL} during a foreground run, which no mode
 * governs - `none` included, since that host is running all the same.
 */
export function hostLifecycleRunLine(view: HostLifecycleView): string | null {
  if (isForegroundHostRun(view)) return HOST_STARTED_IN_A_TERMINAL;
  return hostLifecycleModePromise(view.desired.mode);
}

/**
 * Why a Restart is disabled during a foreground run: the app never restarts
 * a host it did not start. `…_TO_APPLY` is the restart-to-apply line's.
 */
export const HOST_FOREGROUND_RESTART_TO_APPLY_REASON =
  "A host started in a terminal is running; restart it yourself to apply.";
export const HOST_FOREGROUND_RESTART_REASON =
  "A host started in a terminal is running; restart it yourself.";

/**
 * What stands in for an update's Update now / Restart during a foreground run:
 * the desktop cannot finish an update over it (the CLI refuses apply, install
 * and the activation restart with `E_HOST_NOT_SERVICE_RUN`), and it clears by
 * itself once that run ends and main pushes the next view.
 */
export const HOST_FOREGROUND_UPDATE_READY =
  "Update ready. A host you started in a terminal is running; stop it to finish the update.";

/**
 * {@link HOST_FOREGROUND_UPDATE_READY}'s sibling for when stopping that run
 * would NOT finish the update: this app starts and updates no local host in
 * `none` (booted in it, or `→ none` committed this session), so the person
 * who started the run updates it too.
 */
export const HOST_FOREGROUND_UPDATE_READY_UNMANAGED =
  "Update ready. A host you started in a terminal is running; update it yourself.";

/**
 * What an update surface says in place of its Update now / Restart / Install
 * during a foreground run, or `null` when there is none. The home banner, the
 * Overview's answer card, update card and version rows all read this one
 * picker, so they cannot disagree about which sentence is true: "stop it to
 * finish the update" holds only while this app finishes local updates - it
 * manages the local host (`applied.localHostCapability`) and is not leaving
 * that for `none` at the next launch (`pending`). The controls themselves are
 * withheld in every mode: the CLI refuses them over a run it did not start,
 * whatever the mode.
 */
export function hostForegroundUpdateLine(
  view: HostLifecycleView | undefined,
): string | null {
  if (view === undefined || !isForegroundHostRun(view)) return null;
  return view.applied.localHostCapability === "managed" &&
    view.pending !== "restart-app"
    ? HOST_FOREGROUND_UPDATE_READY
    : HOST_FOREGROUND_UPDATE_READY_UNMANAGED;
}

/**
 * Why registering the OS service is withheld during a foreground run: the CLI
 * refuses a registration while that run is live, and the run is the person's
 * to stop. Once it is stopped, registering works as ever.
 */
export const HOST_FOREGROUND_REGISTER_SERVICE_REASON =
  "A host you started in a terminal is running; stop it, then register the service.";

/**
 * Why Remove Traycer is withheld during a foreground run: removing the host
 * would stop a run this app did not start, so the CLI refuses it
 * (`E_HOST_NOT_SERVICE_RUN`) and the person stops that run first.
 */
export const HOST_FOREGROUND_REMOVE_TRAYCER_REASON =
  "A host you started in a terminal is running; stop it, then remove Traycer.";

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
/**
 * Says only what Traycer does. Whether the host ends, and when, depends on how
 * it was started: a service-run host is stopped here, but a terminal-started
 * one is not the service's to stop (`not-service-run`), so this line promises
 * nothing about the host either way.
 */
export const HOST_QUIT_DESCRIPTION_STOPPING =
  "Traycer quits once the stop has run.";
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
/**
 * The `→ none` confirm during a foreground run. Main commits `none` then and
 * refuses the stop (`not-service-run`), so this form offers no Stop and says
 * the terminal host is left alone.
 */
export const HOST_NONE_CONFIRM_TITLE_FOREGROUND = "Switch to No local host?";
export const HOST_NONE_CONFIRM_DESCRIPTION_FOREGROUND =
  "A host started in a terminal is running. Traycer won't stop it: it keeps running until you stop it there. From the next launch, Traycer connects only to remote hosts.";
export const HOST_NONE_CONFIRM_SWITCH_LABEL = "Switch";
export const HOST_LIFECYCLE_SUPERSEDED_TITLE = "Nothing was changed";
export const HOST_LIFECYCLE_SUPERSEDED_DESCRIPTION =
  "The setting was changed from the command line while this was open, so that choice stands and the host was not stopped.";

export const HOST_LIFECYCLE_READ_FAILED =
  "Couldn't read this setting. Try again, or change it from the command line with `traycer host lifecycle set <mode>`.";

/**
 * What a surface says when main did not apply a lifecycle change, chosen by
 * the reason alone. The result's `message` is never shown: it is often the
 * CLI's instruction to its own caller ("Re-run with --force", a lock file's
 * path) or an error string that can carry a home path, and main logs it.
 *
 * `write-failed` does not say "nothing was changed": on the `→ none` path it
 * follows a stop that already ran.
 */
export function hostLifecycleSetRefusalCopy(
  reason: HostLifecycleStopRefusal | HostLifecycleSetFailure,
): string {
  switch (reason) {
    case "host-busy":
      return "The host has work in progress, so it was left running. Stop host again to end that work.";
    case "lock-busy":
      return "Another Traycer process is managing the host right now, so nothing was changed. Try again in a moment.";
    case "update-active":
      return "The host is installing an update, so nothing was changed. Try again once it finishes.";
    case "stop-failed":
      return "The host couldn't be stopped, so nothing was changed. If you started it from a terminal, stop it there, then try again.";
    case "write-failed":
      return "Couldn't save this setting. Try again, or change it from the command line with `traycer host lifecycle set <mode>`.";
    case "confirmation-required":
      return "Turning off the local host stops Traycer Host. Confirm the stop to continue.";
  }
}
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
  // "Nothing is running" is a claim about the shells and wakes too, so it is
  // made only when the host counted both and both are zero. Any other idle
  // host - shells or wakes running, or a count it did not report - says what
  // its idle verdict does cover, and the sentence after it says the rest.
  const nothingRunning =
    breakdown !== null &&
    breakdown.shells === 0 &&
    breakdown.scheduledWakes === 0;
  return nothingRunning
    ? "Nothing is running on this host right now."
    : "No agents or terminals are working on this host right now.";
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
