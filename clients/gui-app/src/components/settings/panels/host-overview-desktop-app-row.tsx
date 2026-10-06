/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ Updates ▸ Traycer Desktop row).
 * Update that file whenever this settings surface changes.
 */
import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { requestAppUpdateInstall } from "@/lib/app-update/request-app-update-install";
import {
  trackUpdateDownloadStarted,
  trackUpdateRestartRequested,
} from "@/lib/app-update-analytics";
import type {
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
} from "@/lib/windows/types";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

/**
 * Overview ▸ Updates: where the desktop app stands, beside the host's own
 * update.
 *
 * The host and the app are separate artifacts that update separately, and
 * this page is where a host update happens. Without this row a host that just
 * moved to a new version sits above an app still on the old one, with nothing
 * saying the app has an update of its own to take.
 *
 * It reads the SAME snapshot the header's update button reads and runs the
 * same download and restart, so the two cannot disagree; it adds no update
 * machinery of its own. The caller renders it only in the desktop app, for
 * the host on this machine: a remote host's page says nothing about the app
 * in this window.
 */
export interface HostOverviewDesktopAppRowProps {
  readonly bridge: DesktopAppUpdatesBridge;
  readonly snapshot: DesktopAppUpdateSnapshot;
}

interface DesktopAppRowAction {
  readonly label: string;
  readonly disabled: boolean;
  /**
   * Waiting on the download or the restart this control started: the label
   * stays, a spinner joins it, and a press does nothing. It is NOT natively
   * `disabled` for that span (see `DesktopAppRowActionButton`).
   */
  readonly pending: boolean;
  readonly onClick: () => void;
}

interface DesktopAppRowView {
  /** The one-line state: the four the row exists for, or the bare version. */
  readonly state: string;
  readonly detail: string;
  readonly action: DesktopAppRowAction | null;
  /**
   * What the row's live region says, or "" when it has nothing to say. Only
   * the steps of an update someone started: the download beginning (never
   * its percentage, which would be read out on every tick), the update
   * landing, the restart beginning.
   */
  readonly announcement: string;
}

const UPDATES_SEPARATELY = "The app updates separately from the host.";

export function HostOverviewDesktopAppRow(
  props: HostOverviewDesktopAppRowProps,
): ReactNode {
  const openInstallGuidance = useDesktopDialogStore(
    (state) => state.openInstallGuidance,
  );
  const rowRef = useRef<HTMLDivElement>(null);
  // Read when it is called, not when it is made: by the time the whole row is
  // being removed its ref is already empty, and then nothing is moved.
  const focusRow = useCallback(() => {
    rowRef.current?.focus();
  }, []);
  const { bridge, snapshot } = props;
  // The updater's first snapshot has not arrived: there is no version to
  // name yet, and a row that only says "Traycer Desktop" says nothing.
  if (snapshot.currentVersion === "") {
    return null;
  }
  const view = desktopAppRowView(bridge, snapshot, openInstallGuidance);

  return (
    // Focusable from code only: where the focus goes when the control it was
    // on is withdrawn (see `DesktopAppRowActionButton`).
    <div
      ref={rowRef}
      role="group"
      aria-label="Traycer Desktop"
      tabIndex={-1}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border/40 px-4 py-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      data-testid="host-overview-desktop-app-row"
    >
      <div className="min-w-0 flex-1">
        <p className="text-ui-sm font-medium text-foreground">
          Traycer Desktop
        </p>
        <p
          className="text-ui-xs text-foreground"
          data-testid="host-overview-desktop-app-state"
        >
          {view.state}
        </p>
        <p className="text-ui-xs text-muted-foreground">{view.detail}</p>
        {/* STANDING, and empty when quiet: a polite region is announced when
            its content changes, not when it is inserted already filled, so
            it has to be here before the download or the restart begins. The
            button's own change (it goes `aria-disabled`, its dots hide
            themselves) announces nothing. */}
        <span
          role="status"
          className="sr-only"
          data-testid="host-overview-desktop-app-status"
        >
          {view.announcement}
        </span>
      </div>
      {view.action === null ? null : (
        <DesktopAppRowActionButton
          action={view.action}
          onWithdrawnWithFocus={focusRow}
        />
      )}
    </div>
  );
}

/**
 * The row's one control. It is ONE button from the update being found to the
 * restart: Download, the same button waiting while the download runs, then
 * Restart. Taking it away for the download would drop the focus of whoever
 * just pressed it out of the row, with nothing announcing that anything
 * started.
 *
 * While it waits it is `aria-disabled`, not `disabled`. Chromium moves the
 * focus to the document the moment a focused button becomes `disabled`, and
 * does not give it back when the button is enabled again (measured in the
 * app's engine, Chrome 148; jsdom keeps it, so a test cannot see this). An
 * `aria-disabled` button keeps the focus, so whoever pressed Download is
 * still on the button when it becomes Restart. Native `disabled` is kept for
 * the blocked install, which nobody can have just pressed.
 *
 * It still goes away when the update does (a download or an install that
 * fails, a candidate withdrawn). If it holds the focus at that moment the row
 * takes it, so the keyboard position stays on the state that replaced it
 * instead of falling back to the document.
 */
function DesktopAppRowActionButton(props: {
  readonly action: DesktopAppRowAction;
  readonly onWithdrawnWithFocus: () => void;
}): ReactNode {
  const { action, onWithdrawnWithFocus } = props;
  const buttonRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const button = buttonRef.current;
    // A layout effect's cleanup runs before the button leaves the document,
    // so it can still be asked whether it holds the focus.
    return () => {
      if (button !== null && document.activeElement === button) {
        onWithdrawnWithFocus();
      }
    };
  }, [onWithdrawnWithFocus]);

  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="default"
      size="sm"
      disabled={action.disabled}
      aria-disabled={action.pending ? true : undefined}
      className="aria-disabled:cursor-default aria-disabled:opacity-50"
      data-testid="host-overview-desktop-app-action"
      onClick={action.pending ? undefined : action.onClick}
    >
      <span className="inline-flex items-center gap-1.5">
        <span>{action.label}</span>
        {action.pending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
      </span>
    </Button>
  );
}

function desktopAppRowView(
  bridge: DesktopAppUpdatesBridge,
  snapshot: DesktopAppUpdateSnapshot,
  openInstallGuidance: () => void,
): DesktopAppRowView {
  const current = `v${snapshot.currentVersion}`;
  const runningLine = `This app is on ${current}.`;
  // Same rule as the header button: an install that cannot run from this
  // location keeps its control on screen, disabled, with the reason beside it.
  const blockedReason = snapshot.installBlockedReason;
  const startDownload = (): void => {
    trackUpdateDownloadStarted("direct_ui");
    void bridge.downloadUpdate();
  };

  if (snapshot.status === "available") {
    return {
      state:
        snapshot.latestVersion === null
          ? "Update available"
          : `v${snapshot.latestVersion} available`,
      detail:
        blockedReason ?? `${runningLine} It updates separately from the host.`,
      action: {
        label: "Download",
        disabled: blockedReason !== null,
        pending: false,
        onClick: startDownload,
      },
      announcement: "",
    };
  }

  if (snapshot.status === "downloading") {
    return {
      state:
        snapshot.downloadProgress === null
          ? "Downloading"
          : `Downloading ${snapshot.downloadProgress}%`,
      detail: `${runningLine} It updates separately from the host.`,
      // Download, waiting: the control the download was started from stays.
      action: {
        label: "Download",
        disabled: false,
        pending: true,
        onClick: startDownload,
      },
      announcement: "Downloading the update",
    };
  }

  if (updateIsDownloaded(snapshot)) {
    // A Linux deb/rpm install that needs a manual step: the same guidance
    // dialog the header's tick and the update toast open. The blocked reason
    // wins if both are set.
    const needsManualInstall =
      blockedReason === null && snapshot.installGuidance !== null;
    const readyDetail = needsManualInstall
      ? `${runningLine} Finishing the update needs a manual step.`
      : `${runningLine} Restart it to install the update.`;
    const readyState =
      snapshot.latestVersion === null
        ? "Update ready"
        : `v${snapshot.latestVersion} ready`;
    return {
      state: readyState,
      detail: blockedReason ?? readyDetail,
      action: {
        label: needsManualInstall ? "Finish update" : "Restart",
        disabled: blockedReason !== null,
        pending: snapshot.installInFlight,
        onClick: () => {
          if (needsManualInstall) {
            Analytics.getInstance().track(
              AnalyticsEvent.UpdateInstallGuidanceOpened,
              { source: "direct_ui" },
            );
            openInstallGuidance();
            return;
          }
          trackUpdateRestartRequested("direct_ui");
          void requestAppUpdateInstall(bridge);
        },
      },
      announcement: readyAnnouncement(
        readyState,
        needsManualInstall,
        snapshot.installInFlight,
      ),
    };
  }

  return {
    state: lastCheckFoundNothing(snapshot)
      ? `Up to date (${current})`
      : current,
    detail: UPDATES_SEPARATELY,
    action: null,
    announcement: "",
  };
}

function readyAnnouncement(
  readyState: string,
  needsManualInstall: boolean,
  installInFlight: boolean,
): string {
  if (installInFlight) return "Restarting to install the update";
  // Not the bare state: a restart whose privilege prompt failed lands here
  // from "ready", and repeating "ready" would say nothing had happened.
  if (needsManualInstall) {
    return `${readyState}. Finishing the update needs a manual step.`;
  }
  return readyState;
}

/**
 * The update is on disk and waiting to be installed: `ready`, and also an
 * `error` that carries manual-install guidance. That second one is how a
 * Linux deb/rpm install whose privilege prompt failed arrives: the updater
 * reports the failure AND the steps that finish the same downloaded file by
 * hand, so the update is still there to finish. Any other `error` has
 * nothing to act on here; the update toast reports it.
 *
 * The updater keeps that guidance until the staged update is discarded, so
 * an `error` can also carry it from an EARLIER failed install (a newer
 * version found afterwards, whose download then failed). The snapshot does
 * not say which, and the update toast offers its View instructions on the
 * same pair, so the row reads it the same way rather than guess.
 */
function updateIsDownloaded(snapshot: DesktopAppUpdateSnapshot): boolean {
  if (snapshot.status === "ready") return true;
  return snapshot.status === "error" && snapshot.installGuidance !== null;
}

/**
 * "Up to date" is a claim about a check, so it needs one that finished and
 * found nothing. The updater publishes that as `up-to-date` only for a check
 * the user asked for; the automatic check that finds nothing goes back to
 * `idle`, with the check's time and the feed's latest version beside it. An
 * `idle` with neither - nothing checked yet, a candidate discarded, the
 * channel just switched - and every other state (checking, error, updates
 * unavailable for this build) claim nothing: the row shows the version alone.
 */
function lastCheckFoundNothing(snapshot: DesktopAppUpdateSnapshot): boolean {
  if (snapshot.status === "up-to-date") return true;
  return (
    snapshot.status === "idle" &&
    snapshot.lastCheckedAt !== null &&
    snapshot.latestVersion !== null
  );
}
