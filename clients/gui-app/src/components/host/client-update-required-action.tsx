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
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
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
   * decided that. `minimumCompatibilityEpoch` says whether a build the updater
   * is ALREADY holding would actually satisfy it; `hostReleaseChannel` says
   * whether looking on the RC line could possibly find one that does. Nothing
   * here is used as an address to open: the manual destination is the same
   * first-party page on every channel.
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
  // afterwards - so a build sits downloaded, the dialog offers "Restart to
  // update", the app restarts, and the same host rejects it again for the same
  // reason. An update loop that never converges, with a button that looks like
  // the remedy.
  const cachedUpdateSufficient = updateSatisfiesRequirement(
    snapshot.latestCompatibilityEpoch,
    props.requirement.minimumCompatibilityEpoch,
  );
  useUpdateCheckOnBlockingMount(bridge);

  // MAY THIS INSTALLATION LOOK ON THE RC LINE AT ALL? Only the rejecting host
  // being ON that line authorizes it - `hostReleaseChannelAllowsRcRecovery`
  // matches the exact string `rc` and treats `stable`, `dev`, an absent field,
  // and any future line as no. Interpreted HERE, once, and passed to main as a
  // verdict, so there is never a second place that could decide an unrecognized
  // channel means RC.
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

  // THE RC HOP, and the only route in this app that can turn on prereleases.
  // There is no general Settings toggle, so consent is always given against a
  // NAMED build that main's probe has already proven clears this exact floor -
  // never against "the RC channel" in the abstract.
  //
  // Reaching this arm means main established all of: the stable feed cannot
  // help, the rejecting host is itself on the RC line, nothing insufficient is
  // staged that this platform could not discard, and a sufficient RC candidate
  // exists and deeply validates. Any one of those failing routes elsewhere.
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

  // macOS WITH AN INSUFFICIENT UPDATE ALREADY STAGED. Squirrel.Mac took the
  // artifact the moment its download finished and no supported API withdraws
  // it, so this build WILL apply at the next quit whatever anyone does here.
  //
  // The install affordance is withheld - offering "Restart to update" for a
  // build the host will refuse is the converging-loop button this whole surface
  // exists to avoid - but the fact is stated rather than hidden, because a user
  // who drag-installs a fresh build while this app is still running gets the
  // staged older one written over it at quit. That downgrade window is narrow
  // and known; the copy is what makes it avoidable.
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
        <ReleasesPageButton openExternalLink={openExternalLink} />
      </>
    );
  }

  // THE MOBILE SHELL. Every desktop arm above needs the updater bridge (or a
  // recovery plan, which is bridge-gated), so a Capacitor build always falls
  // through to here - and the releases page below is a desktop remedy a phone
  // cannot act on: mobile builds ship through the stores, not GitHub. There
  // is no store URL this repository can vouch for across lanes (internal
  // testing installs update through the TestFlight app / Play opt-in track),
  // so the remedy names the shell's own store. A `null` platform is the
  // mobile stream's dev browser tab, which belongs to neither store and gets
  // the neutral sentence.
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

  return <ReleasesPageButton openExternalLink={openExternalLink} />;
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
  return null;
}

/**
 * The one sentence a phone can act on, per shell.
 *
 * `null` is the mobile stream's dev browser tab, which belongs to neither
 * store; naming one there would be a guess, so it gets the neutral sentence.
 */
function mobileStoreUpdateNote(platform: MobileAppPlatform | null): string {
  if (platform === "ios") {
    return "Update the Traycer app in TestFlight or the App Store, then reopen it.";
  }
  if (platform === "android") {
    return "Update the Traycer app in Google Play, then reopen it.";
  }
  return "Update the Traycer app from the store you installed it from, then reopen it.";
}

function ReleasesPageButton(props: {
  readonly openExternalLink: UseMutationResult<void, Error, string>;
}): ReactNode {
  return (
    <Button
      type="button"
      size="sm"
      variant="default"
      disabled={props.openExternalLink.isPending}
      data-testid="client-update-required-download-page"
      onClick={() => {
        // ONE destination for both channels. GitHub Releases lists
        // prereleases alongside stable, so an `rc` remedy and a `stable` one
        // are the same page - and it is the only download location this
        // repository can vouch for (see `traycerInfo.releasesPage`).
        props.openExternalLink.mutate(traycerInfo.releasesPage);
      }}
    >
      <span className="inline-flex items-center gap-1.5">
        <span>Get the latest Traycer</span>
        {props.openExternalLink.isPending ? (
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
 * COMPARED AS EPOCHS, never as versions, and that is the whole substance of
 * this function. The epoch is a cumulative generation number the release
 * pipeline stamps into the document each updater resolves; SemVer describes
 * which build a candidate is, and the two answer different questions. A
 * `1.3.0` hotfix branched off a pre-epoch line is newer by every version
 * comparison and still does not clear a floor of 2.
 *
 * `null` IS INSUFFICIENT, and this inverts what this function used to do. Its
 * predecessor read `minimumKnownClientAppVersion === null` as "the host named
 * no minimum, so anything satisfies it" - a reasonable reading of a field the
 * host might decline to fill, and a catastrophic one now that epoch-only policy
 * leaves that field permanently null. Here `null` means something different:
 * the candidate's GENERATION could not be established - an unstamped feed, an
 * unparseable one, or a build reached by electron-updater's deep-validation
 * fallback rather than the one the release gate proved. Offering an
 * unknown-generation build as the remedy for a compatibility rejection restarts
 * the app straight back into the same rejection, so the answer is no.
 *
 * The cost of being wrong is asymmetric and points the same way: a needless
 * trip to the releases page is an inconvenience, an install that changes
 * nothing is a converging-on-nothing loop.
 */
function updateSatisfiesRequirement(
  latestCompatibilityEpoch: number | null,
  minimumCompatibilityEpoch: number,
): boolean {
  if (latestCompatibilityEpoch === null) return false;
  return latestCompatibilityEpoch >= minimumCompatibilityEpoch;
}

/**
 * Asks main where this rejection's recovery should go - see
 * {@link DesktopCompatRecoveryPlan} for why the decision lives there.
 *
 * ⚠ RESOLVING A PLAN HAS A SIDE EFFECT, in the safe direction only: main
 * discards an insufficient staged artifact wherever the platform permits it, so
 * a user who quits does not install a build that restarts into this same
 * dialog. That is why this runs on mount rather than only when the user reaches
 * for the RC affordance - the moment we learn the staged build is insufficient
 * is the moment it should stop being armed.
 *
 * CACHED FOR THE SESSION (`staleTime`/`gcTime` Infinity) rather than refetched,
 * because the expensive arm walks GitHub's release pages. The key already
 * carries every input that changes the answer, so a genuinely new situation -
 * a check that lands a sufficient candidate, a channel that moves - mints a new
 * key and probes again on its own. What it deliberately does NOT do is poll for
 * an RC build that might get published while the dialog is open; the releases
 * link is the escape hatch for that, and a poller behind a blocking dialog is
 * the failure mode this whole file keeps avoiding.
 */
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
      // One attempt. A failed probe is not a verdict about RC, and the component
      // already routes an unanswered plan to the manual link - retrying would
      // only make a blocking dialog spend longer being unhelpful.
      retry: false,
      staleTime: Infinity,
      gcTime: Infinity,
    }),
  );
}

/**
 * The RC opt-in itself.
 *
 * Invalidates the plan on settle whatever the outcome, and that is not
 * housekeeping: main can legitimately answer `refused-update-pending` - a
 * download started between the probe and the click, or (macOS) an artifact
 * reached native staging in that window - and the correct response is to ask
 * again rather than to report a failure. Re-resolving routes the user to
 * `restart-to-clear-staged` or the manual link, which is the honest next step
 * in both of those cases.
 */
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
