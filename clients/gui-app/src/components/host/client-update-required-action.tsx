import { useEffect, useRef, type ReactNode } from "react";
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
import type { DesktopAppUpdatesBridge } from "@/lib/windows/types";

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
   * It is used ONLY to decide whether this installation's updater could ever
   * reach the required build - never to decide whether the app is compatible,
   * and never as an address to open. The manual destination below is the same
   * first-party page on both channels.
   */
  readonly upgradeChannel: ClientUpgradeChannel | null;
}): ReactNode {
  const { bridge, snapshot } = useDesktopAppUpdates();
  const openExternalLink = useRunnerOpenExternalLink();
  const openInstallGuidance = useDesktopDialogStore(
    (state) => state.openInstallGuidance,
  );
  useUpdateCheckOnBlockingMount(bridge);

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

  if (snapshot.status === "checking") {
    // A check this surface itself may have started (see the effect above).
    // Rendering the external link under it would tell a user to go download
    // by hand a second before the updater answers.
    return (
      <Button
        type="button"
        size="sm"
        variant="default"
        disabled
        data-testid="client-update-required-checking"
      >
        <span className="inline-flex items-center gap-1.5">
          <span>Checking for updates</span>
          <AgentSpinningDots
            className="text-current"
            testId={undefined}
            variant={undefined}
          />
        </span>
      </Button>
    );
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
        // ONE destination for both channels. GitHub Releases lists
        // prereleases alongside stable, so an `rc` remedy and a `stable` one
        // are the same page - and it is the only download location this
        // repository can vouch for (see `traycerInfo.releasesPage`).
        openExternalLink.mutate(traycerInfo.releasesPage);
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

/**
 * Asks the updater ONCE, on mount, when it has never been asked.
 *
 * The desktop DOES auto-check at launch (`installAutoUpdater` ->
 * `checkForUpdatesNow(isDev, "automatic")` in
 * `clients/desktop/src/electron-main/app/updater.ts`), so most of the time the
 * updater has already answered by the time anyone sees this surface. But that
 * check is gated on `canCheckForUpdates` and happens exactly once, while this
 * surface is reachable hours later - a host can activate a floor, or a user can
 * point at a different host, long into a session. In those cases the updater
 * has genuinely never been asked, and without this the user is sent to download
 * by hand while their own updater could have delivered the build.
 *
 * IT READS THE BRIDGE, NOT THE RENDERED SNAPSHOT, and that is the whole
 * correctness of it. `useDesktopAppUpdates` primes its store ASYNCHRONOUSLY,
 * so the first render of any consumer sees the module's default
 * `idle / lastCheckedAt: null` placeholder no matter what the main process
 * actually holds. Deciding from that placeholder would fire a redundant check
 * on every single mount - precisely the loop this is supposed to avoid - and
 * would do it invisibly, because the placeholder and a genuinely-unchecked
 * updater are the same object shape.
 *
 * Two guards, closing different loops:
 *
 *  - `lastCheckedAt !== null` on the AUTHORITATIVE snapshot means a check has
 *    already happened in this process. "up-to-date" and "error" are real
 *    answers; re-asking them would turn a blocking dialog into a poller.
 *  - `requested` is a per-mount ref, so a re-render (this dialog re-renders on
 *    every lease delivery) cannot start a second read while the first is in
 *    flight.
 *
 * Both rejections are swallowed deliberately: the failure mode is "the manual
 * link is what the user gets", which is where the component was heading
 * anyway. An updater error stacked on top of "your app is too old" adds noise
 * to a state that already has one clear instruction.
 */
function useUpdateCheckOnBlockingMount(
  bridge: DesktopAppUpdatesBridge | null,
): void {
  const requested = useRef(false);
  useEffect(() => {
    if (bridge === null || requested.current) return;
    requested.current = true;
    let cancelled = false;
    void bridge
      .getSnapshot()
      .then((snapshot) => {
        if (cancelled) return;
        if (snapshot.status !== "idle" || snapshot.lastCheckedAt !== null) {
          return;
        }
        return bridge.checkForUpdates("automatic").then(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge]);
}
