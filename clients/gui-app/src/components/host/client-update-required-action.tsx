import { useEffect, useRef, type ReactNode } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { traycerInfo } from "@traycer-clients/shared/platform/traycer-info";
import {
  getMobileAppPlatform,
  isMobileApp,
  type MobileAppPlatform,
} from "@/lib/mobile-app";
import { useDesktopAppUpdates } from "@/hooks/runner/use-desktop-app-updates";
import { useOpenLink } from "@/lib/links/open-link";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { requestAppUpdateInstall } from "@/lib/app-update/request-app-update-install";
import {
  trackUpdateDownloadStarted,
  trackUpdateRestartRequested,
} from "@/lib/app-update-analytics";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import type { ClientCompatibilityRequirement } from "@traycer/protocol/framework/index";
import { hostReleaseChannelAllowsRcRecovery } from "@traycer/protocol/framework/index";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { runnerHostQueryScopeId } from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import type {
  DesktopAppUpdateChannelChange,
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
  DesktopCompatRecoveryPlan,
} from "@/lib/windows/types";

/** What it deliberately never offers: Update host (the host is the newer leg by construction, so re-installing
 * it cannot help and would suggest the user is fixing the right machine). */
export function ClientUpdateRequiredAction(props: {
  /** `minimumCompatibilityEpoch` says whether a build the updater is already holding would actually satisfy it;
   * `hostReleaseChannel` says whether looking on the RC line could possibly find one that does. */
  readonly requirement: ClientCompatibilityRequirement;
}): ReactNode {
  const { bridge, snapshot } = useDesktopAppUpdates();
  const openInstallGuidance = useDesktopDialogStore(
    (state) => state.openInstallGuidance,
  );

  // Would the update the updater is holding actually fix this? An update loop that never converges, with a
  // button that looks like the remedy.
  const cachedUpdateSufficient = updateSatisfiesRequirement(
    snapshot.latestCompatibilityEpoch,
    props.requirement.minimumCompatibilityEpoch,
  );
  useUpdateCheckOnBlockingMount(bridge);

  // Interpreted here, once, and passed to main as a verdict, so there is never a second place that could decide
  // an unrecognized channel means RC.
  const hostAllowsRcRecovery = hostReleaseChannelAllowsRcRecovery(
    props.requirement.hostReleaseChannel,
  );
  const recovery = useAppUpdateResolveCompatRecoveryPlan({
    bridge,
    minimumEpoch: props.requirement.minimumCompatibilityEpoch,
    hostAllowsRcRecovery,
    candidateSufficient: cachedUpdateSufficient,
    allowPrerelease: snapshot.allowPrerelease,
    // The held candidate's status is part of the plan's identity - see the key
    // builder for why omitting it silently skips main's discard/disarm.
    candidateStatus: snapshot.status,
  });
  const enableRc = useAppUpdateEnableRcRecovery(bridge);
  const cachedUpdateAction = renderCachedUpdateAction({
    bridge,
    snapshot,
    cachedUpdateSufficient,
    openInstallGuidance,
  });
  if (cachedUpdateAction !== null) return cachedUpdateAction;

  // There is no general Settings toggle, so consent is always given against a named build that main's probe has
  // already proven clears this exact floor - never against "the RC channel" in the abstract.
  if (bridge !== null && recovery.data?.route === "enable-rc") {
    return (
      <Button
        type="button"
        size="sm"
        variant="default"
        disabled={enableRc.isPending}
        data-testid="client-update-required-enable-rc"
        onClick={() => {
          enableRc.mutate(bridge);
        }}
      >
        <span className="inline-flex items-center gap-1.5">
          <span>
            {recovery.data.rcCandidateVersion === null
              ? "Enable RC updates and update"
              : `Enable RC updates and get ${recovery.data.rcCandidateVersion}`}
          </span>
          {enableRc.isPending ? (
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

  // The install affordance is withheld - offering "Restart to update" for a build the host will refuse is the
  // converging-loop button this whole surface exists to avoid.
  if (recovery.data?.route === "restart-to-clear-staged") {
    return (
      <>
        <p
          className="w-full text-left text-xs text-muted-foreground"
          data-testid="client-update-required-staged-note"
        >
          {recovery.data.stagedVersion === null
            ? "An update is already downloaded and will install the next time you quit Traycer - but it is still too old for this host. "
            : `Traycer ${recovery.data.stagedVersion} is already downloaded and will install the next time you quit - but it is still too old for this host. `}
          Quit and reopen Traycer to let it apply, then this dialog will offer
          the next step. If you would rather install a newer build by hand, quit
          Traycer first.
        </p>
        <ReleasesPageButton />
      </>
    );
  }

  // Every desktop arm above needs the updater bridge (or a recovery plan, which is bridge-gated), so a Capacitor
  // build always falls through to here.
  if (isMobileApp()) {
    return (
      <p
        className="w-full text-left text-xs text-muted-foreground"
        data-testid="client-update-required-mobile-note"
      >
        {mobileStoreUpdateNote(getMobileAppPlatform())}
      </p>
    );
  }

  if (snapshot.status === "checking") {
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

  return <ReleasesPageButton />;
}

function renderCachedUpdateAction(input: {
  readonly bridge: DesktopAppUpdatesBridge | null;
  readonly snapshot: DesktopAppUpdateSnapshot;
  readonly cachedUpdateSufficient: boolean;
  readonly openInstallGuidance: () => void;
}): ReactNode | null {
  const { bridge, snapshot, cachedUpdateSufficient, openInstallGuidance } =
    input;
  if (bridge !== null && cachedUpdateSufficient) {
    if (snapshot.status === "available") {
      // A blocked location (macOS app outside /Applications) cannot install even once downloaded, so it falls
      // through to the link below - the manual download IS the remedy there.
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
  return null;
}

/** `null` is the mobile stream's dev browser tab, which belongs to neither store; naming one there would be a
 * guess, so it gets the neutral sentence. */
function mobileStoreUpdateNote(platform: MobileAppPlatform | null): string {
  if (platform === "ios") {
    return "Update the Traycer app in TestFlight or the App Store, then reopen it.";
  }
  if (platform === "android") {
    return "Update the Traycer app in Google Play, then reopen it.";
  }
  return "Update the Traycer app from the store you installed it from, then reopen it.";
}

function ReleasesPageButton(): ReactNode {
  const openLink = useOpenLink();
  return (
    <Button
      type="button"
      size="sm"
      variant="default"
      data-testid="client-update-required-download-page"
      onClick={() => {
        // GitHub Releases lists prereleases alongside stable, so an `rc` remedy and a `stable` one are the same page -
        // and it is the only download location this repository can vouch for (see `traycerInfo.releasesPage`).
        void openLink(traycerInfo.releasesPage, "docs", null);
      }}
    >
      <span>Get the latest Traycer</span>
    </Button>
  );
}

/** Whether a build the updater is holding would actually clear the host's floor. Compared AS epochs, never as
 * versions, and that is the whole substance of this function. */
function updateSatisfiesRequirement(
  latestCompatibilityEpoch: number | null,
  minimumCompatibilityEpoch: number,
): boolean {
  if (latestCompatibilityEpoch === null) return false;
  return latestCompatibilityEpoch >= minimumCompatibilityEpoch;
}

/** Cached for the session (`staleTime`/`gcTime` Infinity) rather than refetched, because the expensive arm
 * walks GitHub's release pages. */
function useAppUpdateResolveCompatRecoveryPlan(input: {
  readonly bridge: DesktopAppUpdatesBridge | null;
  readonly minimumEpoch: number;
  readonly hostAllowsRcRecovery: boolean;
  readonly candidateSufficient: boolean;
  readonly allowPrerelease: boolean;
  readonly candidateStatus: DesktopAppUpdateSnapshot["status"];
}): UseQueryResult<DesktopCompatRecoveryPlan> {
  const { bridge } = input;
  return useQuery(
    queryOptions({
      queryKey: runnerQueryKeys.appUpdateCompatRecovery({
        runnerHostScopeId: bridge === null ? 0 : runnerHostQueryScopeId(bridge),
        minimumEpoch: input.minimumEpoch,
        hostAllowsRcRecovery: input.hostAllowsRcRecovery,
        candidateSufficient: input.candidateSufficient,
        allowPrerelease: input.allowPrerelease,
        candidateStatus: input.candidateStatus,
      }),
      queryFn: () => {
        if (bridge === null) {
          throw new Error("No desktop app-update bridge is available.");
        }
        return bridge.resolveCompatRecovery({
          minimumEpoch: input.minimumEpoch,
          hostAllowsRcRecovery: input.hostAllowsRcRecovery,
        });
      },
      enabled: bridge !== null,
      // A failed probe is not a verdict about RC, and the component already routes an unanswered plan to the manual
      // link - retrying would only make a blocking dialog spend longer being unhelpful.
      retry: false,
      staleTime: Infinity,
      gcTime: Infinity,
    }),
  );
}

/** Invalidates the plan on settle whatever the outcome, and that is not housekeeping: main can legitimately
 * answer `refused-update-pending`. */
function useAppUpdateEnableRcRecovery(
  bridge: DesktopAppUpdatesBridge | null,
): UseMutationResult<
  DesktopAppUpdateChannelChange,
  Error,
  DesktopAppUpdatesBridge
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: runnerMutationKeys.setAllowPrereleaseUpdates(),
    mutationFn: (target: DesktopAppUpdatesBridge) =>
      target.setAllowPrerelease(true),
    onError: (error) => {
      toastFromRunnerError(error, "Couldn't enable RC updates");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.appUpdateCompatRecoveryScope(
          bridge === null ? 0 : runnerHostQueryScopeId(bridge),
        ),
      });
    },
  });
}

/** In those cases the updater has genuinely never been asked, and without this the user is sent to download by
 * hand while their own updater could have delivered the build. */
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

/** Not a reason to ask, and this is the part worth knowing before anyone adds one: the updater already holding
 * a build that cannot clear the host's floor. */
function shouldCheckForUpdates(snapshot: DesktopAppUpdateSnapshot): boolean {
  if (snapshot.installInFlight) return false;
  return snapshot.status === "idle" && snapshot.lastCheckedAt === null;
}
