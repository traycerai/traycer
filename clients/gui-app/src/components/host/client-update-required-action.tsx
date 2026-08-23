import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { traycerInfo } from "@traycer-clients/shared/platform/traycer-info";
import { useDesktopAppUpdates } from "@/hooks/runner/use-desktop-app-updates";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { requestAppUpdateInstall } from "@/lib/app-update/request-app-update-install";
import {
  trackUpdateDownloadStarted,
  trackUpdateRestartRequested,
} from "@/lib/app-update-analytics";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import type { ClientUpgradeChannel } from "@traycer/protocol/framework/index";

/**
 * THE remedy for a host that refused this client at its compatibility-epoch
 * gate: update THIS app.
 *
 * Every arm below leads somewhere that can actually produce a newer build.
 * That is the whole design constraint, and it is why this is not simply the
 * header's update button in a bigger size: this surface is BLOCKING, so an
 * affordance that quietly renders nothing (which the header button correctly
 * does whenever the updater is idle) would leave a user staring at a dialog
 * that names a problem and offers no way out. There is always a link.
 *
 * What it deliberately never offers: Update host (the host is the newer leg by
 * construction, so re-installing it cannot help and would suggest the user is
 * fixing the right machine), Retry (the same binary against the same host
 * reaches the same verdict), and any form of reset or rollback (the data is
 * intact and migrated - discarding it is the destructive thing a stuck user
 * reaches for, which is exactly what the host's own reason text rules out).
 */
export function ClientUpdateRequiredAction(props: {
  /**
   * The channel the required build was published on, from the host's
   * structured requirement. `null` when the host did not say.
   *
   * It is used ONLY to pick between two first-party links, never to decide
   * whether the app is compatible and never as an address to open.
   */
  readonly upgradeChannel: ClientUpgradeChannel | null;
}): ReactNode {
  const { bridge, snapshot } = useDesktopAppUpdates();
  const openExternalLink = useRunnerOpenExternalLink();
  const openInstallGuidance = useDesktopDialogStore(
    (state) => state.openInstallGuidance,
  );

  // CHANNEL MISMATCH: the fix is on the RC line and this installation follows
  // stable, so the in-app updater will keep reporting "up to date" forever
  // while the host keeps refusing. Route straight to the releases page rather
  // than offering a Download button that cannot find the build - an updater
  // that says "no update available" beside "your app is too old" is the most
  // confusing state this surface can produce.
  const channelUnreachable =
    props.upgradeChannel === "rc" && !snapshot.allowPrerelease;

  if (bridge !== null && !channelUnreachable) {
    if (snapshot.status === "available") {
      // A blocked location (macOS app outside /Applications) cannot install
      // even once downloaded, so it falls through to the link below - the
      // manual download IS the remedy there.
      if (snapshot.installBlockedReason === null) {
        return (
          <Button
            type="button"
            size="sm"
            variant="default"
            data-testid="client-update-required-download"
            onClick={() => {
              trackUpdateDownloadStarted("direct_ui");
              void bridge.downloadUpdate();
            }}
          >
            Download update
          </Button>
        );
      }
    } else if (snapshot.status === "downloading") {
      return (
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled
          data-testid="client-update-required-downloading"
        >
          <span className="inline-flex items-center gap-1.5">
            <span>
              {snapshot.downloadProgress === null
                ? "Downloading update"
                : `Downloading ${snapshot.downloadProgress}%`}
            </span>
            <AgentSpinningDots
              className="text-current"
              testId={undefined}
              variant={undefined}
            />
          </span>
        </Button>
      );
    } else if (
      snapshot.status === "ready" &&
      snapshot.installBlockedReason === null
    ) {
      const needsManualInstall = snapshot.installGuidance !== null;
      return (
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={snapshot.installInFlight}
          data-testid="client-update-required-install"
          onClick={() => {
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
          }}
        >
          <span className="inline-flex items-center gap-1.5">
            <span>
              {needsManualInstall ? "Finish update" : "Restart to update"}
            </span>
            {snapshot.installInFlight ? (
              <AgentSpinningDots
                className="text-current"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
          </span>
        </Button>
      );
    }
  }

  // THE FLOOR, reached whenever the updater cannot help: no bridge (web/dev
  // shell), a channel this installation does not follow, an install location
  // that cannot be written, or simply an updater that has not found anything
  // yet. A first-party address chosen locally - never one the host supplied.
  return (
    <Button
      type="button"
      size="sm"
      variant="default"
      disabled={openExternalLink.isPending}
      data-testid="client-update-required-download-page"
      onClick={() => {
        openExternalLink.mutate(
          props.upgradeChannel === "rc"
            ? traycerInfo.releasesPage
            : traycerInfo.mainWebsiteDownload,
        );
      }}
    >
      <span className="inline-flex items-center gap-1.5">
        <span>Get the latest Traycer</span>
        {openExternalLink.isPending ? (
          <AgentSpinningDots
            className="text-current"
            testId={undefined}
            variant={undefined}
          />
        ) : null}
      </span>
    </Button>
  );
}
