import type { ReactNode } from "react";
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
  /** The restart is under way: the label stays, a spinner joins it. */
  readonly pending: boolean;
  readonly onClick: () => void;
}

interface DesktopAppRowView {
  /** The one-line state: the four the row exists for, or the bare version. */
  readonly state: string;
  readonly detail: string;
  readonly action: DesktopAppRowAction | null;
}

const UPDATES_SEPARATELY = "The app updates separately from the host.";

export function HostOverviewDesktopAppRow(
  props: HostOverviewDesktopAppRowProps,
): ReactNode {
  const openInstallGuidance = useDesktopDialogStore(
    (state) => state.openInstallGuidance,
  );
  const { bridge, snapshot } = props;
  // The updater's first snapshot has not arrived: there is no version to
  // name yet, and a row that only says "Traycer Desktop" says nothing.
  if (snapshot.currentVersion === "") {
    return null;
  }
  const view = desktopAppRowView(bridge, snapshot, openInstallGuidance);

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border/40 px-4 py-3"
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
      </div>
      {view.action === null ? null : (
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={view.action.disabled}
          data-testid="host-overview-desktop-app-action"
          onClick={view.action.onClick}
        >
          <span className="inline-flex items-center gap-1.5">
            <span>{view.action.label}</span>
            {view.action.pending ? (
              // The button only goes `disabled`, and the dots hide
              // themselves from assistive technology: the live region is
              // what says the restart is under way, as on the header button.
              <span role="status" aria-label="Restarting to install the update">
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant={undefined}
                />
              </span>
            ) : null}
          </span>
        </Button>
      )}
    </div>
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
        onClick: () => {
          trackUpdateDownloadStarted("direct_ui");
          void bridge.downloadUpdate();
        },
      },
    };
  }

  if (snapshot.status === "downloading") {
    return {
      state:
        snapshot.downloadProgress === null
          ? "Downloading"
          : `Downloading ${snapshot.downloadProgress}%`,
      detail: `${runningLine} It updates separately from the host.`,
      action: null,
    };
  }

  if (snapshot.status === "ready") {
    // A Linux deb/rpm install that needs a manual step: the same guidance
    // dialog the header's tick opens. The blocked reason wins if both are set.
    const needsManualInstall =
      blockedReason === null && snapshot.installGuidance !== null;
    const readyDetail = needsManualInstall
      ? `${runningLine} Finishing the update needs a manual step.`
      : `${runningLine} Restart it to install the update.`;
    return {
      state:
        snapshot.latestVersion === null
          ? "Update ready"
          : `v${snapshot.latestVersion} ready`,
      detail: blockedReason ?? readyDetail,
      action: {
        label: needsManualInstall ? "Finish update" : "Restart",
        disabled: blockedReason !== null || snapshot.installInFlight,
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
    };
  }

  return {
    state: lastCheckFoundNothing(snapshot)
      ? `Up to date (${current})`
      : current,
    detail: UPDATES_SEPARATELY,
    action: null,
  };
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
