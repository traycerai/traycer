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
import type { ClientCompatibilityRequirement } from "@traycer/protocol/framework/index";
import { compareHostVersions } from "@traycer-clients/shared/host-version/compare-host-versions";
import type {
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
} from "@/lib/windows/types";

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
   * The host's structured requirement, whole.
   *
   * Two members are read and NEITHER decides compatibility - the host already
   * decided that. `upgradeChannel` says whether this installation's updater
   * could ever reach the required build; `minimumKnownClientAppVersion` says
   * whether a build the updater is ALREADY holding would actually satisfy it.
   * Nothing here is used as an address to open: the manual destination is the
   * same first-party page on both channels.
   */
  readonly requirement: ClientCompatibilityRequirement;
}): ReactNode {
  const { bridge, snapshot } = useDesktopAppUpdates();
  const openExternalLink = useRunnerOpenExternalLink();
  const openInstallGuidance = useDesktopDialogStore(
    (state) => state.openInstallGuidance,
  );

  // WOULD THE UPDATE THE UPDATER IS HOLDING ACTUALLY FIX THIS?
  //
  // The updater's snapshot is a CACHE. It can be `available` / `downloading` /
  // `ready` for a build found at launch, while the host raised its floor
  // afterwards - so 1.2.0 sits downloaded, the dialog offers "Restart to
  // update", the app restarts, and the same host rejects it again for the same
  // reason. An update loop that never converges, with a button that looks like
  // the remedy.
  //
  // WHEN THIS IS FALSE, THE RELEASES LINK IS THE ONLY RECOVERY - not a
  // preference, a constraint. Main's `checkForUpdatesNow` returns the current
  // snapshot before any feed query while it holds an `available` / `ready` /
  // `downloading` build, whatever the intent, so this surface cannot ask for a
  // newer candidate and cannot discard the stale one. See
  // `shouldCheckForUpdates` below for the trace.
  const cachedUpdateSufficient = updateSatisfiesRequirement(
    snapshot.latestVersion,
    props.requirement.minimumKnownClientAppVersion,
  );
  useUpdateCheckOnBlockingMount(bridge);

  // CHANNEL MISMATCH: the fix is on the RC line and this installation follows
  // stable, so the in-app updater will keep reporting "up to date" forever
  // while the host keeps refusing. Route straight to the releases page rather
  // than offering a Download button that cannot find the build - an updater
  // that says "no update available" beside "your app is too old" is the most
  // confusing state this surface can produce.
  const channelUnreachable =
    props.requirement.upgradeChannel === "rc" && !snapshot.allowPrerelease;

  if (bridge !== null && !channelUnreachable && cachedUpdateSufficient) {
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
    // A check the user started FROM THE HEADER while this dialog is open -
    // NOT the one `useUpdateCheckOnBlockingMount` starts below.
    //
    // `checkForUpdatesNow` publishes `status: "checking"` only for
    // `intent === "manual"` (`clients/desktop/src/electron-main/app/updater.ts`);
    // an automatic check leaves the snapshot `idle` until a result lands. So
    // the self-started check never renders here - the manual link stays up for
    // its duration and flips to `Download update` if a build turns up. That
    // flip is accepted: switching the self-started check to `"manual"` intent
    // would publish `up-to-date` / `error` into the app-wide snapshot and make
    // the header narrate an outcome the user never asked for.
    //
    // The branch is still worth having for the manual case: rendering "Get the
    // latest Traycer" under a running check tells someone to go download by
    // hand a second before their own updater answers.
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
  // that cannot be written, an updater that has not found anything yet, or a
  // cached update too OLD to satisfy the host's floor. A first-party address
  // chosen locally - never one the host supplied.
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
 * Whether a build the updater is holding would actually clear the host's
 * floor.
 *
 * Compared with `compareHostVersions` - the shared strict-SemVer comparator,
 * not a string compare - because prerelease ordering is exactly where this
 * gets decided: a required `1.2.0-rc.2` IS satisfied by a cached `1.2.0`
 * (a release outranks its own prereleases), and a required `1.2.0` is NOT
 * satisfied by a cached `1.2.0-rc.2`. `"1.2.0" < "1.2.0-rc.2"` lexically, so a
 * string compare gets both of those backwards.
 *
 * Two `true` arms that are not "the version is new enough", and both are
 * deliberate:
 *
 *  - The host named NO minimum build (`minimumKnownClientAppVersion: null`).
 *    There is nothing to compare against, and refusing on that basis would
 *    strand a user with no updater path at all over a fact the host declined
 *    to state. The remedy degrades to "install the latest", which is what the
 *    host's own reason already says.
 *
 * And one `false` arm that is not "the version is too old":
 *
 *  - The comparison is INCOMPARABLE, or the updater has no version to offer.
 *    Neither proves the cached build helps, and the cost of being wrong is
 *    asymmetric - a needless trip to the releases page is an inconvenience,
 *    while an install that changes nothing is a restart into the same
 *    rejection.
 */
function updateSatisfiesRequirement(
  latestVersion: string | null,
  minimumKnownClientAppVersion: string | null,
): boolean {
  if (minimumKnownClientAppVersion === null) return true;
  if (latestVersion === null) return false;
  const comparison = compareHostVersions(
    latestVersion,
    minimumKnownClientAppVersion,
  );
  return comparison.comparable && comparison.ordering !== "less";
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
 *
 *    ONE GAP, deliberately left open: an AUTOMATIC check that ERRORS publishes
 *    nothing at all (`emitCheckErrorFromCatch` returns early for non-manual
 *    intent), so `lastCheckedAt` stays `null` and the next mount of this
 *    dialog asks again. That is one request per mount, bounded by the ref
 *    below and by main's own `checkInFlight` dedupe - not a loop - and asking
 *    again after a failed check is the behaviour you would want anyway. The
 *    alternative, tracking "we already tried" in renderer state, would survive
 *    neither a reload nor a second window.
 *  - `requested` is a per-mount ref, so a re-render (this dialog re-renders on
 *    every lease delivery) cannot start a second read while the first is in
 *    flight.
 *
 * The intent stays `"automatic"`. A `"manual"` check would render the pending
 * state below - which is the only reason to want it - but it also publishes
 * `checking`, then `up-to-date` or `error`, into the APP-WIDE snapshot every
 * other update surface reads. A dialog quietly making the header announce
 * "Traycer is up to date" is worse than a brief link-then-button flip.
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
        if (!shouldCheckForUpdates(snapshot)) return;
        return bridge.checkForUpdates("automatic").then(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge]);
}

/**
 * Whether asking the updater again could change this surface's answer.
 *
 * EXACTLY ONE reason to ask: the updater has NEVER been asked - `idle` with no
 * `lastCheckedAt`. The launch check is gated on `canCheckForUpdates` and fires
 * once, while this surface is reachable hours later, so a genuinely
 * never-checked updater is worth one request.
 *
 * NOT a reason to ask, and this is the part worth knowing before anyone adds
 * one: the updater already HOLDING a build that cannot clear the host's floor.
 * That looks like the obvious second case - the user is on the releases link
 * while their own updater is seemingly one request away from the right build -
 * but the request cannot do anything. `checkForUpdatesNow` in
 * `clients/desktop/src/electron-main/app/updater.ts` returns the current
 * snapshot BEFORE any feed query when the status is `ready`, `downloading`, or
 * `available`, for EVERY intent (the `available` arm says so in as many
 * words). Only a channel change moves that snapshot back to a re-queryable
 * state, and it runs its own check. So asking here would dispatch an IPC that
 * provably changes nothing, and a renderer test could only ever assert that
 * the bridge recorded the call.
 *
 * The releases link is therefore the ONLY recovery past a stale cached build,
 * and the render gate above is what makes sure the user is sent there rather
 * than offered a build that restarts into the same rejection. Making the
 * in-app updater recover that case means changing main to discard an
 * `available` candidate on re-check - a desktop-side product decision, not
 * something this surface can reach.
 *
 * Also not a reason: an updater that already answered "nothing here"
 * (`idle` / `up-to-date` / `unavailable` / `error` after a check). That is a
 * real answer, and re-asking it on every mount is the poller the per-mount ref
 * exists to prevent.
 */
function shouldCheckForUpdates(snapshot: DesktopAppUpdateSnapshot): boolean {
  if (snapshot.installInFlight) return false;
  return snapshot.status === "idle" && snapshot.lastCheckedAt === null;
}
